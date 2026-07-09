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
  { id: 'delta', label: 'Дельта', icon: 'Δ' },
  { id: 'review', label: 'Эмилия', icon: '✓' },
  { id: 'artyom', label: 'ТЗ Артёму', icon: '✎' },
  { id: 'meetings', label: 'Встречи', icon: '☰' },
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
    { label: 'Дельта сегодня (нет в выгрузке)', value: forward.length, color: forward.length ? 'red' : 'green', icon: 'Δ', drill: () => showDrill('Активные клиенты OB, которых нет в выгрузке Артёма', forward) },
    { label: 'Нет в TaxService', value: missTax.length, color: 'red', icon: 'T', drill: () => showDrill(ISSUE_TYPES.missing_taxservice.label, missTax) },
    { label: 'Нет в ArmSoft', value: missArm.length, color: 'red', icon: 'A', drill: () => showDrill(ISSUE_TYPES.missing_armsoft.label, missArm) },
    { label: 'Артём выгрузил, нет в реестре OB', value: reverse.length, color: 'yellow', icon: '⇄', drill: () => showDrill('Есть в выгрузке Артёма, но нет в реестре OB', reverse) },
    { label: 'Проблемы выгрузки Артёма', value: open.filter((r) => r.confirmation_status === 'confirmed_artyom_export_problem').length, color: 'red', icon: '!', drill: () => showDrill('Подтверждённые проблемы выгрузки', open.filter((r) => r.confirmation_status === 'confirmed_artyom_export_problem')) },
    { label: 'Ждут проверки Эмилии', value: open.filter((r) => r.confirmation_status === 'not_checked').length, color: 'yellow', icon: '?', drill: () => showDrill('Не проверено', open.filter((r) => r.confirmation_status === 'not_checked')) },
    { label: 'Исправлено со вчера', value: state.deltaItems.filter((r) => r.resolved_at && r.resolved_at.slice(0, 10) >= yesterdayIso).length, color: 'green', icon: '✓', drill: () => showDrill('Исправлено со вчера', state.deltaItems.filter((r) => r.resolved_at && r.resolved_at.slice(0, 10) >= yesterdayIso)) },
    { label: 'Новые за сегодня', value: state.deltaItems.filter((r) => r.snapshot_date === today).length, color: 'red', icon: '+', drill: () => showDrill('Новые за сегодня', state.deltaItems.filter((r) => r.snapshot_date === today)) },
  ];

  $('#summary-cards').innerHTML = cards.map((c, i) => `
    <button class="card card-${c.value === 0 && c.color !== 'green' ? 'gray' : c.color}" data-card="${i}">
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
        <span>Активных клиентов</span><b>${s.total_active_clients}</b>
        <span>С ՀՎՀՀ</span><b>${s.active_with_hvhh}</b>
        <span>TaxService: найдено/ожид.</span><b>${s.found_taxservice}/${s.expected_taxservice}</b>
        <span>Нет в TaxService</span><b><button class="num-link num-bad" data-date="${s.snapshot_date}" data-type="missing_taxservice">${s.missing_taxservice}</button></b>
        <span>ArmSoft: найдено/ожид.</span><b>${s.found_armsoft}/${s.expected_armsoft}</b>
        <span>Нет в ArmSoft</span><b><button class="num-link num-bad" data-date="${s.snapshot_date}" data-type="missing_armsoft">${s.missing_armsoft}</button></b>
        <span>Всего дельта</span><b><button class="num-link num-bad" data-date="${s.snapshot_date}" data-type="">${s.total_delta}</button></b>
        <span>Выгрузка Артёма</span><b>${fmtDateTime(s.artyom_export_time)}</b>
        <span>Записей в выгрузке</span><b>${s.artyom_export_records ?? '—'}</b>
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
    <h3 class="block-title">Объём выгрузки по всему проекту OB Artyom
      <span class="count-pill">${fmtNum(volTotal)} строк</span></h3>
    <p class="hint">Реальный объём того, что парсеры Артёма загрузили в проект: не только справочники
      компаний, а все наборы данных (журналы, счета, операции и т.д.).
      ArmSoft: <b>${fmtNum(catTotal('ArmSoft'))}</b> · TaxService: <b>${fmtNum(catTotal('TaxService'))}</b>
      по <b>${volume.length}</b> наборам.</p>
    <div class="table-wrap">
      <table class="data-table compact">
        <thead><tr><th>Набор данных</th><th>Источник</th><th style="text-align:right">Строк</th></tr></thead>
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
      <h3 class="block-title">${title} <span class="count-pill">${rows.length}</span></h3>
      <p class="hint">${note}</p>
      <div class="table-wrap">
        <table class="data-table compact">
          <thead><tr><th>Компания</th><th>ՀՎՀՀ</th></tr></thead>
          <tbody>${rows.slice(0, limit).map(rowHtml).join('') || '<tr><td colspan="2" class="empty">Нет расхождений</td></tr>'}</tbody>
        </table>
      </div>
      ${rows.length > limit ? `<p class="muted">Показаны первые ${limit} из ${rows.length}. Используйте поиск.</p>` : ''}
    </div>`;

  $('#exports-body').innerHTML = `
    <h3 class="block-title">Выгрузки Артёма по датам</h3>
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
      <span>ՀՎՀՀ: <b>${esc(r.hvhh) || '—'}</b></span>
      <span>Бухгалтер: <b>${esc(r.accountant_name) || '—'}</b></span>
      <span>Статус: <b>${r.client_is_active === true ? 'активен' : r.client_is_active === false ? 'неактивен' : '—'}</b></span>
      <span>Приоритет: <b>${PRIORITIES[r.priority]?.label || r.priority}</b></span>
    </div>
    <div class="item-issue">
      <span class="badge badge-red">${ISSUE_TYPES[r.issue_type]?.short || r.issue_type}</span>
      <span class="muted">не хватает: ${esc(r.missing_from_system)}</span>
    </div>
    <div class="item-chips">${chips(r)}</div>
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
        <span>ՀՎՀՀ: <b>${esc(t.hvhh) || '—'}</b></span>
        <span>Приоритет: <b>${PRIORITIES[t.priority]?.label || t.priority}</b></span>
        <span>Обнаружено: <b>${fmtDate(t.date_detected)}</b></span>
      </div>
      <div class="item-reason">${esc(t.issue_description || '')}</div>
      <div class="item-meta">
        <span>Ожидается в: <b>${esc(t.expected_source) || '—'}</b></span>
        <span>Фактически есть: <b>${esc(t.actual_source) || '—'}</b></span>
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
            <span class="badge ${missing.length ? 'badge-red' : 'badge-green'}">
              ${missing.length ? `${missing.length} нет в выгрузке` : 'всё в выгрузке'}
            </span>
          </div>
          ${list.map((c) => {
            const tm = findMatch(taxIndex, { hvhh: null, names: [c.company_name] });
            const arm = findMatch(armIndex, { hvhh: null, names: [c.company_name] });
            const chip = (m, label) => `<span class="chip ${m.found ? (m.quality === 'fuzzy' ? 'chip-fuzzy' : 'chip-yes') : 'chip-no'}">${m.found ? (m.quality === 'fuzzy' ? '≈' : '✓') : '✗'} ${label}</span>`;
            return `<div class="meeting-row">
              <div class="meeting-company"><b>${esc(c.company_name)}</b>
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
  renderDeltaList();
  renderReviewList();
  renderTz();
  renderMeetings();
}

async function init() {
  renderNav();
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
    const [src, deltaItems, snapshots, tzItems] = await Promise.all([
      loadSourceData(), loadDeltaItems(), loadSnapshots(), loadTzItems(),
    ]);
    state.src = src;
    state.deltaItems = deltaItems;
    state.snapshots = snapshots;
    state.tzItems = tzItems;

    // индексы для раздела «Встречи» (сравнение с выгрузкой Артёма: tax + armsoft)
    state._indexes = {
      taxIndex: buildIndex(src.tax, ['client_name_ru', 'org_name_hy'], 'tin'),
      armIndex: buildIndex(src.armsoft, ['caption', 'name'], null),
    };

    // расчёт в памяти (без записи в БД) — чтобы графики/сравнения выгрузок
    // и счётчики были доступны сразу, даже без ручного пересчёта
    state.computed = computeDelta(state.src);

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
