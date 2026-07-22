-- =============================================================================
-- Утренние созвоны — ПОЛНОЕ сопоставление с выгрузкой Артёма.
--
-- Задача владельца: «take every column of OB Artyom project in database, analyze
-- it, find exact even small matches ... every word they say in the morning call
-- ... do not miss even a small caught information».
--
-- Раньше созвоны сверялись лишь по 5 категориям (счета/отчёты из 5 таблиц).
-- Здесь добавлены RPC, которые покрывают ВСЕ значимые «рабочие» таблицы
-- armsoft_db (26 категорий) — по каждому company_id (ArmSoft) и ИНН/tin
-- (налоговый кабинет). Так каждое слово бухгалтера на созвоне можно сопоставить
-- с реальной работой в любой системе, а не только со счётом/отчётом.
--
-- Проект: OB Artyom (rbtvbsbcycdlwmrzjwun).
-- Функции SECURITY DEFINER — anon-фронт не имеет прямого доступа к armsoft_db.
-- =============================================================================

-- --------------------------------------------------------------------------
-- Устойчивый парсер текстовых дат из выгрузки. В armsoft_db часть дат хранится
-- строками: 'DD.MM.YYYY' (архив форм, ЕАЭС, регистры…) и 'DD/MM/YY HH:MI'
-- (черновики форм). Возвращает date или NULL, никогда не падает.
-- --------------------------------------------------------------------------
create or replace function public._mc_parse_date(p text)
returns date
language plpgsql
immutable
as $$
declare s text; d date;
begin
  if p is null then return null; end if;
  s := split_part(btrim(p), ' ', 1);   -- отбрасываем время, если есть
  if s = '' then return null; end if;
  begin
    if s ~ '^\d{1,2}\.\d{1,2}\.\d{4}$' then
      d := to_date(s, 'DD.MM.YYYY');
    elsif s ~ '^\d{1,2}/\d{1,2}/\d{2}$' then
      d := to_date(s, 'DD/MM/YY');
    elsif s ~ '^\d{1,2}/\d{1,2}/\d{4}$' then
      d := to_date(s, 'DD/MM/YYYY');
    elsif s ~ '^\d{4}-\d{2}-\d{2}' then
      d := to_date(substr(s, 1, 10), 'YYYY-MM-DD');
    else
      d := null;
    end if;
  exception when others then
    d := null;
  end;
  return d;
end $$;

-- Устойчивый парсер чисел: часть денежных полей выгрузки хранится строками
-- ('1 234,56' и т.п.). Возвращает numeric или NULL, никогда не падает.
create or replace function public._mc_num(p text)
returns numeric
language plpgsql
immutable
as $$
declare r numeric; s text;
begin
  if p is null then return null; end if;
  s := replace(replace(btrim(p), ' ', ''), ',', '.');
  if s = '' then return null; end if;
  begin r := s::numeric; exception when others then r := null; end;
  return r;
end $$;

-- --------------------------------------------------------------------------
-- ob_accountant_activity_full — счётчики РЕАЛЬНОЙ работы по дню и категории
-- по ВСЕМ системам выгрузки Артёма. Ключи: p_company_ids (ArmSoft company_id),
-- p_tins (ИНН/tin налогового кабинета). Диапазон [p_from, p_to] — включительно.
--
-- Категории (system → category):
--   ArmSoft:  invoice_issued, invoice_received, transfer_invoice, purchase_doc,
--             cash_receipt, reconciliation_act, document_journal,
--             journal_operation, fixed_asset, arm_employee, material, partner,
--             vat_calc
--   TaxService: report, saved_form, tax_invoice_issued, tax_invoice_received,
--             tax_doc_issued, tax_doc_received, eeu_transaction, tax_employee,
--             cashbook, hdm_fiscal, ledger_entry, penalty, unified_account
-- --------------------------------------------------------------------------
create or replace function public.ob_accountant_activity_full(
  p_company_ids integer[] default '{}'::integer[],
  p_tins        text[]    default '{}'::text[],
  p_from        date      default null,
  p_to          date      default null
)
returns table(activity_date date, system text, category text, cnt bigint)
language sql
stable
security definer
set search_path to ''
as $function$
  with ev as (
    -- ---- ArmSoft (по company_id) ----
    select i.doc_date::date d, 'ArmSoft'::text system, 'invoice_issued'::text category
      from armsoft_db.parsed_issued_invoices i
      where i.company_id = any(p_company_ids)
    union all
    select r.submission_date::date, 'ArmSoft', 'invoice_received'
      from armsoft_db.parsed_received_invoices r
      where r.company_id = any(p_company_ids)
    union all
    select t.doc_date::date, 'ArmSoft', 'transfer_invoice'
      from armsoft_db.parsed_issued_transfer_invoices t
      where t.company_id = any(p_company_ids)
    union all
    select p.doc_date::date, 'ArmSoft', 'purchase_doc'
      from armsoft_db.parsed_purchase_documents p
      where p.company_id = any(p_company_ids)
    union all
    select c.doc_date::date, 'ArmSoft', 'cash_receipt'
      from armsoft_db.parsed_cash_register_receipts c
      where c.company_id = any(p_company_ids)
    union all
    select a.doc_date::date, 'ArmSoft', 'reconciliation_act'
      from armsoft_db.parsed_reconciliation_acts a
      where a.company_id = any(p_company_ids)
    union all
    select dj.doc_date::date, 'ArmSoft', 'document_journal'
      from armsoft_db.parsed_documents_journal dj
      where dj.company_id = any(p_company_ids)
    union all
    select jo.operation_date::date, 'ArmSoft', 'journal_operation'
      from armsoft_db.parsed_journal_operations jo
      where jo.company_id = any(p_company_ids)
    union all
    select fa.date_in::date, 'ArmSoft', 'fixed_asset'
      from armsoft_db.parsed_fixed_assets fa
      where fa.company_id = any(p_company_ids)
    union all
    select e.change_date::date, 'ArmSoft', 'arm_employee'
      from armsoft_db.parsed_employees e
      where e.company_id = any(p_company_ids)
    union all
    select m.change_date::date, 'ArmSoft', 'material'
      from armsoft_db.parsed_materials m
      where m.company_id = any(p_company_ids)
    union all
    select pt.change_date::date, 'ArmSoft', 'partner'
      from armsoft_db.parsed_partners pt
      where pt.company_id = any(p_company_ids)
    union all
    select make_date(v.reporting_year, v.reporting_month, 1), 'ArmSoft', 'vat_calc'
      from armsoft_db.parsed_vat_calculations v
      where v.company_id = any(p_company_ids)
        and v.reporting_year is not null
        and v.reporting_month between 1 and 12
    -- ---- TaxService (по ИНН/tin) ----
    union all
    select public._mc_parse_date(f.submission_date), 'TaxService', 'report'
      from armsoft_db.tax_archive_forms f
      where f.inn = any(p_tins)
    union all
    select public._mc_parse_date(sf.modified_date), 'TaxService', 'saved_form'
      from armsoft_db.tax_saved_forms sf
      where sf.inn = any(p_tins)
    union all
    select ti.issued_at::date, 'TaxService', 'tax_invoice_issued'
      from armsoft_db.tax_invoices_issued ti
      where ti.tin = any(p_tins)
    union all
    select tr.issued_at::date, 'TaxService', 'tax_invoice_received'
      from armsoft_db.tax_invoices_received tr
      where tr.tin = any(p_tins)
    union all
    select di.issued_at::date, 'TaxService', 'tax_doc_issued'
      from armsoft_db.tax_acc_docs_issued di
      where di.tin = any(p_tins)
    union all
    select dr.issued_at::date, 'TaxService', 'tax_doc_received'
      from armsoft_db.tax_acc_docs_received dr
      where dr.tin = any(p_tins)
    union all
    select public._mc_parse_date(eu.import_export_date), 'TaxService', 'eeu_transaction'
      from armsoft_db.tax_eeu_transactions eu
      where eu.inn = any(p_tins)
    union all
    select public._mc_parse_date(te.submission_date), 'TaxService', 'tax_employee'
      from armsoft_db.tax_employees te
      where te.inn = any(p_tins)
    union all
    select cb.reg_date, 'TaxService', 'cashbook'
      from armsoft_db.tax_cashbook cb
      where cb.inn = any(p_tins)
    union all
    select public._mc_parse_date(hf.period_end), 'TaxService', 'hdm_fiscal'
      from armsoft_db.tax_hdm_fiscal hf
      where hf.inn = any(p_tins)
    union all
    select public._mc_parse_date(l.row_date), 'TaxService', 'ledger_entry'
      from armsoft_db.tax_ledger l
      where l.inn = any(p_tins)
    union all
    select public._mc_parse_date(ph.row_date), 'TaxService', 'penalty'
      from armsoft_db.tax_penalty_history ph
      where ph.inn = any(p_tins)
    union all
    select public._mc_parse_date(ua.row_date), 'TaxService', 'unified_account'
      from armsoft_db.tax_unified_account ua
      where ua.inn = any(p_tins)
  )
  select d as activity_date, system, category, count(*)::bigint as cnt
  from ev
  where d is not null
    and (p_from is null or d >= p_from)
    and (p_to   is null or d <= p_to)
  group by d, system, category
  order by d desc, system, category;
$function$;

-- --------------------------------------------------------------------------
-- ob_accountant_day_feed_full — конкретные документы за день и категорию
-- (drill «показать за что») по ВСЕМ категориям выше. Для крупных регистров
-- (проводки, лицевой счёт, единый счёт) заголовок обобщён.
-- --------------------------------------------------------------------------
create or replace function public.ob_accountant_day_feed_full(
  p_company_ids integer[] default '{}'::integer[],
  p_tins        text[]    default '{}'::text[],
  p_day         date      default null,
  p_category    text      default null,
  p_limit       integer   default 400
)
returns table(task_date date, system text, category text, company text,
              title text, detail text, amount numeric, currency text, status text)
language sql
stable
security definer
set search_path to ''
as $function$
  with ev as (
    select i.doc_date::date task_date, 'ArmSoft'::text system, 'invoice_issued'::text category,
           ac.caption company,
           (coalesce(i.doc_type_name,'Счёт') || coalesce(' №'||nullif(i.doc_num,''),'')) title,
           i.part_name detail, i.summ amount, i.curr_code currency, i.doc_state_name status
      from armsoft_db.parsed_issued_invoices i
      left join armsoft_db.armsoft_companies ac on ac.company_id=i.company_id
      where i.company_id = any(p_company_ids)
    union all
    select r.submission_date::date, 'ArmSoft', 'invoice_received', ac.caption,
           ('Полученный счёт'||coalesce(' №'||nullif(r.serial_and_number,''),'')),
           r.supplier_name, r.sum_total, r.curr_code, null
      from armsoft_db.parsed_received_invoices r
      left join armsoft_db.armsoft_companies ac on ac.company_id=r.company_id
      where r.company_id = any(p_company_ids)
    union all
    select t.doc_date::date, 'ArmSoft', 'transfer_invoice', ac.caption,
           ('Накладная / передаточный'||coalesce(' №'||nullif(t.doc_num,''),'')),
           t.part_name, t.summ, t.curr_code, null
      from armsoft_db.parsed_issued_transfer_invoices t
      left join armsoft_db.armsoft_companies ac on ac.company_id=t.company_id
      where t.company_id = any(p_company_ids)
    union all
    select p.doc_date::date, 'ArmSoft', 'purchase_doc', ac.caption,
           (coalesce(p.doc_type_name,'Документ закупки')||coalesce(' №'||nullif(p.doc_num,''),'')),
           p.part_name, p.summ, p.curr_code, p.doc_state_name
      from armsoft_db.parsed_purchase_documents p
      left join armsoft_db.armsoft_companies ac on ac.company_id=p.company_id
      where p.company_id = any(p_company_ids)
    union all
    select c.doc_date::date, 'ArmSoft', 'cash_receipt', ac.caption,
           (coalesce(c.doc_type_name,'Кассовый документ')||coalesce(' №'||nullif(c.doc_num,''),'')),
           c.part_name, c.summ, null, c.doc_state_name
      from armsoft_db.parsed_cash_register_receipts c
      left join armsoft_db.armsoft_companies ac on ac.company_id=c.company_id
      where c.company_id = any(p_company_ids)
    union all
    select a.doc_date::date, 'ArmSoft', 'reconciliation_act', ac.caption,
           ('Акт сверки'||coalesce(' №'||nullif(a.doc_num,''),'')),
           a.part_name, null, a.curr_code, a.doc_state_name
      from armsoft_db.parsed_reconciliation_acts a
      left join armsoft_db.armsoft_companies ac on ac.company_id=a.company_id
      where a.company_id = any(p_company_ids)
    union all
    select dj.doc_date::date, 'ArmSoft', 'document_journal', ac.caption,
           (coalesce(dj.doc_type_name,'Документ')||coalesce(' №'||nullif(dj.doc_num,''),'')),
           coalesce(nullif(dj.part_name,''), dj.comment), dj.summ, dj.curr_code, dj.doc_state_name
      from armsoft_db.parsed_documents_journal dj
      left join armsoft_db.armsoft_companies ac on ac.company_id=dj.company_id
      where dj.company_id = any(p_company_ids)
    union all
    select jo.operation_date::date, 'ArmSoft', 'journal_operation', ac.caption,
           ('Проводка Дт '||coalesce(jo.account_code_db,'—')||' Кт '||coalesce(jo.account_code_cr,'—')),
           coalesce(nullif(jo.comment,''), jo.doc_type_name), jo.summ, jo.curr_code_db, null
      from armsoft_db.parsed_journal_operations jo
      left join armsoft_db.armsoft_companies ac on ac.company_id=jo.company_id
      where jo.company_id = any(p_company_ids)
    union all
    select fa.date_in::date, 'ArmSoft', 'fixed_asset', ac.caption,
           ('Основное средство'||coalesce(' '||nullif(fa.name,''),'')),
           fa.department, null, null, fa.doc_state_name
      from armsoft_db.parsed_fixed_assets fa
      left join armsoft_db.armsoft_companies ac on ac.company_id=fa.company_id
      where fa.company_id = any(p_company_ids)
    union all
    select e.change_date::date, 'ArmSoft', 'arm_employee', ac.caption,
           ('Сотрудник (ArmSoft)'||coalesce(' '||nullif(e.name,''),'')),
           e.position, null, null, null
      from armsoft_db.parsed_employees e
      left join armsoft_db.armsoft_companies ac on ac.company_id=e.company_id
      where e.company_id = any(p_company_ids)
    union all
    select m.change_date::date, 'ArmSoft', 'material', ac.caption,
           ('Товар / материал'||coalesce(' '||nullif(m.name,''),'')),
           m.mat_group, m.price, null, null
      from armsoft_db.parsed_materials m
      left join armsoft_db.armsoft_companies ac on ac.company_id=m.company_id
      where m.company_id = any(p_company_ids)
    union all
    select pt.change_date::date, 'ArmSoft', 'partner', ac.caption,
           ('Контрагент'||coalesce(' '||nullif(pt.name,''),'')),
           pt.type_caption, null, null, null
      from armsoft_db.parsed_partners pt
      left join armsoft_db.armsoft_companies ac on ac.company_id=pt.company_id
      where pt.company_id = any(p_company_ids)
    union all
    select make_date(v.reporting_year, v.reporting_month, 1), 'ArmSoft', 'vat_calc', ac.caption,
           ('Расчёт НДС '||v.reporting_year||'-'||lpad(v.reporting_month::text,2,'0')),
           v.taxpayer_name, v.vat_to_pay, 'AMD', null
      from armsoft_db.parsed_vat_calculations v
      left join armsoft_db.armsoft_companies ac on ac.company_id=v.company_id
      where v.company_id = any(p_company_ids)
        and v.reporting_year is not null and v.reporting_month between 1 and 12
    -- ---- TaxService ----
    union all
    select public._mc_parse_date(f.submission_date), 'TaxService', 'report', f.pdf_company_name,
           f.form_name, nullif(f.report_period,''), null, null, f.status
      from armsoft_db.tax_archive_forms f
      where f.inn = any(p_tins)
    union all
    select public._mc_parse_date(sf.modified_date), 'TaxService', 'saved_form', null,
           ('Черновик / подготовка: '||coalesce(sf.form_name,'форма')), nullif(sf.report_period,''),
           null, null, null
      from armsoft_db.tax_saved_forms sf
      where sf.inn = any(p_tins)
    union all
    select ti.issued_at::date, 'TaxService', 'tax_invoice_issued', ti.supplier_name,
           ('Налоговый счёт'||coalesce(' '||nullif(ti.serial_no,''),'')),
           ti.buyer_name, ti.total, 'AMD', ti.status
      from armsoft_db.tax_invoices_issued ti
      where ti.tin = any(p_tins)
    union all
    select tr.issued_at::date, 'TaxService', 'tax_invoice_received', tr.buyer_name,
           ('Полученный налоговый счёт'||coalesce(' '||nullif(tr.serial_no,''),'')),
           tr.supplier_name, tr.total, 'AMD', tr.status
      from armsoft_db.tax_invoices_received tr
      where tr.tin = any(p_tins)
    union all
    select di.issued_at::date, 'TaxService', 'tax_doc_issued', di.supplier_name,
           ('Налоговая накладная (выст.)'||coalesce(' '||nullif(di.serial_no,''),'')),
           di.buyer_name, di.total_value, 'AMD', di.status
      from armsoft_db.tax_acc_docs_issued di
      where di.tin = any(p_tins)
    union all
    select dr.issued_at::date, 'TaxService', 'tax_doc_received', dr.buyer_name,
           ('Налоговая накладная (получ.)'||coalesce(' '||nullif(dr.serial_no,''),'')),
           dr.supplier_name, dr.total_value, 'AMD', dr.status
      from armsoft_db.tax_acc_docs_received dr
      where dr.tin = any(p_tins)
    union all
    select public._mc_parse_date(eu.import_export_date), 'TaxService', 'eeu_transaction', null,
           ('Операция ЕАЭС: '||coalesce(eu.transaction_type, eu.doc_name, 'документ')),
           eu.doc_status, null, null, eu.transaction_status
      from armsoft_db.tax_eeu_transactions eu
      where eu.inn = any(p_tins)
    union all
    select public._mc_parse_date(te.submission_date), 'TaxService', 'tax_employee', null,
           ('Сотрудник: '||coalesce(te.first_name,'')||' '||coalesce(te.last_name,'')),
           te.position, null, null, te.kkh_status
      from armsoft_db.tax_employees te
      where te.inn = any(p_tins)
    union all
    select cb.reg_date, 'TaxService', 'cashbook', null,
           ('Кассовая книга'||coalesce(' ('||nullif(cb.currency,'')||')','')),
           cb.status, null, cb.currency, cb.status
      from armsoft_db.tax_cashbook cb
      where cb.inn = any(p_tins)
    union all
    select public._mc_parse_date(hf.period_end), 'TaxService', 'hdm_fiscal', null,
           ('ХДМ / фискальные данные '||coalesce(hf.hdm_reg_number,'')),
           ('Продаж: '||coalesce(hf.sales_count,'0')), public._mc_num(hf.sales_amount_total), 'AMD', null
      from armsoft_db.tax_hdm_fiscal hf
      where hf.inn = any(p_tins)
    union all
    select public._mc_parse_date(l.row_date), 'TaxService', 'ledger_entry', null,
           ('Лицевой счёт: '||coalesce(l.operation_content,'операция')),
           l.fgh, public._mc_num(l.tax_obligation_payment), 'AMD', l.row_class
      from armsoft_db.tax_ledger l
      where l.inn = any(p_tins)
    union all
    select public._mc_parse_date(ph.row_date), 'TaxService', 'penalty', null,
           ('Пеня / штраф: '||coalesce(ph.operation,'')),
           ph.fgh, public._mc_num(ph.balance), 'AMD', null
      from armsoft_db.tax_penalty_history ph
      where ph.inn = any(p_tins)
    union all
    select public._mc_parse_date(ua.row_date), 'TaxService', 'unified_account', null,
           ('Единый счёт: '||coalesce(ua.operation,'операция')),
           ua.fgh, public._mc_num(ua.balance), 'AMD', null
      from armsoft_db.tax_unified_account ua
      where ua.inn = any(p_tins)
  )
  select task_date, system, category, company, title, detail, amount, currency, status
  from ev
  where task_date is not null
    and (p_day is null or task_date = p_day)
    and (p_category is null or category = p_category)
  order by task_date desc, system, category
  limit greatest(1, least(coalesce(p_limit, 400), 1000));
$function$;

-- доступ анонимному фронту (RLS на armsoft_db не даёт прямого доступа — только через эти definer-функции)
grant execute on function public.ob_accountant_activity_full(integer[], text[], date, date) to anon, authenticated;
grant execute on function public.ob_accountant_day_feed_full(integer[], text[], date, text, integer) to anon, authenticated;
