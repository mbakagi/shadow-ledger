---
kind: external_dependency
name: Tailwind CSS v3 CDN — runtime utility-class compiler
slug: tailwind-css
category: external_dependency
category_hints:
    - client_constraint
scope:
    - '**'
---

Loaded from `cdn.tailwindcss.com` at runtime; custom theme (dark mode class strategy, Inter font, accent/carrier/procure color palette, keyframes/animations) is configured inline in `<script>` before any Tailwind classes are applied. Because it compiles on the client, CSP must whitelist `https://cdn.tailwindcss.com` under `script-src` and `style-src`.