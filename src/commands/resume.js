// /resume [id]: go back to a saved conversation of this folder. With no id a numbered picker lists the most recent ones
// (the same menu the permission dialog uses). /sessions (sessions.js) is the same picker over every folder.
//
// A conversation belongs to the folder it was started in: its tools and its saved file paths are relative to that
// place. Resuming one from somewhere else is refused with the folder named, rather than quietly editing the wrong project.
import { t } from "../i18n/index.js";
import { listSessions, loadSession } from "../agent/session.js";
import { displayPath, isInside } from "../util/paths.js";
import { truncateLogical, cleanText } from "../ui/views.js";
import "../ui/strings-app.js";

const PICKER_LIMIT = 30;

function ago(iso, now = Date.now()) {
  const ms = now - Date.parse(iso || "");
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return t("app.ago.now");
  if (minutes < 60) return t("app.ago.min", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("app.ago.hour", { n: hours });
  return t("app.ago.day", { n: Math.round(hours / 24) });
}

/** A saved session by exact id, or by a prefix that matches exactly one. */
export function findSession(idOrPrefix) {
  const wanted = String(idOrPrefix || "").trim();
  if (!wanted) return null;
  const exact = loadSession(wanted);
  if (exact) return exact;
  const matches = listSessions({ limit: 500 }).filter(item => item.id.startsWith(wanted));
  return matches.length === 1 ? loadSession(matches[0].id) : null;
}

/** Lets the person pick one of the saved sessions (or resumes `arg`). `all` lists every folder. */
export async function resumeFlow(ctx, arg, { all = false } = {}) {
  let session = null;
  if (arg) {
    session = findSession(arg);
    if (!session) { ctx.ui.notice("warn", t("app.resume.notFound", { id: arg })); return; }
  } else {
    const found = listSessions({ ...(all ? {} : { cwd: ctx.cwd }), limit: PICKER_LIMIT });
    if (!found.length) { ctx.ui.notice("info", t(all ? "app.resume.noneAny" : "app.resume.none")); return; }
    const items = found.map(item => {
      const here = isInside(ctx.cwd, item.cwd) && isInside(item.cwd, ctx.cwd);
      const parts = [ago(item.updatedAt), t("app.status.messages", { n: item.messageCount })];
      if (!here) parts.push(displayPath(item.cwd));
      return { label: truncateLogical(cleanText(item.title) || t("app.resume.untitled"), 70), hint: parts.filter(Boolean).join(" · ") };
    });
    const index = await ctx.ui.pick({ title: t(all ? "app.resume.titleAll" : "app.resume.title"), items });
    if (index < 0) return;
    session = loadSession(found[index].id);
    if (!session) { ctx.ui.notice("warn", t("app.resume.notFound", { id: found[index].id })); return; }
  }
  const same = isInside(ctx.cwd, session.cwd) && isInside(session.cwd, ctx.cwd);
  if (!same) {
    ctx.ui.notice("warn", t("app.resume.otherFolder", { folder: session.cwd }));
    return;
  }
  ctx.resumeSession(session);
}

export const resumeCommand = {
  name: "resume",
  aliases: ["continue"],
  group: "session",
  usage: "[id]",
  get description() { return t("app.cmd.resume"); },
  run: (ctx, args) => resumeFlow(ctx, args.trim()),
};
