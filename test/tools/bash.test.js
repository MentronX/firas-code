import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setup } from "./helpers.js";
import { fileURLToPath } from "node:url";
import { t, setLang } from "../../src/i18n/index.js";
import { createBashTool, commandEnv, reasonLines } from "../../src/tools/bash.js";
import { createJobs } from "../../src/tools/jobs.js";
import { resolveShell, processAlive } from "../../src/tools/shell.js";
import { createToolbox } from "../../src/tools/index.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = code => `node -e "${code}"`; // double quotes work in bash, PowerShell and cmd; keep code free of ", $ and %

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(40);
  }
}

test("a command's output, exit code and card summary", async () => {
  const s = setup();
  try {
    const r = await s.call("Bash", { command: js("console.log('hello'); console.log(6*7)") });
    assert.equal(r.ok, true);
    assert.equal(r.content, "hello\n42\n[exit code: 0]");
    assert.match(r.display.summary, /^Done in \d+\.\ds$/);
    assert.equal(r.display.body, "hello\n42");
    const quiet = await s.call("Bash", { command: js("0") });
    assert.equal(quiet.content, "(no output)\n[exit code: 0]");
  } finally { s.cleanup(); }
});

test("a failing command is reported with its exit code", async () => {
  const s = setup();
  try {
    const r = await s.call("Bash", { command: js("console.error('boom'); process.exit(3)") });
    assert.equal(r.ok, false);
    assert.match(r.content, /boom/);
    assert.match(r.content, /\[exit code: 3\]/);
    assert.match(r.display.summary, /Exit code 3/);
  } finally { s.cleanup(); }
});

test("stdout and stderr are interleaved in arrival order", async () => {
  const s = setup();
  try {
    const r = await s.call("Bash", { command: js("process.stdout.write('one\\n'); setTimeout(()=>{process.stderr.write('two\\n'); setTimeout(()=>console.log('three'),80)},80)") });
    assert.match(r.content, /one\ntwo\nthree/);
  } finally { s.cleanup(); }
});

test("the command runs in the project folder and the shell is told in the description", async () => {
  const s = setup({ "src/x.txt": "x" });
  try {
    const r = await s.call("Bash", { command: js("console.log(process.cwd())") });
    assert.equal(fs.realpathSync(r.content.split("\n")[0].trim()).toLowerCase(), fs.realpathSync(s.dir).toLowerCase());
    const bash = s.toolbox.byName.get("Bash");
    assert.ok(bash.description.includes(bash.shell.name));
    assert.ok(bash.description.includes("30000"));
    assert.ok(bash.description.includes("120000") && bash.description.includes("600000"));
    assert.ok(bash.description.includes("run_in_background"));
    assert.match(bash.description, /Do not use it to read files/);
  } finally { s.cleanup(); }
});

test("cd inside a command works", async () => {
  const s = setup({ "src/x.txt": "x" });
  try {
    const kind = s.toolbox.shell.kind;
    const chain = kind === "cmd" ? "&" : ";";
    const r = await s.call("Bash", { command: `cd src ${chain} ${js("console.log(require('path').basename(process.cwd()))")}` });
    assert.match(r.content, /^src\b/);
  } finally { s.cleanup(); }
});

test("Arabic output survives", async () => {
  const s = setup();
  try {
    const r = await s.call("Bash", { command: js("console.log('مرحبا بالعالم')") });
    assert.ok(r.content.startsWith("مرحبا بالعالم"), r.content);
  } finally { s.cleanup(); }
});

test("colour codes are stripped and the environment is quiet", async () => {
  const s = setup(undefined, { ctx: { env: { ...process.env, FIRAS_CODE: "FC2-SECRET-XXXXX", MY_VAR: "kept", FORCE_COLOR: "3" } } });
  try {
    const r = await s.call("Bash", { command: js("console.log('\\x1b[31mred\\x1b[0m', process.env.NO_COLOR, process.env.FORCE_COLOR, process.env.TERM, process.env.MY_VAR, process.env.FIRAS_CODE)") });
    assert.match(r.content, /^red 1 0 dumb kept undefined/);
    const env = commandEnv({ A: "1", FIRAS_CODE: "x" });
    assert.equal(env.A, "1");
    assert.equal("FIRAS_CODE" in env, false);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  } finally { s.cleanup(); }
});

test("stdin is closed, so a program waiting for input finishes instead of hanging", async () => {
  const s = setup();
  try {
    const started = Date.now();
    const r = await s.call("Bash", { command: js("process.stdin.on('data',()=>{}); process.stdin.on('end',()=>console.log('EOF')); process.stdin.resume()") });
    assert.match(r.content, /EOF/);
    assert.ok(Date.now() - started < 10_000);
  } finally { s.cleanup(); }
});

test("long output keeps its start and its end within 30000 characters", async () => {
  const s = setup();
  try {
    const r = await s.call("Bash", { command: js("for (let i=0;i<4000;i++) console.log('row '+String(i).padStart(5,'0')+' '+'x'.repeat(30))") });
    const body = r.content.replace(/\n\[exit code: 0\]$/, "");
    assert.ok(body.length <= 30_100, `length ${body.length}`);
    assert.ok(body.startsWith("row 00000"));
    assert.match(body, /characters omitted/);
    assert.ok(body.trimEnd().endsWith("row 03999 " + "x".repeat(30)));
  } finally { s.cleanup(); }
});

test("progress is streamed, throttled, with the latest lines", async () => {
  const s = setup();
  try {
    const seen = [];
    const r = await s.call("Bash", { command: js("let i=0; const t=setInterval(()=>{console.log('step '+(++i)); if(i===12){clearInterval(t)}},50)") }, { progress: text => seen.push(text) });
    assert.equal(r.ok, true);
    assert.ok(seen.length >= 1 && seen.length <= 8, `progress calls: ${seen.length}`);
    assert.ok(seen[seen.length - 1].includes("step"));
    assert.ok(seen.every(t => t.split("\n").length <= 5));
  } finally { s.cleanup(); }
});

test("a timeout stops the command and its child processes", async () => {
  const s = setup();
  try {
    const childPidFile = s.abs("child.pid");
    const code = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('fs').writeFileSync(process.argv[2],String(c.pid)); console.log('started'); setInterval(()=>{},1000)`;
    fs.writeFileSync(s.abs("spawner.js"), code);
    const started = Date.now();
    const r = await s.call("Bash", { command: `node spawner.js "${childPidFile.replace(/\\/g, "/")}"`, timeout: 1500 });
    assert.equal(r.ok, false);
    assert.match(r.content, /started/);
    assert.match(r.content, /Timed out after 2 s: the command and its child processes were stopped/);
    assert.ok(Date.now() - started < 9000);
    const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
    await waitFor(() => !processAlive(childPid), 5000);
    assert.equal(processAlive(childPid), false, "grandchild is dead");
  } finally { s.cleanup(); }
});

test("an abort signal kills the command and says it was interrupted", async () => {
  const s = setup();
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 600);
    const started = Date.now();
    const r = await s.call("Bash", { command: js("console.log('working'); setInterval(()=>{},1000)") }, { signal: controller.signal });
    assert.equal(r.ok, false);
    assert.match(r.content, /working/);
    assert.match(r.content, /Interrupted by the user/);
    assert.ok(Date.now() - started < 8000);
    const already = new AbortController();
    already.abort();
    const none = await s.call("Bash", { command: js("console.log('never')") }, { signal: already.signal });
    assert.doesNotMatch(none.content, /never/);
    assert.match(none.content, /Interrupted/);
  } finally { s.cleanup(); }
});

test("background jobs: start, read only new output, finish, stop", async () => {
  const s = setup();
  try {
    const started = Date.now();
    const r = await s.call("Bash", { command: js("console.log('tick1'); setTimeout(()=>console.log('tick2'),700); setTimeout(()=>{},1200)"), run_in_background: true });
    assert.equal(r.ok, true);
    assert.ok(Date.now() - started < 3000, "returns immediately");
    const id = /job (bg\d+)/.exec(r.content)[1];
    assert.equal(r.display.summary, `Started in the background (${id})`);

    const first = await waitFor(async () => { const o = await s.call("BashOutput", { job_id: id }); return o.content.includes("tick1") ? o : null; });
    assert.match(first.content, new RegExp(`^\\[job ${id}: running`));
    assert.ok(!first.content.includes("tick2"));
    const second = await waitFor(async () => { const o = await s.call("BashOutput", { job_id: id }); return o.content.includes("tick2") ? o : null; });
    assert.ok(!second.content.includes("tick1"), "only new output");
    const done = await waitFor(async () => { const o = await s.call("BashOutput", { job_id: id }); return /finished with exit code 0/.test(o.content) ? o : null; });
    assert.match(done.content, /\(no new output\)/);
    assert.equal(s.toolbox.jobs.get(id).status, "exited");

    const unknown = await s.call("BashOutput", { job_id: "bg99" });
    assert.equal(unknown.ok, false);
    assert.match(unknown.content, /No background job named "bg99"\. Known jobs: bg1/);
  } finally { await s.toolbox.dispose(); s.cleanup(); }
});

test("KillShell stops a background job and its child processes", async () => {
  const s = setup();
  try {
    fs.writeFileSync(s.abs("spawner.js"), `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('child '+c.pid); setInterval(()=>{},1000)`);
    const r = await s.call("Bash", { command: "node spawner.js", run_in_background: true });
    const id = /job (bg\d+)/.exec(r.content)[1];
    const out = await waitFor(async () => { const o = await s.call("BashOutput", { job_id: id }); return /child \d+/.test(o.content) ? o : null; });
    const childPid = Number(/child (\d+)/.exec(out.content)[1]);
    assert.ok(processAlive(childPid));
    const killed = await s.call("KillShell", { job_id: id });
    assert.equal(killed.ok, true);
    assert.match(killed.content, new RegExp(`\\[job ${id}: stopped\\]`));
    await waitFor(() => !processAlive(childPid), 5000);
    assert.equal(s.toolbox.jobs.get(id).status, "killed");
    assert.equal((await s.call("KillShell", { job_id: "nope" })).ok, false);
  } finally { await s.toolbox.dispose(); s.cleanup(); }
});

test("the number of running background jobs is limited", async () => {
  const jobs = createJobs({ maxRunning: 2 });
  const shell = resolveShell();
  const bash = createBashTool({ shell, jobs });
  const ctx = { cwd: process.cwd(), env: process.env };
  try {
    const long = { command: js("setInterval(()=>{},1000)"), run_in_background: true };
    assert.equal((await bash.run(long, ctx)).ok, true);
    assert.equal((await bash.run(long, ctx)).ok, true);
    const third = await bash.run(long, ctx);
    assert.equal(third.ok, false);
    assert.match(third.content, /Too many background jobs/);
    assert.equal(jobs.runningCount(), 2);
  } finally { await jobs.killAll(); }
  assert.equal(jobs.runningCount(), 0);
});

test("toolbox.dispose stops every background job", async () => {
  const s = setup();
  try {
    const r = await s.call("Bash", { command: js("console.log('up'); setInterval(()=>{},1000)"), run_in_background: true });
    const id = /job (bg\d+)/.exec(r.content)[1];
    const pid = s.toolbox.jobs.get(id).pid;
    await waitFor(() => processAlive(pid));
    await s.toolbox.dispose();
    await waitFor(() => !processAlive(pid), 5000);
    assert.equal(processAlive(pid), false);
  } finally { s.cleanup(); }
});

test("a shell that cannot start is reported clearly", async () => {
  const tool = createBashTool({ shell: { kind: "bash", name: "bash", path: path.join(process.cwd(), "no-such-shell-binary"), syntax: "x", label: "bash (missing)" }, jobs: createJobs() });
  const r = await tool.run({ command: "echo hi" }, { cwd: process.cwd(), env: process.env });
  assert.equal(r.ok, false);
  assert.match(r.content, /Could not start the shell \(bash \(missing\)\)/);
});

test("validation", () => {
  const bash = createBashTool({ shell: resolveShell(), jobs: createJobs() });
  assert.match(bash.validate({}), /command is required/);
  assert.match(bash.validate({ command: "   " }), /command is required/);
  assert.match(bash.validate({ command: "a\0b" }), /NUL/);
  assert.match(bash.validate({ command: "x".repeat(20_001) }), /too long.*at most 20000/);
  assert.equal(bash.validate({ command: "x".repeat(20_000) }), null, "everything the dialog is asked to show fits in it");
  const ps = createBashTool({ shell: { kind: "powershell", name: "Windows PowerShell", path: "powershell.exe", platform: "win32", syntax: "s", label: "l" }, jobs: createJobs() });
  assert.match(ps.validate({ command: "x".repeat(10_001) }), /at most 10000.*Write a script file/);
  assert.equal(ps.validate({ command: "x".repeat(10_000) }), null);
  const cmd = createBashTool({ shell: { kind: "cmd", name: "cmd", path: "cmd.exe", platform: "win32", syntax: "s", label: "l" }, jobs: createJobs() });
  assert.match(cmd.validate({ command: "x".repeat(8_001) }), /at most 8000/);
  assert.equal(commandEnv({}, { kind: "bash", platform: "win32" }).MSYS_NO_PATHCONV, "1");
  assert.equal(commandEnv({}, { kind: "bash", platform: "linux" }).MSYS_NO_PATHCONV, undefined);
  assert.match(bash.validate({ command: "ls", timeout: "soon" }), /timeout/);
  assert.equal(bash.validate({ command: "ls", timeout: 5000 }), null);
  assert.equal(bash.summarize({ command: "npm test -- --watch" }), "npm test -- --watch");
  assert.equal(bash.summarize({ command: "npm test -- --watch\nsecond line" }), "npm test -- --watch (+1 line)", "a second line is announced, not hidden");
  assert.equal(bash.summarize({ command: "ls\n\nrm -rf x\n  \necho done" }), "ls (+2 lines)");
  assert.equal(bash.summarize({ command: "ls\r\nwhoami" }), "ls (+1 line)", "CRLF is an ordinary line break");
  assert.ok(bash.summarize({ command: "x".repeat(300) }).length <= 100);
  assert.equal(bash.summarize({}), "");
});

test("permission verdicts for commands", () => {
  const s = setup();
  try {
    const bash = s.toolbox.byName.get("Bash");
    const ro = bash.permission({ command: "git status" }, s.ctx);
    assert.equal(ro.decision, "allow");
    assert.equal(ro.readOnlyCall, true);
    const npm = bash.permission({ command: "npm test" }, s.ctx);
    assert.equal(npm.decision, "ask");
    assert.equal(npm.risk, "medium");
    assert.equal(npm.sessionKey, "Bash:npm test");
    assert.deepEqual(npm.sessionKeys, ["Bash:npm test"]);
    assert.match(npm.sessionLabel, /npm test/);
    // Only a plain command can be remembered: a compound one is asked about every time.
    const two = bash.permission({ command: "npm test && git push" }, s.ctx);
    assert.equal(two.decision, "ask");
    assert.equal(two.sessionKey, undefined);
    assert.equal(two.sessionKeys, undefined);
    assert.equal(two.sessionLabel, undefined);
    const quoted = bash.permission({ command: "npm test \"x\"" }, s.ctx);
    assert.equal(quoted.sessionKey, undefined);
    const intent = bash.permission({ command: "npm test", description: "Run the unit tests" }, s.ctx);
    assert.equal(intent.detail, "Run the unit tests\n\nnpm test");
    const high = bash.permission({ command: "rm -rf /" }, s.ctx);
    assert.equal(high.risk, "high");
    assert.equal(high.sessionKey, undefined);
    assert.match(high.detail, /rm -rf \//);
    assert.match(high.detail, /Deletes many files at once/);
    const secret = bash.permission({ command: "cat .env" }, s.ctx);
    assert.equal(secret.decision, "ask");
    assert.equal(secret.risk, "high");
    assert.ok(!secret.readOnlyCall);
  } finally { s.cleanup(); }
});

test("the reasons in a dialog are real sentences: internal labels and unknown keys are never printed", () => {
  const raw = /tools\.risk\./;
  // A plain, unlisted command that is only asked about because of an invisible character or its length.
  const s = setup();
  try {
    const bash = s.toolbox.byName.get("Bash");
    const hidden = bash.permission({ command: "printf hello‮" }, s.ctx);
    assert.equal(hidden.decision, "ask");
    assert.match(hidden.detail, /invisible or text-direction characters/);
    assert.ok(!raw.test(hidden.detail) && !/unlisted/.test(hidden.detail), hidden.detail);
    const long = bash.permission({ command: "printf hello " + "x".repeat(1200) }, s.ctx);
    assert.match(long.detail, /Long command/);
    assert.ok(!raw.test(long.detail) && !/unlisted/.test(long.detail));
    setLang("ar");
    const arabic = bash.permission({ command: "printf hello‮" }, s.ctx);
    setLang("en");
    assert.ok(!raw.test(arabic.detail) && !/unlisted/.test(arabic.detail));
    assert.match(arabic.detail, /[؀-ۿ]/);
  } finally { setLang("en"); s.cleanup(); }
  assert.deepEqual(reasonLines(["unlisted", "unparsed", "", undefined]), []);
  assert.deepEqual(reasonLines(["unlisted", "hiddenChars", "somethingNew", "hiddenChars"]), [t("tools.risk.hiddenChars")], "once each, only those with a text");
});

test("every reason the classifier can give has a text in both languages, apart from the internal ones", () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "tools", "classify.js"), "utf8");
  const reasons = new Set([...source.matchAll(/raise\(\w+,\s*\d+,\s*"([A-Za-z]+)"/g)].map(m => m[1]));
  const rawHigh = source.slice(source.indexOf("const RAW_HIGH = ["), source.indexOf("];", source.indexOf("const RAW_HIGH = [")));
  for (const m of rawHigh.matchAll(/,\s*"([A-Za-z]+)"\],?\s*$/gm)) reasons.add(m[1]);
  for (const extra of ["hiddenChars", "longCommand", "secret"]) reasons.add(extra);
  assert.ok(reasons.size > 15, [...reasons].join(","));
  for (const reason of reasons) {
    if (["unlisted", "unparsed"].includes(reason)) continue;
    for (const lang of ["en", "ar"]) {
      setLang(lang);
      assert.notEqual(t(`tools.risk.${reason}`), `tools.risk.${reason}`, `${reason} has no ${lang} text`);
    }
  }
  setLang("en");
});

// ----- the three Windows shells, for real

const hasPowerShell = process.platform === "win32";
const forced = kind => resolveShell({ platform: "win32", env: process.env, exists: p => (kind === "bash" ? fs.existsSync(p) : !/bash\.exe$/i.test(p) && (kind === "powershell" ? fs.existsSync(p) : !/(pwsh|powershell)\.exe$/i.test(p) && fs.existsSync(p))) });

test("Windows: PowerShell runs commands, keeps Arabic, and reports native exit codes", { skip: !hasPowerShell }, async () => {
  const shell = forced("powershell");
  assert.equal(shell.kind, "powershell");
  const tool = createBashTool({ shell, jobs: createJobs() });
  const ctx = { cwd: process.cwd(), env: process.env };
  const a = await tool.run({ command: "Write-Output 'مرحبا'; node -e \"console.log(1+1)\"" }, ctx);
  assert.equal(a.content, "مرحبا\n2\n[exit code: 0]");
  const b = await tool.run({ command: "node -e \"process.exit(7)\"" }, ctx);
  assert.equal(b.ok, false);
  assert.match(b.content, /\[exit code: 7\]/);
  const c = await tool.run({ command: "exit 4" }, ctx);
  assert.match(c.content, /\[exit code: 4\]/);
  const d = await tool.run({ command: "Get-Item C:\\definitely-not-here" }, ctx);
  assert.equal(d.ok, false);
  assert.match(d.content, /\[exit code: 1\]/);
  const e = await tool.run({ command: "$x = 'a b'; Write-Output \"$x!\"" }, ctx);
  assert.match(e.content, /^a b!/);
});

test("Windows: cmd runs commands and keeps Arabic", { skip: !hasPowerShell }, async () => {
  const shell = forced("cmd");
  assert.equal(shell.kind, "cmd");
  const tool = createBashTool({ shell, jobs: createJobs() });
  const ctx = { cwd: process.cwd(), env: process.env };
  const a = await tool.run({ command: "echo hello & node -e \"console.log('مرحبا')\"" }, ctx);
  assert.match(a.content, /hello\s*\nمرحبا\n\[exit code: 0\]/);
  const b = await tool.run({ command: "exit /b 3" }, ctx);
  assert.match(b.content, /\[exit code: 3\]/);
});

test("Windows: Git Bash handles quotes, pipes and exit codes", { skip: !hasPowerShell || resolveShell().kind !== "bash" }, async () => {
  const tool = createBashTool({ shell: forced("bash"), jobs: createJobs() });
  const ctx = { cwd: process.cwd(), env: process.env };
  const a = await tool.run({ command: "echo \"it's $((6*7))\" | tr a-z A-Z; exit 5" }, ctx);
  assert.match(a.content, /^IT'S 42\n\[exit code: 5\]/);
});

test("the toolbox exports the resolved shell", () => {
  const tb = createToolbox({ cwd: process.cwd() });
  assert.equal(tb.shell, tb.byName.get("Bash").shell);
  assert.ok(["bash", "sh", "zsh", "powershell", "cmd"].includes(tb.shell.kind));
});
