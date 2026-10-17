// macOS/Linux installer, exercised with Git Bash on Windows or the system bash elsewhere.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeTarGz } from "./zip-util.js";
import { scriptsDir, makeTemp, removeTree, startServer, run, cleanEnv, sha256File, findBash, toPosix, writeFakeAppTar } from "./helpers.js";

const script = path.join(scriptsDir, "install.sh");
const bash = findBash();
const usable = (() => {
  if (!bash) return false;
  const probe = spawnSync(bash, ["-c", "uname -s; command -v tar curl awk sed grep mktemp >/dev/null && echo tools-ok"], { encoding: "utf8" });
  return probe.status === 0 && /tools-ok/.test(probe.stdout) && !/Linux\s*\n[\s\S]*microsoft/i.test(probe.stdout);
})();

describe("install.sh", { skip: !usable && "no usable bash with tar and curl" }, () => {
  let work;
  let appTar;
  let home;

  before(() => {
    work = makeTemp("fc2-sh-");
    appTar = path.join(work, "app.tar.gz");
    writeFakeAppTar(appTar);
    home = path.join(work, "home");
    fs.mkdirSync(home);
  });
  after(() => removeTree(work));

  const dirFor = name => path.join(work, name);
  const envFor = (extra = {}) => cleanEnv({ HOME: toPosix(home), LANG: "en_US.UTF-8", SHELL: "/bin/bash", ...extra });
  const install = (args, { env = envFor(), timeout } = {}) => run(bash, [toPosix(script), ...args], { env, timeout });
  const common = name => ["--dir", toPosix(dirFor(name)), "--no-launch"];

  test("has no syntax errors", () => {
    const res = spawnSync(bash, ["-n", toPosix(script)], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
  });

  test("--help exits 0 and unknown options exit 2", async () => {
    const help = await install(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.out, /--uninstall/);
    const bad = await install(["--bogus"]);
    assert.equal(bad.status, 2);
    assert.match(bad.out, /Unknown option: --bogus/);
    const missing = await install(["--code"]);
    assert.equal(missing.status, 2);
    assert.match(missing.out, /needs a value/);
  });

  test("refuses the home folder or a system folder as install folder", async () => {
    assert.equal((await install(["--dir", toPosix(home), "--archive", toPosix(appTar), "--no-launch"])).status, 2);
    assert.equal((await install(["--dir", "/", "--archive", toPosix(appTar), "--no-launch"])).status, 2);
  });

  test("installs, runs through the launchers, edits the shell files once, updates in place and uninstalls", async () => {
    const dir = dirFor("e2e");
    fs.writeFileSync(path.join(home, ".bashrc"), "export KEEP=1");
    const first = await install([...common("e2e"), "--archive", toPosix(appTar)]);
    assert.equal(first.status, 0, first.out);
    assert.match(first.out, /Installed successfully \(version 9\.9\.9\)/);
    assert.ok(fs.existsSync(path.join(dir, "app", "bin", "firas.js")), "the top-level folder must be flattened");
    for (const name of ["firas", "fc2", "firas-code"]) assert.ok(fs.existsSync(path.join(dir, "bin", name)), name);

    const shim = toPosix(path.join(dir, "bin", "firas"));
    const ran = await run(bash, [shim, "alpha", "two words"], { env: envFor({ FAKE_EXIT: "7" }) });
    assert.equal(ran.status, 7, "exit code must pass through the launcher");
    assert.match(ran.stdout, /fake-firas alpha\|two words/);

    const rc = fs.readFileSync(path.join(home, ".bashrc"), "utf8");
    assert.match(rc, /^export KEEP=1\n# >>> firas-code >>>\n/);
    assert.equal((rc.match(/>>> firas-code >>>/g) || []).length, 1);

    fs.writeFileSync(path.join(dir, "app", "stale.txt"), "old");
    fs.writeFileSync(path.join(dir, "config.json"), "{}");
    const second = await install([...common("e2e"), "--archive", toPosix(appTar)]);
    assert.equal(second.status, 0, second.out);
    assert.match(second.out, /Updated successfully/);
    assert.ok(!fs.existsSync(path.join(dir, "app", "stale.txt")));
    assert.ok(fs.existsSync(path.join(dir, "config.json")));
    assert.ok(!fs.existsSync(path.join(dir, "app.new")) && !fs.existsSync(path.join(dir, "app.old")));
    assert.equal((fs.readFileSync(path.join(home, ".bashrc"), "utf8").match(/>>> firas-code >>>/g) || []).length, 1, "the marked block must not be duplicated");

    const gone = await install(["--dir", toPosix(dir), "--uninstall"]);
    assert.equal(gone.status, 0, gone.out);
    assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
    assert.doesNotMatch(fs.readFileSync(path.join(home, ".bashrc"), "utf8"), /firas-code/);
    assert.match(fs.readFileSync(path.join(home, ".bashrc"), "utf8"), /export KEEP=1/);

    const again = await install(["--dir", toPosix(dir), "--uninstall"]);
    assert.match(again.out, /Nothing is installed/);
  });

  test("works in a folder with spaces, parentheses, an ampersand and a percent sign in its name", async () => {
    const dir = dirFor("with space (x) & 100%");
    const res = await install(["--dir", toPosix(dir), "--archive", toPosix(appTar), "--no-launch", "--no-path-update"]);
    assert.equal(res.status, 0, res.out);
    const ran = await run(bash, [toPosix(path.join(dir, "bin", "firas")), "a b"], { env: envFor({ FAKE_EXIT: "3" }) });
    assert.equal(ran.status, 3, ran.out);
    assert.match(ran.stdout, /fake-firas a b/);
    const gone = await install(["--dir", toPosix(dir), "--uninstall", "--purge", "--no-path-update"]);
    assert.equal(gone.status, 0, gone.out);
    assert.ok(!fs.existsSync(dir));
  });

  test("--purge removes everything for a folder it made and leaves strangers' folders alone", async () => {
    const dir = dirFor("purge");
    assert.equal((await install([...common("purge"), "--archive", toPosix(appTar), "--no-path-update"])).status, 0);
    fs.writeFileSync(path.join(dir, "config.json"), "{}");
    assert.equal((await install(["--dir", toPosix(dir), "--uninstall", "--purge", "--no-path-update"])).status, 0);
    assert.ok(!fs.existsSync(dir));

    const stranger = dirFor("stranger");
    fs.mkdirSync(path.join(stranger, "bin"), { recursive: true });
    fs.writeFileSync(path.join(stranger, "keep.txt"), "mine");
    const kept = await install(["--dir", toPosix(stranger), "--uninstall", "--purge", "--no-path-update"]);
    assert.equal(kept.status, 0);
    assert.ok(fs.existsSync(path.join(stranger, "keep.txt")));
    assert.ok(fs.existsSync(path.join(stranger, "bin")), "a stranger's folder called bin is not ours to remove");
    assert.match(kept.out, /Nothing is installed/);
  });

  test("--purge needs the install marker: a folder that is only NAMED .firas-code loses its program folders and nothing else", async () => {
    const dir = path.join(dirFor("named"), ".firas-code");
    fs.mkdirSync(path.join(dir, "app", "bin"), { recursive: true });
    fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app", "bin", "firas.js"), "x");
    fs.writeFileSync(path.join(dir, "keep.txt"), "mine");
    fs.writeFileSync(path.join(dir, "config.json"), "{}");
    const res = await install(["--dir", toPosix(dir), "--uninstall", "--purge", "--no-path-update"]);
    assert.equal(res.status, 0, res.out);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["config.json", "keep.txt"], "the program folders go, the person's files stay");
    assert.match(res.out, /has no Firas Code install marker/);
    assert.doesNotMatch(res.out, /Everything in .* was deleted/);
  });

  test("--purge does not take a marker that is a folder, or a bare folder with no program in it, for proof", async () => {
    const fake = dirFor("fake-marker");
    fs.mkdirSync(path.join(fake, ".firas-install"), { recursive: true });
    fs.writeFileSync(path.join(fake, "keep.txt"), "mine");
    const res = await install(["--dir", toPosix(fake), "--uninstall", "--purge", "--no-path-update"]);
    assert.equal(res.status, 0, res.out);
    assert.ok(fs.existsSync(path.join(fake, "keep.txt")));
    const bare = path.join(dirFor("bare"), ".firas-code");
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, "keep.txt"), "mine");
    const none = await install(["--dir", toPosix(bare), "--uninstall", "--purge", "--no-path-update"]);
    assert.equal(none.status, 0, none.out);
    assert.match(none.out, /Nothing is installed/);
    assert.ok(fs.existsSync(path.join(bare, "keep.txt")), "a folder with only a matching name is never deleted");
  });

  test("picks the right start-up files: zsh creates .zshrc, fish gets a conf.d file, and both are cleaned on uninstall", async () => {
    const altHome = path.join(work, "home2");
    fs.mkdirSync(path.join(altHome, ".config", "fish"), { recursive: true });
    const env = envFor({ HOME: toPosix(altHome), SHELL: "/bin/zsh" });
    const res = await install([...common("shells"), "--archive", toPosix(appTar)], { env });
    assert.equal(res.status, 0, res.out);
    assert.match(fs.readFileSync(path.join(altHome, ".zshrc"), "utf8"), /# >>> firas-code >>>/);
    assert.ok(fs.existsSync(path.join(altHome, ".config", "fish", "conf.d", "firas-code.fish")));
    const gone = await install(["--dir", toPosix(dirFor("shells")), "--uninstall"], { env });
    assert.equal(gone.status, 0, gone.out);
    assert.doesNotMatch(fs.readFileSync(path.join(altHome, ".zshrc"), "utf8"), /firas-code/);
    assert.ok(!fs.existsSync(path.join(altHome, ".config", "fish", "conf.d", "firas-code.fish")));
  });

  test("environment variables work like the flags", async () => {
    const dir = dirFor("envtwins");
    const env = envFor({ FIRAS_INSTALL_DIR: toPosix(dir), FIRAS_INSTALL_ARCHIVE: toPosix(appTar), FIRAS_NO_LAUNCH: "1", FIRAS_NO_PATH_UPDATE: "1" });
    const res = await install([], { env });
    assert.equal(res.status, 0, res.out);
    assert.ok(fs.existsSync(path.join(dir, "app", "bin", "firas.js")));
    const gone = await install([], { env: { ...env, FIRAS_UNINSTALL: "1" } });
    assert.equal(gone.status, 0, gone.out);
    assert.ok(!fs.existsSync(path.join(dir, "app")));
  });

  test("an access code reaches the first launch in its environment, never on its command line; a malformed one is ignored with a warning", async () => {
    const env = envFor({ FIRAS_FORCE_LAUNCH: "1" });
    const good = await install(["--dir", toPosix(dirFor("launch")), "--archive", toPosix(appTar), "--no-path-update", "--code", "FC2-ABCDE-FGHJK"], { env });
    assert.equal(good.status, 0, good.out);
    assert.match(good.out, /fake-firas \r?\n/, "the app gets no arguments");
    assert.doesNotMatch(good.out, /--code/);
    assert.match(good.out, /env-code=FC2-ABCDE-FGHJK/);
    const bad = await install(["--dir", toPosix(dirFor("launch")), "--archive", toPosix(appTar), "--no-path-update", "--code", "nope"], { env });
    assert.match(bad.out, /looks wrong/);
    assert.doesNotMatch(bad.out, /nope/);
    assert.match(bad.out, /env-code=\r?\n/);
  });

  test("Arabic lines appear in a UTF-8 locale and can be switched off with FIRAS_LANG=en", async () => {
    const withArabic = await install(["--bogus"]);
    assert.match(withArabic.out, /[؀-ۿ]/);
    const english = await install(["--bogus"], { env: envFor({ FIRAS_LANG: "en" }) });
    assert.doesNotMatch(english.out, /[؀-ۿ]/);
    const plain = await install(["--bogus"], { env: envFor({ LANG: "C", LC_ALL: "C" }) });
    assert.doesNotMatch(plain.out, /[؀-ۿ]/, "no Arabic bytes into a non-UTF-8 terminal");
  });

  describe("failure modes", () => {
    test("a missing archive exits 3", async () => {
      const res = await install([...common("f-missing"), "--archive", toPosix(path.join(work, "nope.tar.gz")), "--no-path-update"]);
      assert.equal(res.status, 3);
      assert.match(res.out, /not found/);
      assert.ok(!fs.existsSync(path.join(dirFor("f-missing"), "app")));
    });

    test("an archive that is not a tarball exits 4", async () => {
      const junk = path.join(work, "junk.tar.gz");
      fs.writeFileSync(junk, "this is not an archive");
      const res = await install([...common("f-junk"), "--archive", toPosix(junk), "--no-path-update"]);
      assert.equal(res.status, 4, res.out);
      assert.match(res.out, /damaged or incomplete/);
    });

    test("an archive without bin/firas.js exits 4 and keeps the existing install", async () => {
      const dir = dirFor("f-layout");
      assert.equal((await install([...common("f-layout"), "--archive", toPosix(appTar), "--no-path-update"])).status, 0);
      const wrong = path.join(work, "wrong.tar.gz");
      writeTarGz(wrong, [{ name: "x/" }, { name: "x/readme.txt", data: Buffer.from("hello") }]);
      const res = await install([...common("f-layout"), "--archive", toPosix(wrong), "--no-path-update"]);
      assert.equal(res.status, 4, res.out);
      assert.match(res.out, /does not look like Firas Code 2/);
      assert.ok(fs.existsSync(path.join(dir, "app", "bin", "firas.js")));
      assert.ok(!fs.existsSync(path.join(dir, "app.new")));
    });

    test("an unreachable address exits 3 with a network hint", async () => {
      const res = await install([...common("f-offline"), "--archive", "http://127.0.0.1:9/app.tar.gz", "--no-path-update"], { timeout: 90000 });
      assert.equal(res.status, 3, res.out);
      assert.match(res.out, /Check your internet connection/);
    });

    test("an HTTP 404 exits 3", async () => {
      const server = await startServer({});
      try {
        const res = await install([...common("f-404"), "--archive", server.origin + "/missing.tar.gz", "--no-path-update"]);
        assert.equal(res.status, 3, res.out);
        assert.match(res.out, /not found/);
      } finally {
        await server.close();
      }
    });
  });

  describe("download over HTTP and the private Node.js copy", () => {
    let server;
    let nodeTar;
    let badSums = false;
    let noNodePath;

    before(async () => {
      const real = toPosix(process.execPath);
      nodeTar = path.join(work, "node-v99.0.0-linux-x64.tar.gz");
      const fakeNode = `#!/bin/sh\nif [ "$1" = "-v" ]; then echo v99.0.0; exit 0; fi\nexec "${real}" "$@"\n`;
      writeTarGz(nodeTar, [
        { name: "node-v99.0.0-linux-x64/" },
        { name: "node-v99.0.0-linux-x64/bin/" },
        { name: "node-v99.0.0-linux-x64/bin/node", data: Buffer.from(fakeNode), mode: 0o755 },
        { name: "node-v99.0.0-linux-x64/LICENSE", data: Buffer.from("licence text") },
        { name: "node-v99.0.0-linux-x64/include/big.h", data: Buffer.from("not wanted") }
      ]);
      const sums = `${sha256File(nodeTar)}  node-v99.0.0-linux-x64.tar.gz\n${"0".repeat(64)}  node-v99.0.0-darwin-arm64.tar.gz\n`;
      const index = [
        { version: "v100.0.0", files: ["linux-x64"], lts: false },
        { version: "v99.0.0", files: ["linux-x64", "linux-arm64", "osx-arm64-tar"], lts: "Test" },
        { version: "v98.0.0", files: ["linux-x64"], lts: "Older" }
      ];
      server = await startServer({
        "/dist/index.json": JSON.stringify(index),
        "/dist/v99.0.0/node-v99.0.0-linux-x64.tar.gz": fs.readFileSync(nodeTar),
        "/dist/v99.0.0/SHASUMS256.txt": (req, res) => { res.statusCode = 200; res.end(badSums ? sums.replace(/^./, c => (c === "0" ? "1" : "0")) : sums); },
        "/app.tar.gz": fs.readFileSync(appTar)
      });
      if (process.platform === "win32") {
        const root = path.dirname(path.dirname(bash));
        noNodePath = [path.join(root, "usr", "bin"), path.join(root, "mingw64", "bin"), path.join(root, "bin")].join(";");
      } else {
        noNodePath = "/usr/bin:/bin";
      }
    });
    after(async () => { await server.close(); });

    const nodeEnv = extra => {
      const env = envFor({ FIRAS_NODE_INDEX_URL: server.origin + "/dist/index.json", FIRAS_NODE_DIST_URL: server.origin + "/dist", FIRAS_NODE_TARGET: "linux-x64", ...extra });
      for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key];
      env.PATH = noNodePath;
      return env;
    };
    const hasNode = () => spawnSync(bash, ["-c", "command -v node"], { env: nodeEnv(), encoding: "utf8" }).status === 0;

    test("downloads the newest LTS build, verifies its checksum, keeps only the binary and prefers it in the launcher", async t => {
      if (hasNode()) { t.skip("a node binary is on the minimal PATH"); return; }
      const dir = dirFor("nodedl");
      const res = await install(["--dir", toPosix(dir), "--archive", server.origin + "/app.tar.gz", "--no-launch", "--no-path-update"], { env: nodeEnv() });
      assert.equal(res.status, 0, res.out);
      assert.match(res.out, /Downloading a private copy of Node\.js v99\.0\.0/);
      assert.deepEqual(fs.readdirSync(path.join(dir, "runtime")).sort(), ["LICENSE", "bin"]);
      assert.deepEqual(fs.readdirSync(path.join(dir, "runtime", "bin")), ["node"]);
      const ran = await run(bash, [toPosix(path.join(dir, "bin", "firas")), "hello"], { env: nodeEnv() });
      assert.equal(ran.status, 0, ran.out);
      assert.match(ran.stdout, /fake-firas hello/);

      const nodeDownloads = () => server.requests.filter(r => r.endsWith(".tar.gz") && r.includes("node-")).length;
      const before = nodeDownloads();
      const again = await install(["--dir", toPosix(dir), "--archive", server.origin + "/app.tar.gz", "--no-launch", "--no-path-update"], { env: nodeEnv() });
      assert.equal(again.status, 0, again.out);
      assert.match(again.out, /private copy/);
      assert.equal(nodeDownloads(), before, "a working private Node.js must not be downloaded twice");
    });

    test("a checksum mismatch exits 4 and installs nothing", async t => {
      if (hasNode()) { t.skip("a node binary is on the minimal PATH"); return; }
      badSums = true;
      try {
        const dir = dirFor("nodebad");
        const res = await install(["--dir", toPosix(dir), "--archive", server.origin + "/app.tar.gz", "--no-launch", "--no-path-update"], { env: nodeEnv() });
        assert.equal(res.status, 4, res.out);
        assert.match(res.out, /does not match its published SHA-256/);
        assert.ok(!fs.existsSync(path.join(dir, "runtime")) && !fs.existsSync(path.join(dir, "runtime.new")));
        assert.ok(!fs.existsSync(path.join(dir, "app")));
      } finally {
        badSums = false;
      }
    });

    test("a system with no Node.js build to offer is explained instead of guessed", async t => {
      if (process.platform !== "win32") { t.skip("only Git Bash on Windows reports an unsupported system"); return; }
      if (hasNode()) { t.skip("a node binary is on the minimal PATH"); return; }
      const env = nodeEnv({ FIRAS_NODE_TARGET: "" });
      const res = await install(["--dir", toPosix(dirFor("odd")), "--archive", server.origin + "/app.tar.gz", "--no-launch", "--no-path-update"], { env });
      assert.equal(res.status, 7, res.out);
      assert.match(res.out, /not supported/);
    });
  });
});
