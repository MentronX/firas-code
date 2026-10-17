import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isPlainCommand, isStrictReadonly, classifyCommand } from "../../src/tools/classify.js";
import { tmpProject } from "./helpers.js";

// ------------------------------------------------------------------------------------------------ isPlainCommand

const PLAIN_YES = [
  "ls", "ls -la", "git status", "git log --oneline -n 5", "npm --version", "node script.js", "a/b/c.txt", "./x", "../x", "x=1", "foo@bar.com",
  "a,b", "a+b", "C:/x/y", "--flag=value", "-n", "-", "a_b-c.d", "100", "git diff main..dev", "FOO=bar npm test", "ls  -la", "python -m pytest -x",
  "a:b", "http://example.com/x", "/usr/bin/env", "x".repeat(400), ".env", "...", "a.b.c", "A-Z_0-9",
];

const PLAIN_NO = [
  "", " ", " ls", "ls ", "ls\t-la", "ls\n", "\nls", "ls\rid", "ls\0", "ls\x7f", "ls\x1b[0m",
  "ls $HOME", "ls ${HOME}", "ls $(id)", "ls `id`", "ls 'a'", "ls \"a\"", "ls a;b", "ls a; id", "ls && id", "ls || id", "ls | cat", "ls > out", "ls < in",
  "ls 2>&1", "ls &", "cat <<EOF", "cat <<'EOF'", "ls {a,b}", "ls {}", "ls ~", "ls ~a", "ls ^a", "ls *", "ls ?", "ls [a]", "ls ]", "ls !x", "ls #c", "ls a#b",
  "ls \\x", "ls a\\b", "ls %PATH%", "ls (a)", "ls a)", "ls a|b", "ls a<b", "ls a>b", "ls a&b", "ls a$b", "ls a`b", "ls a'b", "ls a\"b",
  "echo تجربة", "ls é", "ls \u201cx\u201d", "ls \u2018x\u2019", "ls \u201d", "ls\u00a0-la", "ls\u2028id", "ls\u0085id", "ls \u202e", "ls \u200b", "ls \ufeff",
  "x".repeat(401), ": x", "=x", "@x", "+x", ",x", "ls :x", "echo $[1<<EOF]", "echo $((1+2))", "a=b;c", "ls -la | head", "cd .. && ls", "ls\u2029id",
];

test("isPlainCommand accepts ordinary words and nothing a shell treats specially", () => {
  const wrongYes = PLAIN_YES.filter(text => !isPlainCommand(text));
  const wrongNo = PLAIN_NO.filter(text => isPlainCommand(text));
  assert.deepEqual(wrongYes, [], "should be plain");
  assert.deepEqual(wrongNo, [], "should NOT be plain");
  assert.ok(PLAIN_YES.length + PLAIN_NO.length >= 90);
  for (const odd of [null, undefined]) assert.equal(isPlainCommand(odd), false);
});

test("isPlainCommand: every printable ASCII character is decided deliberately", () => {
  const allowedInside = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./:=@+,~^-");
  for (let code = 0x20; code <= 0x7e; code++) {
    const ch = String.fromCharCode(code);
    if (ch === " ") continue;
    assert.equal(isPlainCommand(`a${ch}b`), allowedInside.has(ch), `a${ch}b`);
  }
  for (let code = 0; code < 0x20; code++) assert.equal(isPlainCommand(`a${String.fromCharCode(code)}b`), false, `control ${code}`);
  assert.equal(isPlainCommand(`a${String.fromCharCode(0x7f)}b`), false);
});

// ---------------------------------------------------------------------------------------------- isStrictReadonly

function world() {
  const p = tmpProject({
    "package.json": "{}", "README.md": "r", "notes.txt": "n", "src/app.js": "a", "src/util.js": "u", ".env": "SECRET=1", ".env.local": "SECRET=2",
    ".env.example": "SECRET=", ".git/config": "[core]", ".git/HEAD": "ref", "secrets/id_rsa": "k", "key.pem": "k", ".npmrc": "t", "credentials.json": "{}",
    ".ssh/config": "h", "secrets.yaml": "s", "docs/guide.md": "g",
  });
  const outside = tmpProject({ "note.txt": "outside" });
  let linked = true;
  try { fs.symlinkSync(outside.dir, path.join(p.dir, "link"), process.platform === "win32" ? "junction" : "dir"); } catch { linked = false; }
  const ctx = (kind = "bash") => ({ kind, cwd: p.dir, platform: process.platform, env: process.env });
  return { p, outside, linked, ctx, cleanup() { p.cleanup(); outside.cleanup(); } };
}

const STRICT_YES = [
  "pwd", "pwd -L", "pwd -P", "whoami", "hostname", "date", "date -u", "uname", "uname -a", "uname -s", "echo", "echo hello world", "echo a,b", "which node",
  "which node git", "which -a node",
  "ls", "ls -la", "ls -1A", "ls -R", "ls src", "ls -la src", "ls src package.json", "ls docs/", "ls .env.example",
  "cat package.json", "cat -n README.md", "cat src/app.js package.json", "cat .env.example", "head package.json", "head -n 5 README.md", "head -5 README.md",
  "head -c 100 notes.txt", "tail -n 20 src/app.js", "tail -20 src/app.js", "tail README.md", "wc -l src/app.js", "wc README.md", "wc -w src/app.js",
  "git status", "git status -s", "git status --short --branch", "git status --porcelain=v2", "git log", "git log --oneline -n 5", "git log -5", "git log --stat",
  "git log --oneline --graph --decorate", "git log -p", "git diff", "git diff --cached", "git diff --stat", "git diff --name-only", "git diff HEAD", "git diff main..dev",
  "git diff -- src/app.js", "git diff HEAD -- src", "git show", "git show HEAD", "git show --stat", "git branch", "git branch -a", "git branch -vv", "git branch --list",
  "git branch --show-current", "git rev-parse HEAD", "git rev-parse --show-toplevel", "git rev-parse --abbrev-ref HEAD", "git ls-files", "git ls-files src", "git describe --tags",
  "git shortlog -s", "git --version", "git show HEAD~1", "git diff HEAD^", "git log HEAD~3..HEAD", "uname -sr", "wc -lw src/app.js", "cat -nb README.md", "node --version", "node -v", "npm --version", "npm -v", "python --version", "python3 -V", "pip --version", "tsc -v", "cargo --version", "dotnet --version",
  "java -version", "go --version", "deno --version", "make --version",
];
const STRICT_YES_PS = [
  "Get-ChildItem", "Get-ChildItem -Recurse src", "gci -Force", "dir", "ls", "ls -Force src", "Get-Content package.json", "Get-Content package.json -TotalCount 5",
  "gc -Raw README.md", "Get-Content -Tail 10 src/app.js", "cat package.json", "type package.json", "echo hello", "Write-Output hello", "node --version", "git status",
];

const STRICT_NO = [
  // not on the list
  "rm x", "cp a b", "mv a b", "mkdir build", "touch x", "node script.js", "npm test", "npm run build", "curl http://example.com", "grep foo src", "grep -rn TODO .", "find . -name x",
  "sort notes.txt", "jq . package.json", "git commit", "git push", "git fetch", "git pull", "git checkout main", "git add .", "git reset", "git clean -n", "git stash", "git tag",
  "git remote -v", "git config --get user.name", "git config --list", "git ls-remote origin", "git ls-remote https://evil.example/x", "git help status",
  "npm ping", "npm view left-pad", "npm ls", "npm search x", "npm --registry=http://127.0.0.1:1/x ping", "npm --version --registry=http://127.0.0.1:1/x", "node --version --eval=1",
  "go env", "go env -w GOPROXY=http://evil.example", "go version", "env", "printenv", "set", "docker ps", "pip list", "python app.py", "sudo ls", "ssh host ls", "bash", "sh -c ls",
  // flags that write, follow, or reach out (and clustered flags, which the list does not parse)
  "sort --out=victim.txt notes.txt", "sort -o victim.txt notes.txt", "tail -f notes.txt", "tail -F notes.txt", "tail --follow notes.txt", "head -f notes.txt", "cat -v notes.txt", "cat -A notes.txt",
  "ls --color=always", "ls -Z", "ls -la --time=ctime", "date -s 12:00", "date --set=12:00", "hostname newname", "hostname -f", "uname -x", "uname --help", "pwd -x", "wc -x notes.txt",
  "git diff --output=out.txt", "git diff --output out.txt", "git log --output=out.txt", "git -c core.pager=x status", "git -C . status", "git --git-dir=x status", "git diff --ext-diff",
  "git diff --no-index a b", "git branch newname", "git branch -D old", "git branch -m a b", "git branch -d old", "git branch --set-upstream-to=x", "git show --format=x", "git log --exec=x",
  "git status --ignored", "git log -n", "git log -n x", "git log -- ../x", "git diff HEAD:x", "git diff -- .env", "git diff -- .git/config", "git ls-files .env",
  // paths that leave the project or touch credentials
  "cat .env", "cat .env.local", "cat .env.production", "cat secrets/id_rsa", "cat key.pem", "cat .npmrc", "cat credentials.json", "cat .ssh/config", "cat secrets.yaml", "cat id_rsa",
  "head .env", "tail .env.local", "wc .env", "ls .ssh", "ls secrets/id_rsa", "cat .git/config", "cat .git/HEAD", "ls .git", "ls src/.git", "cat .GIT/config",
  "cat ../x", "cat ../../etc/passwd", "cat src/../../x", "cat ./../x", "cat ..", "cat /etc/passwd", "cat /abs/path", "cat C:/Windows/win.ini", "cat C:x", "cat c:", "cat //host/share/x",
  "ls ..", "ls /", "ls /tmp", "ls C:/", "cat ~", "cat -", "cat",
  "cat NUL", "cat nul.txt", "cat con", "cat COM1", "cat lpt1.txt", "cat aux.c", "cat src/prn", "cat file.", "cat src/nul/x", "cat package.json:stream", "cat package.json::DATA", "cat a:b",
  // wildcards, quoting and expansion are not plain
  "cat .env*", "cat .e?v", "cat .en[v]", "cat .*", "head -n 5 .*", "cat *", "cat *.js", "cat 'package.json'", "cat \"package.json\"", "cat package.json $HOME", "cat $HOME/x",
  "cat package.json; id", "cat package.json && id", "cat package.json | head", "cat package.json > out", "cat < package.json", "cat package.json &", "cat `id`", "cat $(id)",
  "cat .env::$DATA", "cat file::$DATA", "ls ~/x", "echo $HOME", "echo `id`", "echo hi > out.txt", "echo hi; id", "echo 'hi'",
  // case and spelling of the program itself
  "LS", "Ls -la", "Git status", "GIT status", "CAT package.json", "./ls", "/bin/ls", "./git status", "node_modules/.bin/tsc -v", "ls.exe", "git.exe status",
  "  ls", "ls ", "", " ", "ls\tsrc", "ls\nid", "ls\rid",
  // limits
  "cat " + "a".repeat(200) + ".txt", "ls " + Array.from({ length: 25 }, (_, i) => `d${i}`).join(" "),
];

test("isStrictReadonly (bash): the short fixed list is accepted", () => {
  const w = world();
  try {
    const wrong = STRICT_YES.filter(cmd => !isStrictReadonly(cmd, w.ctx()));
    assert.deepEqual(wrong, []);
  } finally { w.cleanup(); }
});

test("isStrictReadonly (PowerShell): the short fixed list is accepted", () => {
  const w = world();
  try {
    const wrong = STRICT_YES_PS.filter(cmd => !isStrictReadonly(cmd, w.ctx("powershell")));
    assert.deepEqual(wrong, []);
  } finally { w.cleanup(); }
});

test("isStrictReadonly: everything else is refused", () => {
  const w = world();
  try {
    const wrong = STRICT_NO.filter(cmd => isStrictReadonly(cmd, w.ctx()));
    assert.deepEqual(wrong, []);
    assert.ok(STRICT_YES.length + STRICT_YES_PS.length + STRICT_NO.length >= 250, `${STRICT_YES.length + STRICT_YES_PS.length + STRICT_NO.length} cases`);
  } finally { w.cleanup(); }
});

test("isStrictReadonly (PowerShell): switches and paths that are not on the list are refused", () => {
  const w = world();
  try {
    const no = [
      "Get-Content -Path package.json", "Get-Content package.json -Wait", "Get-Content -Tail abc package.json", "Get-Content -Tail", "Get-Content env:PATH", "Get-ChildItem Env:",
      "Get-ChildItem -Path C:\\", "Get-ChildItem -Filter *.js", "Get-ChildItem -Include x", "Get-Content .env", "Get-Content .env.", "gc .e*", "Get-Content ..\\x",
      "Get-Process", "Set-Content a b", "Remove-Item x", "Get-Content package.json | Out-File x", "Get-Content \u201cpackage.json\u201d", "echo \u2019a\u2019", "Get-ChildItem\rSet-Content x y",
      "Get-ChildItem\u0085calc", "Get-ChildItem\u2028calc", "Select-String foo package.json", "Test-Path src", "type .env", "cat ..\\x", "Get-Content //host/share/x",
    ];
    assert.deepEqual(no.filter(cmd => isStrictReadonly(cmd, w.ctx("powershell"))), []);
  } finally { w.cleanup(); }
});

test("isStrictReadonly: cmd.exe is never trusted, whatever the command", () => {
  const w = world();
  try {
    for (const cmd of ["dir", "type package.json", "echo hi", "git status", "where node", "ver", "cd", "node --version"]) {
      assert.equal(isStrictReadonly(cmd, w.ctx("cmd")), false, cmd);
      assert.equal(classifyCommand(cmd, { shellKind: "cmd", cwd: w.p.dir }).risk, "normal", cmd);
    }
  } finally { w.cleanup(); }
});

test("isStrictReadonly: a link that leads out of the project is refused", { skip: process.platform === "win32" ? false : false }, () => {
  const w = world();
  try {
    if (!w.linked) return; // links cannot be made on this machine
    for (const cmd of ["cat link/note.txt", "ls link", "ls -la link", "head link/note.txt", "wc link/note.txt"]) assert.equal(isStrictReadonly(cmd, w.ctx()), false, cmd);
    assert.equal(isStrictReadonly("cat notes.txt", w.ctx()), true);
    assert.equal(classifyCommand("cat link/note.txt", { cwd: w.p.dir }).risk, "normal");
  } finally { w.cleanup(); }
});

test("isStrictReadonly: the folder the command runs in decides what 'inside' means", () => {
  const w = world();
  try {
    assert.equal(isStrictReadonly("cat package.json", w.ctx()), true);
    assert.equal(isStrictReadonly("cat package.json", { ...w.ctx(), cwd: path.join(w.p.dir, "src") }), true, "a file that does not exist there is still a path inside");
    assert.equal(isStrictReadonly("cat ../package.json", { ...w.ctx(), cwd: path.join(w.p.dir, "src") }), false);
    assert.equal(isStrictReadonly("ls", { ...w.ctx(), cwd: path.join(w.p.dir, "no-such-dir") }), true);
  } finally { w.cleanup(); }
});

test("classifyCommand only reports 'readonly' for a plain, listed command, and says why otherwise", () => {
  const w = world();
  try {
    const c = cmd => classifyCommand(cmd, { shellKind: "bash", cwd: w.p.dir });
    assert.equal(c("ls -la").risk, "readonly");
    assert.deepEqual(c("ls -la").keys, []);
    const unlisted = c("printf hello");
    assert.equal(unlisted.risk, "normal");
    assert.ok(unlisted.reasons.includes("unlisted"));
    assert.deepEqual(unlisted.keys, ["printf hello"], "a plain unlisted command can be remembered, by its whole text");
    assert.equal(c("printf 'hello'").remember, false);
    assert.equal(c("ls | cat").risk, "normal");
    assert.deepEqual(c("ls | cat").keys, []);
    assert.equal(c("rm -rf /").risk, "high");
  } finally { w.cleanup(); }
});
