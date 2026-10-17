// Small runtime helpers shared by the loop, the compactor and the sub-agent.

export const ABORTED = Symbol("aborted");

/**
 * One promise per signal that resolves with ABORTED when it fires. Racing every awaited step against it keeps
 * Esc responsive even when a client or a tool ignores the signal.
 */
export function abortGate(signal) {
  if (!signal) return { promise: new Promise(() => {}), dispose() {} };
  if (signal.aborted) return { promise: Promise.resolve(ABORTED), dispose() {} };
  let onAbort;
  const promise = new Promise(resolve => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, dispose() { signal.removeEventListener("abort", onAbort); } };
}

/** Resolves with the value of `promise`, or ABORTED if the gate fires first. A late rejection is swallowed. */
export function raceAbort(promise, gate) {
  const p = Promise.resolve(promise);
  p.catch(() => {});
  return Promise.race([p, gate.promise]);
}

export function readUsage(usage) {
  const num = v => (Number.isFinite(v) ? v : undefined);
  return { input: num(usage?.input_tokens ?? usage?.inputTokens), output: num(usage?.output_tokens ?? usage?.outputTokens) };
}

/**
 * Wraps a UI object so that a missing method is a no-op and a throwing method cannot take the turn down with it:
 * a rendering bug must never leave the history half-written.
 */
export function safeUi(ui) {
  return new Proxy(ui || {}, {
    get(target, key) {
      const fn = target[key];
      if (typeof fn !== "function") return () => undefined;
      return (...args) => {
        try { return fn.apply(target, args); } catch { return undefined; }
      };
    },
  });
}

export function firstLine(text, max = 120) {
  const line = String(text ?? "").split(/\r?\n/).find(l => l.trim()) || "";
  const clean = line.trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

/** Cuts the middle out of long text, keeping the start and the end (command output matters most at the end). */
export function capHeadTail(text, limit, label = "output") {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.75);
  const tail = limit - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[… ${label} truncated: ${omitted} characters omitted from the middle (limit ${limit}) …]\n\n${text.slice(text.length - tail)}`;
}

export function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
