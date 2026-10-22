// /memory [clear]: show the durable project memory (.firas/memory.md) or empty it. The agent writes it
// with the Remember tool; the system prompt carries it on every turn.
import { t } from "../i18n/index.js";
import { memoryLines, clearMemory } from "../agent/memory.js";
import "../ui/strings-app.js";

export const memoryCommand = {
  name: "memory",
  aliases: ["mem"],
  group: "session",
  get description() { return t("app.memory.desc"); },
  usage: "/memory [clear]",
  async run(ctx, arg) {
    if (String(arg || "").trim().toLowerCase() === "clear") {
      if (!clearMemory(ctx.cwd)) { ctx.ui.notice("warn", t("app.memory.failed")); return; }
      ctx.ui.notice("info", t("app.memory.cleared"));
      return;
    }
    const lines = memoryLines(ctx.cwd);
    if (!lines.length) { ctx.ui.notice("info", t("app.memory.empty")); return; }
    ctx.ui.print([t("app.memory.title"), ...lines.map(line => `  ${line}`)]);
  },
};
