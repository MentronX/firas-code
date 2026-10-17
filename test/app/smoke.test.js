// The real program in a real child process: bin/firas.js with the flags an installer or a script would use.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../../src/brand.js";
import { startMockService, textReply } from "../helpers/mock-service.js";
import { tempDir } from "./helpers.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = path.join(root, "bin", "firas.js");

const home = tempDir("firas-smoke-home-");
const work = tempDir("firas-smoke-work-");
after(() => { home.remove(); work.remove(); });

function firas(args, { env = {}, input, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: work.dir,
      env: { ...process.env, FIRAS_HOME: home.dir, FIRAS_LANG: "en", NO_COLOR: "1", ...env },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`the program did not finish in ${timeoutMs} ms\n${stdout}\n${stderr}`)); }, timeoutMs);
    child.on("error", reject);
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - started }); });
    if (input !== undefined) child.stdin.end(input);
  });
}

test("--version and -v print just the version", async () => {
  for (const flag of ["--version", "-v"]) {
    const run = await firas([flag]);
    assert.equal(run.code, 0);
    assert.equal(run.stdout, `${VERSION}\n`);
    assert.equal(run.stderr, "");
  }
});

test("--help prints the usage in English or Arabic and exits 0", async () => {
  const en = await firas(["--help"]);
  assert.equal(en.code, 0);
  assert.match(en.stdout, /Usage/);
  assert.match(en.stdout, /--print/);
  assert.ok(!en.stdout.includes("--origin"));
  const ar = await firas(["-h"], { env: { FIRAS_LANG: "ar" } });
  assert.equal(ar.code, 0);
  assert.match(ar.stdout, /الاستخدام/);
});

test("a wrong flag exits 2 with one friendly line and the hint", async () => {
  const run = await firas(["--nonsense"]);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /Unknown option --nonsense/);
  assert.match(run.stderr, /firas --help/);
  assert.ok(!/at .*\.js:\d+/.test(run.stderr), "no stack trace");
});

test("without a terminal and without -p the program explains and exits 2", async () => {
  const run = await firas([]);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /needs a terminal/);
});

test("-p against the mock service: the answer on stdout, exit 0, the service saw the right headers", async () => {
  const service = await startMockService([textReply("Hello from a child process. مرحبا!")]);
  try {
    const run = await firas(["-p", "say hello"], { env: { FIRAS_ORIGIN: service.origin, FIRAS_CODE: service.code } });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, "Hello from a child process. مرحبا!\n");
    assert.equal(run.stderr, "");
    assert.ok(run.ms < 15_000);
    const post = service.requests.find(r => r.method === "POST");
    assert.equal(post.headers["x-firas-client"], "cli");
    assert.equal(post.headers.authorization, `Bearer ${service.code}`);
    assert.match(post.headers["user-agent"], new RegExp(`^firas-code/${VERSION.replace(/[.+]/g, "\\$&")} \\(`));
    assert.equal(post.body.messages[0].content[0].text, "say hello");
  } finally { await service.close(); }
});

test("-p reads the message from stdin when there is none on the command line", async () => {
  const service = await startMockService([textReply("read it")]);
  try {
    const run = await firas(["-p"], { env: { FIRAS_ORIGIN: service.origin, FIRAS_CODE: service.code }, input: "summarize this please" });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, "read it\n");
    assert.equal(service.requests.find(r => r.method === "POST").body.messages[0].content[0].text, "summarize this please");
  } finally { await service.close(); }
});

test("--code saves a valid code, so the next run needs no environment variable", async () => {
  const service = await startMockService([textReply("one"), textReply("two")], { code: "FC2-SMOKE-CODE00" });
  try {
    const first = await firas(["--code", "FC2-SMOKE-CODE00", "-p", "hi"], { env: { FIRAS_ORIGIN: service.origin } });
    assert.equal(first.code, 0, first.stderr);
    const second = await firas(["-p", "again"], { env: { FIRAS_ORIGIN: service.origin } });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout, "two\n");
    const bad = await firas(["--code", "FC2-NOPE0-NOPE00", "-p", "x"], { env: { FIRAS_ORIGIN: service.origin } });
    assert.equal(bad.code, 1);
    assert.ok(!bad.stderr.includes("FC2-NOPE0"), "the code is not echoed");
  } finally { await service.close(); }
});

test("a service refusal exits 1 with friendly words and no stack", async () => {
  const service = await startMockService([], { denyModels: false });
  try {
    const run = await firas(["-p", "hi"], { env: { FIRAS_ORIGIN: service.origin, FIRAS_CODE: "FC2-ANY00-ANY00" } });
    assert.equal(run.code, 1);
    assert.equal(run.stdout, "");
    assert.ok(run.stderr.trim().length > 0);
    assert.ok(!/at .*\.js:\d+/.test(run.stderr));
  } finally { await service.close(); }
});

test("`firas update` from a source checkout explains itself instead of running an installer", async () => {
  const run = await firas(["update"]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /source checkout|know where to update from|another folder/);
});

test("a bad service address exits 2", async () => {
  const run = await firas(["-p", "hi", "--origin", "http://example.com"], { env: { FIRAS_CODE: "FC2-ANY00-ANY00" } });
  assert.equal(run.code, 2);
  assert.match(run.stderr, /address isn't valid/);
});
