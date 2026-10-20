// The UI for `-p` (print mode) and for tests: nothing interactive.
//
//   stdout  only what the assistant wrote: the raw markdown it streamed when stdout is a pipe or a file, and the same
//           text rendered for reading (Arabic shaped and ordered, code boxed, lines wrapped) when stdout is a terminal
//   stderr  notices, one line per tool call and its result, denied requests, the final task list
//
// Decisions:
//  - Permission requests that reach this UI are denied: nobody is there to answer. The permission ENGINE has already
//    allowed what the mode allows (project edits in acceptEdits, everything but the always-ask list in bypass), so the
//    only requests that arrive here are the ones that really need a person. The single exception is bypass mode with a
//    request that is not high risk (the engine never sends one, but a custom engine might): that is allowed.
//  - Questions and plans cannot be answered. The model is told so through the normal tool results ("dismissed") and,
//    for a plan, through the feedback text, so a print-mode run in plan mode ends with the plan as its answer.
//  - Nothing but the answer goes to stdout, and a pipe or a file never gets an escape sequence. That holds for a
//    redirected stderr too, which loses its colours here: the colour level is decided from stdout (cli.js), so
//    `2> log` beside a terminal stdout would fill the log with them. stderr lines are shaped and ordered for Arabic
//    only when stderr is a terminal (a redirected log keeps logical text).
//  - What reaches a Windows terminal loses its combining marks (src/ui/terminal.js markFilter): the console host gives
//    each one a cell the layout never gave out, and a right-aligned Arabic row would wrap.
//  - On a terminal an answer block is rendered when the block ends, not token by token: that is what makes wrapping and
//    right-to-left lines correct. `answer()` always returns the raw text.
//  - Text blocks are separated by a blank line; the stream always ends with a newline (finish()).
import { c, sym } from "./theme.js";
import { t } from "../i18n/index.js";
import { stripAnsi, toVisual } from "../text/display.js";
import { renderMarkdown } from "./markdown.js";
import { markFilter } from "./terminal.js";
import { stripBidiMarks } from "./textfit.js";
import { cleanText, createStreamCleaner, truncateLogical } from "./views.js";
import "./strings-app.js";

export function createPlainUi({ stdout = process.stdout, stderr = process.stderr, mode = "default", platform = process.platform, env = process.env } = {}) {
  const pretty = !!stdout.isTTY;
  const outSafe = markFilter({ platform, env, stream: stdout });
  const errSafe = markFilter({ platform, env, stream: stderr });
  const cleaner = () => createStreamCleaner({ tabs: 0 });
  let blockCleaner = cleaner();
  let block = "";
  let wrote = false;
  let lastChar = "\n";
  let todos = null;
  const result = { text: "" };

  const out = text => {
    if (!text) return;
    stdout.write(outSafe(text));
    wrote = true;
    lastChar = text[text.length - 1];
  };
  const err = line => {
    const text = stderr.isTTY ? errSafe(stripBidiMarks(toVisual(line, { dir: "auto" }))) : stripAnsi(stripBidiMarks(line));
    stderr.write(text + "\n");
  };

  const ui = {
    textStart() {
      blockCleaner = cleaner();
      block = "";
      if (wrote) {
        if (lastChar !== "\n") out("\n");
        out("\n");
      }
    },
    textDelta(text) {
      const clean = blockCleaner.push(text);
      if (!clean) return;
      result.text += clean;
      if (pretty) block += clean; else out(clean);
    },
    textEnd() {
      blockCleaner.flush();
      if (pretty && block) {
        const width = Math.max(20, Math.min(100, (stdout.columns || 80) - 1));
        out(renderMarkdown(block, { width, dir: "auto", indent: "" }).join("\n") + "\n");
        block = "";
      }
      if (wrote && lastChar !== "\n") out("\n");
    },

    toolStart({ name, summary }) {
      err(`${c.gray(sym.bullet)} ${c.bold(name)}${c.dim(`(${truncateLogical(cleanText(summary), 100)})`)}`);
    },
    toolEnd({ ok, summary }) {
      const text = truncateLogical(cleanText(summary || ""), 120);
      if (text) err(`  ${c.gray(sym.corner)} ${ok ? text : c.red(text)}`);
    },

    async askPermission(req) {
      const what = truncateLogical(cleanText(req.title || req.tool || ""), 100);
      if (mode === "bypass" && req.risk !== "high") return { decision: "allow" };
      err(`${c.yellow(sym.warn)} ${t("app.plain.denied", { what })}`);
      return { decision: "deny" };
    },
    async askQuestion({ question }) {
      err(`${c.yellow(sym.warn)} ${t("app.plain.noQuestion", { question: truncateLogical(cleanText(question), 100) })}`);
      return { answer: "" };
    },
    async showPlan() {
      err(`${c.yellow(sym.warn)} ${t("app.plain.noPlan")}`);
      return { decision: "reject", feedback: "This is a non-interactive run, so nobody can approve a plan. Do not call ExitPlanMode again: write the plan as your final answer and stop." };
    },

    todos(items) { todos = items; },
    notice(level, text) {
      const mark = level === "error" ? c.red(sym.cross) : level === "warn" ? c.yellow(sym.warn) : c.accent(sym.info);
      err(`${mark} ${cleanText(text).replace(/\s+/g, " ").trim()}`);
    },
    turnEnd() {
      if (!todos?.length) return;
      // The same marks as the interactive task list: done, still running when the turn ended, not started.
      for (const item of todos) {
        const mark = item.status === "completed" ? c.green(sym.checked) : item.status === "in_progress" ? c.accent(sym.active) : c.gray(sym.checkbox);
        err(`  ${mark} ${truncateLogical(cleanText(item.content), 100)}`);
      }
      todos = null;
    },

    // The remaining events have nothing to show here.
    requestStart() {}, requestEnd() {}, thinkingStart() {}, thinkingDelta() {}, thinkingEnd() {},
    toolProgress() {}, agentStart() {}, agentEnd() {}, usage() {},

    /** Makes sure the text ends with a newline (call once at the very end). */
    finish() { if (wrote && lastChar !== "\n") out("\n"); },
    answer: () => result.text,
  };
  return ui;
}
