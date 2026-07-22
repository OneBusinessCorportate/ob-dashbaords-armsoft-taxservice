/* =============================================================================
 * Анализ утренних созвонов (morning calls).
 *
 * ИДЕЯ (по запросу владельца): отдельная страница, где по КАЖДОМУ дню созвона:
 *   - есть сворачиваемый «анализ созвона» (сводка по дню);
 *   - ниже по КАЖДОМУ бухгалтеру три части:
 *       1. что он СКАЗАЛ на созвоне, что сделано (accountant_daily_comments);
 *       2. что РЕАЛЬНО было в TaxService по выгрузке Артёма
 *          (сданные отчёты + налоговые э-счета выставленные/полученные);
 *       3. что РЕАЛЬНО было в ArmSoft по выгрузке Артёма
 *          (счета выставленные/полученные).
 *
 * «Реально» всегда = данные выгрузки Артёма (v_* / RPC ob_accountant_daily_activity),
 * единственного полного источника бухгалтерской информации.
 *
 * Этот модуль — ЧИСТАЯ логика (без БД/браузера), тестируется в tests/run.js.
 * Загрузка фактических счётчиков по дню (RPC) и сопоставление названий с
 * выгрузкой (normalize.js) живут в слое UI/данных (app.js / data.js).
 * ========================================================================== */

/** Типы услуг, относящиеся к каждой системе выгрузки Артёма */
const MC_TAX_CATEGORIES = ['report', 'tax_invoice_issued', 'tax_invoice_received'];
const MC_ARM_CATEGORIES = ['invoice_issued', 'invoice_received'];

/** Сдвиг даты «YYYY-MM-DD» на N дней (в UTC, без зависимости от локали). */
function mcShiftDate(dateStr, days) {
  const base = String(dateStr).slice(0, 10);
  if (!days) return base;
  const d = new Date(base + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

/**
 * Индекс сырых счётчиков активности [{activity_date, category, cnt}] →
 * Map(date → Map(category → count)).
 */
function mcIndexActivity(rows) {
  const byDate = new Map();
  for (const r of rows || []) {
    const d = String(r.activity_date).slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, new Map());
    const m = byDate.get(d);
    m.set(r.category, (m.get(r.category) || 0) + Number(r.cnt || 0));
  }
  return byDate;
}

/**
 * Из карты «категория → счётчик» за один день строит разбивку по системам
 * (TaxService / ArmSoft) с итогами.
 */
function mcSystemBreakdown(catMap) {
  const g = (c) => Number((catMap && catMap.get(c)) || 0);
  const tax = {
    report: g('report'),
    tax_invoice_issued: g('tax_invoice_issued'),
    tax_invoice_received: g('tax_invoice_received'),
  };
  tax.total = tax.report + tax.tax_invoice_issued + tax.tax_invoice_received;
  const arm = {
    invoice_issued: g('invoice_issued'),
    invoice_received: g('invoice_received'),
  };
  arm.total = arm.invoice_issued + arm.invoice_received;
  return { tax, arm, total: tax.total + arm.total };
}

/**
 * Главная сборка структуры страницы утренних созвонов.
 *   comments             — строки accountant_daily_comments;
 *   activityByAccountant — Map(имя бухгалтера → сырые счётчики активности),
 *                          получаемые через RPC ob_accountant_daily_activity;
 *   offsetDays           — за сколько дней ДО созвона проделана обсуждаемая работа
 *                          (0 = тот же день; 1 = вчерашняя работа).
 *
 * Возвращает { days: [ { date, actualDate, accountants: [...], analysis } ], dayCount }.
 * Дни — от новых к старым; бухгалтеры внутри дня — по алфавиту.
 */
function buildMorningCalls(comments, activityByAccountant, offsetDays = 0) {
  const offset = Number(offsetDays || 0);

  // индекс фактической активности по каждому бухгалтеру
  const activityIdx = new Map();
  if (activityByAccountant) {
    for (const [acc, rows] of activityByAccountant) activityIdx.set(acc, mcIndexActivity(rows));
  }

  // группировка комментариев: дата → бухгалтер → сказанное
  const byDate = new Map();
  for (const c of comments || []) {
    const date = String(c.comment_date).slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, new Map());
    const byAcc = byDate.get(date);
    const acc = c.accountant_name || c.accountant_email || 'Без имени';
    if (!byAcc.has(acc)) byAcc.set(acc, []);
    byAcc.get(acc).push({
      company_name: c.company_name || '',
      comment: c.comment || '',
      unaccounted: c.unaccounted_work || '',
    });
  }

  const days = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, byAcc]) => {
      const actualDate = mcShiftDate(date, -offset);
      const accountants = [...byAcc.entries()]
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'ru'))
        .map(([acc, said]) => {
          const idx = activityIdx.get(acc);
          const catMap = idx ? idx.get(actualDate) : null;
          const bd = mcSystemBreakdown(catMap);
          const saidCompanies = [...new Set(said.map((s) => s.company_name).filter(Boolean))];
          return {
            accountant: acc,
            said,
            saidCompanies,
            actualDate,
            tax: bd.tax,
            arm: bd.arm,
            actualTotal: bd.total,
            hasActual: bd.total > 0,
          };
        });

      const sum = (fn) => accountants.reduce((s, a) => s + fn(a), 0);
      const analysis = {
        accountantCount: accountants.length,
        companyCount: sum((a) => a.saidCompanies.length),
        reportCount: sum((a) => a.tax.report),
        taxTotal: sum((a) => a.tax.total),
        armTotal: sum((a) => a.arm.total),
        actualTotal: sum((a) => a.actualTotal),
        withActual: accountants.filter((a) => a.hasActual).length,
        saidNoActual: accountants.filter((a) => a.said.length && !a.hasActual).length,
      };
      return { date, actualDate, accountants, analysis };
    });

  return { days, dayCount: days.length };
}

/** Диапазон дат факта [from, to] для выборки RPC по датам созвонов + сдвиг. */
function mcActualDateRange(comments, offsetDays = 0) {
  const dates = (comments || []).map((c) => String(c.comment_date).slice(0, 10)).filter(Boolean).sort();
  if (!dates.length) return { from: null, to: null };
  const offset = Number(offsetDays || 0);
  return {
    from: mcShiftDate(dates[0], -offset),
    to: mcShiftDate(dates[dates.length - 1], -offset),
  };
}

// экспорт для среды Node (тесты); в браузере функции и так глобальны
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildMorningCalls, mcIndexActivity, mcSystemBreakdown, mcShiftDate,
    mcActualDateRange, MC_TAX_CATEGORIES, MC_ARM_CATEGORIES,
  };
}
