-- =============================================================================
-- Фикс: «Сохранить день» падал с ошибкой
--   invalid input syntax for type integer: "46.8"
--
-- ПРИЧИНА: колонка public.accountant_day_reports.export_minutes была INTEGER,
--   а дневной итог минут по хронометражу — ДРОБНЫЙ: норматив на услугу дробный
--   (счёт = 7.8 мин, config.js → CHRONO.minutesPerUnit), поэтому сумма за день
--   вроде 6 × 7.8 = 46.8. PostgREST/Postgres отвергал дробь для integer, и
--   upsert обратной связи бухгалтера за день не сохранялся.
--
-- РЕШЕНИЕ: расширяем тип колонки до numeric (реальное значение хранится без
--   округления). Аддитивно и идемпотентно: existing integer-значения кастятся
--   без потерь, при повторном применении тип уже numeric.
--
-- Применяется к проекту Supabase "OB Artyom" (rbtvbsbcycdlwmrzjwun).
-- =============================================================================

ALTER TABLE public.accountant_day_reports
  ALTER COLUMN export_minutes TYPE numeric USING export_minutes::numeric;
