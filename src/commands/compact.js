// /compact [what to keep]: summarize the older part of the conversation to free up space. The optional text is passed
// on as `instructions`; the compactor uses it when it supports it.
import { t } from "../i18n/index.js";
import { maybeCompact } from "../agent/context.js";
import "../ui/strings-app.js";

export const compactCommand = {
  name: "compact",
  aliases: [],
  group: "session",
  usage: "[...]",
  get description() { return t("app.cmd.compact"); },
  async run(ctx, args) {
    await ctx.busy(signal => maybeCompact({
      session: ctx.session, client: ctx.client, signal, ui: ctx.ui, force: true, ...(args ? { instructions: args } : {}),
    }));
  },
};
