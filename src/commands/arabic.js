// /arabic [auto|on|off]: whether the app shapes and reorders Arabic itself. Windows Terminal and most terminals need it
// ("auto"/"on"); a terminal that already does its own bidi shows doubled-up text with it, so "off" exists. A sample
// line is printed after a change so the person can see at once whether it looks right.
import { t } from "../i18n/index.js";
import { ARABIC_MODES } from "../config.js";
import { para, contentWidth } from "../ui/views.js";
import { chooseOption } from "./pick.js";
import "../ui/strings-app.js";

export const arabicCommand = {
  name: "arabic",
  aliases: [],
  group: "settings",
  usage: "[auto|on|off]",
  get description() { return t("app.cmd.arabic"); },
  async run(ctx, args) {
    let mode = args.trim().toLowerCase();
    if (mode && !ARABIC_MODES.includes(mode)) {
      ctx.ui.notice("warn", t("app.arabic.invalid", { value: args.trim(), list: ARABIC_MODES.join(", ") }));
      return;
    }
    if (!mode) {
      mode = await chooseOption(ctx, {
        title: t("app.arabic.title"),
        options: ARABIC_MODES.map(value => ({ value, label: value, hint: t(`app.arabic.hint.${value}`) })),
        current: ctx.config.arabic,
      });
      if (!mode) return;
    }
    ctx.setArabic(mode);
    ctx.ui.notice("info", t("app.arabic.set", { mode }));
    ctx.ui.print(para(t("app.arabic.sample"), contentWidth(ctx.screen?.width?.() ?? 80)));
  },
};
