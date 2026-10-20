// Bilingual strings for the terminal widgets (spinner, banner, input editor, first-run language question), namespace
// "term".
//
// Decisions:
//  - Lists (spinner verbs, tips) are stored as numbered keys: "verb.thinking.1", "verb.thinking.2", ...; tList()
//    collects them, so a language can have a different number of entries than the other.
//  - In Arabic strings every Latin snippet (a key name, a command) sits inside an LTR isolate (U+2066 ... U+2069).
//    Without it the slash of "/copy" or the plus of "Alt+Enter" lands on the wrong side of the word once the line is
//    reordered. The display layer removes the isolates when it rebuilds the line (see textfit.stripBidiMarks).
//  - Digits stay Latin in both languages (terminal fonts and copy/paste behave better).
//  - No harakat / shadda / tanween in UI strings: the Windows console host (ConPTY) gives such a mark a cell of its
//    own, which makes a line wider than the text layer measures it. Verified on the real terminal: a line that is
//    exactly full width by our count wraps and the live region then stacks a new row on every redraw.
import { registerStrings, t, getLang, setLang } from "../i18n/index.js";

const L = s => "\u2066" + s + "\u2069";

registerStrings("term", {
  en: {
    "verb.waiting.1": "Working",
    "verb.waiting.2": "Getting started",
    "verb.waiting.3": "On it",
    "verb.thinking.1": "Thinking",
    "verb.thinking.2": "Pondering",
    "verb.thinking.3": "Working it out",
    "verb.thinking.4": "Reasoning",
    "verb.thinking.5": "Mulling it over",
    "verb.writing.1": "Writing",
    "verb.writing.2": "Putting it together",
    "verb.writing.3": "Drafting",
    "verb.writing.4": "Composing",
    "verb.tool.1": "Running",
    "verb.tool.2": "Carrying it out",
    "verb.tool.3": "Working on it",
    "spinner.interrupt": "Esc to interrupt",
    "unit.s": "s",
    "unit.m": "m",
    "unit.h": "h",

    "input.exitHint": "Press Ctrl+C again to exit",
    // The prompt box builds its hint from the parts in strings-input.js; this whole sentence says the same, for any other
    // caller that wants it in one piece.
    "input.placeholder": "Type a message · / for commands and skills · @ for a file",
    "input.moreAbove": "{n} more above",
    "input.moreBelow": "{n} more below",
    "chip.label": "pasted text",
    "count.lines.one": "{n} line",
    "count.lines.two": "{n} lines",
    "count.lines.few": "{n} lines",
    "count.lines.many": "{n} lines",
    "count.chars.one": "{n} char",
    "count.chars.two": "{n} chars",
    "count.chars.few": "{n} chars",
    "count.chars.many": "{n} chars",

    "banner.effort": "effort:",
    "banner.mode": "mode:",
    "banner.resumed": "resumed session",
    "banner.hint": "type / for commands and skills, @ to add a file",
    "banner.tip": "Tip:",
    // The key line under the welcome card: what each key opens (the keys themselves are written in banner.js).
    "banner.key.help": "commands",
    "banner.key.effort": "effort",
    "banner.key.mode": "mode",
    "tip.1": "Type / for commands and skills, @ to add a file",
    "tip.2": "/effort opens a picker: arrows choose, Tab jumps to ultracode",
    "tip.3": "/skills lists your skills; each one runs from the / menu",
    "tip.4": "Shift+Tab changes the permission mode",
    "tip.5": "Esc stops the task in progress",
    "tip.6": "Ctrl+J, or \\ then Enter, starts a new line",
    "tip.7": "/copy copies my last answer",
    "tip.8": "type / for commands and skills",

    // The first-run language question shows both languages at once, each read from its own table (onboarding.js).
    "lang.title": "Language",
    "lang.ask": "Choose your language",
    "lang.ar": "Arabic",
    "lang.en": "English",
    "lang.type": "Type 1 or 2",
    "lang.enter": "Enter to confirm",

    "mode.default": "default",
    "mode.acceptEdits": "accept edits",
    "mode.plan": "plan",
    "mode.bypass": "bypass",
    "effort.low": "low",
    "effort.medium": "medium",
    "effort.high": "high",
    "effort.xhigh": "extra high",
    "effort.max": "max",
    "effort.ultracode": "ultracode",
  },
  ar: {
    "verb.waiting.1": "يبدأ العمل",
    "verb.waiting.2": "يستعد",
    "verb.waiting.3": "لحظة",
    "verb.thinking.1": "يفكر",
    "verb.thinking.2": "يتأمل",
    "verb.thinking.3": "يدرس الأمر",
    "verb.thinking.4": "يستنتج",
    "verb.thinking.5": "يراجع أفكاره",
    "verb.writing.1": "يكتب",
    "verb.writing.2": "يصوغ الرد",
    "verb.writing.3": "يرتب الإجابة",
    "verb.writing.4": "يحرر",
    "verb.tool.1": "ينفذ",
    "verb.tool.2": "يعمل على المهمة",
    "verb.tool.3": "يتابع التنفيذ",
    "spinner.interrupt": `${L("Esc")} للإيقاف`,
    "unit.s": "ث",
    "unit.m": "د",
    "unit.h": "س",

    "input.exitHint": `اضغط ${L("Ctrl+C")} مرة أخرى للخروج`,
    "input.placeholder": `اكتب رسالتك · ${L("/")} للأوامر والمهارات · ${L("@")} لإضافة ملف`,
    "input.moreAbove": "{n} أخرى أعلاه",
    "input.moreBelow": "{n} أخرى أسفله",
    "chip.label": "نص ملصوق",
    "count.lines.one": "سطر واحد",
    "count.lines.two": "سطران",
    "count.lines.few": "{n} أسطر",
    "count.lines.many": "{n} سطرا",
    "count.chars.one": "حرف واحد",
    "count.chars.two": "حرفان",
    "count.chars.few": "{n} أحرف",
    "count.chars.many": "{n} حرفا",

    "banner.effort": "الجهد:",
    "banner.mode": "الوضع:",
    "banner.resumed": "جلسة مستأنفة",
    "banner.hint": `اكتب ${L("/")} للأوامر والمهارات، ${L("@")} لإضافة ملف`,
    "banner.tip": "نصيحة:",
    "banner.key.help": "لعرض الأوامر",
    "banner.key.effort": "الجهد",
    "banner.key.mode": "الوضع",
    "tip.1": `اكتب ${L("/")} للأوامر والمهارات، ${L("@")} لإضافة ملف`,
    "tip.2": `${L("/effort")} يفتح قائمة: اختر بالأسهم، و${L("Tab")} يقفز إلى ${L("ultracode")}`,
    "tip.3": `${L("/skills")} يعرض مهاراتك، وكل مهارة تعمل من قائمة ${L("/")}`,
    "tip.4": `${L("Shift+Tab")} يبدل وضع الأذونات`,
    "tip.5": `${L("Esc")} يوقف المهمة الجارية`,
    "tip.6": `${L("Ctrl+J")} أو ${L("\\")} ثم ${L("Enter")} لبدء سطر جديد`,
    "tip.7": `الأمر ${L("/copy")} ينسخ آخر إجابة`,
    "tip.8": `اكتب ${L("/")} للأوامر والمهارات`,

    "lang.title": "اللغة",
    "lang.ask": "اختر اللغة",
    "lang.ar": "العربية",
    "lang.en": "الإنجليزية",
    "lang.type": "اكتب 1 أو 2",
    "lang.enter": `${L("Enter")} للتأكيد`,

    "mode.default": "عادي",
    "mode.acceptEdits": "قبول التعديلات",
    "mode.plan": "تخطيط",
    "mode.bypass": "تجاوز الأذونات",
    "effort.low": "منخفض",
    "effort.medium": "متوسط",
    "effort.high": "مرتفع",
    "effort.xhigh": "مرتفع جدا",
    "effort.max": "الأقصى",
    // A name, like the product's: kept in Latin letters in both languages, and painted in its rainbow (src/ui/ultra.js).
    "effort.ultracode": L("ultracode"),
  },
});

/**
 * Runs fn with the interface language switched to `lang` and puts the previous one back. Widgets that are told their
 * language per call (spinner, banner) use it so they never depend on what the rest of the app has selected.
 */
export function withLang(lang, fn) {
  const previous = getLang();
  const wanted = lang === "ar" ? "ar" : "en";
  if (previous === wanted) return fn();
  setLang(wanted);
  try {
    return fn();
  } finally {
    setLang(previous);
  }
}

/** Every "<prefix>.1", "<prefix>.2", ... entry of the current language, in order. */
export function tList(prefix) {
  const out = [];
  for (let i = 1; ; i++) {
    const key = `term.${prefix}.${i}`;
    const v = t(key);
    if (v === key) break;
    out.push(v);
  }
  return out;
}

function lookup(group, name) {
  const key = `term.${group}.${name}`;
  const v = t(key);
  return v === key ? String(name) : v;
}

/** Permission mode name for display: "default" | "acceptEdits" | "plan" | "bypass" (unknown values pass through). */
export function modeLabel(mode) {
  return lookup("mode", mode);
}

/** Effort name for display: "low" | "medium" | "high" | "xhigh" | "max" | "ultracode". */
export function effortLabel(effort) {
  return lookup("effort", effort);
}

/** "12 lines" / "سطران" ... the grammatical form for a count. kind: "lines" | "chars". */
export function countText(kind, n) {
  const r = n % 100;
  // Arabic counts by the last two digits: 101 is "one", 102 is "two", 103-110 are "few", 111+ is "many".
  const form = r === 1 ? "one" : r === 2 ? "two" : r >= 3 && r <= 10 ? "few" : "many";
  return t(`term.count.${kind}.${form}`, { n });
}
