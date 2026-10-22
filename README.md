# فراس كود 2

مساعد برمجة يعيش داخل الطرفية. يقرأ مشروعك، ويعدّل الملفات، وينفّذ الأوامر بإذنك، ويتحدث العربية بطلاقة.

[English version below](#english)

## ما هو فراس كود 2؟

تكتب له ما تريده بالعربية أو بالإنجليزية، فيقرأ ملفات مشروعك ويقترح التعديلات ويطبّقها، ويشغّل الاختبارات ويصلح الأخطاء. لا يغيّر ملفاً ولا ينفّذ أمراً ولا يفتح موقعاً قبل أن توافق أنت.

يعمل على ويندوز ثم ماك ثم لينكس، ولا يحتاج منك تثبيت أي شيء آخر.

## التثبيت

اختر طريقة واحدة فقط. لا تحتاج صلاحيات المدير في أي منها.

### الطريقة الأولى: ويندوز (PowerShell)

افتح PowerShell والصق هذا السطر:

```powershell
irm firasai.org/get | iex
```

وإن لم يفتح الرابط القصير عندك فاستخدم الرابط الكامل:

```powershell
irm https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.ps1 | iex
```

إن كان معك رمز الدخول فضعه مباشرة:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.ps1))) -Code FC2-XXXXX-XXXXX
```

يبحث المثبّت عن Node.js في جهازك، وإن لم يجده نزّل نسخة خاصة بالتطبيق بعد التحقق من سلامتها. يوضع كل شيء في المجلد `%USERPROFILE%\.firas-code`، ويمكنك إعادة تشغيل الأمر في أي وقت للتحديث.

### الطريقة الثانية: ماك ولينكس

```bash
curl -fsSL firasai.org/get | bash
```

والرابط الكامل عند الحاجة:

```bash
curl -fsSL https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.sh | bash
```

ومع رمز الدخول:

```bash
curl -fsSL https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.sh | bash -s -- --code FC2-XXXXX-XXXXX
```

### الطريقة الثالثة: لمن عنده Node.js وGit

```bash
npx -y github:MentronX/firas-code
```

## أول تشغيل

اكتب في أي طرفية جديدة:

```bash
firas
```

يسألك أولاً عن اللغة: 1 للعربية أو 2 للإنجليزية. ثم يطلب رمز الدخول الذي أُعطيته، وشكله `FC2-XXXXX-XXXXX-…`. الصقه واضغط Enter. يتحقق البرنامج من الرمز، وبعد أول دخول ناجح يُحفظ في جهازك فلا يُطلب منك مرة أخرى. وإن كنت قد ثبّتّه بالمثبّت مع الرمز فلن يسألك أصلاً: يدخل به مباشرة ثم يحفظه بعد نجاح الدخول.

للعمل على مشروع معيّن، ادخل مجلده أولاً ثم شغّل الأمر:

```bash
cd my-project
firas
```

## جرّب هذه الطلبات

بالعربية:

- اشرح لي بنية هذا المشروع في خمس نقاط.
- أضف زر «مسح» إلى نموذج الإدخال وشغّل الاختبارات.
- لماذا يفشل ملف `login.test.js`؟ أصلحه.
- حوّل هذا الملف من `var` إلى `const` و`let`.
- اكتب ملف `README` قصيراً لهذا المشروع.

بالإنجليزية:

```text
Find where the date is formatted and make it use the 24-hour clock.
Add input validation to the signup form and write a test for it.
Why is the build failing? Fix it and run it again.
Rename the function getData to loadUsers everywhere.
Summarize what changed in the last three commits.
```

## اختصارات لوحة المفاتيح

- إرسال الرسالة: `Enter`
- سطر جديد: `\` ثم `Enter`، أو `Ctrl+J` (و`Shift+Enter` في الطرفيات التي ترسله، وليست منها نافذة ويندوز القديمة)
- إيقاف ما يفعله الآن: `Esc`
- **توجيه أثناء العمل:** اكتب رسالتك ثم `Enter` — تُضاف إلى الدور الجاري فورًا ويقرأها النموذج في الخطوة التالية، بدل انتظار انتهاء الرد.
- تبديل وضع الأذونات: `Shift+Tab`
- توسيع المخرجات المطوية: `Ctrl+O`
- الخروج: `Ctrl+C` مرتين
- اختيار ملف من المشروع: اكتب `@`
- قائمة الأوامر: اكتب `/`

## الأوامر المائلة

اكتب `/` في بداية الرسالة لتظهر القائمة.

- `/help` يعرض المساعدة.
- `/clear` يبدأ محادثة جديدة.
- `/compact` يلخّص المحادثة الطويلة ليوفّر مساحة.
- `/effort` يضبط مقدار تفكيره: `low` أو `medium` أو `high` أو `xhigh` أو `max` أو `ultracode`. اكتبه وحده لتظهر قائمة المستويات: تنقّل بالأسهم، و`Tab` يقفز إلى `ultracode` ويعود، و`Enter` يختار. أو اكتب المستوى مباشرة مثل `/effort high`.
- `ultracode` أعلى مستوى: يرسل وكلاء فرعيين يستكشفون المهمة بالتوازي، ويكتب خطة مرتبة، ويفحص بعد كل خطوة، ثم يراجع التغيير مراجعتين مستقلتين. وإن كتبت كلمة `ultracode` داخل رسالة عملت تلك الرسالة وحدها بهذا المستوى.
- `/mode` يغيّر وضع الأذونات.
- `/lang` يغيّر لغة الواجهة.
- `/arabic` يتحكم بعرض العربية: `auto` أو `on` أو `off`.
- `/skills` يعرض المهارات المتوفرة وأين تضيف غيرها. و`/skills new <name>` ينشئ مهارة جديدة من قالب.
- `/status` يعرض حالة الجلسة.
- `/cost` يعرض ما استُهلك في هذه الجلسة.
- `/copy` ينسخ آخر إجابة بترتيبها الصحيح.
- `/init` يطلب منه كتابة ملف `FIRAS.md` يشرح مشروعك له.
- `/resume` يكمل محادثة سابقة.
- `/sessions` يعرض المحادثات المحفوظة.
- `/checkpoint [label]` يحفظ نقطة استعادة للمحادثة الآن (وتُحفظ تلقائيًا بعد كل خطوة أدوات).
- `/rewind` يعيد المحادثة إلى نقطة استعادة سابقة (لا يرجع الملفات).
- `/memory` يعرض ذاكرة المشروع، و`/memory clear` يمسحها.
- `/logout` ينسى رمز الدخول المحفوظ.
- `/update` يحدّث البرنامج.
- `/exit` يخرج.

## التوجيه والذاكرة ونقاط الاستعادة والتحقق

- **التوجيه أثناء العمل:** بينما يعمل، اكتب ما تريد ثم `Enter`. يُوقف الطلب الجاري بلطف ويُضاف نصك إلى الدور نفسه، فيقرأه النموذج في الخطوة التالية ويعدّل مساره. `Esc` وحده يوقف الدور كله.
- **الذاكرة:** قل «تذكّر أن…» فيحفظها في `.firas/memory.md` بأداة `Remember`، وتُضاف إلى تعليمات كل جلسة لاحقة. `/memory` يعرضها و`/memory clear` يمسحها.
- **نقاط الاستعادة:** تُحفظ نقطة تلقائيًا بعد كل خطوة أدوات، و`/checkpoint` يحفظ واحدة يدويًا. `/rewind` يعيد المحادثة إلى أي نقطة (الملفات على القرص لا تُرجع).
- **التحقق التلقائي:** أي دور يعدّل ملفات يمرّ بعد إجابته على مدقق مستقل يقرأ التغييرات ويشغّل الاختبارات؛ إن وجد مشكلة حقيقية يعيدها للنموذج ليصلحها قبل أن ينتهي الدور. أوقفه بـ`FIRAS_VERIFY=0`.

## المهارات

المهارة ملف تعليمات يحفظ طريقة عمل تتكرر، فيتبعها البرنامج كلما احتاجها. وتأتي معه سبع مهارات جاهزة:

- `/review` يراجع التغييرات غير المحفوظة ويرتب المشكلات حسب خطورتها.
- `/explain` يشرح ملفاً أو دالة أو فكرة من كود المشروع نفسه.
- `/tests` يكتب الاختبارات أو يكملها ويشغلها حتى تنجح.
- `/debug` يعيد إنتاج الخطأ ويجد سببه ويصلحه ويثبت الإصلاح.
- `/docs` يكتب التوثيق أو يحدّثه ليطابق الكود.
- `/blueprint` يبني خطة تنفيذ كاملة قبل تعديل ميزة معقدة.
- `/design` تتفعل تلقائيا لأي مهمة تصميم واجهة أو دراسة تجربة مستخدم، وتستخدم قواعد `ui-ux-pro-max`.

اكتب اسم المهارة بعد `/` ومعه ما تريد، مثل `/review ركز على الأمان`. وتظهر المهارات في قائمة `/` بعد الأوامر. ويختار البرنامج المهارة المناسبة وحده أيضاً حين تطابق طلبك.

ولإضافة مهارة اكتب `/skills new <name>`، ثم عدّل الملف `SKILL.md` الذي ينشئه. تحفظ مهاراتك في مجلد `skills` داخل مجلد البرنامج، ومهارات مشروع معيّن في `.firas/skills` داخل المشروع، ولكل مهارة مجلد باسمها فيه `SKILL.md`. يبدأ الملف بهذه الأسطر:

```
---
name: release
description: Prepare a release: bump the version, update the changelog, tag it
description-ar: تجهيز إصدار جديد
---
```

ثم تكتب تحتها الخطوات بأي لغة. مهارة المشروع تغلب مهارتك بالاسم نفسه، ومهارتك تغلب المهارة الجاهزة. أما المهارات القادمة مع مشروع نسخته من الإنترنت فلها ثقة ملف `FIRAS.md` نفسه، ولا تتجاوز قواعد الأمان أبداً.

## الأمان

الأصل أن يسألك قبل أي أمر يغيّر شيئاً. هذه الأمور تحتاج موافقتك دائماً في الوضع العادي:

- كتابة ملف أو تعديله أو حذفه.
- تشغيل أي أمر في الطرفية.
- فتح موقع على الإنترنت.

عند السؤال تختار: موافقة هذه المرة، أو موافقة طوال الجلسة، أو رفض مع ملاحظة تصل إليه. و`Esc` يعني رفضاً.

أما القراءة داخل مجلد المشروع فتجري بصمت. وللقراءة خارج المجلد يسألك.

وللأذونات أربعة أوضاع، وتبدّلها بـ `Shift+Tab` أو `/mode`:

- `default`: الوضع العادي الموصوف أعلاه.
- `acceptEdits`: تعديل الملفات داخل المشروع دون سؤال، وتبقى الأوامر تسأل.
- `plan`: يقرأ ويخطّط فقط، ولا يغيّر شيئاً حتى توافق على الخطة.
- `bypass`: ينفّذ كل شيء دون سؤال، ويُفعَّل بالخيار `--yolo` فقط. حتى هنا يسألك قبل الأمور الخطرة: حذف المجلدات الجذرية أو مجلد المستخدم، وتهيئة الأقراص، وتشغيل ما يُنزَّل من الإنترنت مباشرة، والكتابة في مجلدات النظام، ولمس الملفات السرّية مثل `.env` ومجلد `.ssh`.

## عرض العربية

- الأفضل استخدام Windows Terminal.
- الطرفيات لا تصل الحروف العربية ولا تعكس اتجاه السطر، فيقوم البرنامج بذلك بنفسه قبل الطباعة. لذلك لو نسخت نصاً من الشاشة بالفأرة لصق بترتيبه البصري المقلوب. استخدم `/copy` لنسخ النص بترتيبه الصحيح.
- إن كانت طرفيتك تعالج العربية وحدها وظهر النص مزدوج الانعكاس، اكتب `/arabic off`. ولتعيده اكتب `/arabic on`. وهناك خيار التشغيل `--no-arabic` ومتغير البيئة `FIRAS_ARABIC=off`.
- يكفي في الغالب خط الطرفية الافتراضي لأنها تستعين بخط النظام للحروف العربية. وإن ظهرت الحروف مفككة أو مربعات فجرّب خطاً فيه حروف عربية، مثل DejaVu Sans Mono أو Kawkab Mono.
- في نافذة ويندوز القديمة (cmd أو PowerShell بدون Windows Terminal) لا يستعين الخط بغيره، فيبدّل البرنامج خط النافذة إلى Courier New تلقائياً إن لم يكن خطها يعرض العربية. التبديل للنافذة الحالية فقط ولا يُحفظ. ولإيقافه ضع متغير البيئة `FIRAS_FONT=keep`.
- هذه النافذة لا ترتب العربية بنفسها أبداً، لذلك يبقى عرض العربية مفعلاً فيها حتى لو حُفظ `off` من قبل، ويحذف البرنامج التشكيل وعلامات الاتجاه المخفية قبل الرسم، لأنها تأخذ فيها خانة كاملة فتُخرج السطر عن مكانه. ويستعمل فيها رموزاً يرسمها خطها فقط.
- إن ظهرت رموز الواجهة مربعات في طرفية ما فاختر مجموعة الرموز بمتغير البيئة `FIRAS_GLYPHS`: `full` أو `console` أو `ascii`.

## حل المشكلات

- **الأمر `firas` غير معروف:** أغلق الطرفية وافتح واحدة جديدة، فتعديل المسار لا يظهر في النافذة المفتوحة. وإن استمر فأعد تسجيل الدخول إلى ويندوز، أو شغّل `%USERPROFILE%\.firas-code\bin\firas.cmd` مباشرة.
- **رمز الدخول غير صالح أو منتهٍ:** اطلب رمزاً جديداً ممّن أعطاك إياه، ثم اكتب `/logout` وأدخل الرمز الجديد.
- **انتهى الحد اليومي:** يتجدد تلقائياً في اليوم التالي.
- **لا يوجد اتصال:** تأكد من الإنترنت، وإن كنت خلف وسيط (Proxy) أو جدار حماية فاسأل مسؤول الشبكة. المثبّت يستخدم إعدادات الوسيط الموجودة في ويندوز تلقائياً.
- **مضاد الفيروسات يحجب التثبيت:** اسمح بالمجلد `%USERPROFILE%\.firas-code` أو أوقفه مؤقتاً، ثم أعد تشغيل أمر التثبيت.
- **يقول إن البرنامج مفتوح أثناء التحديث:** أغلق كل نوافذ فراس كود وأعد المحاولة.
- **أريد تفاصيل الخطأ:** شغّل البرنامج بعد ضبط المتغير `FIRAS_DEBUG=1`.

للتحديث اكتب `/update` داخل البرنامج، أو `firas update`، أو أعد تشغيل أمر التثبيت نفسه.

## الخصوصية

رمز الدخول سرّ شخصي، فلا تتركه يظهر في مكان يراه غيرك:

- الأفضل أن تلصقه في موجّه الإدخال المخفي عند أول تشغيل، أو أن تضعه في متغير البيئة `FIRAS_CODE`. أما الخيار `--code <الرمز>` فيظهر في قائمة العمليات الجارية على جهازك وفي سجل أوامر الطرفية، فتجنّبه.
- الرمز الذي تعطيه للمثبّت بالخيار `-Code` على ويندوز أو `--code` على ماك ولينكس لا يُكتب في سطر الأوامر. يُسلَّم لأول تشغيل فقط عبر المتغير `FIRAS_CODE` الخاص بتلك العملية. فإذا قبله البرنامج حفظه في جهازك مرة واحدة (يظهر سطر هادئ يقول ذلك، ولا يُطبع الرمز أبداً)، وإن لم يتمكن من الاتصال لم يحفظ شيئاً وطلبه منك في المرة التالية. وكتابة الخيار نفسه في الأمر الذي تشغّل به المثبّت تبقيه في سجل الطرفية، فاضبط المتغير `FIRAS_CODE` قبل تشغيل المثبّت وشغّله دون الخيار إن أردت تجنب ذلك.
- الرمز المحفوظ ومحادثاتك المحفوظة في المجلد `.firas-code` الذي في مجلد المستخدم، وعلى ويندوز يقيّد البرنامج هذا المجلد بحسابك وحده.
- الأوامر والبرامج التي ينفّذها البرنامج لا ترى `FIRAS_CODE`.

## الإزالة

على ويندوز:

```powershell
$env:FIRAS_UNINSTALL = "1"; irm https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.ps1 | iex
```

على ماك ولينكس:

```bash
curl -fsSL https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.sh | bash -s -- --uninstall
```

تُزال الأداة ونسخة Node.js الخاصة بها وسطر المسار، وتبقى إعداداتك ومحادثاتك المحفوظة في `.firas-code`. ولحذف كل شيء أضف `-Purge` على ويندوز أو `--purge` على ماك ولينكس.

## الترخيص

حقوق النشر محفوظة لفراس، وهذه النسخة مجانية للتجربة فقط. التفاصيل في ملف `LICENSE`.

---

## English

# Firas Code 2

A coding assistant that lives in your terminal. It reads your project, edits files, runs commands with your permission, and speaks Arabic well.

### What it is

Tell it what you want in Arabic or English. It reads your files, proposes changes and applies them, runs your tests and fixes what breaks. It never changes a file, runs a command or opens a website until you say yes.

It runs on Windows first, then macOS and Linux, and you do not have to install anything else.

### Install

Pick one way. None of them needs administrator rights.

**Windows (PowerShell)**

```powershell
irm firasai.org/get | iex
```

If the short link does not open for you, use the full address:

```powershell
irm https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.ps1 | iex
```

With your access code:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.ps1))) -Code FC2-XXXXX-XXXXX
```

The installer looks for Node.js on your computer. If there is none, it downloads a private copy and checks its SHA-256 first. Everything goes into `%USERPROFILE%\.firas-code`, and running the command again updates it.

**macOS and Linux**

```bash
curl -fsSL firasai.org/get | bash
```

The full address, if needed:

```bash
curl -fsSL https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.sh | bash
```

With your access code:

```bash
curl -fsSL https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.sh | bash -s -- --code FC2-XXXXX-XXXXX
```

**If you already have Node.js and Git**

```bash
npx -y github:MentronX/firas-code
```

### First run

Open a new terminal and type:

```bash
firas
```

It asks for a language first (1 for Arabic, 2 for English), then for the access code you were given. It looks like `FC2-XXXXX-XXXXX-…`. Paste it and press Enter. The program checks it, and after the first successful sign-in it is saved on your computer, so you are not asked again. If you installed with the code, it does not ask at all: it signs in with it straight away and saves it once that works.

To work on a project, go into its folder first:

```bash
cd my-project
firas
```

### Try these

```text
اشرح لي بنية هذا المشروع في خمس نقاط.
أضف زر «مسح» إلى نموذج الإدخال وشغّل الاختبارات.
لماذا يفشل ملف login.test.js؟ أصلحه.
حوّل هذا الملف من var إلى const و let.
اكتب ملف README قصيراً لهذا المشروع.
Find where the date is formatted and make it use the 24-hour clock.
Add input validation to the signup form and write a test for it.
Why is the build failing? Fix it and run it again.
Rename the function getData to loadUsers everywhere.
Summarize what changed in the last three commits.
```

### Keyboard shortcuts

- Send the message: `Enter`
- New line: `\` then `Enter`, or `Ctrl+J` (and `Shift+Enter` in terminals that send it; the classic Windows console does not)
- Stop what it is doing: `Esc`
- Switch permission mode: `Shift+Tab`
- Expand folded output: `Ctrl+O`
- Quit: `Ctrl+C` twice
- Pick a file from the project: type `@`
- Command menu: type `/`

### Slash commands

Type `/` at the start of a message to see the list.

- `/help` shows help.
- `/clear` starts a fresh conversation.
- `/compact` summarizes a long conversation to free up room.
- `/effort` sets how hard it thinks: `low`, `medium`, `high`, `xhigh`, `max` or `ultracode`. Type it alone to get the list of levels: move with the arrows, `Tab` jumps to `ultracode` and back, `Enter` chooses. Or name the level directly, as in `/effort high`.
- `ultracode` is the top level: sub-agents map the task in parallel, it writes a checklist plan, checks after every step, and has the change reviewed twice, independently. Writing the word `ultracode` in a message gives that one message the same treatment.
- `/mode` changes the permission mode.
- `/lang` changes the interface language.
- `/arabic` controls Arabic display: `auto`, `on` or `off`.
- `/skills` lists the available skills and where to add more. `/skills new <name>` creates a new one from a template.
- `/status` shows the state of the session.
- `/cost` shows what this session has used.
- `/copy` copies the last answer in its correct order.
- `/init` asks it to write a `FIRAS.md` file that explains your project to it.
- `/resume` continues an earlier conversation.
- `/sessions` lists saved conversations.
- `/logout` forgets the saved access code.
- `/update` updates the program.
- `/exit` quits.

### Skills

A skill is a file of instructions that captures a way of working you repeat, so it follows that way whenever it is needed. Seven come built in:

- `/review` reviews the uncommitted changes and ranks the problems by severity.
- `/explain` explains a file, a function or an idea from the project's own code.
- `/tests` writes or extends tests and runs them until they pass.
- `/debug` reproduces a failure, finds its cause, fixes it and proves the fix.
- `/docs` writes or updates documentation to match the code.
- `/blueprint` builds a complete execution plan before changing a complex feature.
- `/design` activates automatically for interface design and UX study tasks, and applies the `ui-ux-pro-max` rules.

Type the skill's name after `/` together with what you want, as in `/review focus on security`. Skills appear in the `/` menu after the commands, and it also picks a fitting skill by itself when one matches your request.

To add a skill, type `/skills new <name>` and edit the `SKILL.md` file it creates. Your skills live in the `skills` folder inside the program's folder, a project's own skills in `.firas/skills` inside the project, and each skill is a folder with its name holding a `SKILL.md`. The file starts with these lines:

```
---
name: release
description: Prepare a release: bump the version, update the changelog, tag it
description-ar: تجهيز إصدار جديد
---
```

followed by the steps, in any language. A project skill wins over yours with the same name, and yours wins over a built-in one. Skills that come with a project you cloned from the internet get the same trust as its `FIRAS.md`, and never override the safety rules.

### Safety

By default it asks before anything that changes something. In the normal mode these always need your yes:

- Writing, editing or deleting a file.
- Running any command in the terminal.
- Fetching a website.

When it asks you can allow once, allow for the rest of the session, or deny, optionally with a note that goes back to it. `Esc` means deny.

Reading files inside the project folder is silent. Reading outside it asks first.

There are four permission modes, switched with `Shift+Tab` or `/mode`:

- `default`: the normal mode described above.
- `acceptEdits`: edits inside the project need no question, commands still ask.
- `plan`: it only reads and plans, and changes nothing until you approve the plan.
- `bypass`: runs everything without asking, and only turns on with the `--yolo` option. Even here it still asks before dangerous things: deleting a drive root or your home folder, formatting disks, running something piped straight from the internet, writing to system folders, and touching secrets such as `.env` files and the `.ssh` folder.

### Arabic display

- Windows Terminal is the best choice.
- Terminals do not join Arabic letters or reverse the direction of a line, so the program does both itself before printing. That means text you select with the mouse pastes in its visual, reversed order. Use `/copy` to copy text in the right order.
- If your terminal already handles Arabic by itself and the text looks flipped twice, type `/arabic off`. Type `/arabic on` to switch it back. There is also the `--no-arabic` option and the `FIRAS_ARABIC=off` environment variable.
- The default terminal font is usually fine because terminals borrow a system font for Arabic letters. If letters look broken or show as boxes, try a font that includes Arabic, such as DejaVu Sans Mono or Kawkab Mono.
- The classic Windows console window (cmd or PowerShell without Windows Terminal) borrows no other font, so when its font cannot draw Arabic the program switches that window to Courier New by itself. Only the current window changes, and nothing is saved. Set `FIRAS_FONT=keep` to turn this off.
- That window never arranges Arabic by itself, so Arabic display stays on there even if `off` was saved before, and the program removes vowel marks and hidden direction marks before drawing: that window gives each one a whole cell, which pushes the line out of place. It also uses only symbols its font can draw.
- If interface symbols show as boxes in some terminal, choose the symbol set with the `FIRAS_GLYPHS` environment variable: `full`, `console` or `ascii`.

### Troubleshooting

- **`firas` is not recognized:** close the terminal and open a new one. The PATH change does not reach windows that were already open. If it still fails, sign out of Windows and back in, or run `%USERPROFILE%\.firas-code\bin\firas.cmd` directly.
- **Access code invalid or expired:** ask whoever gave it to you for a new one, then type `/logout` and enter the new code.
- **Daily limit reached:** it resets by itself the next day.
- **Offline:** check your internet connection. Behind a proxy or firewall, ask your network administrator. The installer uses the proxy settings that Windows already has.
- **Antivirus blocks the install:** allow the folder `%USERPROFILE%\.firas-code` or pause the antivirus briefly, then run the install command again.
- **An update says the program is running:** close every Firas Code window and try again.
- **I want the details of an error:** set `FIRAS_DEBUG=1` before starting the program.

To update, type `/update` inside the program, run `firas update`, or run the install command again.

### Privacy

Your access code is a personal secret, so do not let it show up where others can see it:

- Prefer pasting it into the hidden-input prompt on first run, or putting it in the `FIRAS_CODE` environment variable. The `--code <code>` option shows up in the list of running processes on your computer and in your terminal history, so avoid it.
- A code you give the installer with `-Code` on Windows or `--code` on macOS and Linux is not written on a command line. It is handed to the first launch only, through the `FIRAS_CODE` variable of that one process. If the program accepts it, it saves the code on your computer once (a quiet line says so, and the code itself is never printed); if it cannot connect, nothing is saved and it asks for the code next time. Typing the option into the installer command itself leaves it in your terminal history, so set the `FIRAS_CODE` variable first and run the installer without the option if you want to avoid that.
- The saved code and your saved conversations live in the `.firas-code` folder in your user folder. On Windows the program limits that folder to your account alone.
- Commands and programs that this program starts do not see `FIRAS_CODE`.

### Uninstall

Windows:

```powershell
$env:FIRAS_UNINSTALL = "1"; irm https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.ps1 | iex
```

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.sh | bash -s -- --uninstall
```

This removes the program, its private Node.js copy and the PATH entry. Your settings and saved conversations stay in `.firas-code`. To delete those too, add `-Purge` on Windows or `--purge` on macOS and Linux.

### License

Copyright (c) 2026 Firas. All rights reserved. Free of charge for evaluation only. See the `LICENSE` file.
