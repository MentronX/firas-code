// First run: pick a language, then enter the access code. Also used by /logout to take a new code.
//
//   const result = await runOnboarding({ screen, readPrompt, ui, config, makeClient, needLanguage, needCode });
//   -> { ok: true } | { ok: false, cancelled: true } | { ok: false, attempts: true }
//
//   Language                                                       اللغة
//
//   1  Arabic                                                العربية  1
//   2  English                                            الإنجليزية  2
//   ────────────────────────────────────────────────────────────────────
//   ›
//   ────────────────────────────────────────────────────────────────────
//     Choose your language · Type 1 or 2         اكتب 1 أو 2 · اختر اللغة
//
// Decisions:
//  - It looks like the product that follows it: lines laid out for the text column (ui.print adds the gutter), titles
//    bold, explanations and hints dim, the numbers to type in the accent, the prompt glyph accent, the closing check
//    green. Glyphs come from sym, including the one that stands for each character of the hidden code.
//  - The language question comes before there is a language, so it speaks both at once: English at the left edge and
//    Arabic at the right edge of the same rows, each from its own table (term.lang.*), each starting on its reader's
//    side. A terminal too narrow for both on one row gets the English rows first, then the Arabic rows right-aligned.
//  - The question itself is the first part of the hint under the prompt, where the eye is while typing; the title above
//    the choices only names the subject. Hints are built from parts and lose parts from the end instead of wrapping; a
//    sentence that is still too long is shortened as LOGICAL text before it is ordered, so an Arabic hint keeps its
//    start.
//  - The language question accepts "1", "2", the language names in either script and the codes "ar"/"en". An unknown
//    answer asks again (it does not count against anything); Ctrl+C / Esc leaves cleanly.
//  - The code is typed on a masked prompt and is checked with the service before it is saved: 3 attempts. The
//    explanation shown for a failure is the link layer's own friendly text (invalid, expired, not active, offline ...),
//    never the service's words. After an offline failure an empty Enter tries the same code again, so a bad connection
//    does not make anyone retype a long code.
//  - A code is only saved after the service accepted it. It is never echoed, logged or put in an error.
//  - A code that comes from the environment or --code is saved the same way, once, at start-up (rememberAccessCode).
//  - A pasted code often has spaces or a line break inside; they are removed (the service ignores them too).
import { c, sym } from "./ui/theme.js";
import { t, setLang, getLang } from "./i18n/index.js";
import { cleanCode, updateConfig } from "./config.js";
import { isAbortError } from "./link/errors.js";
import { para, contentWidth } from "./ui/views.js";
import { arabicActive, hasRtl, stringWidth, toVisual } from "./text/display.js";
import { fitLogical, stripBidiMarks } from "./ui/textfit.js";
import { withLang } from "./ui/strings.js";
import "./ui/strings-app.js";

export const CODE_ATTEMPTS = 3;
const REMEMBER_TIMEOUT_MS = 5000;
const MIN_CODE_CHARS = 8;
// The least space between the English and the Arabic half of a row before they go on rows of their own.
const MIN_GAP = 4;

export function parseLanguageAnswer(text) {
  const key = String(text ?? "").trim().toLowerCase().replace(/[.)\s]+$/g, "");
  if (["1", "ar", "arabic", "arab", "عربي", "عربية", "العربية", "ع"].includes(key)) return "ar";
  if (["2", "en", "eng", "english", "انجليزي", "إنجليزي", "انجليزية", "الانجليزية", "الإنجليزية"].includes(key)) return "en";
  return "";
}

const NETWORK_CODES = /^network|^stream_|^bad_response$|^unavailable$|^busy$/;

/** One logical line shaped and ordered: left-to-right as it is, right-to-left right-aligned to `width` when given. */
function lay(styled, rtl, width) {
  return stripBidiMarks(toVisual(styled, rtl ? { dir: "rtl", width, align: "end" } : { dir: "ltr" }));
}

/** Logical text shortened (never after ordering) to `room` columns. */
const fit = (text, room) => (stringWidth(text) > room ? fitLogical(text, room, sym.ellipsis) : text);

/** The parts that fit in `room`, joined; parts go from the end, and a first part that is still too long is shortened. */
function fitParts(parts, room, sep = ` ${sym.dot} `) {
  for (let n = parts.length; n > 1; n--) {
    const line = parts.slice(0, n).join(sep);
    if (stringWidth(line) <= room) return line;
  }
  return fit(parts[0] ?? "", room);
}

/** A term.lang.* string in both languages. */
const both = key => ({ en: withLang("en", () => t(`term.lang.${key}`)), ar: withLang("ar", () => t(`term.lang.${key}`)) });

/**
 * Rows of [english, arabic] for a column `width` wide: the English at the left edge and the Arabic at the right edge of
 * each row, or - when any row cannot hold both - all the English rows, then all the Arabic rows right-aligned.
 */
function bilingualRows(pairs, width) {
  const rows = pairs.map(([en, ar]) => [fit(en, width), fit(ar, width)]);
  const side = rows.every(([en, ar]) => !en || !ar || stringWidth(en) + MIN_GAP + stringWidth(ar) <= width);
  const english = en => (en ? lay(en, false) : "");
  const arabic = ar => (ar ? lay(ar, true, width) : "");
  if (!side) return [...rows.map(([en]) => english(en)), ...rows.map(([, ar]) => arabic(ar))];
  return rows.map(([en, ar]) => {
    if (!ar) return english(en);
    if (!en) return arabic(ar);
    return lay(en, false) + " ".repeat(width - stringWidth(en) - stringWidth(ar)) + lay(ar, true);
  });
}

/**
 * The hint under the language prompt, in the same text column as the question above it: both languages on one row, or
 * one row each. The prompt's footer rows are drawn as they are, so the gutter - and, while the interface is Arabic,
 * the margin that puts the column against the right edge (as interactive.js prints everything) - is added here.
 */
function languageHint(columns) {
  const width = contentWidth(columns);
  const lead = "  " + (getLang() === "ar" && arabicActive() ? " ".repeat(Math.max(0, columns - 4 - width)) : "");
  const parts = ["ask", "type", "enter"].map(both);
  const en = parts.map(p => p.en);
  const ar = parts.map(p => p.ar);
  const sep = ` ${sym.dot} `;
  for (let n = en.length; n > 0; n--) {
    const left = en.slice(0, n).join(sep);
    const right = ar.slice(0, n).join(sep);
    const gap = width - stringWidth(left) - stringWidth(right);
    if (gap >= MIN_GAP) return [`${lead}${lay(c.dim(left), false)}${" ".repeat(gap)}${lay(c.dim(right), true)}`];
  }
  return [lead + lay(c.dim(fitParts(en, width)), false), lead + lay(c.dim(fitParts(ar, width)), true, width)];
}

/** One hint row under the prompt: dim, the two-column gutter on its reading side, fitted before it is ordered. */
function hintRow(text, columns) {
  const room = Math.max(1, columns - 4);
  const shown = fit(String(text ?? ""), room);
  return hasRtl(shown) ? lay(c.dim(shown), true, columns - 2) : `  ${lay(c.dim(shown), false)}`;
}

/** Bilingual language question. Resolves "ar" | "en" | null (cancelled). */
export async function pickLanguage({ screen, readPrompt, ui }) {
  const width = contentWidth(screen.width());
  const title = both("title");
  const arabic = both("ar");
  const english = both("en");
  const option = (n, name) => `${c.accent(n)}  ${name}`;
  ui.print(["", ...bilingualRows([
    [c.bold(title.en), c.bold(title.ar)],
    ["", ""],
    [option("1", arabic.en), option("1", arabic.ar)],
    [option("2", english.en), option("2", english.ar)],
  ], width), ""]);
  for (;;) {
    const answer = await readPrompt(screen, {
      prefix: c.accent(sym.prompt) + " ",
      history: [],
      commands: [],
      placeholder: "",
      footer: () => languageHint(screen.width()),
    });
    if (answer.type !== "submit") return null;
    const lang = parseLanguageAnswer(answer.text);
    if (lang) return lang;
    // One notice, a paragraph per language: each takes its own direction and edge instead of one mixed line.
    ui.notice("warn", "اكتب 1 للعربية أو 2 للإنجليزية\nType 1 for Arabic or 2 for English");
  }
}

/**
 * Asks for the access code and checks it. Resolves { ok: true, code } | { ok: false, cancelled } | { ok: false, attempts }.
 * Does not save: the caller decides (runOnboarding saves; /logout saves).
 */
export async function askAccessCode({ screen, readPrompt, ui, makeClient, attempts = CODE_ATTEMPTS, signal }) {
  const width = contentWidth(screen.width());
  ui.print(["", ...para(c.bold(t("app.code.ask")), width), ...para(c.dim(t("app.code.hint")), width), ""]);
  let retryable = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const answer = await readPrompt(screen, {
      prefix: c.accent(sym.prompt) + " ",
      history: [],
      commands: [],
      mask: sym.bullets[0],
      footer: () => [hintRow(retryable ? t("app.code.retryHint") : t("app.code.footer"), screen.width())],
    });
    if (answer.type !== "submit") return { ok: false, cancelled: true };
    let code = cleanCode(answer.text);
    if (!code && retryable) code = retryable;
    if (!code) { attempt -= 1; continue; }
    if (code.length < MIN_CODE_CHARS || !/^[\x21-\x7e]+$/.test(code)) {
      ui.notice("warn", t("app.code.shape"));
      retryable = "";
      continue;
    }
    ui.notice("info", t("app.code.checking"));
    try {
      await makeClient(() => code).checkAccess({ signal });
      return { ok: true, code };
    } catch (error) {
      if (isAbortError(error)) return { ok: false, cancelled: true };
      retryable = NETWORK_CODES.test(error?.code || "") ? code : "";
      ui.notice("error", error?.userMessage || t("app.code.failed"));
    }
  }
  ui.notice("error", t("app.code.giveUp"));
  return { ok: false, attempts: true };
}

/**
 * A code that arrived from the environment (the installers launch the app that way) or from --code is saved once the
 * service has accepted it, so the next start needs neither. Everything about it is quiet and safe:
 *  - an invalid or expired code is never saved (the first message then explains the problem in the usual way);
 *  - when the service cannot be reached within `timeoutMs` nothing is saved and nothing fails: the session simply goes
 *    on with the code it has in memory, and the next start tries again;
 *  - the code itself is never printed.
 * Resolves true when it was saved.
 */
export async function rememberAccessCode({ config, makeClient, ui, signal, timeoutMs = REMEMBER_TIMEOUT_MS }) {
  const code = config.code;
  if (!code || config.stored?.code === code) return false;
  const control = new AbortController();
  const stop = () => control.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  try {
    await makeClient(() => code).checkAccess({ signal: control.signal });
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
  if (!updateConfig(config, { code }).ok) return false;
  ui.notice("info", t("app.code.saved"));
  return true;
}

/** The closing lines: a green check and the title, the explanation dim and hanging under the title's text. */
export function welcomeLines(width) {
  const hang = " ".repeat(stringWidth(sym.check) + 1);
  return [
    "",
    ...para(`${c.green(sym.check)} ${c.bold(t("app.welcome.title"))}`, width, { indent: hang }),
    ...para(c.dim(t("app.welcome.body")), width, { firstIndent: hang, indent: hang }),
    "",
  ];
}

/**
 * The whole first-run flow. `config` is updated and saved as the answers arrive.
 * makeClient(getCode) builds a service client that reads its code from `getCode`.
 */
export async function runOnboarding({ screen, readPrompt, ui, config, makeClient, needLanguage = true, needCode = true, signal }) {
  if (needLanguage) {
    const lang = await pickLanguage({ screen, readPrompt, ui });
    if (!lang) return { ok: false, cancelled: true };
    setLang(lang);
    updateConfig(config, { lang });
  }
  if (needCode) {
    const result = await askAccessCode({ screen, readPrompt, ui, makeClient, signal });
    if (!result.ok) return result;
    updateConfig(config, { code: result.code });
    if (!config.code) config.code = result.code;
  }
  ui.print(welcomeLines(contentWidth(screen.width())));
  return { ok: true };
}
