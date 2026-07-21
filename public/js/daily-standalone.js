/* =============================================================================
 * Дневной отчёт по ОДНОМУ бухгалтеру — самостоятельная страница (daily.html).
 *
 * Задача «Выгрузка Артёма — проверка на 1 бухгалтере». Простой, отдельный
 * экран (без остального дашборда), который по дням показывает:
 *   1. отчёт Артёма по типам услуг + время по хронометражу Гарри;
 *   2. итог времени по отчёту Артёма («бухгалтер проработал N ч»);
 *   3. обратную связь бухгалтера: подтверждение цифр, комментарий к КАЖДОЙ
 *      цифре Артёма, и что он делал помимо (каждое действие + сколько минут);
 *   4. итог времени с учётом комментариев бухгалтера;
 *   5. письмо Артёму со всем, что не выгрузилось / отмечено спорным.
 *
 * Вся тяжёлая логика переиспользуется из проверенных модулей:
 *   data.js (загрузка + RPC), accountants.js (мост бухгалтер→компании),
 *   dailyreport.js (buildDailyReport / mergeAccountantFeedback / формат времени).
 * ========================================================================== */

/* ------------------------------ мелкие хелперы --------------------------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 3500);
}
function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${day}.${m}.${y}`;
}
function fmtNum(n) { return Number(n || 0).toLocaleString('ru-RU').replace(/,/g, ' '); }
function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('ru-RU', {
    timeZone: CONFIG.TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
function fmtMoney(amount, cur) {
  if (amount == null || amount === '') return '';
  const n = Number(amount);
  if (!isFinite(n) || n === 0) return '';
  const val = fmtNum(Math.round(n));
  return cur === 'AMD' || !cur ? `${val} ֏` : `${val} ${cur}`;
}

/* --------------------------------- состояние ----------------------------- */
const S = {
  cmp: null,          // computeAccountantComparison(src)
  accountant: null,
  bridge: null,
  report: null,       // buildDailyReport(...)
  reportsByDate: new Map(),
  shown: 14,
  expanded: new Set(),
  feed: new Map(),    // ключ `${date}|${cat}` → { loading, rows, error }
  letter: '',
  loading: false,
  error: null,
};

/* --------------------------------- запуск -------------------------------- */
(async function init() {
  try {
    const src = await loadSourceData();
    S.cmp = computeAccountantComparison(src);
  } catch (e) {
    console.error(e);
    $('#root').innerHTML = `<p class="empty red">Не удалось загрузить данные: ${esc(e.message)}</p>`;
    return;
  }
  const accs = S.cmp.byAccountant.map((a) => a.accountant).filter((a) => a && a !== '— без бухгалтера');
  const preferred = accs.includes(DAILY_REPORT.defaultAccountant) ? DAILY_REPORT.defaultAccountant : accs[0];
  await loadReport(preferred);
})();

/* --------------------------- загрузка отчёта ----------------------------- */
async function loadReport(accountant) {
  S.accountant = accountant;
  S.loading = true; S.error = null; S.report = null;
  S.shown = 14; S.expanded = new Set(); S.feed = new Map(); S.letter = '';
  render();
  try {
    S.bridge = accountantBridge(S.cmp.rows, accountant);
    const [activity, dayReports] = await Promise.all([
      fetchAccountantDailyActivity(S.bridge.armIds, S.bridge.tins),
      loadDayReports(accountant),
    ]);
    S.reportsByDate = new Map(dayReports.map((r) => [String(r.report_date).slice(0, 10), r]));
    S.report = buildDailyReport(activity, CHRONO);
  } catch (e) {
    console.error(e);
    S.error = e.message;
  } finally {
    S.loading = false;
    render();
  }
}

/* ------------------------------- рендер ---------------------------------- */
function render() {
  const root = $('#root');
  const accs = S.cmp ? S.cmp.byAccountant.map((a) => a.accountant).filter((a) => a && a !== '— без бухгалтера') : [];

  const picker = `<div class="picker">
    <label for="acc">Бухгалтер (пилот):</label>
    <select id="acc">${accs.map((a) =>
      `<option ${a === S.accountant ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
  </div>`;

  const chrono = `<div class="note src">Хронометраж по модели: <b>${esc(CHRONO.source)}</b>.
    Норматив времени на услугу задан в <code>config.js → CHRONO.minutesPerUnit</code> и меняется одним числом.</div>`;

  if (S.loading) { root.innerHTML = picker + chrono + '<div class="loading"><div class="spin"></div>Считаем дневной отчёт…</div>'; bindPicker(); return; }
  if (S.error)   { root.innerHTML = picker + chrono + `<p class="empty red">Ошибка: ${esc(S.error)}</p>`; bindPicker(); return; }

  const rep = S.report;
  const b = S.bridge || {};
  const confirmedDays = [...S.reportsByDate.values()].filter((r) => r.status === 'confirmed').length;

  const tiles = `<div class="tiles">
    <div class="tile"><div class="lab">Компаний у бухгалтера</div><div class="val">${b.activeCount || 0}</div><div class="foot">${b.withWorkCount || 0} с работой в выгрузке</div></div>
    <div class="tile blue"><div class="lab">Дней с работой</div><div class="val">${rep.dayCount}</div><div class="foot">в выгрузке Артёма</div></div>
    <div class="tile blue"><div class="lab">Действий всего</div><div class="val">${fmtNum(rep.totalCount)}</div><div class="foot">счета, отчёты и т.д.</div></div>
    <div class="tile green"><div class="lab">Времени по хронометражу</div><div class="val">${fmtHours(rep.totalMinutes)}</div><div class="foot">за весь период</div></div>
    <div class="tile ${confirmedDays ? 'green' : ''}"><div class="lab">Дней подтверждено</div><div class="val">${confirmedDays}</div><div class="foot">из ${rep.dayCount}</div></div>
  </div>`;

  const letter = `<div class="toolbar">
      <button class="btn" data-letter>✉ Письмо Артёму: что не выгрузилось</button>
    </div>
    ${S.letter ? `<div class="letterbox">
      <textarea rows="14" readonly id="letter">${esc(S.letter)}</textarea>
      <div class="toolbar"><button class="btn primary sm" data-copy>Скопировать</button></div>
    </div>` : ''}`;

  const days = rep.days.slice(0, S.shown);
  const list = days.length
    ? days.map(dayCard).join('')
    : '<p class="empty">У этого бухгалтера нет работы в выгрузке Артёма (нет привязок компаний к ArmSoft/налоговому кабинету).</p>';
  const more = rep.days.length > days.length
    ? `<div class="toolbar"><button class="btn" data-more>Показать ещё дни (${rep.days.length - days.length})</button></div>` : '';

  root.innerHTML = picker + chrono + tiles + letter
    + `<h2 class="block-title">Хронология по дням <span class="pill">${rep.dayCount}</span></h2>`
    + `<p class="hint">Для каждого дня: отчёт Артёма по типам услуг и время по хронометражу → итог времени →
        комментарии бухгалтера (в т.ч. к каждой цифре и что делал помимо) → итог с учётом комментариев.</p>`
    + list + more;

  bindPicker();
  bindDelegated();
}

function bindPicker() {
  const sel = $('#acc');
  if (sel && !sel._b) { sel._b = true; sel.addEventListener('change', () => loadReport(sel.value)); }
}

/* ------------------------------ карточка дня ----------------------------- */
function mergedDay(day) {
  return mergeAccountantFeedback(day, S.reportsByDate.get(day.date) || null);
}

function metricRow(m, date, notes) {
  const st = SERVICE_TYPES[m.category] || { label: m.category, icon: '•', unit: 'шт' };
  const note = notes[m.category] || {};
  const key = `${date}|${m.category}`;
  const feed = S.feed.get(key);
  const expanded = S.expanded.has(key);
  const disputed = !!note.disputed;
  const accCount = note.accountant_count;
  return `<div class="metric${disputed ? ' disp' : ''}">
    <div class="metric-main">
      <span class="metric-name">${st.icon} ${esc(st.label)}</span>
      <span class="metric-nums"><b class="cnt">${m.count}</b> ${esc(st.unit)}
        · <span class="time">${fmtMinutes(m.minutes)}</span>
        <span class="muted">(${m.count} × ${m.minutesPerUnit} мин)</span></span>
      <button class="btn sm" data-drill data-date="${date}" data-cat="${m.category}">${expanded ? '▾ скрыть' : '▸ показать за что'}</button>
    </div>
    <div class="fb-row">
      <label class="disp-lab"><input type="checkbox" data-disp data-cat="${m.category}" ${disputed ? 'checked' : ''}> цифра неверна</label>
      <input type="number" min="0" placeholder="верная цифра" value="${accCount != null ? accCount : ''}" data-count data-cat="${m.category}">
      <input type="text" placeholder="комментарий к этой цифре…" value="${esc(note.comment || '')}" data-comment data-cat="${m.category}">
    </div>
    ${expanded ? `<div class="feed">${
      !feed || feed.loading ? '<p class="muted">Загрузка документов…</p>'
      : feed.error ? `<p class="empty red">Ошибка: ${esc(feed.error)}</p>`
      : !feed.rows.length ? '<p class="muted">Документов не найдено.</p>'
      : `<div class="feed-head">${feed.rows.length}${feed.rows.length >= 400 ? '+, первые' : ''} документ(ов):</div>`
        + feed.rows.map(feedLine).join('')
    }</div>` : ''}
  </div>`;
}

function feedLine(t) {
  const money = fmtMoney(t.amount, t.currency);
  const comp = t.company ? `<span class="feed-comp">${esc(t.company)}</span>` : '';
  const detail = t.detail ? ` — ${esc(t.detail)}` : '';
  const sum = money ? ` <span class="sum">${money}</span>` : '';
  const stt = t.status ? ` <span class="muted">${esc(t.status)}</span>` : '';
  return `<div class="feed-line ${t.system === 'ArmSoft' ? 'arm' : 'tax'}">${comp}<span>${esc(t.title)}${detail}${sum}${stt}</span></div>`;
}

function dayCard(day) {
  const md = mergedDay(day);
  const stMeta = DAY_REPORT_STATUSES[md.status] || DAY_REPORT_STATUSES.pending;
  const notes = md.metricNotes || {};
  const fb = md.feedback;
  return `<div class="day" id="day-${day.date}">
    <div class="day-head">
      <div class="day-date">${fmtDate(day.date)}<span class="badge ${stMeta.color}">${stMeta.label}</span></div>
      <div class="day-total">по отчёту Артёма: <b>${fmtHours(day.totalMinutes)}</b> <span class="muted">(${day.totalCount} действ.)</span></div>
    </div>

    <div class="metrics">${day.metrics.map((m) => metricRow(m, day.date, notes)).join('')}</div>

    <div class="day-sum">Итог по отчёту системы (Артём): <b>${fmtHours(day.totalMinutes)}</b>
      <span class="muted">= ${fmtMinutes(day.totalMinutes)}</span></div>

    <div class="feedback">
      <label class="confirm"><input type="checkbox" data-confirm ${md.countsConfirmed ? 'checked' : ''}>
        Подтверждаю цифры Артёма (кол-во компаний, счетов, отчётов)</label>

      <label>Что делал помимо учтённого времени — по строке на действие, формат «описание | минуты»:</label>
      <textarea data-extra rows="3" placeholder="Например: консультация клиента по НДС | 30">${esc(formatExtra(md.extraWork))}</textarea>

      <label>Общий комментарий бухгалтера за день:</label>
      <textarea data-daycomment rows="2" placeholder="Свободный комментарий…">${esc(fb && fb.accountant_comment || '')}</textarea>

      <div class="grand">Итого с учётом комментариев бухгалтера: <b>${fmtHours(md.grandTotalMinutes)}</b>
        <span class="muted">(отчёт Артёма ${fmtMinutes(day.totalMinutes)} + дописано ${fmtMinutes(md.extraMinutes)})</span></div>

      <div class="actions">
        <label style="display:inline-flex;align-items:center;gap:6px;font-weight:600;">Статус:
          <select data-status>${Object.entries(DAY_REPORT_STATUSES).map(([k, v]) =>
            `<option value="${k}" ${md.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
        </label>
        <button class="btn primary sm" data-save data-date="${day.date}">Сохранить день</button>
        ${fb && fb.confirmed_at ? `<span class="muted">сохранено ${fmtDateTime(fb.updated_at || fb.confirmed_at)}</span>` : ''}
      </div>
    </div>
  </div>`;
}

/* extra_work [{desc,minutes}] ↔ текст «описание | минуты» */
function formatExtra(arr) {
  return (Array.isArray(arr) ? arr : []).map((w) => `${w.desc || ''} | ${w.minutes || 0}`).join('\n');
}
function parseExtra(text) {
  return String(text || '').split('\n').map((line) => {
    const t = line.trim(); if (!t) return null;
    const i = t.lastIndexOf('|');
    if (i < 0) return { desc: t, minutes: 0 };
    const desc = t.slice(0, i).trim();
    const minutes = parseInt(t.slice(i + 1).replace(/[^0-9]/g, ''), 10) || 0;
    return desc ? { desc, minutes } : null;
  }).filter(Boolean);
}

/* --------------------------- перерисовка карточки ------------------------ */
function rerenderDay(date) {
  const day = S.report.days.find((x) => x.date === date);
  const el = document.getElementById('day-' + date);
  if (day && el) el.outerHTML = dayCard(day);
}

/* ------------------------------ обработчики ------------------------------ */
function bindDelegated() {
  const root = $('#root');
  if (root._bound) return;
  root._bound = true;
  root.addEventListener('click', async (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { S.shown += 14; render(); return; }
    const letterBtn = e.target.closest('[data-letter]');
    if (letterBtn) { buildLetter(); return; }
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      const ta = $('#letter');
      try { await navigator.clipboard.writeText(ta.value); toast('Скопировано ✓'); }
      catch { ta.select(); document.execCommand('copy'); toast('Скопировано ✓'); }
      return;
    }
    const drill = e.target.closest('[data-drill]');
    if (drill) { toggleFeed(drill.dataset.date, drill.dataset.cat); return; }
    const save = e.target.closest('[data-save]');
    if (save) { saveDay(save.dataset.date); return; }
  });
}

async function toggleFeed(date, category) {
  const key = `${date}|${category}`;
  if (S.expanded.has(key)) { S.expanded.delete(key); rerenderDay(date); return; }
  S.expanded.add(key);
  if (!S.feed.has(key)) {
    S.feed.set(key, { loading: true, rows: [] });
    rerenderDay(date);
    try {
      const rows = await fetchAccountantDayFeed(S.bridge.armIds, S.bridge.tins, date, category, 400);
      S.feed.set(key, { loading: false, rows });
    } catch (err) {
      S.feed.set(key, { loading: false, rows: [], error: err.message });
    }
  }
  rerenderDay(date);
}

async function saveDay(date) {
  const card = document.getElementById('day-' + date);
  if (!card) return;
  const day = S.report.days.find((x) => x.date === date);

  const metric_notes = {};
  card.querySelectorAll('[data-comment]').forEach((el) => {
    const cat = el.dataset.cat;
    if (el.value.trim()) { metric_notes[cat] = metric_notes[cat] || {}; metric_notes[cat].comment = el.value.trim(); }
  });
  card.querySelectorAll('[data-count]').forEach((el) => {
    const cat = el.dataset.cat;
    if (el.value !== '') { metric_notes[cat] = metric_notes[cat] || {}; metric_notes[cat].accountant_count = parseInt(el.value, 10); }
  });
  card.querySelectorAll('[data-disp]').forEach((el) => {
    const cat = el.dataset.cat;
    if (el.checked) { metric_notes[cat] = metric_notes[cat] || {}; metric_notes[cat].disputed = true; }
  });

  const status = card.querySelector('[data-status]').value;
  const row = {
    accountant_name: S.accountant,
    report_date: date,
    status,
    counts_confirmed: card.querySelector('[data-confirm]').checked,
    accountant_comment: card.querySelector('[data-daycomment]').value.trim() || null,
    metric_notes,
    extra_work: parseExtra(card.querySelector('[data-extra]').value),
    export_minutes: day ? day.totalMinutes : null,
    confirmed_at: status === 'confirmed' ? new Date().toISOString() : null,
  };
  try {
    const saved = await saveDayReport(row);
    S.reportsByDate.set(date, saved);
    toast('День сохранён ✓');
    rerenderDay(date);
  } catch (e) {
    toast('Ошибка сохранения: ' + e.message, true);
  }
}

/* ------------------------- письмо Артёму --------------------------------- */
function buildLetter() {
  const b = S.bridge;
  if (!b) { toast('Сначала выберите бухгалтера', true); return; }
  const active = b.companies.filter((c) => c.is_active);
  const noExport = active.filter((c) => !c.in_taxservice && !c.in_armsoft);
  const noWork = active.filter((c) => (c.in_taxservice || c.in_armsoft) && !c.has_work);

  const disputed = [];
  for (const [date, fb] of S.reportsByDate) {
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

  S.letter = L.join('\n');
  render();
  toast('Письмо сформировано ✓');
}
