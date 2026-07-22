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
  const [clients, tax, armsoft, artem, comments, activities, exportMeta, exportDates, exportVolume, armActivity, taxActivity] = await Promise.all([
    fetchAll('ob_accounting_companies', 'id'),
    fetchAll('v_tax_accounts', 'id'),
    fetchAll('v_armsoft_companies', 'company_id'),
    fetchAll('artem_companies', 'id'),
    fetchAll('accountant_daily_comments', 'id'),
    // активности нужны только как признак «по компании была работа» + дата последней работы
    fetchAll('accounting_activities', 'id', 'company_name,activity_date,system_source,accountant_name'),
    sb.from('v_artyom_export_meta').select('*').maybeSingle().then(({ data }) => data),
    // история выгрузок Артёма по датам (для графика «все выгрузки за всё время»)
    fetchAll('v_artyom_export_dates', 'run_date'),
    // реальный объём выгрузки по всему проекту OB Artyom (все наборы данных,
    // а не только справочники компаний) — точное число строк по каждому набору
    fetchAll('v_artyom_export_volume', 'source_table'),
    // РЕАЛЬНАЯ работа по компаниям из выгрузки Артёма (сводка):
    //   ArmSoft — по company_id (счета выданные/полученные, дата посл. документа)
    //   TaxService — по ИНН/tin (сданные отчёты, налоговые счета, дата активности)
    // Мост к клиентам OB строит фронтенд: tin берётся из налогового совпадения,
    // company_id — из ArmSoft-совпадения (см. accountants.js).
    fetchAll('v_ob_arm_activity', 'company_id').catch((e) => { console.error(e); return []; }),
    fetchAll('v_ob_tax_activity', 'tin').catch((e) => { console.error(e); return []; }),
  ]);
  // индексы «реальной работы» для быстрого доступа по ключу совпадения
  const armActivityById = new Map(armActivity.map((r) => [r.company_id, r]));
  const taxActivityByTin = new Map(taxActivity.map((r) => [normalizeHvhh(r.tin), r]));
  return {
    clients, tax, armsoft, artem, comments, activities, exportMeta, exportDates, exportVolume,
    armActivity, taxActivity, armActivityById, taxActivityByTin,
  };
}

/**
 * Список конкретных задач одной компании (drill-down на странице «Бухгалтеры»):
 * последние документы/отчёты из выгрузки Артёма. Читается через SECURITY DEFINER
 * RPC ob_company_task_feed. armId — company_id ArmSoft; tin — ИНН налогового
 * кабинета; любой из них может быть null (тогда берётся только вторая система).
 */
async function fetchCompanyTaskFeed(armId, tin, limit = 120) {
  const { data, error } = await sb.rpc('ob_company_task_feed', {
    p_armsoft_company_id: armId ?? null,
    p_tin: tin || null,
    p_limit: limit,
  });
  if (error) throw new Error('ob_company_task_feed: ' + error.message);
  return data || [];
}

/* ----------------------------------------------------------------------------
 * Дневной отчёт по одному бухгалтеру (страница «Отчёт по дням»).
 * armIds/tins — company_id ArmSoft и ИНН налогового кабинета компаний
 * бухгалтера (мост строит фронтенд, см. accountants.js / dailyreport.js).
 * -------------------------------------------------------------------------- */

/** Счётчики работы по дню и типу услуги (RPC ob_accountant_daily_activity) */
async function fetchAccountantDailyActivity(armIds, tins, from = null, to = null) {
  const { data, error } = await sb.rpc('ob_accountant_daily_activity', {
    p_company_ids: armIds && armIds.length ? armIds : [],
    p_tins: tins && tins.length ? tins : [],
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error('ob_accountant_daily_activity: ' + error.message);
  return data || [];
}

/**
 * ПОЛНЫЕ счётчики работы по дню и категории по ВСЕМ разделам выгрузки Артёма
 * (26 категорий: счета/накладные/касса/сверки/проводки/НДС/зарплата/ЕАЭС/пени…).
 * RPC ob_accountant_activity_full — см. sql/2026-07-22_morning_calls_full_activity.sql.
 * Возвращает [{ activity_date, system, category, cnt }].
 */
async function fetchAccountantActivityFull(armIds, tins, from = null, to = null) {
  const { data, error } = await sb.rpc('ob_accountant_activity_full', {
    p_company_ids: armIds && armIds.length ? armIds : [],
    p_tins: tins && tins.length ? tins : [],
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error('ob_accountant_activity_full: ' + error.message);
  return data || [];
}

/** Конкретные документы за день и КАТЕГОРИЮ по всем разделам (drill «за что») */
async function fetchAccountantDayFeedFull(armIds, tins, day, category = null, limit = 400) {
  const { data, error } = await sb.rpc('ob_accountant_day_feed_full', {
    p_company_ids: armIds && armIds.length ? armIds : [],
    p_tins: tins && tins.length ? tins : [],
    p_day: day,
    p_category: category,
    p_limit: limit,
  });
  if (error) throw new Error('ob_accountant_day_feed_full: ' + error.message);
  return data || [];
}

/** Конкретные документы за один день и тип услуги (drill «показать за что») */
async function fetchAccountantDayFeed(armIds, tins, day, category = null, limit = 400) {
  const { data, error } = await sb.rpc('ob_accountant_day_feed', {
    p_company_ids: armIds && armIds.length ? armIds : [],
    p_tins: tins && tins.length ? tins : [],
    p_day: day,
    p_category: category,
    p_limit: limit,
  });
  if (error) throw new Error('ob_accountant_day_feed: ' + error.message);
  return data || [];
}

/** Сохранённая обратная связь бухгалтера по дням (для выбранного бухгалтера) */
async function loadDayReports(accountant) {
  let q = sb.from('accountant_day_reports').select('*');
  if (accountant) q = q.eq('accountant_name', accountant);
  const { data, error } = await q.order('report_date', { ascending: false });
  if (error) throw new Error('accountant_day_reports: ' + error.message);
  return data || [];
}

/** Сохранить/обновить обратную связь бухгалтера за день (upsert по паре бухгалтер+дата) */
async function saveDayReport(row) {
  const { data, error } = await sb
    .from('accountant_day_reports')
    .upsert(row, { onConflict: 'accountant_name,report_date' })
    .select()
    .single();
  if (error) throw new Error('accountant_day_reports upsert: ' + error.message);
  return data;
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

/* ----------------------------------------------------------------------------
 * Синхронизация задач бухгалтеров с выгрузкой Артёма.
 * -------------------------------------------------------------------------- */

/** Статус графика выгрузки Артёма (4 состояния) — из SQL-функции */
async function loadExportStatus() {
  const { data, error } = await sb.from('v_artyom_export_status').select('*').maybeSingle();
  if (error) throw new Error('v_artyom_export_status: ' + error.message);
  return data;
}

async function loadTaskSync() {
  return fetchAll('accountant_task_sync', 'id');
}

async function loadSyncProblems() {
  return fetchAll('sync_problems', 'id');
}

/**
 * Сохранение результатов сверки задач. Как и в delta_items: upsert по task_key,
 * поля самопроверки бухгалтера (accountant_response*, accountant_confirmed,
 * accountant_checked_at, reviewer_note) НЕ трогаются — они не входят в payload.
 * Исчезнувшие задачи получают resolved_at; вернувшиеся — переоткрываются.
 */
async function syncTaskSyncRows(computedTasks, existing) {
  const today = todayStr();
  const nowIso = new Date().toISOString();
  const seen = new Set();
  const items = computedTasks.filter((t) => (seen.has(t.task_key) ? false : (seen.add(t.task_key), true)));

  const payload = items.map((t) => ({
    task_key: t.task_key,
    sync_date: today,
    resolved_at: null,
    accountant_name: t.accountant_name || null,
    company_name: t.company_name,
    hvhh: t.hvhh || null,
    system_source: t.system_source || null,
    task_type: t.task_type || null,
    task_type_label: t.task_type_label || null,
    work_summary: t.work_summary || null,
    last_task_date: t.last_task_date || null,
    in_artyom_export: !!t.in_artyom_export,
    match_quality: t.match_quality || 'none',
    not_expected_in_export: !!t.not_expected_in_export,
    status: t.status,
    problem_type: t.problem_type || null,
    problem_description: t.problem_description || null,
  }));

  const CHUNK = 400;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const { error } = await sb.from('accountant_task_sync')
      .upsert(payload.slice(i, i + CHUNK), { onConflict: 'task_key' });
    if (error) throw new Error('accountant_task_sync upsert: ' + error.message);
  }

  const keys = new Set(items.map((t) => t.task_key));
  const toResolve = existing.filter((r) => !r.resolved_at && !keys.has(r.task_key)).map((r) => r.id);
  for (let i = 0; i < toResolve.length; i += CHUNK) {
    const { error } = await sb.from('accountant_task_sync')
      .update({ resolved_at: nowIso }).in('id', toResolve.slice(i, i + CHUNK));
    if (error) throw new Error('accountant_task_sync resolve: ' + error.message);
  }
}

/** Сохранение списка проблем сверки. upsert по problem_key; статус разбора
 *  (status/resolved_at) не перетирается — не входит в payload. */
async function syncProblemRows(computedProblems, existing) {
  const seen = new Set();
  const items = computedProblems.filter((p) => (seen.has(p.problem_key) ? false : (seen.add(p.problem_key), true)));
  const payload = items.map((p) => ({
    problem_key: p.problem_key,
    category: p.category,
    severity: p.severity || 'medium',
    title: p.title,
    description: p.description || null,
    accountant_name: p.accountant_name || null,
    company_name: p.company_name || null,
    source: p.source || null,
    detected_date: p.detected_date || null,
  }));
  const CHUNK = 400;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const { error } = await sb.from('sync_problems')
      .upsert(payload.slice(i, i + CHUNK), { onConflict: 'problem_key' });
    if (error) throw new Error('sync_problems upsert: ' + error.message);
  }
}

async function updateTaskSyncItem(id, fields) {
  const { data, error } = await sb.from('accountant_task_sync').update(fields).eq('id', id).select().single();
  if (error) throw new Error('accountant_task_sync update: ' + error.message);
  return data;
}

async function updateSyncProblem(id, fields) {
  const { data, error } = await sb.from('sync_problems').update(fields).eq('id', id).select().single();
  if (error) throw new Error('sync_problems update: ' + error.message);
  return data;
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
