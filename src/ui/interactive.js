// The interactive UI: the object the agent loop and the tools talk to, wired to the screen.
//
//   const ui = createInteractiveUi({ screen, ... });
//   ui.turnBegin({ abort, exit });  await runUserTurn({ ..., ui });  ui.turnFinish();
//
// What the person sees while a turn runs is a LIVE REGION at the bottom (running tool cards with the last lines of
// their output, the task list, the unfinished markdown line, a blank line and the spinner) and committed lines above
// it (streamed answer, finished cards, notices). Parallel tools therefore interleave safely: a card is committed as
// one block when its tool ends, never half and half.
//
// Decisions:
//  - The model's reasoning text is never shown, stored or logged. While it thinks the spinner says so (with the elapsed
//    time); when a long thought ends one dim line says how long it took, "thought for 12 s". Only the SIZE of what
//    arrives is used (it moves the token counter on the spinner).
//  - The task list is pinned in the live region while the turn runs and committed once, at the end, if it changed.
//  - Keys during a turn: Esc aborts; Ctrl+C aborts, and a second Ctrl+C within 2 s leaves the program; Ctrl+O prints
//    the last card in full; Shift+Tab cycles the permission mode. While a dialog is open
//    it gets every key (a key stack), so Esc means "deny" there and never "abort".
//  - A dialog ignores Enter and the number keys for `graceMs` after it appears (stray type-ahead must not approve).
//  - This object never touches the live region while `external` is set: readPrompt owns it then (feedback lines).
//  - The raw text of the last answer is kept for /copy (cleaned of escape sequences, markdown untouched).
//  - Every line printed here is laid out to the full content width (views.js para), so in the Arabic interface it is
//    right-aligned with the rest of the column. Ctrl+O lays the last card out again at the CURRENT width.
//  - Blocks are separated by one blank line: a card, a notice or the "thought for" line that follows streamed text (or
//    the echoed message) starts with one; consecutive cards and consecutive notices stay together.
import { c, sym } from "./theme.js";
import { t, getLang } from "../i18n/index.js";
import { createSpinner as defaultCreateSpinner } from "./spinner.js";
import { createMarkdownStream as defaultCreateMarkdownStream } from "./stream.js";
import { renderMarkdown } from "./markdown.js";
import { arabicActive } from "../text/display.js";
import { readPrompt as defaultReadPrompt } from "./input.js";
import { classifyCommand } from "../tools/classify.js";
import { isAbortError } from "../link/errors.js";
import {
  GUTTER, contentWidth, cleanText, createStreamCleaner, fmtDuration, footerRow, para, pickDialog, permissionDialog, planDialog,
  questionDialog, renderNotice, renderRunningCard, renderToolCard, renderTodoCard, renderTodos, renderTurnFooter, resultRows,
  toolHeader, truncateLogical,
} from "./views.js";
import "./strings-app.js";

const CHARS_PER_TOKEN = 3.5;
const THOUGHT_NOTE_MS = 3000;
const CTRL_C_WINDOW_MS = 2000;
const TODO_LIVE_ROWS = 8;
const TYPE_AHEAD_MAX = 4000;

function ctrlLetter(key, letter) {
  return !!key.ctrl && key.name === "char" && String(key.ch || "").toLowerCase() === letter;
}

function sameLines(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function riskOf(name, input) {
  if (name !== "Bash" || typeof input?.command !== "string") return undefined;
  try { return classifyCommand(input.command).risk === "high" ? "high" : "medium"; } catch { return "medium"; }
}

export function createInteractiveUi({
  screen,
  createSpinner = defaultCreateSpinner,
  createMarkdownStream = defaultCreateMarkdownStream,
  readPrompt = defaultReadPrompt,
  graceMs = 250,
  cycleMode,
  onPlanDecision,
  now = Date.now,
} = {}) {
  const state = {
    turn: null,
    tools: new Map(),
    thinking: null,
    partial: "",
    md: null,
    cleaner: null,
    todos: null,
    todosPrinted: "",
    todoCard: null,
    lastCard: null,
    lastAnswer: "",
    answerAcc: "",
    stepHadTools: false,
    dialog: null,
    external: 0,
    usage: { inputTokens: 0, outputTokens: 0, contextTokens: 0 },
    liveChars: 0,
    lastBlank: true,
    lastKind: "none",
    lastLive: null,
    timer: null,
    typeAhead: "",
    pendingLines: [],
    // Messages typed and sent while the turn runs (Enter): the loop injects them at its next step.
    steer: [],
    steerAbort: null,
  };

  const width = () => contentWidth(screen.width());
  // In the Arabic interface the text column sits against the RIGHT edge of a wide terminal (the welcome card does), not
  // as a block at its left: whatever is left over beyond the 100 columns of content goes in front of every line.
  const margin = () => (getLang() === "ar" && arabicActive() ? " ".repeat(Math.max(0, screen.width() - 4 - width())) : "");
  const shift = (lines, pad = margin()) => (pad ? lines.map(line => (line === "" ? "" : pad + line)) : lines);

  // ---- printing -------------------------------------------------------------------------------------------------

  function printRaw(lines) {
    const list = Array.isArray(lines) ? lines : [lines];
    if (!list.length) return;
    screen.print(list);
    state.lastBlank = list[list.length - 1] === "";
  }

  /** Lines without the gutter; it is added here so every width calculation can ignore it. */
  function emit(lines, kind = "other") {
    if (!lines.length) return;
    printRaw(shift(lines.map(line => (line === "" ? "" : GUTTER + line))));
    state.lastKind = kind;
  }

  function ensureBlank() {
    if (!state.lastBlank) printRaw([""]);
  }

  // ---- live region ----------------------------------------------------------------------------------------------

  const spinner = createSpinner({ onFrame: () => schedule(), lang: () => getLang() });
  // A new terminal size: the live region is composed again at once, so nothing stays laid out for the old width.
  const offResize = screen.onResize?.(() => { state.lastLive = null; if (state.turn || state.dialog) render(); });

  function setLive(lines, cursor) {
    const key = lines.concat(cursor ? [`@${cursor.row},${cursor.col}`] : []);
    if (state.lastLive && sameLines(state.lastLive, key)) return;
    state.lastLive = key;
    screen.setLive(lines, cursor ?? null);
  }

  function todoWindow(w) {
    const items = state.todos || [];
    if (!items.length) return [];
    let view = items;
    if (items.length > TODO_LIVE_ROWS) {
      const at = Math.max(0, items.findIndex(item => item.status === "in_progress"));
      const from = Math.max(0, Math.min(items.length - TODO_LIVE_ROWS, at - 2));
      view = items.slice(from, from + TODO_LIVE_ROWS);
    }
    return renderTodos(view, w);
  }

  function render() {
    state.timer = null;
    if (state.external) return;
    if (state.dialog) {
      setLive(shift(state.dialog.lines.map(line => (line === "" ? "" : GUTTER + line))), state.dialog.cursor);
      return;
    }
    if (!state.turn) return;
    const w = width();
    const lines = [];
    for (const entry of state.tools.values()) lines.push(...renderRunningCard(entry.card, entry.tail, w).map(line => GUTTER + line));
    lines.push(...todoWindow(w).map(line => GUTTER + line));
    if (state.partial) lines.push(...state.partial.split("\n"));
    lines.push("");
    const bar = spinner.line(w);
    if (bar) lines.push(GUTTER + bar);
    if (state.typeAhead) {
      // What the person has typed while the agent works: Enter sends it as steering, otherwise it becomes
      // the next prompt.
      const shown = truncateLogical(state.typeAhead.replace(/\s+/g, " "), Math.max(8, w - 4));
      const hint = c.dim(`  ${t("app.steer.hint")}`);
      lines.push(...para(c.dim(`${sym.prompt} ${shown}`) + hint, w, { dir: "auto" }).map(line => GUTTER + line));
    }
    const limit = Math.max(3, screen.height() - 1);
    setLive(shift(lines.length > limit ? lines.slice(lines.length - limit) : lines), null);
  }

  /**
   * Prints what the markdown stream committed, together with the new unfinished tail. The stream hands over the finished
   * lines first and the tail after them; printing at once would draw the new lines beside the OLD tail (the same
   * words twice) until the next scheduled redraw, so the live region is brought up to date first, in the same tick.
   */
  function flushText() {
    const lines = state.pendingLines;
    if (!lines.length) return;
    state.pendingLines = [];
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    render();
    printRaw(shift(lines));
  }

  /** Redraws soon, at most ~15 times a second; a burst of output costs one redraw. */
  function schedule() {
    if (state.timer || state.external || state.dialog || !state.turn) return;
    state.timer = setTimeout(render, 66);
    state.timer.unref?.();
  }

  function updateTokens() {
    if (!state.turn) return;
    const done = Math.max(0, state.usage.outputTokens - state.turn.baseOut);
    spinner.set({ tokens: done + Math.ceil(state.liveChars / CHARS_PER_TOKEN) });
  }

  // ---- keys -----------------------------------------------------------------------------------------------------

  const stack = [];
  let unsubscribe = null;
  let turnHandler = null;

  function route(key) {
    const top = stack[stack.length - 1];
    if (top) top(key);
    else if (turnHandler) turnHandler(key);
  }
  function holdKeys() { if (!unsubscribe) unsubscribe = screen.onKey(route); }
  function releaseKeys() {
    if (unsubscribe && !stack.length && !turnHandler) { unsubscribe(); unsubscribe = null; }
  }
  function pushKeys(handler) {
    stack.push(handler);
    holdKeys();
    return () => {
      const at = stack.indexOf(handler);
      if (at !== -1) stack.splice(at, 1);
      releaseKeys();
    };
  }

  function onTurnKey(key) {
    const turn = state.turn;
    if (!turn) return;
    if (key.name === "escape") { turn.abort?.(); return; }
    if (ctrlLetter(key, "c")) {
      const at = now();
      if (turn.ctrlCAt && at - turn.ctrlCAt < CTRL_C_WINDOW_MS) { turn.exit?.(); return; }
      turn.ctrlCAt = at;
      turn.abort?.();
      // Said on the working line, where it is seen and then gone: as a notice it would stay in the scrollback, often
      // in the middle of the paragraph that was being written.
      spinner.set({ label: t("app.ctrlc.again") });
      render();
      return;
    }
    if (ctrlLetter(key, "o")) { ui.expandLast(); return; }
    if (key.name === "backtab") { cycleMode?.(); schedule(); return; }
    // Enter sends what was typed as steering: the loop adds it to the running turn at its next step, and the
    // current request is stopped so the model reads it now instead of after the answer.
    if (key.name === "return" || key.name === "enter") {
      const text = state.typeAhead.trim();
      if (text) {
        state.steer.push(text);
        state.typeAhead = "";
        state.steerAbort?.();
        spinner.set({ label: t("app.steer.sent") });
        render();
      }
      return;
    }
    // Anything else typed while the agent works is kept for the next prompt.
    if (key.name === "char" && !key.ctrl && !key.alt && key.ch) state.typeAhead += key.ch;
    else if (key.name === "paste" && key.paste) state.typeAhead += key.paste.replace(/\n+$/, "");
    else if (key.name === "backspace") state.typeAhead = [...state.typeAhead].slice(0, -1).join("");
    else return;
    if (state.typeAhead.length > TYPE_AHEAD_MAX) state.typeAhead = state.typeAhead.slice(0, TYPE_AHEAD_MAX);
    schedule();
  }

  // ---- dialogs --------------------------------------------------------------------------------------------------

  const host = {
    width,
    // A dialog is the whole live region while it is open, and the screen keeps only the bottom rows of one that is
    // taller than it: the permission box folds its body to this height so its title is never what goes.
    height: () => screen.height(),
    show(lines, cursor) { state.dialog = { lines, cursor: cursor ?? null }; render(); },
    hide() {
      state.dialog = null;
      state.lastLive = null;
      if (state.turn) render(); else screen.clearLive();
    },
    onKey: pushKeys,
    onResize: cb => screen.onResize?.(cb) ?? (() => {}),
    print: lines => emit(lines),
  };

  /** One line typed by the person, on the real prompt editor (so Arabic editing is right). null = cancelled. */
  async function readLine({ prefix, hint }) {
    state.external += 1;
    state.dialog = null;
    state.lastLive = null;
    // The editor reads the keys itself; the turn's own handler (Esc = abort) must not hear them too. Esc means "back".
    const back = new AbortController();
    const mute = pushKeys(key => { if (key.name === "escape") back.abort(); });
    try {
      const result = await readPrompt(screen, {
        prefix: prefix || c.accent(sym.prompt) + " ",
        history: [],
        commands: [],
        footer: () => (hint ? [footerRow(c.dim(hint), screen.width())] : []),
        placeholder: "",
        signal: back.signal,
      });
      return result?.type === "submit" ? String(result.text) : null;
    } finally {
      mute();
      state.external -= 1;
      state.lastLive = null;
      if (!state.external) { if (state.turn) render(); else screen.clearLive(); }
    }
  }

  async function dialogGuard(fallback, fn) {
    if (!screen.isTTY) return fallback;
    try { return await fn(); } catch (error) {
      if (isAbortError(error)) return fallback;
      throw error;
    }
  }

  // ---- the UI object ---------------------------------------------------------------------------------

  const ui = {
    requestStart(o) {
      if (state.stepHadTools) state.answerAcc = "";
      state.stepHadTools = false;
      state.liveChars = 0;
      spinner.set({ phase: "waiting", ultra: o?.effort === "ultracode" });
      updateTokens();
      schedule();
    },
    requestEnd() {
      state.liveChars = 0;
      if (state.md) { state.md.finish(); state.md = null; state.partial = ""; flushText(); }
      spinner.set({ phase: "waiting" });
    },

    thinkingStart() {
      state.thinking = { startedAt: now() };
      spinner.set({ phase: "thinking" });
      schedule();
    },
    // The text itself is dropped on arrival: only how much of it came is used.
    thinkingDelta(text) {
      if (!state.thinking) return;
      state.liveChars += String(text ?? "").length;
      updateTokens();
      schedule();
    },
    thinkingEnd({ ms } = {}) {
      const th = state.thinking;
      state.thinking = null;
      spinner.set({ phase: "waiting" });
      const took = ms ?? (th ? now() - th.startedAt : 0);
      if (th && took >= THOUGHT_NOTE_MS) {
        if (state.lastKind === "text" || state.lastKind === "user") ensureBlank();
        emit(para(c.dim(`${sym.think} ${t("app.thinking.thought", { time: fmtDuration(took) })}`), width()), "thinking");
      }
      schedule();
    },

    textStart() {
      ensureBlank();
      state.cleaner = createStreamCleaner();
      state.md = createMarkdownStream({
        getWidth: () => width() + GUTTER.length,
        indent: GUTTER,
        onLines: lines => { state.pendingLines.push(...lines); state.lastKind = "text"; },
        onPartial: line => { state.partial = line; schedule(); },
      });
      spinner.set({ phase: "writing" });
    },
    textDelta(text) {
      if (!state.md) ui.textStart();
      const clean = state.cleaner.push(text);
      if (!clean) return;
      state.answerAcc += clean;
      state.lastAnswer = state.answerAcc;
      state.liveChars += clean.length;
      state.md.push(clean);
      flushText();
      updateTokens();
    },
    textEnd() {
      if (state.md) { state.md.finish(); state.md = null; }
      state.cleaner = null;
      state.partial = "";
      flushText();
      state.lastAnswer = state.answerAcc;
      state.lastKind = "text";
      spinner.set({ phase: "waiting" });
      schedule();
    },

    toolStart({ id, name, summary, input, readOnly }) {
      state.stepHadTools = true;
      state.tools.set(id, { card: { name, summary, readOnly: !!readOnly, risk: riskOf(name, input) }, tail: [], startedAt: now() });
      spinner.set({ phase: "tool", label: name });
      render();
    },
    toolProgress(id, text) {
      const entry = state.tools.get(id);
      if (!entry) return;
      const rows = cleanText(text).split("\n").map(row => row.trimEnd()).filter(row => row.trim());
      if (!rows.length) return;
      // The Agent tool reports one line per step; shell tools report their latest few lines each time.
      entry.tail = entry.card.name === "Agent" ? [...entry.tail, ...rows].slice(-3) : rows.slice(-3);
      schedule();
    },
    toolEnd({ id, name, ok, summary, body, diff }) {
      const entry = state.tools.get(id);
      state.tools.delete(id);
      // The question and the answer (the plan and the decision) were already written down when the person answered:
      // a second card with the same words would only repeat them.
      if ((name === "AskUserQuestion" || name === "ExitPlanMode") && ok) {
        state.lastCard = null;
        if (!state.tools.size) spinner.set({ phase: "waiting", label: undefined });
        render();
        return;
      }
      const card = entry?.card || { name, summary: "", readOnly: false };
      // The task list is pinned on screen while it changes; the scrollback gets it once per change of its tasks, and
      // a status change alone is one result line (several near-identical cards would only be noise).
      if (name === "TodoWrite" && ok) {
        const update = state.todos?.length ? renderTodoCard(card, state.todos, state.todoCard, summary, width()) : null;
        state.todoCard = state.todos?.length ? state.todos.map(({ content, status }) => ({ content, status })) : null;
        state.lastCard = null;
        if (update) {
          if (state.lastKind === "text" || state.lastKind === "user") ensureBlank();
          emit(update.lines, "card");
          if (update.full) state.todosPrinted = JSON.stringify(state.todos);
        }
        if (!state.tools.size) spinner.set({ phase: "waiting", label: undefined });
        render();
        return;
      }
      const end = { ok, summary, body, diff };
      const rendered = renderToolCard(card, end, width());
      if (state.lastKind === "text" || state.lastKind === "user") ensureBlank();
      emit(rendered.lines, "card");
      // The card and its result are kept, not the lines: Ctrl+O lays them out again at the width of that moment.
      state.lastCard = rendered.hidden ? { card, end } : null;
      if (!state.tools.size) spinner.set({ phase: "waiting", label: undefined });
      render();
    },

    askPermission(req) {
      return dialogGuard({ decision: "deny" }, async () => {
        const answer = await permissionDialog(host, req, { readLine, graceMs });
        if (req.signal?.aborted) return { decision: "deny" };
        return answer;
      });
    },
    askQuestion(request) {
      return dialogGuard({ answer: "" }, async () => {
        ensureBlank();
        const result = await questionDialog(host, request, { readLine, graceMs });
        const text = String(result.answer || "").trim();
        const w = width();
        const question = cleanText(request.question).replace(/\s+/g, " ").trim();
        // Both wrapped as paragraphs: a long answer that soft-wrapped on its own would read bottom-to-top in Arabic.
        const asked = para(`${c.accent("?")} ${c.bold(question)}`, w, { indent: "  " });
        const answered = resultRows(text || t("app.q.dismissed"), w, { prose: true, paint: text ? undefined : c.dim });
        emit([...asked, ...answered], "card");
        return { answer: text };
      });
    },
    showPlan({ plan }) {
      return dialogGuard({ decision: "reject" }, async () => {
        ensureBlank();
        emit([...para(c.bold(c.accent(`${sym.mark} ${t("app.plan.title")}`)), width()), ""], "text");
        printRaw(shift(renderMarkdown(cleanText(plan), { width: width() + GUTTER.length, dir: "auto", indent: GUTTER })));
        printRaw([""]);
        const result = await planDialog(host, { readLine, graceMs });
        if (result.decision !== "reject") { try { onPlanDecision?.(result.decision); } catch { /* the tool switches the mode itself when it can */ } }
        return result;
      });
    },

    todos(items) {
      state.todos = Array.isArray(items) ? items.map(item => ({ ...item })) : null;
      render();
    },
    /**
     * Another conversation (/clear, /resume): its own task list, or none, and nothing remembered of the last one's. The
     * old list would otherwise stay pinned over every later turn, and the new conversation's first list would be
     * compared with the old card and get only a status line, or nothing.
     */
    resetTodos(items) {
      state.todoCard = null;
      state.todosPrinted = "";
      ui.todos(items);
    },
    agentStart({ id, description, kind }) {
      const entry = state.tools.get(id);
      const label = t(`app.agent.${kind === "general" ? "general" : "explore"}`);
      if (entry) { entry.card.summary = `${label} ${sym.dot} ${description}`; render(); return; }
      // The header of a card like any other (a structural, left-to-right line): an explorer reads, a task may write.
      const card = { name: "Agent", summary: `${label} ${sym.dot} ${cleanText(description)}`, readOnly: kind !== "general" };
      emit([toolHeader(card, width(), "running")], "card");
    },
    agentEnd({ id, ok, summary }) {
      // A sub-agent started from a tool call already has a card, and the tool's own result line says how it went.
      if (state.tools.has(id)) return;
      // Standing on its own (other cards may have come between), the result is prose: an Arabic one is right-aligned.
      emit(resultRows(summary, width(), { ok, prose: true }), "card");
    },
    notice(level, text) {
      if (state.lastKind === "text" || state.lastKind === "user") ensureBlank();
      emit(renderNotice(level, text, width()), "notice");
    },
    usage(u) {
      state.usage = { inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, contextTokens: u.contextTokens || 0 };
      updateTokens();
    },
    turnEnd({ ms }) {
      const turn = state.turn;
      if (state.todos?.length) {
        const signature = JSON.stringify(state.todos);
        if (signature !== state.todosPrinted) {
          state.todosPrinted = signature;
          ensureBlank();
          emit(renderTodos(state.todos, width()), "todos");
        }
      }
      // Only a long turn gets the quiet footer. Why a turn stopped early (interrupted, error, limits) is already said
      // by the notice the loop printed, so the footer never repeats it ("interrupted" twice, "error" under a red error).
      if (ms > 5000) {
        const inTokens = turn ? Math.max(0, state.usage.inputTokens - turn.baseIn) : 0;
        const outTokens = turn ? Math.max(0, state.usage.outputTokens - turn.baseOut) : 0;
        ensureBlank();
        emit(renderTurnFooter({ ms, inTokens, outTokens }, width()), "footer");
      }
    },

    // ---- beyond what the loop calls: what the application around it needs ---------------------------------------------

    /** Starts the working state: spinner, key handling (Esc, Ctrl+C, Ctrl+O, Shift+Tab). */
    turnBegin({ abort, exit } = {}) {
      const startedAt = now();
      state.turn = { abort, exit, startedAt, ctrlCAt: 0, baseIn: state.usage.inputTokens, baseOut: state.usage.outputTokens };
      state.tools.clear();
      state.thinking = null;
      state.partial = "";
      state.liveChars = 0;
      state.answerAcc = "";
      state.stepHadTools = false;
      state.steer = [];
      state.steerAbort = null;
      state.lastLive = null;
      turnHandler = onTurnKey;
      holdKeys();
      spinner.start({ startedAt });
      spinner.set({ phase: "waiting", tokens: 0, startedAt });
      render();
    },
    /** Ends it: the live region is cleared and the terminal keys are released. */
    turnFinish() {
      spinner.stop();
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      if (state.md) { try { state.md.finish(); } catch { /* the turn is over anyway */ } state.md = null; }
      state.partial = "";
      flushText();
      state.turn = null;
      state.tools.clear();
      state.thinking = null;
      state.partial = "";
      state.steerAbort = null;
      // Steering that arrived after the loop's last step becomes the next prompt instead of being lost.
      if (state.steer.length) {
        state.typeAhead = [state.typeAhead, ...state.steer].filter(Boolean).join("\n");
        state.steer = [];
      }
      turnHandler = null;
      state.lastLive = null;
      releaseKeys();
      if (!state.external && !state.dialog) screen.clearLive();
    },
    isBusy: () => !!state.turn,
    /** Text typed while the agent was working; hands it over once (the next prompt starts with it). */
    takeTypeAhead() {
      const text = state.typeAhead;
      state.typeAhead = "";
      return text;
    },
    /** Messages sent while the turn runs; the loop takes them at its next step. */
    takeSteering() {
      const list = state.steer;
      state.steer = [];
      return list;
    },
    /** The loop registers how to stop the current request without ending the turn. */
    onSteerAbort(fn) { state.steerAbort = typeof fn === "function" ? fn : null; },

    print: lines => emit(lines),
    printRaw: lines => printRaw(lines),
    /** Lines that already carry their own gutter (a rendered answer): placed in the text column. */
    printText: lines => printRaw(shift(lines)),
    ensureBlank,
    lastAnswer: () => state.lastAnswer,
    setLastAnswer(text) { state.lastAnswer = String(text ?? ""); state.answerAcc = state.lastAnswer; },
    usageSnapshot: () => ({ ...state.usage }),
    resetUsage(u) { state.usage = { inputTokens: u?.inputTokens || 0, outputTokens: u?.outputTokens || 0, contextTokens: 0 }; },

    /** Echoes what the person typed into the scrollback (the prompt box disappears when they press Enter). */
    echoUser(text) {
      const w = width();
      const body = cleanText(text).replace(/\s+$/, "");
      // The full width, like every other block: an Arabic message ends on the same right edge as the answer under it.
      const rows = para(body, w, { firstIndent: `${c.accent(sym.prompt)} `, indent: "  " });
      const fold = () => para(c.dim(t("app.fold.more", { n: rows.length - 12 })), w, { firstIndent: "  " });
      const shown = rows.length > 12 ? [...rows.slice(0, 12), ...fold()] : rows;
      ensureBlank();
      emit(shown, "user");
    },
    /** Ctrl+O: the last folded card, in full, laid out for the terminal as it is now. */
    expandLast() {
      const last = state.lastCard;
      if (!last) { emit(renderNotice("info", t("app.card.nothing"), width()), "notice"); return; }
      const w = width();
      const full = renderToolCard(last.card, last.end, w).full;
      ensureBlank();
      emit([...para(c.dim(`${sym.hline.repeat(3)} ${t("app.card.full")}`), w), ...full, ""], "card");
    },

    /** A picker for commands (sessions, language). Resolves the chosen index or -1. */
    pick(options) { return dialogGuard(-1, () => pickDialog(host, { ...options, graceMs })); },
    /**
     * Runs a dialog of the caller's own: run(host, { graceMs }) draws with host.show(lines), reads keys through
     * host.onKey and resolves its answer. `fallback` is the answer when there is no terminal or the dialog is aborted.
     */
    dialog(run, fallback = null) { return dialogGuard(fallback, () => run(host, { graceMs })); },
    readLine,
    host,

    dispose() {
      ui.turnFinish();
      spinner.stop();
      while (stack.length) stack.pop();
      turnHandler = null;
      releaseKeys();
      offResize?.();
    },
  };
  return ui;
}
