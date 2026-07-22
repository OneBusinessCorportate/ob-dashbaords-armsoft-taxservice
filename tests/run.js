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
const SRC = ['config.js', 'normalize.js', 'tasksync.js', 'accountants.js', 'dailyreport.js', 'morningcalls.js'].map(read).join('\n');

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

// ---- dailyreport: accountantBridge ----
const accRows = [
  { accountant_name: 'Ann', arm_id: 10, tin: '111', is_active: true,  has_work: true },
  { accountant_name: 'Ann', arm_id: null, tin: '222', is_active: true,  has_work: false },
  { accountant_name: 'Ann', arm_id: 10, tin: '111', is_active: false, has_work: false }, // дубли схлопываются
  { accountant_name: 'Bob', arm_id: 33, tin: '999', is_active: true,  has_work: true },
];
const br = accountantBridge(accRows, 'Ann');
eq(br.armIds.length, 1, 'bridge: уникальные arm_id (10)');
eq(br.tins.length, 2, 'bridge: уникальные ИНН (111,222)');
eq(br.companyCount, 3, 'bridge: 3 компании у Ann');
eq(br.activeCount, 2, 'bridge: 2 активные у Ann');
eq(br.withWorkCount, 1, 'bridge: 1 с работой у Ann');

// ---- dailyreport: buildDailyReport + хронометраж ----
const chrono = { minutesPerUnit: { report: 20, invoice_issued: 5, invoice_received: 4 },
  order: ['report', 'invoice_issued', 'invoice_received'] };
const activity = [
  { activity_date: '2026-07-16', category: 'report', cnt: 2 },
  { activity_date: '2026-07-16', category: 'invoice_issued', cnt: 3 },
  { activity_date: '2026-07-15', category: 'invoice_received', cnt: 5 },
];
const rep = buildDailyReport(activity, chrono);
eq(rep.dayCount, 2, 'buildDailyReport: 2 дня');
eq(rep.days[0].date, '2026-07-16', 'дни от новых к старым');
eq(rep.days[0].totalMinutes, 2 * 20 + 3 * 5, 'минуты дня = 2*20 + 3*5 = 55');
eq(rep.days[0].totalCount, 5, 'действий за 16-е = 5');
eq(rep.days[0].metrics[0].category, 'report', 'порядок услуг по CHRONO.order');
eq(rep.totalMinutes, 55 + 5 * 4, 'итого минут за период = 75');

// ---- dailyreport: extraWork + merge ----
eq(extraWorkMinutes([{ desc: 'a', minutes: 30 }, { desc: 'b', minutes: 20 }]), 50, 'сумма минут дописанной работы');
const merged = mergeAccountantFeedback(rep.days[0], { status: 'confirmed', counts_confirmed: true,
  extra_work: [{ desc: 'консультация', minutes: 30 }], metric_notes: { report: { disputed: true } } });
eq(merged.extraMinutes, 30, 'merge: дописано 30 мин');
eq(merged.grandTotalMinutes, 55 + 30, 'merge: итог с учётом комментариев = 85');
eq(merged.status, 'confirmed', 'merge: статус из обратной связи');
ok(merged.countsConfirmed, 'merge: цифры подтверждены');

// без обратной связи — grandTotal = отчёт Артёма, статус pending
const mergedNone = mergeAccountantFeedback(rep.days[1], null);
eq(mergedNone.grandTotalMinutes, rep.days[1].totalMinutes, 'merge без фидбэка: итог = отчёт Артёма');
eq(mergedNone.status, 'pending', 'merge без фидбэка: статус pending');

// ---- morningcalls: mcShiftDate ----
eq(mcShiftDate('2026-06-23', 0), '2026-06-23', 'mcShiftDate 0 = та же дата');
eq(mcShiftDate('2026-06-23', -1), '2026-06-22', 'mcShiftDate -1 = день назад');
eq(mcShiftDate('2026-07-01', -1), '2026-06-30', 'mcShiftDate -1 через границу месяца');

// ---- morningcalls: mcSystemBreakdown ----
const bdMap = new Map([['report', 2], ['tax_invoice_issued', 3], ['tax_invoice_received', 1], ['invoice_issued', 5], ['invoice_received', 4]]);
const bd = mcSystemBreakdown(bdMap);
eq(bd.tax.total, 6, 'breakdown TaxService = 2+3+1');
eq(bd.arm.total, 9, 'breakdown ArmSoft = 5+4');
eq(bd.total, 15, 'breakdown total = tax + arm');
eq(mcSystemBreakdown(null).total, 0, 'breakdown пустого дня = 0');

// ---- morningcalls: mcActualDateRange ----
const mcComments = [
  { accountant_name: 'Ann', company_name: 'Alpha LLC', comment_date: '2026-06-22', comment: 'Сдала отчёт', unaccounted_work: 'Консультация' },
  { accountant_name: 'Ann', company_name: 'Beta LLC',  comment_date: '2026-06-23', comment: 'Выписала 3 инвойса', unaccounted_work: null },
  { accountant_name: 'Bob', company_name: 'Gamma LLC', comment_date: '2026-06-23', comment: 'Работал с накладными', unaccounted_work: null },
];
const range0 = mcActualDateRange(mcComments, 0);
eq(range0.from, '2026-06-22', 'range from = самая ранняя дата созвона');
eq(range0.to, '2026-06-23', 'range to = самая поздняя дата созвона');
const range1 = mcActualDateRange(mcComments, 1);
eq(range1.from, '2026-06-21', 'range со сдвигом 1 сдвигает from на день назад');
eq(mcActualDateRange([], 0).from, null, 'range без комментариев = null');

// ---- morningcalls: buildMorningCalls (offset 0) ----
const mcActivity = new Map([
  ['Ann', [
    { activity_date: '2026-06-22', category: 'report', cnt: 1 },
    { activity_date: '2026-06-23', category: 'invoice_issued', cnt: 3 },
    { activity_date: '2026-06-23', category: 'tax_invoice_received', cnt: 2 },
  ]],
  ['Bob', []],  // у Боба нет привязок → нет факта
]);
const mc = buildMorningCalls(mcComments, mcActivity, 0);
eq(mc.dayCount, 2, 'buildMorningCalls: 2 дня созвонов');
eq(mc.days[0].date, '2026-06-23', 'дни от новых к старым');
const d23 = mc.days[0];
eq(d23.accountants.length, 2, '23-е: два бухгалтера (Ann, Bob)');
eq(d23.accountants[0].accountant, 'Ann', 'бухгалтеры по алфавиту (Ann первый)');
const annCall = d23.accountants.find((x) => x.accountant === 'Ann');
eq(annCall.arm.invoice_issued, 3, 'Ann 23-е: 3 счёта ArmSoft выставлено');
eq(annCall.tax.tax_invoice_received, 2, 'Ann 23-е: 2 налог. счёта получено');
eq(annCall.tax.report, 0, 'Ann 23-е: отчётов нет (report был 22-го)');
ok(annCall.hasActual, 'Ann 23-е: есть факт в выгрузке');
eq(annCall.said.length, 1, 'Ann 23-е: сказал про 1 компанию');
eq(annCall.said[0].company_name, 'Beta LLC', 'Ann 23-е: компания Beta LLC');
const bobCall = d23.accountants.find((x) => x.accountant === 'Bob');
ok(!bobCall.hasActual, 'Bob 23-е: нет факта в выгрузке');
eq(d23.analysis.accountantCount, 2, 'анализ 23-го: 2 бухгалтера');
eq(d23.analysis.saidNoActual, 1, 'анализ 23-го: 1 сказал без факта (Bob)');
eq(d23.analysis.armTotal, 3, 'анализ 23-го: ArmSoft всего 3');
eq(d23.analysis.taxTotal, 2, 'анализ 23-го: TaxService всего 2');
const d22 = mc.days[1];
const annCall22 = d22.accountants.find((x) => x.accountant === 'Ann');
eq(annCall22.tax.report, 1, 'Ann 22-е: 1 сданный отчёт');
eq(annCall22.actualTotal, 1, 'Ann 22-е: всего 1 операция');

// ---- morningcalls: buildMorningCalls (offset 1 = вчерашняя работа) ----
const mcOff = buildMorningCalls(mcComments, mcActivity, 1);
const annOff = mcOff.days[0].accountants.find((x) => x.accountant === 'Ann'); // созвон 23-го
eq(annOff.actualDate, '2026-06-22', 'offset 1: факт берётся за 22-е (день до созвона 23-го)');
eq(annOff.tax.report, 1, 'offset 1: у Ann на 22-е есть 1 отчёт');

// ---- morningcalls: разбор слов (ПОЛНОЕ сопоставление) ----
eq(mcNormalizeText('Сдал ОТЧЁТ'), 'сдал отчет', 'нормализация: нижний регистр + ё→е');
eq(mcSplitPhrases('Выписала 3 инвойса, провела сверку с клиентом').length, 2, 'разбивка фразы на 2 задачи');

const mCat = mcMatchCategories('провела сверку с клиентом');
ok(mCat.categories.includes('reconciliation_act'), 'сверка → акт сверки');
ok(!mCat.structural, 'сверка — это работа в выгрузке, не structural');
ok(mcMatchCategories('Устное согласование по ставкам').structural, 'устное согласование → вне выгрузки');
ok(mcMatchCategories('Выписала инвойсы').categories.includes('invoice_issued'), 'инвойс → счёт выставлен');
ok(mcMatchCategories('Работал с накладными и остатками').categories.includes('transfer_invoice'), 'накладные → передаточные');
ok(mcMatchCategories('Начислил зарплату сотрудникам').categories.includes('tax_employee'), 'зарплата → сотрудники (налог.)');
ok(mcMatchCategories('Подала заявление в налоговую').categories.includes('application'), 'заявление → application (без таблицы)');
ok(!MC_CATEGORIES.application.measurable, 'application не измеряется отдельной таблицей');

// mcBuildClaims: вердикты по фактической активности за день
const claimsCatMap = new Map([['invoice_issued', 3], ['reconciliation_act', 0]]);
const claims = mcBuildClaims(
  [{ company_name: 'Alpha', comment: 'Выписала 3 инвойса, провела сверку', unaccounted: 'Консультация с директором' }],
  claimsCatMap,
);
eq(claims.length, 3, 'три задачи: инвойс, сверка, консультация');
const cInv = claims.find((c) => c.phrase.includes('инвойс'));
const cRec = claims.find((c) => c.phrase.includes('сверк'));
const cCons = claims.find((c) => c.phrase.includes('онсультац'));
eq(cInv.verdict, 'confirmed', 'инвойс: есть 3 факта → подтверждено');
eq(cInv.matchedCount, 3, 'инвойс: matchedCount = 3');
eq(cRec.verdict, 'missing', 'сверка: 0 фактов → сказал, нет в выгрузке');
eq(cCons.verdict, 'not_in_export', 'консультация: вне выгрузки');

// mcFullBreakdown: все категории с фактом (>0), в порядке MC_CATEGORY_ORDER
const fb = mcFullBreakdown(new Map([['journal_operation', 5], ['report', 2], ['invoice_issued', 0]]));
eq(fb.length, 2, 'в разбивку попадают только категории с count>0');
eq(fb[0].category, 'report', 'порядок: report раньше journal_operation');
ok(fb.every((c) => c.label && c.system), 'у каждой категории есть подпись и система');

// buildMorningCalls: полный анализ + «не упомянуто»
const mcFullAct = new Map([
  ['Ann', [
    { activity_date: '2026-06-23', system: 'ArmSoft', category: 'invoice_issued', cnt: 3 },
    { activity_date: '2026-06-23', system: 'ArmSoft', category: 'cash_receipt', cnt: 4 },
  ]],
]);
const mcFullComments = [
  { accountant_name: 'Ann', company_name: 'Beta', comment_date: '2026-06-23', comment: 'Выписала инвойсы', unaccounted: null },
];
const mcFull = buildMorningCalls(mcFullComments, mcFullAct, 0);
const annFull = mcFull.days[0].accountants.find((x) => x.accountant === 'Ann');
eq(annFull.fullCatCount, 2, 'у Ann 2 раздела с фактом (invoice_issued, cash_receipt)');
ok(annFull.hasFullActual, 'hasFullActual=true при наличии любой работы');
eq(annFull.claimStats.confirmed, 1, 'слово «инвойсы» подтверждено фактом');
eq(annFull.unmentioned.length, 1, 'касса — работа в выгрузке, о которой не сказали');
eq(annFull.unmentioned[0].category, 'cash_receipt', 'не упомянута именно касса');
eq(mcFull.days[0].analysis.unmentionedTotal, 4, 'анализ: 4 не упомянутых операции (касса)');
eq(mcFull.days[0].analysis.claimConfirmed, 1, 'анализ: 1 подтверждённое слово');
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
