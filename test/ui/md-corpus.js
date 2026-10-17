// Documents shared by the markdown and stream tests. "§" stands for a backtick so the sources stay readable.
const T = s => s.replaceAll("§", "`");

export const CORPUS = {
  english: T(`# Getting started with the project

This is a **fairly long paragraph** that goes on and on so that it needs to wrap across several rows when rendered at a narrow width, with §inline code§ and *emphasis* and [a link](https://example.com/some/long/path?query=1) thrown in for good measure. Another sentence follows right here to make it longer still.

Second paragraph line one
second line without blank in between, with an unclosed **bold and *nested italic* inside.

## Lists

- apples and a long explanation that wraps to the next line because the text is long enough to do so
- bananas
  - green ones
  - yellow ones
    - very yellow
- cherries

1. First step
2. Second step with §code§
   continuation text under the item
3. Third step

- [ ] unchecked task
- [x] checked task

> A quoted line that is fairly long and will wrap when the width is small enough to force it.
> Second quoted line

---

Done.`),

  arabic: T(`# البدء مع المشروع

هذه فقرة عربية طويلة جدا تحتوي على كلمات كثيرة حتى تحتاج إلى الالتفاف على عدة أسطر عند العرض في عرض ضيق، وفيها §كود داخل السطر§ و **نص عريض** و *نص مائل* ورابط [الموقع](https://firasai.org/docs/arabic) وغير ذلك من العناصر.

سطر ثان من الفقرة بدون سطر فارغ قبله، وفيه **عريض غير مغلق ثم نص آخر.

## القوائم

- التفاح وشرح طويل يلتف إلى السطر التالي لأن النص طويل بما يكفي لذلك تماما
- الموز
  - الأخضر
  - الأصفر
- الكرز

1. الخطوة الأولى
2. الخطوة الثانية مع §npm test§ وبعض الكلمات
3. الخطوة الثالثة

> اقتباس عربي طويل نسبيا حتى يلتف عندما يكون العرض صغيرا بما فيه الكفاية.

النهاية.`),

  mixed: T(`قم بتشغيل §npm test§ ثم ارجع إلى الملف src/app.js الذي يحتوي على 3 دوال (جيدة) وأخرى [سيئة] ثم {x}.

The Arabic word مرحبا means hello and the phrase بسم الله الرحمن الرحيم is common in Arabic text.

Firas Code هو وكيل برمجة يعمل داخل الطرفية ويدعم اللغة العربية بشكل كامل مع كل الميزات التي تحتاجها.

- عنصر with English words داخل القائمة
- item مع §code§ وكلمات`),

  tables: T(`Here is a table:

| الاسم | العمر | المدينة |
|:------|:-----:|--------:|
| أحمد | 25 | بغداد |
| فاطمة | 31 | البصرة |
| Bob | 40 | Erbil |

| Name | Description | Notes |
|------|-------------|-------|
| alpha | A rather long description that definitely needs to wrap inside its column when narrow | ok |
| beta | short | §a \\| b§ |

After the table there is text.
| not | a table |
just a pipe line.`),

  code: T(`Some code:

§§§js
// comment
const x = §template
spanning lines§;
/* block
comment */
function foo(a, b) { return a + b; } // trailing comment that is quite long and will need wrapping at narrow widths
§§§

§§§python
def f(x):
    """docstring
    more"""
    return x * 2  # مرحبا
§§§

§§§
no language here
§§§

~~~bash
echo "hi $USER" && ls -la
~~~

And text right after. An unterminated fence follows:

§§§json
{"a": [1, 2, 3], "b": "c"}`),

  nested: T(`1. Install the tools:
   §§§bash
   npm install
   §§§
2. Run the build
   - substep a
   - substep b
     more text on this item
3. Done

* star item
* another star item

+ plus item

Text after.`),

  harakat: "كِتَابٌ جَمِيلٌ عَلَى الطَّاوِلَةِ وَهَذَا نَصٌّ طَوِيلٌ جِدًّا يَحْتَوِي عَلَى حَرَكَاتٍ كَثِيرَةٍ لِنَرَى كَيْفَ يَتِمُّ الْتِفَافُهُ عَلَى عِدَّةِ أَسْطُرٍ بِشَكْلٍ صَحِيحٍ.\n\nبسم الله الرحمن الرحيم لا إله إلا الله والكلمات لأ لإ لآ مسؤول مئة قراءة",

  emoji: T(`Emoji test 😀 with 👨‍👩‍👧 family and flags 🇮🇶 plus text that wraps around so we get a long enough line for the wrapper to work with 🎉🎉🎉 end.

- list with 😀 emoji
- 日本語のテキストと English mixed together 漢字 テスト`),

  inline: T(`*a* **b** ***c*** _d_ __e__ ~~f~~ §g§ §§h § i§§ [j](k) [l] [m](n o) ![img](x.png) <https://auto.link> <br> a_b_c 2*3*4 5 * 6 ** 7 \\*esc\\* &amp; &lt;tag&gt;
**unclosed bold at the end of the line and some more words to make it wrap
*also unclosed italic and then §unclosed code and [unclosed link](http://x
a line ending with two stars **
***bold italic*** and **bold *nested italic* bold** and *italic **nested bold** italic*`),

  blocks: T(`> quote one
> > nested quote
> back

> - item in quote
> # heading in quote

# H1
## H2
### H3
#### H4
##### H5
###### H6
####### seven
#hashtag not heading
#
## trailing ##`),

  longline: "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(10) + "\n\n" + "https://example.com/" + "x".repeat(150) + " tail\n",

  windows: T("# Title\r\n\r\nFirst line\r\nsecond line with §code§\r\n\r\n- one\r\n- two\r\n\r\n§§§js\r\nlet a = 1;\r\n§§§\r\n"),

  arabicTable: T(`| الوضع | القراءة | التعديل | الأوامر |
|:------|:-------:|:-------:|--------:|
| الافتراضي | بصمت | يسأل | يسأل |
| قبول التعديلات | بصمت | بصمت | يسأل |

| Key | القيمة<br>الثانية |
|-----|----------|
| a | b |`),

  wideTable: T(`| one | two | three | four | five | six |
|-----|-----|-------|------|------|-----|
| aaaaaaaaaaaaaaaaaa | bbbbbbbbbbbbbbbbbbbbbbbb | cccccccccccccccccccc | dddddddddddddddddd | eeeeeeeeeeeeeeee | fffffffffffffffff |
| 1 | 2 | 3 | 4 | 5 | 6 |`),

  tasks: T(`- [ ] open
- [x] done with a really long description that has to be wrapped around to the next line
  - [ ] nested open
1) paren numbered
2) second

Text then a rule
***
Final §code §§ here§§ end`),

  tiny: "ok",
};

export const NAMES = Object.keys(CORPUS);
