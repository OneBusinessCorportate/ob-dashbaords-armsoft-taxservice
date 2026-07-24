/* =============================================================================
 * UI дашборда: навигация, карточки, таблицы, фильтры, drill-down,
 * workflow проверки Эмилии, генератор ТЗ Артёму, сравнение встреч.
 * ========================================================================== */

/* ------------------------------- Состояние ------------------------------- */
const state = {
  src: null,          // исходные данные (клиенты, tax, armsoft, artem, встречи…)
  computed: null,     // результат computeDelta
  deltaItems: [],     // строки delta_items из БД (источник истины для списков)
  snapshots: [],
  tzItems: [],
  taskSync: null,     // результат computeTaskSync (in-memory)
  taskSyncItems: [],  // строки accountant_task_sync из БД
  syncProblems: [],   // строки sync_problems из БД
  exportStatus: null, // строка v_artyom_export_status (статус графика выгрузки)
  syncAccountant: '', // фильтр раздела «Синхронизация» по бухгалтеру
  accCompare: null,   // результат computeAccountantComparison
  accFilter: { accountant: '', activeOnly: true, workOnly: false, search: '', presence: '' },
  accShown: 60,       // пагинация списка компаний на странице «Бухгалтеры»
  accExpanded: new Set(),  // раскрытые карточки компаний (показан список задач)
  accFeed: new Map(),      // кэш списка задач по ключу «armId|tin» → {loading, error, rows}
  // --- страница «Отчёт по дням» (один бухгалтер) ---
  daily: {
    accountant: '',        // выбранный бухгалтер (по умолч. DAILY_REPORT.defaultAccountant)
    loading: false,
    error: null,
    activity: [],          // сырые счётчики день×услуга (RPC)
    report: null,          // buildDailyReport(...)
    reportsByDate: new Map(),  // сохранённая обратная связь бухгалтера: date → row
    shown: 14,             // сколько дней показываем (пагинация)
    expanded: new Set(),   // раскрытые drill'ы по ключу «date|category»
    feed: new Map(),       // кэш документов drill'а: «date|category» → {loading,error,rows}
    letter: '',            // сгенерированное письмо Артёму
  },
  // --- страница «Утренние созвоны» (анализ по дням/бухгалтерам) ---
  calls: {
    loaded: false,
    loading: false,
    error: null,
    data: null,              // buildMorningCalls(...)
    bridges: new Map(),      // бухгалтер → accountantBridge (armIds/tins) для drill
    filterAccountant: '',    // фильтр по бухгалтеру
    filterFrom: '',          // диапазон дат: с какого дня (YYYY-MM-DD, включительно)
    filterTo: '',            // диапазон дат: по какой день (YYYY-MM-DD, включительно)
    sortOrder: 'desc',       // порядок дней: 'desc' — новые сверху, 'asc' — старые сверху
    analysisHidden: new Set(),  // дни, у которых блок «анализ созвона» свёрнут
    expandedFeed: new Set(),    // раскрытые drill'ы «показать за что» (date|acc|system)
    feed: new Map(),            // кэш документов drill'а по тому же ключу
  },
  view: 'summary',
  deltaShown: 100,    // пагинация списков
  reviewShown: 50,
  exportsSearch: '',
  filters: {
    date: '', accountant: '', system: '', issueType: '', confirmation: '',
    priority: '', activeOnly: false, hvhhOnly: false, unresolvedOnly: true,
    search: '',
  },
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('toast-error', isError);
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 3500);
}

function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${day}.${m}.${y}`;
}
/** Число с разделителями тысяч (1639460 → «1 639 460») */
function fmtNum(n) {
  return Number(n || 0).toLocaleString('ru-RU').replace(/,/g, ' ');
}
/** Реальный объём выгрузки Артёма = сумма строк по всем наборам данных проекта */
function exportVolumeTotal() {
  return (state.src?.exportVolume || []).reduce((s, r) => s + Number(r.record_count || 0), 0);
}
function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('ru-RU', {
    timeZone: CONFIG.TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/* ------------------------------ Навигация -------------------------------- */
const NAV = [
  { id: 'summary', label: 'Сводка', icon: '▤' },
  { id: 'exports', label: 'Выгрузки', icon: '↓' },
  { id: 'sync', label: 'Синхр.', icon: '⇅' },
  { id: 'accountants', label: 'Бухгалтеры', icon: '☺' },
  { id: 'daily', label: 'Отчёт по дням', icon: '⏱' },
  { id: 'delta', label: 'Дельта', icon: 'Δ' },
  { id: 'review', label: 'Эмилия', icon: '✓' },
  { id: 'artyom', label: 'ТЗ Артёму', icon: '✎' },
  { id: 'meetings', label: 'Встречи', icon: '☰' },
  { id: 'calls', label: 'Созвоны', icon: '☎' },
];

function renderNav() {
  const html = NAV.map((n) =>
    `<button class="nav-item ${state.view === n.id ? 'active' : ''}" data-view="${n.id}">
       <span class="nav-icon">${n.icon}</span><span>${n.label}</span>
     </button>`).join('');
  $('#nav-desktop').innerHTML = html;
  $('#nav-bottom').innerHTML = html;
  document.querySelectorAll('.nav-item').forEach((b) =>
    b.addEventListener('click', () => switchView(b.dataset.view)));
}

function switchView(v) {
  state.view = v;
  document.querySelectorAll('.view').forEach((s) => { s.hidden = true; });
  $('#view-' + v).hidden = false;
  renderNav();
  window.scrollTo({ top: 0 });
  // «Отчёт по дням» грузится лениво при первом открытии (тяжёлый RPC по дням)
  if (v === 'daily' && !state.daily.report && !state.daily.loading) {
    loadDailyReport(state.daily.accountant || DAILY_REPORT.defaultAccountant);
  }
  // «Утренние созвоны» — тоже ленивая загрузка (RPC по каждому бухгалтеру)
  if (v === 'calls' && !state.calls.loaded && !state.calls.loading) {
    loadMorningCalls();
  }
}

/* ------------------------- Хелперы по delta_items ------------------------ */
const isOpen = (r) => !r.resolved_at;

function openItems() { return state.deltaItems.filter(isOpen); }

/** Применение общих фильтров к строкам delta_items */
function applyFilters(rows) {
  const f = state.filters;
  return rows.filter((r) => {
    if (f.unresolvedOnly && r.resolved_at) return false;
    if (f.issueType && r.issue_type !== f.issueType) return false;
    if (f.accountant && (r.accountant_name || '') !== f.accountant) return false;
    if (f.confirmation && r.confirmation_status !== f.confirmation) return false;
    if (f.priority && r.priority !== f.priority) return false;
    if (f.activeOnly && r.client_is_active === false) return false;
    if (f.hvhhOnly && !r.hvhh) return false;
    if (f.date && !(r.snapshot_date <= f.date && (!r.resolved_at || r.resolved_at.slice(0, 10) > f.date))) return false;
    if (f.system) {
      const sys = f.system;
      const inSys = (sys === 'taxservice' && (r.missing_from_system === 'TaxService' || r.exists_in_taxservice))
        || (sys === 'armsoft' && (r.missing_from_system === 'ArmSoft' || r.exists_in_armsoft))
        || (sys === 'ob' && (r.missing_from_system === 'Реестр OB' || r.exists_in_ob_registry))
        || (sys === 'meeting' && r.exists_in_morning_meeting);
      if (!inSys) return false;
    }
    if (f.search) {
      const s = f.search.toLowerCase();
      if (!(`${r.company_name} ${r.hvhh || ''} ${r.accountant_name || ''}`.toLowerCase().includes(s))) return false;
    }
    return true;
  });
}

/* ------------------------------- Карточки -------------------------------- */
function renderSummaryCards() {
  const today = todayStr();
  // «вчера» считаем от бизнес-даты (Ереван), а не от UTC-времени браузера
  const yesterdayIso = new Date(new Date(today + 'T00:00:00Z').getTime() - 86400e3)
    .toISOString().slice(0, 10);
  const open = openItems();
  // Прямой разрыв покрытия (то, что уменьшается после выгрузок Артёма) — совпадает
  // с «общей дельтой» в дневной таблице.
  const forwardTypes = new Set(RULES.TOTAL_DELTA_TYPES);
  const forward = open.filter((r) => forwardTypes.has(r.issue_type));
  const missTax = open.filter((r) => r.issue_type === 'missing_taxservice');
  const missArm = open.filter((r) => r.issue_type === 'missing_armsoft');
  const reverse = open.filter((r) => r.issue_type === 'tax_not_in_ob' || r.issue_type === 'armsoft_not_in_ob');

  const cards = [
    { label: 'Дельта сегодня (нет в выгрузке)', tip: 'Открытые расхождения прямого типа: активный клиент OB, которого нет в выгрузке Артёма. = «Нет в TaxService» + «Нет в ArmSoft». Именно эта цифра должна уменьшаться после новых выгрузок. Нажмите — список компаний.', value: forward.length, color: forward.length ? 'red' : 'green', icon: 'Δ', drill: () => showDrill('Активные клиенты OB, которых нет в выгрузке Артёма', forward) },
    { label: 'Нет в TaxService', tip: 'Открытые расхождения типа missing_taxservice: клиент активен, но не найден в налоговой выгрузке Артёма (v_tax_accounts) ни по ИНН, ни по названию.', value: missTax.length, color: 'red', icon: 'T', drill: () => showDrill(ISSUE_TYPES.missing_taxservice.label, missTax) },
    { label: 'Нет в ArmSoft', tip: 'Открытые расхождения типа missing_armsoft: клиент активен И в реестре заполнена ArmSoft-привязка (armsoft_company_id), но компания не найдена в ArmSoft-выгрузке (v_armsoft_companies).', value: missArm.length, color: 'red', icon: 'A', drill: () => showDrill(ISSUE_TYPES.missing_armsoft.label, missArm) },
    { label: 'Артём выгрузил, нет в реестре OB', tip: 'Обратные расхождения: компания есть в выгрузке Артёма (TaxService или ArmSoft), но не привязана ни к одному активному клиенту OB. Эти цифры НЕ входят в «Дельта сегодня» — их разбирают отдельно (возможно, клиента забыли завести).', value: reverse.length, color: 'yellow', icon: '⇄', drill: () => showDrill('Есть в выгрузке Артёма, но нет в реестре OB', reverse) },
    { label: 'Проблемы выгрузки Артёма', tip: 'Расхождения, которые Эмилия/Лина в разделе «Проверка» пометили статусом «Подтверждено: проблема выгрузки Артёма». Именно они уходят в раздел «ТЗ Артёму».', value: open.filter((r) => r.confirmation_status === 'confirmed_artyom_export_problem').length, color: 'red', icon: '!', drill: () => showDrill('Подтверждённые проблемы выгрузки', open.filter((r) => r.confirmation_status === 'confirmed_artyom_export_problem')) },
    { label: 'Ждут проверки Эмилии', tip: 'Открытые расхождения со статусом «Не проверено» (confirmation_status = not_checked) — по ним ещё не выбрана причина в разделе «Проверка».', value: open.filter((r) => r.confirmation_status === 'not_checked').length, color: 'yellow', icon: '?', drill: () => showDrill('Не проверено', open.filter((r) => r.confirmation_status === 'not_checked')) },
    { label: 'Исправлено со вчера', tip: 'Расхождения, у которых дата закрытия (resolved_at) — вчера или позже. Показывает, сколько разрывов закрылось после последних выгрузок.', value: state.deltaItems.filter((r) => r.resolved_at && r.resolved_at.slice(0, 10) >= yesterdayIso).length, color: 'green', icon: '✓', drill: () => showDrill('Исправлено со вчера', state.deltaItems.filter((r) => r.resolved_at && r.resolved_at.slice(0, 10) >= yesterdayIso)) },
    { label: 'Новые за сегодня', tip: 'Расхождения, впервые появившиеся в сегодняшнем снимке (snapshot_date = сегодня по Еревану).', value: state.deltaItems.filter((r) => r.snapshot_date === today).length, color: 'red', icon: '+', drill: () => showDrill('Новые за сегодня', state.deltaItems.filter((r) => r.snapshot_date === today)) },
  ];

  $('#summary-cards').innerHTML = cards.map((c, i) => `
    <button class="card card-${c.value === 0 && c.color !== 'green' ? 'gray' : c.color}" data-card="${i}" data-tip="${esc(c.tip)}">
      <span class="card-icon">${c.icon}</span>
      <span class="card-value">${c.value}</span>
      <span class="card-label">${c.label}</span>
    </button>`).join('');
  document.querySelectorAll('#summary-cards .card').forEach((el) =>
    el.addEventListener('click', () => cards[+el.dataset.card].drill()));
}

/* --------------------------- Таблица динамики ---------------------------- */
function trend(deltaChange) {
  if (deltaChange == null) return { icon: '·', cls: 'gray', text: 'нет данных' };
  if (deltaChange < 0) return { icon: '▼', cls: 'green', text: 'лучше' };
  if (deltaChange > 0) return { icon: '▲', cls: 'red', text: 'хуже' };
  return { icon: '=', cls: 'gray', text: 'без изменений' };
}

/** Открытые на дату d расхождения типа type (восстановление истории по датам) */
function itemsOnDate(d, type) {
  return state.deltaItems.filter((r) =>
    (!type || r.issue_type === type)
    && r.snapshot_date <= d
    && (!r.resolved_at || r.resolved_at.slice(0, 10) > d));
}

function renderSnapshotTable() {
  const rows = state.snapshots;
  const cell = (s, val, type) =>
    `<td><button class="num-link ${val > 0 ? 'num-bad' : ''}" data-date="${s.snapshot_date}" data-type="${type || ''}">${val}</button></td>`;

  $('#snapshot-table tbody').innerHTML = rows.map((s) => {
    const t = trend(s.delta_change);
    return `<tr>
      <td class="nowrap">${fmtDate(s.snapshot_date)}</td>
      <td>${s.total_active_clients}</td>
      <td>${s.active_with_hvhh}</td>
      <td>${s.expected_taxservice}</td>
      <td>${s.found_taxservice}</td>
      ${cell(s, s.missing_taxservice, 'missing_taxservice')}
      <td>${s.expected_armsoft}</td>
      <td>${s.found_armsoft}</td>
      ${cell(s, s.missing_armsoft, 'missing_armsoft')}
      ${cell(s, s.total_delta, '')}
      <td class="${t.cls}">${s.delta_change == null ? '—' : (s.delta_change > 0 ? '+' : '') + s.delta_change}</td>
      <td class="${t.cls}">${t.icon} ${t.text}</td>
      <td class="nowrap">${fmtDateTime(s.artyom_export_time)}</td>
      <td>${s.artyom_export_records ?? '—'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="14" class="empty">Снимков пока нет — нажмите «Пересчитать»</td></tr>`;

  // мобильная версия таблицы — карточки
  $('#snapshot-cards').innerHTML = rows.map((s) => {
    const t = trend(s.delta_change);
    return `<div class="snap-card">
      <div class="snap-head">
        <strong>${fmtDate(s.snapshot_date)}</strong>
        <span class="badge badge-${t.cls}">${t.icon} ${t.text}${s.delta_change != null ? ` (${s.delta_change > 0 ? '+' : ''}${s.delta_change})` : ''}</span>
      </div>
      <div class="snap-grid">
        <span data-tip="Активные клиенты в реестре OneBusiness (ob_accounting_companies, is_active = да).">Активных клиентов</span><b>${s.total_active_clients}</b>
        <span data-tip="Сколько из активных клиентов имеют известный ИНН/ՀՎՀՀ. ИНН берётся из TaxService (v_tax_accounts.tin) — в реестре OB своего поля ИНН нет.">С ՀՎՀՀ</span><b>${s.active_with_hvhh}</b>
        <span data-tip="Найдено / ожидается в TaxService. Ожидается = активные клиенты; найдено = реально есть в налоговой выгрузке Артёма (v_tax_accounts).">TaxService: найдено/ожид.</span><b>${s.found_taxservice}/${s.expected_taxservice}</b>
        <span data-tip="Ожидаются в TaxService, но не найдены. Нажмите число — список компаний.">Нет в TaxService</span><b><button class="num-link num-bad" data-date="${s.snapshot_date}" data-type="missing_taxservice">${s.missing_taxservice}</button></b>
        <span data-tip="Найдено / ожидается в ArmSoft. Ожидается = активны и заполнена ArmSoft-привязка (armsoft_company_id); найдено = есть в ArmSoft-выгрузке (v_armsoft_companies).">ArmSoft: найдено/ожид.</span><b>${s.found_armsoft}/${s.expected_armsoft}</b>
        <span data-tip="Ожидаются в ArmSoft, но не найдены. Нажмите число — список компаний.">Нет в ArmSoft</span><b><button class="num-link num-bad" data-date="${s.snapshot_date}" data-type="missing_armsoft">${s.missing_armsoft}</button></b>
        <span data-tip="Общий разрыв покрытия = «Нет в TaxService» + «Нет в ArmSoft». Должен уменьшаться после каждой выгрузки Артёма.">Всего дельта</span><b><button class="num-link num-bad" data-date="${s.snapshot_date}" data-type="">${s.total_delta}</button></b>
        <span data-tip="Дата и время последнего прогона парсеров Артёма (v_artyom_export_meta.last_export_time).">Выгрузка Артёма</span><b>${fmtDateTime(s.artyom_export_time)}</b>
        <span data-tip="Сколько всего строк разобрала выгрузка Артёма по всему проекту OB Artyom (сумма по v_artyom_export_volume).">Записей в выгрузке</span><b>${s.artyom_export_records ?? '—'}</b>
      </div>
    </div>`;
  }).join('');

  document.querySelectorAll('.num-link').forEach((b) => b.addEventListener('click', () => {
    const type = b.dataset.type || null;
    const label = type ? ISSUE_TYPES[type].label : 'Все расхождения';
    showDrill(`${label} — ${fmtDate(b.dataset.date)}`, itemsOnDate(b.dataset.date, type));
  }));
}

/* ----------------------------- Выгрузки ----------------------------------- */
function renderExports() {
  if (!state.src) return;
  const dates = state.src.exportDates || [];

  // --- график: даты выгрузок Артёма и их объём (сколько модулей отработало) --
  const max = Math.max(1, ...dates.map((d) => d.modules_run || 0));
  const bars = dates.map((d) => {
    const h = Math.round(((d.modules_run || 0) / max) * 100);
    return `<div class="bar-col" title="${fmtDate(d.run_date)} — модулей: ${d.modules_run}">
      <span class="bar-val">${d.modules_run}</span>
      <span class="bar" style="height:${Math.max(h, 4)}%"></span>
      <span class="bar-label">${fmtDate(d.run_date).slice(0, 5)}</span>
    </div>`;
  }).join('');

  const total = dates.reduce((s, d) => s + (d.modules_run || 0), 0);
  const chartHtml = dates.length
    ? `<div class="chart">${bars}</div>
       <p class="muted">Всего выгрузок (дат): <b>${dates.length}</b> · всего запусков модулей: <b>${total}</b> ·
       последняя: <b>${fmtDate(dates[dates.length - 1].run_date)}</b></p>`
    : '<p class="empty">Нет данных о выгрузках</p>';

  // --- объём выгрузки по всему проекту OB Artyom (все наборы данных) --------
  const volume = (state.src.exportVolume || []).slice()
    .sort((a, b) => Number(b.record_count) - Number(a.record_count));
  const volTotal = exportVolumeTotal();
  const catTotal = (cat) => volume.filter((r) => r.category === cat)
    .reduce((s, r) => s + Number(r.record_count || 0), 0);
  const volRow = (r) => `<tr>
    <td>${esc(r.label || r.source_table)}</td>
    <td><span class="chip ${r.category === 'TaxService' ? 'chip-yes' : 'chip-no'}">${esc(r.category)}</span></td>
    <td class="nowrap" style="text-align:right">${fmtNum(r.record_count)}</td>
  </tr>`;
  const volumeHtml = volume.length ? `
    <h3 class="block-title" data-tip="Сколько всего строк парсеры Артёма загрузили в проект OB Artyom (armsoft_db) по каждому набору данных: не только справочники компаний, а журналы, счета, операции и т.д. Плашка справа — сумма по всем наборам (v_artyom_export_volume). Это объём разобранных данных, а не число компаний.">Объём выгрузки по всему проекту OB Artyom
      <span class="count-pill">${fmtNum(volTotal)} строк</span></h3>
    <p class="hint">Реальный объём того, что парсеры Артёма загрузили в проект: не только справочники
      компаний, а все наборы данных (журналы, счета, операции и т.д.).
      ArmSoft: <b>${fmtNum(catTotal('ArmSoft'))}</b> · TaxService: <b>${fmtNum(catTotal('TaxService'))}</b>
      по <b>${volume.length}</b> наборам.</p>
    <div class="table-wrap">
      <table class="data-table compact">
        <thead><tr>
          <th data-tip="Таблица в проекте OB Artyom (armsoft_db), куда парсеры Артёма сложили данные.">Набор данных</th>
          <th data-tip="Из какой системы данные: TaxService (налоговый кабинет) или ArmSoft.">Источник</th>
          <th style="text-align:right" data-tip="Точное число строк в этом наборе данных.">Строк</th>
        </tr></thead>
        <tbody>${volume.map(volRow).join('')}
          <tr><td><b>Итого</b></td><td></td><td class="nowrap" style="text-align:right"><b>${fmtNum(volTotal)}</b></td></tr>
        </tbody>
      </table>
    </div>` : '';

  // --- две таблицы сравнения выгрузок между собой -------------------------
  const c = state.computed || {};
  const q = (state.exportsSearch || '').toLowerCase();
  const flt = (rows) => !q ? rows : rows.filter((r) =>
    `${r.company_name} ${r.hvhh || ''}`.toLowerCase().includes(q));
  const taxNotArm = flt(c.crossTaxNotArm || []);
  const armNotTax = flt(c.crossArmNotTax || []);

  const rowHtml = (r) => `<tr>
    <td>${esc(r.company_name)}${r.match_quality === 'fuzzy' ? ' <span class="chip chip-fuzzy">≈ ' + esc(r.fuzzy_hint || '') + '</span>' : ''}</td>
    <td class="nowrap">${esc(r.hvhh) || '—'}</td>
  </tr>`;

  const tableBlock = (title, note, rows, limit) => `
    <div class="cross-block">
      <h3 class="block-title" data-tip="${esc(note)} Плашка — число таких компаний. Сравнение идёт по названию (ArmSoft не отдаёт ИНН); значок ≈ у строки означает вероятное неточное совпадение названий.">${title} <span class="count-pill">${rows.length}</span></h3>
      <p class="hint">${note}</p>
      <div class="table-wrap">
        <table class="data-table compact">
          <thead><tr>
            <th data-tip="Название компании из выгрузки Артёма. Значок ≈ — возможное неточное совпадение по названию.">Компания</th>
            <th data-tip="ИНН/ՀՎՀՀ компании. Есть только у TaxService — ArmSoft ИНН не отдаёт, поэтому для ArmSoft-строк здесь прочерк.">ՀՎՀՀ</th>
          </tr></thead>
          <tbody>${rows.slice(0, limit).map(rowHtml).join('') || '<tr><td colspan="2" class="empty">Нет расхождений</td></tr>'}</tbody>
        </table>
      </div>
      ${rows.length > limit ? `<p class="muted">Показаны первые ${limit} из ${rows.length}. Используйте поиск.</p>` : ''}
    </div>`;

  $('#exports-body').innerHTML = `
    <h3 class="block-title" data-tip="История запусков выгрузки по датам (v_artyom_export_dates). Каждый столбец — день выгрузки, высота столбца — сколько модулей-парсеров отработало в этот день (modules_run). Итоговая строка под графиком: число дат выгрузок, суммарное число запусков модулей и дата последней выгрузки.">Выгрузки Артёма по датам</h3>
    <p class="hint">Каждый столбец — дата, когда Артём делал выгрузку; высота — сколько модулей-парсеров отработало в этот день.</p>
    ${chartHtml}
    ${volumeHtml}
    <div class="filters"><div class="filter-grid"><label class="filter-search">Поиск по таблицам
      <input type="search" id="exports-search" placeholder="Компания или ՀՎՀՀ…" value="${esc(state.exportsSearch || '')}">
    </label></div></div>
    ${tableBlock('Есть в TaxService, нет в ArmSoft',
      'Компании из налоговой выгрузки, которых нет в ArmSoft-выгрузке Артёма.', taxNotArm, 200)}
    ${tableBlock('Есть в ArmSoft, нет в TaxService',
      'Компании из ArmSoft-выгрузки, которых нет в налоговой выгрузке Артёма.', armNotTax, 200)}`;

  const s = $('#exports-search');
  if (s) s.addEventListener('input', () => {
    state.exportsSearch = s.value;
    const pos = s.selectionStart;
    renderExports();
    const s2 = $('#exports-search'); if (s2) { s2.focus(); s2.setSelectionRange(pos, pos); }
  });
}

/* ------------------------- Синхронизация задач ---------------------------- */
function scheduleBannerHtml() {
  const st = state.exportStatus;
  const key = st?.status || 'no_data';
  const meta = TASK_SYNC.scheduleStatuses[key] || TASK_SYNC.scheduleStatuses.no_data;
  const late = st && st.hours_late ? ` · опоздание: <b>${st.hours_late} ч</b>` : '';
  return `<div class="sched-banner sched-${meta.color}">
    <span class="sched-emoji">${meta.emoji}</span>
    <div class="sched-text">
      <strong>График выгрузки Артёма: ${meta.label}</strong>
      <span class="muted">
        Последняя выгрузка: <b>${fmtDateTime(st?.last_run)}</b> ·
        ожидалась к: <b>${fmtDateTime(st?.expected_by)}</b>${late}
      </span>
    </div>
  </div>`;
}

function renderSync() {
  const body = $('#sync-body');
  if (!body) return;
  if (!state.taskSync) { body.innerHTML = '<p class="empty">Нажмите «Пересчитать», чтобы выполнить сверку.</p>'; return; }
  const ts = state.taskSync;
  const rep = ts.report;

  // --- отчёт по процессу: 2 ключевых показателя ---
  const expMeta = TASK_SYNC.scheduleStatuses[rep.exported] || TASK_SYNC.scheduleStatuses.no_data;
  const exportedGood = rep.exported === 'exported';
  const matchRate = rep.dataMatchRate;
  const matchColor = matchRate == null ? 'gray' : (matchRate >= 90 ? 'green' : matchRate >= 70 ? 'yellow' : 'red');

  const reportHtml = `
    <h3 class="block-title">Отчёт по процессу взаимодействия с Артёмом</h3>
    <div class="report-tiles">
      <div class="report-tile tile-${exportedGood ? 'green' : expMeta.color}" data-tip="Успел ли Артём сделать выгрузку по графику. Ожидаем свежую выгрузку к 02:00 по Еревану + 12 ч льготного периода (config.js → TASK_SYNC.exportSchedule). Статус приходит из серверной проверки artyom_export_schedule_status: Выгрузил / Ожидаем / Просрочено / Нет данных.">
        <span class="tile-label">1. Выгрузил Артём?</span>
        <span class="tile-value">${expMeta.emoji} ${expMeta.label}</span>
        <span class="tile-sub">Проверка графика выгрузки</span>
      </div>
      <div class="report-tile tile-${matchColor}" data-tip="Насколько задачи бухгалтеров подтверждаются выгрузкой. Соответствие (%) = задачи, отражённые в выгрузке ÷ ожидаемые в выгрузке × 100. Ожидаемые = задачи, которые в норме должны попасть в выгрузку (без структурно невидимой работы). Цвет: ≥90% зелёный, ≥70% жёлтый, ниже красный.">
        <span class="tile-label">2. Данные соответствуют действительности?</span>
        <span class="tile-value">${matchRate == null ? '—' : matchRate + '%'}</span>
        <span class="tile-sub">${rep.inExportTotal} из ${rep.expectedTotal} задач отражены в выгрузке</span>
      </div>
    </div>
    <div class="report-stats muted">
      <span data-tip="Число задач бухгалтеров, которые ожидались в выгрузке, но там их нет (компания не найдена в нужной системе). Это и есть кандидаты в проблемы.">Не отражено в выгрузке: <b class="${rep.missingTotal ? 'red' : 'green'}">${rep.missingTotal}</b></span> ·
      <span data-tip="Задачи, которые выгрузка Артёма структурно НЕ видит (устные согласования, консультации, корректировки прошлых периодов). Распознаются по списку config.js → TASK_SYNC.tasksNotInExport и исключаются из знаменателя соответствия.">Артём не видит (по правилам): <b>${rep.notExpectedTotal}</b></span> ·
      <span data-tip="Сколько бухгалтеров попало в окно сверки (у кого была активность за последние 45 дней от самой свежей даты в данных).">Бухгалтеров: <b>${rep.accountants}</b></span> ·
      <span data-tip="Число записей в списке проблем сверки (расхождения графика, пропуски, ошибки формата).">Проблем: <b class="${rep.problemsCount ? 'red' : 'green'}">${rep.problemsCount}</b></span> ·
      <span data-tip="Диапазон дат, за который сверялись задачи (окно 45 дней, отсчитывается от самой свежей даты активности в данных, а не от сегодня).">Окно сверки: ${fmtDate(ts.windowStart)} — ${fmtDate(ts.referenceDate)}</span>
    </div>`;

  // --- фильтр по бухгалтеру ---
  const accs = ts.byAccountant.map((a) => a.accountant);
  const accFilter = `<div class="filters"><div class="filter-grid"><label>Бухгалтер
    <select id="sync-acc">
      <option value="">Все (${accs.length})</option>
      ${accs.map((a) => `<option ${state.syncAccountant === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
    </select></label></div></div>`;

  // --- карта DB-строк для самопроверки (по task_key) ---
  const byKey = new Map(state.taskSyncItems.map((r) => [r.task_key, r]));

  // --- по каждому бухгалтеру: задачи, НЕ отражённые в выгрузке ---
  const accs2 = state.syncAccountant
    ? ts.byAccountant.filter((a) => a.accountant === state.syncAccountant)
    : ts.byAccountant;

  const accCards = accs2.map((a) => {
    const rate = a.matchRate == null ? '—' : a.matchRate + '%';
    const rateColor = a.matchRate == null ? 'gray' : (a.matchRate >= 90 ? 'green' : a.matchRate >= 70 ? 'yellow' : 'red');
    const missing = a.missingTasks.map((t) => {
      const db = byKey.get(t.task_key);
      const sc = SELF_CHECK_STATUSES[db?.accountant_response_status || 'pending'];
      const sys = t.system_source === 'taxservice' ? 'TaxService' : 'ArmSoft';
      return `<div class="sync-task" data-key="${esc(t.task_key)}">
        <div class="sync-task-main">
          <b>${esc(t.company_name)}</b>
          <span class="chip chip-no">✗ нет в ${sys}</span>
          <span class="muted">${esc(t.task_type_label)}: ${esc(t.work_summary.split(': ')[1] || '')}</span>
          ${db ? `<span class="badge badge-${sc.color}">${sc.label}</span>` : ''}
        </div>
        ${db ? `<div class="sync-selfcheck">
          <select data-selfcheck="${db.id}">
            ${Object.entries(SELF_CHECK_STATUSES).map(([k, v]) =>
              `<option value="${k}" ${db.accountant_response_status === k ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
          <input type="text" placeholder="Комментарий бухгалтера…" value="${esc(db.accountant_response || '')}" data-selfcheck-note="${db.id}">
          <button class="btn btn-sm" data-selfcheck-save="${db.id}">OK</button>
        </div>` : ''}
      </div>`;
    }).join('') || '<p class="muted" style="padding:0 12px 12px">Все учтённые задачи отражены в выгрузке ✓</p>';

    return `<div class="item-card">
      <div class="item-head">
        <strong>${esc(a.accountant)}</strong>
        <span class="badge badge-${a.missing ? 'red' : 'green'}">${a.missing} не в выгрузке</span>
      </div>
      <div class="item-meta">
        <span data-tip="Сколько задач этого бухгалтера попало в окно сверки (по accounting_activities за 45 дней).">Всего задач: <b>${a.total}</b></span>
        <span data-tip="Из них подтверждены выгрузкой — компания найдена в TaxService или ArmSoft.">В выгрузке: <b class="green">${a.inExport}</b></span>
        <span data-tip="Задачи, которые выгрузка структурно не видит (консультации, устные согласования и т.п.) — в знаменатель соответствия не входят.">Артём не видит: <b>${a.notExpected}</b></span>
        <span data-tip="Соответствие = В выгрузке ÷ (Всего − Артём не видит) × 100. Зелёный ≥90%, жёлтый ≥70%, красный ниже.">Соответствие: <b class="${rateColor}">${rate}</b></span>
      </div>
      ${missing}
    </div>`;
  }).join('') || '<p class="empty">Нет задач в окне сверки</p>';

  // --- список проблем (из БД, с редактируемым статусом; fallback — computed) ---
  const problems = state.syncProblems.length ? state.syncProblems : ts.problems;
  const fromDb = state.syncProblems.length > 0;
  const probRows = problems
    .slice()
    .sort((x, y) => ({ high: 0, medium: 1, low: 2 }[x.severity] - { high: 0, medium: 1, low: 2 }[y.severity]))
    .map((p) => {
      const pst = PROBLEM_STATUSES[p.status || 'open'];
      const sevCls = p.severity === 'high' ? 'red' : p.severity === 'medium' ? 'yellow' : 'gray';
      return `<div class="item-card ${p.status === 'resolved' ? 'item-resolved' : ''}">
        <div class="item-head">
          <strong class="item-name">${esc(p.title)}</strong>
          <span class="badge badge-${pst.color}">${pst.label}</span>
        </div>
        <div class="item-meta">
          <span class="badge badge-${sevCls}">${PROBLEM_CATEGORIES[p.category] || p.category}</span>
          ${p.accountant_name ? `<span>Бухгалтер: <b>${esc(p.accountant_name)}</b></span>` : ''}
          ${p.detected_date ? `<span>Дата: <b>${fmtDate(p.detected_date)}</b></span>` : ''}
        </div>
        <div class="item-reason">${esc(p.description || '')}</div>
        ${fromDb ? `<div class="review-fields">
          ${Object.entries(PROBLEM_STATUSES).map(([k, v]) =>
            `<button class="btn btn-status ${p.status === k ? 'btn-status-active btn-status-' + v.color : ''}"
                     data-prob-status="${k}" data-id="${p.id}">${v.label}</button>`).join('')}
        </div>` : ''}
      </div>`;
    }).join('') || '<p class="empty">Проблем не обнаружено ✓</p>';

  body.innerHTML = `
    ${scheduleBannerHtml()}
    ${reportHtml}
    <h3 class="block-title" data-tip="По каждому бухгалтеру — сколько его задач подтверждено выгрузкой и какие конкретно НЕ отражены. Раскройте бухгалтера, чтобы увидеть задачи; поле самопроверки — заготовка следующего этапа (бухгалтер сам подтверждает, учтена ли работа).">По бухгалтерам · задачи, не отражённые в выгрузке</h3>
    <p class="hint">Разворачивайте бухгалтера, чтобы увидеть конкретные задачи. Поле самопроверки —
      заготовка следующего этапа: бухгалтер сам подтверждает, учтена ли работа.</p>
    ${accFilter}
    <div class="list">${accCards}</div>
    <h3 class="block-title" data-tip="Расхождения, пропуски и ошибки формата, найденные при сверке (категории: график выгрузки, нет в выгрузке, расхождение названия, ошибка формата, не отражённая работа). Из таблицы sync_problems, либо вычислено на лету. Плашка — число проблем; сортировка по важности (высокая → низкая).">Список проблем сверки <span class="count-pill">${problems.length}</span></h3>
    <p class="hint">Расхождения, пропуски и ошибки формата, найденные при сверке задач с выгрузкой.</p>
    <div class="list">${probRows}</div>`;

  bindSyncActions(body);
}

function bindSyncActions(container) {
  const accSel = container.querySelector('#sync-acc');
  if (accSel) accSel.addEventListener('change', () => { state.syncAccountant = accSel.value; renderSync(); });

  container.querySelectorAll('[data-selfcheck-save]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = +b.dataset.selfcheckSave;
      const card = b.closest('.sync-task');
      const status = card.querySelector('[data-selfcheck]').value;
      const note = card.querySelector('[data-selfcheck-note]').value || null;
      try {
        const updated = await updateTaskSyncItem(id, {
          accountant_response_status: status,
          accountant_response: note,
          accountant_confirmed: status === 'confirmed_ok',
          accountant_checked_at: new Date().toISOString(),
        });
        const idx = state.taskSyncItems.findIndex((r) => r.id === id);
        if (idx >= 0) state.taskSyncItems[idx] = updated;
        toast('Самопроверка сохранена ✓');
        renderSync();
      } catch (e) { toast('Ошибка: ' + e.message, true); }
    }));

  container.querySelectorAll('[data-prob-status]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = +b.dataset.id;
      const status = b.dataset.probStatus;
      try {
        const updated = await updateSyncProblem(id, {
          status, resolved_at: status === 'resolved' ? new Date().toISOString() : null,
        });
        const idx = state.syncProblems.findIndex((r) => r.id === id);
        if (idx >= 0) state.syncProblems[idx] = updated;
        toast('Статус проблемы обновлён ✓');
        renderSync();
      } catch (e) { toast('Ошибка: ' + e.message, true); }
    }));
}

/* -------------------------- Строка компании ------------------------------ */
function chips(r) {
  const chip = (ok, label) =>
    `<span class="chip ${ok ? 'chip-yes' : 'chip-no'}">${ok ? '✓' : '✗'} ${label}</span>`;
  // Tax/ArmSoft = найдено в выгрузке Артёма по этой системе; OB = ведётся в реестре OB
  return chip(r.exists_in_taxservice, 'TaxService') + chip(r.exists_in_armsoft, 'ArmSoft')
    + chip(r.exists_in_ob_registry, 'Реестр OB') + chip(r.exists_in_morning_meeting, 'Встреча')
    + (r.match_quality === 'fuzzy' ? '<span class="chip chip-fuzzy">≈ неточное совпадение</span>' : '');
}

function itemCard(r, withReview = false) {
  const conf = CONFIRMATION_STATUSES[r.confirmation_status] || CONFIRMATION_STATUSES.not_checked;
  return `<div class="item-card ${r.resolved_at ? 'item-resolved' : ''}" data-id="${r.id}">
    <div class="item-head">
      <strong class="item-name">${esc(r.company_name)}</strong>
      <span class="badge badge-${conf.color}">${conf.label}</span>
    </div>
    <div class="item-meta">
      <span data-tip="ИНН/ՀՎՀՀ компании. Восстанавливается из TaxService (v_tax_accounts.tin) через связь tax_account_id или совпадение названия — в реестре OB своего поля ИНН нет. Прочерк, если не удалось определить.">ՀՎՀՀ: <b>${esc(r.hvhh) || '—'}</b></span>
      <span data-tip="Бухгалтер, за которым закреплён клиент в реестре OB (ob_accounting_companies.accountant_name).">Бухгалтер: <b>${esc(r.accountant_name) || '—'}</b></span>
      <span data-tip="Активен ли клиент в реестре OB (is_active). Расхождения считаются только по активным клиентам.">Статус: <b>${r.client_is_active === true ? 'активен' : r.client_is_active === false ? 'неактивен' : '—'}</b></span>
      <span data-tip="Приоритет разбора, выставляется вручную в разделе «Проверка».">Приоритет: <b>${PRIORITIES[r.priority]?.label || r.priority}</b></span>
    </div>
    <div class="item-issue">
      <span class="badge badge-red" data-tip="Тип расхождения. Прямые (нет в TaxService/ArmSoft) считаются в общую дельту; обратные (есть у Артёма, нет в реестре OB) разбираются отдельно и в дельту не входят.">${ISSUE_TYPES[r.issue_type]?.short || r.issue_type}</span>
      <span class="muted">не хватает: ${esc(r.missing_from_system)}</span>
    </div>
    <div class="item-chips" data-tip="Где компания реально существует: ✓ TaxService / ArmSoft — найдена в выгрузке Артёма по этой системе; ✓ Реестр OB — ведётся в реестре клиентов; ✓ Встреча — упоминалась на утренней встрече. ≈ — неточное (fuzzy) совпадение по названию.">${chips(r)}</div>
    <div class="item-reason">${esc(r.possible_reason || '')}</div>
    <div class="item-foot muted">
      Обнаружено: ${fmtDate(r.snapshot_date)} · Последняя проверка: ${fmtDate(r.last_seen_date)}
      ${r.resolved_at ? ` · <span class="green">Закрыто ${fmtDate(r.resolved_at)}</span>` : ''}
      · Источник: ${esc(r.source_table)}
    </div>
    ${r.comment ? `<div class="item-comment">» ${esc(r.comment)}${r.responsible_person ? ` — <b>${esc(r.responsible_person)}</b>` : ''}</div>` : ''}
    ${withReview ? reviewControls(r) : ''}
  </div>`;
}

/* --------------------------- Фильтры (общие) ------------------------------ */
function filtersHtml(idPrefix, { withConfirmation = true } = {}) {
  const accountants = [...new Set(state.src.clients.map((c) => c.accountant_name).filter(Boolean))].sort();
  const f = state.filters;
  return `
  <div class="filter-grid">
    <label>Дата
      <input type="date" data-f="date" value="${f.date}">
    </label>
    <label>Бухгалтер
      <select data-f="accountant">
        <option value="">Все</option>
        ${accountants.map((a) => `<option ${f.accountant === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
      </select>
    </label>
    <label>Система
      <select data-f="system">
        <option value="">Все</option>
        <option value="taxservice" ${f.system === 'taxservice' ? 'selected' : ''}>TaxService</option>
        <option value="armsoft" ${f.system === 'armsoft' ? 'selected' : ''}>ArmSoft</option>
        <option value="ob" ${f.system === 'ob' ? 'selected' : ''}>Реестр OB</option>
        <option value="meeting" ${f.system === 'meeting' ? 'selected' : ''}>Встречи</option>
      </select>
    </label>
    <label>Тип расхождения
      <select data-f="issueType">
        <option value="">Все</option>
        ${Object.entries(ISSUE_TYPES).map(([k, v]) => `<option value="${k}" ${f.issueType === k ? 'selected' : ''}>${v.short}</option>`).join('')}
      </select>
    </label>
    ${withConfirmation ? `<label>Статус проверки
      <select data-f="confirmation">
        <option value="">Все</option>
        ${Object.entries(CONFIRMATION_STATUSES).map(([k, v]) => `<option value="${k}" ${f.confirmation === k ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select>
    </label>` : ''}
    <label>Приоритет
      <select data-f="priority">
        <option value="">Все</option>
        ${Object.entries(PRIORITIES).map(([k, v]) => `<option value="${k}" ${f.priority === k ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select>
    </label>
    <label class="filter-search">Поиск
      <input type="search" data-f="search" placeholder="Компания, ՀՎՀՀ, бухгалтер…" value="${esc(f.search)}">
    </label>
  </div>
  <div class="filter-checks">
    <label><input type="checkbox" data-f="activeOnly" ${f.activeOnly ? 'checked' : ''}> Только активные клиенты</label>
    <label><input type="checkbox" data-f="hvhhOnly" ${f.hvhhOnly ? 'checked' : ''}> Только с ՀՎՀՀ</label>
    <label><input type="checkbox" data-f="unresolvedOnly" ${f.unresolvedOnly ? 'checked' : ''}> Только нерешённые</label>
  </div>`;
}

function bindFilters(container) {
  container.querySelectorAll('[data-f]').forEach((el) => {
    el.addEventListener(el.type === 'search' ? 'input' : 'change', () => {
      const k = el.dataset.f;
      state.filters[k] = el.type === 'checkbox' ? el.checked : el.value;
      state.deltaShown = 100;
      state.reviewShown = 50;
      renderDeltaList();
      renderReviewList();
      renderMeetings();
    });
  });
}

/* ----------------------------- 2. Дельта ---------------------------------- */
function renderDeltaList() {
  const rows = applyFilters(state.deltaItems);
  const shown = rows.slice(0, state.deltaShown);
  $('#delta-list').innerHTML =
    `<p class="muted">Найдено расхождений: <b>${rows.length}</b></p>` +
    (shown.map((r) => itemCard(r, false)).join('') || '<p class="empty">Нет расхождений по выбранным фильтрам</p>');
  $('#delta-more').hidden = rows.length <= state.deltaShown;
}

/* ----------------------- 3. Проверка с Эмилией ---------------------------- */
function reviewControls(r) {
  return `<div class="review-controls">
    <div class="status-buttons">
      ${Object.entries(CONFIRMATION_STATUSES).map(([k, v]) => `
        <button class="btn btn-status ${r.confirmation_status === k ? 'btn-status-active btn-status-' + v.color : ''}"
                data-action="status" data-id="${r.id}" data-status="${k}">${v.label}</button>`).join('')}
    </div>
    <div class="review-fields">
      <input type="text" placeholder="Комментарий…" value="${esc(r.comment || '')}" data-field="comment" data-id="${r.id}">
      <input type="text" placeholder="Ответственный…" value="${esc(r.responsible_person || '')}" data-field="responsible_person" data-id="${r.id}">
      <select data-field="priority" data-id="${r.id}">
        ${Object.entries(PRIORITIES).map(([k, v]) => `<option value="${k}" ${r.priority === k ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select>
      <button class="btn btn-primary" data-action="save" data-id="${r.id}">Сохранить</button>
    </div>
  </div>`;
}

function renderReviewList() {
  const rows = applyFilters(state.deltaItems)
    .slice()
    .sort((a, b) => (a.confirmation_status === 'not_checked' ? -1 : 1) - (b.confirmation_status === 'not_checked' ? -1 : 1));
  const shown = rows.slice(0, state.reviewShown);
  $('#review-list').innerHTML =
    `<p class="muted">К проверке: <b>${rows.filter((r) => r.confirmation_status === 'not_checked').length}</b> из ${rows.length}</p>` +
    (shown.map((r) => itemCard(r, true)).join('') || '<p class="empty">Ничего не найдено</p>');
  $('#review-more').hidden = rows.length <= state.reviewShown;
  bindReviewActions($('#review-list'));
}

function bindReviewActions(container) {
  container.querySelectorAll('[data-action="status"]').forEach((b) =>
    b.addEventListener('click', () => saveReview(+b.dataset.id, { confirmation_status: b.dataset.status })));
  container.querySelectorAll('[data-action="save"]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = +b.dataset.id;
      const card = b.closest('.item-card');
      const fields = {};
      card.querySelectorAll('[data-field]').forEach((el) => { fields[el.dataset.field] = el.value || null; });
      saveReview(id, fields);
    }));
}

async function saveReview(id, fields) {
  try {
    const updated = await updateDeltaItem(id, fields);
    const idx = state.deltaItems.findIndex((r) => r.id === id);
    if (idx >= 0) state.deltaItems[idx] = updated;
    // автосоздание ТЗ Артёму при подтверждении проблемы выгрузки
    if (updated.confirmation_status === 'confirmed_artyom_export_problem') {
      await ensureTzItem(updated);
      state.tzItems = await loadTzItems();
      renderTz();
    }
    toast('Сохранено ✓');
    renderReviewList();
    renderDeltaList();
    renderSummaryCards();
  } catch (e) {
    toast('Ошибка сохранения: ' + e.message, true);
  }
}

/* --------------------------- 4. ТЗ Артёму --------------------------------- */
function renderTz() {
  const rows = state.tzItems;
  $('#tz-list').innerHTML = rows.map((t) => {
    const st = TZ_STATUSES[t.status] || TZ_STATUSES.open;
    return `<div class="item-card">
      <div class="item-head">
        <strong class="item-name">${esc(t.company_name)}</strong>
        <span class="badge badge-${st.color}">${st.label}</span>
      </div>
      <div class="item-meta">
        <span data-tip="ИНН/ՀՎՀՀ компании (из TaxService).">ՀՎՀՀ: <b>${esc(t.hvhh) || '—'}</b></span>
        <span data-tip="Приоритет пункта — переносится из раздела «Проверка».">Приоритет: <b>${PRIORITIES[t.priority]?.label || t.priority}</b></span>
        <span data-tip="Дата, когда расхождение впервые обнаружено.">Обнаружено: <b>${fmtDate(t.date_detected)}</b></span>
      </div>
      <div class="item-reason">${esc(t.issue_description || '')}</div>
      <div class="item-meta">
        <span data-tip="Система, в которой компания ДОЛЖНА быть по правилу (TaxService и/или ArmSoft), но её там нет.">Ожидается в: <b>${esc(t.expected_source) || '—'}</b></span>
        <span data-tip="Где компания сейчас фактически присутствует (например, только в реестре OB или только в одной из систем).">Фактически есть: <b>${esc(t.actual_source) || '—'}</b></span>
      </div>
      ${t.comment ? `<div class="item-comment">» ${esc(t.comment)}</div>` : ''}
      <div class="review-fields">
        ${Object.entries(TZ_STATUSES).map(([k, v]) => `
          <button class="btn btn-status ${t.status === k ? 'btn-status-active btn-status-' + v.color : ''}"
                  data-tz-status="${k}" data-id="${t.id}">${v.label}</button>`).join('')}
      </div>
    </div>`;
  }).join('') || '<p class="empty">Пока нет подтверждённых проблем выгрузки. Отметьте расхождения в разделе «Эмилия».</p>';

  $('#tz-list').querySelectorAll('[data-tz-status]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await updateTzItem(+b.dataset.id, { status: b.dataset.tzStatus });
        state.tzItems = await loadTzItems();
        renderTz();
        toast('Статус обновлён ✓');
      } catch (e) { toast('Ошибка: ' + e.message, true); }
    }));
}

/** Готовое сообщение Артёму на русском, сгруппированное по типу проблемы */
function generateArtyomMessage() {
  const rows = state.tzItems.filter((t) => t.status === 'open' || t.status === 'sent');
  if (!rows.length) { toast('Нет открытых пунктов для Артёма', true); return; }

  const byIssue = new Map();
  for (const t of rows) {
    const key = t.expected_source || 'Прочее';
    if (!byIssue.has(key)) byIssue.set(key, []);
    byIssue.get(key).push(t);
  }

  const lines = [];
  lines.push('Привет, Артём!');
  lines.push('');
  lines.push('Мы сверили твою выгрузку с TaxService, ArmSoft и отчётами бухгалтеров.');
  lines.push('Ниже список компаний, по которым есть расхождения — они подтверждены Эмилией/Линой как проблемы выгрузки.');
  lines.push('');
  let n = 0;
  for (const [group, items] of byIssue) {
    lines.push(`— Ожидается в: ${group} (${items.length} шт.)`);
    for (const t of items) {
      n += 1;
      const parts = [`${n}. «${t.company_name}»`];
      if (t.hvhh) parts.push(`ՀՎՀՀ: ${t.hvhh}`);
      if (t.issue_description) parts.push(t.issue_description);
      if (t.actual_source) parts.push(`сейчас есть только в: ${t.actual_source}`);
      if (t.comment) parts.push(`комментарий: ${t.comment}`);
      if (t.priority === 'high') parts.push('(!) высокий приоритет');
      lines.push('   ' + parts.join(' · '));
    }
    lines.push('');
  }
  lines.push('Что нужно сделать:');
  lines.push('1) Проверить, почему эти компании не попали в выгрузку (фильтры, статусы, названия).');
  lines.push('2) Добавить их в следующий экспорт или объяснить, почему их там быть не должно.');
  lines.push('3) Сообщить нам дату следующей выгрузки, чтобы мы проверили динамику дельты.');
  lines.push('');
  lines.push('Спасибо!');

  $('#tz-message').value = lines.join('\n');
  $('#tz-message-box').hidden = false;
}

/* ------------- Бухгалтеры: реальная работа по каждой компании -------------- */
/* Каждая карточка компании показывает фактическую работу из выгрузки Артёма
 * (сданные налоговые отчёты + выставленные/полученные счета ArmSoft и
 * TaxService) и раскрывается в список КОНКРЕТНЫХ задач (ob_company_task_feed). */

const ACC_CAT = {
  invoice_issued:       { icon: '🧾', verb: 'Выставлен счёт' },
  invoice_received:     { icon: '📥', verb: 'Получен счёт' },
  tax_invoice_issued:   { icon: '🧾', verb: 'Выставлен налоговый счёт' },
  tax_invoice_received: { icon: '📥', verb: 'Получен налоговый счёт' },
  report:               { icon: '📄', verb: 'Сдан отчёт' },
};

/** Сумма с валютой: 14000, AMD → «14 000 ֏» */
function fmtMoney(amount, cur) {
  if (amount == null || amount === '') return '';
  const n = Number(amount);
  if (!isFinite(n) || n === 0) return '';
  const val = fmtNum(Math.round(n));
  return cur === 'AMD' || !cur ? `${val} ֏` : `${val} ${cur}`;
}

/** Компактные значки «где существует компания» */
function accExistBadges(r) {
  const cell = (ok, label, fuzzy) =>
    `<span class="ex ex-${ok ? 'y' : 'n'}" title="${label}">${label}${fuzzy ? ' ≈' : ''}</span>`;
  return `<span class="ex-row">`
    + cell(r.in_ob_registry, 'OB')
    + cell(r.in_taxservice, 'TaxService', r.tax_quality === 'fuzzy')
    + cell(r.in_armsoft, 'ArmSoft', r.arm_quality === 'fuzzy')
    + `</span>`;
}

/** Чипы-сводка реальной работы компании */
function accWorkChips(w) {
  if (!w || !w.total) return '<span class="muted">нет работы в выгрузке Артёма</span>';
  const chips = [];
  if (w.reports)           chips.push(`<span class="wchip wchip-report" data-tip="Сданные налоговые отчёты (формы) по этой компании из выгрузки Артёма.">📄 Отчёты: ${w.reports}</span>`);
  if (w.invoices_issued)   chips.push(`<span class="wchip wchip-inv" data-tip="Выставленные счета: ArmSoft + налоговые э-счета TaxService.">🧾 Счета выст.: ${w.invoices_issued}</span>`);
  if (w.invoices_received) chips.push(`<span class="wchip wchip-rcv" data-tip="Полученные/проведённые счета: ArmSoft + налоговые э-счета TaxService.">📥 Счета получ.: ${w.invoices_received}</span>`);
  return chips.join(' ');
}

/** Ключ компании для раскрытия/кэша списка задач */
function accKey(r) { return `${r.arm_id != null ? r.arm_id : ''}|${r.tin || ''}`; }

/** Одна задача в раскрытом списке */
function accTaskLine(t) {
  const m = ACC_CAT[t.category] || { icon: '•', verb: t.category };
  const money = fmtMoney(t.amount, t.currency);
  const detail = t.detail ? ` — ${esc(t.detail)}` : '';
  const sum = money ? ` <b class="task-sum">${money}</b>` : '';
  const st = t.status ? ` <span class="task-st">${esc(t.status)}</span>` : '';
  return `<div class="task-line task-${t.system === 'ArmSoft' ? 'arm' : 'tax'}">
    <span class="task-date">${fmtDate(t.task_date)}</span>
    <span class="task-sys">${esc(t.system)}</span>
    <span class="task-body">${m.icon} ${esc(m.verb)}: ${esc(t.title)}${detail}${sum}${st}</span>
  </div>`;
}

/** Блок раскрытого списка задач (учитывает состояние загрузки/ошибки/кэша) */
function accFeedBlock(r) {
  const key = accKey(r);
  const st = state.accFeed.get(key);
  if (!st || st.loading) return `<div class="acc-feed"><p class="muted">Загрузка задач…</p></div>`;
  if (st.error) return `<div class="acc-feed"><p class="red">Ошибка загрузки задач: ${esc(st.error)}</p></div>`;
  if (!st.rows.length) return `<div class="acc-feed"><p class="muted">Задач в выгрузке не найдено.</p></div>`;
  const shown = st.rows;
  return `<div class="acc-feed">
    <div class="acc-feed-head">Задачи (${shown.length}${shown.length >= 500 ? '+, последние' : ''}) — от новых к старым</div>
    ${shown.map(accTaskLine).join('')}
  </div>`;
}

/** Карточка одной компании */
function accCompanyCard(r, showAcc) {
  const key = accKey(r);
  const expanded = state.accExpanded.has(key);
  const canDrill = r.has_work && (r.arm_id != null || r.tin);
  const meta = [];
  if (r.contract_number) meta.push(`Договор <b>${esc(r.contract_number)}</b>`);
  if (r.hvhh) meta.push(`ՀՎՀՀ <b>${esc(r.hvhh)}</b>`);
  if (showAcc && r.accountant_name) meta.push(`Бухгалтер: <b>${esc(r.accountant_name)}</b>`);
  if (r.work.last_date) meta.push(`посл. работа: <b>${fmtDate(r.work.last_date)}</b>`);
  return `<div class="acc-card${r.has_work ? '' : ' acc-card-idle'}">
    <div class="acc-card-head">
      <span class="acc-card-name">${esc(r.company_name)}${r.is_active ? '' : ' <span class="wchip wchip-idle">неактивен</span>'}</span>
      ${accExistBadges(r)}
    </div>
    <div class="acc-card-meta">${meta.join(' · ') || '<span class="muted">нет реквизитов</span>'}</div>
    <div class="acc-card-work">${accWorkChips(r.work)}</div>
    ${canDrill ? `<button class="btn btn-sm acc-drill" data-acc-key="${esc(key)}" data-arm="${r.arm_id != null ? r.arm_id : ''}" data-tin="${esc(r.tin || '')}">
      ${expanded ? '▾ Скрыть задачи' : `▸ Показать задачи (${r.work.total})`}</button>` : ''}
    ${expanded ? accFeedBlock(r) : ''}
  </div>`;
}

function renderAccountants() {
  const body = $('#accountants-body');
  if (!body) return;
  if (!state.accCompare) {
    state.accCompare = state.src ? computeAccountantComparison(state.src) : null;
  }
  if (!state.accCompare) { body.innerHTML = '<p class="empty">Нет данных. Нажмите «Пересчитать».</p>'; return; }

  const cmp = state.accCompare;
  const f = state.accFilter;
  const accs = cmp.byAccountant.map((a) => a.accountant);
  const sel = f.accountant ? cmp.byAccountant.find((a) => a.accountant === f.accountant) : null;

  let rows = f.accountant ? (sel ? sel.companies.slice() : []) : cmp.rows.slice();
  if (f.activeOnly) rows = rows.filter((r) => r.is_active);
  if (f.workOnly) rows = rows.filter((r) => r.has_work);
  if (f.presence === 'no_tax') rows = rows.filter((r) => !r.in_taxservice);
  else if (f.presence === 'no_arm') rows = rows.filter((r) => !r.in_armsoft);
  else if (f.presence === 'in_tax') rows = rows.filter((r) => r.in_taxservice);
  else if (f.presence === 'in_arm') rows = rows.filter((r) => r.in_armsoft);
  if (f.search) {
    const q = f.search.toLowerCase();
    rows = rows.filter((r) => `${r.company_name} ${r.hvhh || ''} ${r.contract_number || ''} ${r.accountant_name || ''}`.toLowerCase().includes(q));
  }
  // компании с реальной работой — первыми, внутри по объёму работы, затем по алфавиту
  rows.sort((a, b) => (b.work.total - a.work.total) || a.company_name.localeCompare(b.company_name, 'ru'));

  // --- агрегированные показатели реальной работы ---
  const agg = sel || cmp.byAccountant.reduce((s, a) => ({
    active: s.active + a.active, total: s.total + a.total, withWork: s.withWork + a.withWork,
    workReports: s.workReports + a.workReports,
    workInvoicesIssued: s.workInvoicesIssued + a.workInvoicesIssued,
    workInvoicesReceived: s.workInvoicesReceived + a.workInvoicesReceived,
  }), { active: 0, total: 0, withWork: 0, workReports: 0, workInvoicesIssued: 0, workInvoicesReceived: 0 });

  const tiles = `
    <div class="report-tiles acc-tiles">
      <div class="report-tile tile-gray" data-tip="Сколько компаний активны (is_active) — по выбранному бухгалтеру или по всем. Из ${agg.total} компаний в реестре OB, закреплённых за бухгалтером(ами). Мусорные названия не считаются."><span class="tile-label">Компаний активных</span>
        <span class="tile-value">${agg.active}</span><span class="tile-sub">из ${agg.total} в реестре</span></div>
      <div class="report-tile tile-green" data-tip="Сколько компаний имеют хотя бы одну реальную операцию в выгрузке Артёма (сданный отчёт или выставленный/полученный счёт). Работа берётся по company_id (ArmSoft) и ИНН (TaxService)."><span class="tile-label">С работой в выгрузке</span>
        <span class="tile-value">${agg.withWork}</span><span class="tile-sub">есть реальные задачи Артёма</span></div>
      <div class="report-tile tile-blue" data-tip="Сумма сданных налоговых отчётов (форм) по всем компаниям — из налоговой активности выгрузки Артёма (reports_submitted)."><span class="tile-label">Сдано отчётов</span>
        <span class="tile-value">${fmtNum(agg.workReports)}</span><span class="tile-sub">налоговые формы</span></div>
      <div class="report-tile tile-blue" data-tip="Сумма счетов: выставленные / полученные. Считаются вместе счета ArmSoft и налоговые э-счета TaxService (invoices_issued/received + tax_invoices_issued/received)."><span class="tile-label">Счета (выст. / получ.)</span>
        <span class="tile-value">${fmtNum(agg.workInvoicesIssued)} / ${fmtNum(agg.workInvoicesReceived)}</span><span class="tile-sub">ArmSoft + TaxService</span></div>
    </div>`;

  const filters = `<div class="filters"><div class="filter-grid">
    <label>Бухгалтер
      <select id="acc-select">
        <option value="">Все бухгалтеры (${accs.length})</option>
        ${accs.map((a) => `<option ${f.accountant === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
      </select>
    </label>
    <label>Выгрузка
      <select id="acc-presence">
        <option value="" ${f.presence === '' ? 'selected' : ''}>Все</option>
        <option value="no_tax" ${f.presence === 'no_tax' ? 'selected' : ''}>Только без выгрузки в TaxService</option>
        <option value="no_arm" ${f.presence === 'no_arm' ? 'selected' : ''}>Только без выгрузки в ArmSoft</option>
        <option value="in_tax" ${f.presence === 'in_tax' ? 'selected' : ''}>Только с выгрузкой в TaxService</option>
        <option value="in_arm" ${f.presence === 'in_arm' ? 'selected' : ''}>Только с выгрузкой в ArmSoft</option>
      </select>
    </label>
    <label class="filter-search">Поиск
      <input type="search" id="acc-search" placeholder="Компания, ՀՎՀՀ, договор…" value="${esc(f.search)}">
    </label>
  </div>
  <div class="filter-checks">
    <label><input type="checkbox" id="acc-active" ${f.activeOnly ? 'checked' : ''}> Только активные клиенты</label>
    <label><input type="checkbox" id="acc-work" ${f.workOnly ? 'checked' : ''}> Только с работой в выгрузке</label>
  </div></div>`;

  const total = rows.length;
  const slice = rows.slice(0, state.accShown);
  const list = slice.length
    ? `<div class="acc-list">${slice.map((r) => accCompanyCard(r, !f.accountant)).join('')}</div>`
    : '<p class="empty">Нет компаний по выбранным фильтрам</p>';
  const more = total > slice.length
    ? `<button class="btn btn-more" id="acc-more">Показать ещё (${total - slice.length})</button>` : '';
  const count = `<p class="muted">Показано компаний: <b>${slice.length}</b> из ${total}${f.accountant ? '' : ` · бухгалтеров: ${accs.length}`}</p>`;

  body.innerHTML = tiles + filters + count + list + more;
  bindAccountantActions(body);
}

function bindAccountantActions(container) {
  const rerender = () => renderAccountants();
  const selEl = container.querySelector('#acc-select');
  if (selEl) selEl.addEventListener('change', () => { state.accFilter.accountant = selEl.value; state.accShown = 60; rerender(); });
  const actEl = container.querySelector('#acc-active');
  if (actEl) actEl.addEventListener('change', () => { state.accFilter.activeOnly = actEl.checked; state.accShown = 60; rerender(); });
  const workEl = container.querySelector('#acc-work');
  if (workEl) workEl.addEventListener('change', () => { state.accFilter.workOnly = workEl.checked; state.accShown = 60; rerender(); });
  const presEl = container.querySelector('#acc-presence');
  if (presEl) presEl.addEventListener('change', () => { state.accFilter.presence = presEl.value; state.accShown = 60; rerender(); });
  const moreEl = container.querySelector('#acc-more');
  if (moreEl) moreEl.addEventListener('click', () => { state.accShown += 60; rerender(); });
  const srchEl = container.querySelector('#acc-search');
  if (srchEl) srchEl.addEventListener('input', () => {
    state.accFilter.search = srchEl.value;
    state.accShown = 60;
    const pos = srchEl.selectionStart;
    rerender();
    const s2 = $('#acc-search');
    if (s2) { s2.focus(); s2.setSelectionRange(pos, pos); }
  });
  container.querySelectorAll('.acc-drill').forEach((btn) => {
    btn.addEventListener('click', () => toggleAccFeed(btn.dataset.accKey,
      btn.dataset.arm ? Number(btn.dataset.arm) : null, btn.dataset.tin || null));
  });
}

/** Раскрыть/свернуть список задач компании; при первом раскрытии — загрузка RPC */
async function toggleAccFeed(key, armId, tin) {
  if (state.accExpanded.has(key)) {
    state.accExpanded.delete(key);
    renderAccountants();
    return;
  }
  state.accExpanded.add(key);
  if (!state.accFeed.has(key)) {
    state.accFeed.set(key, { loading: true, rows: [] });
    renderAccountants();
    try {
      const rows = await fetchCompanyTaskFeed(armId, tin, 300);
      state.accFeed.set(key, { loading: false, rows });
    } catch (e) {
      console.error(e);
      state.accFeed.set(key, { loading: false, error: e.message, rows: [] });
    }
  }
  renderAccountants();
}

/* ================= Отчёт по дням (один бухгалтер) ========================= */
/* Хронология по дням: что бухгалтер сделал за день по выгрузке Артёма
 * (по типам услуг) × хронометраж = сколько времени; + обратная связь
 * бухгалтера (подтверждение цифр, комментарий к каждой цифре, работа помимо
 * учтённого времени). Работа за день = отчёт системы + комментарий бухгалтера. */

/** extra_work [{desc,minutes}] → текст «описание | минуты» построчно (для textarea) */
function formatExtraWork(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map((w) => `${w.desc || ''} | ${w.minutes || 0}`).join('\n');
}
/** Обратный разбор textarea в extra_work [{desc,minutes}] (пустые строки пропускаем) */
function parseExtraWork(text) {
  return String(text || '').split('\n').map((line) => {
    const t = line.trim();
    if (!t) return null;
    const i = t.lastIndexOf('|');
    if (i < 0) return { desc: t, minutes: 0 };
    const desc = t.slice(0, i).trim();
    const minutes = parseInt(t.slice(i + 1).replace(/[^0-9]/g, ''), 10) || 0;
    return desc ? { desc, minutes } : null;
  }).filter(Boolean);
}

/** Загрузка данных страницы для выбранного бухгалтера (ленивая, тяжёлый RPC) */
async function loadDailyReport(accountant) {
  const d = state.daily;
  d.accountant = accountant;
  d.loading = true;
  d.error = null;
  d.report = null;
  d.shown = 14;
  d.expanded = new Set();
  d.feed = new Map();
  d.letter = '';
  renderDaily();
  try {
    if (!state.accCompare) state.accCompare = computeAccountantComparison(state.src);
    const bridge = accountantBridge(state.accCompare.rows, accountant);
    d.bridge = bridge;
    const [activity, dayReports] = await Promise.all([
      fetchAccountantDailyActivity(bridge.armIds, bridge.tins),
      loadDayReports(accountant),
    ]);
    d.activity = activity;
    d.reportsByDate = new Map(dayReports.map((r) => [String(r.report_date).slice(0, 10), r]));
    d.report = buildDailyReport(activity, CHRONO);
  } catch (e) {
    console.error(e);
    d.error = e.message;
  } finally {
    d.loading = false;
    renderDaily();
  }
}

/** Слитый день (отчёт Артёма + сохранённая обратная связь) */
function dailyMergedDay(day) {
  return mergeAccountantFeedback(day, state.daily.reportsByDate.get(day.date) || null);
}

/** Одна строка услуги внутри дня (цифра Артёма + поля обратной связи) */
function dailyMetricRow(m, date, notes) {
  const st = SERVICE_TYPES[m.category] || { label: m.category, icon: '•', unit: 'шт' };
  const note = notes[m.category] || {};
  const key = `${date}|${m.category}`;
  const feed = state.daily.feed.get(key);
  const expanded = state.daily.expanded.has(key);
  const disputed = !!note.disputed;
  const accCount = note.accountant_count;
  return `<div class="dr-metric${disputed ? ' dr-metric-disp' : ''}">
    <div class="dr-metric-main">
      <span class="dr-metric-name" data-tip="Тип услуги из выгрузки Артёма (${esc(st.system || '—')}). Количество за день × норматив ${m.minutesPerUnit} мин = время по хронометражу. Норматив меняется одним числом в config.js → CHRONO.minutesPerUnit.">${st.icon} ${esc(st.label)}</span>
      <span class="dr-metric-nums">
        <b class="dr-count">${m.count}</b> ${esc(st.unit)}${m.count === 1 ? '' : 'а/ов'}
        <span class="muted">× ${m.minutesPerUnit} мин = <b>${fmtMinutes(m.minutes)}</b></span>
      </span>
      <button class="btn btn-sm dr-drill" data-day-drill data-date="${date}" data-cat="${m.category}">
        ${expanded ? '▾ скрыть' : '▸ показать за что'}</button>
    </div>
    <div class="dr-metric-fb">
      <label class="dr-disp"><input type="checkbox" data-metric-disputed data-cat="${m.category}" ${disputed ? 'checked' : ''}> цифра неверна</label>
      <input type="number" class="dr-acccount" min="0" placeholder="верная цифра" value="${accCount != null ? accCount : ''}" data-metric-count data-cat="${m.category}">
      <input type="text" class="dr-metric-comment" placeholder="комментарий к этой цифре…" value="${esc(note.comment || '')}" data-metric-comment data-cat="${m.category}">
    </div>
    ${expanded ? `<div class="dr-feed">${
      !feed || feed.loading ? '<p class="muted">Загрузка документов…</p>'
      : feed.error ? `<p class="red">Ошибка: ${esc(feed.error)}</p>`
      : !feed.rows.length ? '<p class="muted">Документов не найдено.</p>'
      : `<div class="dr-feed-head">${feed.rows.length}${feed.rows.length >= 400 ? '+, первые' : ''} документ(ов):</div>`
        + feed.rows.map(dailyFeedLine).join('')
    }</div>` : ''}
  </div>`;
}

/** Строка одного документа в drill'е дня */
function dailyFeedLine(t) {
  const money = fmtMoney(t.amount, t.currency);
  const comp = t.company ? `<span class="dr-feed-comp">${esc(t.company)}</span>` : '';
  const detail = t.detail ? ` — ${esc(t.detail)}` : '';
  const sum = money ? ` <b class="task-sum">${money}</b>` : '';
  const stt = t.status ? ` <span class="task-st">${esc(t.status)}</span>` : '';
  return `<div class="dr-feed-line task-${t.system === 'ArmSoft' ? 'arm' : 'tax'}">
    ${comp}<span class="task-body">${esc(t.title)}${detail}${sum}${stt}</span>
  </div>`;
}

/** Карточка одного дня */
function dailyDayCard(day) {
  const md = dailyMergedDay(day);
  const stMeta = DAY_REPORT_STATUSES[md.status] || DAY_REPORT_STATUSES.pending;
  const notes = md.metricNotes || {};
  const fb = md.feedback;
  return `<div class="day-card" id="day-${day.date}">
    <div class="day-head">
      <div class="day-date">${fmtDate(day.date)}
        <span class="badge badge-${stMeta.color}">${stMeta.label}</span></div>
      <div class="day-total" data-tip="Суммарное время за день по хронометражу = сумма (количество × норматив) по всем услугам этого дня. В скобках — общее число действий за день.">по отчёту Артёма: <b>${fmtHours(day.totalMinutes)}</b>
        <span class="muted">(${day.totalCount} действ.)</span></div>
    </div>

    <div class="dr-metrics">${day.metrics.map((m) => dailyMetricRow(m, day.date, notes)).join('')}</div>

    <div class="dr-sum" data-tip="Итог времени по выгрузке Артёма за день (без правок бухгалтера). = сумма минут по всем услугам выше.">Итого по отчёту системы (Артём): <b>${fmtHours(day.totalMinutes)}</b>
      <span class="muted">= ${fmtMinutes(day.totalMinutes)}</span></div>

    <div class="dr-feedback">
      <label class="dr-confirm"><input type="checkbox" data-day-confirm ${md.countsConfirmed ? 'checked' : ''}>
        Подтверждаю цифры Артёма (кол-во компаний, счетов, отчётов)</label>

      <label class="dr-extra-label">Что делал помимо учтённого времени — по строке на действие,
        формат «описание | минуты»:</label>
      <textarea class="dr-extra" data-day-extra rows="3"
        placeholder="Например: консультация клиента по НДС | 30">${esc(formatExtraWork(md.extraWork))}</textarea>

      <label class="dr-extra-label">Общий комментарий бухгалтера за день:</label>
      <textarea class="dr-comment" data-day-comment rows="2"
        placeholder="Свободный комментарий…">${esc(fb && fb.accountant_comment || '')}</textarea>

      <div class="dr-grand" data-tip="Итог времени с учётом бухгалтера = время по выгрузке Артёма + минуты, которые бухгалтер дописал в блоке «что делал помимо учтённого времени» (формат «описание | минуты»).">Итого с учётом комментариев бухгалтера:
        <b>${fmtHours(md.grandTotalMinutes)}</b>
        <span class="muted">(отчёт Артёма ${fmtMinutes(day.totalMinutes)} + дописано ${fmtMinutes(md.extraMinutes)})</span></div>

      <div class="dr-actions">
        <label>Статус:
          <select data-day-status>
            ${Object.entries(DAY_REPORT_STATUSES).map(([k, v]) =>
              `<option value="${k}" ${md.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
        </label>
        <button class="btn btn-primary btn-sm" data-day-save data-date="${day.date}">Сохранить день</button>
        ${fb && fb.confirmed_at ? `<span class="muted">сохранено ${fmtDateTime(fb.updated_at || fb.confirmed_at)}</span>` : ''}
      </div>
    </div>
  </div>`;
}

/** Полный рендер страницы «Отчёт по дням» */
function renderDaily() {
  const body = $('#daily-body');
  if (!body) return;
  const d = state.daily;

  const accs = state.accCompare
    ? state.accCompare.byAccountant.map((a) => a.accountant)
    : [];
  const selVal = d.accountant || DAILY_REPORT.defaultAccountant;

  const chronoNote = CHRONO.isDraft
    ? `<div class="dr-chrono-warn">⚠ Хронометраж — <b>${esc(CHRONO.source)}</b>.
        Значения времени условны, пока Гарри не пришлёт эксель с реальными нормативами
        (тогда правим <code>config.js → CHRONO.minutesPerUnit</code>, страница пересчитается сама).</div>`
    : `<div class="dr-chrono-src">Хронометраж по модели: <b>${esc(CHRONO.source)}</b>.
        Норматив на услугу — <code>config.js → CHRONO.minutesPerUnit</code>.</div>`;

  const header = `
    <div class="dr-explain">Мы считаем сделанной за день работой <b>только</b> то, что видно в
      выгрузке Артёма (отчёт системы), плюс то, что бухгалтер добавил в комментарии. Именно этот
      объём и будет учтён.</div>
    ${chronoNote}
    <div class="filters"><div class="filter-grid">
      <label>Бухгалтер
        <select id="daily-accountant">
          ${accs.map((a) => `<option ${a === selVal ? 'selected' : ''}>${esc(a)}</option>`).join('')}
        </select>
      </label>
    </div></div>`;

  if (d.loading) { body.innerHTML = header + '<p class="empty">Загрузка дневного отчёта…</p>'; bindDailyStatic(body); return; }
  if (d.error) { body.innerHTML = header + `<p class="empty red">Ошибка: ${esc(d.error)}</p>`; bindDailyStatic(body); return; }
  if (!d.report) { body.innerHTML = header + '<p class="empty">Нет данных.</p>'; bindDailyStatic(body); return; }

  const rep = d.report;
  const b = d.bridge || { companyCount: 0, activeCount: 0, withWorkCount: 0 };

  // сколько дней уже согласовано бухгалтером
  const confirmedDays = [...d.reportsByDate.values()].filter((r) => r.status === 'confirmed').length;

  const tiles = `<div class="report-tiles acc-tiles">
    <div class="report-tile tile-gray" data-tip="Сколько активных компаний закреплено за этим бухгалтером в реестре OB; в скобках — у скольких из них есть работа в выгрузке Артёма."><span class="tile-label">Компаний у бухгалтера</span>
      <span class="tile-value">${b.activeCount}</span><span class="tile-sub">${b.withWorkCount} с работой в выгрузке</span></div>
    <div class="report-tile tile-blue" data-tip="За сколько отдельных дней в выгрузке Артёма есть хоть одна операция этого бухгалтера (окно — последние 30 дней активности)."><span class="tile-label">Дней с работой</span>
      <span class="tile-value">${rep.dayCount}</span><span class="tile-sub">в выгрузке Артёма</span></div>
    <div class="report-tile tile-blue" data-tip="Сумма всех действий за период: сданные отчёты + выставленные/полученные счета (ArmSoft и TaxService)."><span class="tile-label">Действий всего</span>
      <span class="tile-value">${fmtNum(rep.totalCount)}</span><span class="tile-sub">счета, отчёты и т.д.</span></div>
    <div class="report-tile tile-green" data-tip="Оценка отработанного времени = Σ(количество услуг × норматив минут на услугу). Норматив из хронометража Гарри (config.js → CHRONO.minutesPerUnit): счёт 7,8 мин, сданный отчёт 180 мин."><span class="tile-label">Времени по хронометражу</span>
      <span class="tile-value">${fmtHours(rep.totalMinutes)}</span><span class="tile-sub">за весь период</span></div>
    <div class="report-tile tile-${confirmedDays ? 'green' : 'yellow'}" data-tip="Сколько дней бухгалтер уже подтвердил (статус «Подтверждено бухгалтером») из общего числа дней с работой."><span class="tile-label">Дней подтверждено</span>
      <span class="tile-value">${confirmedDays}</span><span class="tile-sub">из ${rep.dayCount}</span></div>
  </div>`;

  const letterBox = `<div class="toolbar">
      <button class="btn btn-primary" data-daily-letter>Письмо Артёму: что не выгрузилось</button>
    </div>
    ${d.letter ? `<div class="message-box">
      <textarea id="daily-letter" rows="12" readonly>${esc(d.letter)}</textarea>
      <button class="btn btn-primary" data-copy-letter>Скопировать</button>
    </div>` : ''}`;

  const shown = rep.days.slice(0, d.shown);
  const list = shown.length
    ? `<div class="day-list">${shown.map(dailyDayCard).join('')}</div>`
    : '<p class="empty">У этого бухгалтера нет работы в выгрузке Артёма (нет привязок company_id/ИНН).</p>';
  const more = rep.days.length > shown.length
    ? `<button class="btn btn-more" data-daily-more>Показать ещё дни (${rep.days.length - shown.length})</button>` : '';

  body.innerHTML = header + tiles + letterBox
    + `<h3 class="block-title" data-tip="По каждому дню: отчёт Артёма по типам услуг и время по хронометражу, итог времени, подтверждение и комментарии бухгалтера (в т.ч. к каждой цифре), итог с учётом комментариев. Плашка — число дней с работой.">Хронология по дням <span class="count-pill">${rep.dayCount}</span></h3>`
    + `<p class="hint">Для каждого дня: отчёт Артёма по типам услуг и время по хронометражу; итог времени;
        подтверждение и комментарии бухгалтера (в т.ч. к каждой цифре); итог с учётом комментариев.</p>`
    + list + more;

  bindDailyStatic(body);
  bindDailyDelegated(body);
}

/** Слушатели, которые нужно навесить при каждом полном рендере (селект/статик) */
function bindDailyStatic(container) {
  const sel = container.querySelector('#daily-accountant');
  if (sel) sel.addEventListener('change', () => loadDailyReport(sel.value));
}

/** Делегированные действия страницы (навешиваются один раз на #daily-body) */
function bindDailyDelegated(container) {
  if (container._daily_bound) return;
  container._daily_bound = true;

  container.addEventListener('click', async (e) => {
    const more = e.target.closest('[data-daily-more]');
    if (more) { state.daily.shown += 14; renderDaily(); return; }

    const letterBtn = e.target.closest('[data-daily-letter]');
    if (letterBtn) { generateAccountantExportLetter(); return; }

    const copyBtn = e.target.closest('[data-copy-letter]');
    if (copyBtn) {
      const ta = $('#daily-letter');
      try { await navigator.clipboard.writeText(ta.value); toast('Скопировано ✓'); }
      catch { ta.select(); document.execCommand('copy'); toast('Скопировано ✓'); }
      return;
    }

    const drill = e.target.closest('[data-day-drill]');
    if (drill) { toggleDailyFeed(drill.dataset.date, drill.dataset.cat); return; }

    const save = e.target.closest('[data-day-save]');
    if (save) { saveDailyDay(save.dataset.date); return; }
  });
}

/** Раскрыть/свернуть список документов за день+услугу (drill), с ленивой загрузкой */
async function toggleDailyFeed(date, category) {
  const d = state.daily;
  const key = `${date}|${category}`;
  if (d.expanded.has(key)) { d.expanded.delete(key); rerenderDayCard(date); return; }
  d.expanded.add(key);
  if (!d.feed.has(key)) {
    d.feed.set(key, { loading: true, rows: [] });
    rerenderDayCard(date);
    try {
      const rows = await fetchAccountantDayFeed(d.bridge.armIds, d.bridge.tins, date, category, 400);
      d.feed.set(key, { loading: false, rows });
    } catch (e) {
      d.feed.set(key, { loading: false, error: e.message, rows: [] });
    }
  }
  rerenderDayCard(date);
}

/** Перерисовать одну карточку дня (не трогая остальные — сохраняет их правки) */
function rerenderDayCard(date) {
  const el = document.getElementById('day-' + date);
  if (!el) return;
  const day = state.daily.report.days.find((x) => x.date === date);
  if (!day) return;
  el.outerHTML = dailyDayCard(day);
}

/** Собрать правки одной карточки и сохранить обратную связь бухгалтера */
async function saveDailyDay(date) {
  const card = document.getElementById('day-' + date);
  if (!card) return;
  const d = state.daily;
  const day = d.report.days.find((x) => x.date === date);

  const metric_notes = {};
  card.querySelectorAll('[data-metric-comment]').forEach((el) => {
    const cat = el.dataset.cat;
    metric_notes[cat] = metric_notes[cat] || {};
    if (el.value.trim()) metric_notes[cat].comment = el.value.trim();
  });
  card.querySelectorAll('[data-metric-count]').forEach((el) => {
    const cat = el.dataset.cat;
    if (el.value !== '') { metric_notes[cat] = metric_notes[cat] || {}; metric_notes[cat].accountant_count = parseInt(el.value, 10); }
  });
  card.querySelectorAll('[data-metric-disputed]').forEach((el) => {
    const cat = el.dataset.cat;
    if (el.checked) { metric_notes[cat] = metric_notes[cat] || {}; metric_notes[cat].disputed = true; }
  });
  // убираем пустые записи
  Object.keys(metric_notes).forEach((k) => { if (!Object.keys(metric_notes[k]).length) delete metric_notes[k]; });

  const extra_work = parseExtraWork(card.querySelector('[data-day-extra]').value);
  const status = card.querySelector('[data-day-status]').value;
  const row = {
    accountant_name: d.accountant,
    report_date: date,
    status,
    counts_confirmed: card.querySelector('[data-day-confirm]').checked,
    accountant_comment: card.querySelector('[data-day-comment]').value.trim() || null,
    metric_notes,
    extra_work,
    export_minutes: day ? day.totalMinutes : null,
    confirmed_at: status === 'confirmed' ? new Date().toISOString() : null,
  };
  try {
    const saved = await saveDayReport(row);
    d.reportsByDate.set(date, saved);
    toast('День сохранён ✓');
    rerenderDayCard(date);
  } catch (e) {
    toast('Ошибка сохранения: ' + e.message, true);
  }
}

/** Письмо Артёму: всё, что по этому бухгалтеру НЕ выгрузилось / отмечено спорным */
function generateAccountantExportLetter() {
  const d = state.daily;
  const b = d.bridge;
  if (!b) { toast('Сначала выберите бухгалтера', true); return; }

  // A. Активные компании бухгалтера без данных в выгрузке
  const active = b.companies.filter((c) => c.is_active);
  const noExport = active.filter((c) => !c.in_taxservice && !c.in_armsoft);
  const noWork = active.filter((c) => (c.in_taxservice || c.in_armsoft) && !c.has_work);

  // B. Цифры/дни, которые бухгалтер отметил как спорные (обратная связь)
  const disputed = [];
  for (const [date, fb] of d.reportsByDate) {
    const notes = fb.metric_notes || {};
    for (const [cat, n] of Object.entries(notes)) {
      if (n && n.disputed) {
        const st = SERVICE_TYPES[cat] || { label: cat };
        disputed.push({ date, label: st.label, comment: n.comment || '', acc: n.accountant_count });
      }
    }
  }

  const L = [];
  L.push('Привет, Артём!');
  L.push('');
  L.push(`Мы сверяем твою выгрузку по бухгалтеру «${b.accountant}» с фактической работой.`);
  L.push('Ниже — то, что в выгрузку не попало или вызывает вопросы. Прошу проверить.');
  L.push('');

  L.push(`1) Активные компании без данных в выгрузке (ни в TaxService, ни в ArmSoft) — ${noExport.length} шт.:`);
  if (noExport.length) noExport.forEach((c, i) =>
    L.push(`   ${i + 1}. «${c.company_name}»${c.hvhh ? ` · ՀՎՀՀ ${c.hvhh}` : ''}${c.contract_number ? ` · договор ${c.contract_number}` : ''}`));
  else L.push('   — нет');
  L.push('');

  L.push(`2) Компании есть в выгрузке, но по ним нет ни одной операции (работа не выгрузилась) — ${noWork.length} шт.:`);
  if (noWork.length) noWork.forEach((c, i) =>
    L.push(`   ${i + 1}. «${c.company_name}»${c.hvhh ? ` · ՀՎՀՀ ${c.hvhh}` : ''} · где есть: ${[c.in_taxservice ? 'TaxService' : null, c.in_armsoft ? 'ArmSoft' : null].filter(Boolean).join(', ')}`));
  else L.push('   — нет');
  L.push('');

  L.push(`3) Цифры, которые бухгалтер отметил как неверные/неполные — ${disputed.length} шт.:`);
  if (disputed.length) disputed.forEach((x, i) =>
    L.push(`   ${i + 1}. ${fmtDate(x.date)} · ${x.label}${x.acc != null ? ` · по мнению бухгалтера: ${x.acc}` : ''}${x.comment ? ` · «${x.comment}»` : ''}`));
  else L.push('   — нет (бухгалтер пока не отмечал расхождений)');
  L.push('');
  L.push('Что нужно: проверить, почему это не попало в выгрузку, и добавить в следующий экспорт');
  L.push('или объяснить, почему этих данных быть не должно. Спасибо!');

  d.letter = L.join('\n');
  renderDaily();
  toast('Письмо сформировано ✓');
}

/* ----------------------------- 5. Встречи --------------------------------- */
function renderMeetings() {
  if (!state.src) return;
  const { comments } = state.src;
  const { taxIndex, armIndex } = state._indexes;
  const f = state.filters;
  // «в выгрузке Артёма» = найдено в налоговой ИЛИ ArmSoft-выгрузке (точно, не fuzzy)
  const inExport = (name) => {
    const tm = findMatch(taxIndex, { hvhh: null, names: [name] });
    const arm = findMatch(armIndex, { hvhh: null, names: [name] });
    return (tm.found && tm.quality !== 'fuzzy') || (arm.found && arm.quality !== 'fuzzy');
  };

  let rows = comments.slice().sort((a, b) => (a.comment_date < b.comment_date ? 1 : -1));
  if (f.date) rows = rows.filter((c) => c.comment_date === f.date);
  if (f.accountant) rows = rows.filter((c) => (c.accountant_name || '') === f.accountant);
  if (f.search) rows = rows.filter((c) => `${c.company_name || ''} ${c.accountant_name || ''}`.toLowerCase().includes(f.search.toLowerCase()));

  // группировка: дата → бухгалтер → компании
  const byDate = new Map();
  for (const c of rows) {
    if (!byDate.has(c.comment_date)) byDate.set(c.comment_date, new Map());
    const byAcc = byDate.get(c.comment_date);
    const acc = c.accountant_name || c.accountant_email || 'Без имени';
    if (!byAcc.has(acc)) byAcc.set(acc, []);
    byAcc.get(acc).push(c);
  }

  const html = [...byDate.entries()].map(([date, byAcc]) => `
    <div class="meeting-day">
      <h3 class="block-title">Встреча ${fmtDate(date)}</h3>
      ${[...byAcc.entries()].map(([acc, list]) => {
        const missing = list.filter((c) => !inExport(c.company_name));
        return `<div class="item-card">
          <div class="item-head">
            <strong>${esc(acc)}</strong>
            <span class="badge ${missing.length ? 'badge-red' : 'badge-green'}" data-tip="Сколько компаний, упомянутых этим бухгалтером, НЕ подтверждены точным совпадением названия в выгрузке (ни в TaxService, ни в ArmSoft). Неточное совпадение (≈) показывается у компании, но как присутствие не засчитывается — такая компания тоже попадает в «нет в выгрузке».">
              ${missing.length ? `${missing.length} нет в выгрузке` : 'всё в выгрузке'}
            </span>
          </div>
          ${list.map((c) => {
            const tm = findMatch(taxIndex, { hvhh: null, names: [c.company_name] });
            const arm = findMatch(armIndex, { hvhh: null, names: [c.company_name] });
            const chip = (m, label) => `<span class="chip ${m.found ? (m.quality === 'fuzzy' ? 'chip-fuzzy' : 'chip-yes') : 'chip-no'}">${m.found ? (m.quality === 'fuzzy' ? '≈' : '✓') : '✗'} ${label}</span>`;
            return `<div class="meeting-row">
              <div class="meeting-company" data-tip="Компания, упомянутая на встрече. Чипы: ✓ — найдена в выгрузке этой системы, ≈ — неточное совпадение названия, ✗ — не найдена."><b>${esc(c.company_name)}</b>
                ${chip(tm, 'TaxService')}${chip(arm, 'ArmSoft')}
              </div>
              <div class="muted">${esc(c.comment || '')}</div>
              ${c.unaccounted_work ? `<div class="item-comment">(!) Не отражено: ${esc(c.unaccounted_work)}</div>` : ''}
            </div>`;
          }).join('')}
        </div>`;
      }).join('')}
    </div>`).join('');

  $('#meetings-list').innerHTML = html || '<p class="empty">Нет данных встреч за выбранный период</p>';
}

/* ---------------------- Утренние созвоны (анализ) ------------------------- */
/**
 * Загрузка данных страницы «Утренние созвоны»: по каждому бухгалтеру, который
 * есть в утренних комментариях, тянем фактическую активность из выгрузки Артёма
 * (RPC ob_accountant_daily_activity) за диапазон дат созвонов (со сдвигом
 * MORNING_CALLS.actualsDayOffset). Ленивая, вызывается при открытии вкладки.
 */
async function loadMorningCalls() {
  const c = state.calls;
  if (c.loaded || c.loading) return;
  c.loading = true;
  c.error = null;
  renderCalls();
  try {
    if (!state.accCompare) state.accCompare = computeAccountantComparison(state.src);
    const comments = state.src.comments || [];
    const offset = MORNING_CALLS.actualsDayOffset || 0;
    const bridges = new Map();
    const activityByAccountant = new Map();

    const accountants = [...new Set(
      comments.map((x) => x.accountant_name || x.accountant_email || 'Без имени'),
    )];

    if (comments.length) {
      const { from, to } = mcActualDateRange(comments, offset);
      await Promise.all(accountants.map(async (acc) => {
        const bridge = accountantBridge(state.accCompare.rows, acc);
        bridges.set(acc, bridge);
        if (!bridge.armIds.length && !bridge.tins.length) {
          activityByAccountant.set(acc, []);
          return;
        }
        try {
          // ПОЛНАЯ активность по всем 26 категориям выгрузки Артёма
          // (счета/накладные/касса/сверки/проводки/НДС/зарплата/ЕАЭС/пени…).
          const rows = await fetchAccountantActivityFull(bridge.armIds, bridge.tins, from, to);
          activityByAccountant.set(acc, rows);
        } catch (e) {
          console.error('Активность бухгалтера', acc, e);
          activityByAccountant.set(acc, []);
        }
      }));
    }

    c.bridges = bridges;
    c.data = buildMorningCalls(comments, activityByAccountant, offset);
    // блок «анализ» открыт/свёрнут по умолчанию из конфигурации
    if (!MORNING_CALLS.analysisOpenByDefault) {
      c.data.days.forEach((d) => c.analysisHidden.add(d.date));
    }
    c.loaded = true;
  } catch (e) {
    console.error(e);
    c.error = e.message;
  } finally {
    c.loading = false;
    renderCalls();
  }
}

/** Короткий текстовый вывод анализа дня «сказано ↔ факт выгрузки Артёма» */
function callAnalysisText(day) {
  const a = day.analysis;
  const offset = MORNING_CALLS.actualsDayOffset || 0;
  const when = offset
    ? `за ${fmtDate(day.actualDate)} (работа накануне созвона)`
    : `за ${fmtDate(day.date)}`;
  const parts = [];
  parts.push(`Отчитались ${a.accountantCount} бухгалтер(ов) по ${a.companyCount} компани(ям).`);
  parts.push(`По выгрузке Артёма ${when}: ${fmtNum(a.fullActualTotal)} операций в ${a.categoriesUsed} раздел(ах) `
    + `(в т.ч. ${fmtNum(a.reportCount)} сданных отчётов, ${fmtNum(a.taxTotal)} операций TaxService и ${fmtNum(a.armTotal)} операций ArmSoft).`);
  parts.push(`Разобрано слов созвона: ${a.claimTotal} — ✓ ${a.claimConfirmed} подтверждено, `
    + `✗ ${a.claimMissing} нет в выгрузке, ◌ ${a.claimStructural} вне выгрузки, ? ${a.claimUnclassified} не распознано.`);
  if (a.claimMissing > 0) {
    parts.push(`⚠ ${a.claimMissing} задач(и) со слов бухгалтеров не подтверждаются выгрузкой — стоит проверить.`);
  }
  if (a.unmentionedTotal > 0) {
    parts.push(`🔎 В выгрузке ${when} есть ${fmtNum(a.unmentionedTotal)} операций, о которых на созвоне не сказали.`);
  }
  return parts.join(' ');
}

/** Строка одной цифры факта (услуга → количество) */
function mcMetricLine(label, n) {
  return `<div class="mc-metric${n ? '' : ' mc-metric-zero'}"><span>${label}</span><b>${fmtNum(n)}</b></div>`;
}

/** Блок drill «показать за что» (ленивая загрузка документов) для одной системы */
function callFeedBlock(key) {
  const c = state.calls;
  if (!c.expandedFeed.has(key)) return '';
  const feed = c.feed.get(key);
  let inner;
  if (!feed || feed.loading) inner = '<p class="muted">Загрузка документов…</p>';
  else if (feed.error) inner = `<p class="red">Ошибка: ${esc(feed.error)}</p>`;
  else if (!feed.rows.length) inner = '<p class="muted">Документов не найдено.</p>';
  else inner = `<div class="dr-feed-head">${feed.rows.length}${feed.rows.length >= 400 ? '+' : ''} документ(ов):</div>`
    + feed.rows.map(dailyFeedLine).join('');
  return `<div class="dr-feed mc-feed">${inner}</div>`;
}

/** Вердикт одного слова/задачи созвона → значок, подпись, цвет */
const MC_CLAIM_VERDICTS = {
  confirmed:    { icon: '✓', label: 'подтверждено в выгрузке', cls: 'mc-claim-ok' },
  missing:      { icon: '✗', label: 'сказал — нет в выгрузке', cls: 'mc-claim-miss' },
  not_in_export:{ icon: '◌', label: 'вне выгрузки (ожидаемо)', cls: 'mc-claim-struct' },
  no_source:    { icon: '≈', label: 'нет отдельного раздела в выгрузке', cls: 'mc-claim-nosrc' },
  unclassified: { icon: '?', label: 'не распознано — проверить вручную', cls: 'mc-claim-unk' },
};

/** Значок+подпись категории выгрузки (из MC_CATEGORIES) */
function mcCatLabel(key) {
  const c = MC_CATEGORIES[key];
  return c ? `${c.icon} ${c.label}` : key;
}

/** Одна строка «слово бухгалтера ↔ факт в выгрузке» */
function mcClaimRow(day, acc, claim, i) {
  const v = MC_CLAIM_VERDICTS[claim.verdict] || MC_CLAIM_VERDICTS.unclassified;
  // категории, по которым есть факт (кликабельны — drill за конкретными документами)
  const matched = (claim.matchedCats || []).map((cat) => {
    const key = `${day.date}|${acc.accountant}|${cat}`;
    const n = (acc.fullCats.find((f) => f.category === cat) || {}).count || 0;
    return `<button class="mc-cat-chip mc-cat-ok mc-drill" data-mc-drill="${esc(key)}" title="показать документы">${mcCatLabel(cat)} · ${fmtNum(n)}${c_isFeedOpen(key) ? ' ▾' : ''}</button>`;
  }).join('');
  // распознанные категории без факта (сказал, но в выгрузке за день нет)
  const missing = (claim.measurableCats || []).filter((c) => !(claim.matchedCats || []).includes(c))
    .map((cat) => `<span class="mc-cat-chip mc-cat-miss">${mcCatLabel(cat)} · 0</span>`).join('');
  // прочие распознанные категории без таблицы-счётчика (заявления и т.п.)
  const other = (claim.categories || []).filter((c) => MC_CATEGORIES[c] && !MC_CATEGORIES[c].measurable)
    .map((cat) => `<span class="mc-cat-chip mc-cat-nosrc">${mcCatLabel(cat)}</span>`).join('');
  const feeds = (claim.matchedCats || []).map((cat) => callFeedBlock(`${day.date}|${acc.accountant}|${cat}`)).join('');
  return `<div class="mc-claim ${v.cls}">
    <div class="mc-claim-head">
      <span class="mc-claim-badge">${v.icon}</span>
      <span class="mc-claim-text">${esc(claim.phrase)}</span>
      ${claim.company_name ? `<span class="mc-claim-company">${esc(claim.company_name)}</span>` : ''}
    </div>
    <div class="mc-claim-verdict">${v.label}</div>
    ${(matched || missing || other) ? `<div class="mc-claim-cats">${matched}${missing}${other}</div>` : ''}
    ${feeds}
  </div>`;
}

/** Карточка одного бухгалтера внутри дня созвона (полное сопоставление) */
function callAccountantCard(day, acc) {
  const { taxIndex, armIndex } = state._indexes;
  const chip = (m, label) => `<span class="chip ${m.found ? (m.quality === 'fuzzy' ? 'chip-fuzzy' : 'chip-yes') : 'chip-no'}">${m.found ? (m.quality === 'fuzzy' ? '≈' : '✓') : '✗'} ${label}</span>`;

  // --- 1. Слова бухгалтера, сгруппированные по компании, с company-совпадением
  const said = acc.said.map((s) => {
    const hasName = !!s.company_name;
    const tm = hasName ? findMatch(taxIndex, { hvhh: null, names: [s.company_name] }) : null;
    const arm = hasName ? findMatch(armIndex, { hvhh: null, names: [s.company_name] }) : null;
    return `<div class="mc-said-row">
      <div class="mc-said-company"><b>${esc(s.company_name || '—')}</b>${hasName ? chip(tm, 'TaxService') + chip(arm, 'ArmSoft') : ''}</div>
      ${s.comment ? `<div class="muted">${esc(s.comment)}</div>` : ''}
      ${s.unaccounted ? `<div class="item-comment">(!) не отражено: ${esc(s.unaccounted)}</div>` : ''}
    </div>`;
  }).join('');

  // --- 2. Разбор КАЖДОГО слова ↔ факт по всем категориям выгрузки
  const cs = acc.claimStats;
  const claimSummary = acc.claims.length
    ? `<div class="mc-claim-summary">
        ${cs.confirmed ? `<span class="mc-pill mc-pill-ok" data-tip="Слово распознано и есть факт в выгрузке за день по нужной категории.">✓ ${cs.confirmed} подтв.</span>` : ''}
        ${cs.missing ? `<span class="mc-pill mc-pill-miss" data-tip="Слово названо, категория измеримая, но факта в выгрузке за день по ней нет — стоит проверить.">✗ ${cs.missing} нет в выгрузке</span>` : ''}
        ${cs.structural ? `<span class="mc-pill mc-pill-struct" data-tip="Работа, которую выгрузка структурно не видит: устные согласования, консультации, корректировки прошлых периодов (config.js → MC_STRUCTURAL_PATTERNS).">◌ ${cs.structural} вне выгрузки</span>` : ''}
        ${cs.noSource ? `<span class="mc-pill mc-pill-nosrc" data-tip="Категория распознана, но за ней нет отдельной таблицы-счётчика в выгрузке (например, заявления/ходатайства).">≈ ${cs.noSource} без раздела</span>` : ''}
        ${cs.unclassified ? `<span class="mc-pill mc-pill-unk" data-tip="Слово не удалось отнести ни к одной категории — нужно разобрать вручную и дополнить таксономию config.js → MC_CATEGORIES.">? ${cs.unclassified} не распознано</span>` : ''}
      </div>`
    : '';
  const claims = acc.claims.length
    ? acc.claims.map((c, i) => mcClaimRow(day, acc, c, i)).join('')
    : '<p class="muted">Слов на созвоне не зафиксировано.</p>';

  // --- 3. Полная фактическая работа за день (ВСЕ категории выгрузки Артёма)
  const factRows = acc.fullCats.length
    ? acc.fullCats.map((c) => {
        const key = `${day.date}|${acc.accountant}|${c.category}`;
        return `<button class="mc-fact-row mc-drill" data-mc-drill="${esc(key)}" title="показать документы">
          <span class="mc-fact-label">${c.icon} ${esc(c.label)} <em>${c.system}</em></span>
          <b>${fmtNum(c.count)}</b>${c_isFeedOpen(key) ? ' ▾' : ''}
        </button>${callFeedBlock(key)}`;
      }).join('')
    : '<p class="muted">Нет ни одной операции в выгрузке за этот день.</p>';

  // --- 4. Работа в выгрузке, о которой на созвоне НЕ сказали (не пропускаем!)
  const unmentioned = acc.unmentioned.length
    ? `<div class="mc-unmentioned">
        <div class="mc-col-title" data-tip="Категории, по которым в выгрузке за день есть операции, но на созвоне о них не сказали. Помогает не потерять невыговоренную работу. Число — сколько таких разделов.">🔎 В выгрузке есть, но на созвоне не упомянуто (${acc.unmentioned.length})</div>
        ${acc.unmentioned.map((c) => `<div class="mc-metric"><span>${c.icon} ${esc(c.label)} <em>${c.system}</em></span><b>${fmtNum(c.count)}</b></div>`).join('')}
      </div>`
    : '';

  return `<div class="item-card mc-acc${acc.hasFullActual ? '' : ' mc-acc-idle'}">
    <div class="item-head">
      <strong>${esc(acc.accountant)}</strong>
      <span class="badge ${acc.hasFullActual ? 'badge-green' : 'badge-yellow'}">
        ${acc.hasFullActual ? `есть факт в выгрузке · ${acc.fullCatCount} раздел(ов)` : 'нет факта в выгрузке'}
      </span>
    </div>
    <div class="mc-cols mc-cols-3">
      <div class="mc-col mc-col-said">
        <div class="mc-col-title" data-tip="Что бухгалтер сказал на созвоне по каждой компании (accountant_daily_comments): комментарий и поле «не отражено». Чипы TaxService/ArmSoft — найдена ли компания в выгрузке.">🗣 Сказал на созвоне</div>
        ${said || '<p class="muted">—</p>'}
        <div class="mc-col-title" style="margin-top:12px;" data-tip="Комментарий разбивается на отдельные слова-задачи, каждое сверяется с фактом за день по всем 26 категориям. Значок слева от слова — вердикт (см. подсказки на цветных плашках выше).">🧩 Разбор по словам ↔ выгрузка</div>
        ${claimSummary}
        <div class="mc-claims">${claims}</div>
      </div>
      <div class="mc-col mc-col-fact">
        <div class="mc-col-title" data-tip="Вся фактическая работа этого бухгалтера в выгрузке Артёма за день (все 26 разделов, счётчики из ob_accountant_activity_full). Клик по строке — конкретные документы.">📊 Факт в выгрузке · ${fmtDate(acc.actualDate)}</div>
        <div class="mc-facts">${factRows}</div>
      </div>
      <div class="mc-col mc-col-extra">
        ${unmentioned || '<div class="mc-col-title">🔎 Не упомянутое</div><p class="muted">Всё сказанное покрывает работу в выгрузке.</p>'}
      </div>
    </div>
  </div>`;
}

const c_isFeedOpen = (key) => state.calls.expandedFeed.has(key);

/** Карточка одного дня созвона: свёртываемый анализ + карточки бухгалтеров */
function callDayCard(day) {
  const c = state.calls;
  const hidden = c.analysisHidden.has(day.date);
  const a = day.analysis;
  const offset = MORNING_CALLS.actualsDayOffset || 0;
  const whenSub = offset ? `за ${fmtDate(day.actualDate)}` : `за ${fmtDate(day.date)}`;

  const analysisBlock = hidden ? '' : `
    <div class="mc-analysis">
      <div class="report-tiles mc-tiles">
        <div class="report-tile tile-gray" data-tip="Сколько бухгалтеров что-то сказали на этом созвоне и о скольких компаниях суммарно (из accountant_daily_comments за дату созвона)."><span class="tile-label">Отчитались</span>
          <span class="tile-value">${a.accountantCount}</span><span class="tile-sub">бухгалтеров · ${a.companyCount} компаний</span></div>
        <div class="report-tile tile-blue" data-tip="Сколько всего операций реально было в выгрузке Артёма ${whenSub} и в скольких из 26 разделов. Факт берётся из RPC ob_accountant_activity_full. День факта может отличаться от дня созвона (config.js → MORNING_CALLS.actualsDayOffset)."><span class="tile-label">Факт в выгрузке</span>
          <span class="tile-value">${fmtNum(a.fullActualTotal)}</span><span class="tile-sub">операций в ${a.categoriesUsed} раздел(ах) ${whenSub}</span></div>
        <div class="report-tile tile-green" data-tip="Сколько СЛОВ (задач) бухгалтеров распознано и подтверждено фактом в выгрузке за день, из общего числа разобранных слов. Разбор слов — по таксономии config.js → MC_CATEGORIES."><span class="tile-label">Слов подтверждено</span>
          <span class="tile-value">${a.claimConfirmed}</span><span class="tile-sub">из ${a.claimTotal} разобранных слов</span></div>
        <div class="report-tile tile-${a.claimMissing ? 'red' : 'green'}" data-tip="Слова, где бухгалтер назвал работу измеримой категории, но факта в выгрузке за день по этой категории НЕТ. Это главные кандидаты «сказал, но не сделал / не выгрузилось»."><span class="tile-label">Сказали — нет факта</span>
          <span class="tile-value">${a.claimMissing}</span><span class="tile-sub">задач без подтверждения</span></div>
        <div class="report-tile tile-${a.unmentionedTotal ? 'yellow' : 'gray'}" data-tip="Операции, которые в выгрузке за день ЕСТЬ, но на созвоне о них не сказали ни слова — чтобы не потерять невыговоренную работу."><span class="tile-label">Не упомянуто</span>
          <span class="tile-value">${fmtNum(a.unmentionedTotal)}</span><span class="tile-sub">операций в выгрузке без слов</span></div>
      </div>
      <p class="mc-analysis-text">${esc(callAnalysisText(day))}</p>
    </div>`;

  const cards = day.accountants.map((acc) => callAccountantCard(day, acc)).join('');

  return `<div class="meeting-day mc-day" id="mc-day-${day.date}">
    <div class="mc-day-head">
      <h3 class="block-title" data-tip="Один день утреннего созвона. Плашка — сколько бухгалтеров в этот день отчитались. Ниже — сводный анализ дня и по каждому бухгалтеру полное сопоставление слов созвона с фактом выгрузки.">Созвон ${fmtDate(day.date)} <span class="count-pill">${day.accountants.length}</span></h3>
      <button class="btn btn-sm" data-mc-toggle="${day.date}">${hidden ? '▸ показать анализ созвона' : '▾ скрыть анализ созвона'}</button>
    </div>
    ${analysisBlock}
    <div class="mc-accs">${cards}</div>
  </div>`;
}

/** Полный рендер страницы «Утренние созвоны» */
function renderCalls() {
  const body = $('#calls-body');
  if (!body) return;
  const c = state.calls;

  // Список бухгалтеров в селекте = ВСЕ бухгалтеры реестра OB (state.accCompare),
  // объединённые с теми, кто реально что-то говорил на созвонах. Так в фильтре
  // виден каждый бухгалтер, даже если по нему пока нет ни одного созвона —
  // при выборе такого покажется пустое состояние «нет созвонов».
  const callAccs = c.data
    ? c.data.days.flatMap((d) => d.accountants.map((a) => a.accountant))
    : [];
  const rosterAccs = state.accCompare
    ? state.accCompare.byAccountant.map((a) => a.accountant)
    : [];
  const accs = [...new Set([...rosterAccs, ...callAccs])]
    .filter((a) => a && a !== '— без бухгалтера')
    .sort((a, b) => a.localeCompare(b, 'ru'));
  // границы доступных дат — из всех дней истории созвонов
  const allDates = c.data ? c.data.days.map((d) => d.date).sort() : [];
  const minDate = allDates[0] || '';
  const maxDate = allDates[allDates.length - 1] || '';
  const hasRange = !!(c.filterFrom || c.filterTo);
  const header = `<div class="filters"><div class="filter-grid">
      <label>Бухгалтер
        <select id="calls-accountant">
          <option value="">Все бухгалтеры</option>
          ${accs.map((a) => `<option ${a === c.filterAccountant ? 'selected' : ''}>${esc(a)}</option>`).join('')}
        </select>
      </label>
      <label>С какого дня
        <input type="date" id="calls-from" value="${esc(c.filterFrom)}"${minDate ? ` min="${minDate}"` : ''}${maxDate ? ` max="${maxDate}"` : ''}>
      </label>
      <label>По какой день
        <input type="date" id="calls-to" value="${esc(c.filterTo)}"${minDate ? ` min="${minDate}"` : ''}${maxDate ? ` max="${maxDate}"` : ''}>
      </label>
      <label>Порядок дней
        <select id="calls-sort">
          <option value="desc" ${c.sortOrder === 'desc' ? 'selected' : ''}>Сначала новые</option>
          <option value="asc" ${c.sortOrder === 'asc' ? 'selected' : ''}>Сначала старые</option>
        </select>
      </label>
    </div>
    <div class="filter-actions">
      <button class="btn btn-sm" type="button" id="calls-reset-range"${hasRange ? '' : ' disabled'}>Сбросить период</button>
      <span class="hint" style="margin:0;">Всего дней в истории: ${allDates.length}${minDate ? ` (${fmtDate(minDate)} — ${fmtDate(maxDate)})` : ''}</span>
    </div></div>`;

  if (c.loading) { body.innerHTML = header + '<p class="empty">Загрузка анализа созвонов…</p>'; bindCallsStatic(body); return; }
  if (c.error) { body.innerHTML = header + `<p class="empty red">Ошибка: ${esc(c.error)}</p>`; bindCallsStatic(body); return; }
  if (!c.data || !c.data.dayCount) {
    body.innerHTML = header + '<p class="empty">Нет данных утренних созвонов (таблица accountant_daily_comments пуста).</p>';
    bindCallsStatic(body);
    return;
  }

  let days = c.data.days;
  // фильтр по диапазону дат (включительно), сравнение строк YYYY-MM-DD корректно
  if (c.filterFrom) days = days.filter((d) => d.date >= c.filterFrom);
  if (c.filterTo) days = days.filter((d) => d.date <= c.filterTo);
  if (c.filterAccountant) {
    days = days
      .map((d) => ({ ...d, accountants: d.accountants.filter((a) => a.accountant === c.filterAccountant) }))
      .filter((d) => d.accountants.length);
  }
  // порядок дней: data.days уже отсортирован по убыванию — переворачиваем для 'asc'
  if (c.sortOrder === 'asc') days = [...days].reverse();

  const empty = (c.filterFrom || c.filterTo)
    ? '<p class="empty">Нет созвонов за выбранный период'
      + (c.filterAccountant ? ' по выбранному бухгалтеру' : '') + '.</p>'
    : '<p class="empty">Нет созвонов по выбранному бухгалтеру.</p>';
  const list = days.map(callDayCard).join('') || empty;
  body.innerHTML = header + list;
  bindCallsStatic(body);
  bindCallsDelegated(body);
}

/** Слушатели, навешиваемые при каждом полном рендере (селект бухгалтера) */
function bindCallsStatic(container) {
  const sel = container.querySelector('#calls-accountant');
  if (sel) sel.addEventListener('change', () => { state.calls.filterAccountant = sel.value; renderCalls(); });

  const from = container.querySelector('#calls-from');
  if (from) from.addEventListener('change', () => { state.calls.filterFrom = from.value; renderCalls(); });

  const to = container.querySelector('#calls-to');
  if (to) to.addEventListener('change', () => { state.calls.filterTo = to.value; renderCalls(); });

  const sort = container.querySelector('#calls-sort');
  if (sort) sort.addEventListener('change', () => { state.calls.sortOrder = sort.value; renderCalls(); });

  const reset = container.querySelector('#calls-reset-range');
  if (reset) reset.addEventListener('click', () => {
    state.calls.filterFrom = '';
    state.calls.filterTo = '';
    renderCalls();
  });
}

/** Делегированные действия страницы (один раз на #calls-body) */
function bindCallsDelegated(container) {
  if (container._calls_bound) return;
  container._calls_bound = true;
  container.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-mc-toggle]');
    if (toggle) {
      const date = toggle.dataset.mcToggle;
      const set = state.calls.analysisHidden;
      set.has(date) ? set.delete(date) : set.add(date);
      renderCalls();
      return;
    }
    const drill = e.target.closest('[data-mc-drill]');
    if (drill) { toggleCallFeed(drill.dataset.mcDrill); return; }
  });
}

/** Раскрыть/свернуть список документов за день+бухгалтер+КАТЕГОРИЯ (drill) */
async function toggleCallFeed(key) {
  const c = state.calls;
  if (c.expandedFeed.has(key)) { c.expandedFeed.delete(key); renderCalls(); return; }
  c.expandedFeed.add(key);
  const [date, accountant, category] = key.split('|');
  if (!c.feed.has(key)) {
    c.feed.set(key, { loading: true, rows: [] });
    renderCalls();
    try {
      const bridge = c.bridges.get(accountant) || { armIds: [], tins: [] };
      const day = c.data.days.find((d) => d.date === date);
      const actualDate = day ? day.actualDate : date;
      // конкретные документы именно этой категории (все разделы выгрузки)
      const rows = await fetchAccountantDayFeedFull(bridge.armIds, bridge.tins, actualDate, category, 400);
      c.feed.set(key, { loading: false, rows });
    } catch (e) {
      c.feed.set(key, { loading: false, error: e.message, rows: [] });
    }
  }
  renderCalls();
}

/* ------------------------- Тултипы на заголовках -------------------------- */
/**
 * Поясняющие подсказки при наведении (десктоп) или тапе (мобильные) на
 * заголовки таблиц и подписи-карточек: откуда значение и что означает.
 * Один плавающий элемент (position: fixed) — не обрезается прокруткой таблицы.
 * Делегирование событий → работает и для заголовков, отрисованных динамически.
 */
function initHeaderTooltips() {
  let tip = $('#th-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'th-tooltip';
    tip.className = 'th-tooltip';
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  let current = null;

  const place = (el) => {
    const r = el.getBoundingClientRect();
    tip.style.maxWidth = Math.min(300, window.innerWidth - 20) + 'px';
    const tr = tip.getBoundingClientRect();
    let top = r.top - tr.height - 8;
    const below = top < 8;
    if (below) top = r.bottom + 8;
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
    tip.style.top = Math.round(top) + 'px';
    tip.style.left = Math.round(left) + 'px';
    tip.classList.toggle('tip-below', below);
  };
  const show = (el) => {
    const text = el.getAttribute('data-tip');
    if (!text) return;
    current = el;
    tip.textContent = text;
    tip.hidden = false;
    place(el);
  };
  const hide = () => { current = null; tip.hidden = true; };

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el) show(el);
  });
  document.addEventListener('mouseout', (e) => {
    if (current && e.target.closest('[data-tip]') === current) hide();
  });
  // мобильные / тач: тап по заголовку показывает подсказку, тап мимо — прячет
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el) { el === current ? hide() : show(el); }
    else if (current) hide();
  });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}

/* --------------------------- Drill-down модал ----------------------------- */
function showDrill(title, rows) {
  $('#modal-title').textContent = `${title} (${rows.length})`;
  $('#modal-body').innerHTML =
    rows.slice(0, 300).map((r) => itemCard(r, false)).join('') ||
    '<p class="empty">Список пуст</p>';
  if (rows.length > 300) {
    $('#modal-body').insertAdjacentHTML('beforeend',
      `<p class="muted">Показаны первые 300 из ${rows.length}. Уточните фильтры в разделе «Дельта».</p>`);
  }
  $('#modal').hidden = false;
  document.body.classList.add('modal-open');
}

/* ------------------------- Пересчёт и загрузка ---------------------------- */
async function recompute(showToast = true) {
  const loader = $('#loader');
  loader.hidden = false;
  try {
    state.computed = computeDelta(state.src);
    state.accCompare = computeAccountantComparison(state.src);
    const existing = await loadDeltaItems();
    await syncDeltaItems(state.computed.items, existing);
    state.deltaItems = await loadDeltaItems();
    // объём выгрузки Артёма = все строки, разобранные его парсерами по всему
    // проекту OB Artyom (все наборы данных). Если view объёма недоступен —
    // откат к прежней оценке по справочникам компаний (TaxService + ArmSoft).
    const exportRecords = exportVolumeTotal()
      || ((state.src.tax?.length || 0) + (state.src.armsoft?.length || 0));
    await upsertSnapshot(state.computed.counts, state.src.exportMeta,
      exportRecords, state.snapshots);
    state.snapshots = await loadSnapshots();

    // сверка задач бухгалтеров с выгрузкой Артёма — в отдельном try, чтобы
    // сбой сверки НЕ ломал пересчёт дельты
    try {
      state.exportStatus = await loadExportStatus();
      state.taskSync = computeTaskSync(state.src, state.exportStatus);
      await syncTaskSyncRows(state.taskSync.tasks, state.taskSyncItems);
      await syncProblemRows(state.taskSync.problems, state.syncProblems);
      state.taskSyncItems = await loadTaskSync();
      state.syncProblems = await loadSyncProblems();
    } catch (e) {
      console.error('Ошибка сверки задач:', e);
      toast('Сверка задач: ' + e.message, true);
    }

    renderAll();
    if (showToast) toast('Дельта пересчитана и сохранена ✓');
  } catch (e) {
    console.error(e);
    toast('Ошибка пересчёта: ' + e.message, true);
  } finally {
    loader.hidden = true;
  }
}

function renderExportMeta() {
  const m = state.src.exportMeta;
  const vol = exportVolumeTotal();
  $('#export-meta-line').textContent = m
    ? `Выгрузка Артёма: ${fmtDateTime(m.last_export_time)} · ArmSoft: ${m.armsoft_companies_count} комп. · `
      + `TaxService: ${m.tax_accounts_count} комп.${vol ? ` · всего строк: ${fmtNum(vol)}` : ''}`
    : 'Нет метаданных выгрузки';
}

function renderAll() {
  renderExportMeta();
  renderSummaryCards();
  renderSnapshotTable();
  renderExports();
  renderSync();
  renderDeltaList();
  renderReviewList();
  renderTz();
  renderAccountants();
  renderMeetings();
}

async function init() {
  renderNav();
  initHeaderTooltips();
  switchView('summary');

  $('#btn-recompute').addEventListener('click', () => recompute(true));
  $('#modal-close').addEventListener('click', () => { $('#modal').hidden = true; document.body.classList.remove('modal-open'); });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') { $('#modal').hidden = true; document.body.classList.remove('modal-open'); } });
  $('#delta-more').addEventListener('click', () => { state.deltaShown += 100; renderDeltaList(); });
  $('#review-more').addEventListener('click', () => { state.reviewShown += 50; renderReviewList(); });
  $('#btn-generate-message').addEventListener('click', generateArtyomMessage);
  $('#btn-copy-message').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#tz-message').value);
      toast('Скопировано в буфер ✓');
    } catch {
      $('#tz-message').select();
      document.execCommand('copy');
      toast('Скопировано ✓');
    }
  });

  try {
    const [src, deltaItems, snapshots, tzItems, exportStatus, taskSyncItems, syncProblems] = await Promise.all([
      loadSourceData(), loadDeltaItems(), loadSnapshots(), loadTzItems(),
      loadExportStatus().catch((e) => { console.error(e); return null; }),
      loadTaskSync().catch((e) => { console.error(e); return []; }),
      loadSyncProblems().catch((e) => { console.error(e); return []; }),
    ]);
    state.src = src;
    state.deltaItems = deltaItems;
    state.snapshots = snapshots;
    state.tzItems = tzItems;
    state.exportStatus = exportStatus;
    state.taskSyncItems = taskSyncItems;
    state.syncProblems = syncProblems;

    // индексы для раздела «Встречи» (сравнение с выгрузкой Артёма: tax + armsoft)
    state._indexes = {
      taxIndex: buildIndex(src.tax, ['client_name_ru', 'org_name_hy'], 'tin'),
      armIndex: buildIndex(src.armsoft, ['caption', 'name'], null),
    };

    // расчёт в памяти (без записи в БД) — чтобы графики/сравнения выгрузок
    // и счётчики были доступны сразу, даже без ручного пересчёта
    state.computed = computeDelta(state.src);
    state.taskSync = computeTaskSync(state.src, state.exportStatus);
    state.accCompare = computeAccountantComparison(state.src);

    // фильтры рисуем после загрузки списка бухгалтеров
    $('#filters-delta').innerHTML = filtersHtml('delta');
    $('#filters-review').innerHTML = filtersHtml('review');
    $('#filters-meetings').innerHTML = filtersHtml('meetings', { withConfirmation: false });
    bindFilters($('#filters-delta'));
    bindFilters($('#filters-review'));
    bindFilters($('#filters-meetings'));

    renderAll();
    $('#loader').hidden = true;

    // автоматический пересчёт раз в день (один раз на браузер),
    // чтобы снимок за сегодня появлялся без ручного нажатия
    const key = 'ob-delta-synced-' + todayStr();
    if (!localStorage.getItem(key)) {
      await recompute(false);
      localStorage.setItem(key, '1');
    }
  } catch (e) {
    console.error(e);
    $('#loader').hidden = true;
    toast('Ошибка загрузки данных: ' + e.message, true);
  }
}

init();
