/* =============================================================================
 * Слой данных: Supabase-клиент, загрузка исходных таблиц,
 * сохранение снимков/расхождений/статусов проверки.
 * ========================================================================== */

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

/** Сегодняшняя дата (YYYY-MM-DD) в часовом поясе бизнеса */
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TIMEZONE }).format(new Date());
}

/**
 * Загрузка всех строк таблицы с постраничным обходом (PostgREST отдаёт
 * максимум 1000 за раз). orderCol обязателен: без явного ORDER BY порядок
 * строк между страницами не гарантирован, и при пагинации строки могут
 * задублироваться или потеряться.
 */
async function fetchAll(table, orderCol, select = '*') {
  const PAGE = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .order(orderCol, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

/** Параллельная загрузка всех исходных данных дашборда */
async function loadSourceData() {
  const [clients, tax, armsoft, artem, comments, activities, exportMeta] = await Promise.all([
    fetchAll('ob_accounting_companies', 'id'),
    fetchAll('v_tax_accounts', 'id'),
    fetchAll('v_armsoft_companies', 'company_id'),
    fetchAll('artem_companies', 'id'),
    fetchAll('accountant_daily_comments', 'id'),
    // активности нужны только как признак «по компании была работа» + дата последней работы
    fetchAll('accounting_activities', 'id', 'company_name,activity_date,system_source,accountant_name'),
    sb.from('v_artyom_export_meta').select('*').maybeSingle().then(({ data }) => data),
  ]);
  return { clients, tax, armsoft, artem, comments, activities, exportMeta };
}

/** Загрузка сохранённых расхождений (весь реестр, вкл. решённые — для карточек динамики) */
async function loadDeltaItems() {
  return fetchAll('delta_items', 'id');
}

async function loadSnapshots() {
  const rows = await fetchAll('daily_delta_snapshots', 'snapshot_date');
  return rows.reverse(); // новые даты первыми — так их ждут таблица и upsertSnapshot
}

async function loadTzItems() {
  const rows = await fetchAll('artyom_tz_items', 'id');
  return rows.reverse(); // новые первыми
}

/* ----------------------------------------------------------------------------
 * Синхронизация вычисленных расхождений с таблицей delta_items.
 *
 * Логика сохранения (чтобы результаты проверки Эмилии не терялись):
 *  - upsert по issue_key: обновляются только «вычисляемые» поля, поля проверки
 *    (confirmation_status, comment, responsible_person, priority) не трогаются;
 *  - snapshot_date (дата первого обнаружения) у существующих строк сохраняется;
 *  - расхождения, которые исчезли из расчёта, получают resolved_at (закрыты);
 *  - если закрытое расхождение появилось снова — оно переоткрывается (resolved_at=null).
 * -------------------------------------------------------------------------- */
async function syncDeltaItems(computedItems, existingItems) {
  const today = todayStr();
  const nowIso = new Date().toISOString();
  const existingByKey = new Map(existingItems.map((r) => [r.issue_key, r]));

  // защита от дублей issue_key в одном пакете (например, два налоговых
  // аккаунта с одинаковым ՀՎՀՀ) — upsert не может обновить строку дважды
  const seenKeys = new Set();
  computedItems = computedItems.filter((it) =>
    seenKeys.has(it.issue_key) ? false : (seenKeys.add(it.issue_key), true));

  const payload = computedItems.map((it) => {
    const prev = existingByKey.get(it.issue_key);
    return {
      issue_key: it.issue_key,
      snapshot_date: prev ? prev.snapshot_date : today,
      last_seen_date: today,
      resolved_at: null,
      company_name: it.company_name,
      hvhh: it.hvhh || null,
      accountant_name: it.accountant_name || null,
      client_is_active: it.client_is_active ?? null,
      issue_type: it.issue_type,
      expected_system: it.expected_system,
      missing_from_system: it.missing_from_system,
      exists_in_taxservice: !!it.exists_in_taxservice,
      exists_in_armsoft: !!it.exists_in_armsoft,
      exists_in_artyom_export: !!it.exists_in_artyom_export,
      exists_in_ob_registry: !!it.exists_in_ob_registry,
      exists_in_morning_meeting: !!it.exists_in_morning_meeting,
      match_quality: it.match_quality || 'none',
      possible_reason: it.possible_reason || null,
      source_table: it.source_table || null,
    };
  });

  // upsert пакетами, чтобы не упереться в лимиты запроса
  const CHUNK = 400;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const { error } = await sb
      .from('delta_items')
      .upsert(payload.slice(i, i + CHUNK), { onConflict: 'issue_key' });
    if (error) throw new Error('delta_items upsert: ' + error.message);
  }

  // закрываем исчезнувшие расхождения
  const computedKeys = new Set(computedItems.map((it) => it.issue_key));
  const toResolve = existingItems
    .filter((r) => !r.resolved_at && !computedKeys.has(r.issue_key))
    .map((r) => r.id);
  for (let i = 0; i < toResolve.length; i += CHUNK) {
    const { error } = await sb
      .from('delta_items')
      .update({ resolved_at: nowIso })
      .in('id', toResolve.slice(i, i + CHUNK));
    if (error) throw new Error('delta_items resolve: ' + error.message);
  }
}

/** Запись/обновление дневного снимка (одна строка на дату) */
async function upsertSnapshot(counts, exportMeta, artemCount, snapshots) {
  const today = todayStr();
  const prev = snapshots.find((s) => s.snapshot_date < today); // список отсортирован по убыванию
  const row = {
    snapshot_date: today,
    ...counts,
    previous_delta: prev ? prev.total_delta : null,
    delta_change: prev ? counts.total_delta - prev.total_delta : null,
    artyom_export_time: exportMeta?.last_export_time || null,
    artyom_export_records: artemCount,
  };
  const { error } = await sb.from('daily_delta_snapshots').upsert(row, { onConflict: 'snapshot_date' });
  if (error) throw new Error('snapshot upsert: ' + error.message);
}

/** Обновление полей проверки (workflow Эмилии) у одного расхождения */
async function updateDeltaItem(id, fields) {
  const { data, error } = await sb.from('delta_items').update(fields).eq('id', id).select().single();
  if (error) throw new Error('delta_items update: ' + error.message);
  return data;
}

/**
 * Автосоздание задачи для Артёма, когда расхождение подтверждено
 * как «проблема выгрузки Артёма».
 */
async function ensureTzItem(deltaItem) {
  const meta = ISSUE_TYPES[deltaItem.issue_type] || {};
  const row = {
    delta_item_id: deltaItem.id,
    company_name: deltaItem.company_name,
    hvhh: deltaItem.hvhh,
    issue_description: `${meta.label || deltaItem.issue_type}. ${deltaItem.possible_reason || ''}`.trim(),
    expected_source: deltaItem.expected_system,
    actual_source: sourcesLine(deltaItem),
    date_detected: deltaItem.snapshot_date,
    priority: deltaItem.priority || 'medium',
    comment: deltaItem.comment || null,
  };
  const { error } = await sb.from('artyom_tz_items').upsert(row, { onConflict: 'delta_item_id' });
  if (error) throw new Error('artyom_tz_items upsert: ' + error.message);
}

async function updateTzItem(id, fields) {
  const { error } = await sb.from('artyom_tz_items').update(fields).eq('id', id);
  if (error) throw new Error('artyom_tz_items update: ' + error.message);
}

/** Строка «где компания реально существует» для карточек и ТЗ */
function sourcesLine(item) {
  const parts = [];
  if (item.exists_in_taxservice) parts.push('TaxService (выгрузка Артёма)');
  if (item.exists_in_armsoft) parts.push('ArmSoft (выгрузка Артёма)');
  if (item.exists_in_ob_registry) parts.push('Реестр OB');
  if (item.exists_in_morning_meeting) parts.push('Утренняя встреча');
  return parts.length ? parts.join(', ') : 'нигде из отслеживаемых';
}
