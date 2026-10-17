// Permission verdicts for reading and for changing files, shared by every file tool.
// A verdict is what a tool's permission() returns; the engine (permissions.js) applies the active mode on top.
//
// Every check looks at the path as written AND at the place it leads to once links are followed (guard.real): a link
// inside the project that points at a protected folder is as protected as the folder, and the person is shown both.
import path from "node:path";
import { t } from "../i18n/index.js";
import { isSecretPath, isSystemPath, isGitInternal } from "./pathguard.js";
import { settings, shown } from "./common.js";

/** Where the path really leads when that is somewhere else than where it points (a link, a junction); otherwise null. */
function linkTarget(g, platform) {
  if (typeof g.real !== "string" || !g.real) return null;
  const P = platform === "win32" ? path.win32 : path.posix;
  const fold = p => (platform === "win32" ? P.normalize(p).toLowerCase() : P.normalize(p));
  return fold(g.abs) === fold(g.real) ? null : g.real;
}

/** The path as written and, when a link is involved, the place it leads to; `both` is for dialogs that name the target. */
function names(g, target, ctx) {
  const plain = shown(g.abs, ctx);
  return { plain, both: target ? `${plain} -> ${shown(target, ctx)}` : plain };
}

/** Verdict for looking at a path (a file or a folder). Inside the project: allowed. */
export function readVerdict(g, ctx, { directory = false } = {}) {
  const s = settings(ctx);
  const target = linkTarget(g, s.platform);
  const { plain, both } = names(g, target, ctx);
  if (isSecretPath(g.abs, s.platform) || (target && isSecretPath(target, s.platform))) {
    return { decision: "ask", risk: "high", category: "read", inside: g.inside, title: t("tools.perm.secretRead"), detail: both };
  }
  if (g.inside) return { decision: "allow", risk: "low", category: "read", inside: true, title: t("tools.perm.read", { file: plain }) };
  // A remembered folder is the place the path really leads to: a link must not turn "allow this folder" into "allow
  // whatever the link points at tomorrow".
  const place = target || g.abs;
  const dir = directory ? place : path.dirname(place);
  return {
    decision: "ask", risk: "low", category: "read", inside: false,
    title: t("tools.perm.readOutside", { file: both }), detail: target ? `${g.abs}\n-> ${target}` : g.abs,
    sessionKey: `Read:dir:${dir}`, sessionLabel: t("tools.perm.readOutsideSession", { dir }),
  };
}

/** Verdict for creating or changing a file. `title` is the already-localized headline. */
export function writeVerdict(g, ctx, { title, diff, detail }) {
  const s = settings(ctx);
  const target = linkTarget(g, s.platform);
  const { plain, both } = names(g, target, ctx);
  const places = target ? [g.abs, target] : [g.abs];
  const base = { decision: "ask", category: "edit", inside: g.inside, title, detail: detail ?? plain, diff };
  const flagged = key => ({ ...base, risk: "high", title: t(key, { file: both }), detail: detail ?? both });
  if (places.some(p => isSecretPath(p, s.platform))) return flagged("tools.perm.secretWrite");
  if (places.some(p => isSystemPath(p, { platform: s.platform, env: s.env }))) return flagged("tools.perm.systemWrite");
  // Hooks and settings under .git are run by git later, so they are never an ordinary in-project edit: high risk is
  // asked about in every mode (bypass included) and never remembered for the session.
  if (places.some(isGitInternal)) return flagged("tools.perm.gitWrite");
  if (g.inside) return { ...base, risk: "low", sessionKey: "Edit:*", sessionLabel: t("tools.perm.editSession") };
  const dir = path.dirname(target || g.abs);
  return { ...base, risk: "medium", detail: target ? `${g.abs}\n-> ${target}` : g.abs, sessionKey: `Edit:dir:${dir}`, sessionLabel: t("tools.perm.editOutsideSession", { dir }) };
}
