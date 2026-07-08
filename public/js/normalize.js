/* =============================================================================
 * Нормализация названий компаний и движок сопоставления.
 *
 * Правило сопоставления (по ТЗ):
 *   1. сначала по ՀՎՀՀ (ХВХХ / ИНН) — точное совпадение;
 *   2. если ՀՎՀՀ нет — по нормализованному названию (точное);
 *   3. затем нечёткое (fuzzy) сравнение — помечается отдельно, НЕ считается
 *      точным совпадением.
 * ========================================================================== */

/** Организационно-правовые формы и служебные слова, удаляемые из названия */
const LEGAL_FORMS = new Set([
  // русские
  'ооо', 'оао', 'зао', 'пао', 'ао', 'ип', 'чп', 'тоо',
  // латинские
  'ooo', 'llc', 'ltd', 'inc', 'co', 'company', 'llp', 'jsc', 'cjsc', 'ojsc', 'ip', 'pe',
  // армянские (ՍՊԸ = ООО, ԱՁ = ИП, ՓԲԸ = ЗАО, ԲԲԸ = ОАО)
  'սպը', 'աձ', 'փբը', 'բբը', 'հկ',
]);

/** Карта транслитерации кириллица → латиница (для нечёткого сравнения) */
const CYR_TO_LAT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Нормализация названия:
 * lowercase → убрать кавычки/пунктуацию → убрать орг. формы → схлопнуть пробелы
 */
function normalizeName(raw) {
  if (!raw) return '';
  let t = String(raw).toLowerCase();
  // кавычки, скобки и прочая пунктуация → пробел
  t = t.replace(/[«»"“”„'’`´(){}\[\].,;:!?\-_/\\+&№#*@|]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  const words = t.split(' ').filter((w) => w && !LEGAL_FORMS.has(w));
  return words.join(' ').trim();
}

/** Ключ для нечёткого сравнения: нормализация + транслит + без пробелов/цифр-разделителей */
function fuzzyKey(raw) {
  const norm = normalizeName(raw);
  let out = '';
  for (const ch of norm) out += CYR_TO_LAT[ch] !== undefined ? CYR_TO_LAT[ch] : ch;
  return out.replace(/[^a-z0-9ա-և]/g, ''); // латиница + армянские буквы
}

/** Нормализация ՀՎՀՀ: только цифры/буквы, без пробелов */
function normalizeHvhh(raw) {
  if (!raw) return '';
  return String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Индекс сущностей для быстрого поиска.
 * entities: массив объектов; nameFields: какие поля содержат названия;
 * hvhhField: поле с ՀՎՀՀ (или null).
 */
function buildIndex(entities, nameFields, hvhhField) {
  const byHvhh = new Map();
  const byName = new Map();
  const byFuzzy = new Map();
  for (const e of entities) {
    if (hvhhField) {
      const h = normalizeHvhh(e[hvhhField]);
      if (h && !byHvhh.has(h)) byHvhh.set(h, e);
    }
    for (const f of nameFields) {
      const n = normalizeName(e[f]);
      if (n && !byName.has(n)) byName.set(n, e);
      const fk = fuzzyKey(e[f]);
      if (fk && fk.length >= RULES.FUZZY_MIN_LEN && !byFuzzy.has(fk)) byFuzzy.set(fk, e);
    }
  }
  return { byHvhh, byName, byFuzzy, entities };
}

/**
 * Поиск сущности в индексе.
 * Возвращает { found, entity, quality }:
 *   quality: 'exact_hvhh' | 'exact_name' | 'fuzzy' | 'none'
 * Fuzzy-совпадение помечается отдельно и в расчётах считается «возможным».
 */
function findMatch(index, { hvhh, names }) {
  const h = normalizeHvhh(hvhh);
  if (h && index.byHvhh.has(h)) {
    return { found: true, entity: index.byHvhh.get(h), quality: 'exact_hvhh' };
  }
  for (const name of names || []) {
    const n = normalizeName(name);
    if (n && index.byName.has(n)) {
      return { found: true, entity: index.byName.get(n), quality: 'exact_name' };
    }
  }
  // нечёткий проход: транслит-ключ (ловит «АрмСофт» ↔ «ArmSoft»)
  for (const name of names || []) {
    const fk = fuzzyKey(name);
    if (fk.length < RULES.FUZZY_MIN_LEN) continue;
    if (index.byFuzzy.has(fk)) {
      return { found: true, entity: index.byFuzzy.get(fk), quality: 'fuzzy' };
    }
  }
  return { found: false, entity: null, quality: 'none' };
}
