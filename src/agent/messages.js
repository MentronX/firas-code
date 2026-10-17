// Helpers for wire-format messages: reading them, cleaning what we store, and repairing a history so that
// every tool_use has its tool_result and roles alternate. The service rejects histories that break either rule,
// so everything that writes or loads messages goes through here.

export const INTERRUPTED_RESULT = "[interrupted by the user before this tool call ran or finished]";

export function contentBlocks(message) {
  const content = message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === "string" && content) return [{ type: "text", text: content }];
  return [];
}

export function toolUsesOf(message) {
  return contentBlocks(message).filter(b => b?.type === "tool_use");
}

export function toolResultsOf(message) {
  return contentBlocks(message).filter(b => b?.type === "tool_result");
}

export function textOf(message) {
  return contentBlocks(message).filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text).join("");
}

/** A user message that starts a turn: it carries text (or an image), not only tool results. */
export function isTurnStart(message) {
  return message?.role === "user" && contentBlocks(message).some(b => b?.type === "text" || b?.type === "image");
}

/** Index of the message that opened the current user turn (0 when none is found). */
export function lastTurnStart(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (isTurnStart(messages[i])) return i;
  return 0;
}

/**
 * Keeps only what the service understands from a streamed assistant message. Empty text and thinking blocks are
 * rejected by the service, and our own bookkeeping fields (such as `inputError`) must never go over the wire.
 */
export function sanitizeAssistantContent(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (!b) continue;
    if (b.type === "text") {
      if (typeof b.text === "string" && b.text.trim()) out.push({ type: "text", text: b.text });
    } else if (b.type === "thinking") {
      if (typeof b.thinking === "string" && b.thinking.trim()) {
        const block = { type: "thinking", thinking: b.thinking };
        if (typeof b.signature === "string" && b.signature) block.signature = b.signature;
        out.push(block);
      }
    } else if (b.type === "tool_use") {
      out.push({ type: "tool_use", id: String(b.id), name: String(b.name), input: b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : {} });
    }
  }
  return out;
}

export function makeToolResult(toolUseId, content, isError = false) {
  const block = { type: "tool_result", tool_use_id: toolUseId, content: String(content ?? "") };
  if (isError) block.is_error = true;
  return block;
}

function normalized(message) {
  if (!message || (message.role !== "user" && message.role !== "assistant")) return null;
  const blocks = contentBlocks(message).filter(b => b && typeof b === "object" && typeof b.type === "string");
  return { role: message.role, content: blocks };
}

/**
 * Returns `{ messages, changed }` with a history the service will accept:
 * roles alternate starting with user, every tool_use is answered by a tool_result in the very next user message,
 * and no tool_result is left without its tool_use. Used when loading old sessions (a crash can leave a dangling
 * tool_use) and as a guard at the start of every turn.
 */
export function repairMessages(messages) {
  let changed = false;
  const list = [];
  for (const raw of messages || []) {
    const m = normalized(raw);
    if (!m) { changed = true; continue; }
    if (raw.content !== m.content && !Array.isArray(raw.content)) changed = true;
    list.push(m);
  }

  // Roles must alternate: fold neighbours with the same role together, tool_results first.
  const merged = [];
  for (const m of list) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      changed = true;
      const all = [...prev.content, ...m.content];
      prev.content = m.role === "user" ? [...all.filter(b => b.type === "tool_result"), ...all.filter(b => b.type !== "tool_result")] : all;
    } else merged.push({ role: m.role, content: [...m.content] });
  }
  while (merged.length && merged[0].role !== "user") { merged.shift(); changed = true; }

  // Pair every tool_use with a tool_result in the next message; drop results that answer nothing.
  const out = [];
  for (let i = 0; i < merged.length; i++) {
    const m = merged[i];
    if (m.role === "user") {
      const prev = out[out.length - 1];
      const wanted = new Set(prev?.role === "assistant" ? toolUsesOf(prev).map(b => b.id) : []);
      const kept = m.content.filter(b => b.type !== "tool_result" || wanted.has(b.tool_use_id));
      if (kept.length !== m.content.length) changed = true;
      if (!kept.length) { changed = true; continue; }
      out.push({ role: "user", content: kept });
      continue;
    }
    out.push(m);
    const uses = toolUsesOf(m);
    if (!uses.length) continue;
    const next = merged[i + 1];
    const answered = new Set(next?.role === "user" ? toolResultsOf(next).map(b => b.tool_use_id) : []);
    const missing = uses.filter(u => !answered.has(u.id));
    if (!missing.length) continue;
    changed = true;
    const stubs = missing.map(u => makeToolResult(u.id, INTERRUPTED_RESULT, true));
    if (next?.role === "user") next.content = [...stubs, ...next.content];
    else merged.splice(i + 1, 0, { role: "user", content: stubs });
  }

  // Dropping an empty user message can leave two assistant messages side by side; run the fold once more.
  const final = [];
  for (const m of out) {
    const prev = final[final.length - 1];
    if (prev && prev.role === m.role) { changed = true; prev.content = [...prev.content, ...m.content]; } else final.push(m);
  }
  return { messages: changed ? final : messages, changed };
}
