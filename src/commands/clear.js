// /clear: forget the conversation and clear the screen. A NEW session is started (the old one stays on disk and can be
// brought back with /resume); the application does the swap, because it owns the session object.
import { t } from "../i18n/index.js";
import "../ui/strings-app.js";

export const clearCommand = {
  name: "clear",
  aliases: ["new"],
  group: "session",
  get description() { return t("app.cmd.clear"); },
  run(ctx) { ctx.clearConversation(); },
};
