// Saved conversations: one JSON file per session under sessionsDir(), written atomically with mode 0600.
// The file begins with a small header and ends with the messages, so listing sessions only has to read the
// first few hundred bytes of each file instead of parsing every conversation.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { sessionsDir, writePrivate } from "../util/paths.js";
import { contentBlocks, repairMessages, sanitizeAssistantContent, makeToolResult } from "./messages.js";

const FORMAT_VERSION = 1;
const TITLE_MAX = 60;
const HEADER_BYTES = 4096;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function pad(n) { return String(n).padStart(2, "0"); }

function newId(now = new Date()) {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

/** Same folder regardless of separators, trailing slash or (on Windows) letter case. */
function sameDir(a, b) {
  const norm = p => { const r = path.resolve(String(p || "")); return process.platform === "win32" ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
}

export function titleFrom(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > TITLE_MAX ? clean.slice(0, TITLE_MAX - 1).trimEnd() + "…" : clean;
}

function sessionFile(id) { return path.join(sessionsDir(), `${id}.json`); }

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/**
 * The history without its thinking blocks. They are only needed while the tool loop of the current
 * turn is running, so they never go to disk (they can be long, and they quote file contents and tool output) and are
 * dropped from files that hold them. A message that held nothing else disappears with them, and the repair pass folds the
 * neighbours back together so roles still alternate and every tool_use keeps its tool_result.
 */
export function withoutThinking(messages) {
  let dropped = false;
  const kept = [];
  for (const message of messages) {
    if (message?.role === "assistant" && Array.isArray(message.content) && message.content.some(b => b?.type === "thinking")) {
      dropped = true;
      const content = message.content.filter(b => b?.type !== "thinking");
      if (content.length) kept.push({ ...message, content });
    } else kept.push(message);
  }
  return dropped ? repairMessages(kept).messages : messages;
}

export class Session {
  constructor({ id, cwd, createdAt, updatedAt, title, messages, usage, mode, persist = true }) {
    this.id = id;
    this.cwd = cwd;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt || createdAt;
    this.title = title || "";
    this.messages = messages || [];
    this.usage = { inputTokens: 0, outputTokens: 0, turns: 0, ...(usage || {}) };
    this.mode = mode || "default";
    // Context size reported by the last request. Runtime only: it is stale after a reload.
    this.contextTokens = 0;
    // Files the tools have read in this run (Write refuses to overwrite what the model never saw). Not saved.
    this.fileState = new Map();
    this.persist = persist;
  }

  get file() { return sessionFile(this.id); }

  toJSON() {
    // The saved copy only; the messages in memory keep their thinking for the rest of the turn.
    const messages = withoutThinking(this.messages);
    return {
      version: FORMAT_VERSION,
      id: this.id,
      cwd: this.cwd,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      title: this.title,
      mode: this.mode,
      usage: this.usage,
      messageCount: messages.length,
      messages,
    };
  }

  /** Never throws: a full disk or a locked file must not kill a running turn. Returns false when nothing was written. */
  save() {
    if (!this.persist) return true;
    this.updatedAt = new Date().toISOString();
    const text = JSON.stringify(this);
    for (let attempt = 0; attempt < 3; attempt++) {
      try { writePrivate(this.file, text); return true; } catch {
        // Antivirus scanners and indexers briefly hold files open on Windows, which makes the rename fail.
        if (attempt < 2) sleepSync(25 * (attempt + 1));
      }
    }
    return false;
  }

  setTitle(text) { this.title = titleFrom(text); }

  /** Adds a user message. If the history already ends with a user message (an interrupted turn) the text is folded into it. */
  addUser(content) {
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : contentBlocks({ content });
    if (!this.title) {
      const firstText = blocks.find(b => b.type === "text" && b.text?.trim());
      if (firstText) this.title = titleFrom(firstText.text);
    }
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "user") {
      last.content = [...contentBlocks(last), ...blocks];
      return last;
    }
    const message = { role: "user", content: blocks };
    this.messages.push(message);
    return message;
  }

  /** Stores an assistant message after cleaning it. Returns null (and stores nothing) when no usable content is left. */
  addAssistant(message) {
    const content = sanitizeAssistantContent(contentBlocks(message));
    if (!content.length) return null;
    const stored = { role: "assistant", content };
    this.messages.push(stored);
    return stored;
  }

  /** results: [{ tool_use_id, content, is_error? }] in the order of the tool_use blocks. */
  addToolResults(results) {
    const blocks = results.map(r => (r.type === "tool_result" ? r : makeToolResult(r.tool_use_id, r.content, r.is_error)));
    const message = { role: "user", content: blocks };
    this.messages.push(message);
    return message;
  }

  addUsage({ inputTokens = 0, outputTokens = 0 } = {}) {
    this.usage.inputTokens += inputTokens;
    this.usage.outputTokens += outputTokens;
  }

  replaceMessages(messages) {
    this.messages = messages;
    this.contextTokens = 0;
  }

  checkpointDir() { return path.join(sessionsDir(), `${this.id}.checkpoints`); }

  /**
   * Writes a snapshot of the conversation (messages only; files are not copied) and keeps the newest 20.
   * Best effort: a full disk or a locked file returns null and never stops the turn.
   */
  checkpoint(label = "") {
    if (!this.persist) return null;
    const dir = this.checkpointDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      const at = new Date().toISOString();
      const file = path.join(dir, `${at.replace(/[:.]/g, "-")}.json`);
      writePrivate(file, JSON.stringify({ ...this.toJSON(), checkpoint: { label: String(label || "").slice(0, 80), at } }));
      const names = fs.readdirSync(dir).filter(name => name.endsWith(".json")).sort();
      for (const old of names.slice(0, Math.max(0, names.length - 20))) {
        try { fs.unlinkSync(path.join(dir, old)); } catch { /* keep going */ }
      }
      return file;
    } catch { return null; }
  }

  /** Newest first: { file, at, label, messageCount }. */
  listCheckpoints() {
    const dir = this.checkpointDir();
    let names;
    try { names = fs.readdirSync(dir).filter(name => name.endsWith(".json")); } catch { return []; }
    const out = [];
    for (const name of names) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        out.push({
          file: path.join(dir, name),
          at: data.checkpoint?.at || data.updatedAt || "",
          label: data.checkpoint?.label || "",
          messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
        });
      } catch { /* a corrupt checkpoint is skipped */ }
    }
    out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return out;
  }

  /** Replaces the conversation with a checkpoint's messages. Files are not reverted. */
  restoreCheckpoint(file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(data.messages)) return false;
      this.replaceMessages(repairMessages(withoutThinking(data.messages)).messages);
      this.save();
      return true;
    } catch { return false; }
  }

  /** Forgets the conversation but keeps the id and the file. */
  clear() {
    this.messages = [];
    this.title = "";
    this.usage = { inputTokens: 0, outputTokens: 0, turns: 0 };
    this.contextTokens = 0;
  }
}

export function createSession({ cwd = process.cwd(), mode = "default", persist = true } = {}) {
  const now = new Date();
  return new Session({ id: newId(now), cwd: path.resolve(cwd), createdAt: now.toISOString(), mode, persist });
}

function fromData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (typeof data.id !== "string" || !ID_PATTERN.test(data.id) || !Array.isArray(data.messages)) return null;
  const createdAt = typeof data.createdAt === "string" ? data.createdAt : new Date(0).toISOString();
  return new Session({
    id: data.id,
    cwd: typeof data.cwd === "string" ? data.cwd : process.cwd(),
    createdAt,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : createdAt,
    title: typeof data.title === "string" ? data.title : "",
    messages: repairMessages(withoutThinking(data.messages)).messages,
    usage: data.usage && typeof data.usage === "object" ? data.usage : undefined,
    mode: typeof data.mode === "string" ? data.mode : undefined,
  });
}

/** Returns the saved session or null when the id is unknown, malformed or the file is corrupt. */
export function loadSession(id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  try { return fromData(JSON.parse(fs.readFileSync(sessionFile(id), "utf8").replace(/^﻿/, ""))); } catch { return null; }
}

/** Reads just the header of a session file; falls back to a full parse for files written by other versions. */
function readHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
    const head = buf.toString("utf8", 0, n);
    const cut = head.indexOf(',"messages":');
    if (cut > 0) {
      const meta = JSON.parse(head.slice(0, cut) + "}");
      if (meta && typeof meta.id === "string") return meta;
    }
  } catch { /* fall through to the full parse */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    if (data && typeof data.id === "string" && Array.isArray(data.messages)) return { ...data, messageCount: data.messages.length, messages: undefined };
  } catch { /* corrupt */ }
  return null;
}

/** Newest first. Corrupt or foreign files are skipped. `cwd` keeps only sessions started in that folder. */
export function listSessions({ cwd, limit = 50 } = {}) {
  let names;
  try { names = fs.readdirSync(sessionsDir()); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const meta = readHeader(path.join(sessionsDir(), name));
    if (!meta || !ID_PATTERN.test(meta.id) || `${meta.id}.json` !== name) continue;
    if (!Number(meta.messageCount)) continue;
    if (cwd && !sameDir(meta.cwd, cwd)) continue;
    out.push({
      id: meta.id,
      cwd: meta.cwd,
      title: meta.title || "",
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt || meta.createdAt,
      messageCount: Number(meta.messageCount),
      turns: meta.usage?.turns ?? 0,
      usage: meta.usage || { inputTokens: 0, outputTokens: 0, turns: 0 },
    });
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out.slice(0, Math.max(0, limit));
}

/** The most recently updated session that was started in `cwd`, or null. */
export function latestSession(cwd) {
  for (const meta of listSessions({ cwd, limit: 5 })) {
    const session = loadSession(meta.id);
    if (session) return session;
  }
  return null;
}
