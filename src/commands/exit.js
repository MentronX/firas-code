// /exit (and /quit): leave. The session is already saved after every turn.
import { t } from "../i18n/index.js";
import "../ui/strings-app.js";

export const exitCommand = {
  name: "exit",
  aliases: ["quit", "q"],
  group: "session",
  get description() { return t("app.cmd.exit"); },
  run(ctx) { ctx.exit(0); },
};
