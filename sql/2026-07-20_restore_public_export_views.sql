-- =============================================================================
-- Восстановление curated public-views над armsoft_db, которые нужны дашборду.
-- Применяется к проекту Supabase "OB Artyom" (rbtvbsbcycdlwmrzjwun) миграцией
-- `restore_public_export_views`.
--
-- ПОЧЕМУ ЭТО НУЖНО:
--   PostgREST (API дашборда) читает только схему public. Базовые таблицы Артёма
--   лежат в схеме armsoft_db. Когда парсеры Артёма пересоздают armsoft_db,
--   зависимые public-view удаляются каскадом. Так пропали:
--       public.v_armsoft_companies
--       public.v_artyom_export_meta
--       public.v_artyom_export_dates
--   Из-за этого дашборд падал с «Could not find the table 'public.…'».
--   (v_tax_accounts восстановлен ранее миграцией create_public_v_tax_accounts.)
--
-- БЕЗОПАСНОСТЬ:
--   Ни один view НЕ выставляет учётные данные. В частности из tax_accounts
--   НЕ отдаются username/password; из armsoft_companies НЕ отдаются
--   local_token / login_raw_data / service_url / db_service_url.
--
-- Миграция аддитивная и идемпотентная (CREATE OR REPLACE VIEW): существующие
-- таблицы не изменяет.
-- =============================================================================

-- 1. Компании ArmSoft (без токенов/URL-сервисов) --------------------------------
CREATE OR REPLACE VIEW public.v_armsoft_companies AS
SELECT
  company_id,
  company_key,
  name,
  caption,
  ps_mode,
  is_blocked,
  is_active,
  updated_at
FROM armsoft_db.armsoft_companies;

GRANT SELECT ON public.v_armsoft_companies TO anon, authenticated;

-- 2. Метаданные последней выгрузки Артёма --------------------------------------
CREATE OR REPLACE VIEW public.v_artyom_export_meta AS
SELECT
  (SELECT MAX(last_run) FROM armsoft_db.parser_modules)            AS last_export_time,
  (SELECT COUNT(*) FROM armsoft_db.parser_modules WHERE is_active) AS active_modules,
  (SELECT COUNT(*) FROM armsoft_db.armsoft_companies)              AS armsoft_companies_count,
  (SELECT COUNT(*) FROM armsoft_db.tax_accounts)                   AS tax_accounts_count,
  (SELECT MAX(updated_at) FROM armsoft_db.armsoft_companies)       AS armsoft_last_updated,
  (SELECT MAX(updated_at) FROM armsoft_db.tax_accounts)            AS tax_last_updated;

GRANT SELECT ON public.v_artyom_export_meta TO anon, authenticated;

-- 3. История выгрузок Артёма по датам (для графика «Выгрузки») ------------------
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
