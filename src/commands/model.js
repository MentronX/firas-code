// /model: shows the product name, its maker and the effort level.
import { c } from "../ui/theme.js";
import { t } from "../i18n/index.js";
import { NAME, MAKER } from "../brand.js";
import { vis } from "../ui/views.js";
import "../ui/strings-app.js";

export const modelCommand = {
  name: "model",
  aliases: [],
  group: "settings",
  get description() { return t("app.cmd.model"); },
  run(ctx) {
    ctx.ui.print(["", `${c.bold(NAME)} ${c.dim(`· ${MAKER}`)}`, vis(c.dim(t("app.model.note", { effort: ctx.effort.get() }))), ""]);
  },
};
