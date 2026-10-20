// The strings of the skills feature: the /skills listing, /skills new, and the tag the "/" menu puts on a skill row.
// Namespace "app", keys under "skills." (so the menu reads t("app.skills.tag")). Same conventions as strings-app.js:
// short Modern Standard Arabic without harakat (ConPTY gives each mark a cell of its own), every Latin snippet (a
// command, a file name, a character range) inside an LTR isolate so it keeps its own order once the line is reordered.
//
// Code that uses these strings goes through skillText(key): the key it names is relative to "app.skills.", and the
// full table below is checked in both languages by test/skills/strings.test.js.
import { registerStrings, t } from "../i18n/index.js";

const L = s => "\u2066" + s + "\u2069";

export const SKILL_STRINGS = Object.freeze({
  en: Object.freeze({
    "tag": "skill",
    "cmd": "List the skills, or start a new one",
    "title": "Skills",
    "scope.builtin": "Built-in",
    "scope.user": "Yours",
    "scope.project": "This project",
    "none": "None yet",
    "replaces.builtin": "replaces the built-in one",
    "replaces.user": "replaces yours",
    "where": "To add a skill, make a folder with a SKILL.md file in one of these:",
    "where.user": "yours, every project",
    "where.project": "this project only",
    "newHint": "/skills new <name> starts one from a template.",
    "skipped": "Skipped {name}: {why}",
    "why.name": "a name may use only a-z, 0-9, - and _ (up to 64)",
    "why.command": "a command has the same name",
    "why.outside": "it points outside its folder",
    "why.duplicate": "another skill in the same folder has this name",
    "why.limit": "only the first {n} skills are used",
    "usage": "Usage: /skills to list them, /skills new <name> to start one.",
    "new.badName": "\"{name}\" cannot be a skill name: use a-z, 0-9, - and _ (up to 64), starting with a letter or a digit.",
    "new.command": "/{name} is already a command. Choose another name.",
    "new.exists": "A skill named {name} is already there: {path}",
    "new.created": "Created {path}. Write its steps, then type /{name} to use it.",
    "new.replaces": "It replaces the built-in /{name} skill.",
    "new.failed": "Could not create {path}.",
  }),
  ar: Object.freeze({
    "tag": "مهارة",
    "cmd": "عرض المهارات أو إنشاء مهارة جديدة",
    "title": "المهارات",
    "scope.builtin": "مهارات مدمجة",
    "scope.user": "مهاراتك",
    "scope.project": "هذا المشروع",
    "none": "لا شيء بعد",
    "replaces.builtin": "بديلة عن المدمجة",
    "replaces.user": "بديلة عن مهارتك",
    "where": "لإضافة مهارة أنشئ مجلدا فيه ملف " + L("SKILL.md") + " داخل أحد هذين المجلدين:",
    "where.user": "لك في كل المشاريع",
    "where.project": "لهذا المشروع فقط",
    "newHint": "الأمر " + L("/skills new <name>") + " ينشئ مهارة من قالب.",
    "skipped": "تم تجاهل {name}: {why}",
    "why.name": "الاسم يقبل فقط " + L("a-z 0-9 - _") + " وحتى 64 حرفا",
    "why.command": "يوجد أمر بالاسم نفسه",
    "why.outside": "يشير إلى مكان خارج مجلده",
    "why.duplicate": "توجد مهارة أخرى بالاسم نفسه في المجلد ذاته",
    "why.limit": "تستخدم أول {n} مهارة فقط",
    "usage": "الاستخدام: " + L("/skills") + " لعرضها، و" + L("/skills new <name>") + " لإنشاء مهارة.",
    "new.badName": "لا يصلح " + L("\"{name}\"") + " اسما لمهارة: استخدم " + L("a-z 0-9 - _") + " وحتى 64 حرفا، وابدأ بحرف أو رقم.",
    "new.command": "يوجد أمر باسم " + L("/{name}") + " مسبقا. اختر اسما آخر.",
    "new.exists": "توجد مهارة باسم " + L("{name}") + " في: " + L("{path}"),
    "new.created": "تم إنشاء " + L("{path}") + ". اكتب خطواتها ثم اكتب " + L("/{name}") + " لاستخدامها.",
    "new.replaces": "ستحل محل المهارة المدمجة " + L("/{name}") + ".",
    "new.failed": "تعذر إنشاء " + L("{path}") + ".",
  }),
});

registerStrings("app", {
  en: Object.fromEntries(Object.entries(SKILL_STRINGS.en).map(([key, value]) => [`skills.${key}`, value])),
  ar: Object.fromEntries(Object.entries(SKILL_STRINGS.ar).map(([key, value]) => [`skills.${key}`, value])),
});

/** One of the strings above, in the current language: skillText("scope.user") is t("app.skills.scope.user"). */
export function skillText(key, params) { return t(`app.skills.${key}`, params); }
