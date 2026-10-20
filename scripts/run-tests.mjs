// Runs every *.test.js under test/ (and under dev/test/ when that folder exists on this machine) with Node's built-in
// runner. Works on Node 18+ (no glob support needed).
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.test\.(m?js)$/.test(name)) files.push(full);
  }
}
walk(join(root, "test"));
if (existsSync(join(root, "dev", "test"))) walk(join(root, "dev", "test"));

if (!files.length) {
  console.error("no test files found under test/");
  process.exit(1);
}
const filter = process.argv[2];
const picked = filter ? files.filter(f => f.includes(filter)) : files;
// The UI tests describe the modern-terminal glyphs. A test runner on Windows has no WT_SESSION, so the
// app would otherwise pick the classic-console set and the expectations would compare different symbols.
const res = spawnSync(process.execPath, ["--test", ...picked], {
  stdio: "inherit", cwd: root,
  env: { ...process.env, FIRAS_GLYPHS: process.env.FIRAS_GLYPHS || "full" },
});
process.exit(res.status ?? 1);
