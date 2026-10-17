// The agent loop: one user turn = a series of model requests, each followed by running the tools it asked for,
// until the model answers without tool calls. Everything here keeps one invariant: whatever happens (abort,
// service error, a tool that throws), the stored history stays valid, i.e. every tool_use has its tool_result.
import { MODEL_ID } from "../brand.js";
import { t } from "../i18n/index.js";
import "./strings.js";
import { buildSystemPrompt, detectGit, formatDate, loadProjectInstructions, ULTRACODE_NOTE } from "./prompt.js";
import { estimateTokens, maybeCompact, pruneForRequest } from "./context.js";
import { INTERRUPTED_RESULT, makeToolResult, repairMessages, sanitizeAssistantContent, textOf } from "./messages.js";
import { ABORTED, abortGate, capHeadTail, firstLine, raceAbort, randomId, readUsage, safeUi } from "./support.js";

export const MAX_STEPS = 60;
// An ultracode turn maps, plans, builds, verifies and has its work reviewed: it gets room for all of it.
export const ULTRA_MAX_STEPS = 150;
export const MAX_CONTINUATIONS = 2;
export const MAX_RESULT_CHARS = 100 * 1024;
const MAX_PARALLEL_TOOLS = 10;
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultracode"];
const CONTINUE_TEXT = "Continue exactly where you stopped. Do not repeat what you already wrote.";

/**
 * Effort level -> the request fields that carry it. Ultracode travels as the service's own top level ("max"): what
 * makes a turn ultracode is how the agent works (ULTRACODE_NOTE and the larger step budget), not a field.
 */
export function requestShape(effort) {
  const level = EFFORTS.includes(effort) ? effort : effort === "off" ? "low" : "medium";
  const wire = level === "ultracode" ? "max" : level;
  return { max_tokens: wire === "xhigh" || wire === "max" ? 32000 : 16000, thinking: { type: "adaptive" }, output_config: { effort: wire } };
}

/** The system prompt (a string, or a function returning one) with the ultracode instructions after it. */
function withUltracode(system) {
  if (typeof system === "function") return () => `${system()}\n\n${ULTRACODE_NOTE}`;
  return `${system}\n\n${ULTRACODE_NOTE}`;
}

function buildRequest({ system, tools, messages, effort }) {
  const shape = requestShape(effort);
  const request = { model: MODEL_ID, max_tokens: shape.max_tokens, stream: true, system: [{ type: "text", text: system }], messages };
  if (tools.length) request.tools = tools;
  if (shape.thinking) {
    request.thinking = shape.thinking;
    request.output_config = shape.output_config;
  }
  return request;
}

// ---------------------------------------------------------------------------------------------------------
// Tool input checking. The model often quotes numbers and booleans or forgets a required field; catching that
// here costs nothing and saves a confusing failure inside the tool.

function enumProblem(value, spec) {
  return Array.isArray(spec?.enum) && !spec.enum.includes(value) ? `must be one of: ${spec.enum.join(", ")}` : null;
}

function matchesType(value, type) {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return !!value && typeof value === "object" && !Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}

function coerce(value, spec) {
  const types = Array.isArray(spec?.type) ? spec.type : spec?.type ? [spec.type] : [];
  if (!types.length || types.some(ty => matchesType(value, ty))) {
    const problem = enumProblem(value, spec);
    return problem ? { error: problem } : { value };
  }
  if (typeof value === "string") {
    const text = value.trim();
    if ((types.includes("number") || types.includes("integer")) && text !== "" && Number.isFinite(Number(text))) {
      const n = Number(text);
      if (types.includes("number") || Number.isInteger(n)) return { value: n };
    }
    if (types.includes("boolean") && (text === "true" || text === "false")) return { value: text === "true" };
    if (types.includes("array") || types.includes("object")) {
      try {
        const parsed = JSON.parse(text);
        if (types.some(ty => matchesType(parsed, ty))) return { value: parsed };
      } catch { /* not JSON: report the type problem below */ }
    }
  }
  return { error: `must be ${types.join(" or ")}` };
}

export function checkInput(input, schema) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "the input must be a JSON object" };
  const out = { ...input };
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const missing = required.filter(k => out[k] === undefined || out[k] === null);
  if (missing.length) return { error: `missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}` };
  for (const [key, spec] of Object.entries(schema?.properties || {})) {
    if (out[key] === undefined) continue;
    const r = coerce(out[key], spec);
    if (r.error) return { error: `parameter "${key}" ${r.error}` };
    out[key] = r.value;
  }
  return { input: out };
}

// ---------------------------------------------------------------------------------------------------------
// One streamed model response.

function parseToolJson(raw, seed) {
  const text = raw.trim();
  if (!text) return { input: seed && typeof seed === "object" && !Array.isArray(seed) ? seed : {} };
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return { input: value };
    return { input: {}, error: "the input was valid JSON but not an object" };
  } catch (err) {
    return { input: {}, error: `invalid JSON (${err.message})` };
  }
}

/**
 * Drives one `client.stream` call: forwards blocks to the UI as they arrive and returns the assembled blocks.
 * Never throws; failures come back as `aborted` or `error`. Iterating by hand (not `for await`) lets an abort end
 * the wait immediately even when the client does not look at the signal.
 */
async function streamOnce({ client, request, signal, ui }) {
  const blocks = new Map();
  const usage = { input: undefined, output: undefined };
  let stopReason = null;
  let aborted = false;
  let error = null;
  let ended = false;
  let iterator;
  const gate = abortGate(signal);

  const open = (index, type, meta = {}) => {
    const block = { index, type, id: meta.id, name: meta.name, text: "", json: "", seed: meta.input, open: true, startedAt: Date.now() };
    blocks.set(index, block);
    if (type === "text") ui.textStart();
    else if (type === "thinking") ui.thinkingStart();
    return block;
  };
  const close = block => {
    if (!block.open) return;
    block.open = false;
    if (block.type === "text") ui.textEnd();
    else if (block.type === "thinking") ui.thinkingEnd({ ms: Date.now() - block.startedAt, chars: block.text.length });
    else {
      const parsed = parseToolJson(block.json, block.seed);
      block.input = parsed.input;
      block.inputError = parsed.error;
    }
  };
  const take = u => {
    const r = readUsage(u);
    if (r.input !== undefined) usage.input = r.input;
    if (r.output !== undefined) usage.output = r.output;
  };
  const handle = ev => {
    switch (ev?.type) {
      case "message_start": take(ev.usage); break;
      case "block_start": {
        const type = ev.block?.type;
        if (type === "text" || type === "thinking" || type === "tool_use") open(ev.index, type, ev.block);
        break;
      }
      case "text_delta": {
        const block = blocks.get(ev.index) ?? open(ev.index, "text");
        if (block.type !== "text" || typeof ev.text !== "string") break;
        block.text += ev.text;
        ui.textDelta(ev.text);
        break;
      }
      case "thinking_delta": {
        const block = blocks.get(ev.index) ?? open(ev.index, "thinking");
        if (block.type !== "thinking" || typeof ev.text !== "string") break;
        block.text += ev.text;
        ui.thinkingDelta(ev.text);
        break;
      }
      case "tool_json_delta": {
        const block = blocks.get(ev.index);
        if (block?.type === "tool_use" && typeof ev.json === "string") block.json += ev.json;
        break;
      }
      case "block_stop": {
        const block = blocks.get(ev.index);
        if (block) close(block);
        break;
      }
      case "message_delta":
        if (ev.stopReason) stopReason = ev.stopReason;
        take(ev.usage);
        break;
      case "message_stop": ended = true; break;
      default: break; // ping and anything newer
    }
  };

  try {
    const stream = await raceAbort(client.stream(request, { signal }), gate);
    if (stream === ABORTED) aborted = true;
    else {
      iterator = stream[Symbol.asyncIterator]();
      while (!ended) {
        const r = await raceAbort(iterator.next(), gate);
        if (r === ABORTED) { aborted = true; break; }
        if (r.done) break;
        handle(r.value);
        if (signal?.aborted) { aborted = true; break; }
      }
    }
  } catch (err) {
    if (signal?.aborted) aborted = true;
    else error = err;
  } finally {
    gate.dispose();
    // A block left open means the stream was cut: close it for the UI (tool inputs are judged by their JSON).
    for (const block of blocks.values()) close(block);
    // Not awaited: on an abort the generator may still be inside a pending read, and return() queues behind it.
    if (iterator) try { void iterator.return()?.catch?.(() => {}); } catch { /* already closed */ }
  }
  const ordered = [...blocks.values()].sort((a, b) => a.index - b.index);
  return { blocks: ordered, stopReason, usage, aborted, error };
}

// ---------------------------------------------------------------------------------------------------------
// Running the tools of one assistant message.

function normalizeToolResult(out) {
  if (typeof out === "string") return { ok: true, content: out };
  const content = typeof out?.content === "string" ? out.content : out?.content == null ? "" : JSON.stringify(out.content);
  return { ok: out?.ok !== false, content, display: out?.display };
}

async function runPool(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function createToolRunner({ toolbox, permissions, ui, session, client, config, signal, depth, fileState, turn }) {
  const gate = abortGate(signal);

  const getTool = name => {
    const map = toolbox.byName;
    if (map instanceof Map) return map.get(name);
    if (map && Object.hasOwn(map, name)) return map[name];
    return (toolbox.tools || []).find(tool => tool.name === name);
  };
  const toolNames = () => (toolbox.tools || []).map(tool => tool.name);

  const makeCtx = call => ({
    cwd: session.cwd,
    signal,
    platform: process.platform,
    env: process.env,
    fileState,
    ui,
    client,
    config,
    session,
    depth,
    mode: permissions.mode,
    progress: text => ui.toolProgress(call.id, text),
    // Not in the base contract: the sub-agent tool needs the toolbox and the shared turn state, and its card needs the id.
    toolbox,
    turn,
    toolUseId: call.id,
  });

  const isParallel = call => {
    const tool = getTool(call.name);
    if (!tool || call.inputError) return false;
    if (typeof tool.isParallel === "function") {
      try { return !!tool.isParallel(call.input); } catch { return false; }
    }
    return !!(tool.readOnly && tool.concurrencySafe);
  };

  /** Finds the tool, checks the input and builds the summary. Returns `{ error }` for anything the model must fix. */
  async function prepare(call) {
    const tool = getTool(call.name);
    if (!tool) {
      const lower = String(call.name).toLowerCase();
      const near = toolNames().find(n => n.toLowerCase() === lower);
      return { error: { content: `Unknown tool "${call.name}". ${near ? `Did you mean "${near}"? ` : ""}Available tools: ${toolNames().join(", ")}.`, summary: t("agent.toolUnknown") } };
    }
    if (call.inputError) {
      if (call.truncated) {
        return { error: { content: `Your response hit the output length limit while you were writing the input for "${call.name}", so the call was not run. Retry with a much smaller input (for example write a large file in several steps).`, summary: t("agent.toolCutOff") } };
      }
      return { error: { content: `The input for tool "${call.name}" could not be read: ${call.inputError}. Send the arguments again as one valid JSON object.`, summary: t("agent.toolBadJson") } };
    }
    const ctx = makeCtx(call);
    const checked = checkInput(call.input, tool.input_schema);
    if (checked.error) {
      const required = tool.input_schema?.required?.length ? ` Required parameters: ${tool.input_schema.required.join(", ")}.` : "";
      return { error: { content: `Invalid input for tool "${tool.name}": ${checked.error}.${required}`, summary: t("agent.toolInvalid") } };
    }
    let problem = null;
    try { problem = tool.validate ? await tool.validate(checked.input, ctx) : null; } catch (err) { problem = `validation failed (${err?.message || err})`; }
    if (problem) return { error: { content: `Invalid input for tool "${tool.name}": ${problem}`, summary: t("agent.toolInvalid") } };
    let summary = "";
    try { summary = tool.summarize ? String(tool.summarize(checked.input, ctx) ?? "") : ""; } catch { summary = ""; }
    return { call, tool, input: checked.input, ctx, summary };
  }

  /** Permission checks are serialized per turn: parallel sub-agents must not stack dialogs on the user. */
  async function askPermission({ tool, input, ctx }) {
    const run = () => permissions.check(tool, input, ctx);
    turn.permLock = turn.permLock.then(run, run);
    const pending = turn.permLock;
    turn.permLock = pending.catch(() => {});
    try {
      const verdict = await raceAbort(pending, gate);
      if (verdict === ABORTED) return ABORTED;
      return { allowed: !!verdict?.allowed, feedback: verdict?.feedback };
    } catch (err) {
      return { allowed: false, feedback: `the permission check failed (${err?.message || err})` };
    }
  }

  /**
   * Runs every tool call of one assistant message and returns the tool_result blocks in the original order.
   * Consecutive read-only + concurrency-safe calls run together; any other call runs alone, in sequence.
   */
  async function runCalls(calls) {
    const results = new Array(calls.length);

    const settle = (index, call, entry, startedAt) => {
      const content = capHeadTail(entry.content || "(no output)", MAX_RESULT_CHARS, "tool output");
      results[index] = makeToolResult(call.id, content, !entry.ok);
      const display = entry.display || {};
      ui.toolEnd({
        id: call.id,
        name: call.name,
        ok: entry.ok,
        summary: entry.summary ?? display.summary ?? (entry.ok ? "" : firstLine(entry.content)),
        body: display.body,
        diff: display.diff,
        ms: Date.now() - startedAt,
      });
    };
    const startCard = (call, summary, readOnly) => ui.toolStart({ id: call.id, name: call.name, summary: summary || call.name, input: call.input, readOnly: !!readOnly });

    const runOne = async (index, { tool, input, ctx, call }) => {
      const startedAt = Date.now();
      let entry;
      try {
        const out = await raceAbort(Promise.resolve().then(() => tool.run(input, ctx)), gate);
        entry = out === ABORTED ? { ok: false, content: INTERRUPTED_RESULT, summary: t("agent.toolInterrupted") } : normalizeToolResult(out);
      } catch (err) {
        entry = signal?.aborted
          ? { ok: false, content: INTERRUPTED_RESULT, summary: t("agent.toolInterrupted") }
          : { ok: false, content: `Tool "${tool.name}" failed: ${err?.message || err}`, summary: t("agent.toolFailed") };
      }
      if (signal?.aborted && !entry.ok && entry.content !== INTERRUPTED_RESULT) entry = { ...entry, content: `${entry.content}\n[interrupted by the user]` };
      settle(index, call, entry, startedAt);
    };

    const runGroup = async (from, to) => {
      const approved = [];
      for (let i = from; i < to; i++) {
        if (signal?.aborted) return;
        const call = calls[i];
        const prepared = await prepare(call);
        if (prepared.error) {
          startCard(call, call.name, false);
          settle(i, call, { ok: false, content: prepared.error.content, summary: prepared.error.summary }, Date.now());
          continue;
        }
        const verdict = await askPermission(prepared);
        if (verdict === ABORTED) return;
        if (!verdict.allowed) {
          const why = verdict.feedback ? ` Reason or feedback: ${verdict.feedback}` : " The user declined.";
          startCard(call, prepared.summary, prepared.tool.readOnly);
          settle(i, call, {
            ok: false,
            content: `Permission denied for ${call.name}.${why} Do not retry this action unchanged; take the feedback into account, choose another approach, or ask the user.`,
            summary: verdict.feedback ? t("agent.toolDeniedWhy", { why: firstLine(verdict.feedback, 80) }) : t("agent.toolDenied"),
          }, Date.now());
          continue;
        }
        approved.push({ index: i, prepared });
      }
      if (signal?.aborted) return;
      for (const { index, prepared } of approved) startCard(calls[index], prepared.summary, prepared.tool.readOnly);
      await runPool(approved, MAX_PARALLEL_TOOLS, ({ index, prepared }) => runOne(index, prepared));
    };

    let i = 0;
    while (i < calls.length && !signal?.aborted) {
      let j = i + 1;
      if (isParallel(calls[i])) while (j < calls.length && isParallel(calls[j])) j++;
      try {
        await runGroup(i, j);
      } catch (err) {
        // A bug in a tool's own helpers (summarize, permission) must not leave the group unanswered.
        for (let k = i; k < j; k++) if (!results[k]) results[k] = makeToolResult(calls[k].id, `Tool execution failed internally: ${err?.message || err}`, true);
      }
      i = j;
    }
    // Whatever never ran (abort) still needs an answer, or the next request would be rejected.
    calls.forEach((call, k) => {
      if (!results[k]) results[k] = makeToolResult(call.id, INTERRUPTED_RESULT, true);
    });
    return results;
  }

  return { runCalls, dispose: () => gate.dispose() };
}

// ---------------------------------------------------------------------------------------------------------
// The loop itself.

function usedChars(blocks) {
  let n = 0;
  for (const b of blocks) n += b.type === "tool_use" ? (b.name || "").length + (b.json || "").length : (b.text || "").length;
  return n;
}

/**
 * Runs model requests until the model stops asking for tools. The user message must already be in the session.
 * Shared by the main turn and by sub-agents. Returns `{ stopReason, steps, usage, text }`, where stopReason is one of
 * end_turn | max_steps | max_tokens | aborted | error | empty and `text` is the closing assistant text.
 */
export async function runAgentLoop(options) {
  const { session, client, toolbox, permissions, config, effort, depth = 0, maxSteps = MAX_STEPS, autoCompact = true } = options;
  // A function lets the prompt follow things that change mid-turn, such as the permission mode after ExitPlanMode.
  const systemNow = () => (typeof options.system === "function" ? options.system() : options.system);
  if (!permissions || typeof permissions.check !== "function") throw new TypeError("runAgentLoop needs a permission engine");
  const ui = safeUi(options.ui);
  const signal = options.signal ?? new AbortController().signal;
  const turn = options.turn ?? { permLock: Promise.resolve() };
  const fileState = options.fileState ?? toolbox.fileState ?? session.fileState;
  const toolDefs = toolbox.definitions();
  const runner = createToolRunner({ toolbox, permissions, ui, session, client, config, signal, depth, fileState, turn });
  const usage = { inputTokens: 0, outputTokens: 0 };

  let steps = 0;
  let continuations = 0;
  let emptyRetried = false;
  let tooLargeRetried = false;
  let compactBlocked = false;
  let saveWarned = false;
  let stopReason = "end_turn";
  // finalText is the closing answer (continuations joined); narration is the text that came with the last tool calls.
  let finalText = "";
  let narration = "";

  const save = () => {
    if (session.save() === false && !saveWarned) {
      saveWarned = true;
      ui.notice("warn", t("agent.saveFailed"));
    }
  };

  try {
    while (true) {
      if (signal.aborted) { stopReason = "aborted"; break; }
      if (steps >= maxSteps) {
        ui.notice("warn", t("agent.maxSteps", { n: maxSteps }));
        stopReason = "max_steps";
        break;
      }
      const system = systemNow();
      if (autoCompact && !compactBlocked) {
        const c = await maybeCompact({ session, client, signal, ui, system, tools: toolDefs });
        if (c.aborted) { stopReason = "aborted"; break; }
        if (c.failed) compactBlocked = true;
      }

      steps += 1;
      const request = buildRequest({ system, tools: toolDefs, messages: pruneForRequest(session), effort });
      ui.requestStart({ step: steps, effort });
      let res;
      try { res = await streamOnce({ client, request, signal, ui }); } finally { ui.requestEnd(); }

      if (res.usage.input !== undefined || res.usage.output !== undefined || res.blocks.length) {
        const input = res.usage.input ?? estimateTokens(request.messages, request.system, request.tools);
        const output = res.usage.output ?? Math.ceil(usedChars(res.blocks) / 3.5);
        session.addUsage({ inputTokens: input, outputTokens: output });
        usage.inputTokens += input;
        usage.outputTokens += output;
        session.contextTokens = input + output;
        ui.usage({ inputTokens: session.usage.inputTokens, outputTokens: session.usage.outputTokens, contextTokens: session.contextTokens });
      }

      if (res.aborted || res.error) {
        // Keep what the user already saw (text only); partial thinking and half-built tool calls are dropped.
        const partial = res.blocks.filter(b => b.type === "text" && b.text.trim()).map(b => ({ type: "text", text: b.text }));
        if (partial.length) session.addAssistant({ content: partial });
        save();
        if (res.aborted) { stopReason = "aborted"; break; }
        const code = res.error.code;
        if (code === "request_too_large" && autoCompact && !tooLargeRetried) {
          tooLargeRetried = true;
          ui.notice("warn", t("agent.tooLarge"));
          const c = await maybeCompact({ session, client, signal, ui, force: true, system, tools: toolDefs });
          if (c.aborted) { stopReason = "aborted"; break; }
          if (c.compacted) continue;
        }
        ui.notice("error", res.error.userMessage || t("agent.serviceError") + (process.env.FIRAS_DEBUG ? ` (${res.error.message})` : ""));
        stopReason = "error";
        break;
      }

      const taken = new Set();
      const content = [];
      const calls = [];
      for (const b of res.blocks) {
        if (b.type === "tool_use") {
          let id = b.id ? String(b.id) : randomId("call");
          while (taken.has(id)) id = randomId("call");
          taken.add(id);
          const call = { id, name: String(b.name || ""), input: b.input ?? {}, inputError: b.inputError, truncated: !!b.inputError && res.stopReason === "max_tokens" };
          calls.push(call);
          content.push({ type: "tool_use", id, name: call.name, input: call.input });
        } else if (b.type === "text") content.push({ type: "text", text: b.text });
        else content.push({ type: "thinking", thinking: b.text });
      }
      const stored = sanitizeAssistantContent(content);
      const hasText = stored.some(b => b.type === "text");

      if (!calls.length && !hasText) {
        if (!emptyRetried) { emptyRetried = true; continue; }
        ui.notice("warn", t("agent.emptyResponse"));
        stopReason = res.stopReason === "max_tokens" ? "max_tokens" : "empty";
        break;
      }

      session.addAssistant({ content: stored });
      const said = textOf({ content: stored });

      if (calls.length) {
        continuations = 0;
        finalText = "";
        narration = said;
        const blocks = await runner.runCalls(calls);
        session.addToolResults(blocks);
        save();
        if (signal.aborted) { stopReason = "aborted"; break; }
        continue;
      }

      finalText += said;
      if (res.stopReason === "max_tokens") {
        if (continuations >= MAX_CONTINUATIONS) {
          ui.notice("warn", t("agent.maxTokensGiveUp"));
          stopReason = "max_tokens";
          break;
        }
        continuations += 1;
        ui.notice("warn", t("agent.maxTokens"));
        session.addUser(CONTINUE_TEXT);
        continue;
      }

      stopReason = "end_turn";
      break;
    }
  } finally {
    runner.dispose();
  }

  if (stopReason === "aborted") ui.notice("warn", t("agent.interrupted"));
  save();
  return { stopReason, steps, usage, text: finalText || narration };
}

// ---------------------------------------------------------------------------------------------------------
// One user turn.

/** Reads git state and project files once per turn; the returned function renders the prompt with the current mode. */
async function composeSystem({ session, toolbox, permissions, lang, signal }) {
  const git = await detectGit(session.cwd, undefined, signal);
  const projectInstructions = loadProjectInstructions(session.cwd);
  const toolNames = (toolbox.tools || []).map(tool => tool.name);
  const date = formatDate(new Date());
  return () => buildSystemPrompt({
    cwd: session.cwd,
    platform: process.platform,
    shell: toolbox.shell,
    date,
    lang,
    projectInstructions,
    git,
    mode: permissions.mode || session.mode || "default",
    toolNames,
  });
}

/**
 * Adds the user's text to the session and runs the agent until it is done. `system` (a string, or a function
 * returning one) replaces the generated prompt; tests and callers that already built one use it.
 * Resolves with `{ stopReason, steps, usage }`; never rejects.
 */
export async function runUserTurn({ session, text, ui, client, toolbox, permissions, effort, signal, lang = "en", config, system }) {
  const u = safeUi(ui);
  const abortSignal = signal ?? new AbortController().signal;
  const startedAt = Date.now();
  let outcome = { stopReason: "error", steps: 0, usage: { inputTokens: 0, outputTokens: 0 } };
  // The service rejects empty text blocks, so an empty line from the prompt box must not become a request.
  if (typeof text !== "string" || !text.trim()) return { stopReason: "end_turn", steps: 0, usage: outcome.usage };
  try {
    // A previous turn killed by something other than our own abort path may have left a dangling tool_use.
    const repaired = repairMessages(session.messages);
    if (repaired.changed) session.replaceMessages(repaired.messages);
    session.addUser(text);
    session.usage.turns += 1;
    session.save();
    const prompt = system ?? await composeSystem({ session, toolbox, permissions, lang, signal: abortSignal });
    const level = effort ?? config?.effort ?? "medium";
    const ultra = level === "ultracode";
    outcome = await runAgentLoop({
      session, ui: u, client, toolbox, permissions, config,
      effort: level,
      signal: abortSignal,
      system: ultra ? withUltracode(prompt) : prompt,
      maxSteps: ultra ? ULTRA_MAX_STEPS : MAX_STEPS,
    });
  } catch (err) {
    u.notice("error", t("agent.internalError") + (process.env.FIRAS_DEBUG ? ` (${err?.message || err})` : ""));
    session.save();
  }
  u.turnEnd({ ms: Date.now() - startedAt, stopReason: outcome.stopReason, steps: outcome.steps });
  return { stopReason: outcome.stopReason, steps: outcome.steps, usage: outcome.usage };
}
