---
name: blueprint
description: Build a complete execution plan before changing a complex feature
description-ar: بناء خطة تنفيذ كاملة قبل تعديل ميزة معقدة
---

# Complete execution blueprint

Goal: understand the problem, map the real code, choose a sound approach, and write a plan a developer can follow without guessing.

1. Define the work:
   - State the desired outcome in one sentence.
   - List the constraints that cannot be broken.
   - Name the user-visible result.
2. Investigate before planning:
   - Use `Glob`, `Grep`, and `Read` to find the relevant files, components, tests, and callers.
   - Use the `Agent` tool for broad or open-ended searches.
   - Do not invent a file or behavior you have not read.
3. Map the current path:
   - Which files own the behavior.
   - Which functions or components call them.
   - Which tests already cover them.
   - Which parts are stable and which are risky.
4. Consider at least two approaches:
   - Keep the existing architecture if it still fits.
   - Say why the chosen approach wins: smaller diff, better clarity, lower risk, better performance, or better user experience.
5. Write the plan in this order:
   - Goal.
   - Files to change.
   - Step-by-step implementation.
   - Tests and verification.
   - Risks and rollback.
6. Keep the plan specific:
   - Every step should name a file or a behavior.
   - No vague “improve” or “optimize” without a measurable result.
7. If the user approves, execute the plan in order and update the checklist as work progresses.

Do not begin implementation before the plan is complete unless the user explicitly asks for immediate work.