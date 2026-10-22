// /checkpoint [label]: save a restore point of this conversation now. /rewind restores one.
// The agent also writes one after every tool step, so a turn can always be rewound to a valid state.
import { t } from "../i18n/index.js";
import "../ui/strings-app.js";

export const checkpointCommand = {
  name: "checkpoint",
  aliases: ["cp"],
  group: "session",
  get description() { return t("app.checkpoint.desc"); },
  usage: "/checkpoint [label]",
  async run(ctx, arg) {
    const label = String(arg || "").trim();
    const file = ctx.session.checkpoint(label);
    if (!file) { ctx.ui.notice("warn", t("app.checkpoint.failed")); return; }
    ctx.ui.notice("info", t("app.checkpoint.saved", { label: label || t("app.checkpoint.auto") }));
  },
};
