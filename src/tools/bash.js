// Bash: runs a shell command. The tool's description is built from the shell that was actually found.
import fs from "node:fs";
import { t } from "../i18n/index.js";
import { ok, fail, settings, toInt, tn, reveal, HIDDEN, childEnv } from "./common.js";

export { reveal };
import { classifyCommand } from "./classify.js";
import { runProcess, OutputBuffer } from "./runner.js";
import { resolveShell } from "./shell.js";
import { createJobs } from "./jobs.js";

export const BASH_DEFAULT_TIMEOUT = 120_000;
export const BASH_MAX_TIMEOUT = 600_000;
// Small enough that the permission dialog can always carry the whole text of what it asks about.
export const BASH_MAX_COMMAND = 20_000;
// Above either limit the person cannot be expected to read the command in the dialog (it folds long text).
export const REVIEW_MAX_CHARS = 1_000;
export const REVIEW_MAX_LINES = 10;

/** Longest command text a shell can be handed (Windows limits the whole command line to about 32 000 characters). */
export function maxCommandLength(shell) {
  if (shell.kind === "powershell") return 10_000; // sent base64-encoded, which makes it nearly three times longer
  if (shell.kind === "cmd") return 8_000;
  return BASH_MAX_COMMAND;
}

const asBool = v => v === true || v === "true";

/** CRLF is an ordinary line break; every other special character is left for permission() to flag. */
const canonical = command => String(command ?? "").replace(/\r\n/g, "\n");

/** First non-empty line, revealed and shortened, with the number of further lines (the tail must not hide). */
function cardHead(command, max) {
  const lines = reveal(command).split("\n");
  const first = lines.findIndex(line => line.trim());
  if (first === -1) return "";
  let head = lines[first].trim().replace(/\s+/g, " ");
  if (head.length > max) head = head.slice(0, max - 1) + "…";
  const more = lines.slice(first + 1).filter(line => line.trim()).length;
  return more ? `${head} ${tn("tools.cmd.moreLines", more)}` : head;
}

/** The environment commands run in: the user's own, made quiet and non-interactive, minus this app's own secret. */
export function commandEnv(base, shell) {
  return {
    ...childEnv(base),
    FORCE_COLOR: "0", NO_COLOR: "1", TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0",
    PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1",
    // Git Bash would otherwise rewrite arguments such as /F or /all (Windows switches) into paths.
    ...(shell?.kind === "bash" && shell.platform === "win32" ? { MSYS_NO_PATHCONV: "1" } : {}),
  };
}

// Reasons are internal labels. "unlisted" only says the command is not on the short list that runs without asking,
// which every question already implies; "unparsed" is said by the question itself.
const INTERNAL_REASONS = new Set(["unlisted", "unparsed"]);

/** The reasons a person reads in the dialog. A label without a text of its own is skipped, never shown as a raw key. */
export function reasonLines(reasons) {
  const lines = [];
  for (const reason of reasons) {
    if (!reason || INTERNAL_REASONS.has(reason)) continue;
    const key = `tools.risk.${reason}`;
    const text = t(key);
    if (text && text !== key && !lines.includes(text)) lines.push(text);
  }
  return lines;
}

function description(shell) {
  return [
    `Runs a shell command on the user's machine and returns its combined output (stdout and stderr) and exit code. Shell: ${shell.name}. ${shell.syntax}`,
    "Every call starts a new shell in the project folder, so a cd lasts only within one command.",
    "Use it for builds, tests, git, package managers, running scripts and other command-line tools. Do not use it to read files (Read), search (Grep, Glob), list folders (LS) or edit files (Edit, Write): those tools are safer and cheaper.",
    "Standard input is closed, so programs that wait for input fail instead of hanging: pass non-interactive flags (for example --yes). Quote paths that contain spaces.",
    "Output longer than 30000 characters keeps its start and its end. The default timeout is 120000 ms and the maximum is 600000 ms; on timeout the whole process tree is stopped.",
    "For servers, watchers and anything long-running set run_in_background to true: it returns a job id immediately; read new output with BashOutput and stop the job with KillShell.",
    "Never run destructive commands (deleting folders, force-pushing, resetting work) unless the user asked for exactly that.",
  ].join(" ");
}

export function createBashTool({ shell = resolveShell(), jobs = createJobs() } = {}) {
  return {
    name: "Bash",
    description: description(shell),
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: `The command to run, in ${shell.name} syntax.` },
        description: { type: "string", description: "One short sentence saying what the command does, shown to the user." },
        timeout: { type: "integer", minimum: 100, maximum: BASH_MAX_TIMEOUT, description: `Timeout in milliseconds. Default ${BASH_DEFAULT_TIMEOUT}, maximum ${BASH_MAX_TIMEOUT}.` },
        run_in_background: { type: "boolean", description: "Start the command as a background job and return its id immediately. Default false." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    readOnly: false,
    concurrencySafe: false,
    shell,
    jobs,

    summarize(input) { return cardHead(canonical(input?.command), 100); },

    validate(input) {
      if (typeof input?.command !== "string" || !input.command.trim()) return "command is required (a non-empty string).";
      if (input.command.length > maxCommandLength(shell)) return `command is too long (${input.command.length} characters; this shell accepts at most ${maxCommandLength(shell)}). Write a script file with Write and run that instead.`;
      if (input.command.includes("\0")) return "command contains a NUL byte.";
      if (input.timeout !== undefined && input.timeout !== null && !(toInt(input.timeout) > 0)) return "timeout must be a positive number of milliseconds.";
      return null;
    },

    permission(input, ctx) {
      const s = settings(ctx);
      const command = canonical(input?.command);
      const c = classifyCommand(command, { shellKind: shell.kind, cwd: s.cwd, platform: s.platform, env: s.env });
      const head = cardHead(command, 90);
      if (c.risk === "readonly" && !c.secret) {
        return { decision: "allow", risk: "low", category: "exec", readOnlyCall: true, title: t("tools.perm.bash", { cmd: head }) };
      }
      const hidden = HIDDEN.test(command);
      const lineCount = command.split("\n").length;
      // Nobody is reading in bypass mode, so length alone does not force a question there; hidden characters always do.
      const long = (command.length > REVIEW_MAX_CHARS || lineCount > REVIEW_MAX_LINES) && ctx?.mode !== "bypass";
      const reasons = [...c.reasons, ...(hidden ? ["hiddenChars"] : []), ...(long ? ["longCommand"] : [])];
      const intentText = typeof input?.description === "string" ? cardHead(input.description, 200) : "";
      const shown = (intentText ? `${intentText}\n\n` : "") + reveal(command);
      if (c.risk === "high" || hidden || long) {
        const why = reasonLines(reasons);
        // What the person reads first must carry the warning and the end of the command, whatever the dialog folds.
        const lastLine = reveal(command).split("\n").map(line => line.trim()).filter(Boolean).pop() || "";
        const parts = [
          ...(why.length ? [why.map(w => `• ${w}`).join("\n")] : []),
          ...(long ? [t("tools.cmd.size", { chars: command.length, lines: lineCount }) + "\n" + t("tools.cmd.lastLine") + " " + (lastLine.length > 200 ? lastLine.slice(0, 199) + "…" : lastLine)] : []),
          shown,
        ];
        return { decision: "ask", risk: "high", category: "exec", title: t("tools.perm.bashHigh", { cmd: head }), detail: parts.join("\n\n") };
      }
      const verdict = { decision: "ask", risk: "medium", category: "exec", title: t("tools.perm.bash", { cmd: head }), detail: shown };
      if (c.remember) {
        verdict.sessionKeys = c.keys.map(k => `Bash:${k}`);
        verdict.sessionKey = verdict.sessionKeys.join(" && ");
        verdict.sessionLabel = t("tools.perm.bashSession", { cmd: c.keys.join(" && ") });
      }
      return verdict;
    },

    async run(input, ctx) {
      const s = settings(ctx);
      const command = canonical(input?.command);
      if (!command.trim()) return fail("invalidInput", "command is empty.");
      const env = commandEnv(s.env, shell);
      if (!fs.existsSync(s.cwd)) return fail("badPath", `The working folder no longer exists: ${s.cwd}`);

      if (asBool(input.run_in_background)) {
        const job = jobs.start({ info: shell, command, cwd: s.cwd, env });
        if (job.error && !job.id) return fail("tooManyJobs", job.error);
        return ok(`Started background job ${job.id}${job.pid ? ` (pid ${job.pid})` : ""}. Read its new output with BashOutput (job_id "${job.id}") and stop it with KillShell.`, {
          summary: t("tools.bash.background", { id: job.id }),
        });
      }

      const wanted = input.timeout === undefined || input.timeout === null ? BASH_DEFAULT_TIMEOUT : toInt(input.timeout);
      const timeoutMs = Math.min(BASH_MAX_TIMEOUT, Math.max(100, Number.isFinite(wanted) ? wanted : BASH_DEFAULT_TIMEOUT));
      const buffer = new OutputBuffer();
      let last = 0;
      let pendingTimer = null;
      const emit = () => { try { ctx?.progress?.(buffer.recent()); } catch { /* progress is cosmetic */ } };
      const onChunk = text => {
        buffer.push(text);
        if (!ctx?.progress) return;
        const wait = 250 - (Date.now() - last);
        if (wait <= 0) { last = Date.now(); emit(); }
        else if (!pendingTimer) pendingTimer = setTimeout(() => { pendingTimer = null; last = Date.now(); emit(); }, wait);
      };

      const result = await runProcess({ info: shell, command, cwd: s.cwd, env, signal: ctx?.signal, timeoutMs, onChunk, platform: s.platform });
      clearTimeout(pendingTimer);
      if (result.error) return fail("spawn", `Could not start the shell (${shell.label}): ${result.error.message || result.error}`);

      const output = buffer.render().replace(/\s+$/, "") || "(no output)";
      const secs = (result.ms / 1000).toFixed(result.ms < 10_000 ? 1 : 0);
      if (result.timedOut) {
        return {
          ok: false,
          content: `${output}\n[Timed out after ${Math.round(timeoutMs / 1000)} s: the command and its child processes were stopped. Raise timeout (maximum ${BASH_MAX_TIMEOUT} ms) or use run_in_background for long tasks.]`,
          display: { summary: t("tools.bash.timeout", { secs: Math.round(timeoutMs / 1000) }), body: output },
        };
      }
      if (result.aborted) {
        return { ok: false, content: `${output}\n[Interrupted by the user before it finished.]`, display: { summary: t("tools.bash.interrupted"), body: output } };
      }
      if (result.code === null) {
        return { ok: false, content: `${output}\n[The command was terminated by signal ${result.signal || "unknown"}.]`, display: { summary: t("tools.bash.signal", { signal: result.signal || "?" }), body: output } };
      }
      return {
        ok: result.code === 0,
        content: `${output}\n[exit code: ${result.code}]`,
        display: { summary: result.code === 0 ? t("tools.bash.done", { secs }) : t("tools.bash.failed", { code: result.code, secs }), body: output },
      };
    },
  };
}
