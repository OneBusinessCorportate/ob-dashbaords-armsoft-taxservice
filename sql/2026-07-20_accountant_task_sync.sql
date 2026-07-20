-- =============================================================================
-- Синхронизация ежедневных задач бухгалтеров с выгрузкой Артёма.
-- Применяется к проекту Supabase "OB Artyom" (rbtvbsbcycdlwmrzjwun) миграцией
-- `accountant_task_sync`.
--
-- Содержит:
--   1. app_config — сид расписания выгрузки (график/льготный период).
--   2. public.artyom_export_schedule_status() — статус графика выгрузки
--      (4 состояния: awaiting / exported / overdue / no_data). Используется
--      и дашбордом, и Telegram-отбивкой — единый источник истины по статусу.
--   3. public.v_artyom_export_status — view над функцией (для anon SELECT).
--   4. public.accountant_task_sync — реестр сверки задач бухгалтеров с выгрузкой
--      + модель самопроверки бухгалтером (следующий этап).
--   5. public.sync_problems — список проблем процесса сверки.
--
-- Аддитивная миграция: существующие таблицы не изменяет.
-- =============================================================================

-- 1. Конфиг расписания выгрузки (сервер-сайд источник для функции и Telegram) ---
--    Дублируется в config.js (TASK_SYNC.exportSchedule) для UI. Здесь — канон
--    для серверных проверок, чтобы отбивка в Telegram не зависела от браузера.
INSERT INTO public.app_config (key, value) VALUES
  ('export.frequency',            'daily'),   -- как часто ждём выгрузку
  ('export.expected_hour_yerevan','2'),       -- к какому часу (Ереван) ждём свежую выгрузку
  ('export.grace_hours',          '12')       -- льготный период после дедлайна до статуса «Просрочено»
ON CONFLICT (key) DO NOTHING;

-- 2. Статус графика выгрузки ----------------------------------------------------
-- SECURITY DEFINER: считает по armsoft_db.parser_modules, к которой у anon нет
-- прямого доступа (как и у остальных public.v_*-view над armsoft_db).
CREATE OR REPLACE FUNCTION public.artyom_export_schedule_status()
RETURNS TABLE (
  status         text,   -- awaiting | exported | overdue | no_data
  last_run       timestamptz,
  expected_by    timestamptz,
  grace_until    timestamptz,
  hours_late     numeric,
  now_yerevan    timestamptz,
  active_modules integer,
  last_run_modules integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH cfg AS (
    SELECT
      COALESCE((SELECT value FROM public.app_config WHERE key='export.expected_hour_yerevan'),'2')::int  AS expected_hour,
      COALESCE((SELECT value FROM public.app_config WHERE key='export.grace_hours'),'12')::int            AS grace_hours
  ),
  base AS (
    SELECT
      (SELECT MAX(last_run) FROM armsoft_db.parser_modules)                     AS last_run,
      (SELECT COUNT(*)::int FROM armsoft_db.parser_modules WHERE is_active)     AS active_modules,
      (now() AT TIME ZONE 'Asia/Yerevan')                                       AS now_local,
      c.expected_hour,
      c.grace_hours
    FROM cfg c
  ),
  calc AS (
    SELECT
      b.*,
      -- дедлайн сегодняшнего цикла в Ереване
      (date_trunc('day', b.now_local) + make_interval(hours => b.expected_hour)) AS deadline_today
    FROM base b
  ),
  calc2 AS (
    SELECT
      c.*,
      -- актуальный дедлайн: если сегодняшний ещё не наступил — берём вчерашний
      CASE WHEN c.now_local >= c.deadline_today
           THEN c.deadline_today
           ELSE c.deadline_today - interval '1 day'
      END AS current_deadline
    FROM calc c
  ),
  final AS (
    SELECT
      c.*,
      -- переводим «локальный» дедлайн обратно в timestamptz (из Asia/Yerevan)
      (c.current_deadline AT TIME ZONE 'Asia/Yerevan')                       AS deadline_tz,
      ((c.current_deadline + make_interval(hours => c.grace_hours)) AT TIME ZONE 'Asia/Yerevan') AS grace_tz,
      (c.now_local AT TIME ZONE 'Asia/Yerevan')                             AS now_tz
    FROM calc2 c
  )
  SELECT
    CASE
      WHEN f.last_run IS NULL                        THEN 'no_data'
      WHEN f.last_run >= f.deadline_tz               THEN 'exported'
      WHEN f.now_tz  <= f.grace_tz                   THEN 'awaiting'
      ELSE 'overdue'
    END AS status,
    f.last_run,
    f.deadline_tz  AS expected_by,
    f.grace_tz     AS grace_until,
    CASE WHEN f.last_run IS NULL OR f.last_run >= f.deadline_tz THEN 0
         ELSE round(EXTRACT(EPOCH FROM (f.now_tz - f.deadline_tz)) / 3600.0, 1)
    END AS hours_late,
    f.now_tz AS now_yerevan,
    f.active_modules,
    (SELECT COUNT(*)::int FROM armsoft_db.parser_modules
       WHERE last_run IS NOT NULL
         AND (last_run AT TIME ZONE 'Asia/Yerevan')::date
             = ((SELECT MAX(last_run) FROM armsoft_db.parser_modules) AT TIME ZONE 'Asia/Yerevan')::date
    ) AS last_run_modules
  FROM final f;
$$;

REVOKE ALL ON FUNCTION public.artyom_export_schedule_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.artyom_export_schedule_status() TO anon, authenticated;

CREATE OR REPLACE VIEW public.v_artyom_export_status AS
  SELECT * FROM public.artyom_export_schedule_status();
GRANT SELECT ON public.v_artyom_export_status TO anon, authenticated;

-- 3. Реестр сверки задач бухгалтеров с выгрузкой Артёма -------------------------
--    task_key стабилен между пересчётами (бухгалтер|компания|система|тип задачи),
--    чтобы самопроверка/пометки бухгалтера переживали пересчёты.
CREATE TABLE IF NOT EXISTS public.accountant_task_sync (
    id                        BIGSERIAL PRIMARY KEY,
    task_key                  TEXT NOT NULL UNIQUE,
    sync_date                 DATE NOT NULL,
    accountant_name           TEXT,
    company_name              TEXT NOT NULL,
    hvhh                      TEXT,
    system_source             TEXT,               -- armsoft | taxservice | meeting
    task_type                 TEXT,               -- ключ типа задачи (см. config.js TASK_SYNC.taskTypes)
    task_type_label           TEXT,
    work_summary              TEXT,
    last_task_date            DATE,
    in_artyom_export          BOOLEAN DEFAULT FALSE,
    match_quality             TEXT,
    not_expected_in_export    BOOLEAN DEFAULT FALSE,  -- задача, которую Артём в принципе не видит (config)
    status                    TEXT NOT NULL DEFAULT 'missing_in_export'
        CHECK (status IN ('in_export','missing_in_export','not_expected','problem')),
    problem_type              TEXT,
    problem_description       TEXT,
    -- ── модель самопроверки бухгалтером (следующий этап) ──────────────────────
    accountant_response_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (accountant_response_status IN ('pending','confirmed_ok','reported_missing','disputed')),
    accountant_response       TEXT,
    accountant_confirmed      BOOLEAN DEFAULT FALSE,
    accountant_checked_at     TIMESTAMPTZ,
    reviewer_note             TEXT,
    resolved_at               TIMESTAMPTZ,
    created_at                TIMESTAMPTZ DEFAULT NOW(),
    updated_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_sync_accountant ON public.accountant_task_sync (accountant_name);
CREATE INDEX IF NOT EXISTS idx_task_sync_status     ON public.accountant_task_sync (status);
CREATE INDEX IF NOT EXISTS idx_task_sync_date       ON public.accountant_task_sync (sync_date);

-- 4. Список проблем процесса сверки --------------------------------------------
CREATE TABLE IF NOT EXISTS public.sync_problems (
    id               BIGSERIAL PRIMARY KEY,
    problem_key      TEXT NOT NULL UNIQUE,
    category         TEXT NOT NULL DEFAULT 'coverage_gap'
        CHECK (category IN ('schedule','coverage_gap','name_mismatch','format_error','unaccounted_work','config','other')),
    severity         TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
    title            TEXT NOT NULL,
    description      TEXT,
    accountant_name  TEXT,
    company_name     TEXT,
    source           TEXT,
    detected_date    DATE,
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','ack','resolved')),
    resolved_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_problems_category ON public.sync_problems (category);
CREATE INDEX IF NOT EXISTS idx_sync_problems_status   ON public.sync_problems (status);

-- updated_at триггеры (функция public.set_updated_at уже создана ранее) ---------
DROP TRIGGER IF EXISTS trg_accountant_task_sync_updated ON public.accountant_task_sync;
CREATE TRIGGER trg_accountant_task_sync_updated BEFORE UPDATE ON public.accountant_task_sync
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_sync_problems_updated ON public.sync_problems;
CREATE TRIGGER trg_sync_problems_updated BEFORE UPDATE ON public.sync_problems
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS + политики (внутренний инструмент, как delta_items) -----------------------
ALTER TABLE public.accountant_task_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_problems        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ats_all ON public.accountant_task_sync;
CREATE POLICY ats_all ON public.accountant_task_sync FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sp_all ON public.sync_problems;
CREATE POLICY sp_all ON public.sync_problems FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.accountant_task_sync, public.sync_problems TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.accountant_task_sync_id_seq, public.sync_problems_id_seq TO anon, authenticated;
