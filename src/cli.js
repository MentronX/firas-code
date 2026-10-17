// The application: flags, start-up, the interactive loop, print mode, the update subcommand.
//
//   main(args)                       the real program (bin/firas.js): sets the exit code and ends the process cleanly
//   main(args, { stdin, stdout, stderr, env, cwd, fetchImpl, clientOptions, screen, process, graceMs, ... })
//                                    the same code with everything injected (tests); nothing global is touched and the
//                                    exit code is returned. Settings and sessions still live under homeDir()
//                                    (FIRAS_HOME), so tests point that at a temporary folder.
//
// Exit codes: 0 done, 1 error, 2 usage, 130 interrupted (Ctrl+C / SIGINT / SIGTERM, or a print-mode run that was stopped).
//
// Decisions:
//  - Order of precedence for each setting: flag > environment > settings file > built-in default.
//  - `-p` takes the prompt from the next word, then from any bare words after the flags, then from stdin when stdin is
//    piped. Without `-p`, bare words are the first message of an interactive session.
//  - `-r` takes an id only when the next word looks like a session id (starts with 8 digits, the date); otherwise it
//    would swallow the first word of a prompt. `--resume=<id>` is always an id. `-r` alone picks from a list
//    (interactive) or means "the latest" (print mode).
//  - Print mode asks nobody anything: permission requests are denied unless the mode already allows them (see plain.js).
//  - A fatal error is one friendly line; the stack appears only with FIRAS_DEBUG=1.
//  - The terminal is restored on every way out: normal exit, signals, uncaught errors.
import path from "node:path";
import { VERSION, NAME, NAME_AR, DEFAULT_ORIGIN } from "./brand.js";
import { t, setLang, getLang, systemLang } from "./i18n/index.js";
import { c, sym, refreshColorLevel, setColorLevel } from "./ui/theme.js";
import { setArabicMode, stringWidth, toVisual } from "./text/display.js";
import { loadConfig, updateConfig, cleanCode, EFFORTS, normalizeEffort } from "./config.js";
import { createServiceClient } from "./link/client.js";
import { isAbortError } from "./link/errors.js";
import { createSession, loadSession, latestSession, listSessions } from "./agent/session.js";
import { runUserTurn } from "./agent/loop.js";
import { createAgentTool } from "./agent/subagent.js";
import { createToolbox, createPermissionEngine } from "./tools/index.js";
import { createScreen } from "./ui/screen.js";
import { readPrompt as defaultReadPrompt } from "./ui/input.js";
import { renderBanner } from "./ui/banner.js";
import { renderMarkdown } from "./ui/markdown.js";
import { createInteractiveUi } from "./ui/interactive.js";
import { createPlainUi } from "./ui/plain.js";
import { loadHistory, appendHistory } from "./ui/history.js";
import { createFileIndex } from "./ui/files.js";
import { contentWidth, cleanText, vis } from "./ui/views.js";
import { modeLabel, effortLabel } from "./ui/strings.js";
import { fitLogical, stripBidiMarks } from "./ui/textfit.js";
import { dispatch, commandMenu } from "./commands/index.js";
import { parseMode } from "./commands/mode.js";
import { runOnboarding, askAccessCode, rememberAccessCode } from "./onboarding.js";
import { runUpdate } from "./update.js";
import { updateFailureText } from "./commands/update.js";
import { resumeFlow } from "./commands/resume.js";
import { shouldFixConsoleFont, fixConsoleFont, fontStillBroken } from "./ui/winfont.js";
import { paintUltra, mentionsUltra } from "./ui/ultra.js";
import "./ui/strings-app.js";

const SESSION_ID = /^\d{8}(?:-\d{6}(?:-[0-9a-f]{1,6})?)?$/;
const windowTitle = cwd => `${NAME} - ${path.basename(cwd) || cwd}`;
const STDIN_LIMIT = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------------
// Flags

const VALUE_FLAGS = { "--code": "code", "--origin": "origin", "--effort": "effort", "--mode": "mode", "--lang": "lang" };

/**
 * Parses the command line. Returns { opts } or { error: { kind, flag, value? } }.
 * opts: { print, prompt, continue, resume, code, origin, effort, mode, yolo, lang, noArabic, noColor, version, help, update, words }
 */
export function parseArgs(args) {
  const opts = { print: false, prompt: "", continue: false, resume: undefined, code: "", origin: "", effort: "", mode: "", yolo: false, lang: "", noArabic: false, noColor: false, version: false, help: false, update: false, words: [] };
  const list = [...args];
  let onlyWords = false;
  const takesWord = next => next !== undefined && !next.startsWith("-");
  while (list.length) {
    const arg = list.shift();
    if (onlyWords || !arg.startsWith("-") || arg === "-") { opts.words.push(arg); continue; }
    if (arg === "--") { onlyWords = true; continue; }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    switch (flag) {
      case "-h": case "--help": opts.help = true; break;
      case "-v": case "-V": case "--version": opts.version = true; break;
      case "-c": case "--continue": opts.continue = true; break;
      case "--yolo": opts.yolo = true; break;
      case "--no-arabic": opts.noArabic = true; break;
      case "--no-color": opts.noColor = true; break;
      case "-p": case "--print":
        opts.print = true;
        if (inline !== undefined) opts.prompt = inline;
        else if (takesWord(list[0])) opts.prompt = list.shift();
        break;
      case "-r": case "--resume":
        if (inline !== undefined) opts.resume = inline;
        else if (list[0] !== undefined && SESSION_ID.test(list[0])) opts.resume = list.shift();
        else opts.resume = true;
        break;
      default: {
        const key = VALUE_FLAGS[flag];
        if (!key) return { error: { kind: "unknown", flag } };
        const value = inline !== undefined ? inline : list.shift();
        if (value === undefined || (inline === undefined && value.startsWith("--"))) return { error: { kind: "missing", flag } };
        opts[key] = value;
      }
    }
  }
  if (opts.effort) {
    const level = normalizeEffort(opts.effort);
    if (!level) return { error: { kind: "value", flag: "--effort", value: opts.effort.toLowerCase(), allowed: EFFORTS.join(" | ") } };
    opts.effort = level;
  }
  if (opts.mode) {
    const mode = parseMode(opts.mode);
    if (!mode) return { error: { kind: "value", flag: "--mode", value: opts.mode, allowed: "default | acceptEdits | plan | bypass" } };
    opts.mode = mode;
  }
  if (opts.lang) {
    const lang = opts.lang.trim().toLowerCase().slice(0, 2);
    if (lang !== "ar" && lang !== "en") return { error: { kind: "value", flag: "--lang", value: opts.lang, allowed: "ar | en" } };
    opts.lang = lang;
  }
  if (opts.words[0] === "update" && !opts.print && opts.words.length === 1) { opts.update = true; opts.words = []; }
  if (opts.print && opts.words.length) opts.prompt = [opts.prompt, ...opts.words].filter(Boolean).join(" ");
  else if (!opts.print) opts.prompt = opts.words.join(" ");
  return { opts };
}

const HELP = {
  en: [
    `${NAME} - a coding agent for your terminal`,
    "",
    "Usage",
    "  firas [options] [message]        start a conversation (the message is sent first)",
    "  firas -p \"message\"               run once, print the answer and exit",
    "  firas update                     install the latest version",
    "",
    "Options",
    "  -p, --print [message]   run once and print the answer (piped input is the message)",
    "  -c, --continue          continue the latest conversation in this folder",
    "  -r, --resume [id]       resume a saved conversation (no id: choose from a list)",
    "      --code <code>       save an access code and continue",
    "      --effort <level>    low | medium | high | xhigh | max | ultracode",
    "      --mode <mode>       default | acceptEdits | plan | bypass",
    "      --yolo              skip permission prompts (dangerous actions still ask)",
    "      --lang <ar|en>      interface language",
    "      --no-arabic         do not shape or reorder Arabic (for terminals that already do)",
    "      --no-color          no colours",
    "  -v, --version           print the version",
    "  -h, --help              show this help",
    "",
    "Exit codes: 0 done, 1 error, 2 wrong usage, 130 interrupted",
  ],
  ar: [
    `${NAME_AR} - وكيل برمجة داخل الطرفية`,
    "",
    "الاستخدام",
    "  firas [خيارات] [رسالة]            ابدأ محادثة (تُرسَل الرسالة أولاً)",
    "  firas -p \"رسالة\"                  نفّذ مرة واحدة واطبع الجواب ثم اخرج",
    "  firas update                     ثبّت أحدث إصدار",
    "",
    "الخيارات",
    "  -p, --print [رسالة]     نفّذ مرة واحدة واطبع الجواب (المدخل المُمرَّر هو الرسالة)",
    "  -c, --continue          تابع آخر محادثة في هذا المجلد",
    "  -r, --resume [id]       استأنف محادثة محفوظة (بلا id: اختر من قائمة)",
    "      --code <code>       احفظ رمز الدخول وتابع",
    "      --effort <level>    low | medium | high | xhigh | max | ultracode",
    "      --mode <mode>       default | acceptEdits | plan | bypass",
    "      --yolo              تخطَّ أسئلة الأذونات (الأفعال الخطرة تسأل دائماً)",
    "      --lang <ar|en>      لغة الواجهة",
    "      --no-arabic         لا تشكّل العربية ولا تعيد ترتيبها (لطرفية تفعل ذلك بنفسها)",
    "      --no-color          بلا ألوان",
    "  -v, --version           اطبع رقم الإصدار",
    "  -h, --help              اعرض هذه المساعدة",
    "",
    "رموز الخروج: 0 تمّ، 1 خطأ، 2 استخدام خاطئ، 130 مقاطَعة",
  ],
};

/** The help text as printable lines (shaped and ordered for a terminal when `visual`). */
export function helpLines(lang, visual) {
  const lines = HELP[lang === "ar" ? "ar" : "en"];
  if (!visual) return lines.map(line => stripBidiMarks(line));
  return lines.map(line => (/^\s{2}/.test(line) && lang === "ar" ? toVisualMixed(line) : toVisual(line, { dir: "auto" })));
}

// Option rows start with a Latin flag column followed by an Arabic description: keep the row left-to-right overall.
function toVisualMixed(line) {
  return toVisual(line, { dir: "ltr" });
}

// ---------------------------------------------------------------------------------------------------------------------
// Small helpers

function readAll(stream, limit = STDIN_LIMIT) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    stream.on("data", chunk => {
      size += chunk.length;
      if (size <= limit) chunks.push(Buffer.from(chunk));
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
    if (stream.readableEnded) resolve("");
  });
}

/**
 * The program ends by itself with this exit code once nothing is left to do: calling process.exit() while a socket is
 * still closing can abort the process on Windows. A handle that stays open anyway is cut after a grace period (the
 * timer is unref'd, so it never keeps the process alive on its own).
 */
function finishProcess(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 4000).unref();
}

/** The quiet line shown while the client waits to try again: a lost connection is not "busy". */
export function retryText({ delayMs, error } = {}) {
  return t(/^network/.test(error?.code || "") ? "app.retryingLink" : "app.retrying", { secs: Math.max(1, Math.round((delayMs || 0) / 1000)) });
}

function writeLine(stream, text) {
  const line = stream.isTTY ? toVisual(text, { dir: "auto" }) : stripBidiMarks(text);
  stream.write(line + "\n");
}

function exitCodeFor(stopReason) {
  if (stopReason === "aborted") return 130;
  return stopReason === "error" || stopReason === "empty" ? 1 : 0;
}

function lastText(message) {
  return (message?.content || []).filter(block => block.type === "text").map(block => block.text).join("\n").trim();
}

// ---------------------------------------------------------------------------------------------------------------------
// main

export async function main(args = [], io) {
  const injected = io !== undefined;
  const env = io?.env ?? process.env;
  let code = 1;
  const guard = injected ? null : installFatalHandlers(io || {});
  try {
    code = await run(args, { ...(io || {}), env, injected });
  } catch (error) {
    code = fatal(error, io?.stderr ?? process.stderr, env);
  } finally {
    guard?.();
  }
  if (!injected) finishProcess(code);
  return code;
}

function fatal(error, stderr, env) {
  try { writeLine(stderr, `${sym.cross} ${t("app.fatal")}`); } catch { /* stderr is gone */ }
  if (env.FIRAS_DEBUG) { try { stderr.write(`${error?.stack || error}\n`); } catch { /* nothing left to tell */ } }
  return 1;
}

function installFatalHandlers() {
  const onFatal = error => {
    process.exitCode = fatal(error, process.stderr, process.env);
    process.exit();
  };
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  return () => {
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
  };
}

async function run(args, io) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;
  const env = io.env;
  const cwd = path.resolve(io.cwd ?? process.cwd());

  const parsed = parseArgs(args);
  setLang(systemLang(env));
  if (parsed.error) return usageError(parsed.error, stderr);
  const opts = parsed.opts;

  if (opts.version) { stdout.write(`${VERSION}\n`); return 0; }

  const config = loadConfig({ env });
  const lang = opts.lang || config.lang || systemLang(env);
  setLang(lang);
  setArabicMode(opts.noArabic ? "off" : config.arabic);
  if (opts.noColor) setColorLevel(0);
  else refreshColorLevel(env, stdout);

  if (opts.help) {
    for (const line of helpLines(lang, !!stdout.isTTY)) stdout.write(line + "\n");
    return 0;
  }
  if (opts.update) return updateSubcommand({ stdout, stderr, cwd, env, io });

  const origin = opts.origin || config.origin || DEFAULT_ORIGIN;
  const makeClient = getCode => createServiceClient({
    origin,
    getCode,
    version: VERSION,
    lang: () => getLang(),
    ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
    ...(io.clientOptions || {}),
    ...(io.onRetry ? { onRetry: io.onRetry } : {}),
  });
  try { makeClient(() => ""); } catch (error) {
    writeLine(stderr, `${sym.cross} ${error?.userMessage || t("app.fatal")}`);
    return 2;
  }

  const wantsPrint = opts.print;
  if (!wantsPrint && !io.screen && (!stdin.isTTY || !stdout.isTTY)) {
    writeLine(stderr, `${sym.cross} ${t("app.cli.needTerminal")}`);
    return 2;
  }

  // --code: validated, then saved, then the program carries on with it.
  if (opts.code) {
    const candidate = cleanCode(opts.code);
    try {
      await makeClient(() => candidate).checkAccess();
    } catch (error) {
      writeLine(stderr, `${sym.cross} ${error?.userMessage || t("app.code.failed")}`);
      return 1;
    }
    updateConfig(config, { code: candidate });
    config.code = candidate;
  }

  // The classic Windows console draws Arabic with the one font of its window; a font without Arabic letters is swapped
  // for one with them, in the background (src/ui/winfont.js). Never in tests, where nothing global may change.
  const fontFix = !io.injected && shouldFixConsoleFont({ env, stdout }) ? fixConsoleFont({ env, title: wantsPrint ? "" : windowTitle(cwd) }) : null;

  const shared = { opts, config, cwd, env, io, stdin, stdout, stderr, makeClient, fontFix };
  return wantsPrint ? runPrint(shared) : runInteractive(shared);
}

function usageError(error, stderr) {
  const text = error.kind === "unknown" ? t("app.cli.unknownFlag", { flag: error.flag })
    : error.kind === "missing" ? t("app.cli.missingValue", { flag: error.flag })
      : t("app.cli.badValue", { flag: error.flag, value: error.value, allowed: error.allowed });
  writeLine(stderr, `${sym.cross} ${text}`);
  writeLine(stderr, t("app.cli.tryHelp"));
  return 2;
}

// ---------------------------------------------------------------------------------------------------------------------
// firas update

async function updateSubcommand({ stdout, stderr, cwd, env, io }) {
  writeLine(stdout, t("app.update.running"));
  const run = io.runUpdate || runUpdate;
  const result = await run({
    cwd, env, platform: io.platform, ...(io.updateOptions || {}),
    onOutput: (text, stream) => (stream === "stderr" ? stderr : stdout).write(text),
  });
  if (result.ok) { writeLine(stdout, `${sym.check} ${t("app.update.done")}`); return 0; }
  writeLine(stderr, `${sym.cross} ${updateFailureText(result)}`);
  return 1;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sessions and the pieces both modes build

/**
 * The session to start with: a saved one (--resume <id>, --continue, or "the latest" for a bare --resume in print
 * mode) or a new one. `-r` with no id in interactive mode starts a new session and lets the caller show the picker.
 */
function openSession({ opts, cwd, mode, notify, pickLater = false }) {
  if (opts.resume !== undefined && opts.resume !== true) {
    const wanted = String(opts.resume);
    let session = loadSession(wanted);
    if (!session) {
      const matches = listSessions({ cwd, limit: 500 }).filter(item => item.id.startsWith(wanted));
      session = matches.length === 1 ? loadSession(matches[0].id) : null;
    }
    if (session) { session.cwd = cwd; return { session, resumed: true }; }
    notify("warn", t("app.resume.notFound", { id: wanted }));
  } else if (opts.continue || (opts.resume === true && !pickLater)) {
    const session = latestSession(cwd);
    if (session) { session.cwd = cwd; return { session, resumed: true }; }
    notify("info", t("app.session.noPrevious"));
  }
  return { session: createSession({ cwd, mode }), resumed: false };
}

function buildEngine({ ui, client, config, session, cwd, mode, effortRef }) {
  const permissions = createPermissionEngine({ mode, cwd, ui, config });
  let toolbox = null;
  const base = () => ({ client, ui, permissions, toolbox: () => toolbox, getEffort: () => effortRef.value });
  // The tool is rebuilt per call so the sub-agent follows /lang and /effort made after start-up.
  const agentTool = { ...createAgentTool({ ...base(), lang: getLang() }), run: (input, ctx) => createAgentTool({ ...base(), lang: getLang() }).run(input, ctx) };
  toolbox = createToolbox({ cwd, ui, client, config, session, mode, permissions, extraTools: [agentTool] });
  return { permissions, toolbox };
}

// ---------------------------------------------------------------------------------------------------------------------
// Print mode

async function runPrint({ opts, config, cwd, env, io, stdin, stdout, stderr, makeClient }) {
  const notify = (level, text) => writeLine(stderr, `${level === "error" ? sym.cross : level === "warn" ? sym.warn : sym.info} ${text}`);
  if (!config.code) { notify("error", t("app.print.noCode")); return 1; }

  // The message comes from the command line; only when there is none is a piped stdin read (it would never end
  // for a caller that leaves stdin open).
  let prompt = opts.prompt.trim();
  if (!prompt && !stdin.isTTY) prompt = (await readAll(stdin)).trim();
  if (!prompt) { notify("error", t("app.print.noPrompt")); return 2; }

  const mode = opts.yolo ? "bypass" : opts.mode || config.mode || "default";
  const effortRef = { value: opts.effort || config.effort || "medium" };
  const ui = createPlainUi({ stdout, stderr, mode });
  const client = withRetryNotice(makeClient(() => config.code), info => ui.notice("info", retryText(info)));
  const { session } = openSession({ opts, cwd, mode, notify });
  const { permissions, toolbox } = buildEngine({ ui, client, config, session, cwd, mode, effortRef });

  const control = new AbortController();
  const proc = io.process || (io.injected ? null : process);
  const onSignal = () => control.abort();
  proc?.on?.("SIGINT", onSignal);
  proc?.on?.("SIGTERM", onSignal);
  try {
    const result = await runUserTurn({ session, text: prompt, ui, client, toolbox, permissions, effort: mentionsUltra(prompt) ? "ultracode" : effortRef.value, signal: control.signal, lang: getLang(), config });
    ui.finish();
    session.save();
    return exitCodeFor(result.stopReason);
  } finally {
    proc?.off?.("SIGINT", onSignal);
    proc?.off?.("SIGTERM", onSignal);
    try { await toolbox.dispose(); } catch { /* background jobs that will not stop are left to the OS */ }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Interactive mode

/**
 * The line under the prompt: mode, effort and the key that switches the mode. On a narrow terminal the parts go from the
 * end (the hint first) instead of being cut in the middle of a word; in the Arabic interface the line is right-aligned
 * like everything else, with the same two-column gutter as the English one.
 */
export function footerLine(permissions, effortRef, width = 80) {
  const mode = permissions.mode;
  const paint = mode === "bypass" ? c.red : mode === "plan" ? c.accent : mode === "acceptEdits" ? c.yellow : c.dim;
  const parts = [`${t("term.banner.mode")}: ${modeLabel(mode)}`, `${t("term.banner.effort")}: ${effortLabel(effortRef.value)}`, t("app.footer.cycle")];
  const sep = ` ${sym.dot} `;
  const room = Math.max(10, width - 4);
  let shown = parts;
  while (shown.length > 1 && stringWidth(shown.join(sep)) > room) shown = shown.slice(0, -1);
  const styled = paint(fitLogical(shown[0], room, sym.ellipsis)) + (shown.length > 1 ? c.dim(sep + shown.slice(1).join(sep)) : "");
  // The isolates around Latin names have done their job once the line is ordered; a console font draws them as boxes.
  return paintUltra(stripBidiMarks(toVisual(`  ${styled}`, getLang() === "ar" ? { dir: "rtl", width, align: "end" } : { dir: "ltr" })));
}

function recap(session, ui, width) {
  const messages = session.messages;
  const user = [...messages].reverse().find(m => m.role === "user" && lastText(m) && !/^\[Summary of the earlier conversation/.test(lastText(m)));
  const assistant = [...messages].reverse().find(m => m.role === "assistant" && lastText(m));
  if (user) ui.echoUser(lastText(user).slice(0, 600));
  if (assistant) {
    if (user) ui.ensureBlank();
    const rows = renderMarkdown(cleanText(lastText(assistant)), { width: width + 2, dir: "auto", indent: "  " });
    const cap = 16;
    ui.printText([...(rows.length > cap ? rows.slice(0, cap) : rows), ...(rows.length > cap ? ["  " + vis(c.dim(t("app.fold.more", { n: rows.length - cap })))] : []), ""]);
  }
}

async function runInteractive({ opts, config, cwd, env, io, stdin, stdout, stderr, makeClient, fontFix }) {
  const proc = io.process || (io.injected ? null : process);
  const readPrompt = io.readPrompt || defaultReadPrompt;
  const screen = io.screen || createScreen({ stdin, stdout, env });
  const app = { exitCode: null, effort: { value: opts.effort || config.effort || "medium" }, turnAbort: null, session: null, firstPrompt: opts.prompt.trim() };
  const lifeline = new AbortController();
  const mode = opts.yolo ? "bypass" : opts.mode || config.mode || "default";
  let ui = null;
  let permissions = null;
  let toolbox = null;
  let client = null;
  let disposed = false;
  // One key listener for the whole session. Switching the terminal input off and on again between a turn and the
  // prompt (a first listener released before any key was read) leaves Windows consoles under ConPTY unable to end the
  // process afterwards: it hangs after the exit event. So the input is started once, here, and released once, in cleanup().
  let holdInput = null;

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    try { ui?.dispose(); } catch { /* the screen is disposed next */ }
    try { holdInput?.(); } catch { /* the screen is disposed next */ }
    try { screen.dispose(); } catch { /* nothing more to restore */ }
  };

  const requestExit = code => {
    if (app.exitCode === null) app.exitCode = code;
    app.turnAbort?.();
    lifeline.abort();
  };
  const onSignal = () => requestExit(130);
  proc?.on?.("SIGINT", onSignal);
  proc?.on?.("SIGTERM", onSignal);

  try {
    ui = createInteractiveUi({
      screen,
      graceMs: io.graceMs ?? 250,
      cycleMode: () => {
        const next = permissions.cycleMode();
        app.session.mode = next;
        ui.notice("info", t("app.mode.set", { mode: modeLabel(next) }));
      },
      onPlanDecision: decision => {
        permissions.setMode(decision === "approve" ? "default" : "acceptEdits");
        app.session.mode = permissions.mode;
      },
    });
    holdInput = screen.onKey(() => {});
    // The helper renames the window while it runs: the title is put back, and a font that still cannot draw Arabic
    // after the switch was tried is said once.
    fontFix?.then(result => {
      if (disposed) return;
      screen.title?.(windowTitle(cwd));
      if (fontStillBroken(result)) ui.notice("warn", t("app.font.broken"));
    });
    // A quiet "busy, retrying in 2 s" while the client waits to try again.
    const retryNotice = info => ui.notice("info", retryText(info));
    client = withRetryNotice(makeClient(() => config.code), retryNotice);

    screen.title?.(windowTitle(cwd));

    const { session, resumed } = openSession({ opts, cwd, mode, notify: (level, text) => ui.notice(level, text), pickLater: true });
    app.session = session;
    const engine = buildEngine({ ui, client, config, session, cwd, mode, effortRef: app.effort });
    permissions = engine.permissions;
    toolbox = engine.toolbox;

    ui.printRaw(renderBanner({ width: screen.width(), cwd, effort: app.effort.value, mode, lang: getLang(), version: VERSION, resumed }));
    if (config.recovered) ui.notice("warn", t("app.config.recovered"));
    if (resumed) { ui.resetUsage(session.usage); recap(session, ui, contentWidth(screen.width())); }

    // ---- first run ------------------------------------------------------------------------------------------------
    const needLanguage = !config.lang && !opts.lang && !env.FIRAS_LANG;
    const needCode = !config.code;
    if (needLanguage || needCode) {
      const result = await runOnboarding({
        screen, readPrompt: promptWithLife(readPrompt, lifeline.signal), ui, config,
        makeClient, needLanguage, needCode, signal: lifeline.signal,
      });
      if (!result.ok) {
        if (result.cancelled) requestExit(0);
        else requestExit(1);
      } else {
        screen.title?.(windowTitle(cwd));
      }
    }

    // A code from the environment is saved once the service accepts it (the installers start the app that way); the
    // session goes on either way.
    if (app.exitCode === null) await rememberAccessCode({ config, makeClient, ui, signal: lifeline.signal, ...(io.rememberTimeoutMs ? { timeoutMs: io.rememberTimeoutMs } : {}) });

    // ---- what commands may use --------------------------------------------------------------------------------------
    const history = loadHistory();
    const files = createFileIndex({ cwd });
    files.warm();

    const beginTurn = () => {
      const control = new AbortController();
      app.turnAbort = () => control.abort();
      ui.turnBegin({ abort: app.turnAbort, exit: () => requestExit(130) });
      return control;
    };
    const endTurn = () => { app.turnAbort = null; ui.turnFinish(); };

    const runAgentTurn = async text => {
      const control = beginTurn();
      try {
        // Naming ultracode in a message gives that one message the top level; the setting itself does not change.
        const effort = mentionsUltra(text) ? "ultracode" : app.effort.value;
        return await runUserTurn({ session: app.session, text, ui, client, toolbox, permissions, effort, signal: control.signal, lang: getLang(), config });
      } finally {
        endTurn();
        keep(app.session);
      }
    };

    const ctx = {
      get config() { return config; },
      get session() { return app.session; },
      get lang() { return getLang(); },
      client, toolbox, permissions, ui, screen, cwd, env,
      platform: io.platform || process.platform,
      copyToClipboard: io.copyToClipboard,
      runUpdate: io.runUpdate,
      effort: {
        get: () => app.effort.value,
        set: value => { app.effort.value = value; updateConfig(config, { effort: value }); },
      },
      setMode: value => { permissions.setMode(value); app.session.mode = value; },
      setLang: value => { setLang(value); updateConfig(config, { lang: value }); },
      setArabic: value => { setArabicMode(value); updateConfig(config, { arabic: value }); },
      forgetCode: () => { updateConfig(config, { code: null }); config.code = ""; },
      askNewCode: async () => {
        const result = await askAccessCode({ screen, readPrompt: promptWithLife(readPrompt, lifeline.signal), ui, makeClient, signal: lifeline.signal });
        if (!result.ok) return false;
        updateConfig(config, { code: result.code });
        config.code = result.code;
        return true;
      },
      exit: code => requestExit(code ?? 0),
      runAgentTurn,
      busy: async fn => {
        const control = beginTurn();
        try { return await fn(control.signal); } finally { endTurn(); }
      },
      clearConversation: () => {
        keep(app.session);
        app.session = createSession({ cwd, mode: permissions.mode });
        toolbox.fileState.clear();
        permissions.reset();
        ui.resetUsage();
        ui.setLastAnswer("");
        // Scrolling the old text out of sight (not erasing it) keeps the terminal's own scrollback intact.
        if (typeof screen.clear === "function") screen.clear();
        else ui.printRaw(Array.from({ length: Math.max(1, screen.height()) }, () => ""));
        ui.printRaw(renderBanner({ width: screen.width(), cwd, effort: app.effort.value, mode: permissions.mode, lang: getLang(), version: VERSION }));
      },
      resumeSession: session => {
        keep(app.session);
        session.cwd = cwd;
        app.session = session;
        toolbox.fileState.clear();
        ui.resetUsage(session.usage);
        ui.setLastAnswer("");
        ui.notice("info", t("app.resume.done", { title: session.title || session.id }));
        recap(session, ui, contentWidth(screen.width()));
      },
    };

    // ---- the loop ---------------------------------------------------------------------------------------------------
    const promptOptions = () => ({
      prefix: c.accent(sym.prompt) + " ",
      continuationPrefix: "  ",
      initial: ui.takeTypeAhead(),
      history,
      commands: commandMenu(),
      files: query => files.files(query),
      footer: () => [footerLine(permissions, app.effort, screen.width())],
      onShiftTab: () => { permissions.cycleMode(); app.session.mode = permissions.mode; },
      onExpand: () => ui.expandLast(),
      signal: lifeline.signal,
    });

    if (app.exitCode === null && opts.resume === true && !opts.continue) await resumeFlow(ctx, "");
    if (app.exitCode === null && app.firstPrompt) {
      ui.echoUser(app.firstPrompt);
      await runAgentTurn(app.firstPrompt);
    }
    while (app.exitCode === null) {
      const answer = await readPrompt(screen, promptOptions());
      if (app.exitCode !== null) break;
      if (answer.type === "exit") { app.exitCode = 0; break; }
      if (answer.type !== "submit") continue;
      const text = answer.text.trim();
      if (!text) continue;
      if (appendHistory(text) && history[history.length - 1] !== text) history.push(text);
      ui.echoUser(answer.text);
      if (text.startsWith("/")) {
        const handled = await dispatch(text, ctx);
        if (handled.handled) continue;
      }
      await runAgentTurn(text);
    }
    return app.exitCode ?? 0;
  } catch (error) {
    if (isAbortError(error)) return app.exitCode ?? 130;
    cleanup();
    return fatal(error, stderr, env);
  } finally {
    proc?.off?.("SIGINT", onSignal);
    proc?.off?.("SIGTERM", onSignal);
    try { keep(app.session); } catch { /* the turn already saved what it could */ }
    try { await toolbox?.dispose(); } catch { /* leave stubborn background jobs to the OS */ }
    cleanup();
  }
}

/** Saves a conversation that has something in it (an empty one would only leave a file behind). */
function keep(session) {
  if (session?.messages?.length) session.save();
}

/** readPrompt that also ends when the program is told to stop. */
function promptWithLife(readPrompt, signal) {
  return (screen, options) => readPrompt(screen, { signal, ...options });
}

/** Every request made through this client reports its automatic retries through `onRetry`. */
function withRetryNotice(client, onRetry) {
  const stream = client.stream.bind(client);
  return { ...client, stream: (request, options = {}) => stream(request, { onRetry, ...options }) };
}
