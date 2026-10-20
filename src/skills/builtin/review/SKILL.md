---
name: review
description: Review the uncommitted changes for real bugs, reported by severity with file and line
description-ar: مراجعة التغييرات الحالية بحثا عن أخطاء حقيقية مرتبة حسب الخطورة
---

# Review the current changes

Goal: find what in the change would actually hurt (wrong results, crashes, data loss, security holes, broken callers) and report it so it can be fixed. Style is not the job.

1. Collect the change. Run `git status` and `git diff HEAD` to see staged and unstaged edits, and read every untracked file that belongs to the change. If the request names files, a branch or a commit range, review that instead. If there is nothing to review, say so and stop.
2. Read around each hunk. Open the changed functions in full, then their callers and their tests: a diff on its own hides what it breaks.
3. Question every change:
   - What input breaks it: empty, missing, very large, non-ASCII text, a path with spaces, two calls at once, the error path?
   - Does every caller still get what it expects (types, return values, thrown errors, side effects)?
   - Are files, handles, timers and processes released on every path, including failures?
   - Can text the user or a remote party controls reach a shell, a query, a file path or HTML without escaping?
   - Do the tests cover the new behaviour, and do they still pass?
4. Verify before you report. Run the relevant tests or a short check whenever that settles a question. Drop anything you cannot back with the code you read.
5. Report the findings, most severe first:
   - **High**: wrong behaviour, a crash, data loss or a security hole.
   - **Medium**: a likely bug under realistic conditions, or a case the change forgot.
   - **Low**: a real but minor risk.
   For each one give `path:line`, what goes wrong and when, and the smallest fix.
6. Leave out style nits, naming opinions and rewrites of code that works. If nothing real turns up, say the change looks correct and list what you checked.

Do not edit files during the review unless the user asks for the fixes.
