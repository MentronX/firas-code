// /mode [default|acceptEdits|plan|bypass]: how much the agent may do without asking. Applies to this session only
// (Shift+Tab cycles the first three); the starting mode comes from the settings file or the --mode / --yolo flags.
import { t } from "../i18n/index.js";
import { modeLabel } from "../ui/strings.js";
import { chooseOption } from "./pick.js";
import "../ui/strings-app.js";

export const MODE_NAMES = ["default", "acceptEdits", "plan", "bypass"];
const ALIASES = { acceptedits: "acceptEdits", accept: "acceptEdits", edits: "acceptEdits", yolo: "bypass", normal: "default", ask: "default" };

export function parseMode(text) {
  const key = String(text || "").trim().replace(/[\s_-]+/g, "").toLowerCase();
  if (!key) return "";
  return ALIASES[key] || MODE_NAMES.find(name => name.toLowerCase() === key) || "";
}

export const modeCommand = {
  name: "mode",
  aliases: [],
  group: "settings",
  usage: "[default|acceptEdits|plan|bypass]",
  get description() { return t("app.cmd.mode"); },
  async run(ctx, args) {
    let mode = parseMode(args);
    if (args.trim() && !mode) {
      ctx.ui.notice("warn", t("app.mode.invalid", { value: args.trim(), list: MODE_NAMES.join(", ") }));
      return;
    }
    if (!mode) {
      mode = await chooseOption(ctx, {
        title: t("app.mode.title"),
        options: MODE_NAMES.map(value => ({ value, label: modeLabel(value), hint: t(`app.mode.hint.${value}`) })),
        current: ctx.permissions.mode,
      });
      if (!mode) return;
    }
    ctx.setMode(mode);
    ctx.ui.notice(mode === "bypass" ? "warn" : "info", t(mode === "bypass" ? "app.mode.setBypass" : "app.mode.set", { mode: modeLabel(mode) }));
  },
};
