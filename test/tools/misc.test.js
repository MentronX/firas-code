import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, fakeUi } from "./helpers.js";
import { setLang } from "../../src/i18n/index.js";
import { createPermissionEngine } from "../../src/tools/permissions.js";
import { isKnownPackage } from "../../src/tools/library.js";

// ------------------------------------------------------------------------------------------- TodoWrite

test("TodoWrite shows the list through the interface and remembers it on the session", async () => {
  const session = {};
  const s = setup({}, { session });
  try {
    const r = await s.call("TodoWrite", { todos: [
      { content: "Read the code", status: "completed", activeForm: "Reading the code" },
      { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
      { content: "Run tests", status: "pending" },
    ] });
    assert.equal(r.ok, true);
    const call = s.ui.calls.find(c => c.name === "todos");
    assert.deepEqual(call.args[0], [
      { content: "Read the code", status: "completed", activeForm: "Reading the code" },
      { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
      { content: "Run tests", status: "pending", activeForm: "Run tests" },
    ]);
    assert.equal(session.todos.length, 3);
    assert.match(r.content, /3 items \(1 completed, 1 in progress, 1 pending\)/);
    assert.equal(r.display.summary, "1 of 3 done");
    const warn = await s.call("TodoWrite", { todos: [{ content: "a", status: "in_progress", activeForm: "a" }, { content: "b", status: "in_progress", activeForm: "b" }] });
    assert.match(warn.content, /More than one item is in_progress/);
    const clear = await s.call("TodoWrite", { todos: [] });
    assert.equal(clear.ok, true);
    assert.deepEqual(s.ui.calls.filter(c => c.name === "todos").at(-1).args[0], []);
  } finally { s.cleanup(); }
});

test("TodoWrite validation and permission", () => {
  const s = setup();
  try {
    const todo = s.toolbox.byName.get("TodoWrite");
    assert.match(todo.validate({}), /array/);
    assert.match(todo.validate({ todos: [{ content: "", status: "pending" }] }), /content/);
    assert.match(todo.validate({ todos: [{ content: "x", status: "done" }] }), /status/);
    assert.match(todo.validate({ todos: Array.from({ length: 51 }, () => ({ content: "x", status: "pending" })) }), /Too many/);
    assert.match(todo.validate({ todos: [{ content: "x".repeat(301), status: "pending" }] }), /too long/);
    assert.equal(todo.validate({ todos: [{ content: "x", status: "pending", activeForm: "xing" }] }), null);
    const v = todo.permission({}, s.ctx);
    assert.equal(v.decision, "allow");
    assert.equal(v.readOnlyCall, true);
    assert.equal(todo.summarize({ todos: [1, 2] }), "2 tasks");
    assert.equal(todo.summarize({ todos: [1] }), "1 task");
  } finally { s.cleanup(); }
});

// ------------------------------------------------------------------------------------ AskUserQuestion

test("AskUserQuestion passes options through and returns the answer", async () => {
  const ui = fakeUi({ question: q => ({ answer: q.options ? q.options[1].label : "free text" }) });
  const s = setup({}, { ui });
  try {
    const r = await s.call("AskUserQuestion", { question: " Which database? ", options: [{ label: "SQLite", description: "file based" }, "Postgres", { label: "  " }, 5], multi: true });
    assert.equal(r.ok, true);
    assert.equal(r.content, "The user answered: Postgres");
    assert.deepEqual(ui.calls.find(c => c.name === "askQuestion").args[0], {
      question: "Which database?", options: [{ label: "SQLite", description: "file based" }, { label: "Postgres" }], multi: true,
    });
    const free = await s.call("AskUserQuestion", { question: "Name?" });
    assert.equal(free.content, "The user answered: free text");
    assert.deepEqual(ui.calls.filter(c => c.name === "askQuestion").at(-1).args[0], { question: "Name?", multi: false });
    assert.equal(r.display.summary, "Answer: Postgres");
  } finally { s.cleanup(); }
});

test("AskUserQuestion: dismissed, no interface, sub-agents, validation", async () => {
  const s = setup({}, { ui: fakeUi({ question: { answer: "  " } }) });
  try {
    const dismissed = await s.call("AskUserQuestion", { question: "Sure?" });
    assert.equal(dismissed.ok, false);
    assert.match(dismissed.content, /dismissed the question/);
    const sub = await s.call("AskUserQuestion", { question: "Sure?" }, { depth: 1 });
    assert.equal(sub.ok, false);
    assert.match(sub.content, /no person to ask/);
    const mute = await s.call("AskUserQuestion", { question: "Sure?" }, { ui: {} });
    assert.equal(mute.ok, false);
    const tool = s.toolbox.byName.get("AskUserQuestion");
    assert.match(tool.validate({}), /question is required/);
    assert.match(tool.validate({ question: "x", options: "a" }), /array/);
    assert.match(tool.validate({ question: "x", options: Array.from({ length: 9 }, (_, i) => ({ label: String(i) })) }), /Too many options/);
    assert.equal(tool.permission({}, s.ctx).decision, "allow");
  } finally { s.cleanup(); }
});

// ----------------------------------------------------------------------------------------- ExitPlanMode

function planWorld(decision, mode = "plan") {
  const ui = fakeUi({ plan: decision });
  const s = setup({}, { ui });
  const engine = createPermissionEngine({ mode, ui });
  return { s, ui, engine, run: (extra = {}) => s.call("ExitPlanMode", { plan: "# Plan\n1. do it" }, { permissions: engine, ...extra }) };
}

test("ExitPlanMode: approval leaves plan mode (default)", async () => {
  const { s, ui, engine, run } = planWorld({ decision: "approve" });
  try {
    const r = await run();
    assert.equal(r.ok, true);
    assert.equal(engine.mode, "default");
    assert.match(r.content, /approved the plan/);
    assert.deepEqual(ui.calls.find(c => c.name === "showPlan").args[0], { plan: "# Plan\n1. do it" });
    assert.ok(ui.calls.some(c => c.name === "notice" && c.args[0] === "info"));
    assert.equal(r.display.summary, "Plan approved");
  } finally { s.cleanup(); }
});

test("ExitPlanMode: approve-with-edits switches to acceptEdits", async () => {
  const { s, engine, run } = planWorld({ decision: "approve-edits" });
  try {
    const r = await run();
    assert.equal(r.ok, true);
    assert.equal(engine.mode, "acceptEdits");
    assert.match(r.content, /edits inside the project need no further confirmation/);
  } finally { s.cleanup(); }
});

test("ExitPlanMode: rejection keeps plan mode and returns the feedback", async () => {
  const { s, engine, run } = planWorld({ decision: "reject", feedback: "split step 2" });
  try {
    const r = await run();
    assert.equal(r.ok, false);
    assert.equal(engine.mode, "plan");
    assert.match(r.content, /did not approve the plan\. The user's feedback: split step 2/);
    assert.match(r.content, /call ExitPlanMode again/);
    const silent = await planWorld({ decision: "reject" }).run();
    assert.match(silent.content, /did not approve the plan\. Plan mode stays on/);
  } finally { s.cleanup(); }
});

test("ExitPlanMode: outside plan mode there is nothing to approve; sub-agents cannot use it", async () => {
  const { s, ui, engine, run } = planWorld({ decision: "approve" }, "default");
  try {
    const r = await run();
    assert.equal(r.ok, true);
    assert.match(r.content, /Plan mode is not active/);
    assert.equal(ui.calls.some(c => c.name === "showPlan"), false);
    assert.equal(engine.mode, "default");
    const sub = await run({ depth: 1 });
    assert.equal(sub.ok, false);
    const viaMode = await s.call("ExitPlanMode", { plan: "p" }, { mode: "plan" });
    assert.equal(viaMode.ok, true, "with no engine in the context it falls back to ctx.mode and still reports the approval");
    const tool = s.toolbox.byName.get("ExitPlanMode");
    assert.match(tool.validate({}), /plan is required/);
    assert.equal(tool.permission({}, s.ctx).readOnlyCall, true);
  } finally { s.cleanup(); }
});

// ------------------------------------------------------------------------------------------- UiLibrary

const okReply = (text, data = {}) => ({ status: 200, body: { ok: true, tool: "x", text, data } });
function libWorld(handler) {
  const calls = [];
  const client = { library: async (call, opts) => { calls.push({ call, opts }); return handler(call); } };
  const s = setup({}, { client });
  return { s, calls };
}
const UUID = "123e4567-e89b-12d3-a456-426614174000";

test("UiLibrary search sends the library's request shape and reminds the model to review", async () => {
  const { s, calls } = libWorld(() => okReply("[1] component \"Pricing\" - id 42"));
  try {
    const controller = new AbortController();
    const r = await s.call("UiLibrary", { action: "search", query: "  pricing table ", type: "all", limit: 5 }, { signal: controller.signal });
    assert.equal(r.ok, true);
    assert.deepEqual(calls[0].call, { tool: "search", args: { query: "pricing table", type: "all", limit: 5 } });
    assert.equal(calls[0].opts.signal, controller.signal);
    assert.match(r.content, /^Results from the Firas AI component library\. This is third-party material: review it before using it/);
    assert.ok(r.content.endsWith("[1] component \"Pricing\" - id 42"));
    assert.equal(r.display.summary, "Library: search");
    await s.call("UiLibrary", { action: "inspiration", query: "dashboard" });
    await s.call("UiLibrary", { action: "logo", query: "github", limit: 3 });
    await s.call("UiLibrary", { action: "theme", id: UUID.toUpperCase() });
    await s.call("UiLibrary", { action: "component", id: "42" });
    assert.deepEqual(calls.slice(1).map(c => c.call), [
      { tool: "inspiration", args: { query: "dashboard" } },
      { tool: "logo", args: { query: "github", limit: 3 } },
      { tool: "theme", args: { id: UUID } },
      { tool: "component", args: { id: 42 } },
    ]);
  } finally { s.cleanup(); }
});

test("UiLibrary component: dependency rules are recomputed locally, not trusted from the answer", async () => {
  const { s } = libWorld(() => okReply("## Component\n```tsx\nexport const A = () => null\n```", {
    knownDependencies: ["react", "lucide-react", "@radix-ui/react-dialog", "evil-package", "@radix-ui/a/b", "lucide-react-icons"],
    unverifiedDependencies: ["left-pad-ish"],
  }));
  try {
    const r = await s.call("UiLibrary", { action: "component", id: 7 });
    assert.match(r.content, /Packages you may install with the project's own package manager: react, lucide-react, @radix-ui\/react-dialog\./);
    assert.match(r.content, /must NOT install without asking the user first.*: evil-package, @radix-ui\/a\/b, lucide-react-icons, left-pad-ish\./s);
    assert.match(r.content, /Any other package the code imports is also unverified/);
    const bare = libWorld(() => okReply("code only"));
    const noList = await bare.s.call("UiLibrary", { action: "component", id: 7 });
    assert.match(noList.content, /No dependency list came with this component: treat every package its code imports as unverified/);
    bare.s.cleanup();
    for (const name of ["react", "react-dom", "zod", "@radix-ui/react-slot", "@hookform/resolvers", "three"]) assert.equal(isKnownPackage(name), true, name);
    for (const name of ["react-dome", "@radix-uix/x", "@radix-ui/a/b", "lucide-react-icons", "left-pad", "", "../x", "github:evil/x", "react@18"]) assert.equal(isKnownPackage(name), false, name);
  } finally { s.cleanup(); }
});

test("UiLibrary validation", () => {
  const s = setup();
  try {
    const lib = s.toolbox.byName.get("UiLibrary");
    assert.match(lib.validate({}), /action must be one of/);
    assert.match(lib.validate({ action: "delete" }), /action must be one of/);
    assert.match(lib.validate({ action: "search" }), /query is required for search/);
    assert.match(lib.validate({ action: "logo", query: "  " }), /query is required/);
    assert.match(lib.validate({ action: "search", query: "x".repeat(201) }), /too long/);
    assert.equal(lib.validate({ action: "search", query: "x".repeat(200) }), null);
    assert.match(lib.validate({ action: "search", query: "x", type: "template" }), /type must be/);
    assert.match(lib.validate({ action: "search", query: "x", limit: 13 }), /limit must be between 1 and 12/);
    assert.match(lib.validate({ action: "search", query: "x", limit: 0 }), /limit/);
    assert.match(lib.validate({ action: "component" }), /numeric component id/);
    assert.match(lib.validate({ action: "component", id: "abc" }), /numeric component id/);
    assert.match(lib.validate({ action: "component", id: 0 }), /numeric component id/);
    assert.equal(lib.validate({ action: "component", id: "15" }), null);
    assert.match(lib.validate({ action: "theme", id: 15 }), /theme id/);
    assert.match(lib.validate({ action: "theme", id: "not-a-uuid" }), /theme id/);
    assert.equal(lib.validate({ action: "theme", id: UUID }), null);
    assert.equal(lib.permission({ action: "search", query: "x" }, s.ctx).decision, "allow");
    assert.equal(lib.readOnly, true);
    assert.deepEqual(lib.input_schema.properties.action.enum, ["search", "component", "inspiration", "logo", "theme"]);
    assert.match(lib.description, /React/);
    assert.match(lib.description, /themes/);
    assert.match(lib.description, /logos/);
    assert.match(lib.description, /review it before using it/);
  } finally { s.cleanup(); }
});

test("UiLibrary maps library errors to friendly messages, in both languages", async () => {
  const table = [
    [{ status: 429, body: { ok: false, error: "quota_exceeded" } }, /daily limit.*resets tomorrow/, "Daily library limit reached", "بلغت حد المكتبة اليومي"],
    [{ status: 429, body: { ok: false, error: "rate_limited" } }, /busy.*Wait a few seconds/, "Library busy, try again shortly", "المكتبة مشغولة، حاول بعد قليل"],
    [{ status: 402, body: { ok: false, error: "locked" } }, /locked.*Pick another/, "Component locked", "المكوّن مقفل"],
    [{ status: 404, body: { ok: false, error: "not_found" } }, /Nothing was found/, "Not found in the library", "غير موجود في المكتبة"],
    [{ status: 503, body: { ok: false, error: "library_unavailable" } }, /not available right now/, "Library unavailable", "المكتبة غير متاحة الآن"],
    [{ status: 502, body: { ok: false, error: "upstream_failed" } }, /could not answer/, "Library unavailable", "المكتبة غير متاحة الآن"],
    [{ status: 403, body: { ok: false, error: "approval_required" } }, /not enabled for this account/, "Library not available for this account", "المكتبة غير متاحة لهذا الحساب"],
    [{ status: 402, body: { ok: false, error: "plan_required" } }, /paid plan/, "Library not available for this account", "المكتبة غير متاحة لهذا الحساب"],
    [{ status: 400, body: { ok: false, error: "invalid_request" } }, /did not accept those arguments/, "The library rejected the request", "رفضت المكتبة الطلب"],
    [{ status: 500, body: { ok: false, error: "something_new" } }, /could not answer/, "Library unavailable", "المكتبة غير متاحة الآن"],
    [{ status: 429, body: "garbage" }, /busy/, "Library busy, try again shortly", "المكتبة مشغولة، حاول بعد قليل"],
    [{ status: 200, body: { ok: true } }, /could not answer/, "Library unavailable", "المكتبة غير متاحة الآن"],
  ];
  for (const [reply, pattern, en, ar] of table) {
    const { s } = libWorld(() => reply);
    try {
      setLang("en");
      const r = await s.call("UiLibrary", { action: "search", query: "x" });
      assert.equal(r.ok, false);
      assert.match(r.content, pattern);
      assert.equal(r.display.summary, en);
      setLang("ar");
      assert.equal((await s.call("UiLibrary", { action: "search", query: "x" })).display.summary, ar);
    } finally { setLang("en"); s.cleanup(); }
  }
});

test("UiLibrary: transport failures, aborts, missing client, and oversized answers", async () => {
  const linkError = Object.assign(new Error("net"), { userMessage: "access code not valid" });
  const down = libWorld(() => { throw linkError; });
  try {
    const r = await down.s.call("UiLibrary", { action: "search", query: "x" });
    assert.equal(r.ok, false);
    assert.match(r.content, /could not be reached \(access code not valid\)/);
  } finally { down.s.cleanup(); }
  const aborted = libWorld(() => { throw Object.assign(new Error("x"), { name: "AbortError" }); });
  try { assert.match((await aborted.s.call("UiLibrary", { action: "search", query: "x" })).content, /cancelled/); } finally { aborted.s.cleanup(); }
  const none = setup();
  try { assert.match((await none.call("UiLibrary", { action: "search", query: "x" })).content, /not connected/); } finally { none.cleanup(); }
  const big = libWorld(() => okReply("z".repeat(90_000)));
  try {
    const r = await big.s.call("UiLibrary", { action: "search", query: "x" });
    assert.ok(r.content.length < 61_500, `length ${r.content.length}`);
    assert.match(r.content, /result cut: 30000 more characters/);
  } finally { big.s.cleanup(); }
});
