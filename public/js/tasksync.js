/* =============================================================================
 * Синхронизация ежедневных задач бухгалтеров с выгрузкой Артёма.
 *
 * ИДЕЯ: выгрузка Артёма (TaxService + ArmSoft, разобранные его парсерами) —
 * единственный источник полной бухгалтерской информации. Значит, каждая
 * ежедневная задача бухгалтера должна находить отражение в выгрузке. Здесь мы
 * по каждому бухгалтеру считаем, какие его задачи НЕ отражены в выгрузке, и
 * собираем список проблем сверки.
 *
 * ИСТОЧНИКИ ЗАДАЧ:
 *   - accounting_activities — фактическая работа (по компании/дню/системе,
 *     со счётчиками: счета, отчёты, заявления, изменения остатков);
 *   - accountant_daily_comments.unaccounted_work — работа, которую бухгалтер
 *     сам отметил как «не отражено».
 *
 * ВСЕ настройки (типы задач, что Артём не видит, окно сверки) — в config.js →
 * TASK_SYNC. Сопоставление названий переиспользует normalize.js (buildIndex /
 * findMatch), как и движок дельты.
 * ========================================================================== */

/** Матчит текст работы против config-паттернов «Артём этого не видит» */
function isWorkNotInExport(text) {
  const t = (text || '').toLowerCase();
  if (!t) return false;
  return TASK_SYNC.tasksNotInExport.patterns.some((p) => t.includes(p));
}

/** Прибавить N дней к строке YYYY-MM-DD (без часовых поясов) */
function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Главный расчёт сверки задач бухгалтеров с выгрузкой Артёма.
 * exportStatus — строка из public.v_artyom_export_status (может быть null).
 * Возвращает: { referenceDate, windowStart, tasks, byAccountant, problems, report }.
 */
function computeTaskSync(src, exportStatus) {
  const { tax, armsoft, activities, comments, clients } = src;

  const taxIndex = buildIndex(tax, ['client_name_ru', 'org_name_hy'], 'tin');
  const armIndex = buildIndex(armsoft, ['caption', 'name'], null);

  // ID активных клиентов OB → название бухгалтера (запасной источник имени)
  const accByCompanyNorm = new Map();
  for (const c of clients || []) {
    const n = normalizeName(c.company_name);
    if (n && c.accountant_name && !accByCompanyNorm.has(n)) accByCompanyNorm.set(n, c.accountant_name);
  }

  // --- окно сверки: последние SYNC_WINDOW_DAYS дней от самой свежей активности -
  const allDates = [];
  for (const a of activities || []) if (a.activity_date) allDates.push(a.activity_date);
  for (const c of comments || []) if (c.comment_date) allDates.push(c.comment_date);
  const referenceDate = allDates.length ? allDates.reduce((m, d) => (d > m ? d : m)) : todayStr();
  const windowStart = addDaysIso(referenceDate, -TASK_SYNC.SYNC_WINDOW_DAYS);

  // --- агрегируем задачи из accounting_activities ---------------------------
  // ключ: бухгалтер | компания(норм) | система | тип задачи
  const taskMap = new Map();
  const typeEntries = Object.entries(TASK_SYNC.taskTypes);
  for (const a of activities || []) {
    if (a.activity_date && a.activity_date < windowStart) continue;
    const company = a.company_name;
    if (!company || RULES.isJunkName(company)) continue;
    const accountant = a.accountant_name || a.accountant_email || '—';
    const system = a.system_source || 'armsoft';
    const cnorm = normalizeName(company);
    for (const [key, def] of typeEntries) {
      const cnt = Number(a[def.field] || 0);
      if (cnt <= 0) continue;
      const tkey = `${normalizeName(accountant)}|${cnorm}|${system}|${key}`;
      let t = taskMap.get(tkey);
      if (!t) {
        t = {
          task_key: tkey, accountant, company_name: company, system_source: system,
          task_type: key, task_type_label: def.label, count: 0, last_task_date: null,
        };
        taskMap.set(tkey, t);
      }
      t.count += cnt;
      if (!t.last_task_date || (a.activity_date && a.activity_date > t.last_task_date)) {
        t.last_task_date = a.activity_date;
      }
    }
  }

  // --- сверяем каждую задачу с выгрузкой Артёма ------------------------------
  const tasks = [];
  const problems = [];
  const seenProblem = new Set();
  const addProblem = (p) => {
    if (seenProblem.has(p.problem_key)) return;
    seenProblem.add(p.problem_key);
    problems.push(p);
  };

  for (const t of taskMap.values()) {
    const def = TASK_SYNC.taskTypes[t.task_type] || {};
    // система задачи определяет, где искать: налоговая или ArmSoft
    const index = t.system_source === 'taxservice' ? taxIndex : armIndex;
    const m = findMatch(index, { hvhh: null, names: [t.company_name] });
    const foundExact = m.found && m.quality !== 'fuzzy';
    const hvhh = t.system_source === 'taxservice' && foundExact ? (m.entity.tin || null) : null;

    const notExpected = !def.expectedInExport
      || TASK_SYNC.tasksNotInExport.taskTypeKeys.includes(t.task_type);

    let status;
    if (notExpected) status = 'not_expected';
    else if (foundExact) status = 'in_export';
    else status = 'missing_in_export';

    const workSummary = `${t.task_type_label}: ${t.count}`;

    tasks.push({
      task_key: t.task_key,
      accountant_name: t.accountant,
      company_name: t.company_name,
      hvhh,
      system_source: t.system_source,
      task_type: t.task_type,
      task_type_label: t.task_type_label,
      work_summary: workSummary,
      last_task_date: t.last_task_date,
      in_artyom_export: foundExact,
      match_quality: m.quality,
      not_expected_in_export: notExpected,
      status,
      problem_type: status === 'missing_in_export' ? 'coverage_gap'
        : (m.quality === 'fuzzy' ? 'name_mismatch' : null),
      problem_description: null,
    });

    // проблемы сверки
    if (status === 'missing_in_export') {
      addProblem({
        problem_key: `coverage_gap|${normalizeName(t.company_name)}|${t.system_source}`,
        category: 'coverage_gap',
        severity: 'high',
        title: `Компания «${t.company_name}» не найдена в выгрузке (${t.system_source})`,
        description: `Бухгалтер ${t.accountant} вёл работу (${workSummary}), но компании нет в `
          + `${t.system_source === 'taxservice' ? 'налоговой' : 'ArmSoft'}-выгрузке Артёма.`,
        accountant_name: t.accountant, company_name: t.company_name,
        source: 'accounting_activities', detected_date: referenceDate,
      });
    } else if (m.quality === 'fuzzy') {
      const hint = m.entity.caption || m.entity.name || m.entity.client_name_ru || m.entity.org_name_hy || '';
      addProblem({
        problem_key: `name_mismatch|${normalizeName(t.company_name)}|${t.system_source}`,
        category: 'name_mismatch',
        severity: 'medium',
        title: `Возможное расхождение названия: «${t.company_name}»`,
        description: `В выгрузке похоже присутствует как «${hint}» — проверить/выровнять название (ошибка формата).`,
        accountant_name: t.accountant, company_name: t.company_name,
        source: 'accounting_activities', detected_date: referenceDate,
      });
    }
  }

  // --- работа, которую бухгалтер сам отметил как «не отражено» ---------------
  for (const c of comments || []) {
    if (c.comment_date && c.comment_date < windowStart) continue;
    const uw = c.unaccounted_work;
    if (!uw) continue;
    const accountant = c.accountant_name || c.accountant_email || '—';
    addProblem({
      problem_key: `unaccounted_work|${c.id}`,
      category: isWorkNotInExport(uw) ? 'unaccounted_work' : 'coverage_gap',
      severity: 'medium',
      title: `Не отражено в выгрузке: «${c.company_name || '—'}»`,
      description: `${accountant}: ${uw}`,
      accountant_name: accountant, company_name: c.company_name || null,
      source: 'accountant_daily_comments', detected_date: c.comment_date || referenceDate,
    });
  }

  // --- проблема графика выгрузки (если просрочено / нет данных) ---------------
  if (exportStatus && (exportStatus.status === 'overdue' || exportStatus.status === 'no_data')) {
    const st = TASK_SYNC.scheduleStatuses[exportStatus.status] || {};
    addProblem({
      problem_key: `schedule|${referenceDate}`,
      category: 'schedule',
      severity: exportStatus.status === 'overdue' ? 'high' : 'medium',
      title: `Выгрузка Артёма: ${st.label || exportStatus.status}`,
      description: exportStatus.status === 'overdue'
        ? `Свежей выгрузки нет уже ${exportStatus.hours_late} ч сверх графика `
          + `(ждали к ${String(exportStatus.expected_by || '').replace('T', ' ').slice(0, 16)}).`
        : 'Нет данных о выгрузке Артёма (парсеры ни разу не отработали).',
      source: 'v_artyom_export_status', detected_date: referenceDate,
    });
  }

  // --- сводка по бухгалтерам -------------------------------------------------
  const byAccMap = new Map();
  for (const t of tasks) {
    let s = byAccMap.get(t.accountant_name);
    if (!s) {
      s = { accountant: t.accountant_name, total: 0, inExport: 0, missing: 0, notExpected: 0, missingTasks: [] };
      byAccMap.set(t.accountant_name, s);
    }
    s.total += 1;
    if (t.status === 'in_export') s.inExport += 1;
    else if (t.status === 'not_expected') s.notExpected += 1;
    else { s.missing += 1; s.missingTasks.push(t); }
  }
  const byAccountant = [...byAccMap.values()].map((s) => {
    const expected = s.inExport + s.missing;
    s.matchRate = expected ? Math.round((s.inExport / expected) * 100) : null;
    return s;
  }).sort((a, b) => b.missing - a.missing || b.total - a.total);

  // --- отчёт по процессу: 2 ключевых показателя ------------------------------
  const expectedTotal = tasks.filter((t) => t.status === 'in_export' || t.status === 'missing_in_export').length;
  const inExportTotal = tasks.filter((t) => t.status === 'in_export').length;
  const missingTotal = tasks.filter((t) => t.status === 'missing_in_export').length;
  const notExpectedTotal = tasks.filter((t) => t.status === 'not_expected').length;

  const report = {
    // (а) выгрузил Артём или нет
    exported: exportStatus ? exportStatus.status : 'no_data',
    exportStatus: exportStatus || null,
    // (б) соответствует ли информация в выгрузке действительности
    dataMatchRate: expectedTotal ? Math.round((inExportTotal / expectedTotal) * 100) : null,
    expectedTotal, inExportTotal, missingTotal, notExpectedTotal,
    accountants: byAccountant.length,
    problemsCount: problems.length,
  };

  problems.sort((a, b) => {
    const sev = { high: 0, medium: 1, low: 2 };
    return (sev[a.severity] - sev[b.severity]) || a.category.localeCompare(b.category);
  });

  return { referenceDate, windowStart, tasks, byAccountant, problems, report };
}
