// /sessions: the saved conversations of every folder, most recent first. Choosing one of this folder resumes it; one
// from another folder is only named (see resume.js).
import { t } from "../i18n/index.js";
import { resumeFlow } from "./resume.js";
import "../ui/strings-app.js";

export const sessionsCommand = {
  name: "sessions",
  aliases: ["history"],
  group: "session",
  get description() { return t("app.cmd.sessions"); },
  run: ctx => resumeFlow(ctx, "", { all: true }),
};
