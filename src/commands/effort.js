// /effort [low|medium|high|xhigh|max|ultracode]: how much the agent thinks before it answers. Saved for next time.
// Choosing ultracode plays its charge-up (src/ui/ultra.js) instead of the plain one-line confirmation.
import { t } from "../i18n/index.js";
import { EFFORTS, normalizeEffort } from "../config.js";
import { chooseOption } from "./pick.js";
import { playUltraIntro } from "../ui/ultra.js";
import "../ui/strings-app.js";

export const effortCommand = {
  name: "effort",
  aliases: [],
  group: "settings",
  usage: "[low|medium|high|xhigh|max|ultracode]",
  get description() { return t("app.cmd.effort"); },
  async run(ctx, args) {
    let level = args.trim() ? normalizeEffort(args) : "";
    if (!args.trim()) {
      level = await chooseOption(ctx, {
        title: t("app.effort.title"),
        options: EFFORTS.map(value => ({ value, label: value, hint: t(`app.effort.hint.${value}`) })),
        current: ctx.effort.get(),
      });
      if (!level) {
        ctx.ui.notice("info", t("app.effort.current", { level: ctx.effort.get(), list: EFFORTS.join(", ") }));
        return;
      }
    }
    if (!level) {
      ctx.ui.notice("warn", t("app.effort.invalid", { value: args.trim(), list: EFFORTS.join(", ") }));
      return;
    }
    ctx.effort.set(level);
    if (level === "ultracode" && typeof ctx.ui.print === "function") {
      await playUltraIntro({ screen: ctx.screen, print: lines => ctx.ui.print(lines), lang: ctx.lang });
      return;
    }
    ctx.ui.notice("info", t("app.effort.set", { level }));
  },
};
