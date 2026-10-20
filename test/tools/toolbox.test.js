import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createToolbox, READ_ONLY_TOOL_NAMES, shellInfo } from "../../src/tools/index.js";
import { t, setLang } from "../../src/i18n/index.js";
import { setup } from "./helpers.js";
import { banned, skipNoList } from "../helpers/banned.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const NAMES = ["Read", "Write", "Edit", "MultiEdit", "Bash", "BashOutput", "KillShell", "Glob", "Grep", "LS", "WebFetch", "TodoWrite", "AskUserQuestion", "ExitPlanMode", "UiLibrary", "Skill"];

test("the toolbox has every tool, in order, with its documented name", () => {
  const tb = createToolbox({ cwd: process.cwd() });
  assert.deepEqual(tb.tools.map(x => x.name), NAMES);
  for (const name of NAMES) assert.equal(tb.has(name), true);
  assert.equal(tb.has("Agent"), false);
  assert.equal(tb.byName.get("Read"), tb.tools[0]);
});

test("every tool follows the tool contract", () => {
  const tb = createToolbox({ cwd: process.cwd() });
  for (const tool of tb.tools) {
    assert.equal(typeof tool.description, "string", tool.name);
    assert.ok(tool.description.length > 120 && tool.description.length < 2500, `${tool.name} description length ${tool.description.length}`);
    assert.equal(tool.input_schema.type, "object", tool.name);
    assert.ok(tool.input_schema.properties && typeof tool.input_schema.properties === "object");
    assert.equal(tool.input_schema.additionalProperties, false, `${tool.name} is strict`);
    for (const key of tool.input_schema.required || []) assert.ok(key in tool.input_schema.properties, `${tool.name}.${key} is required but undefined`);
    for (const [prop, def] of Object.entries(tool.input_schema.properties)) {
      assert.ok(def.type, `${tool.name}.${prop} has a type`);
      assert.equal(typeof def.description, "string", `${tool.name}.${prop} is described`);
    }
    assert.equal(typeof tool.readOnly, "boolean", tool.name);
    assert.equal(typeof tool.concurrencySafe, "boolean", tool.name);
    for (const fn of ["summarize", "permission", "run"]) assert.equal(typeof tool[fn], "function", `${tool.name}.${fn}`);
    if (tool.validate) assert.equal(typeof tool.validate, "function");
    if (tool.concurrencySafe) assert.equal(tool.readOnly, true, `${tool.name}: only read-only tools may run in parallel`);
  }
});

test("each description says when NOT to use the tool", () => {
  const tb = createToolbox({ cwd: process.cwd() });
  for (const tool of tb.tools) assert.match(tool.description, /\b(Do not|Don't|do not|Never|never|only in plan mode)\b/, tool.name);
});

test("definitions() are exactly { name, description, input_schema }", () => {
  const tb = createToolbox({ cwd: process.cwd() });
  const all = tb.definitions();
  assert.equal(all.length, NAMES.length);
  for (const def of all) assert.deepEqual(Object.keys(def).sort(), ["description", "input_schema", "name"]);
  assert.deepEqual(all.map(d => d.name), NAMES);
  assert.doesNotThrow(() => JSON.stringify(all));
  assert.deepEqual(tb.definitions(["Read", "Glob"]).map(d => d.name), ["Read", "Glob"]);
  assert.deepEqual(tb.definitions(tool => tool.name.startsWith("Bash")).map(d => d.name), ["BashOutput"].length ? ["Bash", "BashOutput"] : []);
  assert.deepEqual(tb.definitions({ readOnly: true }).map(d => d.name), READ_ONLY_TOOL_NAMES.slice().sort((a, b) => NAMES.indexOf(a) - NAMES.indexOf(b)));
  assert.deepEqual(tb.definitions({ exclude: ["Bash", "Write"] }).map(d => d.name).includes("Bash"), false);
  all[0].name = "tampered";
  assert.equal(tb.definitions()[0].name, "Read", "callers cannot corrupt the toolbox");
});

test("READ_ONLY_TOOL_NAMES lists exactly the tools flagged read-only", () => {
  const tb = createToolbox({ cwd: process.cwd() });
  assert.deepEqual(tb.tools.filter(x => x.readOnly).map(x => x.name).sort(), [...READ_ONLY_TOOL_NAMES].sort());
  for (const name of ["Write", "Edit", "MultiEdit", "Bash", "KillShell", "TodoWrite", "AskUserQuestion", "ExitPlanMode"]) assert.equal(tb.byName.get(name).readOnly, false, name);
});

test("extra tools are appended, and bad or duplicate ones are rejected", () => {
  const agent = { name: "Agent", description: "x".repeat(130), input_schema: { type: "object", properties: {} }, readOnly: false, concurrencySafe: false, summarize: () => "", permission: () => ({ decision: "allow" }), run: async () => ({ ok: true, content: "" }) };
  const tb = createToolbox({ cwd: process.cwd(), extraTools: [agent] });
  assert.equal(tb.tools.at(-1), agent);
  assert.equal(tb.has("Agent"), true);
  assert.equal(tb.definitions().at(-1).name, "Agent");
  assert.throws(() => createToolbox({ extraTools: [{ ...agent, name: "Read" }] }), /Two tools are named Read/);
  assert.throws(() => createToolbox({ extraTools: [{ name: "Broken" }] }), /Broken is missing/);
});

test("context() fills in everything a tool needs", () => {
  const ui = {}, client = {}, config = {}, session = {};
  const tb = createToolbox({ cwd: "/work", ui, client, config, session, mode: "plan" });
  const ctx = tb.context({ depth: 1 });
  assert.equal(ctx.cwd, "/work");
  assert.equal(ctx.depth, 1);
  assert.equal(ctx.mode, "plan");
  assert.equal(ctx.ui, ui);
  assert.equal(ctx.client, client);
  assert.equal(ctx.fileState, tb.fileState);
  assert.equal(typeof ctx.progress, "function");
  assert.equal(ctx.platform, process.platform);
  assert.equal(tb.context().fileState, ctx.fileState, "one read-state per toolbox");
});

test("the resolved shell is exported and named in the Bash description", () => {
  assert.ok(shellInfo.name && shellInfo.path && shellInfo.syntax);
  const tb = createToolbox({ cwd: process.cwd() });
  assert.equal(tb.shell, shellInfo);
  assert.ok(tb.byName.get("Bash").description.includes(`Shell: ${shellInfo.name}.`));
});

test("tools do not throw on junk input", async () => {
  const s = setup({ "a.txt": "x" });
  try {
    for (const tool of s.toolbox.tools) {
      for (const input of [{}, { path: 5, command: 5, pattern: 5, url: 5, edits: 5, todos: 5, question: 5, plan: 5, action: 5, job_id: 5 }]) {
        assert.doesNotThrow(() => tool.summarize(input, s.ctx), `${tool.name}.summarize`);
        assert.doesNotThrow(() => tool.validate?.(input, s.ctx), `${tool.name}.validate`);
        assert.doesNotThrow(() => tool.permission(input, s.ctx), `${tool.name}.permission`);
      }
    }
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------- language and vocabulary

const listFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test("every string key used by the tools exists in Arabic and English", () => {
  const files = listFiles(path.join(root, "src", "tools")).filter(f => f.endsWith(".js"));
  const keys = new Set();
  const codes = new Set();
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/\bt[n]?\(\s*["'`](tools\.[\w.]+)["'`]/g)) keys.add(m[1]);
    for (const m of text.matchAll(/\bfail\(\s*"(\w+)"/g)) codes.add(m[1]);
    for (const m of text.matchAll(/err\("(\w+)"/g)) codes.add(m[1]);
    for (const m of text.matchAll(/\["(?:quota|busy|locked|notFound|unavailable|invalid|denied)"/g)) void m;
  }
  for (const code of ["notRead", "stale", "emptyOld", "sameString", "noMatch", "multiMatch", "unread", "editFailed"]) codes.add(code);
  for (const code of codes) keys.add(`tools.err.${code}`);
  for (const kind of ["quota", "busy", "locked", "notFound", "unavailable", "invalid", "denied"]) keys.add(`tools.lib.${kind}`);
  for (const status of ["running", "exited", "killed", "failed"]) keys.add(`tools.job.${status}`);
  for (const r of ["elevated", "recursiveDelete", "diskTool", "shutdown", "downloadExec", "registry", "forcePush", "remoteDelete", "hiddenChars", "longCommand", "hardReset", "gitClean", "discardChanges", "rewriteHistory", "systemWrite", "systemChange", "permissions", "secret", "forkBomb", "pipeToShell", "gitConfigOverride", "envOverride", "nested", "outsideRead", "unparsed"]) keys.add(`tools.risk.${r}`);
  for (const key of ["tools.plan.switchedDefault", "tools.plan.switchedEdits"]) keys.add(key);
  assert.ok(keys.size > 100, `found ${keys.size} keys`);
  const missing = [];
  try {
    for (const lang of ["en", "ar"]) {
      setLang(lang);
      for (const key of keys) {
        const params = { n: 2, name: "x", file: "f", dir: "d", cmd: "c", host: "h", kind: "k", secs: "1", code: "1", signal: "s", id: "bg1", done: 1, from: 1, to: 2, i: 1, status: 200, type: "x", action: "a", answer: "a", pattern: "p", files: 1, chars: 1200, lines: 14 };
        const text = t(key, params);
        if (text === key || /\{\w+\}/.test(text)) missing.push(`${lang}:${key}`);
        if (lang === "ar" && !/[؀-ۿ]/.test(text)) missing.push(`ar-not-arabic:${key}`);
      }
    }
  } finally { setLang("en"); }
  assert.deepEqual(missing, []);
  for (const key of keys) if (/^tools\.(read\.lines|write\.created|glob\.found|grep\.files|grep\.matches|ls\.items|todo\.count|fetch\.done|cmd\.moreLines)$/.test(key)) {
    setLang("en");
    assert.notEqual(t(`${key}.one`), `${key}.one`, `${key}.one exists`);
  }
  setLang("en");
});

test("singular and plural wording", () => {
  setLang("en");
  const s = setup({ "a.txt": "one\n" });
  return s.call("Read", { path: "a.txt" }).then(r => {
    assert.equal(r.display.summary, "1 line");
    s.cleanup();
  });
});

test("Arabic summaries appear when the language is Arabic", async () => {
  const s = setup({ "ملف.txt": "نص\n" });
  try {
    setLang("ar");
    const r = await s.call("Read", { path: "ملف.txt" });
    assert.match(r.display.summary, /^الأسطر: 1$/);
    const missing = await s.call("Read", { path: "غائب.txt" });
    assert.match(missing.display.summary, /^غير موجود: /);
    const perm = s.toolbox.byName.get("Edit").permission({ path: "ملف.txt", old_string: "x", new_string: "y" }, s.ctx);
    assert.ok(perm.title.length > 0);
  } finally { setLang("en"); s.cleanup(); }
});

test("none of the listed words appears in the tools, their tests or what they show", { skip: skipNoList }, () => {
  const shouted = new RegExp(`\\b${banned.avoided.toUpperCase()}\\b`);
  const files = [...listFiles(path.join(root, "src", "tools")), ...listFiles(path.join(root, "test", "tools"))].filter(f => f.endsWith(".js"));
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const lower = text.toLowerCase();
    for (const word of banned.all) if (lower.includes(word)) hits.push(`${path.relative(root, file)}: ${word}`);
    if (shouted.test(text)) hits.push(`${path.relative(root, file)}: the listed technical word`);
  }
  assert.deepEqual(hits, []);
  const tb = createToolbox({ cwd: process.cwd() });
  const shown = JSON.stringify(tb.definitions()).toLowerCase();
  for (const word of banned.all) assert.ok(!shown.includes(word), word);
});

test("no hard-coded escape codes, debug output or TODOs in the tools", () => {
  const files = listFiles(path.join(root, "src", "tools")).filter(f => f.endsWith(".js"));
  const hits = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const where = `${path.basename(file)}:${i + 1}`;
      if (/console\.(log|error|warn|debug)/.test(line)) hits.push(`${where} console`);
      if (/\b(TODO|FIXME|XXX)\b/.test(line)) hits.push(`${where} todo`);
    });
  }
  assert.deepEqual(hits, []);
});
