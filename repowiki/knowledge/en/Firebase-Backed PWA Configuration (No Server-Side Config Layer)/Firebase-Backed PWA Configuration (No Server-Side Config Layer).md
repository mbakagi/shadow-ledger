---
kind: configuration_system
name: Firebase-Backed PWA Configuration (No Server-Side Config Layer)
category: configuration_system
scope:
    - '**'
source_files:
    - firebase-config.js
    - firebase.json
    - firestore.rules
    - manifest.json
    - index.html
    - app.js
---

This repository does not implement a traditional server-side configuration system. Instead, configuration is distributed across several client-side and Firebase-hosting files, reflecting its zero-build single-page PWA architecture.

**What system/approach is used**
- **Firebase Hosting + Firestore**: The app is hosted via `firebase.json` with SPA rewrites (`** → /index.html`) and security rules in `firestore.rules`. There is no Node.js or backend config loader — all runtime configuration lives on the client.
- **Hardcoded Firebase credentials**: `firebase-config.js` contains a literal `firebaseConfig` object with `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, and `appId`. These are committed to source and loaded at page startup; there is no `.env`, env-var injection, or build-time replacement.
- **PWA manifest**: `manifest.json` declares install metadata, icons, shortcuts, theme/background colors, and scope — this is the only JSON-based declarative config consumed by the browser.
- **Tailwind runtime config**: Tailwind's theme, colors, fonts, keyframes, and animations are configured inline inside `<script>tailwind.config = {...}</script>` in `index.html`, not via a separate config file.
- **Service Worker & CSP**: `sw.js` (not shown) handles caching; `index.html` embeds a strict Content-Security-Policy meta tag listing allowed CDN origins for scripts, styles, fonts, and Firestore/Identity Toolkit endpoints.
- **Firestore Security Rules**: `firestore.rules` defines per-user read/write boundaries (`ownerId == request.auth.uid`) and required fields — effectively acting as the data-layer policy configuration.

**Key files and packages**
- `firebase-config.js` — Firebase SDK init + Firestore persistence enablement
- `firebase.json` — Hosting deployment config (public dir, SPA rewrite, cache/security headers)
- `firestore.rules` — Per-collection access control and field validation
- `manifest.json` — PWA installability, icons, shortcuts, theme color
- `index.html` — Inline Tailwind config, CSP, CDN script imports, DOM shell
- `app.js` — Application constants (`STORAGE_KEY`, `THEME_KEY`, `PAGE_SIZE`, location IDs `LOC_DEPOT`/`LOC_BUILDING`) and sample-data seed keys
- `sw.js` — Service worker (caching strategy, offline behavior)

**Architecture and conventions**
- **Client-only config**: All configuration is evaluated in the browser at load time. There is no config hierarchy (no defaults → env → file → flags). Hardcoded values take precedence everywhere.
- **Per-user isolation via rules, not config**: Multi-tenancy is enforced purely through Firestore rules checking `request.auth.uid` against `resource.data.ownerId`; the app itself has no tenant-aware config.
- **Feature toggles are absent**: There are no feature-flag files, environment switches, or runtime toggle mechanisms. Behavior differences (e.g., dark mode) are stored in `localStorage` under `shadowLedger_theme`, not driven by config.
- **Sample data seeding**: When Firestore is empty, `app.js` seeds default locations (`Main Depot`, `Company Building`) and sample inventory items — this is the closest thing to "default configuration" and is hard-coded in the JS.
- **Deployment targets are fixed**: `firebase.json` points hosting at `public: "."` and ignores `test.csv`/`README.md`; the project has no staging/prod split or deploy-time variable substitution.

**Rules developers should follow**
- Do not add new secrets (API keys, tokens) to `firebase-config.js` without understanding they will be shipped to every client. Prefer Firebase App Check or Cloud Functions if secrets must be hidden.
- If you need environment-specific settings (staging vs production), introduce a small bootstrap layer that loads a JSON config from a path resolved from an env var or query string, rather than editing `firebase-config.js` per deploy.
- Keep `firestore.rules` in sync with any schema changes in `app.js` (required fields like `sku`, `name`, `category`); rule violations surface as `permission-denied` errors to users.
- New UI features that depend on external CDNs must also be whitelisted in the CSP meta tag in `index.html`; otherwise the browser will block them.