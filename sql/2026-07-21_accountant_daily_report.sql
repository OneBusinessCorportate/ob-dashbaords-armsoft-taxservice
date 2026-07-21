-- =============================================================================
-- Дневной отчёт бухгалтера (страница daily-report.html).
-- Применяется к проекту Supabase "OB Artyom" (rbtvbsbcycdlwmrzjwun) миграцией
-- `accountant_daily_report`.
--
-- ЧТО ДОБАВЛЯЕТ (аддитивно, существующие таблицы не ломает):
--   1. public.ob_export_day_activity(date) — сколько РЕАЛЬНОЙ работы Артём
--      выгрузил за ОДИН день, в разрезе company_id (ArmSoft) и ИНН/tin
--      (TaxService): выставленные/полученные счета и сданные отчёты. Мост
--      «компания → бухгалтер» строит фронтенд (как в accountants.js: company_id
--      из ArmSoft-совпадения, tin из налогового) — поэтому здесь агрегируем
--      только по ключам систем, без привязки к реестру.
--   2. public.ob_export_days(limit) — последние даты, где вообще была активность
--      в выгрузке (для выбора дня в отчёте и разумного значения по умолчанию:
--      «сегодня» в демо-данных часто пустое).
--   3. accountant_daily_comments.report_meta jsonb — ОДНА добавочная колонка
--      (наименее инвазивно), в которой дневной отчёт хранит:
--        • комментарий-работу бухгалтера:  {"kind":"work","minutes":N}
--          (текст действия при этом кладётся и в comment, и в unaccounted_work —
--           так его подхватывает существующая сверка в tasksync.js);
--        • пометку к конкретной цифре Артёма: {"kind":"figure","figure":"invoices"}
--          (текст пометки — в comment; unaccounted_work у пометок пустой, чтобы
--           не засорять сверку). figure ∈ companies | invoices | services.
--      Обычные строки accountant_daily_comments (report_meta IS NULL) работают
--      как раньше — колонка nullable и опциональна.
--
-- БЕЗОПАСНОСТЬ: функции — SECURITY DEFINER с пустым search_path, EXECUTE только
-- для anon/authenticated (как ob_company_task_feed). Учётные данные не выводятся.
-- Идемпотентно (CREATE OR REPLACE / ADD COLUMN IF NOT EXISTS).
-- =============================================================================

-- 1. Дневная активность выгрузки Артёма по ключам систем -----------------------
CREATE OR REPLACE FUNCTION public.ob_export_day_activity(p_date date DEFAULT NULL)
RETURNS TABLE (
  arm_company_id    integer,   -- заполнено для строк ArmSoft (иначе NULL)
  tin               text,      -- заполнено для строк TaxService (иначе NULL)
  invoices_issued   bigint,
  invoices_received bigint,
  reports           bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH day AS (
    SELECT COALESCE(p_date, (now() AT TIME ZONE 'Asia/Yerevan')::date) AS d
  ),
  arm AS (
    SELECT
      company_id,
      count(*) FILTER (WHERE src = 'issued')   AS invoices_issued,
      count(*) FILTER (WHERE src = 'received') AS invoices_received
    FROM (
      SELECT company_id, doc_date::date        AS d, 'issued'::text   AS src FROM armsoft_db.parsed_issued_invoices
      UNION ALL
      SELECT company_id, submission_date::date AS d, 'received'::text AS src FROM armsoft_db.parsed_received_invoices
    ) u
    WHERE company_id IS NOT NULL AND u.d = (SELECT d FROM day)
    GROUP BY company_id
  ),
  tax AS (
    SELECT
      tin,
      count(*) FILTER (WHERE typ = 'inv_issued') AS invoices_issued,
      count(*) FILTER (WHERE typ = 'inv_recv')   AS invoices_received,
      count(*) FILTER (WHERE typ = 'report')     AS reports
    FROM (
      SELECT inn AS tin, 'report'::text     AS typ, to_date(nullif(submission_date, ''), 'DD.MM.YYYY') AS d
        FROM armsoft_db.tax_archive_forms WHERE inn IS NOT NULL
      UNION ALL
      SELECT tin, 'inv_issued'::text, issued_at::date FROM armsoft_db.tax_invoices_issued  WHERE tin IS NOT NULL
      UNION ALL
      SELECT tin, 'inv_recv'::text,   issued_at::date FROM armsoft_db.tax_invoices_received WHERE tin IS NOT NULL
    ) e
    WHERE e.d = (SELECT d FROM day)
    GROUP BY tin
  )
  SELECT company_id AS arm_company_id, NULL::text AS tin,
         invoices_issued, invoices_received, 0::bigint AS reports
  FROM arm
  UNION ALL
  SELECT NULL::integer AS arm_company_id, tin,
         invoices_issued, invoices_received, reports
  FROM tax;
$$;

REVOKE ALL ON FUNCTION public.ob_export_day_activity(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ob_export_day_activity(date) TO anon, authenticated;

-- 2. Даты, где была активность выгрузки (для выбора дня в отчёте) ---------------
CREATE OR REPLACE FUNCTION public.ob_export_days(p_limit integer DEFAULT 60)
RETURNS TABLE (
  activity_date date,
  events        bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT d AS activity_date, count(*) AS events
  FROM (
    SELECT doc_date::date        AS d FROM armsoft_db.parsed_issued_invoices   WHERE doc_date IS NOT NULL
    UNION ALL
    SELECT submission_date::date       FROM armsoft_db.parsed_received_invoices WHERE submission_date IS NOT NULL
    UNION ALL
    SELECT to_date(nullif(submission_date, ''), 'DD.MM.YYYY')
      FROM armsoft_db.tax_archive_forms WHERE nullif(submission_date, '') IS NOT NULL
    UNION ALL
    SELECT issued_at::date FROM armsoft_db.tax_invoices_issued   WHERE issued_at IS NOT NULL
    UNION ALL
    SELECT issued_at::date FROM armsoft_db.tax_invoices_received WHERE issued_at IS NOT NULL
  ) all_ev
  WHERE d IS NOT NULL
  GROUP BY d
  ORDER BY d DESC
  LIMIT greatest(1, least(coalesce(p_limit, 60), 400));
$$;

REVOKE ALL ON FUNCTION public.ob_export_days(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ob_export_days(integer) TO anon, authenticated;

-- 3. Одна добавочная колонка для дневного отчёта (наименее инвазивно) ----------
ALTER TABLE public.accountant_daily_comments
  ADD COLUMN IF NOT EXISTS report_meta jsonb;

COMMENT ON COLUMN public.accountant_daily_comments.report_meta IS
  'Дневной отчёт (daily-report.html): {"kind":"work","minutes":N} — комментарий-работа с затраченным временем; {"kind":"figure","figure":"companies|invoices|services"} — пометка к цифре выгрузки Артёма. NULL — обычная строка комментария.';
