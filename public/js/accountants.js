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
  // Карты РЕАЛЬНОЙ работы из выгрузки Артёма (см. data.js / v_ob_*_activity).
  // В тестовой среде их нет — тогда пустые карты и работа = 0.
  const armActivityById = src && src.armActivityById ? src.armActivityById : new Map();
  const taxActivityByTin = src && src.taxActivityByTin ? src.taxActivityByTin : new Map();

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

    // --- РЕАЛЬНАЯ работа по компании из выгрузки Артёма ------------------------
    // ключ к налоговой активности — ИНН из совпадения; к ArmSoft — company_id.
    const armId = armMatch.found ? (armMatch.entity.company_id ?? null) : null;
    const taxAct = hvhh ? (taxActivityByTin.get(normalizeHvhh(hvhh)) || null) : null;
    const armAct = armId != null ? (armActivityById.get(armId) || null) : null;
    const work = {
      reports:          Number(taxAct?.reports_submitted || 0),
      tax_inv_issued:   Number(taxAct?.tax_invoices_issued || 0),
      tax_inv_received: Number(taxAct?.tax_invoices_received || 0),
      arm_inv_issued:   Number(armAct?.invoices_issued || 0),
      arm_inv_received: Number(armAct?.invoices_received || 0),
    };
    work.invoices_issued = work.tax_inv_issued + work.arm_inv_issued;
    work.invoices_received = work.tax_inv_received + work.arm_inv_received;
    work.total = work.reports + work.invoices_issued + work.invoices_received;
    const workLastDate = [taxAct?.last_activity_date, armAct?.last_doc_date]
      .filter(Boolean).sort().slice(-1)[0] || null;
    work.last_date = workLastDate;
    const hasWork = work.total > 0;

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
      contract_number: client.contract_number || null,
      hvhh,
      arm_id: armId,          // company_id ArmSoft — ключ к списку задач (RPC)
      tin: hvhh,              // ИНН — ключ к налоговым задачам (RPC)
      is_active: !!client.is_active,
      reported,
      has_work: hasWork,      // есть реальная работа в выгрузке Артёма
      work,                   // сводка реальной работы (отчёты/счета)
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
      s = { accountant: acc, companies: [], total: 0, active: 0, reported: 0, inArmsoft: 0, inTax: 0, reportedMissing: 0, tasksTotal: 0,
        withWork: 0, workReports: 0, workInvoicesIssued: 0, workInvoicesReceived: 0, workTotal: 0, lastWorkDate: null };
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
    // рулоны реальной работы
    if (r.has_work) s.withWork += 1;
    s.workReports += r.work.reports;
    s.workInvoicesIssued += r.work.invoices_issued;
    s.workInvoicesReceived += r.work.invoices_received;
    s.workTotal += r.work.total;
    if (r.work.last_date && (!s.lastWorkDate || r.work.last_date > s.lastWorkDate)) s.lastWorkDate = r.work.last_date;
  }
  const byAccountant = [...byAccMap.values()]
    .sort((a, b) => b.workTotal - a.workTotal || b.active - a.active || b.total - a.total);

  return { rows, byAccountant };
}

// экспорт для среды Node (тесты); в браузере функция и так глобальна
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeAccountantComparison, ACC_TASK_FIELDS };
}
