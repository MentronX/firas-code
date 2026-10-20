// Strings of the effort picker (/effort with no argument) and of the rows /status added, namespace "app".
//
// Kept apart from strings-app.js so the picker can be changed without touching the table every command shares. Keys:
// "effortpick.*" for the picker, "statusview.*" for /status.
//
//  - The descriptions are short on purpose: they share a row with the name and the meter, and the app.effort.hint.*
//    texts of the plain menu are too long for that (and their Arabic carries harakat, which take a cell of their own in
//    Windows Terminal). No harakat, shadda or tanween here.
//  - Every Latin snippet inside an Arabic string (a key name, "ultracode") sits in an LTR isolate, like strings-app.js.
//  - The key hint is stored as PARTS ("effortpick.key.*"): a narrow box drops parts from the end instead of wrapping in
//    the middle of a pair.
import { registerStrings } from "../i18n/index.js";

const L = s => "\u2066" + s + "\u2069";

registerStrings("app", {
  en: {
    "effortpick.title": "Effort",
    "effortpick.subtitle": "How much thinking and checking goes into each turn.",
    "effortpick.desc.low": "Quick answers, light checks",
    "effortpick.desc.medium": "Balanced, the default",
    "effortpick.desc.high": "Reads more before it acts",
    "effortpick.desc.xhigh": "Plans and checks its work",
    "effortpick.desc.max": "Everything it has, every turn",
    "effortpick.desc.ultracode": "Parallel agents, plans, two reviews",
    "effortpick.current": "current",
    "effortpick.key.choose": "{ud} choose",
    "effortpick.key.tab": "Tab ultracode",
    "effortpick.key.tabBack": "Tab back",
    "effortpick.key.confirm": "Enter confirm",
    "effortpick.key.cancel": "Esc cancel",
    "effortpick.same": "Effort is already {level}.",

    "statusview.on": "on",
    "statusview.off": "off",
    "statusview.setting": "setting: {mode}",
  },
  ar: {
    "effortpick.title": "الجهد",
    "effortpick.subtitle": "مقدار التفكير والتحقق في كل رد.",
    "effortpick.desc.low": "إجابات سريعة وفحص خفيف",
    "effortpick.desc.medium": "متوازن، وهو الافتراضي",
    "effortpick.desc.high": "يقرأ أكثر قبل أن يعمل",
    "effortpick.desc.xhigh": "يخطط ويراجع عمله",
    "effortpick.desc.max": "كل ما لديه في كل رد",
    "effortpick.desc.ultracode": "وكلاء بالتوازي وخطة ومراجعتان",
    "effortpick.current": "الحالي",
    "effortpick.key.choose": `${L("{ud}")} للتنقل`,
    "effortpick.key.tab": `${L("Tab")} إلى ${L("ultracode")}`,
    "effortpick.key.tabBack": `${L("Tab")} للرجوع`,
    "effortpick.key.confirm": `${L("Enter")} للتأكيد`,
    "effortpick.key.cancel": `${L("Esc")} للإلغاء`,
    "effortpick.same": "الجهد مضبوط على {level} من قبل.",

    "statusview.on": "مفعل",
    "statusview.off": "متوقف",
    "statusview.setting": "الإعداد: {mode}",
  },
});
