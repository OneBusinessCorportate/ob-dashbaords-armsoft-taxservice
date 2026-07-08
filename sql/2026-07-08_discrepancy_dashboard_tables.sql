-- =============================================================================
-- Копия миграции, УЖЕ применённой к проекту Supabase "OB Artyom"
-- (rbtvbsbcycdlwmrzjwun) под именем `discrepancy_dashboard_tables`.
-- Хранится в репозитории для справки. Миграция аддитивная: создаёт 3 новые
-- таблицы + 1 view, существующие таблицы не изменяет и не удаляет.
-- =============================================================================

-- 1. Один снимок в день: агрегированная дельта
CREATE TABLE IF NOT EXISTS public.daily_delta_snapshots (
    id                   BIGSERIAL PRIMARY KEY,
    snapshot_date        DATE NOT NULL UNIQUE,
    total_active_clients INTEGER NOT NULL DEFAULT 0,
    active_with_hvhh     INTEGER NOT NULL DEFAULT 0,
    expected_taxservice  INTEGER NOT NULL DEFAULT 0,
    found_taxservice     INTEGER NOT NULL DEFAULT 0,
    missing_taxservice   INTEGER NOT NULL DEFAULT 0,
    expected_armsoft     INTEGER NOT NULL DEFAULT 0,
    found_armsoft        INTEGER NOT NULL DEFAULT 0,
    missing_armsoft      INTEGER NOT NULL DEFAULT 0,
    total_delta          INTEGER NOT NULL DEFAULT 0,
    previous_delta       INTEGER,
    delta_change         INTEGER,
    artyom_export_time   TIMESTAMPTZ,
    artyom_export_records INTEGER,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Живой реестр расхождений. issue_key — стабильный идентификатор
--    (тип + ՀՎՀՀ либо нормализованное название), чтобы статусы проверки
--    Эмилии переживали пересчёты и смену дат.
CREATE TABLE IF NOT EXISTS public.delta_items (
    id                       BIGSERIAL PRIMARY KEY,
    issue_key                TEXT NOT NULL UNIQUE,
    snapshot_date            DATE NOT NULL,
    last_seen_date           DATE,
    resolved_at              TIMESTAMPTZ,
    company_name             TEXT NOT NULL,
    hvhh                     TEXT,
    accountant_name          TEXT,
    client_is_active         BOOLEAN,
    issue_type               TEXT NOT NULL,
    expected_system          TEXT,
    missing_from_system      TEXT,
    exists_in_taxservice     BOOLEAN DEFAULT FALSE,
    exists_in_armsoft        BOOLEAN DEFAULT FALSE,
    exists_in_artyom_export  BOOLEAN DEFAULT FALSE,  -- = найдено в tax ИЛИ armsoft выгрузке
    exists_in_ob_registry    BOOLEAN DEFAULT FALSE,  -- добавлено миграцией delta_items_add_ob_registry_flag
    exists_in_morning_meeting BOOLEAN DEFAULT FALSE,
    match_quality            TEXT,
    possible_reason          TEXT,
    source_table             TEXT,
    confirmation_status      TEXT NOT NULL DEFAULT 'not_checked'
        CHECK (confirmation_status IN (
            'not_checked',
            'confirmed_not_in_armsoft',
            'confirmed_not_in_taxservice',
            'confirmed_artyom_export_problem',
            'confirmed_accountant_mistake',
            'confirmed_duplicate_name_mismatch',
            'confirmed_no_action_needed'
        )),
    comment                  TEXT,
    responsible_person       TEXT,
    priority                 TEXT NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('low','medium','high')),
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delta_items_issue_type ON public.delta_items (issue_type);
CREATE INDEX IF NOT EXISTS idx_delta_items_confirmation ON public.delta_items (confirmation_status);
CREATE INDEX IF NOT EXISTS idx_delta_items_snapshot_date ON public.delta_items (snapshot_date);

-- 3. ТЗ Артёму: автозаполняется из подтверждённых проблем выгрузки
CREATE TABLE IF NOT EXISTS public.artyom_tz_items (
    id                BIGSERIAL PRIMARY KEY,
    delta_item_id     BIGINT UNIQUE REFERENCES public.delta_items(id) ON DELETE CASCADE,
    company_name      TEXT NOT NULL,
    hvhh              TEXT,
    issue_description TEXT,
    expected_source   TEXT,
    actual_source     TEXT,
    date_detected     DATE,
    priority          TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
    status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','sent','fixed','cancelled')),
    comment           TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_daily_delta_snapshots_updated ON public.daily_delta_snapshots;
CREATE TRIGGER trg_daily_delta_snapshots_updated BEFORE UPDATE ON public.daily_delta_snapshots
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_delta_items_updated ON public.delta_items;
CREATE TRIGGER trg_delta_items_updated BEFORE UPDATE ON public.delta_items
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_artyom_tz_items_updated ON public.artyom_tz_items;
CREATE TRIGGER trg_artyom_tz_items_updated BEFORE UPDATE ON public.artyom_tz_items
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Внутренний инструмент: anon получает полный доступ, но RLS включён
-- с явными политиками — правило легко ужесточить позже.
ALTER TABLE public.daily_delta_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delta_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.artyom_tz_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dds_all ON public.daily_delta_snapshots;
CREATE POLICY dds_all ON public.daily_delta_snapshots FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS di_all ON public.delta_items;
CREATE POLICY di_all ON public.delta_items FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS atz_all ON public.artyom_tz_items;
CREATE POLICY atz_all ON public.artyom_tz_items FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_delta_snapshots, public.delta_items, public.artyom_tz_items TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.daily_delta_snapshots_id_seq, public.delta_items_id_seq, public.artyom_tz_items_id_seq TO anon, authenticated;

-- Метаданные выгрузки Артёма: время последнего прогона парсеров + количества
CREATE OR REPLACE VIEW public.v_artyom_export_meta AS
SELECT
  (SELECT MAX(last_run) FROM armsoft_db.parser_modules)            AS last_export_time,
  (SELECT COUNT(*) FROM armsoft_db.parser_modules WHERE is_active) AS active_modules,
  (SELECT COUNT(*) FROM armsoft_db.armsoft_companies)              AS armsoft_companies_count,
  (SELECT COUNT(*) FROM armsoft_db.tax_accounts)                   AS tax_accounts_count,
  (SELECT MAX(updated_at) FROM armsoft_db.armsoft_companies)       AS armsoft_last_updated,
  (SELECT MAX(updated_at) FROM armsoft_db.tax_accounts)            AS tax_last_updated;

GRANT SELECT ON public.v_artyom_export_meta TO anon, authenticated;
