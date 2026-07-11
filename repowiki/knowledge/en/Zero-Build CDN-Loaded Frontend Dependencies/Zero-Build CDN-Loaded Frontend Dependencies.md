---
kind: dependency_management
name: Zero-Build CDN-Loaded Frontend Dependencies
category: dependency_management
scope:
    - '**'
source_files:
    - index.html
    - firebase-config.js
    - firebase.json
    - sw.js
    - manifest.json
---

This repository is a zero-build, single-file PWA that manages all third-party dependencies exclusively via `<script>` and `<link>` tags loaded from CDNs in `index.html`. There is no package manager (no `package.json`, `go.mod`, `yarn.lock`, or `Gemfile`), no vendoring directory, and no build step — the app runs directly from static files served by Firebase Hosting (`firebase.json`).

**External libraries and their sources** (all pinned to exact versions in `index.html`):
- Tailwind CSS v3 runtime: `https://cdn.tailwindcss.com`
- Firebase JS SDK v9.23.0 compat bundle: `firebase-app-compat.js`, `firebase-auth-compat.js`, `firebase-firestore-compat.js` from `gstatic.com`
- QR code generation: `qrcodejs@1.0.0` from `cdn.jsdelivr.net`
- QR decoding (camera scan-out): `jsqr@1.4.0` from `cdn.jsdelivr.net`
- Excel import/export: SheetJS `xlsx-0.20.3` from `cdn.sheetjs.com`
- Google Fonts (Inter): `fonts.googleapis.com` + `fonts.gstatic.com`

**Security posture** — a strict Content-Security-Policy meta tag in `index.html` whitelists only these specific origins for scripts, styles, fonts, images, and connect endpoints, including the three Firebase API domains plus `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`, and `www.googleapis.com`. Preconnect hints are declared for each external origin.

**Runtime configuration** — Firebase project credentials live in `firebase-config.js` (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId) and initialize the compat SDK; Firestore offline persistence is enabled with `synchronizeTabs: true`. The Service Worker (`sw.js`) and PWA manifest (`manifest.json`) are present but do not introduce additional dependency management.

**Consequences & conventions**:
- Dependency updates require manually editing the versioned URLs in `index.html`; there is no lockfile or automated update tooling.
- All dependencies are browser globals exposed at load time (e.g. `firebase`, `QRCode`, `jsQR`, `XLSX`); the application code references them directly rather than through module imports.
- Because nothing is bundled or cached locally beyond the browser cache, the app depends on network availability for first-load of every library, though Firestore's offline persistence mitigates data access after initial load.