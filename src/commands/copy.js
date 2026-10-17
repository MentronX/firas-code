// /copy: puts the last answer on the clipboard as the model wrote it (logical order, markdown untouched), so pasting
// it elsewhere reads correctly even though the terminal shows Arabic in visual order.
import { t } from "../i18n/index.js";
import { copyToClipboard } from "./clipboard.js";
import "../ui/strings-app.js";

export const copyCommand = {
  name: "copy",
  aliases: [],
  group: "info",
  get description() { return t("app.cmd.copy"); },
  async run(ctx) {
    const text = ctx.ui.lastAnswer();
    if (!text || !text.trim()) {
      ctx.ui.notice("warn", t("app.copy.nothing"));
      return;
    }
    const copy = ctx.copyToClipboard || copyToClipboard;
    const result = await copy(text, { platform: ctx.platform, env: ctx.env });
    ctx.ui.notice(result.ok ? "info" : "warn", result.ok ? t("app.copy.done", { n: [...text].length }) : t("app.copy.failed"));
  },
};
