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
 * Схема данных в проекте OB Artyom:
 *  - ob_accounting_companies — базовый реестр клиентов OB
 *      (is_active, accountant_name, armsoft_company_id, tax_account_id)
 *  - v_tax_accounts     — налоговый кабинет (TaxService), выгрузка Артёма;
 *                         tin = ՀՎՀՀ (ХВХХ)
 *  - v_armsoft_companies — ArmSoft, выгрузка Артёма
 *  - artem_companies    — собственный список-выгрузка Артёма (tin = ՀՎՀՀ)
 *  - accountant_daily_comments — что бухгалтеры говорили на утренних встречах
 *  - accounting_activities — фактическая работа по системам (armsoft/taxservice)
 *
 * ВАЖНО: в реестре клиентов НЕТ собственного поля ՀՎՀՀ, поэтому ՀՎՀՀ клиента
 * восстанавливается через связь tax_account_id → v_tax_accounts.tin, либо через
 * совпадение названия с TaxService / списком Артёма.
 * -------------------------------------------------------------------------- */
const RULES = {
  /**
   * Клиент ОБЯЗАН существовать в TaxService, если:
   * активен И (у него известен ՀՎՀՀ ИЛИ заполнено поле tax_account_id).
   * ctx: { client, hvhh, taxMatch, armMatch, artemMatch }
   */
  expectedInTaxService(ctx) {
    return !!ctx.client.is_active && (!!ctx.hvhh || ctx.client.tax_account_id != null);
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
   * Какие типы расхождений вычисляются и сохраняются в delta_items.
   * Отключите тип, убрав его из списка.
   */
  ENABLED_ISSUE_TYPES: [
    'missing_taxservice',
    'missing_armsoft',
    'tax_not_in_artem',
    'armsoft_not_in_artem',
    'meeting_not_in_artem',
    'artem_without_work',
  ],

  // total_delta в дневном снимке = число ВСЕХ открытых расхождений этих типов
  TOTAL_DELTA_TYPES: [
    'missing_taxservice',
    'missing_armsoft',
    'tax_not_in_artem',
    'armsoft_not_in_artem',
    'meeting_not_in_artem',
    'artem_without_work',
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
  tax_not_in_artem: {
    label: 'Есть в TaxService, нет в выгрузке Артёма',
    short: 'Tax → нет у Артёма',
    expected: 'Выгрузка Артёма',
    missingFrom: 'Выгрузка Артёма',
    source: 'v_tax_accounts',
    reason: 'Компания существует в налоговом кабинете, но отсутствует в списке-выгрузке Артёма — вероятно, ещё не экспортирована',
  },
  armsoft_not_in_artem: {
    label: 'Есть в ArmSoft, нет в выгрузке Артёма',
    short: 'ArmSoft → нет у Артёма',
    expected: 'Выгрузка Артёма',
    missingFrom: 'Выгрузка Артёма',
    source: 'v_armsoft_companies',
    reason: 'Компания существует в ArmSoft, но отсутствует в списке-выгрузке Артёма — вероятно, ещё не экспортирована',
  },
  meeting_not_in_artem: {
    label: 'Упомянута бухгалтером, нет в выгрузке Артёма',
    short: 'Встреча → нет у Артёма',
    expected: 'Выгрузка Артёма',
    missingFrom: 'Выгрузка Артёма',
    source: 'accountant_daily_comments',
    reason: 'Бухгалтер отчитался о работе по компании на утренней встрече, но компании нет в выгрузке Артёма',
  },
  artem_without_work: {
    label: 'В выгрузке Артёма, но нет работы бухгалтера',
    short: 'У Артёма без работы',
    expected: 'Работа бухгалтера (activities/встречи)',
    missingFrom: 'Отчёты бухгалтеров',
    source: 'artem_companies',
    reason: 'Компания есть в выгрузке Артёма, но не подтверждена ни активностью, ни упоминанием бухгалтера',
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
