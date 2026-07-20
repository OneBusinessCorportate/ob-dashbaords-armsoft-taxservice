/* =============================================================================
 * Сверка по каждому бухгалтеру: что бухгалтер «сказал, что сделано» (задачи в
 * отчёте / accounting_activities + утренние комментарии) против фактических
 * данных в ArmSoft, TaxService и реестре OB (база данных).
 *
 * ИДЕЯ (по запросу владельца): страница с фильтром по каждому бухгалтеру и
 * таблицей-сравнением: по каждой компании бухгалтера видно, отчитался ли он о
 * работе (задачи), и подтверждается ли эта работа выгрузкой Артёма (ArmSoft /
 * TaxService) и реестром OB. Так сразу видно, где бухгалтер «сказал сделано»,
 * но в системах этого нет.
 *
 * ЗАДАЧИ БУХГАЛТЕРА («задачи»/zadachi) берутся из accounting_activities —
 * счётчики по компании/дню: счета, отчёты, заявления, изменения остатков. Это
 * и есть отражение формы обратной связи бухгалтеров: что он отчитал как работу.
 *
 * Чистый модуль без БД/браузера — тестируется в tests/run.js. Сопоставление
 * названий переиспользует normalize.js (buildIndex / findMatch), как и дельта.
 * ========================================================================== */

/** Типы задач бухгалтера (его «задачи»/zadachi) — поле → русская подпись */
const ACC_TASK_FIELDS = [
  ['invoices_issued',   'Счета'],
  ['reports_submitted', 'Отчёты'],
  ['applications_filed','Заявления'],
  ['balance_changes',   'Остатки'],
];

/**
 * Главный расчёт сверки по бухгалтерам.
 * src = { clients, tax, armsoft, activities, comments }.
 * Возвращает { rows, byAccountant }.
 */
function computeAccountantComparison(src) {
  const { clients = [], tax = [], armsoft = [], activities = [], comments = [] } = src || {};

  const taxIndex = buildIndex(tax, ['client_name_ru', 'org_name_hy'], 'tin');
  const armIndex = buildIndex(armsoft, ['caption', 'name'], null);
  const taxById = new Map(tax.map((t) => [t.id, t]));
  const armById = new Map(armsoft.map((a) => [a.company_id, a]));

  // --- агрегируем задачи (задачи) бухгалтера по ключу бухгалтер||компания ------
  const actMap = new Map();
  for (const a of activities) {
    const norm = normalizeName(a.company_name);
    if (!norm) continue;
    const acc = a.accountant_name || a.accountant_email || '';
    const key = normalizeName(acc) + '||' + norm;
    let e = actMap.get(key);
    if (!e) {
      e = { invoices_issued: 0, reports_submitted: 0, applications_filed: 0, balance_changes: 0, total: 0, lastDate: null, systems: new Set() };
      actMap.set(key, e);
    }
    for (const [f] of ACC_TASK_FIELDS) {
      const n = Number(a[f] || 0);
      e[f] += n; e.total += n;
    }
    if (a.system_source) e.systems.add(a.system_source);
    if (a.activity_date && (!e.lastDate || a.activity_date > e.lastDate)) e.lastDate = a.activity_date;
  }

  // --- комментарии бухгалтера с утренних встреч по тому же ключу ---------------
  const commMap = new Map();
  for (const c of comments) {
    const norm = normalizeName(c.company_name);
    const acc = c.accountant_name || c.accountant_email || '';
    const key = normalizeName(acc) + '||' + norm;
    if (!commMap.has(key)) commMap.set(key, []);
    commMap.get(key).push(c);
  }

  // --- строка сравнения по каждой компании из реестра OB -----------------------
  const rows = [];
  for (const client of clients) {
    if (RULES.isJunkName(client.company_name)) continue;
    const acc = client.accountant_name || client.accountant_email || null;
    const norm = normalizeName(client.company_name);

    // связь по ID приоритетнее совпадения по названию (как в движке дельты)
    let taxMatch;
    if (client.tax_account_id != null && taxById.has(client.tax_account_id)) {
      taxMatch = { found: true, entity: taxById.get(client.tax_account_id), quality: 'exact_id' };
    } else {
      taxMatch = findMatch(taxIndex, { hvhh: null, names: [client.company_name] });
    }
    let armMatch;
    if (client.armsoft_company_id != null && armById.has(client.armsoft_company_id)) {
      armMatch = { found: true, entity: armById.get(client.armsoft_company_id), quality: 'exact_id' };
    } else {
      armMatch = findMatch(armIndex, { hvhh: null, names: [client.company_name] });
    }

    const inTax = taxMatch.found && taxMatch.quality !== 'fuzzy';
    const inArm = armMatch.found && armMatch.quality !== 'fuzzy';
    const hvhh = taxMatch.found ? (taxMatch.entity.tin || null) : null;

    const key = normalizeName(acc || '') + '||' + norm;
    const act = actMap.get(key) || null;
    const comms = commMap.get(key) || [];
    const reported = !!(act && act.total > 0) || comms.length > 0;
    const inExport = inTax || inArm;

    // вердикт сверки «сказал сделано» ↔ факт в системах
    let verdict;
    if (reported && !inExport) verdict = 'reported_missing';   // сказал сделано, в выгрузке нет
    else if (reported && inExport) verdict = 'confirmed';       // отчитался и подтверждено
    else if (!reported && inExport) verdict = 'no_report';      // есть в выгрузке, но без отчёта
    else verdict = 'none';                                      // нет ни отчёта, ни выгрузки

    rows.push({
      accountant_name: acc,
      company_name: client.company_name,
      hvhh,
      is_active: !!client.is_active,
      reported,
      in_armsoft: inArm,
      in_taxservice: inTax,
      in_ob_registry: true,
      arm_quality: armMatch.quality,
      tax_quality: taxMatch.quality,
      tasks: act ? {
        invoices_issued: act.invoices_issued,
        reports_submitted: act.reports_submitted,
        applications_filed: act.applications_filed,
        balance_changes: act.balance_changes,
        total: act.total,
      } : null,
      last_activity_date: act ? act.lastDate : null,
      systems: act ? [...act.systems] : [],
      comments: comms.map((c) => ({ date: c.comment_date, text: c.comment || '', unaccounted: c.unaccounted_work || '' })),
      verdict,
    });
  }

  // --- сводка по бухгалтерам ---------------------------------------------------
  const byAccMap = new Map();
  for (const r of rows) {
    const acc = r.accountant_name || '— без бухгалтера';
    let s = byAccMap.get(acc);
    if (!s) {
      s = { accountant: acc, companies: [], total: 0, active: 0, reported: 0, inArmsoft: 0, inTax: 0, reportedMissing: 0, tasksTotal: 0 };
      byAccMap.set(acc, s);
    }
    s.companies.push(r);
    s.total += 1;
    if (r.is_active) s.active += 1;
    if (r.reported) s.reported += 1;
    if (r.in_armsoft) s.inArmsoft += 1;
    if (r.in_taxservice) s.inTax += 1;
    if (r.verdict === 'reported_missing') s.reportedMissing += 1;
    if (r.tasks) s.tasksTotal += r.tasks.total;
  }
  const byAccountant = [...byAccMap.values()]
    .sort((a, b) => b.reportedMissing - a.reportedMissing || b.active - a.active || b.total - a.total);

  return { rows, byAccountant };
}

// экспорт для среды Node (тесты); в браузере функция и так глобальна
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeAccountantComparison, ACC_TASK_FIELDS };
}
