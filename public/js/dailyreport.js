/* =============================================================================
 * Дневной отчёт по ОДНОМУ бухгалтеру на основе выгрузки Артёма.
 *
 * ИДЕЯ (задача «Выгрузка Артёма — проверка на 1 бухгалтере»):
 *   Показать по дням, ЧТО бухгалтер сделал за день (по типам услуг из выгрузки
 *   Артёма) и, помножив на хронометраж (CHRONO), СКОЛЬКО времени он потратил
 *   («бухгалтер проработал N ч»). Затем бухгалтер даёт обратную связь:
 *   подтверждает цифры, комментирует каждую цифру, дописывает работу вне
 *   учтённого времени. Работой за день считается «отчёт системы + комментарий».
 *
 * Этот модуль — ЧИСТАЯ логика (без БД/браузера), тестируется в tests/run.js:
 *   - accountantBridge()  — какие company_id/ИНН принадлежат бухгалтеру
 *     (переиспользует строки computeAccountantComparison — там уже есть
 *     сопоставление клиента OB с ArmSoft/налоговым кабинетом);
 *   - buildDailyReport()  — из плоских счётчиков (день × тип услуги) строит
 *     дневную ленту с минутами и итогами;
 *   - mergeAccountantFeedback() — накладывает сохранённую обратную связь и
 *     считает итог с учётом дописанной работы бухгалтера.
 * ========================================================================== */

/**
 * Мост «бухгалтер → его компании» из строк computeAccountantComparison.
 * rows — cmp.rows (см. accountants.js): у каждой строки есть accountant_name,
 * arm_id (company_id ArmSoft) и tin (ИНН налогового кабинета).
 * Возвращает уникальные массивы company_id и ИНН + список компаний бухгалтера.
 */
function accountantBridge(accRows, accountantName) {
  const mine = (accRows || []).filter((r) => (r.accountant_name || '') === accountantName);
  const armIds = [...new Set(mine.map((r) => r.arm_id).filter((x) => x != null))];
  const tins = [...new Set(mine.map((r) => r.tin).filter(Boolean))];
  return {
    accountant: accountantName,
    armIds,
    tins,
    companies: mine,
    companyCount: mine.length,
    activeCount: mine.filter((r) => r.is_active).length,
    withWorkCount: mine.filter((r) => r.has_work).length,
  };
}

/** Минут на одну услугу данного типа (из CHRONO, 0 если не задано) */
function minutesPerUnit(category, chrono) {
  const m = (chrono && chrono.minutesPerUnit) || {};
  return Number(m[category] || 0);
}

/**
 * Из плоских счётчиков активности строит дневную ленту.
 * activityRows: [{ activity_date, category, cnt }] (из RPC ob_accountant_daily_activity).
 * Возвращает { days: [{ date, metrics: [{category,count,minutes}], totalCount,
 *   totalMinutes }], totalMinutes, totalCount, dayCount }.
 * Дни — от новых к старым; метрики внутри дня — в порядке CHRONO.order.
 */
function buildDailyReport(activityRows, chrono) {
  const order = (chrono && chrono.order) || Object.keys(SERVICE_TYPES);
  const byDate = new Map();
  for (const r of activityRows || []) {
    const d = String(r.activity_date).slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, new Map());
    const cur = byDate.get(d).get(r.category) || 0;
    byDate.get(d).set(r.category, cur + Number(r.cnt || 0));
  }

  const days = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, catMap]) => {
      const metrics = order
        .filter((cat) => catMap.has(cat))
        .map((cat) => {
          const count = catMap.get(cat);
          const per = minutesPerUnit(cat, chrono);
          return { category: cat, count, minutesPerUnit: per, minutes: count * per };
        });
      const totalCount = metrics.reduce((s, m) => s + m.count, 0);
      const totalMinutes = metrics.reduce((s, m) => s + m.minutes, 0);
      return { date, metrics, totalCount, totalMinutes };
    });

  return {
    days,
    dayCount: days.length,
    totalMinutes: days.reduce((s, d) => s + d.totalMinutes, 0),
    totalCount: days.reduce((s, d) => s + d.totalCount, 0),
  };
}

/** Сумма минут дописанной бухгалтером работы (extra_work: [{desc, minutes}]) */
function extraWorkMinutes(extraWork) {
  return (Array.isArray(extraWork) ? extraWork : []).reduce(
    (s, w) => s + Number(w && w.minutes ? w.minutes : 0), 0);
}

/**
 * Накладывает сохранённую обратную связь бухгалтера на день отчёта и считает
 * итог с учётом дописанной работы.
 * day — элемент buildDailyReport().days; fb — строка accountant_day_reports (или null).
 * Возвращает { ...day, feedback, extraMinutes, grandTotalMinutes, status }.
 */
function mergeAccountantFeedback(day, fb) {
  const extra = fb ? extraWorkMinutes(fb.extra_work) : 0;
  return {
    ...day,
    feedback: fb || null,
    metricNotes: (fb && fb.metric_notes) || {},
    extraWork: (fb && Array.isArray(fb.extra_work)) ? fb.extra_work : [],
    extraMinutes: extra,
    grandTotalMinutes: day.totalMinutes + extra,
    status: (fb && fb.status) || 'pending',
    countsConfirmed: !!(fb && fb.counts_confirmed),
  };
}

/** «95 мин» → «1 ч 35 мин»; 0 → «0 мин»; для подписей времени. */
function fmtMinutes(mins) {
  const m = Math.round(Number(mins || 0));
  if (m <= 0) return '0 мин';
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h && r) return `${h} ч ${r} мин`;
  if (h) return `${h} ч`;
  return `${r} мин`;
}

/** Часы одним числом: 95 мин → «1.6 ч» (для фразы «проработал N ч») */
function fmtHours(mins) {
  return (Number(mins || 0) / 60).toFixed(1).replace('.', ',') + ' ч';
}

// экспорт для среды Node (тесты); в браузере функции и так глобальны
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    accountantBridge, buildDailyReport, mergeAccountantFeedback,
    extraWorkMinutes, minutesPerUnit, fmtMinutes, fmtHours,
  };
}
