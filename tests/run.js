/* =============================================================================
 * Тесты чистой логики (без браузера/сети).
 * Запуск: `npm test` (node tests/run.js).
 *
 * Дашборд написан на глобалах (script-теги), поэтому исходники грузим как текст
 * и исполняем в одной области видимости с тестами, подставив заглушку todayStr.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..', 'public', 'js');
const read = (f) => fs.readFileSync(path.join(base, f), 'utf8');

// заглушки браузерных глобалов, которые нужны загружаемым модулям
const STUB = 'function todayStr(){return "2026-07-20";}\n';
const SRC = ['config.js', 'normalize.js', 'tasksync.js', 'accountants.js'].map(read).join('\n');

let passed = 0;
const fails = [];
function ok(cond, msg) { if (cond) passed++; else fails.push(msg); }
function eq(a, b, msg) { ok(a === b, `${msg} — ожидалось ${JSON.stringify(b)}, получили ${JSON.stringify(a)}`); }

const TESTS = `
// ---- normalize ----
eq(normalizeName('ООО «Alpha»'), 'alpha', 'normalizeName убирает форму и кавычки');
eq(normalizeHvhh('  01-234 567 '), '01234567', 'normalizeHvhh чистит разделители');

// ---- isWorkNotInExport (config-паттерны) ----
ok(isWorkNotInExport('Устное согласование по ставкам'), 'устное согласование => не в выгрузке');
ok(isWorkNotInExport('Консультация с директором'), 'консультация => не в выгрузке');
ok(!isWorkNotInExport('Выписала 3 инвойса'), 'обычная работа => в выгрузке ожидается');

// ---- computeTaskSync ----
const src = {
  clients: [{ company_name: 'Alpha LLC', accountant_name: 'Ann', is_active: true, tax_account_id: 1, armsoft_company_id: 10 }],
  tax: [{ id: 1, client_name_ru: 'Alpha LLC', tin: '111', org_name_hy: 'Ալֆա' }],
  armsoft: [{ company_id: 10, caption: 'Alpha LLC', name: 'alpha' }],
  activities: [
    { company_name: 'Alpha LLC', accountant_name: 'Ann', activity_date: '2026-07-10', system_source: 'taxservice', invoices_issued: 5, reports_submitted: 0, applications_filed: 0, balance_changes: 0 },
    { company_name: 'Beta LLC',  accountant_name: 'Ann', activity_date: '2026-07-11', system_source: 'armsoft',    invoices_issued: 2, reports_submitted: 0, applications_filed: 0, balance_changes: 0 },
  ],
  comments: [
    { id: 1, company_name: 'Beta LLC', accountant_name: 'Ann', comment_date: '2026-07-11', unaccounted_work: 'Устное согласование по ставкам' },
  ],
};
const status = { status: 'overdue', hours_late: 5, expected_by: '2026-07-20T02:00:00+04:00' };
const ts = computeTaskSync(src, status);

const alpha = ts.tasks.find((t) => t.company_name === 'Alpha LLC');
const beta  = ts.tasks.find((t) => t.company_name === 'Beta LLC');
eq(alpha.status, 'in_export', 'Alpha есть в налоговой выгрузке');
ok(alpha.in_artyom_export === true, 'Alpha in_artyom_export=true');
eq(alpha.hvhh, '111', 'Alpha ХВХХ восстановлен из tax.tin');
eq(beta.status, 'missing_in_export', 'Beta нет в ArmSoft-выгрузке');

eq(ts.report.exported, 'overdue', 'report.exported = статус графика');
eq(ts.report.dataMatchRate, 50, 'соответствие данных = 1 из 2 = 50%');
eq(ts.report.missingTotal, 1, 'одна задача не в выгрузке');

ok(ts.problems.some((p) => p.category === 'coverage_gap' && /Beta/.test(p.title)), 'проблема coverage_gap по Beta');
ok(ts.problems.some((p) => p.category === 'unaccounted_work'), 'проблема unaccounted_work из комментария');
ok(ts.problems.some((p) => p.category === 'schedule'), 'проблема графика при overdue');

const ann = ts.byAccountant.find((a) => a.accountant === 'Ann');
eq(ann.missing, 1, 'у Ann одна незакрытая задача');
eq(ann.matchRate, 50, 'matchRate Ann = 50%');

// ---- not_expected через config.taskTypeKeys ----
TASK_SYNC.tasksNotInExport.taskTypeKeys.push('balance');
const src2 = { clients: [], tax: [], armsoft: [], comments: [],
  activities: [{ company_name: 'Gamma LLC', accountant_name: 'Bob', activity_date: '2026-07-11', system_source: 'armsoft', invoices_issued: 0, reports_submitted: 0, applications_filed: 0, balance_changes: 3 }] };
const ts2 = computeTaskSync(src2, null);
eq(ts2.tasks[0].status, 'not_expected', 'balance помечен как «Артём не видит» по config');

// ---- computeAccountantComparison (сверка по бухгалтеру) ----
const srcA = {
  clients: [
    { company_name: 'Alpha LLC', accountant_name: 'Ann', is_active: true,  tax_account_id: 1, armsoft_company_id: 10 },
    { company_name: 'Beta LLC',  accountant_name: 'Ann', is_active: true,  tax_account_id: null, armsoft_company_id: null },
    { company_name: 'Gamma LLC', accountant_name: 'Bob', is_active: true,  tax_account_id: null, armsoft_company_id: null },
  ],
  tax: [{ id: 1, client_name_ru: 'Alpha LLC', tin: '111', org_name_hy: 'Ալֆա' }],
  armsoft: [{ company_id: 10, caption: 'Alpha LLC', name: 'alpha' }, { company_id: 99, caption: 'Gamma LLC', name: 'gamma' }],
  activities: [
    { company_name: 'Alpha LLC', accountant_name: 'Ann', activity_date: '2026-07-10', system_source: 'taxservice', invoices_issued: 5, reports_submitted: 1, applications_filed: 0, balance_changes: 0 },
    { company_name: 'Beta LLC',  accountant_name: 'Ann', activity_date: '2026-07-11', system_source: 'armsoft',    invoices_issued: 2, reports_submitted: 0, applications_filed: 0, balance_changes: 0 },
  ],
  comments: [],
};
const cmp = computeAccountantComparison(srcA);
const rAlpha = cmp.rows.find((r) => r.company_name === 'Alpha LLC');
const rBeta  = cmp.rows.find((r) => r.company_name === 'Beta LLC');
const rGamma = cmp.rows.find((r) => r.company_name === 'Gamma LLC');
ok(rAlpha.reported && rAlpha.in_armsoft && rAlpha.in_taxservice, 'Alpha: отчитался и есть в обеих выгрузках');
eq(rAlpha.verdict, 'confirmed', 'Alpha вердикт = подтверждено');
eq(rAlpha.hvhh, '111', 'Alpha ХВХХ из tax.tin');
eq(rAlpha.tasks.total, 6, 'Alpha сумма задач = 6');
ok(rBeta.reported && !rBeta.in_armsoft && !rBeta.in_taxservice, 'Beta: сказал сделано, нет в выгрузке');
eq(rBeta.verdict, 'reported_missing', 'Beta вердикт = сказал сделано, нет в выгрузке');
eq(rGamma.verdict, 'no_report', 'Gamma: есть в выгрузке, но без отчёта');
const annA = cmp.byAccountant.find((a) => a.accountant === 'Ann');
eq(annA.reportedMissing, 1, 'у Ann одно «сказал сделано — нет в выгрузке» (Beta)');
eq(annA.reported, 2, 'у Ann две отчитанные компании');

// ---- реальная работа из выгрузки Артёма (карты v_ob_*_activity) ----
const srcW = {
  clients: [{ company_name: 'Alpha LLC', contract_number: 'B-1', accountant_name: 'Ann', is_active: true, tax_account_id: 1, armsoft_company_id: 10 }],
  tax: [{ id: 1, client_name_ru: 'Alpha LLC', tin: '00111', org_name_hy: 'Ալֆա' }],
  armsoft: [{ company_id: 10, caption: 'Alpha LLC', name: 'alpha' }],
  activities: [], comments: [],
  armActivityById: new Map([[10, { company_id: 10, invoices_issued: 5, invoices_received: 3, last_doc_date: '2026-07-15' }]]),
  taxActivityByTin: new Map([['00111', { tin: '00111', reports_submitted: 4, tax_invoices_issued: 0, tax_invoices_received: 2, last_activity_date: '2026-07-16' }]]),
};
const cmpW = computeAccountantComparison(srcW);
const rW = cmpW.rows[0];
eq(rW.work.reports, 4, 'work.reports из налоговой активности');
eq(rW.work.invoices_issued, 5, 'work.invoices_issued = ArmSoft 5 + Tax 0');
eq(rW.work.invoices_received, 5, 'work.invoices_received = ArmSoft 3 + Tax 2');
eq(rW.work.total, 14, 'work.total = 4+5+5');
ok(rW.has_work, 'has_work=true при наличии работы');
eq(rW.work.last_date, '2026-07-16', 'last_date = максимум tax/arm');
eq(rW.arm_id, 10, 'arm_id проброшен для RPC задач');
eq(rW.tin, '00111', 'tin проброшен для RPC задач');
const annW = cmpW.byAccountant.find((a) => a.accountant === 'Ann');
eq(annW.workTotal, 14, 'rollup workTotal по бухгалтеру');
eq(annW.withWork, 1, 'rollup withWork по бухгалтеру');

// работа = 0, если карт активности нет (тестовая/старая среда)
const cmpNo = computeAccountantComparison({ clients: [{ company_name: 'Solo Company', accountant_name: 'Zed', is_active: true }], tax: [], armsoft: [], activities: [], comments: [] });
eq(cmpNo.rows[0].work.total, 0, 'без карт активности работа = 0');
ok(!cmpNo.rows[0].has_work, 'без карт активности has_work=false');
`;

try {
  // одна область видимости: заглушки + исходники + тесты
  // eslint-disable-next-line no-new-func
  new Function('ok', 'eq', STUB + SRC + '\n' + TESTS)(ok, eq);
} catch (e) {
  console.error('Ошибка выполнения тестов:', e);
  process.exit(1);
}

if (fails.length) {
  console.error(`\n❌ Провалено ${fails.length} проверок:`);
  for (const f of fails) console.error('  - ' + f);
  console.error(`\nПройдено: ${passed}`);
  process.exit(1);
}
console.log(`✅ Все проверки пройдены: ${passed}`);
