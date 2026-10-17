// Builds the assistant message out of normalized stream events (the ones client.stream() yields).
//
//   const acc = createAccumulator();
//   for await (const ev of client.stream(req)) acc.add(ev);
//   acc.message()  -> { role: "assistant", content: [ {type:"text",text}, {type:"thinking",thinking},
//                                                      {type:"tool_use",id,name,input[,inputError]} ] }
//
// Decisions:
//  - Blocks are ordered by their stream `index`. Empty text/thinking blocks are left out: they carry nothing
//    and a strict server refuses empty text blocks in history.
//  - A tool_use block's JSON arrives in fragments; it is parsed once, at block_stop (or at message_stop for
//    a stream that forgot to close the block). Bad JSON gives `input: {}` plus `inputError` so the loop can
//    answer with an error tool_result and let the model retry. An empty string means `{}`.
//  - `inputError` is not a wire field: run a message through wireMessage() before it goes back out.
//  - Usage is { inputTokens, outputTokens } (snake_case aliases exist as non-enumerable properties, so
//    `usage.input_tokens` works but never shows up in JSON or deep-equal comparisons).

function usageOf(inputTokens, outputTokens) {
  const usage = { inputTokens, outputTokens };
  Object.defineProperty(usage, "input_tokens", { value: inputTokens, enumerable: false });
  Object.defineProperty(usage, "output_tokens", { value: outputTokens, enumerable: false });
  return usage;
}

const count = value => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

/** Wire usage ({ input_tokens, output_tokens, cache_* }) or an already-normalized one -> { inputTokens, outputTokens }. */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return usageOf(0, 0);
  const cached = (count(raw.cache_read_input_tokens) ?? 0) + (count(raw.cache_creation_input_tokens) ?? 0);
  const input = count(raw.input_tokens ?? raw.inputTokens);
  const output = count(raw.output_tokens ?? raw.outputTokens);
  return usageOf(input === null ? 0 : input + cached, output === null ? 0 : output);
}

/** A later report wins, except that a missing or zero figure never erases a real one (the closing report may omit the input count). */
export function mergeUsage(base, next) {
  const a = normalizeUsage(base);
  const b = normalizeUsage(next);
  return usageOf(b.inputTokens > 0 || a.inputTokens === 0 ? b.inputTokens : a.inputTokens,
    b.outputTokens > 0 || a.outputTokens === 0 ? b.outputTokens : a.outputTokens);
}

function parseToolInput(parts) {
  const raw = parts.join("");
  if (raw.trim() === "") return { input: {} };
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return { input: value };
    return { input: {}, inputError: "tool input must be a JSON object" };
  } catch (error) {
    return { input: {}, inputError: `invalid JSON: ${error.message}` };
  }
}

/** A copy of an assistant message that is safe to send back: local-only fields are removed. */
export function wireMessage(message) {
  return {
    ...message,
    content: (message.content || []).map(block => {
      if (block.type !== "tool_use" || !("inputError" in block)) return block;
      const { inputError: _local, ...rest } = block;
      return rest;
    }),
  };
}

export function createAccumulator() {
  let blocks = new Map();
  let usage = usageOf(0, 0);
  let stopReason = null;
  let finished = false;
  let fallbackIds = 0;

  function ensure(index, type) {
    let block = blocks.get(index);
    if (!block) {
      block = { index, type, text: "", id: "", name: "", parts: [], result: null };
      blocks.set(index, block);
    }
    return block;
  }

  function close(block) {
    if (block.type === "tool_use" && !block.result) block.result = parseToolInput(block.parts);
  }

  function shape(block) {
    if (block.type === "text") return block.text ? { type: "text", text: block.text } : null;
    if (block.type === "thinking") return block.text ? { type: "thinking", thinking: block.text } : null;
    if (block.type !== "tool_use") return null;
    const { input, inputError } = block.result || parseToolInput(block.parts);
    const out = { type: "tool_use", id: block.id, name: block.name, input };
    if (inputError) out.inputError = inputError;
    return out;
  }

  const ordered = () => [...blocks.values()].sort((a, b) => a.index - b.index);

  return {
    add(event) {
      if (!event || typeof event !== "object") return;
      switch (event.type) {
        case "message_start":
          blocks = new Map();
          stopReason = null;
          finished = false;
          usage = normalizeUsage(event.usage);
          break;
        case "block_start": {
          const type = event.block?.type || "text";
          const block = ensure(event.index, type);
          block.type = type;
          if (type === "tool_use") {
            block.id = event.block.id || `call_local_${++fallbackIds}`;
            block.name = event.block.name || "";
          }
          break;
        }
        case "text_delta":
          ensure(event.index, "text").text += event.text ?? "";
          break;
        case "thinking_delta":
          ensure(event.index, "thinking").text += event.text ?? "";
          break;
        case "tool_json_delta": {
          const block = ensure(event.index, "tool_use");
          if (!block.id) block.id = `call_local_${++fallbackIds}`;
          block.parts.push(event.json ?? "");
          break;
        }
        case "block_stop": {
          const block = blocks.get(event.index);
          if (block) close(block);
          break;
        }
        case "message_delta":
          if (event.stopReason) stopReason = event.stopReason;
          if (event.usage) usage = mergeUsage(usage, event.usage);
          break;
        case "message_stop":
          for (const block of blocks.values()) close(block);
          finished = true;
          break;
        default:
          break;
      }
    },
    message() {
      return { role: "assistant", content: ordered().map(shape).filter(Boolean) };
    },
    get stopReason() { return stopReason; },
    get usage() { return usageOf(usage.inputTokens, usage.outputTokens); },
    get thinkingText() { return ordered().filter(block => block.type === "thinking").map(block => block.text).filter(Boolean).join("\n\n"); },
    get text() { return ordered().filter(block => block.type === "text").map(block => block.text).join(""); },
    get hasToolUse() { return ordered().some(block => block.type === "tool_use"); },
    get finished() { return finished; },
  };
}
