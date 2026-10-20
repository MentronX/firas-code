---
name: explain
description: Explain a file, function or idea in this codebase, from the code itself
description-ar: شرح ملف أو دالة أو فكرة في هذا المشروع من الكود نفسه
---

# Explain code

Goal: a clear and correct explanation grounded in this codebase, not in general knowledge.

1. Find the subject. Locate the file, function or concept the request names with Glob and Grep. If several things match, pick the most likely one and say which you chose.
2. Read the code itself, then one level around it: where it is called from, what it calls, its tests and its configuration.
3. Explain in this order:
   - what it is for, in one or two sentences;
   - how it works, step by step through the real code paths;
   - what goes in and what comes out (data, files, side effects);
   - the parts that are not obvious: edge cases, error handling, performance, decisions explained in comments.
4. Cite `path:line` for every claim, and quote only the few lines that matter.
5. Match the depth to the question: a quick question gets a short answer. Use a small list or diagram only when it makes things clearer.
6. Say plainly what the code does not tell you. Never describe behaviour you did not read.

Do not change any files.
