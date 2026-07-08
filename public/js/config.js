/* =============================================================================
 * Конфигурация дашборда расхождений OneBusiness
 * Backend: Supabase проект "OB Artyom" (rbtvbsbcycdlwmrzjwun)
 *
 * ВСЯ настраиваемая бизнес-логика собрана здесь, чтобы правила можно было
 * менять без правки остального кода.
 * ========================================================================== */

const CONFIG = {
  SUPABASE_URL: 'https://rbtvbsbcycdlwmrzjwun.supabase.co',
  // anon-ключ (публичный по дизайну Supabase; доступ ограничивается RLS)
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJidHZic2JjeWNkbHdtcnpqd3VuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzOTg2MDYsImV4cCI6MjA5NTk3NDYwNn0.Aw6cLYNiQRNVahANyUkXehFwQI9oyUW9Hj2xjELWwk0',

  // Часовой пояс бизнеса — "сегодня" считается по Еревану
  TIMEZONE: 'Asia/Yerevan',
};

/* -----------------------------------------------------------------------------
 * ПРАВИЛА (настраиваемые)
 *
 * ЧТО ТАКОЕ «ВЫГРУЗКА АРТЁМА»:
 *   Весь проект OB Artyom — это и есть результат выгрузки Артёма. Его парсеры
 *   (armsoft_db.parser_modules) выгружают данные из налогового кабинета и
 *   ArmSoft в таблицы armsoft_db. Поэтому «выгрузка Артёма» = фактически
 *   разобранные им данные:
 *     - TaxService (налоговый кабинет) → v_tax_accounts  (tin = ՀՎՀՀ)
 *     - ArmSoft                        → v_armsoft_companies
 *
 * ИСТОЧНИК ИСТИНЫ «кто наш активный клиент» — реестр OB:
 *     - ob_accounting_companies (is_active, accountant_name,
 *       armsoft_company_id → v_armsoft_companies.company_id,
 *       tax_account_id     → v_tax_accounts.id)
 *
 * ПРОЧЕЕ:
 *     - accountant_daily_comments — что бухгалтеры отчитали на утренних встречах
 *     - accounting_activities     — фактическая работа по системам (реальная)
 *
 * ГЛАВНЫЙ СМЫСЛ ДЕЛЬТЫ: сколько активных клиентов OB ещё НЕ попали в выгрузку
 * Артёма. По мере новых выгрузок этот разрыв должен уменьшаться.
 *
 * ВАЖНО: в реестре клиентов НЕТ собственного поля ՀՎՀՀ — оно восстанавливается
 * через связь tax_account_id → v_tax_accounts.tin либо через совпадение названия.
 *
 * ПРИМЕЧАНИЕ: таблица artem_companies (15 строк с тестовыми ИНН AM00…) —
 * демонстрационные данные, в расчёте дельты НЕ используется.
 * -------------------------------------------------------------------------- */
const RULES = {
  /**
   * Клиент ОБЯЗАН существовать в TaxService, если он активен.
   * (Действующий бизнес в Армении обязан быть в налоговом кабинете; ՀՎՀՀ —
   *  дополнительный признак, показывается и фильтруется, но не скрывает разрыв.)
   * Если нужно строгое правило «активен И есть ՀՎՀՀ» — раскомментируйте вторую строку.
   * ctx: { client, hvhh, taxMatch, armMatch }
   */
  expectedInTaxService(ctx) {
    return !!ctx.client.is_active;
    // return !!ctx.client.is_active && (!!ctx.hvhh || ctx.client.tax_account_id != null);
  },

  /**
   * Клиент ОБЯЗАН существовать в ArmSoft, если:
   * активен И заполнено ArmSoft-поле в реестре (armsoft_company_id).
   * Это лучшее доступное поле-признак «у клиента есть логин/учётка ArmSoft».
   * При необходимости правило легко расширить (например, `|| ctx.armMatch.found`).
   */
  expectedInArmsoft(ctx) {
    return !!ctx.client.is_active && ctx.client.armsoft_company_id != null;
  },

  /**
   * Клиента можно ИГНОРИРОВАТЬ (не считать расхождением «нет в TaxService»),
   * если его название явно не является компанией — мусорные строки реестра.
   */
  isJunkName(name) {
    const n = (name || '').trim().toLowerCase();
    return !n || n === '#n/a' || n === 'n/a' || n === '-' || n.length < 2;
  },

  /**
   * Какие типы расхождений вычисляются и сохраняются в delta_items.
   * Отключите тип, убрав его из списка.
   */
  ENABLED_ISSUE_TYPES: [
    'missing_taxservice',   // активный клиент OB → нет в выгрузке TaxService
    'missing_armsoft',      // активный клиент OB (с armsoft-привязкой) → нет в ArmSoft
    'tax_not_in_ob',        // в выгрузке TaxService есть, в реестре OB нет
    'armsoft_not_in_ob',    // в выгрузке ArmSoft есть, в реестре OB нет
    'meeting_not_in_export', // упомянута на встрече → нет в выгрузке Артёма
  ],

  // total_delta в дневном снимке = разрыв покрытия (клиенты OB, которых ещё нет
  // в выгрузке Артёма). Именно он должен уменьшаться после новых выгрузок.
  // Обратные типы (tax_not_in_ob / armsoft_not_in_ob) остаются кликабельными
  // в разделе «Дельта», но не раздувают ежедневный итог.
  TOTAL_DELTA_TYPES: [
    'missing_taxservice',
    'missing_armsoft',
  ],

  // Минимальная длина нормализованного названия для нечёткого (fuzzy) сравнения
  FUZZY_MIN_LEN: 4,
};

/* ----------------------------------------------------------------------------
 * Справочники для UI (русский интерфейс)
 * -------------------------------------------------------------------------- */
const ISSUE_TYPES = {
  missing_taxservice: {
    label: 'Нет в TaxService',
    short: 'Нет в Tax',
    expected: 'TaxService',
    missingFrom: 'TaxService',
    source: 'ob_accounting_companies',
    reason: 'Клиент активен и имеет ՀՎՀՀ/привязку, но не найден в налоговом кабинете — возможно, кабинет не создан или название не совпадает',
  },
  missing_armsoft: {
    label: 'Нет в ArmSoft',
    short: 'Нет в ArmSoft',
    expected: 'ArmSoft',
    missingFrom: 'ArmSoft',
    source: 'ob_accounting_companies',
    reason: 'У клиента заполнено ArmSoft-поле, но компания не найдена в ArmSoft — возможно, не создана или ссылка устарела',
  },
  tax_not_in_ob: {
    label: 'Есть в выгрузке TaxService, нет в реестре OB',
    short: 'Tax → нет в OB',
    expected: 'Реестр OB',
    missingFrom: 'Реестр OB',
    source: 'v_tax_accounts',
    reason: 'Компания есть в налоговой выгрузке Артёма, но не привязана ни к одному активному клиенту OB — возможно, клиента забыли завести или он помечен неактивным',
  },
  armsoft_not_in_ob: {
    label: 'Есть в выгрузке ArmSoft, нет в реестре OB',
    short: 'ArmSoft → нет в OB',
    expected: 'Реестр OB',
    missingFrom: 'Реестр OB',
    source: 'v_armsoft_companies',
    reason: 'Компания есть в ArmSoft-выгрузке Артёма, но не привязана ни к одному активному клиенту OB — возможно, клиента забыли завести или он помечен неактивным',
  },
  meeting_not_in_export: {
    label: 'Упомянута на встрече, нет в выгрузке Артёма',
    short: 'Встреча → нет у Артёма',
    expected: 'Выгрузка Артёма (TaxService/ArmSoft)',
    missingFrom: 'Выгрузка Артёма',
    source: 'accountant_daily_comments',
    reason: 'Бухгалтер отчитался о работе по компании на утренней встрече, но её нет ни в налоговой, ни в ArmSoft-выгрузке Артёма',
  },
};

const CONFIRMATION_STATUSES = {
  not_checked:                        { label: 'Не проверено', color: 'gray' },
  confirmed_not_in_armsoft:           { label: 'Подтверждено: не создан в ArmSoft', color: 'red' },
  confirmed_not_in_taxservice:        { label: 'Подтверждено: не создан в TaxService', color: 'red' },
  confirmed_artyom_export_problem:    { label: 'Подтверждено: проблема выгрузки Артёма', color: 'red' },
  confirmed_accountant_mistake:       { label: 'Подтверждено: ошибка бухгалтера', color: 'yellow' },
  confirmed_duplicate_name_mismatch:  { label: 'Подтверждено: дубликат / не совпало название', color: 'yellow' },
  confirmed_no_action_needed:         { label: 'Подтверждено: действий не требуется', color: 'green' },
};

const PRIORITIES = {
  low:    { label: 'Низкий' },
  medium: { label: 'Средний' },
  high:   { label: 'Высокий' },
};

const TZ_STATUSES = {
  open:      { label: 'Открыто', color: 'yellow' },
  sent:      { label: 'Отправлено Артёму', color: 'gray' },
  fixed:     { label: 'Исправлено', color: 'green' },
  cancelled: { label: 'Отменено', color: 'gray' },
};
