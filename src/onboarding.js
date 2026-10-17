// First run: pick a language, then enter the access code. Also used by /logout to take a new code.
//
//   const result = await runOnboarding({ screen, readPrompt, ui, config, makeClient, needLanguage, needCode });
//   -> { ok: true } | { ok: false, cancelled: true } | { ok: false, attempts: true }
//
// Decisions:
//  - The language question is bilingual and accepts "1", "2", the language names in either script and the codes
//    "ar"/"en". An unknown answer asks again (it does not count against anything); Ctrl+C / Esc leaves cleanly.
//  - The code is typed on a masked prompt ("•" per character) and is checked with the service before it is saved:
//    3 attempts. The explanation shown for a failure is the link layer's own friendly text (invalid, expired, not
//    active, offline ...), never the service's words. After an offline failure an empty Enter tries the same code again,
//    so a bad connection does not make anyone retype a long code.
//  - A code is only saved after the service accepted it. It is never echoed, logged or put in an error.
//  - A code that comes from the environment or --code is saved the same way, once, at start-up (rememberAccessCode).
//  - A pasted code often has spaces or a line break inside; they are removed (the service ignores them too).
import { c, sym } from "./ui/theme.js";
import { t, setLang } from "./i18n/index.js";
import { NAME, NAME_AR } from "./brand.js";
import { cleanCode, updateConfig } from "./config.js";
import { isAbortError } from "./link/errors.js";
import { para, vis, contentWidth, footerRow } from "./ui/views.js";
import "./ui/strings-app.js";

export const CODE_ATTEMPTS = 3;
const REMEMBER_TIMEOUT_MS = 5000;
const MIN_CODE_CHARS = 8;

export function parseLanguageAnswer(text) {
  const key = String(text ?? "").trim().toLowerCase().replace(/[.)\s]+$/g, "");
  if (["1", "ar", "arabic", "arab", "عربي", "عربية", "العربية", "ع"].includes(key)) return "ar";
  if (["2", "en", "eng", "english", "انجليزي", "إنجليزي", "انجليزية", "الانجليزية", "الإنجليزية"].includes(key)) return "en";
  return "";
}

const NETWORK_CODES = /^network|^stream_|^bad_response$|^unavailable$|^busy$/;

/** Bilingual language question. Resolves "ar" | "en" | null (cancelled). */
export async function pickLanguage({ screen, readPrompt, ui }) {
  const width = contentWidth(screen.width());
  ui.print(["", ...para(c.bold(`${NAME_AR} · ${NAME}`), width), "", vis(`${c.accent("1")}  العربية`, "ltr"), `${c.accent("2")}  English`, ""]);
  for (;;) {
    const answer = await readPrompt(screen, {
      prefix: c.accent(sym.prompt) + " ",
      history: [],
      commands: [],
      placeholder: "",
      footer: () => [vis(c.dim("  اختر اللغة · Choose your language  (1 / 2)"), "ltr")],
    });
    if (answer.type !== "submit") return null;
    const lang = parseLanguageAnswer(answer.text);
    if (lang) return lang;
    ui.notice("warn", "اكتب 1 للعربية أو 2 للإنجليزية · Type 1 for Arabic or 2 for English");
  }
}

/**
 * Asks for the access code and checks it. Resolves { ok: true, code } | { ok: false, cancelled } | { ok: false, attempts }.
 * Does not save: the caller decides (runOnboarding saves; /logout saves).
 */
export async function askAccessCode({ screen, readPrompt, ui, makeClient, attempts = CODE_ATTEMPTS, signal }) {
  const width = contentWidth(screen.width());
  ui.print(["", ...para(t("app.code.ask"), width), ...para(c.dim(t("app.code.hint")), width), ""]);
  let retryable = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const answer = await readPrompt(screen, {
      prefix: c.accent(sym.prompt) + " ",
      history: [],
      commands: [],
      mask: "•",
      footer: () => [footerRow(c.dim(retryable ? t("app.code.retryHint") : t("app.code.footer")), screen.width())],
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

export function welcomeLines(width) {
  return ["", ...para(`${c.accent(sym.check)} ${c.bold(t("app.welcome.title"))}`, width), ...para(c.dim(t("app.welcome.body")), width), ""];
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
