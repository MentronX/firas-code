// Bilingual strings for the prompt box, its "/" and "@" menus, the footer line under it and the /help listing
// (namespace "term", next to strings.js).
//
// Decisions:
//  - Latin snippets inside Arabic (a key, a command, "@") sit in an LTR isolate, as in strings.js; the display layer
//    removes the isolates once the line is ordered.
//  - No harakat, shadda or tanween: Windows Terminal gives each mark a cell of its own and the line overflows.
//  - Hints are stored as PARTS ("ask", "slash", "file"), never as one sentence, so a narrow terminal can drop whole
//    parts from the end instead of cutting one in the middle of a key and its meaning.
import { registerStrings } from "../i18n/index.js";

const L = s => "\u2066" + s + "\u2069";

registerStrings("term", {
  en: {
    "menu.skillTag": "skill",

    // "Type a message" stays the first words: the session tests wait for them to know the prompt is up.
    "input.ask": "Type a message",
    "input.askSlash": "/ for commands and skills",
    "input.askFile": "@ for a file",
    "input.askSep": " · ",

    "footer.cycle": "Shift+Tab mode",

    "help.newlineSlash": "new line: a \\ at the end of the line, then Enter",
    "help.newlineCtrl": "new line, in terminals that send it",
    "help.commands": "commands and skills",
  },
  ar: {
    "menu.skillTag": "مهارة",

    "input.ask": "اكتب رسالتك",
    "input.askSlash": `${L("/")} للأوامر والمهارات`,
    "input.askFile": `${L("@")} لإضافة ملف`,
    "input.askSep": " · ",

    "footer.cycle": `${L("Shift+Tab")} الوضع`,

    "help.newlineSlash": `سطر جديد: ${L("\\")} في آخر السطر ثم ${L("Enter")}`,
    "help.newlineCtrl": "سطر جديد، في الطرفيات التي ترسله",
    "help.commands": "الأوامر والمهارات",
  },
});
