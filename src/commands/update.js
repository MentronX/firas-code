// /update: runs the installer again (see src/update.js) and shows its output. After a successful update the program
// ends, because the app folder it was running from has just been replaced.
import { t } from "../i18n/index.js";
import { runUpdate } from "../update.js";
import { cleanText } from "../ui/views.js";
import "../ui/strings-app.js";

const REASON_KEYS = { not_configured: "notConfigured", inside_app: "insideApp", dev_checkout: "devCheckout", spawn_failed: "spawnFailed", aborted: "aborted" };

/** The one-line message for a failed update result. */
export function updateFailureText(result) {
  const key = REASON_KEYS[result.reason];
  return key ? t(`app.update.${key}`) : t("app.update.failed", { code: result.code ?? "?" });
}

export const updateCommand = {
  name: "update",
  aliases: [],
  group: "account",
  get description() { return t("app.cmd.update"); },
  async run(ctx) {
    ctx.ui.notice("info", t("app.update.running"));
    const run = ctx.runUpdate || runUpdate;
    const result = await ctx.busy(signal => run({
      cwd: ctx.cwd, env: ctx.env, platform: ctx.platform, signal,
      // The installer prints its own lines (Arabic already in visual order): shown as they are.
      onOutput: text => {
        const lines = cleanText(text).split("\n").map(line => line.replace(/\s+$/, "")).filter(Boolean);
        if (lines.length) ctx.ui.printRaw(lines.map(line => `  ${line}`));
      },
    }));
    if (result.ok) {
      ctx.ui.notice("info", t("app.update.done"));
      ctx.exit(0);
    } else {
      ctx.ui.notice("error", updateFailureText(result));
    }
  },
};
