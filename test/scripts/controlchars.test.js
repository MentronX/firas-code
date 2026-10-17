// Published text files must not carry stray control characters. A form feed once sat inside an installer message
// ("bin<FF>iras.js") and printed as garbage; nothing else would have noticed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "./helpers.js";

// The installers are not part of the npm package (the updater fetches them from the repository) but are published.
const published = [...JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).files, "scripts"];
const BINARY = /\.(png|jpe?g|gif|ico|zip|gz|tgz|woff2?|ttf|otf|exe|node)$/i;

function collect(entry, out = []) {
  const full = path.join(projectRoot, entry);
  let stat;
  try { stat = fs.statSync(full); } catch { return out; }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(full)) if (name !== "node_modules" && name !== ".git") collect(path.join(entry, name), out);
  } else if (!BINARY.test(entry)) out.push(entry);
  return out;
}

/** Characters that print as nothing useful, with their position. Tab, line feed and the carriage return of a CRLF line end are fine. */
function strayControls(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10) continue;
    if (code === 13 && text.charCodeAt(i + 1) === 10) continue;
    if (code < 32 || code === 127) {
      const line = text.slice(0, i).split("\n").length;
      found.push(`U+${code.toString(16).toUpperCase().padStart(4, "0")} at line ${line}`);
    }
  }
  return found;
}

test("the detector finds what it is meant to find", () => {
  assert.deepEqual(strayControls("fine\ttext\nwith\r\nlines"), []);
  assert.deepEqual(strayControls("bin\firas.js"), ["U+000C at line 1"]);
  assert.deepEqual(strayControls("a\nb\u001b[0m"), ["U+001B at line 2"]);
  assert.deepEqual(strayControls("a\rb"), ["U+000D at line 1"], "a lone carriage return is not a line end");
  assert.deepEqual(strayControls("a\u0000b\u007fc"), ["U+0000 at line 1", "U+007F at line 1"]);
});

test("no published text file has a stray control character", () => {
  const files = published.flatMap(entry => collect(entry));
  assert.ok(files.includes("README.md") && files.includes(path.join("scripts", "install.ps1")) && files.includes(path.join("scripts", "install.sh")), "the scan must cover the installers and the README");
  const problems = [];
  for (const rel of files) {
    const bad = strayControls(fs.readFileSync(path.join(projectRoot, rel), "utf8"));
    if (bad.length) problems.push(`${rel}: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ` (+${bad.length - 5} more)` : ""}`);
  }
  assert.deepEqual(problems, []);
});

test("the installer messages that name a file path spell its backslash out", () => {
  const ps1 = fs.readFileSync(path.join(projectRoot, "scripts", "install.ps1"), "utf8");
  assert.ok(ps1.includes("(bin\\firas.js is missing)"));
});
