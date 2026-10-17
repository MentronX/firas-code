// Windows installer: parser check, offline end-to-end install/update/uninstall, failure modes, the Node.js download path and both `iex` forms.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { writeZip } from "./zip-util.js";
import { scriptsDir, makeTemp, removeTree, startServer, run, cleanEnv, sha256File, writeFakeApp, fakeAppEntries } from "./helpers.js";

const script = path.join(scriptsDir, "install.ps1");
const onWindows = process.platform === "win32";
const PS = "powershell.exe";
const psArgs = file => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file];

function hasPwsh() {
  const res = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
  return res.status === 0;
}

function install(args, { env = cleanEnv(), timeout } = {}) {
  return run(PS, [...psArgs(script), ...args], { env, timeout });
}

describe("install.ps1", { skip: !onWindows && "Windows only" }, () => {
  let work;
  let appZip;

  before(() => {
    work = makeTemp("fc2-ps-");
    appZip = path.join(work, "app.zip");
    writeFakeApp(appZip);
  });
  after(() => removeTree(work));

  const dirFor = name => path.join(work, name);

  test("is plain ASCII with no byte order mark, so `irm | iex` and file runs behave the same", () => {
    const bytes = fs.readFileSync(script);
    assert.ok(!bytes.some(b => b > 127), "non-ASCII byte found");
    assert.notEqual(bytes[0], 0xef);
  });

  test("parses without errors in Windows PowerShell and, when present, PowerShell 7", () => {
    const check = "$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($args[0],[ref]$t,[ref]$e);if($e.Count){$e|%{$_.Message};exit 1}";
    const res = spawnSync(PS, ["-NoProfile", "-Command", `& { ${check} } '${script}'`], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    if (hasPwsh()) {
      const res7 = spawnSync("pwsh", ["-NoProfile", "-Command", `& { ${check} } '${script}'`], { encoding: "utf8" });
      assert.equal(res7.status, 0, res7.stdout + res7.stderr);
    }
  });

  test("-Help exits 0 and unknown options exit 2", async () => {
    const help = await install(["-Help"]);
    assert.equal(help.status, 0);
    assert.match(help.out, /-Uninstall/);
    const bad = await install(["-Bogus"]);
    assert.equal(bad.status, 2);
    assert.match(bad.out, /Unknown option: -Bogus/);
    const missing = await install(["-Code"]);
    assert.equal(missing.status, 2);
    assert.match(missing.out, /needs a value/);
  });

  test("refuses a drive root or the home folder as install folder", async () => {
    const root = await install(["-InstallDir", "C:\\", "-ArchiveUrl", appZip, "-NoLaunch", "-NoPathUpdate"]);
    assert.equal(root.status, 2);
    const home = await install(["-InstallDir", process.env.USERPROFILE, "-ArchiveUrl", appZip, "-NoLaunch", "-NoPathUpdate"]);
    assert.equal(home.status, 2);
  });

  test("installs from a local zip, runs through the shims, updates in place and uninstalls", async () => {
    const dir = dirFor("e2e");
    const first = await install(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoLaunch", "-NoPathUpdate"]);
    assert.equal(first.status, 0, first.out);
    assert.match(first.out, /Installed successfully \(version 9\.9\.9\)/);
    assert.ok(fs.existsSync(path.join(dir, "app", "bin", "firas.js")), "GitHub's top-level folder must be flattened");
    assert.ok(!fs.existsSync(path.join(dir, "app", "fake-main")));
    for (const name of ["firas.cmd", "fc2.cmd", "firas-code.cmd"]) assert.ok(fs.existsSync(path.join(dir, "bin", name)), name);
    assert.ok(!fs.existsSync(path.join(dir, "bin", "firas.ps1")), "no .ps1 shim unless scripts are explicitly allowed");

    const shim = path.join(dir, "bin", "firas.cmd");
    const ran = await run(shim, ["alpha", "two words", "--flag"], { env: cleanEnv({ FAKE_EXIT: "7" }) });
    assert.equal(ran.status, 7, "exit code must pass through the shim");
    assert.match(ran.stdout, /fake-firas alpha\|two words\|--flag/);
    const alias = await run(path.join(dir, "bin", "fc2.cmd"), ["x"], { env: cleanEnv() });
    assert.equal(alias.status, 0);
    assert.match(alias.stdout, /fake-firas x/);

    fs.writeFileSync(path.join(dir, "app", "stale.txt"), "old");
    fs.writeFileSync(path.join(dir, "config.json"), "{}");
    const second = await install(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoLaunch", "-NoPathUpdate"]);
    assert.equal(second.status, 0, second.out);
    assert.match(second.out, /Updated successfully/);
    assert.ok(!fs.existsSync(path.join(dir, "app", "stale.txt")), "old version files must not survive an update");
    assert.ok(fs.existsSync(path.join(dir, "config.json")), "user data must survive an update");
    assert.ok(!fs.existsSync(path.join(dir, "app.new")) && !fs.existsSync(path.join(dir, "app.old")));

    const gone = await install(["-InstallDir", dir, "-Uninstall", "-NoPathUpdate"]);
    assert.equal(gone.status, 0, gone.out);
    assert.match(gone.out, /settings and saved sessions were kept/);
    assert.deepEqual(fs.readdirSync(dir), ["config.json"]);

    const again = await install(["-InstallDir", dir, "-Uninstall", "-NoPathUpdate"]);
    assert.equal(again.status, 0);
    assert.match(again.out, /Nothing is installed/);
  });

  test("works in a folder with spaces, brackets, an ampersand and Arabic letters in its name", async () => {
    const dir = dirFor("مجلد (x) & [y] 100%");
    const res = await install(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoLaunch", "-NoPathUpdate"]);
    assert.equal(res.status, 0, res.out);
    const ran = await run(path.join(dir, "bin", "firas.cmd"), ["a b"], { env: cleanEnv({ FAKE_EXIT: "3" }) });
    assert.equal(ran.status, 3, ran.out);
    assert.match(ran.stdout, /fake-firas a b/);
    const gone = await install(["-InstallDir", dir, "-Uninstall", "-Purge", "-NoPathUpdate"]);
    assert.equal(gone.status, 0, gone.out);
    assert.ok(!fs.existsSync(dir));
  });

  test("an update while the app is in use fails politely and keeps the working version", async () => {
    const dir = dirFor("inuse");
    assert.equal((await install(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoLaunch", "-NoPathUpdate"])).status, 0);
    // A process whose working folder is inside app\ blocks the rename, like a running copy would.
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: path.join(dir, "app"), stdio: "ignore" });
    try {
      await new Promise(resolve => setTimeout(resolve, 400));
      const res = await install(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoLaunch", "-NoPathUpdate"]);
      assert.equal(res.status, 5, res.out);
      assert.match(res.out, /Close it, then run the command again/);
      assert.ok(fs.existsSync(path.join(dir, "app", "bin", "firas.js")), "the working version must stay");
      assert.ok(!fs.existsSync(path.join(dir, "app.new")), "no staging folder left behind");
    } finally {
      holder.kill();
      await new Promise(resolve => holder.once("close", resolve));
    }
    const after = await install(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoLaunch", "-NoPathUpdate"]);
    assert.equal(after.status, 0, after.out);
  });

  test("-Uninstall -Purge removes everything, but only for a folder this installer made", async () => {
    const dir = dirFor("purge");
    assert.equal((await install(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoLaunch", "-NoPathUpdate"])).status, 0);
    fs.writeFileSync(path.join(dir, "config.json"), "{}");
    const res = await install(["-InstallDir", dir, "-Uninstall", "-Purge", "-NoPathUpdate"]);
    assert.equal(res.status, 0, res.out);
    assert.ok(!fs.existsSync(dir));

    const stranger = dirFor("stranger");
    fs.mkdirSync(path.join(stranger, "bin"), { recursive: true });
    fs.writeFileSync(path.join(stranger, "keep.txt"), "mine");
    const kept = await install(["-InstallDir", stranger, "-Uninstall", "-Purge", "-NoPathUpdate"]);
    assert.equal(kept.status, 0);
    assert.ok(fs.existsSync(path.join(stranger, "keep.txt")), "a folder without the install marker must keep unrelated files");
    assert.ok(fs.existsSync(path.join(stranger, "bin")), "a stranger's folder called bin is not ours to remove");
    assert.match(kept.out, /Nothing is installed/);
  });

  test("-Purge needs the install marker: a folder that is only NAMED .firas-code loses its program folders and nothing else", async () => {
    const dir = path.join(dirFor("named"), ".firas-code");
    fs.mkdirSync(path.join(dir, "app", "bin"), { recursive: true });
    fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app", "bin", "firas.js"), "x");
    fs.writeFileSync(path.join(dir, "keep.txt"), "mine");
    fs.writeFileSync(path.join(dir, "config.json"), "{}");
    const res = await install(["-InstallDir", dir, "-Uninstall", "-Purge", "-NoPathUpdate"]);
    assert.equal(res.status, 0, res.out);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["config.json", "keep.txt"], "the program folders go, the person's files stay");
    assert.match(res.out, /has no Firas Code install marker/);
    assert.doesNotMatch(res.out, /Everything in .* was deleted/);
  });

  test("-Purge does not take a marker that is a folder, or a bare folder with no program in it, for proof", async () => {
    const fake = dirFor("fake-marker");
    fs.mkdirSync(path.join(fake, ".firas-install"), { recursive: true });
    fs.writeFileSync(path.join(fake, "keep.txt"), "mine");
    const res = await install(["-InstallDir", fake, "-Uninstall", "-Purge", "-NoPathUpdate"]);
    assert.equal(res.status, 0, res.out);
    assert.ok(fs.existsSync(path.join(fake, "keep.txt")));
    const bare = path.join(dirFor("bare"), ".firas-code");
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, "keep.txt"), "mine");
    const none = await install(["-InstallDir", bare, "-Uninstall", "-Purge", "-NoPathUpdate"]);
    assert.equal(none.status, 0, none.out);
    assert.match(none.out, /Nothing is installed/);
    assert.ok(fs.existsSync(path.join(bare, "keep.txt")), "a folder with only a matching name is never deleted");
  });

  test("options can come from environment variables (the plain `| iex` form)", async () => {
    const dir = dirFor("envtwins");
    const env = cleanEnv({ FIRAS_INSTALL_DIR: dir, FIRAS_INSTALL_ARCHIVE: appZip, FIRAS_NO_LAUNCH: "1", FIRAS_NO_PATH_UPDATE: "1" });
    const res = await run(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "Get-Content -Raw -LiteralPath $env:SCRIPT_UNDER_TEST | Invoke-Expression; exit $LASTEXITCODE"], { env: { ...env, SCRIPT_UNDER_TEST: script } });
    assert.equal(res.status, 0, res.out);
    assert.ok(fs.existsSync(path.join(dir, "app", "bin", "firas.js")));
    const gone = await run(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "Get-Content -Raw -LiteralPath $env:SCRIPT_UNDER_TEST | Invoke-Expression; exit $LASTEXITCODE"], { env: { ...env, FIRAS_UNINSTALL: "1", SCRIPT_UNDER_TEST: script } });
    assert.equal(gone.status, 0, gone.out);
    assert.ok(!fs.existsSync(path.join(dir, "app")));
  });

  test("the scriptblock form takes named options and reports the exit code without closing the session", async () => {
    const dir = dirFor("sblock");
    const body = "$sb = [scriptblock]::Create((Get-Content -Raw -LiteralPath $env:SCRIPT_UNDER_TEST)); & $sb -InstallDir $env:T_DIR -ArchiveUrl $env:T_ZIP -NoLaunch -NoPathUpdate -Code FC2-AAAAA-BBBBB; 'last=' + $LASTEXITCODE; & $sb -Bogus; 'bad=' + $LASTEXITCODE; 'session still alive'";
    const res = await run(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", body], { env: cleanEnv({ SCRIPT_UNDER_TEST: script, T_DIR: dir, T_ZIP: appZip }) });
    assert.match(res.out, /last=0/);
    assert.match(res.out, /enter the access code/, "a code that is not launched with must be asked for later");
    assert.match(res.out, /bad=2/);
    assert.match(res.out, /session still alive/);
    assert.ok(fs.existsSync(path.join(dir, "app", "bin", "firas.js")));
  });

  test("the `iex \"& { $(irm …) } -Option\"` one-liner form passes its options too", async () => {
    const dir = dirFor("amp");
    const body = "$text = Get-Content -Raw -LiteralPath $env:SCRIPT_UNDER_TEST; Invoke-Expression \"& { $text } -InstallDir '$env:T_DIR' -ArchiveUrl '$env:T_ZIP' -NoLaunch -NoPathUpdate\"; 'last=' + $LASTEXITCODE";
    const res = await run(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", body], { env: cleanEnv({ SCRIPT_UNDER_TEST: script, T_DIR: dir, T_ZIP: appZip }) });
    assert.match(res.out, /last=0/);
    assert.ok(fs.existsSync(path.join(dir, "app", "bin", "firas.js")), res.out);
  });

  test("an access code reaches the first launch in its environment, never on its command line; a malformed one is ignored with a warning", async () => {
    const dir = dirFor("launch");
    const env = cleanEnv({ FIRAS_FORCE_LAUNCH: "1" });
    const good = await install(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoPathUpdate", "-Code", "FC2-ABCDE-FGHJK"], { env });
    assert.equal(good.status, 0, good.out);
    assert.match(good.out, /fake-firas \r?\n/, "the app gets no arguments");
    assert.doesNotMatch(good.out, /--code/);
    assert.match(good.out, /env-code=FC2-ABCDE-FGHJK/);
    const bad = await install(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoPathUpdate", "-Code", "not-a-code"], { env });
    assert.equal(bad.status, 0, bad.out);
    assert.match(bad.out, /looks wrong/);
    assert.doesNotMatch(bad.out, /not-a-code/);
    assert.match(bad.out, /fake-firas \r?\n/);
    assert.match(bad.out, /env-code=\r?\n/);
  });

  test("the launch leaves the caller's own FIRAS_CODE as it was", async () => {
    const dir = dirFor("launch-env");
    const inSession = prior => {
      const set = prior === null ? "Remove-Item Env:\\FIRAS_CODE -ErrorAction SilentlyContinue" : `$env:FIRAS_CODE = '${prior}'`;
      const body = `${set}; $sb = [scriptblock]::Create((Get-Content -Raw -LiteralPath $env:SCRIPT_UNDER_TEST)); & $sb -InstallDir $env:T_DIR -ArchiveUrl $env:T_ZIP -NoPathUpdate -Code FC2-AAAAA-BBBBB; 'after=[' + $env:FIRAS_CODE + ']'`;
      return run(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", body], { env: cleanEnv({ FIRAS_FORCE_LAUNCH: "1", SCRIPT_UNDER_TEST: script, T_DIR: dir, T_ZIP: appZip }) });
    };
    const blank = await inSession(null);
    assert.match(blank.out, /env-code=FC2-AAAAA-BBBBB/);
    assert.match(blank.out, /after=\[\]/, "no code is left behind in the session");
    const kept = await inSession("FC2-KEEP0-KEEP0");
    assert.match(kept.out, /env-code=FC2-AAAAA-BBBBB/, "the code given to the installer wins for the launch");
    assert.match(kept.out, /after=\[FC2-KEEP0-KEEP0\]/, "the session's own value comes back");
  });

  test("writes the .ps1 shim when scripts are allowed, and it passes arguments and exit codes through", async () => {
    const dir = dirFor("psshim");
    const res = await install(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoLaunch", "-NoPathUpdate"], { env: cleanEnv({ FIRAS_FORCE_PS_SHIM: "1" }) });
    assert.equal(res.status, 0, res.out);
    const shim = path.join(dir, "bin", "firas.ps1");
    assert.ok(fs.existsSync(shim));
    const ran = await run(PS, [...psArgs(shim), "one", "two words"], { env: cleanEnv({ FAKE_EXIT: "5" }) });
    assert.equal(ran.status, 5);
    assert.match(ran.stdout, /fake-firas one\|two words/);
    const stale = await install(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoLaunch", "-NoPathUpdate"]);
    assert.equal(stale.status, 0);
    assert.ok(!fs.existsSync(shim), "a .ps1 shim must be removed when scripts are not allowed (PowerShell would pick it over the .cmd)");
  });

  describe("user PATH (a scratch registry key stands in for the real one)", () => {
    const keyPath = "HKCU\\Software\\FirasCodeTest\\PathCase";
    const keyName = "Software\\FirasCodeTest\\PathCase";
    const reg = (...args) => spawnSync("reg", args, { encoding: "utf8" });
    const seed = (value, type = "REG_EXPAND_SZ") => {
      reg("delete", keyPath, "/f");
      if (value !== null) assert.equal(reg("add", keyPath, "/v", "Path", "/t", type, "/d", value, "/f").status, 0);
      else assert.equal(reg("add", keyPath, "/f").status, 0);
    };
    const current = () => {
      const res = reg("query", keyPath, "/v", "Path");
      const match = /Path\s+(REG_\w+)\s+(.*)\r?\n/.exec(res.stdout);
      return match ? { type: match[1], value: match[2].trim() } : null;
    };
    const withKey = (args, env = {}) => install(args, { env: cleanEnv({ FIRAS_TEST_PATH_KEY: keyName, ...env }) });
    after(() => { reg("delete", "HKCU\\Software\\FirasCodeTest", "/f"); });

    test("adds the folder once, keeps the value's type and other entries, and removes only its own entry", async () => {
      const dir = dirFor("pathcase");
      const bin = path.join(dir, "bin");
      const original = "%USERPROFILE%\\tools;C:\\Existing Tools";
      seed(original);
      const first = await withKey(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoLaunch"]);
      assert.equal(first.status, 0, first.out);
      assert.match(first.out, /Added .* to your user PATH/);
      assert.deepEqual(current(), { type: "REG_EXPAND_SZ", value: `${original};${bin}` });

      const second = await withKey(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoLaunch"]);
      assert.equal(second.status, 0, second.out);
      assert.match(second.out, /already on your PATH/);
      assert.deepEqual(current(), { type: "REG_EXPAND_SZ", value: `${original};${bin}` }, "no duplicate entry");

      const gone = await withKey(["-InstallDir", dir, "-Uninstall"]);
      assert.equal(gone.status, 0, gone.out);
      assert.match(gone.out, /Removed .* from your user PATH/);
      assert.deepEqual(current(), { type: "REG_EXPAND_SZ", value: original });
    });

    test("recognises its folder written another way (case, trailing slash) and a plain string value keeps its type", async () => {
      const dir = dirFor("pathcase2");
      seed(`C:\\A;${path.join(dir, "BIN").toUpperCase()}\\`, "REG_SZ");
      const res = await withKey(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoLaunch"]);
      assert.equal(res.status, 0, res.out);
      assert.match(res.out, /already on your PATH/);
      seed("C:\\A", "REG_SZ");
      await withKey(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoLaunch"]);
      assert.equal(current().type, "REG_SZ");
    });

    test("creates the value when there is none", async () => {
      const dir = dirFor("pathcase3");
      seed(null);
      const res = await withKey(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoLaunch"]);
      assert.equal(res.status, 0, res.out);
      assert.deepEqual(current(), { type: "REG_EXPAND_SZ", value: path.join(dir, "bin") });
    });

    test("-NoPathUpdate leaves it alone", async () => {
      const dir = dirFor("pathcase4");
      seed("C:\\A");
      const res = await withKey(["-ArchiveUrl", appZip, "-InstallDir", dir, "-NoLaunch", "-NoPathUpdate"]);
      assert.equal(res.status, 0, res.out);
      assert.deepEqual(current(), { type: "REG_EXPAND_SZ", value: "C:\\A" });
    });
  });

  test("`irm <address> | iex` works end to end against a web server", async () => {
    const server = await startServer({ "/install.ps1": (req, res) => { res.setHeader("content-type", "text/plain; charset=utf-8"); res.end(fs.readFileSync(script)); } });
    try {
      const dir = dirFor("irm");
      const env = cleanEnv({ FIRAS_INSTALL_DIR: dir, FIRAS_INSTALL_ARCHIVE: appZip, FIRAS_NO_LAUNCH: "1", FIRAS_NO_PATH_UPDATE: "1" });
      const res = await run(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted", "-Command", `irm ${server.origin}/install.ps1 | iex; exit $LASTEXITCODE`], { env });
      assert.equal(res.status, 0, res.out);
      assert.ok(fs.existsSync(path.join(dir, "app", "bin", "firas.js")));
    } finally {
      await server.close();
    }
  });

  describe("failure modes", () => {
    const base = name => ["-InstallDir", dirFor(name), "-NoLaunch", "-NoPathUpdate"];

    test("a missing archive exits 3 and leaves no half-installed app", async () => {
      const res = await install([...base("f-missing"), "-ArchiveUrl", path.join(work, "nope.zip")]);
      assert.equal(res.status, 3);
      assert.match(res.out, /not found/);
      assert.ok(!fs.existsSync(path.join(dirFor("f-missing"), "app")));
    });

    test("an archive that is not a zip exits 4", async () => {
      const junk = path.join(work, "junk.zip");
      fs.writeFileSync(junk, "this is not a zip file at all");
      const res = await install([...base("f-junk"), "-ArchiveUrl", junk]);
      assert.equal(res.status, 4, res.out);
      assert.match(res.out, /damaged or incomplete/);
    });

    test("a zip without bin/firas.js exits 4 and an existing install survives", async () => {
      const dir = dirFor("f-layout");
      assert.equal((await install(["-InstallDir", dir, "-ArchiveUrl", appZip, "-NoLaunch", "-NoPathUpdate"])).status, 0);
      const wrong = path.join(work, "wrong.zip");
      writeZip(wrong, [{ name: "x/" }, { name: "x/readme.txt", data: Buffer.from("hello") }]);
      const res = await install(["-InstallDir", dir, "-ArchiveUrl", wrong, "-NoLaunch", "-NoPathUpdate"]);
      assert.equal(res.status, 4, res.out);
      assert.match(res.out, /does not look like Firas Code 2/);
      assert.ok(fs.existsSync(path.join(dir, "app", "bin", "firas.js")), "the previous version must still be there");
      assert.ok(!fs.existsSync(path.join(dir, "app.new")));
    });

    test("entries that climb out of the destination are refused", async () => {
      const evil = path.join(work, "evil.zip");
      writeZip(evil, fakeAppEntries("evil-main", { extra: [{ name: "evil-main/../../escaped.txt", data: Buffer.from("boom") }] }));
      const dir = dirFor("f-evil");
      const res = await install(["-InstallDir", dir, "-ArchiveUrl", evil, "-NoLaunch", "-NoPathUpdate"]);
      assert.equal(res.status, 4, res.out);
      assert.ok(!fs.existsSync(path.join(path.dirname(dir), "escaped.txt")));
      assert.ok(!fs.existsSync(path.join(dir, "escaped.txt")));
    });

    test("an unreachable address exits 3 with a network hint", async () => {
      const res = await install([...base("f-offline"), "-ArchiveUrl", "http://127.0.0.1:9/app.zip"], { timeout: 60000 });
      assert.equal(res.status, 3, res.out);
      assert.match(res.out, /Check your internet connection/);
    });

    test("an HTTP 404 exits 3 and says so", async () => {
      const server = await startServer({});
      try {
        const res = await install([...base("f-404"), "-ArchiveUrl", server.origin + "/missing.zip"]);
        assert.equal(res.status, 3, res.out);
        assert.match(res.out, /not found/);
      } finally {
        await server.close();
      }
    });

    test("an install folder that cannot be created exits 5", async () => {
      const blocker = path.join(work, "blocker");
      fs.writeFileSync(blocker, "a file, not a folder");
      const res = await install(["-InstallDir", path.join(blocker, "inside"), "-ArchiveUrl", appZip, "-NoLaunch", "-NoPathUpdate"]);
      assert.equal(res.status, 5, res.out);
      assert.match(res.out, /Cannot write to/);
    });
  });

  describe("download over HTTP and the private Node.js copy", () => {
    let server;
    let nodeZip;
    let sums;
    let badSums = false;

    before(async () => {
      nodeZip = path.join(work, "node-v99.0.0-win-x64.zip");
      writeZip(nodeZip, [
        { name: "node-v99.0.0-win-x64/" },
        { name: "node-v99.0.0-win-x64/node.exe", data: fs.readFileSync(process.execPath) },
        { name: "node-v99.0.0-win-x64/LICENSE", data: Buffer.from("licence text") },
        { name: "node-v99.0.0-win-x64/node_modules/npm/package.json", data: Buffer.from("{}") }
      ], { store: true });
      sums = `${sha256File(nodeZip)}  node-v99.0.0-win-x64.zip\n${"0".repeat(64)}  node-v99.0.0-win-arm64.zip\n`;
      const index = [
        { version: "v100.0.0", date: "2026-10-01", files: ["win-x64-zip"], lts: false },
        { version: "v99.0.0", date: "2026-04-01", files: ["win-x64-zip", "win-arm64-zip"], lts: "Test" },
        { version: "v98.0.0", date: "2025-10-01", files: ["win-x64-zip"], lts: "Older" }
      ];
      server = await startServer({
        "/dist/index.json": JSON.stringify(index),
        "/dist/v99.0.0/node-v99.0.0-win-x64.zip": (req, res) => { res.statusCode = 200; fs.createReadStream(nodeZip).pipe(res); },
        "/dist/v99.0.0/SHASUMS256.txt": (req, res) => { res.statusCode = 200; res.end(badSums ? sums.replace(/^./, c => (c === "0" ? "1" : "0")) : sums); },
        "/app.zip": fs.readFileSync(appZip)
      });
    });
    after(async () => { await server.close(); });

    const nodeEnv = extra => cleanEnv({ FIRAS_NODE_INDEX_URL: server.origin + "/dist/index.json", FIRAS_NODE_DIST_URL: server.origin + "/dist", ...extra }, { withoutNode: true });

    test("downloads the newest LTS build, verifies its checksum, keeps only node.exe and uses it from the shim", async () => {
      const dir = dirFor("nodedl");
      const res = await install(["-InstallDir", dir, "-ArchiveUrl", server.origin + "/app.zip", "-NoLaunch", "-NoPathUpdate"], { env: nodeEnv() });
      assert.equal(res.status, 0, res.out);
      assert.match(res.out, /Downloading a private copy of Node\.js v99\.0\.0/);
      assert.deepEqual(fs.readdirSync(path.join(dir, "runtime")).sort(), ["LICENSE", "node.exe"]);
      assert.ok(!server.requests.includes("/dist/v98.0.0/node-v98.0.0-win-x64.zip"));
      const ran = await run(path.join(dir, "bin", "firas.cmd"), ["hello"], { env: nodeEnv() });
      assert.equal(ran.status, 0, ran.out);
      assert.match(ran.stdout, /fake-firas hello/);
      assert.ok(ran.stdout.toLowerCase().includes(path.join(dir, "runtime", "node.exe").toLowerCase()), ran.stdout);

      const before = server.requests.filter(r => r.endsWith(".zip") && r.includes("node-")).length;
      const again = await install(["-InstallDir", dir, "-ArchiveUrl", server.origin + "/app.zip", "-NoLaunch", "-NoPathUpdate"], { env: nodeEnv() });
      assert.equal(again.status, 0, again.out);
      assert.match(again.out, /private copy/);
      assert.equal(server.requests.filter(r => r.endsWith(".zip") && r.includes("node-")).length, before, "a valid private Node.js must not be downloaded twice");
    });

    test("a checksum mismatch exits 4 and installs nothing", async () => {
      badSums = true;
      try {
        const dir = dirFor("nodebad");
        const res = await install(["-InstallDir", dir, "-ArchiveUrl", server.origin + "/app.zip", "-NoLaunch", "-NoPathUpdate"], { env: nodeEnv() });
        assert.equal(res.status, 4, res.out);
        assert.match(res.out, /does not match its published SHA-256/);
        assert.ok(!fs.existsSync(path.join(dir, "runtime")));
        assert.ok(!fs.existsSync(path.join(dir, "app")));
      } finally {
        badSums = false;
      }
    });
  });

  describe("Arabic lines", () => {
    // Reference shaper written independently of the installer: presentation forms come in the order isolated, final, initial, medial.
    const forms = new Map();
    for (let cp = 0xfe80; cp <= 0xfef4; cp++) {
      const glyph = String.fromCodePoint(cp);
      const base = glyph.normalize("NFKC");
      if ([...base].length === 1) forms.set(base, [...(forms.get(base) || []), glyph]);
    }
    const ligatures = new Map();
    for (let cp = 0xfef5; cp <= 0xfefc; cp++) {
      const glyph = String.fromCodePoint(cp);
      const base = glyph.normalize("NFKC");
      ligatures.set(base, [...(ligatures.get(base) || []), glyph]);
    }
    const joinsNext = ch => (forms.get(ch) || []).length === 4;
    const joinsPrev = ch => (forms.get(ch) || []).length >= 2;
    function shape(word) {
      const chars = [...word];
      let out = "";
      for (let i = 0; i < chars.length; i++) {
        const prev = i > 0 && joinsNext(chars[i - 1]);
        const pair = chars[i] + (chars[i + 1] || "");
        if (ligatures.has(pair)) { out += ligatures.get(pair)[prev ? 1 : 0]; i++; continue; }
        const set = forms.get(chars[i]);
        const next = joinsNext(chars[i]) && i + 1 < chars.length && joinsPrev(chars[i + 1]);
        out += prev && next ? set[3] : prev && set.length > 1 ? set[1] : next ? set[2] : set[0];
      }
      return out;
    }
    const visualWord = word => [...shape(word)].reverse().join("");
    const arabicLines = text => text.split(/\r?\n/).map(l => l.trim()).filter(l => /[\uFE70-\uFEFF]/.test(l));
    const utf8 = (args, env = {}) => run(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; & '${script}' ${args}`], { env: cleanEnv(env) });

    test("are joined and reordered for a terminal that draws one code point per cell", async () => {
      const res = await utf8("-Bogus");
      assert.deepEqual(arabicLines(res.out), [[visualWord("معروف"), visualWord("غير"), visualWord("خيار")].join(" ")]);
    });

    test("keep Latin words and numbers in reading order inside a right-to-left line", async () => {
      const dir = dirFor("arabic");
      const res = await utf8(`-InstallDir '${dir}' -ArchiveUrl '${appZip}' -NoLaunch -NoPathUpdate`);
      assert.equal(res.status, 0, res.out);
      const lines = arabicLines(res.out);
      const shown = JSON.stringify(lines);
      assert.ok(lines.includes(["2", visualWord("كود"), visualWord("فراس"), visualWord("تثبيت")].join(" ")), shown);
      assert.ok(lines.includes(["Node.js", visualWord("من"), visualWord("التحقق")].join(" ")), shown);
      assert.ok(lines.includes(["firas", ":" + visualWord("اكتب"), visualWord("للبدء")].join(" ")), shown);
    });

    test("are left out when FIRAS_LANG=en", async () => {
      const res = await utf8("-Bogus", { FIRAS_LANG: "en" });
      assert.doesNotMatch(res.out, /[؀-ۿﹰ-﻿]/);
      assert.match(res.out, /Unknown option: -Bogus/);
    });

    test("stay as plain logical text when FIRAS_ARABIC=off", async () => {
      const res = await utf8("-Bogus", { FIRAS_ARABIC: "off" });
      assert.equal(arabicLines(res.out).length, 0);
      assert.ok(res.out.includes("خيار غير معروف"), res.out);
    });
  });
});
