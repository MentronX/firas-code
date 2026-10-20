// /status: version, folder, mode, effort, language, Arabic display, session, tokens, and whether the service answers.
//
// Layout (dev/DESIGN.md, Tones and Grid): two columns, labels dim and values plain, every value starting in the same
// column. A value may have a dim second part ("· messages: 4") that is left out when the row has no room for it; the
// folder keeps its tail and every other value is cut to the room there is, so no row is wider than the content width
// (on a terminal too narrow for two columns each value goes under its label). In the Arabic interface each row is laid
// out right to left to the full width: the labels sit on the right edge, the values line up to their left, and Latin
// values (version, folder, session id, token counts) are isolated so they read as typed.
//
// The Arabic row says what is in EFFECT (arabicActive), then what the setting says. They can differ: a saved "off" is
// read as "auto" in the classic console (cli.js arabicSetting) and --no-arabic turns shaping off whatever is saved, so
// printing the setting alone said "off" while every Arabic line on screen was being shaped.
import { c, sym } from "../ui/theme.js";
import { t, getLang } from "../i18n/index.js";
import { NAME, VERSION } from "../brand.js";
import { modeLabel, effortLabel } from "../ui/strings.js";
import { isAbortError } from "../link/errors.js";
import { arabicActive, hasRtl, stringWidth, toVisual } from "../text/display.js";
import { fmtTokens, truncateLogical, cleanText, contentWidth, UP, DOWN } from "../ui/views.js";
import { fitPathTail, ltrIsolate, stripBidiMarks } from "../ui/textfit.js";
import { paintUltra } from "../ui/ultra.js";
import "../ui/strings-app.js";
import "../ui/strings-effort.js";

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

// Below this many columns for the values, each value goes on its own line under its label instead.
const MIN_VALUE = 14;

/**
 * The rows of /status as visual lines no wider than `width` (the content width).
 * rows: [{ label, value, alt?, path?, ltr?, style?, extra?, paint? }]
 *  - value: plain logical text, shortened to the room there is (a path keeps its tail); style(text) colours it. alt is
 *    a shorter value used instead when value does not fit.
 *  - ltr: the value is a structural Latin run (a version, a path, an id, counts) and reads left to right in Arabic too;
 *    any value without Arabic letters is kept in one piece the same way.
 *  - extra: a dim second part ("· messages: 4"), shown only when it fits.
 *  - paint(line): runs on the finished line (the ultracode rainbow).
 */
export function statusLines(rows, width, { rtl = getLang() === "ar" && arabicActive() } = {}) {
  const col = Math.max(...rows.map(row => stringWidth(row.label))) + 2;
  const stacked = width - col < MIN_VALUE;
  const room = Math.max(4, stacked ? width - 2 : width - col);
  const place = (logical, cells = width) => stripBidiMarks(rtl ? toVisual(logical, { dir: "rtl", width: cells, align: "end" }) : toVisual(logical, { dir: "ltr" }));
  const lines = [];
  for (const { label, value, alt, path, ltr, style, extra, paint } of rows) {
    const full = stripBidiMarks(String(value ?? ""));
    const plain = alt && stringWidth(full) > room ? stripBidiMarks(String(alt)) : full;
    const text = path ? fitPathTail(plain, room, sym.ellipsis) : truncateLogical(plain, room);
    let body = style ? style(text) : text;
    if (rtl && (ltr || !hasRtl(text))) body = ltrIsolate(body);
    const more = extra ? `${sym.dot} ${extra}` : "";
    if (more && stringWidth(text) + 1 + stringWidth(more) <= room) body += ` ${c.dim(more)}`;
    const finish = line => (paint ? paint(line) : line);
    if (!stacked) lines.push(finish(place(`${c.dim(label)}${" ".repeat(Math.max(0, col - stringWidth(label)))}${body}`)));
    // Under its label the value is indented by two columns on the reading side: the right in Arabic.
    else lines.push(place(c.dim(label)), finish(rtl ? place(body, width - 2) + "  " : place(`  ${body}`)));
  }
  return lines;
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
    const width = contentWidth(ctx.screen?.width?.() ?? 80);
    const rtl = getLang() === "ar" && arabicActive();
    const label = key => t(`app.status.${key}`);
    const setting = String(ctx.config?.arabic || "auto");
    const rows = [
      // Short of room the version number is what matters, not the name in front of it.
      { label: label("version"), value: `${NAME} ${VERSION}`, alt: VERSION, ltr: true },
      // What a row may hold: the folder and the service message can be long, and a row wider than the terminal wraps.
      { label: label("folder"), value: ctx.cwd, path: true, ltr: true },
      { label: label("mode"), value: modeLabel(ctx.permissions.mode) },
      { label: label("effort"), value: effortLabel(ctx.effort.get()), paint: line => paintUltra(line, 0) },
      { label: label("lang"), value: getLang() === "ar" ? "العربية" : "English" },
      {
        label: label("arabic"),
        value: arabicActive() ? t("app.statusview.on") : t("app.statusview.off"),
        extra: t("app.statusview.setting", { mode: rtl ? ltrIsolate(setting) : setting }),
      },
      { label: label("session"), value: s.id, ltr: true, extra: t("app.status.messages", { n: s.messages.length }) },
      { label: label("tokens"), value: `${UP} ${fmtTokens(usage.inputTokens)} ${DOWN} ${fmtTokens(usage.outputTokens)}`, ltr: true },
      service?.ok
        ? { label: label("service"), value: t("app.status.reachable"), style: c.green }
        : { label: label("service"), value: cleanText(service?.message || t("app.status.unreachable")), style: c.red },
    ];
    ctx.ui.print(["", ...statusLines(rows, width, { rtl }), ""]);
  },
};
