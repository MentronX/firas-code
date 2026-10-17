// /status: version, folder, mode, effort, language, session, tokens, and whether the service answers right now.
import { c, sym } from "../ui/theme.js";
import { t } from "../i18n/index.js";
import { NAME, VERSION } from "../brand.js";
import { modeLabel, effortLabel } from "../ui/strings.js";
import { isAbortError } from "../link/errors.js";
import { stringWidth } from "../text/display.js";
import { fmtTokens, truncateLogical, cleanText, contentWidth, padLabel, vis, UP, DOWN } from "../ui/views.js";
import { fitPathTail } from "../ui/textfit.js";
import "../ui/strings-app.js";

const CHECK_MS = 6000;

/** Asks the service whether the access code works. Resolves { ok } or { ok:false, message }. Never rejects. */
export async function checkService(ctx, signal, timeoutMs = CHECK_MS) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeoutMs);
  const link = () => control.abort();
  signal?.addEventListener("abort", link, { once: true });
  try {
    await ctx.client.checkAccess({ signal: control.signal });
    return { ok: true };
  } catch (error) {
    if (isAbortError(error)) return { ok: false, message: signal?.aborted ? t("app.status.cancelled") : t("app.status.slow") };
    return { ok: false, message: error?.userMessage || t("app.status.unreachable") };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", link);
  }
}

export const statusCommand = {
  name: "status",
  aliases: ["info"],
  group: "info",
  get description() { return t("app.cmd.status"); },
  async run(ctx) {
    const service = await ctx.busy(signal => checkService(ctx, signal));
    const s = ctx.session;
    const usage = s.usage || {};
    const names = [t("app.status.version"), t("app.status.folder"), t("app.status.mode"), t("app.status.effort"), t("app.status.lang"), t("app.status.session"), t("app.status.tokens"), t("app.status.service")];
    const label = Math.max(...names.map(name => stringWidth(name))) + 2;
    // What a row may hold: the folder and the service message can be long, and a row wider than the terminal wraps.
    const room = Math.max(12, contentWidth(ctx.screen?.width?.() ?? 80) - label);
    const rows = [
      [t("app.status.version"), `${NAME} ${VERSION}`],
      [t("app.status.folder"), fitPathTail(ctx.cwd, room, sym.ellipsis)],
      [t("app.status.mode"), modeLabel(ctx.permissions.mode)],
      [t("app.status.effort"), effortLabel(ctx.effort.get())],
      [t("app.status.lang"), `${ctx.lang === "ar" ? "العربية" : "English"} ${c.dim(`· ${t("app.status.arabic")}: ${ctx.config.arabic}`)}`],
      [t("app.status.session"), `${s.id} ${c.dim(`· ${t("app.status.messages", { n: s.messages.length })}`)}`],
      [t("app.status.tokens"), `${UP} ${fmtTokens(usage.inputTokens)} ${DOWN} ${fmtTokens(usage.outputTokens)}`],
      [t("app.status.service"), service?.ok ? c.green(t("app.status.reachable")) : c.red(truncateLogical(cleanText(service?.message || ""), room))],
    ];
    const lines = [""];
    for (const [name, value] of rows) lines.push(`${c.dim(padLabel(name, label))}${vis(value)}`);
    lines.push("");
    ctx.ui.print(lines);
  },
};
