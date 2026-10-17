// /effort [off|low|medium|high|xhigh|max]: how much the agent thinks before it answers. Saved for next time.
import { t } from "../i18n/index.js";
import { EFFORTS } from "../config.js";
import { chooseOption } from "./pick.js";
import "../ui/strings-app.js";

const ALIASES = { med: "medium", normal: "medium", none: "off", "x-high": "xhigh", extra: "xhigh", maximum: "max" };

export const effortCommand = {
  name: "effort",
  aliases: [],
  group: "settings",
  usage: "[off|low|medium|high|xhigh|max]",
  get description() { return t("app.cmd.effort"); },
  async run(ctx, args) {
    let level = args.trim().toLowerCase();
    level = ALIASES[level] || level;
    if (!level) {
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
    if (!EFFORTS.includes(level)) {
      ctx.ui.notice("warn", t("app.effort.invalid", { value: args.trim(), list: EFFORTS.join(", ") }));
      return;
    }
    ctx.effort.set(level);
    ctx.ui.notice("info", t("app.effort.set", { level }));
  },
};
