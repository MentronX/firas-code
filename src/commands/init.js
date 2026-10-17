// /init: asks the agent to study the project and write FIRAS.md, the file every later session reads first.
// The prompt is model-facing English on purpose.
import { t } from "../i18n/index.js";
import "../ui/strings-app.js";

export const INIT_PROMPT = `Study this project and create a file named FIRAS.md in the project root. Future sessions read it first, so it must help someone who has never seen the project work in it safely and quickly.

How to work:
1. Look before you write: list the top-level files, read the package or build manifest (package.json, pyproject.toml, Cargo.toml, go.mod, pom.xml, a Makefile, or similar), the README, and a few representative source and test files. Check for existing instruction files (AGENTS.md, CONTRIBUTING.md, .editorconfig, linter configs) and fold in anything that matters.
2. If FIRAS.md already exists, read it and improve it instead of replacing it: keep what is still true, fix what is wrong, add what is missing.

What FIRAS.md should contain (omit a section that does not apply, and never invent anything you did not see):
- One or two sentences on what the project is.
- The exact commands to install, build, run, test (including how to run a single test) and lint, taken from the manifest or scripts.
- The layout: the main folders and what lives in each, and how the important pieces connect (the big picture, not a file listing).
- Conventions that are not obvious from the code: language and module style, naming, error handling, formatting, commit or branch rules.
- Gotchas: things that break easily, files that are generated, environment variables or setup that tests need.

Keep it under about 80 lines, in plain Markdown, written in the language the project's own documentation uses. Use the Write tool to create the file, then tell me in two or three sentences what you put in it.`;

export const initCommand = {
  name: "init",
  aliases: [],
  group: "session",
  get description() { return t("app.cmd.init"); },
  async run(ctx) {
    ctx.ui.notice("info", t("app.init.start"));
    await ctx.runAgentTurn(INIT_PROMPT);
  },
};
