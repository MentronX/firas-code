---
name: design
description: Automatically use for any task involving UI, UX, visual design, web or app interface, design system, styling, layout, typography, color, interaction, accessibility, responsive behavior, or design review
description-ar: تُستخدم تلقائيا لأي مهمة تتعلق بواجهة أو تجربة مستخدم أو تصميم بصري أو نظام تصميم أو تيبوغرافي أو ألوان أو تفاعل أو استجابة أو مراجعة تصميم
---

# Professional interface design

Goal: produce an interface that looks like it was made by a designer, not a generic template, while staying inside the project’s stack, style and accessibility rules.

## UI/UX Pro Max priority order

These rules come from the **ui-ux-pro-max** skill and apply to every web, mobile, or desktop interface task:

1. **Accessibility** — contrast at least 4.5:1, real alt text, keyboard navigation, ARIA labels, visible focus.
2. **Touch and interaction** — minimum 44×44 px touch targets, at least 8 px spacing, clear loading feedback, no hover-only affordances.
3. **Performance** — WebP/AVIF where useful, lazy loading, reserve layout space, avoid layout thrashing.
4. **Style selection** — match the product type, keep visual language consistent, use SVG icons, avoid random mixing of flat and skeuomorphic.
5. **Layout and responsive** — mobile-first breakpoints, no horizontal scroll, no fixed-width containers, never disable zoom.
6. **Typography and color** — base 16 px, line-height around 1.5, semantic color tokens, no raw hex scattered through components.
7. **Animation** — timing must fit context, motion must explain or guide, no one-duration-fits-all, no animating width/height where transform works.
8. **Forms and feedback** — visible labels, errors next to the field, helper text, progressive disclosure, never placeholder-only labels.
9. **Navigation** — predictable back behavior, bottom navigation at most 5 items, deep links where meaningful.
10. **Charts and data** — legends, tooltips, accessible colors, never rely on color alone.

For a new project or a whole new page, build a **design system** first: style direction, palette, typography, spacing scale, layout grid, motion rules, component states, and accessibility rules. Do not start from an isolated component.

## Stack and query contract

- Detect the implementation stack from the project itself: `package.json`, Tailwind config, framework files, or the existing component library.
- Do not guess the stack.
- If stack-specific guidance matters, search for that stack’s implementation rules.
- Keep each search focused on one dominant intent and 2–5 meaningful terms.
- If the first search misses, retry once with a narrower phrase or an explicit domain.
- If `UiLibrary` answers with 404, treat it as “this deployment has no component-library endpoint yet”, do not call it again in the same task, and continue with the built-in design rules below.
- If a design-system master file already exists, use it as the source of truth and only add page-specific overrides.
- For dashboards or dense tools, use a denser spacing scale.
- For marketing or content pages, use a more spacious scale.
- Tune motion deliberately: subtle for utility apps, richer for marketing or immersive experiences.

1. Understand the product before you draw anything:
   - Who uses it, what they want to finish, what the most important action is.
   - The existing design language: colors, spacing, type scale, radii, shadows, motion, component patterns.
   - The platform: web, desktop app, mobile, dashboard, marketing page, terminal-adjacent UI.
2. Inspect the current implementation before proposing a new one:
   - Read the page, its layout, its CSS/Tailwind setup, its component boundaries, and the screens next to it.
   - If the project already has design tokens, a theme, or a component library, use it; do not invent a second design system.
3. Use `UiLibrary` as the design-intelligence source for professional references and components:
   - For a new page or project, generate a full design-system direction first.
   - Search for inspiration or components that match the page’s purpose.
   - Fetch only one or two concrete components, not a pile of examples.
   - Adapt what you get: replace colors, type, spacing, states, labels, and language with the project’s own.
   - Do not paste a component unchanged if the project has different conventions or needs.
   - If the project has an existing `MASTER.md` or design-system folder, read it before generating a new direction.
4. Build the design as a system, not as one screen:
   - Hierarchy: one primary action, clear secondary actions, obvious content flow.
   - Layout: consistent grid, responsive behavior, stable alignment, no arbitrary spacing.
   - Typography: a real scale, readable line height, consistent weights, clear headings.
   - Color: accessible contrast, meaningful state colors, a restrained palette.
   - Components: consistent sizes, focus states, hover states, disabled states, loading/empty/error states.
   - Motion: only where it helps understanding or orientation.
5. Support Arabic properly:
   - Right-to-left layout when Arabic is the primary language.
   - Natural Arabic wording, no machine-literal translation.
   - Keep code, numbers, and commands in the correct direction.
6. Verify like a designer and an engineer:
   - Check the responsive breakpoints.
   - Check keyboard navigation and focus visibility.
   - Check contrast and touch targets.
   - Run the relevant build, type check, or visual test when available.
7. Finish with the design decisions and evidence:
   - What visual direction was used and why.
   - Which files changed.
   - What was verified and how.
   - What remains unresolved.

Do not add decorative effects that hurt readability or performance. Do not break the existing user flow.