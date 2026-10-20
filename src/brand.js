// Product identity. Every user-visible name comes from here so it can change in one place.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function readVersion() {
  try { return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version || "2.0.0"; }
  catch { return "2.0.0"; }
}

export const VERSION = readVersion();
export const NAME = "Firas Code 2";
export const NAME_AR = "فراس كود 2";
export const MAKER = "Firas AI";
export const BIN = "firas";
/** The public model alias this product sends with every request; the service resolves it to the real model privately. */
export const MODEL_ID = "firas-code-2";
/** Where the service lives unless FIRAS_ORIGIN / --origin says otherwise. */
export const DEFAULT_ORIGIN = "https://firasai.org";
export const ROUTE_PREFIX = "/api/desktop/code2";
export const CLIENT_ID = "cli";
/** Folder under the user's home directory for settings and saved sessions. */
export const HOME_DIRNAME = ".firas-code";
/** Project instruction files, in priority order. The first one that exists in a folder is read. */
export const PROJECT_FILES = ["FIRAS.md", "AGENTS.md"];
/** Accent colour (RGB). Matches the Firas AI teal. */
export const ACCENT_RGB = [87, 174, 156];
/** Published location, filled in by scripts/set-repo.mjs. */
export const REPO = "MentronX/firas-code";
