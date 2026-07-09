/* =============================================================================
 * Движок расчёта расхождений (дельты).
 *
 * МОДЕЛЬ ДАННЫХ (важно для понимания цифр):
 *   «Выгрузка Артёма» = данные, которые его парсеры разобрали в armsoft_db:
 *       TaxService → v_tax_accounts,  ArmSoft → v_armsoft_companies.
 *   Источник истины «наш активный клиент» = ob_accounting_companies.
 *
 *   Прямая дельта (уменьшается по мере выгрузок Артёма):
 *     - missing_taxservice: активный клиент OB не найден в налоговой выгрузке
 *     - missing_armsoft:    активный клиент OB (с armsoft-привязкой) не найден в ArmSoft
 *   Обратная дельта (что Артём выгрузил, но OB не ведёт как клиента):
 *     - tax_not_in_ob / armsoft_not_in_ob
 *   Встречи:
 *     - meeting_not_in_export: упомянута бухгалтером, нет в выгрузке Артёма
 *
 *   Таблица artem_companies (15 тестовых строк) в расчёте НЕ используется.
 *
 * Сопоставление всегда: ՀՎՀՀ → нормализованное название → нечёткое (fuzzy,
 * помечается отдельно, точным совпадением не считается).
 * ========================================================================== */

function computeDelta(src) {
  const { clients, tax, armsoft, comments, activities } = src;

  // --- индексы систем -------------------------------------------------------
  const taxIndex = buildIndex(tax, ['client_name_ru', 'org_name_hy'], 'tin');
  const armIndex = buildIndex(armsoft, ['caption', 'name'], null);
  const clientIndex = buildIndex(clients, ['company_name'], null);

  // быстрый доступ по ID-связям из реестра клиентов
  const taxById = new Map(tax.map((t) => [t.id, t]));
  const armById = new Map(armsoft.map((a) => [a.company_id, a]));

  // множества нормализованных названий/ID активных клиентов OB — для обратной дельты
  const obActiveNames = new Set();
  const obTaxIds = new Set();
  const obArmIds = new Set();
  for (const c of clients) {
    if (!c.is_active) continue;
    const n = normalizeName(c.company_name);
    if (n) obActiveNames.add(n);
    if (c.tax_account_id != null) obTaxIds.add(c.tax_account_id);
    if (c.armsoft_company_id != null) obArmIds.add(c.armsoft_company_id);
  }

  // --- признак «по компании была работа» + дата последней активности --------
  const activityByName = new Map();
  for (const a of activities) {
    const n = normalizeName(a.company_name);
    if (!n) continue;
    const cur = activityByName.get(n) || { lastDate: null, systems: new Set() };
    if (!cur.lastDate || a.activity_date > cur.lastDate) cur.lastDate = a.activity_date;
    cur.systems.add(a.system_source);
    activityByName.set(n, cur);
  }

  // --- упоминания на утренних встречах --------------------------------------
  const mentionByName = new Map();
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
  const clientCtxs = [];

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
      // «есть в выгрузке Артёма» = найдено хотя бы в одной из его систем
      exists_in_artyom_export: !!(extra.exists_in_taxservice || extra.exists_in_armsoft),
      exists_in_ob_registry: !!extra.exists_in_ob_registry,
      exists_in_morning_meeting: !!extra.exists_in_morning_meeting,
      match_quality: extra.match_quality || 'none',
      last_activity_date: extra.last_activity_date || null,
    };
  }

  const enabled = new Set(RULES.ENABLED_ISSUE_TYPES);

  // ==========================================================================
  // 1–2. Реестр OB → должен быть в выгрузке TaxService / ArmSoft Артёма
  // ==========================================================================
  for (const client of clients) {
    const names = [client.company_name];

    // связь по ID приоритетнее совпадения по названию
    let taxMatch;
    if (client.tax_account_id != null && taxById.has(client.tax_account_id)) {
      taxMatch = { found: true, entity: taxById.get(client.tax_account_id), quality: 'exact_id' };
    } else {
      taxMatch = findMatch(taxIndex, { hvhh: null, names });
    }

    let armMatch;
    if (client.armsoft_company_id != null && armById.has(client.armsoft_company_id)) {
      armMatch = { found: true, entity: armById.get(client.armsoft_company_id), quality: 'exact_id' };
    } else {
      armMatch = findMatch(armIndex, { hvhh: null, names });
    }

    // ՀՎՀՀ клиента восстанавливаем из TaxService (tin)
    const hvhh = taxMatch.found ? taxMatch.entity.tin : null;

    const norm = normalizeName(client.company_name);
    const mention = mentionByName.get(norm) || null;
    const activity = activityByName.get(norm) || null;

    const ctx = { client, hvhh, taxMatch, armMatch, mention, activity };
    clientCtxs.push(ctx);

    const common = {
      hvhh,
      accountant_name: client.accountant_name,
      client_is_active: client.is_active,
      exists_in_taxservice: taxMatch.found && taxMatch.quality !== 'fuzzy',
      exists_in_armsoft: armMatch.found && armMatch.quality !== 'fuzzy',
      exists_in_ob_registry: true,
      exists_in_morning_meeting: !!mention,
      last_activity_date: activity ? activity.lastDate : null,
    };

    // пропускаем явно мусорные строки реестра (#N/A и т.п.)
    if (RULES.isJunkName(client.company_name)) continue;

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
  // 3. Выгрузка TaxService Артёма → нет в реестре активных клиентов OB
  // ==========================================================================
  if (enabled.has('tax_not_in_ob')) {
    for (const t of tax) {
      if (obTaxIds.has(t.id)) continue; // явно привязан к клиенту OB
      const n = normalizeName(t.client_name_ru) || normalizeName(t.org_name_hy);
      if (n && obActiveNames.has(n)) continue; // совпал по названию
      const cm = findMatch(clientIndex, { hvhh: null, names: [t.client_name_ru, t.org_name_hy] });
      if (cm.found && cm.quality !== 'fuzzy') continue; // точное совпадение с любым клиентом
      items.push(makeItem('tax_not_in_ob', t.client_name_ru || t.org_name_hy || ('ՀՎՀՀ ' + t.tin), {
        hvhh: t.tin,
        accountant_name: cm.found ? cm.entity.accountant_name : null,
        client_is_active: cm.found ? cm.entity.is_active : null,
        exists_in_taxservice: true,
        exists_in_armsoft: false,
        exists_in_ob_registry: cm.found,
        exists_in_morning_meeting: mentionByName.has(n),
        match_quality: cm.quality,
        possible_reason: cm.quality === 'fuzzy'
          ? `Возможное неточное совпадение с клиентом OB: «${cm.entity.company_name}» — проверить название`
          : undefined,
      }));
    }
  }

  // ==========================================================================
  // 4. Выгрузка ArmSoft Артёма → нет в реестре активных клиентов OB
  // ==========================================================================
  if (enabled.has('armsoft_not_in_ob')) {
    for (const a of armsoft) {
      if (obArmIds.has(a.company_id)) continue;
      const n = normalizeName(a.caption) || normalizeName(a.name);
      if (n && obActiveNames.has(n)) continue;
      const cm = findMatch(clientIndex, { hvhh: null, names: [a.caption, a.name] });
      if (cm.found && cm.quality !== 'fuzzy') continue;
      items.push(makeItem('armsoft_not_in_ob', a.caption || a.name, {
        hvhh: null,
        accountant_name: cm.found ? cm.entity.accountant_name : null,
        client_is_active: cm.found ? cm.entity.is_active : null,
        exists_in_taxservice: false,
        exists_in_armsoft: true,
        exists_in_ob_registry: cm.found,
        exists_in_morning_meeting: mentionByName.has(n),
        match_quality: cm.quality,
        possible_reason: cm.quality === 'fuzzy'
          ? `Возможное неточное совпадение с клиентом OB: «${cm.entity.company_name}» — проверить название`
          : undefined,
      }));
    }
  }

  // ==========================================================================
  // 5. Упомянута бухгалтером на встрече, но нет в выгрузке Артёма
  //    (ни в налоговой, ни в ArmSoft-выгрузке)
  // ==========================================================================
  if (enabled.has('meeting_not_in_export')) {
    for (const [norm, m] of mentionByName) {
      const tm = findMatch(taxIndex, { hvhh: null, names: [m.name, norm] });
      const arm = findMatch(armIndex, { hvhh: null, names: [m.name, norm] });
      const inTax = tm.found && tm.quality !== 'fuzzy';
      const inArm = arm.found && arm.quality !== 'fuzzy';
      if (inTax || inArm) continue; // компания есть в выгрузке — расхождения нет
      const cm = findMatch(clientIndex, { hvhh: null, names: [m.name, norm] });
      items.push(makeItem('meeting_not_in_export', m.name || norm, {
        hvhh: null,
        accountant_name: m.accountant,
        client_is_active: cm.found ? cm.entity.is_active : null,
        exists_in_taxservice: false,
        exists_in_armsoft: false,
        exists_in_ob_registry: cm.found,
        exists_in_morning_meeting: true,
        match_quality: (tm.quality === 'fuzzy' || arm.quality === 'fuzzy') ? 'fuzzy' : 'none',
        last_activity_date: m.lastDate,
        possible_reason: (tm.quality === 'fuzzy' || arm.quality === 'fuzzy')
          ? 'Возможное неточное совпадение в выгрузке Артёма — проверить название'
          : undefined,
      }));
    }
  }

  // ==========================================================================
  // Дедупликация по issue_key (например, два налоговых аккаунта с одним ՀՎՀՀ),
  // чтобы счётчики совпадали с тем, что сохранится в delta_items
  // ==========================================================================
  const seenKeys = new Set();
  const deduped = items.filter((it) =>
    seenKeys.has(it.issue_key) ? false : (seenKeys.add(it.issue_key), true));
  items.length = 0;
  items.push(...deduped);

  // ==========================================================================
  // Сравнение двух выгрузок Артёма между собой (по запросу):
  //   - есть в TaxService, но нет в ArmSoft
  //   - есть в ArmSoft, но нет в TaxService
  // Совпадение — точное (по нормализованному названию; ՀՎՀՀ у ArmSoft нет).
  // «≈» отмечает возможное неточное (fuzzy) совпадение — оно НЕ исключает строку.
  // ==========================================================================
  const crossTaxNotArm = [];
  for (const t of tax) {
    const name = t.client_name_ru || t.org_name_hy || ('ՀՎՀՀ ' + t.tin);
    const m = findMatch(armIndex, { hvhh: null, names: [t.client_name_ru, t.org_name_hy] });
    if (m.found && m.quality !== 'fuzzy') continue;
    crossTaxNotArm.push({
      company_name: name,
      hvhh: t.tin || null,
      match_quality: m.found ? 'fuzzy' : 'none',
      fuzzy_hint: m.found ? (m.entity.caption || m.entity.name) : null,
    });
  }

  const crossArmNotTax = [];
  for (const a of armsoft) {
    const name = a.caption || a.name || ('ArmSoft #' + a.company_id);
    const m = findMatch(taxIndex, { hvhh: null, names: [a.caption, a.name] });
    if (m.found && m.quality !== 'fuzzy') continue;
    crossArmNotTax.push({
      company_name: name,
      hvhh: null,
      match_quality: m.found ? 'fuzzy' : 'none',
      fuzzy_hint: m.found ? (m.entity.client_name_ru || m.entity.org_name_hy) : null,
    });
  }
  crossTaxNotArm.sort((x, y) => x.company_name.localeCompare(y.company_name, 'ru'));
  crossArmNotTax.sort((x, y) => x.company_name.localeCompare(y.company_name, 'ru'));

  // ==========================================================================
  // Сводные показатели для дневного снимка
  // ==========================================================================
  const nonJunk = clientCtxs.filter((c) => !RULES.isJunkName(c.client.company_name));
  const active = nonJunk.filter((c) => c.client.is_active);
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

  return { items, counts, clientCtxs, activityByName, mentionByName, crossTaxNotArm, crossArmNotTax };
}
