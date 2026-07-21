/* =============================================================================
 * Дневной отчёт бухгалтера (страница daily-report.html).
 *
 * ЧТО ПОКАЗЫВАЕТ за выбранный день и бухгалтера:
 *   1. «Артём проработал N часов» — часы, посчитанные из цифр выгрузки Артёма
 *      (обслуженные компании / счета / услуги) через ЕДИНУЮ функцию serviceHours()
 *      в config.js. Хронометраж пока по нормативу-заглушке; позже — Excel Гарри.
 *   2. Комментарии бухгалтера (действие + затраченное время в минутах) — свободные
 *      записи под днём. Хранятся в accountant_daily_comments (см. ниже).
 *   3. «Итого с учётом комментариев» — часы Артёма + минуты бухгалтера.
 *   4. Пометка к конкретной цифре Артёма («прокомментировать»): бухгалтер отмечает
 *      цифру как неверную/уточняет её.
 *   + «Письмо Артёму» — копируемое сообщение о том, что за день НЕ прошло в выгрузке
 *     (компании из комментариев без строк в выгрузке + помеченные цифры).
 *
 * ХРАНЕНИЕ (переиспользуем accountant_daily_comments, одна доп. колонка report_meta):
 *   • комментарий-работа:  comment = действие; unaccounted_work = действие (его
 *       подхватывает сверка в tasksync.js); report_meta = {kind:'work', minutes:N};
 *       company_name — необязательная привязка к компании.
 *   • пометка к цифре:     comment = текст пометки; report_meta = {kind:'figure',
 *       figure:'companies'|'invoices'|'services'}; unaccounted_work пустой.
 *
 * Мост «компания → выгрузка Артёма» переиспользует computeAccountantComparison
 * (accountants.js): по каждой компании бухгалтера он уже находит company_id ArmSoft
 * и ИНН/tin. Дневные цифры берём из RPC ob_export_day_activity(date).
 *
 * Vanilla JS + вендоренный Supabase (как во всём репозитории), без фреймворков.
 * ========================================================================== */

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Сегодняшняя дата (YYYY-MM-DD) в часовом поясе бизнеса */
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TIMEZONE }).format(new Date());
}

function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${day}.${m}.${y}`;
}
function fmtNum(n) { return Number(n || 0).toLocaleString('ru-RU').replace(/,/g, ' '); }
/** Часы → «7,5 ч» */
function fmtHours(h) { return `${Number(h || 0).toLocaleString('ru-RU')} ч`; }
/** Минуты → «2 ч 15 мин» / «45 мин» */
function fmtMinutes(min) {
  const m = Math.round(Number(min || 0));
  if (!m) return '0 мин';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return (h ? `${h} ч` : '') + (h && r ? ' ' : '') + (r || !h ? `${r} мин` : '');
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('toast-error', isError);
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 3500);
}

/** Ключ бухгалтера без имени (согласован с accountants.js byAccountant) */
const NO_ACC = '— без бухгалтера';
const accOf = (r) => r.accountant_name || NO_ACC;

/* ------------------------------- Состояние ------------------------------- */
const state = {
  src: null,        // { clients, tax, armsoft, comments }
  cmp: null,        // computeAccountantComparison(src)
  days: [],         // [{ activity_date, events }]
  accountant: '',   // выбранный бухгалтер
  date: '',         // выбранный день (YYYY-MM-DD)
  byArm: new Map(), // company_id ArmSoft → { issued, received, reports }
  byTin: new Map(), // normalizeHvhh(tin) → { issued, received, reports }
  figureBox: null,  // какая цифра сейчас редактируется ('companies'|'invoices'|'services')
  letterText: '',   // текст письма Артёму (для копирования)
  letterShown: false,
};

/* ------------------------------- Загрузка -------------------------------- */
/** Полная выгрузка таблицы постранично (PostgREST отдаёт максимум 1000). */
async function fetchAll(table, orderCol, select = '*') {
  const PAGE = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await sb.from(table).select(select)
      .order(orderCol, { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function loadBase() {
  const [clients, tax, armsoft, comments, daysRes] = await Promise.all([
    fetchAll('ob_accounting_companies', 'id'),
    fetchAll('v_tax_accounts', 'id'),
    fetchAll('v_armsoft_companies', 'company_id'),
    fetchAll('accountant_daily_comments', 'id'),
    sb.rpc('ob_export_days', { p_limit: 180 }),
  ]);
  if (daysRes.error) throw new Error('ob_export_days: ' + daysRes.error.message);
  state.src = { clients, tax, armsoft, comments };
  state.cmp = computeAccountantComparison(state.src);
  state.days = daysRes.data || [];
}

/** Перечитать комментарии (после вставки/удаления) */
async function reloadComments() {
  state.src.comments = await fetchAll('accountant_daily_comments', 'id');
}

/** Дневная активность выгрузки Артёма → индексы по company_id и по ИНН */
async function loadDayActivity(date) {
  const { data, error } = await sb.rpc('ob_export_day_activity', { p_date: date });
  if (error) throw new Error('ob_export_day_activity: ' + error.message);
  const byArm = new Map();
  const byTin = new Map();
  for (const r of data || []) {
    const cell = {
      issued: Number(r.invoices_issued || 0),
      received: Number(r.invoices_received || 0),
      reports: Number(r.reports || 0),
    };
    if (r.arm_company_id != null) byArm.set(r.arm_company_id, cell);
    else if (r.tin) byTin.set(normalizeHvhh(r.tin), cell);
  }
  state.byArm = byArm;
  state.byTin = byTin;
}

/* ------------------------------- Расчёт ---------------------------------- */
/** Компании выбранного бухгалтера (строки computeAccountantComparison) */
function accountantRows() {
  return (state.cmp?.rows || []).filter((r) => accOf(r) === state.accountant);
}

/** Активность выгрузки Артёма по одной компании за выбранный день */
function companyDayActivity(r) {
  const arm = r.arm_id != null ? state.byArm.get(r.arm_id) : null;
  const tax = r.tin ? state.byTin.get(normalizeHvhh(r.tin)) : null;
  const invoices = (arm ? arm.issued + arm.received : 0) + (tax ? tax.issued + tax.received : 0);
  const services = tax ? tax.reports : 0;
  return {
    invoices, services,
    issued: (arm ? arm.issued : 0) + (tax ? tax.issued : 0),
    received: (arm ? arm.received : 0) + (tax ? tax.received : 0),
    active: invoices > 0 || services > 0,
  };
}

/** Цифры дня Артёма для бухгалтера + список активных компаний */
function computeFigures() {
  const rows = accountantRows();
  let companies = 0; let invoices = 0; let services = 0;
  const activeCompanies = [];
  for (const r of rows) {
    const a = companyDayActivity(r);
    if (!a.active) continue;
    companies += 1;
    invoices += a.invoices;
    services += a.services;
    activeCompanies.push({ row: r, act: a });
  }
  activeCompanies.sort((x, y) =>
    (y.act.invoices + y.act.services) - (x.act.invoices + x.act.services)
    || x.row.company_name.localeCompare(y.row.company_name, 'ru'));
  return { figures: { companies, invoices, services }, activeCompanies };
}

/** Комментарии бухгалтера за выбранный день, по типу report_meta */
function dayComments() {
  const list = (state.src?.comments || []).filter((c) =>
    accOf(c) === state.accountant && String(c.comment_date).slice(0, 10) === state.date);
  const work = []; const figures = {};
  for (const c of list) {
    const meta = c.report_meta || null;
    if (meta && meta.kind === 'figure' && meta.figure) {
      (figures[meta.figure] = figures[meta.figure] || []).push(c);
    } else if (meta && meta.kind === 'work') {
      work.push(c);
    } else {
      // обычный старый комментарий (без report_meta) — тоже показываем как запись
      work.push(c);
    }
  }
  return { work, figures };
}

/** Суммарные минуты из комментариев-работы */
function commentMinutes(work) {
  return work.reduce((s, c) => s + Number(c.report_meta?.minutes || 0), 0);
}

/* ------------------------------- Рендер ---------------------------------- */
function renderControls() {
  const accs = [...new Set((state.cmp?.byAccountant || []).map((a) => a.accountant))]
    .sort((a, b) => a.localeCompare(b, 'ru'));
  $('#dr-accountant').innerHTML = accs
    .map((a) => `<option ${a === state.accountant ? 'selected' : ''}>${esc(a)}</option>`).join('')
    || '<option value="">Нет бухгалтеров</option>';

  $('#dr-day').innerHTML = state.days.map((d) => {
    const iso = String(d.activity_date).slice(0, 10);
    return `<option value="${iso}" ${iso === state.date ? 'selected' : ''}>${fmtDate(iso)} · ${fmtNum(d.events)} событий</option>`;
  }).join('') || `<option value="${state.date}">${fmtDate(state.date)}</option>`;

  $('#dr-meta-line').textContent = `${state.accountant || '—'} · день ${fmtDate(state.date)}`;
}

function figureCard(key, value, annotations) {
  const label = DAILY_REPORT.figureLabels[key] || key;
  const list = (annotations || []).map((c) => `
    <div class="dr-annot">
      <span class="chip chip-fuzzy">⚑ пометка</span>
      <span>${esc(c.comment)}</span>
      <button class="btn-close dr-del" data-del="${c.id}" title="Удалить пометку">✕</button>
    </div>`).join('');
  const editing = state.figureBox === key;
  return `<div class="report-tile tile-${annotations && annotations.length ? 'yellow' : 'gray'}">
    <span class="tile-label">${esc(label)}</span>
    <span class="tile-value">${fmtNum(value)}</span>
    <button class="btn btn-sm dr-annotate" data-figure="${key}">${editing ? 'Отмена' : '⚑ прокомментировать'}</button>
    ${editing ? `<div class="dr-annot-form">
      <input type="text" id="dr-annot-input" placeholder="напр.: неверно, было 12, а не 9…">
      <button class="btn btn-primary btn-sm" id="dr-annot-save" data-figure="${key}">Сохранить</button>
    </div>` : ''}
    ${list ? `<div class="dr-annot-list">${list}</div>` : ''}
  </div>`;
}

function renderBody() {
  const body = $('#dr-body');
  if (!state.accountant) { body.innerHTML = '<p class="empty">Выберите бухгалтера.</p>'; return; }

  const { figures, activeCompanies } = computeFigures();
  const { work, figures: figAnnot } = dayComments();
  const artyomHours = serviceHours(figures);
  const minutes = commentMinutes(work);
  const totalHours = Math.round((artyomHours + minutes / 60) * 10) / 10;

  // --- верхние плитки: часы Артёма / минуты бухгалтера / итого ---
  const topTiles = `
    <div class="report-tiles">
      <div class="report-tile tile-blue">
        <span class="tile-label">Артём проработал</span>
        <span class="tile-value">${fmtHours(artyomHours)}</span>
        <span class="tile-sub">по цифрам выгрузки за день (норматив)</span>
      </div>
      <div class="report-tile tile-gray">
        <span class="tile-label">Комментарии бухгалтера</span>
        <span class="tile-value">${fmtMinutes(minutes)}</span>
        <span class="tile-sub">${work.length} ${work.length === 1 ? 'запись' : 'записей'}</span>
      </div>
      <div class="report-tile tile-green">
        <span class="tile-label">Итого с учётом комментариев</span>
        <span class="tile-value">${fmtHours(totalHours)}</span>
        <span class="tile-sub">${fmtHours(artyomHours)} + ${fmtMinutes(minutes)}</span>
      </div>
    </div>`;

  // --- цифры Артёма с пометками ---
  const figuresBlock = `
    <h3 class="block-title">Цифры выгрузки Артёма за день
      <span class="count-pill">норматив ниже TODO</span></h3>
    <p class="hint">Нажмите «⚑ прокомментировать» рядом с цифрой, чтобы отметить её как неверную —
      пометка попадёт в письмо Артёму.</p>
    <div class="report-tiles">
      ${figureCard('companies', figures.companies, figAnnot.companies)}
      ${figureCard('invoices', figures.invoices, figAnnot.invoices)}
      ${figureCard('services', figures.services, figAnnot.services)}
    </div>`;

  // --- разбивка по компаниям с активностью ---
  const compRows = activeCompanies.map(({ row, act }) => `
    <div class="acc-card">
      <div class="acc-card-head">
        <span class="acc-card-name">${esc(row.company_name)}</span>
        <span class="ex-row">
          ${row.tin ? `<span class="ex ex-y" title="ИНН">${esc(row.tin)}</span>` : ''}
        </span>
      </div>
      <div class="acc-card-work">
        ${act.invoices ? `<span class="wchip wchip-inv">🧾 Счета: ${act.invoices} (выст. ${act.issued} / получ. ${act.received})</span>` : ''}
        ${act.services ? `<span class="wchip wchip-report">📄 Услуги/отчёты: ${act.services}</span>` : ''}
      </div>
    </div>`).join('');
  const companiesBlock = `
    <h3 class="block-title">Компании с активностью в выгрузке
      <span class="count-pill">${activeCompanies.length}</span></h3>
    ${activeCompanies.length ? `<div class="acc-list">${compRows}</div>`
      : '<p class="empty">За этот день по компаниям бухгалтера нет строк в выгрузке Артёма.</p>'}`;

  // --- комментарии бухгалтера (под днём) + форма добавления ---
  const workRows = work.map((c) => {
    const min = Number(c.report_meta?.minutes || 0);
    return `<div class="item-card">
      <div class="item-head">
        <strong class="item-name">${esc(c.comment)}</strong>
        <span class="badge badge-gray">${fmtMinutes(min)}</span>
      </div>
      <div class="item-meta">
        ${c.company_name ? `<span>Компания: <b>${esc(c.company_name)}</b></span>` : ''}
        <span>Дата: <b>${fmtDate(c.comment_date)}</b></span>
        <button class="btn btn-sm dr-del" data-del="${c.id}">Удалить</button>
      </div>
    </div>`;
  }).join('') || '<p class="muted">Комментариев за этот день пока нет.</p>';

  const companyOptions = ['<option value="">— без привязки к компании —</option>']
    .concat(accountantRows()
      .map((r) => r.company_name)
      .sort((a, b) => a.localeCompare(b, 'ru'))
      .map((n) => `<option value="${esc(n)}">${esc(n)}</option>`)).join('');

  const commentsBlock = `
    <h3 class="block-title">Комментарии бухгалтера</h3>
    <p class="hint">Действие + затраченное время. Минуты суммируются в «Итого». Если указать
      компанию, и по ней за день нет строк в выгрузке — она попадёт в письмо Артёму.</p>
    <div class="list">${workRows}</div>
    <div class="item-card dr-comment-form">
      <div class="filter-grid">
        <label class="filter-search">Действие
          <input type="text" id="dr-c-action" placeholder="напр.: сверка актов с поставщиком…">
        </label>
        <label>Время (минут)
          <input type="number" id="dr-c-minutes" min="1" step="1" placeholder="45">
        </label>
        <label>Компания (необязательно)
          <select id="dr-c-company">${companyOptions}</select>
        </label>
      </div>
      <button class="btn btn-primary" id="dr-c-add">Добавить комментарий</button>
    </div>`;

  // --- письмо Артёму ---
  const letterBlock = `
    <h3 class="block-title">Письмо Артёму</h3>
    <p class="hint">Соберёт всё, что за ${fmtDate(state.date)} не прошло в выгрузке по этому бухгалтеру:
      компании из комментариев без строк в выгрузке и цифры, помеченные как неверные.</p>
    <div class="toolbar">
      <button class="btn btn-primary" id="dr-letter-gen">Сформировать письмо Артёму</button>
    </div>
    <div id="dr-letter-box" class="message-box" ${state.letterShown ? '' : 'hidden'}>
      <textarea id="dr-letter" rows="14" readonly>${esc(state.letterText)}</textarea>
      <button class="btn btn-primary" id="dr-letter-copy">Скопировать</button>
    </div>`;

  body.innerHTML = topTiles + figuresBlock + companiesBlock + commentsBlock + letterBlock;
  bindBody(body);
}

/* --------------------------- Письмо Артёму -------------------------------- */
function buildLetter() {
  const rows = accountantRows();
  const { figures: figAnnot } = dayComments();
  const { work } = dayComments();

  // компании из комментариев без строк в выгрузке за день
  const normByComp = new Map(rows.map((r) => [normalizeName(r.company_name), r]));
  const missing = [];
  const seen = new Set();
  for (const c of work) {
    if (!c.company_name) continue;
    const key = normalizeName(c.company_name);
    if (seen.has(key)) continue;
    const r = normByComp.get(key);
    const act = r ? companyDayActivity(r) : null;
    if (!act || !act.active) { missing.push({ name: c.company_name, note: c.comment }); seen.add(key); }
  }

  const flagged = [];
  for (const [fig, list] of Object.entries(figAnnot)) {
    for (const c of list) flagged.push({ figure: DAILY_REPORT.figureLabels[fig] || fig, note: c.comment });
  }

  const lines = [];
  lines.push('Привет, Артём!');
  lines.push('');
  lines.push(`Дневная сверка за ${fmtDate(state.date)}, бухгалтер: ${state.accountant}.`);
  lines.push('Ниже то, что по нашим данным не прошло в твою выгрузку за этот день.');
  lines.push('');

  if (missing.length) {
    lines.push(`— Компании, по которым велась работа, но нет строк в выгрузке (${missing.length}):`);
    missing.forEach((m, i) => {
      lines.push(`   ${i + 1}. «${m.name}»${m.note ? ` — ${m.note}` : ''}`);
    });
    lines.push('');
  }
  if (flagged.length) {
    lines.push(`— Цифры выгрузки, помеченные бухгалтером как неверные (${flagged.length}):`);
    flagged.forEach((f, i) => {
      lines.push(`   ${i + 1}. ${f.figure}: ${f.note}`);
    });
    lines.push('');
  }
  if (!missing.length && !flagged.length) {
    lines.push('За этот день расхождений не отмечено — всё прошло в выгрузку. 👍');
    lines.push('');
  } else {
    lines.push('Что нужно сделать:');
    lines.push('1) Проверить, почему эти компании/цифры не попали в выгрузку за день (фильтры, даты, названия).');
    lines.push('2) Добавить их в следующий экспорт или объяснить, почему их там быть не должно.');
    lines.push('');
  }
  lines.push('Спасибо!');
  return lines.join('\n');
}

/* ---------------------------- События (bind) ----------------------------- */
function bindBody(container) {
  // пометка к цифре: раскрыть/скрыть форму
  container.querySelectorAll('.dr-annotate').forEach((b) => b.addEventListener('click', () => {
    const fig = b.dataset.figure;
    state.figureBox = state.figureBox === fig ? null : fig;
    renderBody();
    const inp = $('#dr-annot-input'); if (inp) inp.focus();
  }));
  // сохранить пометку к цифре
  const saveAnnot = container.querySelector('#dr-annot-save');
  if (saveAnnot) saveAnnot.addEventListener('click', async () => {
    const text = ($('#dr-annot-input').value || '').trim();
    if (!text) { toast('Введите текст пометки', true); return; }
    await addComment({
      comment: text,
      unaccounted_work: null,
      company_name: null,
      report_meta: { kind: 'figure', figure: saveAnnot.dataset.figure },
    });
    state.figureBox = null;
  });

  // добавить комментарий-работу
  const addBtn = container.querySelector('#dr-c-add');
  if (addBtn) addBtn.addEventListener('click', async () => {
    const action = ($('#dr-c-action').value || '').trim();
    const minutes = parseInt($('#dr-c-minutes').value, 10);
    const company = $('#dr-c-company').value || null;
    if (!action) { toast('Введите описание действия', true); return; }
    if (!Number.isFinite(minutes) || minutes <= 0) { toast('Укажите время в минутах', true); return; }
    await addComment({
      comment: action,
      unaccounted_work: action,   // переиспользуем поле — его читает сверка tasksync.js
      company_name: company,
      report_meta: { kind: 'work', minutes },
    });
  });

  // удалить запись/пометку
  container.querySelectorAll('.dr-del').forEach((b) => b.addEventListener('click', async () => {
    try {
      const { error } = await sb.from('accountant_daily_comments').delete().eq('id', +b.dataset.del);
      if (error) throw new Error(error.message);
      await reloadComments();
      toast('Удалено ✓');
      renderBody();
    } catch (e) { toast('Ошибка удаления: ' + e.message, true); }
  }));

  // письмо Артёму
  const gen = container.querySelector('#dr-letter-gen');
  if (gen) gen.addEventListener('click', () => {
    state.letterText = buildLetter();
    state.letterShown = true;
    renderBody();
  });
  const copy = container.querySelector('#dr-letter-copy');
  if (copy) copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#dr-letter').value);
      toast('Скопировано в буфер ✓');
    } catch {
      $('#dr-letter').select();
      document.execCommand('copy');
      toast('Скопировано ✓');
    }
  });
}

/** Вставка строки в accountant_daily_comments + перечитывание + перерисовка */
async function addComment(fields) {
  try {
    const row = {
      accountant_name: state.accountant === NO_ACC ? null : state.accountant,
      comment_date: state.date,
      ...fields,
    };
    const { error } = await sb.from('accountant_daily_comments').insert(row);
    if (error) throw new Error(error.message);
    await reloadComments();
    toast('Сохранено ✓');
    renderBody();
  } catch (e) { toast('Ошибка сохранения: ' + e.message, true); }
}

/* ------------------------------- Инициализация --------------------------- */
async function onControlsChange() {
  $('#loader').hidden = false;
  try {
    state.figureBox = null;
    state.letterShown = false;
    state.letterText = '';
    await loadDayActivity(state.date);
    renderBody();
  } catch (e) { toast('Ошибка: ' + e.message, true); }
  finally { $('#loader').hidden = true; }
}

async function init() {
  try {
    await loadBase();
    const accs = [...new Set((state.cmp?.byAccountant || []).map((a) => a.accountant))]
      .sort((a, b) => a.localeCompare(b, 'ru'));
    state.accountant = accs[0] || '';
    state.date = state.days.length ? String(state.days[0].activity_date).slice(0, 10) : todayStr();

    renderControls();
    $('#dr-accountant').addEventListener('change', (e) => {
      state.accountant = e.target.value;
      $('#dr-meta-line').textContent = `${state.accountant || '—'} · день ${fmtDate(state.date)}`;
      onControlsChange();
    });
    $('#dr-day').addEventListener('change', (e) => {
      state.date = e.target.value;
      $('#dr-meta-line').textContent = `${state.accountant || '—'} · день ${fmtDate(state.date)}`;
      onControlsChange();
    });

    await loadDayActivity(state.date);
    renderBody();
  } catch (e) {
    console.error(e);
    $('#dr-body').innerHTML = `<p class="empty">Ошибка загрузки: ${esc(e.message)}</p>`;
    toast('Ошибка загрузки данных: ' + e.message, true);
  } finally {
    $('#loader').hidden = true;
  }
}

init();
