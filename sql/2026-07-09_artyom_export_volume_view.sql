-- =============================================================================
-- Копия миграций, УЖЕ применённых к проекту Supabase "OB Artyom"
-- (rbtvbsbcycdlwmrzjwun): `artyom_export_volume_view` +
-- `artyom_export_volume_view_security_definer`. Хранится для справки.
-- Миграции аддитивные: создают одну public-функцию и один view над таблицами
-- armsoft_db; существующие объекты не изменяют.
--
-- Назначение: реальный ОБЪЁМ выгрузки Артёма по всему проекту OB Artyom.
-- Раньше дашборд считал «объём выгрузки» только по двум таблицам-справочникам
-- (tax_accounts + armsoft_companies ≈ 1304 строки), что кратно занижало
-- реальную картину. На деле парсеры Артёма загрузили ~1.6 млн строк в ~40
-- таблиц (журналы документов, счета, операции, курсы валют и т.д.).
--
-- Считать приходится через SECURITY DEFINER-функцию: динамический count(*)
-- внутри query_to_xml выполняется с правами ВЫЗЫВАЮЩЕГО, а у anon нет прямого
-- доступа к таблицам armsoft_db. Выполнение от имени владельца функции (у него
-- доступ есть) повторяет то, как уже работают обычные v_*-view.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.artyom_export_volume()
RETURNS TABLE (category text, source_table text, label text, record_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH counts(category, source_table, label) AS (
    VALUES
      ('ArmSoft','armsoft_companies','Компании ArmSoft'),
      ('ArmSoft','parsed_all_documents_journal','Обобщённый журнал документов'),
      ('ArmSoft','parsed_bank_accounts','Банковские счета'),
      ('ArmSoft','parsed_cash_register_receipts','ՀԴՄ кассовые чеки'),
      ('ArmSoft','parsed_chart_of_accounts','План счетов'),
      ('ArmSoft','parsed_complect_components','Компоненты комплектов'),
      ('ArmSoft','parsed_currency_rates','Курсы валют'),
      ('ArmSoft','parsed_document_items','Номенклатура документов'),
      ('ArmSoft','parsed_documents_journal','Журнал документов'),
      ('ArmSoft','parsed_employees','Сотрудники (ArmSoft)'),
      ('ArmSoft','parsed_fixed_assets','Основные средства'),
      ('ArmSoft','parsed_issued_invoices','Выданные счета'),
      ('ArmSoft','parsed_issued_transfer_invoices','Выданные передаточные счета'),
      ('ArmSoft','parsed_journal_operations','Журнал операций'),
      ('ArmSoft','parsed_materials','Материальные ценности'),
      ('ArmSoft','parsed_partners','Партнёры'),
      ('ArmSoft','parsed_purchase_documents','Документы закупок'),
      ('ArmSoft','parsed_received_invoices','Полученные счета'),
      ('ArmSoft','parsed_reconciliation_acts','Акты сверки'),
      ('ArmSoft','parsed_user_roles','Права доступа'),
      ('ArmSoft','parsed_users','Пользователи'),
      ('ArmSoft','parsed_vat_calculations','Расчёты НДС'),
      ('TaxService','tax_accounts','Налоговые кабинеты'),
      ('TaxService','tax_acc_docs_issued','Учётные документы — выданные'),
      ('TaxService','tax_acc_docs_received','Учётные документы — полученные'),
      ('TaxService','tax_archive_forms','Сданные отчёты (архив)'),
      ('TaxService','tax_cashbook','Кассовые книги'),
      ('TaxService','tax_eeu_transactions','Сделки ЕАЭС'),
      ('TaxService','tax_employees','Сотрудники (налоговая)'),
      ('TaxService','tax_employees_archive','Сотрудники (архив)'),
      ('TaxService','tax_fine_history','История штрафов'),
      ('TaxService','tax_hdm_deal','ՀԴՄ сделки'),
      ('TaxService','tax_hdm_fiscal','ՀԴՄ фискальные'),
      ('TaxService','tax_hdm_list','ՀԴՄ список'),
      ('TaxService','tax_hdm_turnover','ՀԴՄ оборот'),
      ('TaxService','tax_invoices_issued','Налоговые счета — выданные'),
      ('TaxService','tax_invoices_received','Налоговые счета — полученные'),
      ('TaxService','tax_ledger','Книга по видам налогов'),
      ('TaxService','tax_login_results','Результаты входа'),
      ('TaxService','tax_passport_data','Паспортные данные'),
      ('TaxService','tax_penalty_history','История пеней'),
      ('TaxService','tax_saved_forms','Незавершённые отчёты'),
      ('TaxService','tax_unified_account','Единый счёт')
  )
  SELECT
    c.category,
    c.source_table,
    c.label,
    (pg_catalog.xpath('/row/c/text()',
       pg_catalog.query_to_xml(pg_catalog.format('SELECT count(*) AS c FROM armsoft_db.%I', c.source_table),
                    false, true, ''))
    )[1]::text::bigint AS record_count
  FROM counts c
  ORDER BY record_count DESC;
$$;

CREATE OR REPLACE VIEW public.v_artyom_export_volume AS
  SELECT category, source_table, label, record_count FROM public.artyom_export_volume();

REVOKE ALL ON FUNCTION public.artyom_export_volume() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.artyom_export_volume() TO anon, authenticated;
GRANT SELECT ON public.v_artyom_export_volume TO anon, authenticated;
