// /logout: forget the saved access code. Then the person is offered the chance to enter a new one right away;
// leaving that empty ends the program, so a forgotten code never leaves the app half signed in.
import { t } from "../i18n/index.js";
import "../ui/strings-app.js";

export const logoutCommand = {
  name: "logout",
  aliases: [],
  group: "account",
  get description() { return t("app.cmd.logout"); },
  async run(ctx) {
    if (ctx.config.env?.code) {
      ctx.ui.notice("warn", t("app.logout.env"));
      return;
    }
    ctx.forgetCode();
    ctx.ui.notice("info", t("app.logout.done"));
    const entered = await ctx.askNewCode();
    if (entered) ctx.ui.notice("info", t("app.logout.renewed"));
    else ctx.exit(0);
  },
};
