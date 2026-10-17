// Tiny string table. Each module registers its own strings under a namespace:
//
//   import { registerStrings, t } from "../i18n/index.js";
//   registerStrings("tools", { ar: { reading: "يقرأ" }, en: { reading: "Reading" } });
//   t("tools.reading")                       // -> in the current language
//   t("tools.lines", { n: 12 })              // -> "{n}" placeholders are replaced
//
// A key missing in the current language falls back to English, then to the key itself.

const tables = { ar: Object.create(null), en: Object.create(null) };
let current = "en";

export function registerStrings(namespace, dict) {
  for (const lang of ["ar", "en"]) {
    for (const [key, value] of Object.entries(dict?.[lang] || {})) tables[lang][`${namespace}.${key}`] = String(value);
  }
}

export function setLang(lang) { current = lang === "ar" ? "ar" : "en"; }
export function getLang() { return current; }
export function isArabic() { return current === "ar"; }

export function t(key, params) {
  let text = tables[current][key] ?? tables.en[key] ?? key;
  if (params) text = text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
  return text;
}

/** Picks the first usable language from a locale string such as "ar-IQ" or "en_US.UTF-8". */
export function langFromLocale(locale) {
  return /^ar/i.test(String(locale || "").trim()) ? "ar" : "en";
}

export function systemLang(env = process.env) {
  const raw = env.FIRAS_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || "";
  return langFromLocale(raw);
}
