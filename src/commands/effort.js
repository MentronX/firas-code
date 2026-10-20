// /effort [low|medium|high|xhigh|max|ultracode]: how much the agent thinks before it answers. Saved for next time.
// Choosing ultracode plays its charge-up (src/ui/ultra.js) instead of the plain one-line confirmation.
//
// Without an argument the effort picker opens (src/ui/effortpicker.js: the arrows choose, Tab jumps to ultracode and
// back). A UI without dialogs of its own falls back to the plain menu every command shares (pick.js). Picking the level
// that is already set says so instead of announcing a change that did not happen; a level typed after the command
// (/effort high) is applied exactly as before, confirmation included.
import { t } from "../i18n/index.js";
import { EFFORTS, normalizeEffort } from "../config.js";
import { chooseOption } from "./pick.js";
import { playUltraIntro } from "../ui/ultra.js";
import { runEffortPicker } from "../ui/effortpicker.js";
import { effortLabel } from "../ui/strings.js";
import "../ui/strings-app.js";
import "../ui/strings-effort.js";

/** The level the person picks, or undefined when they backed out or there is no terminal to ask in. */
async function pickLevel(ctx) {
  const current = ctx.effort.get();
  if (typeof ctx.ui.dialog === "function") {
    const level = await ctx.ui.dialog((host, o) => runEffortPicker(host, { ...o, levels: EFFORTS, current, lang: ctx.lang }), null);
    return normalizeEffort(level) || undefined;
  }
  return chooseOption(ctx, {
    title: t("app.effort.title"),
    options: EFFORTS.map(value => ({ value, label: value, hint: t(`app.effort.hint.${value}`) })),
    current,
  });
}

/**
 * The ultracode charge-up and its announcement. In the interactive UI the frames are drawn in the dialog region during a
 * short busy turn, so whatever is typed meanwhile is kept for the next prompt, in order, exactly as while the agent
 * works: Enter sends nothing, so nothing typed can choose or approve anything, and Esc only ends the frames early. The
 * region is claimed before the turn begins and given back once it has ended: a turn's spinner never draws over a
 * dialog, so it never flashes in between.
 */
async function chargeUp(ctx) {
  const intro = o => playUltraIntro({ screen: ctx.screen, print: lines => ctx.ui.print(lines), lang: ctx.lang, ...o });
  let drawn = false;
  if (typeof ctx.ui.dialog === "function" && typeof ctx.busy === "function") {
    await ctx.ui.dialog(async host => {
      drawn = true;
      host.show([], null);
      try {
        await ctx.busy(signal => intro({ host, signal }));
      } finally {
        host.hide();
      }
    }, null);
  }
  // No terminal to draw on (the dialog did not open), or a UI without dialogs: the plain way, announcement included.
  if (!drawn) await intro();
}

export const effortCommand = {
  name: "effort",
  aliases: [],
  group: "settings",
  usage: "[low|medium|high|xhigh|max|ultracode]",
  get description() { return t("app.cmd.effort"); },
  async run(ctx, args) {
    const typed = args.trim();
    let level = typed ? normalizeEffort(typed) : "";
    if (!typed) {
      level = await pickLevel(ctx);
      if (!level) {
        ctx.ui.notice("info", t("app.effort.current", { level: ctx.effort.get(), list: EFFORTS.join(", ") }));
        return;
      }
      if (level === ctx.effort.get()) {
        ctx.ui.notice("info", t("app.effortpick.same", { level: effortLabel(level) }));
        return;
      }
    }
    if (!level) {
      ctx.ui.notice("warn", t("app.effort.invalid", { value: typed, list: EFFORTS.join(", ") }));
      return;
    }
    ctx.effort.set(level);
    if (level === "ultracode" && typeof ctx.ui.print === "function") {
      await chargeUp(ctx);
      return;
    }
    ctx.ui.notice("info", t("app.effort.set", { level }));
  },
};
