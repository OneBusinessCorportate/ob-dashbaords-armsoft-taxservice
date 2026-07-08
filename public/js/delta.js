/* =============================================================================
 * Движок расчёта расхождений (дельты) между системами.
 *
 * Сопоставление всегда: сначала ՀՎՀՀ → затем нормализованное название →
 * затем нечёткое совпадение (помечается как fuzzy, отдельно от точных).
 * ========================================================================== */

/**
 * Главная функция: принимает исходные данные, возвращает
 * { items, counts, clientCtxs, activityByName }.
 */
function computeDelta(src) {
  const { clients, tax, armsoft, artem, comments, activities } = src;

  // --- индексы систем -------------------------------------------------------
  const taxIndex = buildIndex(tax, ['client_name_ru', 'org_name_hy'], 'tin');
  const armIndex = buildIndex(armsoft, ['caption', 'name'], null);
  const artemIndex = buildIndex(artem, ['company_name'], 'tin');
  const clientIndex = buildIndex(clients, ['company_name'], null);

  // быстрый доступ по ID-связям из реестра клиентов
  const taxById = new Map(tax.map((t) => [t.id, t]));
  const armById = new Map(armsoft.map((a) => [a.company_id, a]));

  // --- признак «по компании была работа» + дата последней активности --------
  const activityByName = new Map(); // normName -> { lastDate, systems:Set }
  for (const a of activities) {
    const n = normalizeName(a.company_name);
    if (!n) continue;
    const cur = activityByName.get(n) || { lastDate: null, systems: new Set() };
    if (!cur.lastDate || a.activity_date > cur.lastDate) cur.lastDate = a.activity_date;
    cur.systems.add(a.system_source);
    activityByName.set(n, cur);
  }

  // --- упоминания на утренних встречах --------------------------------------
  const mentionByName = new Map(); // normName -> { lastDate, accountant, comment }
  for (const c of comments) {
    const n = normalizeName(c.company_name);
    if (!n) continue;
    const cur = mentionByName.get(n);
    if (!cur || c.comment_date > cur.lastDate) {
      mentionByName.set(n, {
        name: c.company_name,
        lastDate: c.comment_date,
        accountant: c.accountant_name || c.accountant_email || '',
        comment: c.comment || '',
      });
    }
  }

  const items = [];
  const clientCtxs = []; // контекст каждого клиента (для сводки и отладки правил)

  /** Хелпер: собрать объект расхождения */
  function makeItem(issueType, companyName, extra) {
    const meta = ISSUE_TYPES[issueType];
    const key = `${issueType}|${normalizeHvhh(extra.hvhh) || normalizeName(companyName)}`;
    return {
      issue_key: key,
      issue_type: issueType,
      company_name: companyName,
      expected_system: meta.expected,
      missing_from_system: meta.missingFrom,
      source_table: meta.source,
      possible_reason: extra.possible_reason || meta.reason,
      hvhh: extra.hvhh || null,
      accountant_name: extra.accountant_name || null,
      client_is_active: extra.client_is_active ?? null,
      exists_in_taxservice: !!extra.exists_in_taxservice,
      exists_in_armsoft: !!extra.exists_in_armsoft,
      exists_in_artyom_export: !!extra.exists_in_artyom_export,
      exists_in_morning_meeting: !!extra.exists_in_morning_meeting,
      match_quality: extra.match_quality || 'none',
      last_activity_date: extra.last_activity_date || null, // только для отображения
    };
  }

  const enabled = new Set(RULES.ENABLED_ISSUE_TYPES);

  // ==========================================================================
  // 1–2. Прямые проверки по реестру клиентов: должен быть в TaxService / ArmSoft
  // ==========================================================================
  for (const client of clients) {
    const names = [client.company_name];

    // связь по ID приоритетнее совпадения по названию
    let taxMatch;
    if (client.tax_account_id != null && taxById.has(client.tax_account_id)) {
      taxMatch = { found: true, entity: taxById.get(client.tax_account_id), quality: 'exact_hvhh' };
    } else {
      taxMatch = findMatch(taxIndex, { hvhh: null, names });
    }

    let armMatch;
    if (client.armsoft_company_id != null && armById.has(client.armsoft_company_id)) {
      armMatch = { found: true, entity: armById.get(client.armsoft_company_id), quality: 'exact_hvhh' };
    } else {
      armMatch = findMatch(armIndex, { hvhh: null, names });
    }

    // ՀՎՀՀ клиента восстанавливаем из TaxService или из списка Артёма
    let hvhh = taxMatch.found ? taxMatch.entity.tin : null;
    let artemMatch = findMatch(artemIndex, { hvhh, names });
    if (!hvhh && artemMatch.found) hvhh = artemMatch.entity.tin;

    const norm = normalizeName(client.company_name);
    const mention = mentionByName.get(norm) || null;
    const activity = activityByName.get(norm) || null;

    const ctx = { client, hvhh, taxMatch, armMatch, artemMatch, mention, activity };
    clientCtxs.push(ctx);

    const common = {
      hvhh,
      accountant_name: client.accountant_name,
      client_is_active: client.is_active,
      exists_in_taxservice: taxMatch.found && taxMatch.quality !== 'fuzzy',
      exists_in_armsoft: armMatch.found && armMatch.quality !== 'fuzzy',
      exists_in_artyom_export: artemMatch.found && artemMatch.quality !== 'fuzzy',
      exists_in_morning_meeting: !!mention,
      last_activity_date: activity ? activity.lastDate : null,
    };

    // fuzzy-совпадение НЕ считается найденным, но фиксируется как возможная причина
    if (enabled.has('missing_taxservice') && RULES.expectedInTaxService(ctx) && !common.exists_in_taxservice) {
      items.push(makeItem('missing_taxservice', client.company_name, {
        ...common,
        match_quality: taxMatch.quality,
        possible_reason: taxMatch.quality === 'fuzzy'
          ? `Возможное неточное совпадение в TaxService: «${taxMatch.entity.client_name_ru || taxMatch.entity.org_name_hy}» — проверить название`
          : undefined,
      }));
    }

    if (enabled.has('missing_armsoft') && RULES.expectedInArmsoft(ctx) && !common.exists_in_armsoft) {
      items.push(makeItem('missing_armsoft', client.company_name, {
        ...common,
        match_quality: armMatch.quality,
        possible_reason: armMatch.quality === 'fuzzy'
          ? `Возможное неточное совпадение в ArmSoft: «${armMatch.entity.caption || armMatch.entity.name}» — проверить название`
          : undefined,
      }));
    }
  }

  // ==========================================================================
  // 3. Есть в TaxService, но нет в выгрузке Артёма
  // ==========================================================================
  if (enabled.has('tax_not_in_artem')) {
    for (const t of tax) {
      const names = [t.client_name_ru, t.org_name_hy];
      const am = findMatch(artemIndex, { hvhh: t.tin, names });
      if (am.found && am.quality !== 'fuzzy') continue;
      const cm = findMatch(clientIndex, { hvhh: null, names });
      const client = cm.found ? cm.entity : null;
      items.push(makeItem('tax_not_in_artem', t.client_name_ru || t.org_name_hy || ('ՀՎՀՀ ' + t.tin), {
        hvhh: t.tin,
        accountant_name: client ? client.accountant_name : null,
        client_is_active: client ? client.is_active : null,
        exists_in_taxservice: true,
        exists_in_armsoft: false,
        exists_in_artyom_export: false,
        exists_in_morning_meeting: mentionByName.has(normalizeName(t.client_name_ru)),
        match_quality: am.quality,
        possible_reason: am.quality === 'fuzzy'
          ? `Возможное неточное совпадение в выгрузке Артёма: «${am.entity.company_name}»`
          : undefined,
      }));
    }
  }

  // ==========================================================================
  // 4. Есть в ArmSoft, но нет в выгрузке Артёма
  // ==========================================================================
  if (enabled.has('armsoft_not_in_artem')) {
    for (const a of armsoft) {
      const names = [a.caption, a.name];
      const am = findMatch(artemIndex, { hvhh: null, names });
      if (am.found && am.quality !== 'fuzzy') continue;
      const cm = findMatch(clientIndex, { hvhh: null, names });
      const client = cm.found ? cm.entity : null;
      items.push(makeItem('armsoft_not_in_artem', a.caption || a.name, {
        hvhh: null,
        accountant_name: client ? client.accountant_name : null,
        client_is_active: client ? client.is_active : null,
        exists_in_taxservice: false,
        exists_in_armsoft: true,
        exists_in_artyom_export: false,
        exists_in_morning_meeting: mentionByName.has(normalizeName(a.caption)),
        match_quality: am.quality,
        possible_reason: am.quality === 'fuzzy'
          ? `Возможное неточное совпадение в выгрузке Артёма: «${am.entity.company_name}»`
          : undefined,
      }));
    }
  }

  // ==========================================================================
  // 5. Упомянута бухгалтером на встрече, но нет в выгрузке Артёма
  // ==========================================================================
  if (enabled.has('meeting_not_in_artem')) {
    for (const [norm, m] of mentionByName) {
      const am = findMatch(artemIndex, { hvhh: null, names: [norm] });
      if (am.found && am.quality !== 'fuzzy') continue;
      const tm = findMatch(taxIndex, { hvhh: null, names: [norm] });
      const arm = findMatch(armIndex, { hvhh: null, names: [norm] });
      items.push(makeItem('meeting_not_in_artem', m.name || norm, {
        hvhh: tm.found && tm.quality !== 'fuzzy' ? tm.entity.tin : null,
        accountant_name: m.accountant,
        client_is_active: null,
        exists_in_taxservice: tm.found && tm.quality !== 'fuzzy',
        exists_in_armsoft: arm.found && arm.quality !== 'fuzzy',
        exists_in_artyom_export: false,
        exists_in_morning_meeting: true,
        match_quality: am.quality,
        last_activity_date: m.lastDate,
        possible_reason: am.quality === 'fuzzy'
          ? `Возможное неточное совпадение в выгрузке Артёма: «${am.entity.company_name}»`
          : undefined,
      }));
    }
  }

  // ==========================================================================
  // 6. В выгрузке Артёма, но работа бухгалтера не подтверждена
  //    (нет ни активности в системах, ни упоминания на встрече)
  // ==========================================================================
  if (enabled.has('artem_without_work')) {
    for (const a of artem) {
      const norm = normalizeName(a.company_name);
      const hasActivity = activityByName.has(norm);
      const hasMention = mentionByName.has(norm);
      if (hasActivity || hasMention) continue;
      const cm = findMatch(clientIndex, { hvhh: null, names: [a.company_name] });
      const tm = findMatch(taxIndex, { hvhh: a.tin, names: [a.company_name] });
      const arm = findMatch(armIndex, { hvhh: null, names: [a.company_name] });
      items.push(makeItem('artem_without_work', a.company_name, {
        hvhh: a.tin,
        accountant_name: cm.found ? cm.entity.accountant_name : null,
        client_is_active: cm.found ? cm.entity.is_active : null,
        exists_in_taxservice: tm.found && tm.quality !== 'fuzzy',
        exists_in_armsoft: arm.found && arm.quality !== 'fuzzy',
        exists_in_artyom_export: true,
        exists_in_morning_meeting: false,
        match_quality: 'none',
      }));
    }
  }

  // ==========================================================================
  // Дедупликация по issue_key (два налоговых аккаунта с одним ՀՎՀՀ и т.п.),
  // чтобы счётчики совпадали с тем, что сохранится в delta_items
  // ==========================================================================
  const seenKeys = new Set();
  const deduped = items.filter((it) =>
    seenKeys.has(it.issue_key) ? false : (seenKeys.add(it.issue_key), true));
  items.length = 0;
  items.push(...deduped);

  // ==========================================================================
  // Сводные показатели для дневного снимка
  // ==========================================================================
  const active = clientCtxs.filter((c) => c.client.is_active);
  const expectedTax = active.filter((c) => RULES.expectedInTaxService(c));
  const expectedArm = active.filter((c) => RULES.expectedInArmsoft(c));
  const foundTax = expectedTax.filter((c) => c.taxMatch.found && c.taxMatch.quality !== 'fuzzy');
  const foundArm = expectedArm.filter((c) => c.armMatch.found && c.armMatch.quality !== 'fuzzy');

  const totalDeltaTypes = new Set(RULES.TOTAL_DELTA_TYPES);
  const counts = {
    total_active_clients: active.length,
    active_with_hvhh: active.filter((c) => !!c.hvhh).length,
    expected_taxservice: expectedTax.length,
    found_taxservice: foundTax.length,
    missing_taxservice: expectedTax.length - foundTax.length,
    expected_armsoft: expectedArm.length,
    found_armsoft: foundArm.length,
    missing_armsoft: expectedArm.length - foundArm.length,
    total_delta: items.filter((it) => totalDeltaTypes.has(it.issue_type)).length,
  };

  return { items, counts, clientCtxs, activityByName, mentionByName };
}
