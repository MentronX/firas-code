// Keeping the conversation inside the context window: a local token estimate, a cheap per-request pruning pass,
// and compaction (the model summarizes the older part of the conversation, the recent messages stay verbatim).
import { MODEL_ID } from "../brand.js";
import { t } from "../i18n/index.js";
import "./strings.js";
import { contentBlocks, lastTurnStart, toolResultsOf } from "./messages.js";
import { ABORTED, abortGate, capHeadTail, raceAbort, safeUi } from "./support.js";

export const COMPACT_THRESHOLD_TOKENS = 150000;
export const KEEP_RECENT_MESSAGES = 6;
const CHARS_PER_TOKEN = 3.5;
const SUMMARY_MAX_TOKENS = 4096;
const TRANSCRIPT_CAP_CHARS = 360000;

function toolResultText(block) {
  const c = block?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(p => (p && typeof p.text === "string" ? p.text : "")).join("");
  return "";
}

function blockChars(b) {
  if (!b) return 0;
  switch (b.type) {
    case "text": return (b.text || "").length;
    case "thinking": return (b.thinking || "").length;
    case "tool_use": return (b.name || "").length + JSON.stringify(b.input ?? {}).length;
    case "tool_result": return toolResultText(b).length;
    default: return 0; // images are ignored on purpose: their cost is not text-shaped
  }
}

/** chars / 3.5 over the system prompt, the tool definitions and every message. */
export function estimateTokens(messages, system, tools) {
  let chars = 0;
  if (typeof system === "string") chars += system.length;
  else if (Array.isArray(system)) for (const s of system) chars += (s?.text || "").length;
  if (tools && tools.length) chars += JSON.stringify(tools).length;
  for (const m of messages || []) {
    chars += 4;
    for (const b of contentBlocks(m)) chars += blockChars(b);
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function withoutThinking(message) {
  const content = contentBlocks(message).filter(b => b.type !== "thinking");
  // An assistant turn made only of thinking would become empty, which the service rejects.
  return { ...message, content: content.length ? content : [{ type: "text", text: "…" }] };
}

function shrinkResults(message, minChars, stubChars) {
  let touched = false;
  const content = contentBlocks(message).map(b => {
    if (b.type !== "tool_result") return b;
    const text = toolResultText(b);
    if (text.length <= minChars) return b;
    touched = true;
    const omitted = text.length - stubChars;
    return { ...b, content: `${text.slice(0, stubChars)}\n[… ${omitted} more characters of this earlier tool output were removed to save context; run the tool again if you need them]` };
  });
  return touched ? { ...message, content } : message;
}

/**
 * The messages to send with the next request. The stored history is left untouched:
 *  - thinking blocks of finished turns are dropped (only the current turn's tool loop keeps them);
 *  - when the conversation is big, large tool outputs from long ago are cut to a short stub.
 * tool_use ids are never touched, so pairing stays valid.
 */
export function pruneForRequest(session, { shrinkAbove = 50000, keepRecent = 10, minChars = 2000, stubChars = 300 } = {}) {
  const source = session.messages;
  const turnStart = lastTurnStart(source);
  let out = source.map((m, i) => (i < turnStart && m.role === "assistant" && contentBlocks(m).some(b => b.type === "thinking") ? withoutThinking(m) : m));
  if (estimateTokens(out) > shrinkAbove) {
    const limit = out.length - keepRecent;
    out = out.map((m, i) => (i < limit && m.role === "user" ? shrinkResults(m, minChars, stubChars) : m));
  }
  return out;
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;
}

function renderForSummary(message, resultCap) {
  const lines = [];
  for (const b of contentBlocks(message)) {
    if (b.type === "text") lines.push(clip(b.text || "", 8000));
    else if (b.type === "tool_use") lines.push(`[tool call ${b.name} ${clip(JSON.stringify(b.input ?? {}), 700)}]`);
    else if (b.type === "tool_result") lines.push(`[tool result${b.is_error ? " (error)" : ""}: ${clip(toolResultText(b), resultCap)}]`);
  }
  return `${message.role === "user" ? "USER" : "ASSISTANT"}:\n${lines.join("\n")}`;
}

function buildTranscript(messages) {
  const render = cap => messages.map(m => renderForSummary(m, cap)).join("\n\n");
  let text = render(1500);
  if (text.length > TRANSCRIPT_CAP_CHARS) text = render(400);
  if (text.length > TRANSCRIPT_CAP_CHARS) {
    // Keep the opening (the original goal) and the most recent part; the middle is the least valuable.
    const head = Math.floor(TRANSCRIPT_CAP_CHARS * 0.25);
    const tail = TRANSCRIPT_CAP_CHARS - head;
    text = `${text.slice(0, head)}\n\n[… ${text.length - TRANSCRIPT_CAP_CHARS} characters of the middle of the conversation omitted …]\n\n${text.slice(text.length - tail)}`;
  }
  return text;
}

const SUMMARY_SYSTEM = "You write compact, faithful summaries of a coding-agent conversation so the work can continue after the older messages are removed. Output only the summary.";

function summaryInstructions(transcript) {
  return `Below is the earlier part of a conversation between a user and a coding agent, including the tools the agent called. Summarize it so the agent can carry on without the original messages.

Use these sections as terse bullet points (omit a section only if it is empty):
## Goal
## Decisions and constraints
## Files touched (path - what changed or why it matters; also files that were only read but matter)
## Work completed
## Pending work and next steps
## Important facts (working commands, error messages, names, versions, user preferences, open questions)

Rules: keep exact file paths, identifiers, commands and error text. Keep the user's own wording for requirements. Do not invent anything. No filler. Write in the language the user has been using, but leave code and paths as they are. At most about 1,500 words.

<conversation>
${transcript}
</conversation>`;
}

const ACK_TEXT = "Understood. I have the summary of our earlier work and will continue from it.";

function summaryMessage(summary) {
  return { role: "user", content: [{ type: "text", text: `[Summary of the earlier conversation. It was compacted to save space.]\n\n${summary}` }] };
}

/** Where the verbatim tail starts: the last KEEP_RECENT_MESSAGES messages, widened so no tool_result loses its tool_use. */
function tailStart(messages) {
  let k = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);
  // A tail that opens with tool results would lose the tool calls they answer, so it starts one message earlier.
  if (k > 0 && messages[k].role === "user" && toolResultsOf(messages[k]).length) k -= 1;
  return k;
}

async function askForSummary(client, request, signal) {
  const gate = abortGate(signal);
  let iterator;
  let text = "";
  try {
    const stream = await client.stream(request, { signal });
    iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const r = await raceAbort(iterator.next(), gate);
      if (r === ABORTED) return { aborted: true };
      if (r.done) break;
      if (r.value?.type === "text_delta" && typeof r.value.text === "string") text += r.value.text;
    }
    return { text: text.trim() };
  } catch (err) {
    if (signal?.aborted) return { aborted: true };
    return { error: err };
  } finally {
    gate.dispose();
    try { void iterator?.return?.()?.catch?.(() => {}); } catch { /* the stream is already closed */ }
  }
}

/**
 * Summarizes the older messages when the estimated context passes the threshold (or when `force` is set) and
 * replaces them with one synthetic user message (+ an assistant acknowledgement when needed to keep roles
 * alternating). The last few messages stay verbatim. Never throws; reports what happened instead.
 * `system` and `tools` are optional and only improve the estimate.
 */
export async function maybeCompact({ session, client, signal, ui, force = false, system, tools, threshold = COMPACT_THRESHOLD_TOKENS }) {
  const u = safeUi(ui);
  const messages = session.messages;
  const before = Math.max(estimateTokens(messages, system, tools), session.contextTokens || 0);
  if (!force && before <= threshold) return { compacted: false, before, after: before };

  const k = tailStart(messages);
  if (k < 2) {
    if (force) u.notice("info", t("agent.compactNothing"));
    return { compacted: false, before, after: before, reason: "nothing" };
  }
  const head = messages.slice(0, k);
  const tail = messages.slice(k);
  u.notice("info", t("agent.compacting"));

  const request = {
    model: MODEL_ID,
    max_tokens: SUMMARY_MAX_TOKENS,
    stream: true,
    system: [{ type: "text", text: SUMMARY_SYSTEM }],
    messages: [{ role: "user", content: [{ type: "text", text: summaryInstructions(buildTranscript(head)) }] }],
  };
  const result = await askForSummary(client, request, signal);
  if (result.aborted) return { compacted: false, before, after: before, aborted: true };
  if (result.error || !result.text || result.text.length < 40) {
    u.notice("warn", t("agent.compactFailed"));
    return { compacted: false, before, after: before, failed: true };
  }

  const next = [summaryMessage(capHeadTail(result.text, 24000, "summary"))];
  if (tail[0].role === "user") next.push({ role: "assistant", content: [{ type: "text", text: ACK_TEXT }] });
  session.replaceMessages([...next, ...tail]);
  session.save();
  const after = estimateTokens(session.messages, system, tools);
  u.notice("info", t("agent.compacted", { before: Math.round(before / 1000), after: Math.round(after / 1000) }));
  return { compacted: true, before, after };
}
