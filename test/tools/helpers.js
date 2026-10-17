// Shared helpers for the tools tests: temporary projects, a recording fake UI, small call wrappers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolbox } from "../../src/tools/index.js";
import { setLang } from "../../src/i18n/index.js";

setLang("en");

// Tests run shell commands such as `node -e ...`: make sure the Node that runs the tests is found by them.
const nodeDir = path.dirname(process.execPath);
if (!(process.env.PATH || "").split(path.delimiter).includes(nodeDir)) process.env.PATH = nodeDir + path.delimiter + (process.env.PATH || "");

export function tmpProject(files = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fc2 tools-")));
  const api = {
    dir,
    abs: rel => path.join(dir, rel),
    write(rel, content) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    },
    read: rel => fs.readFileSync(path.join(dir, rel), "utf8"),
    readBuf: rel => fs.readFileSync(path.join(dir, rel)),
    exists: rel => fs.existsSync(path.join(dir, rel)),
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ } },
  };
  for (const [rel, content] of Object.entries(files)) api.write(rel, content);
  return api;
}

/** A UI object that records every call and answers permission requests from a queue. */
export function fakeUi({ permission = [], question = { answer: "yes" }, plan = { decision: "approve" } } = {}) {
  const calls = [];
  const answers = [...permission];
  const record = name => (...args) => { calls.push({ name, args }); };
  const ui = {
    calls,
    asked: [],
    todos: record("todos"),
    notice: record("notice"),
    async askPermission(req) {
      calls.push({ name: "askPermission", args: [req] });
      ui.asked.push(req);
      const next = answers.length ? answers.shift() : { decision: "deny" };
      return typeof next === "function" ? next(req) : next;
    },
    async askQuestion(q) { calls.push({ name: "askQuestion", args: [q] }); return typeof question === "function" ? question(q) : question; },
    async showPlan(p) { calls.push({ name: "showPlan", args: [p] }); return typeof plan === "function" ? plan(p) : plan; },
  };
  return ui;
}

export function setup(files = {}, options = {}) {
  const project = tmpProject(files);
  const ui = options.ui || fakeUi();
  const toolbox = createToolbox({ cwd: project.dir, ui, client: options.client, config: {}, session: options.session || {}, ...options.toolbox });
  const ctx = toolbox.context({ cwd: project.dir, ...options.ctx });
  const call = async (name, input, extra = {}) => {
    const tool = toolbox.byName.get(name);
    const c = Object.keys(extra).length ? { ...ctx, ...extra } : ctx;
    const problem = tool.validate?.(input, c);
    if (problem) return { ok: false, content: `VALIDATION: ${problem}`, validation: problem };
    return tool.run(input, c);
  };
  return { ...project, ui, toolbox, ctx, call };
}
