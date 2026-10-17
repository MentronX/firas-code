// /cost: how many tokens this session has used (the service is not metered per token on the person's side).
import { c } from "../ui/theme.js";
import { t } from "../i18n/index.js";
import { stringWidth } from "../text/display.js";
import { fmtTokens, padLabel } from "../ui/views.js";
import "../ui/strings-app.js";

export const costCommand = {
  name: "cost",
  aliases: ["usage"],
  group: "info",
  get description() { return t("app.cmd.cost"); },
  run(ctx) {
    const usage = ctx.session.usage || {};
    const input = usage.inputTokens || 0;
    const output = usage.outputTokens || 0;
    const rows = [
      [t("app.cost.turns"), String(usage.turns || 0)],
      [t("app.cost.input"), fmtTokens(input)],
      [t("app.cost.output"), fmtTokens(output)],
      [t("app.cost.total"), fmtTokens(input + output)],
    ];
    if (ctx.session.contextTokens) rows.push([t("app.cost.context"), fmtTokens(ctx.session.contextTokens)]);
    const label = Math.max(...rows.map(([name]) => stringWidth(name))) + 2;
    ctx.ui.print(["", ...rows.map(([name, value]) => `${c.dim(padLabel(name, label))}${value}`), ""]);
  },
};
