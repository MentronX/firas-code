// Runs one shell command to completion (or in the background) with bounded memory, throttled progress,
// a timeout, abort support, and whole-tree termination.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { buildInvocation, killTree, killTreeSync } from "./shell.js";
import { childEnv } from "./common.js";

// Terminal control sequences (colours, cursor moves, window titles) that a program may print. They are only
// recognised here to be removed; the escape character is spelled out so no raw escape code lives in this file.
const E = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(`${E}\\[[0-?]*[ -/]*[@-~]|${E}\\][^${BEL}${E}]*(?:${BEL}|${E}\\\\)|${E}[()][0-9A-Za-z]|${E}[=>78M]`, "g");

/** Plain text for the model: no colour codes, CRLF -> LF, progress-bar carriage returns collapsed. */
export function cleanOutput(text) {
  return text
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => (line.includes("\r") ? (line.split("\r").filter(Boolean).pop() ?? "") : line))
    .join("\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** Keeps the first `headMax` and the last `tailMax` characters of an unbounded stream. */
export class OutputBuffer {
  constructor(headMax = 10_000, tailMax = 20_000) {
    this.headMax = headMax;
    this.tailMax = tailMax;
    this.head = "";
    this.tail = "";
    this.dropped = 0;
    this.total = 0;
  }

  push(text) {
    this.total += text.length;
    if (this.head.length < this.headMax) {
      const room = this.headMax - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
    }
    if (!text) return;
    this.tail += text;
    if (this.tail.length > this.tailMax * 2) {
      this.dropped += this.tail.length - this.tailMax;
      this.tail = this.tail.slice(-this.tailMax);
    }
  }

  render() {
    let tail = this.tail;
    let dropped = this.dropped;
    if (tail.length > this.tailMax) { dropped += tail.length - this.tailMax; tail = tail.slice(-this.tailMax); }
    const raw = dropped ? `${this.head}\n... [${dropped} characters omitted] ...\n${tail}` : this.head + tail;
    return cleanOutput(raw);
  }

  /** The last few non-empty lines, for live progress. */
  recent(lines = 5, width = 200) {
    const source = (this.tail || this.head).slice(-4000);
    return cleanOutput(source).split("\n").map(l => l.trimEnd()).filter(Boolean).slice(-lines).map(l => (l.length > width ? l.slice(0, width) + "…" : l)).join("\n");
  }
}

/** Last `max` characters of a background job's output, with an absolute read position. */
export class RingBuffer {
  constructor(max = 1_000_000) { this.max = max; this.text = ""; this.base = 0; this.readPos = 0; }

  push(chunk) {
    this.text += chunk;
    if (this.text.length > this.max) {
      const cut = this.text.length - this.max;
      this.text = this.text.slice(cut);
      this.base += cut;
    }
  }

  /** Output produced since the last call, and how much of it had already scrolled out of the buffer. */
  readNew() {
    const end = this.base + this.text.length;
    const dropped = Math.max(0, this.base - this.readPos);
    const from = Math.max(this.readPos, this.base) - this.base;
    this.readPos = end;
    return { text: this.text.slice(from), dropped };
  }
}

const liveJobs = new Set();
let exitHookInstalled = false;
function trackJob(pid) {
  liveJobs.add(pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => { for (const id of liveJobs) killTreeSync(id); });
}
export const untrackJob = pid => liveJobs.delete(pid);

/**
 * Starts a command. Returns { pid, done } where done resolves to
 * { code, signal, timedOut, aborted, error, ms } and never rejects.
 * opts: { info, command, cwd, env, signal?, timeoutMs?, onChunk(text) , platform?, track? }
 */
export function startProcess({ info, command, cwd, env, signal, timeoutMs, onChunk, platform = process.platform, track = false }) {
  const startedAt = Date.now();
  if (signal?.aborted) return { pid: null, done: Promise.resolve({ code: null, signal: null, timedOut: false, aborted: true, ms: 0 }) };
  const inv = buildInvocation(info, command);
  let child;
  try {
    child = spawn(inv.file, inv.args, {
      // Whatever the caller passes, the access code never reaches a child.
      cwd, env: childEnv(env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: platform !== "win32", ...inv.options,
    });
  } catch (error) {
    return { pid: null, done: Promise.resolve({ code: null, signal: null, timedOut: false, aborted: false, error, ms: 0 }) };
  }
  if (track && child.pid) trackJob(child.pid);

  const done = new Promise(resolve => {
    let finished = false, timedOut = false, aborted = false, exit = null, killing = null;
    let timer = null, grace = null, hardStop = null;
    const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };

    const finish = extra => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(grace); clearTimeout(hardStop);
      signal?.removeEventListener("abort", onAbort);
      for (const [name, stream] of [["out", child.stdout], ["err", child.stderr]]) {
        const rest = decoders[name].end();
        if (rest) onChunk?.(rest);
        try { stream.destroy(); } catch { /* closed already */ }
      }
      if (track && child.pid) untrackJob(child.pid);
      resolve({ code: exit?.code ?? null, signal: exit?.signal ?? null, timedOut, aborted, ms: Date.now() - startedAt, ...extra });
    };
    const kill = () => {
      if (killing) return;
      killing = killTree(child.pid, { platform });
      // If the tree refuses to die we still hand control back.
      hardStop = setTimeout(() => finish(), 3000);
    };
    function onAbort() { aborted = true; kill(); }

    child.stdout.on("data", buf => { const s = decoders.out.write(buf); if (s) onChunk?.(s); });
    child.stderr.on("data", buf => { const s = decoders.err.write(buf); if (s) onChunk?.(s); });
    child.on("error", error => finish({ error }));
    child.on("exit", (code, sig) => {
      exit = { code, signal: sig };
      // A background grandchild may keep the pipes open; do not wait for it forever.
      grace = setTimeout(() => finish(), 300);
    });
    child.on("close", (code, sig) => { exit = exit || { code, signal: sig }; finish(); });
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return { pid: child.pid ?? null, child, done };
}

export const runProcess = opts => startProcess(opts).done;
