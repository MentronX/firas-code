// The words the app's text is checked against. They are kept in dev/banned-words.json, which stays on the developer's
// machine and is not published, so a fresh clone has no such list. Every check that needs the words reads them through
// here and skips itself (it does not fail) when the file is missing.
//
//   import { banned, skipNoList } from "../helpers/banned.js";
//   test("...", { skip: skipNoList }, () => { for (const word of banned.words) ... });
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LIST_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dev", "banned-words.json");

/**
 * { found, words, standalone, all, avoided }: all lower-case; empty when the file is absent or unreadable.
 * `all` is `words` plus the short ones that only count on their own in a scan of file text (a plain substring match
 * of every entry is what the checks on app text use).
 */
export function loadBanned(file = LIST_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = key => (Array.isArray(data[key]) ? data[key].map(word => String(word).toLowerCase()).filter(Boolean) : []);
    const words = list("words");
    const standalone = list("standalone");
    return { found: words.length > 0, words, standalone, all: [...words, ...standalone], avoided: typeof data.avoidedWord === "string" ? data.avoidedWord.toLowerCase() : "" };
  } catch {
    return { found: false, words: [], standalone: [], all: [], avoided: "" };
  }
}

export const banned = loadBanned();

/** For the `skip` option of node:test: a reason when there is no list, false when there is. */
export const skipNoList = banned.found ? false : "dev/banned-words.json is not on this machine";

/** A case-insensitive whole-word pattern for the avoided technical word, or null without a list. */
export function avoidedWordPattern() {
  return banned.avoided ? new RegExp(`\\b${banned.avoided}\\b`, "i") : null;
}
