-- =============================================================================
-- Ежедневный отчёт по одному бухгалтеру на основе выгрузки Артёма.
-- Применяется к проекту Supabase "OB Artyom" (rbtvbsbcycdlwmrzjwun) миграцией
-- `accountant_daily_report`.
--
-- ЗАЧЕМ (задача «Выгрузка Артёма — проверка на 1 бухгалтере»):
--   Нужна понятная дневная отчётность, которая по выгрузке Артёма показывает,
--   ЧТО бухгалтер сделал за конкретный день (по типам услуг) и, помножив на
--   хронометраж выполнения услуги, СКОЛЬКО времени он на это потратил. Затем
--   бухгалтер даёт обратную связь: подтверждает цифры Артёма (кол-во компаний,
--   счетов, отчётов), комментирует каждую цифру и дописывает, что делал помимо
--   учтённого времени. Именно «отчёт системы + комментарий бухгалтера» и
--   считается сделанной за день работой.
--
--   Мост «бухгалтер → компании» строит фронтенд (normalize.js / accountants.js):
--   он уже сопоставил каждого клиента OB с ArmSoft (company_id) и налоговым
--   кабинетом (ИНН/tin). Поэтому серверные функции принимают массивы company_id
--   и tin и агрегируют работу из armsoft_db по дням и типам услуг.
--
--   Даты приводятся тем же способом (::date), что и существующие view над
--   armsoft_db (v_ob_arm_activity, ob_company_task_feed) — для консистентности.
--
-- Содержит:
--   1. ob_accountant_daily_activity(company_ids, tins, from, to) — счётчики по
--      дню и типу услуги (для дневной ленты и хронометража).
--   2. ob_accountant_day_feed(company_ids, tins, day, category, limit) — список
--      КОНКРЕТНЫХ документов за один день и тип услуги (drill «показать за что»).
--   3. public.accountant_day_reports — обратная связь бухгалтера по дню:
--      подтверждение цифр, комментарии к каждой цифре, дописанная работа с её
--      временем, статус согласования.
--
-- БЕЗОПАСНОСТЬ: функции — SECURITY DEFINER с пустым search_path (у anon нет
--   прямого доступа к armsoft_db), EXECUTE только для anon/authenticated.
--   Таблица — RLS включён с явными политиками (как delta_items / task_sync).
--
-- Аддитивная и идемпотентная миграция. Существующие таблицы не изменяет.
-- =============================================================================

-- 1. Счётчики работы по дню и типу услуги --------------------------------------
--    category: invoice_issued | invoice_received | report |
--              tax_invoice_issued | tax_invoice_received
CREATE OR REPLACE FUNCTION public.ob_accountant_daily_activity(
  p_company_ids integer[] DEFAULT '{}',
  p_tins        text[]    DEFAULT '{}',
  p_from        date      DEFAULT NULL,
  p_to          date      DEFAULT NULL
)
RETURNS TABLE (
  activity_date date,
  category      text,
  cnt           bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH ev AS (
    -- ArmSoft: выставленные счета
    SELECT i.doc_date::date AS d, 'invoice_issued'::text AS category
    FROM armsoft_db.parsed_issued_invoices i
    WHERE i.company_id = ANY (p_company_ids)

    UNION ALL
    -- ArmSoft: полученные счета
    SELECT r.submission_date::date, 'invoice_received'
    FROM armsoft_db.parsed_received_invoices r
    WHERE r.company_id = ANY (p_company_ids)

    UNION ALL
    -- TaxService: сданные отчёты (архив форм)
    SELECT to_date(nullif(f.submission_date, ''), 'DD.MM.YYYY'), 'report'
    FROM armsoft_db.tax_archive_forms f
    WHERE f.inn = ANY (p_tins)

    UNION ALL
    -- TaxService: выставленные э-счета
    SELECT ti.issued_at::date, 'tax_invoice_issued'
    FROM armsoft_db.tax_invoices_issued ti
    WHERE ti.tin = ANY (p_tins)

    UNION ALL
    -- TaxService: полученные э-счета
    SELECT tr.issued_at::date, 'tax_invoice_received'
    FROM armsoft_db.tax_invoices_received tr
    WHERE tr.tin = ANY (p_tins)
  )
  SELECT d AS activity_date, category, count(*)::bigint AS cnt
  FROM ev
  WHERE d IS NOT NULL
    AND (p_from IS NULL OR d >= p_from)
    AND (p_to   IS NULL OR d <= p_to)
  GROUP BY d, category
  ORDER BY d DESC, category;
$$;

REVOKE ALL ON FUNCTION public.ob_accountant_daily_activity(integer[], text[], date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ob_accountant_daily_activity(integer[], text[], date, date) TO anon, authenticated;

-- 2. Список конкретных документов за один день и тип услуги (drill) ------------
--    p_category = NULL → все типы за день. Каждая строка = один документ/отчёт.
CREATE OR REPLACE FUNCTION public.ob_accountant_day_feed(
  p_company_ids integer[] DEFAULT '{}',
  p_tins        text[]    DEFAULT '{}',
  p_day         date      DEFAULT NULL,
  p_category    text      DEFAULT NULL,
  p_limit       integer   DEFAULT 300
)
RETURNS TABLE (
  task_date date,
  system    text,
  category  text,
  company   text,
  title     text,
  detail    text,
  amount    numeric,
  currency  text,
  status    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH ev AS (
    SELECT
      i.doc_date::date AS task_date, 'ArmSoft'::text AS system, 'invoice_issued'::text AS category,
      ac.caption AS company,
      (coalesce(i.doc_type_name, 'Счёт') || coalesce(' №' || nullif(i.doc_num, ''), '')) AS title,
      i.part_name AS detail, i.summ AS amount, i.curr_code AS currency, i.doc_state_name AS status
    FROM armsoft_db.parsed_issued_invoices i
    LEFT JOIN armsoft_db.armsoft_companies ac ON ac.company_id = i.company_id
    WHERE i.company_id = ANY (p_company_ids)

    UNION ALL
    SELECT
      r.submission_date::date, 'ArmSoft', 'invoice_received',
      ac.caption,
      ('Полученный счёт' || coalesce(' №' || nullif(r.serial_and_number, ''), '')),
      r.supplier_name, r.sum_total, r.curr_code, NULL
    FROM armsoft_db.parsed_received_invoices r
    LEFT JOIN armsoft_db.armsoft_companies ac ON ac.company_id = r.company_id
    WHERE r.company_id = ANY (p_company_ids)

    UNION ALL
    SELECT
      to_date(nullif(f.submission_date, ''), 'DD.MM.YYYY'), 'TaxService', 'report',
      f.pdf_company_name,
      f.form_name, nullif(f.report_period, ''), NULL, NULL, f.status
    FROM armsoft_db.tax_archive_forms f
    WHERE f.inn = ANY (p_tins)

    UNION ALL
    SELECT
      ti.issued_at::date, 'TaxService', 'tax_invoice_issued',
      ti.supplier_name,
      ('Налоговый счёт' || coalesce(' ' || nullif(ti.serial_no, ''), '')),
      ti.buyer_name, ti.total, 'AMD', ti.status
    FROM armsoft_db.tax_invoices_issued ti
    WHERE ti.tin = ANY (p_tins)

    UNION ALL
    SELECT
      tr.issued_at::date, 'TaxService', 'tax_invoice_received',
      tr.buyer_name,
      ('Полученный налоговый счёт' || coalesce(' ' || nullif(tr.serial_no, ''), '')),
      tr.supplier_name, tr.total, 'AMD', tr.status
    FROM armsoft_db.tax_invoices_received tr
    WHERE tr.tin = ANY (p_tins)
  )
  SELECT task_date, system, category, company, title, detail, amount, currency, status
  FROM ev
  WHERE task_date IS NOT NULL
    AND (p_day IS NULL OR task_date = p_day)
    AND (p_category IS NULL OR category = p_category)
  ORDER BY task_date DESC, system, category
  LIMIT greatest(1, least(coalesce(p_limit, 300), 1000));
$$;

REVOKE ALL ON FUNCTION public.ob_accountant_day_feed(integer[], text[], date, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ob_accountant_day_feed(integer[], text[], date, text, integer) TO anon, authenticated;

-- 3. Обратная связь бухгалтера по дню ------------------------------------------
--    Одна строка на (бухгалтер, дата). Ключевая идея процесса: работой за день
--    считается «отчёт системы (Артём) + комментарий бухгалтера».
--      - counts_confirmed  — бухгалтер подтвердил цифры Артёма;
--      - metric_notes      — комментарий/спор по каждой цифре (по типу услуги):
--                            { "invoice_issued": {"comment":"…","disputed":true,
--                                                 "accountant_count":12}, … };
--      - extra_work        — что делал ПОМИМО учтённого времени, с оценкой минут:
--                            [ {"desc":"консультация клиента","minutes":30}, … ];
--      - status            — pending | confirmed | disputed.
CREATE TABLE IF NOT EXISTS public.accountant_day_reports (
    id                 BIGSERIAL PRIMARY KEY,
    accountant_name    TEXT NOT NULL,
    report_date        DATE NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','confirmed','disputed')),
    counts_confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
    accountant_comment TEXT,                       -- что делал помимо учтённого часа (свободный текст)
    metric_notes       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- комментарии по каждой цифре Артёма
    extra_work         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- дописанная работа [{desc, minutes}]
    export_minutes     INTEGER,                    -- снимок минут по отчёту Артёма (на момент сохранения)
    reviewer_note      TEXT,
    confirmed_at       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at         TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (accountant_name, report_date)
);

CREATE INDEX IF NOT EXISTS idx_day_reports_accountant ON public.accountant_day_reports (accountant_name);
CREATE INDEX IF NOT EXISTS idx_day_reports_date       ON public.accountant_day_reports (report_date);

-- updated_at триггер (функция public.set_updated_at создана ранее) --------------
DROP TRIGGER IF EXISTS trg_day_reports_updated ON public.accountant_day_reports;
CREATE TRIGGER trg_day_reports_updated BEFORE UPDATE ON public.accountant_day_reports
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS + политики (внутренний инструмент, как delta_items / accountant_task_sync)
ALTER TABLE public.accountant_day_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS adr_all ON public.accountant_day_reports;
CREATE POLICY adr_all ON public.accountant_day_reports FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.accountant_day_reports TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.accountant_day_reports_id_seq TO anon, authenticated;
