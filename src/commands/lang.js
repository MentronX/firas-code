// /lang [ar|en]: the language of the interface (the agent answers in the language you write in either way).
import { t } from "../i18n/index.js";
import { chooseOption } from "./pick.js";
import "../ui/strings-app.js";

export function parseLang(text) {
  const key = String(text || "").trim().toLowerCase();
  if (["ar", "arabic", "عربي", "العربية", "عربية", "1"].includes(key)) return "ar";
  if (["en", "english", "انجليزي", "إنجليزي", "الانجليزية", "الإنجليزية", "2"].includes(key)) return "en";
  return "";
}

export const langCommand = {
  name: "lang",
  aliases: ["language"],
  group: "settings",
  usage: "[ar|en]",
  get description() { return t("app.cmd.lang"); },
  async run(ctx, args) {
    let lang = parseLang(args);
    if (args.trim() && !lang) {
      ctx.ui.notice("warn", t("app.lang.invalid", { value: args.trim() }));
      return;
    }
    if (!lang) {
      lang = await chooseOption(ctx, {
        title: t("app.lang.title"),
        options: [{ value: "ar", label: "العربية" }, { value: "en", label: "English" }],
        current: ctx.lang,
      });
      if (!lang) return;
    }
    ctx.setLang(lang);
    ctx.ui.notice("info", t("app.lang.set"));
  },
};
