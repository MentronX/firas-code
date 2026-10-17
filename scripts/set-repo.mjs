#!/usr/bin/env node
// Fills in the repository address once it is known:  node scripts/set-repo.mjs owner/repo
// Replaces the placeholder in every publishable text file (README, both installers, src/brand.js, ...).
//   --check          exit 1 if the placeholder is still anywhere (use before publishing)
//   --from owner/x   replace a previous value instead of the placeholder (to fix a typo later)
//   --dry-run        show what would change, write nothing
//   --root <dir>     work on another folder (tests)
// The placeholder is built from pieces below so this file never matches itself.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPublishedFiles, looksBinary, isMain } from "./lib/tree.mjs";

export const PLACEHOLDER = ["__", "REPO", "__"].join("");

/** Accepts owner/repo, a github.com address, git@github.com:owner/repo.git or github:owner/repo. Returns "owner/repo" or null. */
export function parseRepo(input) {
  if (typeof input !== "string") return null;
  let value = input.trim();
  value = value.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]/i, "").replace(/^git@github\.com:/i, "").replace(/^github:/i, "");
  value = value.replace(/\/+$/, "").replace(/\.git$/i, "");
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(value);
  if (!match || match[2] === "." || match[2] === "..") return null;
  return `${match[1]}/${match[2]}`;
}

/** Replaces `from` with `to` in every publishable text file. Returns [{ file, count }] for the files that contain it. */
export function replaceInTree(root, from, to, { write = true } = {}) {
  const changed = [];
  for (const rel of listPublishedFiles(root)) {
    const full = path.join(root, rel);
    let buffer;
    try { buffer = fs.readFileSync(full); } catch { continue; }
    if (looksBinary(rel, buffer)) continue;
    const text = buffer.toString("utf8");
    if (!text.includes(from)) continue;
    const count = text.split(from).length - 1;
    if (write) fs.writeFileSync(full, text.split(from).join(to));
    changed.push({ file: rel, count });
  }
  return changed;
}

export function findPlaceholders(root, token = PLACEHOLDER) {
  return replaceInTree(root, token, token, { write: false });
}

function usage() {
  return [
    "Usage:",
    "  node scripts/set-repo.mjs <owner/repo> [--dry-run] [--from <old owner/repo>]",
    "  node scripts/set-repo.mjs --check",
    "",
    "Example:",
    "  node scripts/set-repo.mjs firas/firas-code"
  ].join("\n");
}

export function main(argv, { out = s => process.stdout.write(s + "\n"), err = s => process.stderr.write(s + "\n"), defaultRoot } = {}) {
  let root = defaultRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let check = false;
  let dryRun = false;
  let from = null;
  let target = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") check = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--root") root = path.resolve(argv[++i] || "");
    else if (arg === "--from") from = argv[++i];
    else if (arg === "-h" || arg === "--help") { out(usage()); return 0; }
    else if (arg.startsWith("-")) { err(`Unknown option: ${arg}\n\n${usage()}`); return 2; }
    else if (target === null) target = arg;
    else { err(`Unexpected argument: ${arg}\n\n${usage()}`); return 2; }
  }

  if (check) {
    const left = findPlaceholders(root);
    if (!left.length) { out("No repository placeholder is left."); return 0; }
    err("The repository placeholder is still present:");
    for (const item of left) err(`  ${item.file} (${item.count})`);
    err("Run: node scripts/set-repo.mjs <owner/repo>");
    return 1;
  }

  if (target === null) { err(usage()); return 2; }
  const repo = parseRepo(target);
  if (!repo) { err(`"${target}" is not a repository like owner/repo.`); return 2; }
  let token = PLACEHOLDER;
  if (from !== null) {
    const old = parseRepo(from);
    if (!old) { err(`"${from}" is not a repository like owner/repo.`); return 2; }
    token = old;
  }
  const changed = replaceInTree(root, token, repo, { write: !dryRun });
  if (!changed.length) {
    out(from !== null ? `Nothing to change: "${token}" does not appear in any file.` : `Nothing to change: no placeholder found (already set to a repository?).`);
    return 0;
  }
  const total = changed.reduce((sum, item) => sum + item.count, 0);
  out(`${dryRun ? "Would set" : "Set"} ${repo} in ${changed.length} file${changed.length === 1 ? "" : "s"} (${total} place${total === 1 ? "" : "s"}):`);
  for (const item of changed) out(`  ${item.file} (${item.count})`);
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
