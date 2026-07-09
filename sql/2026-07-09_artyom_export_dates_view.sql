-- =============================================================================
-- Копия миграции, УЖЕ применённой к проекту Supabase "OB Artyom"
-- (rbtvbsbcycdlwmrzjwun) под именем `artyom_export_dates_view`.
-- Хранится в репозитории для справки. Миграция аддитивная: создаёт один
-- public-view над armsoft_db.parser_modules (по образцу v_tax_accounts /
-- v_armsoft_companies), существующие объекты не изменяет.
--
-- Назначение: история выгрузок Артёма по датам — для графика «все выгрузки
-- за всё время» в разделе «Выгрузки» дашборда. Каждая строка = дата, когда
-- отрабатывали парсеры Артёма, и сколько модулей запустилось в этот день.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_artyom_export_dates AS
SELECT
  ((last_run AT TIME ZONE 'Asia/Yerevan')::date) AS run_date,
  COUNT(*)                                        AS modules_run,
  MAX(last_run)                                   AS last_run_time
FROM armsoft_db.parser_modules
WHERE last_run IS NOT NULL
GROUP BY 1
ORDER BY 1;

GRANT SELECT ON public.v_artyom_export_dates TO anon, authenticated;
