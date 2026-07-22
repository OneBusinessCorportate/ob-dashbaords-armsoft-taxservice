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
 * СИНХРОНИЗАЦИЯ ЗАДАЧ БУХГАЛТЕРОВ С ВЫГРУЗКОЙ АРТЁМА (настраиваемо)
 *
 * Выгрузка Артёма — единственный источник полной бухгалтерской информации.
 * Все ежедневные задачи бухгалтеров должны сверяться с ней. Здесь собраны ВСЕ
 * настройки этой сверки, чтобы менять правила без правки кода:
 *   - какие типы задач бывают и должны ли они попадать в выгрузку;
 *   - какие задачи Артём В ПРИНЦИПЕ не видит (согласуется с Эмилией и Лилит);
 *   - график выгрузки (к какому часу ждём, льготный период);
 *   - подписи 4 статусов для Telegram-отбивки.
 *
 * ВАЖНО про exportSchedule: эти же значения продублированы в БД (app_config:
 * export.expected_hour_yerevan / export.grace_hours / export.frequency) — это
 * канон для СЕРВЕРНОЙ проверки (SQL-функция artyom_export_schedule_status и
 * Telegram-отбивка), не зависящей от браузера. Здесь — зеркало для UI.
 * При изменении графика правьте app_config (через SQL) И этот блок.
 * -------------------------------------------------------------------------- */
const TASK_SYNC = {
  // Окно «ежедневных задач»: сколько последних дней активности сверяем.
  // Отсчитывается от самой свежей даты активности в данных (а не от «сегодня»),
  // чтобы сверка работала и на исторических/демо-данных.
  SYNC_WINDOW_DAYS: 45,

  /**
   * Типы ежедневных задач бухгалтера. Выводятся из счётчиков в
   * accounting_activities. expectedInExport = должна ли задача в норме
   * отражаться в выгрузке Артёма (если да и её там нет — это расхождение).
   */
  taskTypes: {
    invoices:     { label: 'Счета / инвойсы',        field: 'invoices_issued',   expectedInExport: true },
    reports:      { label: 'Сдача отчётов',          field: 'reports_submitted', expectedInExport: true },
    applications: { label: 'Подача заявлений',       field: 'applications_filed', expectedInExport: true },
    balance:      { label: 'Изменение остатков',     field: 'balance_changes',   expectedInExport: true },
  },

  /**
   * ЗАДАЧИ, КОТОРЫЕ АРТЁМ НЕ ВИДИТ (согласовать с Эмилией и Лилит).
   * Это работа, которая структурно НЕ попадает в выгрузку из TaxService/ArmSoft:
   * устные согласования, консультации, ручные корректировки прошлых периодов и т.п.
   *
   *   - taskTypeKeys: ключи из taskTypes выше, которые целиком не ожидаются в выгрузке
   *     (по умолчанию пусто — все счётные задачи ожидаются в выгрузке);
   *   - patterns: подстроки (в нижнем регистре) для распознавания такой работы в
   *     свободном тексте (комментарий бухгалтера / поле «не отражено»).
   *
   * Список намеренно вынесен сюда, а не в код, — дополняйте по итогам разбора
   * ежедневных задач с бухгалтерами.
   */
  tasksNotInExport: {
    taskTypeKeys: [],
    patterns: [
      'консультац',      // консультации
      'устн',            // устное согласование
      'согласован',      // согласования (устные)
      'созвон', 'звонок', 'телефон',
      'встреч',          // встреча с клиентом
      'корректировк прошл', 'прошлых периодов', 'прошлого периода',
      'обучен',          // обучение
      'внутрен',         // внутренняя работа
      'переписк',        // переписка
    ],
  },

  /**
   * График выгрузки Артёма (зеркало app_config, см. примечание выше).
   * frequency пока информативно; проверка идёт по expectedHourYerevan + graceHours.
   * requiredModules — список парсеров, которые ОБЯЗАНЫ отрабатывать в каждой
   * выгрузке (для отчёта «что не выгрузилось по графику»). Пусто = не проверять.
   */
  exportSchedule: {
    frequency: 'daily',
    expectedHourYerevan: 2,   // к 02:00 по Еревану ждём свежую выгрузку
    graceHours: 12,           // +12 ч льготного периода до статуса «Просрочено»
    requiredModules: [],      // напр. ['taxparser_invoices_issued.py', ...]
  },

  /** Подписи и оформление 4 статусов графика выгрузки (UI + Telegram). */
  scheduleStatuses: {
    awaiting: { label: 'Ожидаем выгрузку', emoji: '⏳', color: 'yellow' },
    exported: { label: 'Выгрузил',         emoji: '✅', color: 'green' },
    overdue:  { label: 'Просрочено',       emoji: '⚠️', color: 'red' },
    no_data:  { label: 'Нет данных',       emoji: '⚫', color: 'gray' },
  },
};

/* ----------------------------------------------------------------------------
 * ХРОНОМЕТРАЖ УСЛУГ (настраиваемо)
 *
 * Задача «Выгрузка Артёма — проверка на 1 бухгалтере»: показать понятную дневную
 * отчётность и, помножив количество выполненных услуг из выгрузки Артёма на
 * норматив времени по каждой услуге, посчитать, сколько ЧАСОВ бухгалтер
 * проработал за день («бухгалтер проработал N ч»).
 *
 * ⚠ ВАЖНО: значения minutesPerUnit ниже — ЧЕРНОВИК-заглушка. Финальный
 * хронометраж пришлёт Гарри (эксель по времени выполнения услуг/задач). Когда
 * файл придёт — заменить minutesPerUnit реальными нормативами. Всё остальное
 * (страница, расчёт, обратная связь бухгалтера) от этих чисел не зависит и
 * пересчитается автоматически.
 *
 * category = типы услуг, которые видит выгрузка Артёма:
 *   invoice_issued        — счёт ArmSoft выставлен
 *   invoice_received      — счёт ArmSoft получен/проведён
 *   report                — сдан налоговый отчёт (форма)
 *   tax_invoice_issued    — налоговый э-счёт выставлен
 *   tax_invoice_received  — налоговый э-счёт получен/проведён
 * -------------------------------------------------------------------------- */
const CHRONO = {
  // Источник норматива — для подписи на странице.
  source: 'Хронометраж Гарри — final_pricing_model.xlsx (лист «05_Хронометраж» / калькулятор «06_Выбор_Пакета»)',
  isDraft: false,

  // Минут на одну услугу данного типа. Значения взяты из модели Гарри
  // (в модели нормативы в ЧАСАХ; здесь переведены в минуты, ×60).
  // Буфер 25% НЕ применяется — калькулятор «06_Выбор_Пакета» считает по базовым
  // часам (столбец «Часы_в_месяц» = базовые часы без буфера).
  //
  //   report               — «Сдача ежемесячной отчётности» (S001, FIX):
  //                           базовая месячная норма, тариф Стандарт = 3 ч = 180 мин.
  //                           В модели это фикс-услуга на месяц; в выгрузке Артёма
  //                           «report» = каждая сданная форма (архив форм), поэтому
  //                           норма применяется к каждой форме. Если нужна доля на
  //                           форму — измените одно число здесь.
  //   invoice_*/tax_*      — «Инвойс (1 шт)» (S017, VAR, драйвер INVOICE) =
  //                           0.13 ч = 7.8 мин за документ (все счета и налоговые
  //                           э-счета считаем по норме инвойса).
  minutesPerUnit: {
    invoice_issued:        7.8,   // 0.13 ч × 60  (S017 «Инвойс (1 шт)»)
    invoice_received:      7.8,   // 0.13 ч × 60  (S017 «Инвойс (1 шт)»)
    report:              180,     // 3 ч × 60     (S001 «Сдача ежемесячной отчётности», Стандарт)
    tax_invoice_issued:    7.8,   // 0.13 ч × 60  (S017 «Инвойс (1 шт)»)
    tax_invoice_received:  7.8,   // 0.13 ч × 60  (S017 «Инвойс (1 шт)»)
  },

  // Порядок вывода типов услуг в дневном отчёте.
  order: ['report', 'invoice_issued', 'invoice_received', 'tax_invoice_issued', 'tax_invoice_received'],
};

/* Подписи и значки типов услуг (общие для страницы «Бухгалтеры» и дневного отчёта) */
const SERVICE_TYPES = {
  report:               { label: 'Сдача налоговых отчётов',      unit: 'отчёт',  icon: '📄', system: 'TaxService' },
  invoice_issued:       { label: 'Счета выставленные (ArmSoft)', unit: 'счёт',   icon: '🧾', system: 'ArmSoft' },
  invoice_received:     { label: 'Счета полученные (ArmSoft)',    unit: 'счёт',   icon: '📥', system: 'ArmSoft' },
  tax_invoice_issued:   { label: 'Налоговые счета выставленные',  unit: 'счёт',   icon: '🧾', system: 'TaxService' },
  tax_invoice_received: { label: 'Налоговые счета полученные',    unit: 'счёт',   icon: '📥', system: 'TaxService' },
};

/* Статусы согласования дневного отчёта бухгалтером */
const DAY_REPORT_STATUSES = {
  pending:   { label: 'Ждёт бухгалтера', color: 'yellow' },
  confirmed: { label: 'Подтверждено бухгалтером', color: 'green' },
  disputed:  { label: 'Есть возражения', color: 'red' },
};

/* ----------------------------------------------------------------------------
 * УТРЕННИЕ СОЗВОНЫ (страница «Утренние созвоны» / morning calls)
 *
 * По каждому дню утреннего созвона показываем ПО КАЖДОМУ бухгалтеру три колонки:
 *   1. что он СКАЗАЛ на созвоне, что сделано (accountant_daily_comments);
 *   2. что РЕАЛЬНО было в TaxService (выгрузка Артёма: сданные отчёты + налоговые
 *      э-счета выставленные/полученные);
 *   3. что РЕАЛЬНО было в ArmSoft (выгрузка Артёма: счета выставленные/полученные).
 * Всё «реально» = данные выгрузки Артёма, единственного полного источника.
 *
 * actualsDayOffset — за сколько дней ДО созвона была проделана обсуждаемая на нём
 * работа. Утренний созвон обычно обсуждает вчерашнюю работу → поставьте 1, тогда
 * факт берётся за день до созвона. 0 = факт за тот же день, что и созвон.
 * -------------------------------------------------------------------------- */
const MORNING_CALLS = {
  actualsDayOffset: 0,
  // По умолчанию блок «Анализ созвона» (сводка по дню) показан; его можно
  // свернуть кнопкой на каждом дне. Здесь — состояние по умолчанию для новых дней.
  analysisOpenByDefault: true,
};

/* ----------------------------------------------------------------------------
 * ПОЛНОЕ сопоставление слов созвона с выгрузкой Артёма (задача владельца:
 * «take every column of OB Artyom project ... every word they say in the
 * morning call ... do not miss even a small caught information»).
 *
 * MC_CATEGORIES — ВСЕ рабочие разделы выгрузки Артёма (26 категорий, покрывают
 * практически каждый «рабочий» столбец armsoft_db). Каждая категория:
 *   system   — 'ArmSoft' | 'TaxService';
 *   label    — русская подпись;
 *   icon     — значок;
 *   legacy   — входит ли в старую сводку из 5 категорий (для совместимости);
 *   measurable — есть ли за ней реальная таблица-счётчик в выгрузке
 *                (false → работу структурно нельзя увидеть в выгрузке);
 *   patterns — подстроки (в нижнем регистре, ё→е) для распознавания этой работы
 *              в СЛОВАХ бухгалтера на созвоне. Дополняйте по итогам разбора
 *              реальных созвонов — правило меняется здесь, без правки кода.
 *
 * Источник счётчиков — RPC public.ob_accountant_activity_full (см.
 * sql/2026-07-22_morning_calls_full_activity.sql). Ключи category здесь
 * СОВПАДАЮТ с category из RPC.
 * -------------------------------------------------------------------------- */
const MC_CATEGORIES = {
  // ---- ArmSoft ----
  invoice_issued:     { system: 'ArmSoft', label: 'Счета/инвойсы выставленные', icon: '🧾', legacy: true,  measurable: true,
    patterns: ['инвойс', 'выставил счет', 'выставила счет', 'выписал счет', 'выписала счет', 'счет выставл', 'счета выставл', 'реализац', 'продаж товар', 'отгруз'] },
  invoice_received:   { system: 'ArmSoft', label: 'Счета полученные', icon: '📥', legacy: true, measurable: true,
    patterns: ['получ счет', 'счет получ', 'счета получ', 'входящ счет', 'входящ инвойс', 'получ инвойс', 'приход счет', 'обработ входящ'] },
  transfer_invoice:   { system: 'ArmSoft', label: 'Накладные / передаточные', icon: '📦', legacy: false, measurable: true,
    patterns: ['наклад', 'передаточн', 'перемещен', 'товарно-транспортн'] },
  purchase_doc:       { system: 'ArmSoft', label: 'Документы закупки', icon: '🛒', legacy: false, measurable: true,
    patterns: ['закуп', 'приобрет', 'покупк', 'поставк', 'приход товар', 'снабжен'] },
  cash_receipt:       { system: 'ArmSoft', label: 'Касса (ArmSoft)', icon: '💵', legacy: false, measurable: true,
    patterns: ['касс', 'наличн', 'пко', 'рко', 'приходн ордер', 'расходн ордер', 'кассов чек', 'кассов ордер'] },
  reconciliation_act: { system: 'ArmSoft', label: 'Акты сверки', icon: '🔄', legacy: false, measurable: true,
    patterns: ['сверк', 'акт сверк', 'взаиморасч'] },
  document_journal:   { system: 'ArmSoft', label: 'Документы в журнале', icon: '📚', legacy: false, measurable: true,
    patterns: ['провел документ', 'провела документ', 'занес документ', 'оформил документ', 'оформила документ', 'внес документ', 'обработ документ'] },
  journal_operation:  { system: 'ArmSoft', label: 'Бухгалтерские проводки', icon: '🧮', legacy: false, measurable: true,
    patterns: ['проводк', 'провел операц', 'разнес', 'бух справк', 'бухгалтерск справк', 'ручн операц', 'сделал операц', 'сделала операц'] },
  fixed_asset:        { system: 'ArmSoft', label: 'Основные средства', icon: '🏗', legacy: false, measurable: true,
    patterns: ['основн средств', 'основных средств', 'амортизац', 'введен в эксплуат', 'поставил на учет ос'] },
  arm_employee:       { system: 'ArmSoft', label: 'Кадры (ArmSoft)', icon: '🧑‍💼', legacy: false, measurable: true,
    patterns: ['кадр', 'штат', 'прием на работ', 'табел'] },
  material:           { system: 'ArmSoft', label: 'Товары / материалы / остатки', icon: '📦', legacy: false, measurable: true,
    patterns: ['материал', 'товар', 'номенклатур', 'склад', 'остатк', 'инвентар', 'оприход'] },
  partner:            { system: 'ArmSoft', label: 'Контрагенты', icon: '🤝', legacy: false, measurable: true,
    patterns: ['контрагент', 'партнер', 'поставщик', 'нов клиент', 'завел клиент', 'завела клиент', 'добавил клиент', 'добавила клиент'] },
  vat_calc:           { system: 'ArmSoft', label: 'Расчёт НДС', icon: '📐', legacy: false, measurable: true,
    patterns: ['ндс', 'расчет ндс', 'декларац ндс'] },
  // ---- TaxService ----
  report:             { system: 'TaxService', label: 'Сдача налоговых отчётов', icon: '📄', legacy: true, measurable: true,
    patterns: ['отчет', 'сдал форм', 'сдала форм', 'декларац', 'подал деклар', 'подала деклар', 'сдача отчет', 'квартальн', 'годов отчет', 'месячн отчет', 'сдал в налог', 'сдала в налог'] },
  saved_form:         { system: 'TaxService', label: 'Подготовка / черновики отчётов', icon: '📝', legacy: false, measurable: true,
    patterns: ['подготов отчет', 'подготов деклар', 'черновик', 'заполн форм', 'начал отчет', 'сохранил форм', 'готовл отчет', 'подготовил отчет', 'подготовила отчет'] },
  tax_invoice_issued: { system: 'TaxService', label: 'Налоговые э-счета выставленные', icon: '🧾', legacy: true, measurable: true,
    patterns: ['налог счет выстав', 'эл счет', 'электрон счет', 'выставил налог', 'выставила налог', 'э-счет', 'налог инвойс выстав', 'эсф'] },
  tax_invoice_received:{ system: 'TaxService', label: 'Налоговые э-счета полученные', icon: '📥', legacy: true, measurable: true,
    patterns: ['получ налог счет', 'налог счет получ', 'получ э-счет', 'входящ налог счет', 'принял налог счет', 'подтверд налог счет', 'подтвердил счет', 'подтвердила счет'] },
  tax_doc_issued:     { system: 'TaxService', label: 'Налоговые накладные (выст.)', icon: '📤', legacy: false, measurable: true,
    patterns: ['налог накладн', 'товарн накладн выстав'] },
  tax_doc_received:   { system: 'TaxService', label: 'Налоговые накладные (получ.)', icon: '📥', legacy: false, measurable: true,
    patterns: ['получ накладн', 'вход накладн'] },
  eeu_transaction:    { system: 'TaxService', label: 'Операции ЕАЭС / импорт-экспорт', icon: '🌍', legacy: false, measurable: true,
    patterns: ['еаэс', 'ввоз', 'вывоз', 'импорт', 'экспорт', 'таможн'] },
  tax_employee:       { system: 'TaxService', label: 'Сотрудники / зарплата', icon: '👥', legacy: false, measurable: true,
    patterns: ['зарплат', 'заработн', 'сотрудник', 'начислен зп', 'начислил зарплат', 'начислила зарплат', 'выплат зарплат', 'прием сотрудник', 'увольнен', 'регистрац сотрудник'] },
  cashbook:           { system: 'TaxService', label: 'Кассовая книга (налоговая)', icon: '📕', legacy: false, measurable: true,
    patterns: ['кассов книг', 'регистрац касс'] },
  hdm_fiscal:         { system: 'TaxService', label: 'ХДМ / фискальные данные', icon: '🖨', legacy: false, measurable: true,
    patterns: ['хдм', 'фискал', 'кассов аппарат', 'ккм'] },
  ledger_entry:       { system: 'TaxService', label: 'Лицевой счёт / налоговый регистр', icon: '📒', legacy: false, measurable: true,
    patterns: ['лицев счет', 'налог регистр', 'налог обязательств', 'начислен налог', 'сверк с налог'] },
  penalty:            { system: 'TaxService', label: 'Пени / штрафы', icon: '⚠', legacy: false, measurable: true,
    patterns: ['пени', 'штраф', 'санкц', 'неустойк'] },
  unified_account:    { system: 'TaxService', label: 'Единый счёт', icon: '🏦', legacy: false, measurable: true,
    patterns: ['единый счет', 'перечисл в бюджет', 'оплат налог', 'уплат налог', 'оплатил налог', 'оплатила налог', 'заплатил налог', 'перечислил налог', 'перечислила налог'] },
  // ---- виртуальная категория: работа без отдельной таблицы-счётчика в выгрузке ----
  application:        { system: 'TaxService', label: 'Заявления / ходатайства', icon: '📨', legacy: false, measurable: false,
    patterns: ['заявлен', 'ходатайств', 'обращен в налог'] },
};

/* Порядок вывода категорий (легаси-5 сначала, дальше по системам). */
const MC_CATEGORY_ORDER = [
  'report', 'tax_invoice_issued', 'tax_invoice_received', 'invoice_issued', 'invoice_received',
  'transfer_invoice', 'purchase_doc', 'cash_receipt', 'reconciliation_act',
  'document_journal', 'journal_operation', 'fixed_asset', 'arm_employee', 'material', 'partner', 'vat_calc',
  'tax_doc_issued', 'tax_doc_received', 'saved_form', 'eeu_transaction', 'tax_employee',
  'cashbook', 'hdm_fiscal', 'ledger_entry', 'penalty', 'unified_account', 'application',
];

/* Работа, которую выгрузка Артёма структурно НЕ видит (устные согласования,
 * консультации, корректировки прошлых периодов и т.п.). Зеркало
 * TASK_SYNC.tasksNotInExport.patterns — держим здесь для наглядности созвонов. */
const MC_STRUCTURAL_PATTERNS = [
  'консультац', 'устн', 'согласован', 'созвон', 'звонок', 'телефон', 'встреч',
  'корректировк прошл', 'прошлых периодов', 'прошлого периода', 'обучен',
  'внутрен', 'переписк', 'напомнил', 'напомнила', 'уточнил', 'уточнила',
];

/* Настройки дневного отчёта */
const DAILY_REPORT = {
  // Кого показываем по умолчанию на странице (пилот).
  // ЗАФИКСИРОВАН реальный бухгалтер: Tatev Altunyan — по данным выгрузки Артёма
  // у неё больше всего реальной работы среди живых бухгалтеров с привязками
  // к ArmSoft/налоговому кабинету (~5 527 выставленных + ~10 053 полученных
  // счетов ArmSoft по 6 активным компаниям). Именно на ней запускаем пилот
  // «проверить на 1 бухгалтере, что данные в ArmSoft = факт проделанной работы».
  // Бухгалтер меняется селектом на странице; значение по умолчанию — одна строка.
  defaultAccountant: 'Tatev Altunyan',
  // Сколько последних дней активности показывать (от самой свежей даты в данных).
  windowDays: 30,
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

/* Статусы самопроверки бухгалтера (раздел «Синхронизация», модель след. этапа) */
const SELF_CHECK_STATUSES = {
  pending:          { label: 'Не проверено', color: 'gray' },
  confirmed_ok:     { label: 'Всё учтено', color: 'green' },
  reported_missing: { label: 'Не учтено (сообщаю)', color: 'red' },
  disputed:         { label: 'Спорно', color: 'yellow' },
};

/* Статусы разбора проблемы сверки */
const PROBLEM_STATUSES = {
  open:     { label: 'Открыто', color: 'red' },
  ack:      { label: 'В работе', color: 'yellow' },
  resolved: { label: 'Решено', color: 'green' },
};

/* Вердикт сверки «бухгалтер сказал сделано» ↔ факт в системах (страница «Бухгалтеры») */
const ACC_VERDICTS = {
  reported_missing: { label: 'Сказал сделано — нет в выгрузке', color: 'red',    short: 'Нет в выгрузке' },
  confirmed:        { label: 'Отчитался и подтверждено',        color: 'green',  short: 'Подтверждено' },
  no_report:        { label: 'Есть в выгрузке, без отчёта',      color: 'gray',   short: 'Без отчёта' },
  none:             { label: 'Нет ни отчёта, ни в выгрузке',     color: 'yellow', short: 'Нигде' },
};

const PROBLEM_CATEGORIES = {
  schedule:         'График выгрузки',
  coverage_gap:     'Нет в выгрузке',
  name_mismatch:    'Расхождение названия',
  format_error:     'Ошибка формата',
  unaccounted_work: 'Не отражённая работа',
  config:           'Конфигурация',
  other:            'Прочее',
};
