---
kind: frontend_style
name: Tailwind CSS v3 CDN with Inline Design Tokens and Utility-First Styling
category: frontend_style
scope:
    - '**'
source_files:
    - index.html
---

The project uses a zero-build, utility-first styling approach built entirely around Tailwind CSS v3 loaded from the CDN (`cdn.tailwindcss.com`). All styling lives in a single `index.html` file — there are no external `.css`, `.scss`, or component-library files. The style system is organized as follows:

**1. Runtime Tailwind configuration**
A `<script>` block sets `tailwind.config` at runtime, enabling `darkMode: 'class'` and extending the theme with custom design tokens:
- Font family: Inter + system-ui fallback
- Custom color palette: `surface.{50..900}` (slate-based dark/light backgrounds), `accent` (indigo primary), `carrier` (red alerts), `procure` (amber purchase alerts)
- Custom keyframes/animations: `fade-in`, `slide-up`, `pulse-ring`, `shake`

**2. Custom styles via `<style type="text/tailwindcss">`**
The page defines application-level reusable components using Tailwind's `@apply` directive inside a `text/tailwindcss` block, including:
- Layout primitives: `.card`, `.modal-overlay`, `.modal-content`
- Form elements: `.input-field`, `.label`, `.inline-input`
- Buttons: `.btn-accent`, `.btn-secondary`, `.nav-btn`, `.adj-btn`
- Status indicators: `.badge-*`, `.row-carrier`, `.row-procure`
- Feedback: `.toast`, `.toast-success/error/info`
- Print-specific rules for label generation and manifest output
- Shelf-label print layout (4×2 in labels with QR codes)

**3. Dark mode strategy**
The root `<html>` element starts with `class="dark"`. Theme toggling is handled by adding/removing the `dark` class on `<html>`, and every styled element uses the `dark:` variant to provide alternate colors, backgrounds, and borders.

**4. Responsive strategy**
Responsive breakpoints are applied inline throughout the markup using Tailwind's responsive prefixes (`sm:`, `md:`, `lg:`). The layout switches from stacked columns on mobile to multi-column grids on larger screens. Some features (like action buttons) force visibility on small screens via a `@media (max-width: 1023px)` override.

**5. Print styling**
Dedicated `@media print` rules hide UI chrome and render only the relevant content area. A special `body.printing-label` mode hides everything except a generated `#print-container` that lays out shelf labels in inches (`in`) units for physical label printers.

**6. Inline styles for complex/one-off cases**
Where Tailwind classes become unwieldy (notably the login overlay background gradient, backdrop blur, and some label dimensions), inline `style=` attributes are used directly in the HTML. This is acceptable given the single-file architecture but should be minimized for maintainability.

**7. External assets**
- Google Fonts (Inter) loaded via `<link>`
- PWA manifest and icons referenced via standard meta/link tags
- No CSS framework other than Tailwind; no CSS-in-JS library, no SCSS/Sass pipeline, no build step

**Conventions developers should follow:**
- Prefer Tailwind utility classes over new custom CSS; use `@apply` only for genuinely reusable component-like patterns already defined in the `text/tailwindcss` block.
- Always pair light-mode classes with their `dark:` counterparts when writing new styles.
- Use the existing token colors (`surface-*`, `accent`, `carrier`, `procure`) instead of hardcoding hex values.
- Keep responsive behavior consistent with the established breakpoint pattern (`sm:`, `md:`, `lg:`).
- For print-related changes, add rules under the existing `@media print` section rather than creating separate print stylesheets.