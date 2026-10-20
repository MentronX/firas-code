// Skills: reusable instruction packs. The agent loads one by name with the Skill tool when a task matches it, and the
// person starts one by typing /name. A skill is a folder holding a SKILL.md:
//
//   ---
//   name: review
//   description: Review the uncommitted changes for real bugs
//   description-ar: (the same in Arabic, shown in the Arabic interface)
//   ---
//   The playbook, in Markdown, written for the model.
//
// Decisions:
//  - Three roots, in priority order: the project's .firas/skills, the person's own <home>/skills, and the built-in ones
//    in src/skills/builtin. A name found earlier shadows the same name later, so a project can replace a built-in
//    playbook with its own. One level deep only: <root>/<folder>/SKILL.md.
//  - A cloned repository's .firas/skills is as untrusted as its FIRAS.md: each SKILL.md is capped at 32 KB, the names
//    and descriptions are cleaned before they reach a menu or the prompt, and anything that is a link leading out of
//    its root is skipped (a repository must not make us read a file elsewhere on the machine by calling it a skill).
//    For the same reason the project's root must itself stay inside the project.
//  - A name taken by a built-in command is skipped: commands win. The caller says which names are taken (`reserved`),
//    so this module does not depend on the command registry (which depends on it).
//  - At most 50 skills, and the built-in and the person's own get their room first: a project's folders may replace
//    one of them by name, never push it out by number.
//  - The list is rebuilt for every prompt. Each root's folder list is read again every time (one readdir: on exFAT and
//    FAT adding a folder does not change the root's mtime, so a cache keyed on it would never see the new skill) and
//    each SKILL.md's header is cached by its own mtime and size: a new folder or an edited description shows at once.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLang } from "../i18n/index.js";
import { homeDir, isInside } from "../util/paths.js";
import { readCapped } from "../agent/prompt.js";
import { reveal } from "../tools/common.js";
import { stripAnsi } from "../text/ansi.js";

export const SKILL_FILE = "SKILL.md";
export const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SKILL_CAP_BYTES = 32 * 1024;
export const MAX_SKILLS = 50;
export const SCOPES = Object.freeze(["project", "user", "builtin"]);
/** Where the built-in skills ship: next to this file, so an installed copy finds its own. */
export const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin");

const DESCRIPTION_MAX = 200;
const FILES_MAX = 50;
const BOM = String.fromCharCode(0xfeff);

/** The project's skills folder for `cwd` and the person's own; both are shown by /skills. */
export function projectSkillsDir(cwd = process.cwd()) { return path.join(path.resolve(cwd), ".firas", "skills"); }
export function userSkillsDir() { return path.join(homeDir(), "skills"); }

/** [{ scope, dir, within? }] in priority order. `within`: the folder the root itself must stay inside. */
export function skillRoots(cwd = process.cwd()) {
  return [
    { scope: "project", dir: projectSkillsDir(cwd), within: path.resolve(cwd) },
    { scope: "user", dir: userSkillsDir() },
    { scope: "builtin", dir: BUILTIN_DIR },
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Front matter

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === "\"" && v.at(-1) === "\"") || (v[0] === "'" && v.at(-1) === "'"))) return v.slice(1, -1);
  return v;
}

/**
 * { data, body, found } for a SKILL.md. The header is the block between a first line "---" and the next "---": one
 * `key: value` per line (keys lower-cased; '..' and ".." unquoted; `key: |` or `key: >` takes the indented lines below
 * it, joined). A BOM and CRLF line ends are fine. Without a complete header the whole text is the body.
 */
export function parseFrontMatter(text) {
  const src = String(text ?? "").replace(new RegExp("^" + BOM), "").replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const fence = line => /^---[ \t]*$/.test(line);
  const end = fence(lines[0] ?? "") ? lines.findIndex((line, i) => i > 0 && fence(line)) : -1;
  if (end === -1) return { data: {}, body: src, found: false };
  const data = {};
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z][\w-]*)[ \t]*:(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < end && /^[ \t]+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(" ");
    } else value = unquote(value);
    data[m[1].toLowerCase()] = value;
  }
  return { data, body: lines.slice(end + 1).join("\n"), found: true };
}

/** One line of text from a file, safe to show and to put in the prompt: no escapes, hidden characters spelled out. */
export function cleanLine(text, max = DESCRIPTION_MAX) {
  const plain = reveal(stripAnsi(String(text ?? "")).replace(/[\r\n\t]+/g, " ")).replace(/\s+/g, " ").trim();
  const chars = Array.from(plain);
  return chars.length > max ? chars.slice(0, max - 1).join("").trimEnd() + "…" : plain;
}

const firstLine = body => String(body || "").split("\n").map(line => line.replace(/^#+\s*/, "").trim()).find(Boolean) || "";

// ---------------------------------------------------------------------------------------------------------------------
// Discovery

const headerCache = new Map(); // SKILL.md path -> { stamp, value }

function realOrNull(p) { try { return fs.realpathSync(p); } catch { return null; } }

// Read again on every call, never cached by the root's mtime (see the decisions above: exFAT and FAT never move it).
function listRoot(dir) {
  let stat;
  try { stat = fs.statSync(dir); } catch { return null; }
  if (!stat.isDirectory()) return null;
  let folders = [];
  try {
    folders = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name);
  } catch { folders = []; }
  folders.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { real: realOrNull(dir), folders };
}

const hasSkillFile = dir => { try { return fs.statSync(path.join(dir, SKILL_FILE)).isFile(); } catch { return false; } };

/** The header of <root>/<folder>/SKILL.md: { name, description, descriptionAr }, { skipped, name } or null (no skill). */
function readHeader(rootReal, dir, folder) {
  const file = path.join(dir, SKILL_FILE);
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!stat.isFile()) return null;
  // Following the folder (and the file) to where they really are: a link that leaves the root is not a skill here.
  const real = realOrNull(file);
  if (!real || !isInside(rootReal, real)) return { skipped: "outside", name: cleanLine(folder, 64) };
  const stamp = `${stat.mtimeMs}:${stat.size}:${real}`;
  const hit = headerCache.get(file);
  if (hit && hit.stamp === stamp) return hit.value;
  const text = readCapped(file, SKILL_CAP_BYTES);
  let value = null;
  if (text != null) {
    const { data, body } = parseFrontMatter(text);
    const name = String(data.name || folder).trim().toLowerCase();
    value = SKILL_NAME.test(name)
      ? { name, description: cleanLine(data.description || firstLine(body)), descriptionAr: cleanLine(data["description-ar"] || data.description_ar || "") }
      : { skipped: "name", name: cleanLine(data.name || folder, 64) };
  }
  headerCache.set(file, { stamp, value });
  return value;
}

/**
 * Everything found: { skills, skipped }. skills are [{ name, description, descriptionAr, scope, dir, file, root,
 * replaces? }] sorted by name; skipped are [{ name, scope, dir, reason }] with reason "name" | "command" | "outside" |
 * "duplicate" | "limit" (a root with skills that did not fit is named once, by its folder, with name ""). opts:
 * { roots, reserved(name) -> boolean, max }.
 *
 * The roots are read from the last to the first: the built-in and the person's own get their room under the limit
 * before a cloned repository's folders do, which may replace one of them by name but never push it out by number. A
 * root read later still wins a name, as its place in the order says. Once the list is full, only the folders named like
 * a listed skill are read (they may still replace it): a repository with thousands of folders costs one readdir more,
 * not thousands of reads.
 */
export function scanSkills(cwd = process.cwd(), { roots = skillRoots(cwd), reserved = () => false, max = MAX_SKILLS } = {}) {
  const byName = new Map();
  const skipped = [];
  for (const root of [...roots].reverse()) {
    const listing = listRoot(root.dir);
    if (!listing) continue;
    const within = root.within ? realOrNull(root.within) || path.resolve(root.within) : null;
    if (!listing.real || (within && !isInside(within, listing.real))) {
      skipped.push({ name: "", scope: root.scope, dir: root.dir, reason: "outside" });
      continue;
    }
    const { folders } = listing;
    const seenHere = new Set();
    let overflow = false;
    for (const folder of folders) {
      const dir = path.join(root.dir, folder);
      // Full: a folder may still REPLACE a skill already listed (that adds nothing to the count), so only the folders
      // named like one are read; the rest are only checked until one of them turns out to be a skill that did not fit.
      const full = byName.size >= max;
      if (full && !byName.has(folder.toLowerCase())) {
        if (!overflow && hasSkillFile(dir)) overflow = true;
        continue;
      }
      const header = readHeader(listing.real, dir, folder);
      if (!header) continue;
      const note = reason => skipped.push({ name: header.name, scope: root.scope, dir, reason });
      if (header.skipped) { note(header.skipped); continue; }
      let isReserved = false;
      try { isReserved = !!reserved(header.name); } catch { isReserved = false; }
      if (isReserved) { note("command"); continue; }
      if (full && !byName.has(header.name)) { overflow = true; continue; }
      if (seenHere.has(header.name)) { note("duplicate"); continue; }
      seenHere.add(header.name);
      // A name already found came from a root after this one: this one hides it, and says which one it replaces.
      const hidden = byName.get(header.name);
      const skill = { ...header, scope: root.scope, dir, file: path.join(dir, SKILL_FILE), root: listing.real };
      byName.set(skill.name, hidden ? { ...skill, replaces: hidden.scope } : skill);
    }
    if (overflow) skipped.push({ name: "", scope: root.scope, dir: root.dir, reason: "limit" });
  }
  const skills = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { skills: skills.map(skill => Object.freeze(skill)), skipped };
}

/** The skills for `cwd` (see scanSkills for the shape and the options). */
export function discoverSkills(cwd = process.cwd(), opts = {}) {
  return scanSkills(cwd, opts).skills;
}

/** The description to show: the Arabic one in the Arabic interface when the skill has one. */
export function skillDescription(skill, lang = getLang()) {
  if (!skill) return "";
  return (lang === "ar" && skill.descriptionAr) || skill.description || skill.descriptionAr || "";
}

/**
 * What the app hands around: { cwd, list(), find(name), scan() }. Every call looks again (cheaply, see the caches),
 * so a skill added while the app runs is in the next prompt's menu. A failing scan is an empty list, never an error.
 */
export function createSkillSource(cwd = process.cwd(), opts = {}) {
  const scan = () => { try { return scanSkills(cwd, opts); } catch { return { skills: [], skipped: [] }; } };
  const list = () => scan().skills;
  return {
    cwd,
    scan,
    list,
    find(name) {
      const key = String(name ?? "").trim().toLowerCase();
      return key ? list().find(skill => skill.name === key) || null : null;
    },
  };
}

/** A skill source from whatever a caller passed: a source, a list of skills, or a function returning one. */
export function asSkillSource(value) {
  if (value && typeof value.list === "function") {
    if (typeof value.find === "function") return value;
    return { ...value, find: name => value.list().find(skill => skill.name === String(name ?? "").trim().toLowerCase()) || null };
  }
  const list = typeof value === "function" ? () => value() || [] : () => (Array.isArray(value) ? value : []);
  return { list, find: name => list().find(skill => skill.name === String(name ?? "").trim().toLowerCase()) || null, scan: () => ({ skills: list(), skipped: [] }) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Loading

/** The other files in a skill's folder (two levels, links left out), as relative paths with forward slashes. */
function skillFiles(dir) {
  const out = [];
  const walk = (abs, rel, depth) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (out.length >= FILES_MAX) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (depth < 2 && !entry.name.startsWith(".")) walk(path.join(abs, entry.name), childRel, depth + 1); continue; }
      if (entry.isFile() && !(depth === 1 && entry.name === SKILL_FILE)) out.push(childRel);
    }
  };
  walk(dir, "", 1);
  return out;
}

/**
 * { text, files } for a skill found by discovery: its SKILL.md read again now (so an edit counts at once), the header
 * removed, capped at 32 KB with a note when cut; files are the other files in its folder. null when it cannot be read.
 */
export function loadSkill(skill, { cap = SKILL_CAP_BYTES } = {}) {
  if (!skill || typeof skill.file !== "string") return null;
  const real = realOrNull(skill.file);
  if (!real || (skill.root && !isInside(skill.root, real))) return null;
  const text = readCapped(skill.file, cap);
  if (text == null) return null;
  return { text: parseFrontMatter(text).body.trim(), files: skillFiles(skill.dir) };
}

/**
 * The message a typed "/name args" turns into. Its first line is what the person typed, so the conversation's title
 * reads as they wrote it; the rest tells the model to load the skill with the tool (where its text gets the trust of
 * project instructions, not of the person's own message: a project's skill may come from a cloned repository).
 */
export function skillMessage(skill, args = "") {
  const name = String(skill?.name ?? "");
  const task = String(args ?? "").trim();
  return [
    `/${name}${task ? ` ${task}` : ""}`,
    "",
    task
      ? `Use the "${name}" skill for the request above: call the Skill tool with name "${name}" and args set to the text after /${name}, then follow the instructions it returns.`
      : `Use the "${name}" skill: call the Skill tool with name "${name}", then follow the instructions it returns. No further details were given, so apply it to the current project and conversation.`,
  ].join("\n");
}
