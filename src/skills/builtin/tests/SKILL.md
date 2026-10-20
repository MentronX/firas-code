---
name: tests
description: Write or extend tests for the given code, run them, and fix until they pass
description-ar: كتابة اختبارات للكود المحدد أو توسيعها وتشغيلها حتى تنجح
---

# Write tests

Goal: tests that pin down the behaviour of the code in question, and that pass.

1. Learn the project's setup first: the test framework, where tests live, how they are named, and how to run a single file (package.json scripts, a Makefile, the project instructions). Follow the existing style exactly. Do not add a framework or a dependency.
2. Read the code under test and list what matters: the main behaviour, the edge cases (empty, boundaries, invalid input, error paths), and anything the request or a bug report mentions.
3. Write focused tests, one behaviour each, with names that say what is expected. Prefer real inputs to mocks; mock only what is slow, random or outside the machine.
4. Run the new tests. When one fails, decide which side is wrong: fix a wrong test; for a real bug in the code, report it with `path:line`, and fix it only if the user asked for fixes.
5. Repeat until they pass, then run the whole relevant suite once to make sure nothing else broke.
6. Finish with what is now covered, the command that runs the tests, and any behaviour you left untested and why.

Never delete, skip or weaken an existing test to make the suite pass.
