// /rewind: restore the conversation to an earlier checkpoint. The messages come back; files on disk do
// not (the checkpoint is a conversation snapshot, not a copy of the project), and the notice says so.
import { t } from "../i18n/index.js";
import { truncateLogical, cleanText } from "../ui/views.js";
import "../ui/strings-app.js";

export const rewindCommand = {
  name: "rewind",
  aliases: ["undo"],
  group: "session",
  get description() { return t("app.rewind.desc"); },
  async run(ctx) {
    const points = ctx.session.listCheckpoints();
    if (!points.length) { ctx.ui.notice("info", t("app.rewind.none")); return; }
    const items = points.slice(0, 20).map(point => ({
      label: truncateLogical(cleanText(point.label) || t("app.checkpoint.auto"), 60),
      hint: `${point.at} · ${t("app.status.messages", { n: point.messageCount })}`,
    }));
    const index = await ctx.ui.pick({ title: t("app.rewind.title"), items });
    if (index < 0) return;
    if (!ctx.session.restoreCheckpoint(points[index].file)) { ctx.ui.notice("warn", t("app.rewind.failed")); return; }
    ctx.ui.resetTodos?.(null);
    ctx.ui.notice("info", t("app.rewind.done"));
  },
};
