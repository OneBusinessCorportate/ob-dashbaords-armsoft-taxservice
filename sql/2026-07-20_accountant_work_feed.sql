-- =============================================================================
-- Реальная работа бухгалтеров: фактические задачи из выгрузки Артёма.
-- Применяется к проекту Supabase "OB Artyom" (rbtvbsbcycdlwmrzjwun) миграцией
-- `accountant_work_feed`.
--
-- ЗАЧЕМ:
--   Страница «Бухгалтеры» раньше показывала «задачи» только из
--   accounting_activities (76 компаний, все под общим «OB Accounting» и с
--   короткими ключами-названиями, которые не совпадали с реестром OB) — поэтому
--   у всех стояло «— нет отчёта». При этом парсеры Артёма уже разобрали реальную
--   работу по каждой компании: ~46 000 выданных счетов, ~47 000 полученных,
--   ~5 900 сданных налоговых отчётов, налоговые э-счета. Эти данные лежат в
--   armsoft_db и до сих пор не выводились.
--
--   Эта миграция аддитивно выставляет их в схему public (её читает PostgREST):
--     1. v_ob_arm_activity — сводка работы по компании ArmSoft (company_id):
--        сколько выставлено/получено счетов и дата последнего документа.
--     2. v_ob_tax_activity — сводка работы по налоговому кабинету (по ИНН/tin):
--        сданные отчёты, выданные/полученные налоговые счета, дата последней
--        активности.
--     3. ob_company_task_feed(armsoft_company_id, tin, limit) — единый список
--        КОНКРЕТНЫХ задач одной компании (каждая строка = «выставлен счёт №… —
--        партнёр на …֏», «сдан отчёт … за период …»), для drill-down в UI.
--
--   Фронтенд уже сопоставляет каждого клиента OB с налоговым кабинетом (tin) и с
--   ArmSoft (company_id) в normalize.js — поэтому мост в БД не нужен: он берёт
--   tin из налогового совпадения и company_id из ArmSoft-совпадения и по ним
--   читает эти сводки/фид.
--
-- БЕЗОПАСНОСТЬ:
--   Как и существующие v_*-view, обычные view над armsoft_db работают под
--   владельцем (у него есть доступ к armsoft_db) и выдаются anon только на
--   SELECT. Учётные данные (username/password/токены) не выводятся. Функция-фид
--   — SECURITY DEFINER c пустым search_path, EXECUTE только для anon.
--
-- Миграция аддитивная и идемпотентная (CREATE OR REPLACE). Существующие таблицы
-- не изменяет.
-- =============================================================================

-- 1. Работа в ArmSoft по компании (company_id = armsoft_companies.company_id) ----
CREATE OR REPLACE VIEW public.v_ob_arm_activity AS
SELECT
  company_id,
  count(*) FILTER (WHERE src = 'issued')   AS invoices_issued,
  count(*) FILTER (WHERE src = 'received') AS invoices_received,
  max(doc_date)::date                      AS last_doc_date
FROM (
  SELECT company_id, doc_date,        'issued'::text   AS src FROM armsoft_db.parsed_issued_invoices
  UNION ALL
  SELECT company_id, submission_date, 'received'::text AS src FROM armsoft_db.parsed_received_invoices
) u
WHERE company_id IS NOT NULL
GROUP BY company_id;

GRANT SELECT ON public.v_ob_arm_activity TO anon, authenticated;

-- 2. Работа в налоговом кабинете по ИНН (tin = v_tax_accounts.tin) ---------------
CREATE OR REPLACE VIEW public.v_ob_tax_activity AS
WITH ev AS (
  SELECT inn AS tin, 'report'::text     AS typ,
         to_date(nullif(submission_date, ''), 'DD.MM.YYYY') AS d
  FROM armsoft_db.tax_archive_forms WHERE inn IS NOT NULL
  UNION ALL
  SELECT tin, 'inv_issued'::text, issued_at::date FROM armsoft_db.tax_invoices_issued WHERE tin IS NOT NULL
  UNION ALL
  SELECT tin, 'inv_recv'::text,   issued_at::date FROM armsoft_db.tax_invoices_received WHERE tin IS NOT NULL
)
SELECT
  tin,
  count(*) FILTER (WHERE typ = 'report')     AS reports_submitted,
  count(*) FILTER (WHERE typ = 'inv_issued') AS tax_invoices_issued,
  count(*) FILTER (WHERE typ = 'inv_recv')   AS tax_invoices_received,
  max(d)                                     AS last_activity_date
FROM ev
GROUP BY tin;

GRANT SELECT ON public.v_ob_tax_activity TO anon, authenticated;

-- 3. Единый список конкретных задач одной компании (drill-down) ------------------
--    Возвращает последние p_limit событий по компании: счета ArmSoft (выданные/
--    полученные), налоговые э-счета и сданные отчёты. Каждая строка — задача.
CREATE OR REPLACE FUNCTION public.ob_company_task_feed(
  p_armsoft_company_id integer DEFAULT NULL,
  p_tin text DEFAULT NULL,
  p_limit integer DEFAULT 120
)
RETURNS TABLE (
  task_date date,
  system    text,
  category  text,
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
    -- ArmSoft: выданные счета
    SELECT
      doc_date::date AS task_date, 'ArmSoft'::text AS system, 'invoice_issued'::text AS category,
      (coalesce(doc_type_name, 'Счёт') || coalesce(' №' || nullif(doc_num, ''), '')) AS title,
      part_name AS detail, summ AS amount, curr_code AS currency, doc_state_name AS status
    FROM armsoft_db.parsed_issued_invoices
    WHERE p_armsoft_company_id IS NOT NULL AND company_id = p_armsoft_company_id

    UNION ALL
    -- ArmSoft: полученные счета
    SELECT
      submission_date::date, 'ArmSoft', 'invoice_received',
      ('Полученный счёт' || coalesce(' №' || nullif(serial_and_number, ''), '')),
      supplier_name, sum_total, curr_code, NULL
    FROM armsoft_db.parsed_received_invoices
    WHERE p_armsoft_company_id IS NOT NULL AND company_id = p_armsoft_company_id

    UNION ALL
    -- TaxService: сданные отчёты (архив форм)
    SELECT
      to_date(nullif(submission_date, ''), 'DD.MM.YYYY'), 'TaxService', 'report',
      form_name, nullif(report_period, ''), NULL, NULL, status
    FROM armsoft_db.tax_archive_forms
    WHERE p_tin IS NOT NULL AND inn = p_tin

    UNION ALL
    -- TaxService: выданные э-счета
    SELECT
      issued_at::date, 'TaxService', 'tax_invoice_issued',
      ('Налоговый счёт' || coalesce(' ' || nullif(serial_no, ''), '')),
      buyer_name, total, 'AMD', status
    FROM armsoft_db.tax_invoices_issued
    WHERE p_tin IS NOT NULL AND tin = p_tin

    UNION ALL
    -- TaxService: полученные э-счета
    SELECT
      issued_at::date, 'TaxService', 'tax_invoice_received',
      ('Полученный налоговый счёт' || coalesce(' ' || nullif(serial_no, ''), '')),
      supplier_name, total, 'AMD', status
    FROM armsoft_db.tax_invoices_received
    WHERE p_tin IS NOT NULL AND tin = p_tin
  )
  SELECT task_date, system, category, title, detail, amount, currency, status
  FROM ev
  WHERE task_date IS NOT NULL
  ORDER BY task_date DESC
  LIMIT greatest(1, least(coalesce(p_limit, 120), 500));
$$;

REVOKE ALL ON FUNCTION public.ob_company_task_feed(integer, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ob_company_task_feed(integer, text, integer) TO anon, authenticated;
