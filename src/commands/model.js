// /model: shows the product name, its maker and the effort level.
import { c } from "../ui/theme.js";
import { t } from "../i18n/index.js";
import { NAME, MAKER } from "../brand.js";
import { para, contentWidth } from "../ui/views.js";
import "../ui/strings-app.js";

export const modelCommand = {
  name: "model",
  aliases: [],
  group: "settings",
  get description() { return t("app.cmd.model"); },
  run(ctx) {
    // Laid out to the full width, so the Arabic note ends at the same right edge as everything else.
    const width = contentWidth(ctx.screen?.width?.() ?? 80);
    ctx.ui.print(["", `${c.bold(NAME)} ${c.dim(`· ${MAKER}`)}`, ...para(c.dim(t("app.model.note", { effort: ctx.effort.get() })), width), ""]);
  },
};
