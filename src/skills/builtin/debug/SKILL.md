---
name: debug
description: Reproduce a failure, find its root cause, fix it, and prove the fix
description-ar: إعادة إنتاج الخطأ ومعرفة سببه الحقيقي ثم إصلاحه وإثبات الإصلاح
---

# Debug a failure

1. Reproduce it. Take the exact failing command, test or steps from the request (or find them), run them, and capture the full error. If it does not fail, say so and ask for what is missing.
2. Read the error from its first relevant line: the message, the stack, the file and line inside this project.
3. Form one hypothesis about the cause and test it with the smallest experiment: read the code path, add a temporary print, narrow the input, or look at recent changes with `git log -p` and `git diff`.
4. Go to the root cause, not the symptom. Ask why the bad value or state exists, and keep asking until you reach the line that is actually wrong.
5. Fix it with the smallest change that removes the cause. Remove every temporary print.
6. Prove it. Run the original reproduction and the related tests. When the project has tests, add one that fails without the fix.
7. Report the cause in one or two sentences with `path:line`, the fix, and the evidence that it now works.

After two failed attempts with the same idea, step back and try a different hypothesis. Never hide the error: no blanket try/catch, no skipped or deleted tests, no silenced warnings.
