---
kind: build_system
name: No Build System — Zero-Build Static PWA
category: build_system
scope:
    - '**'
source_files:
    - firebase.json
    - README.md
---

This repository contains a zero-build, single-page Progressive Web App with no build system. There are no Makefiles, Dockerfiles, CI pipelines, package manifests, or build scripts of any kind. The project is a flat collection of static files (HTML, CSS, JS) served directly from the filesystem.

Deployment is handled exclusively through Firebase Hosting via `firebase.json`, which configures SPA rewrites to `index.html`, sets cache headers for assets and the service worker (`sw.js`), applies security headers, and excludes non-asset files like `README.md` and `test.csv`. Firestore rules are declared in `firestore.rules` and referenced by the same config. Local development uses `npx serve . -l 3000` as documented in `README.md`.

There is no versioning strategy, no cross-compilation, no artifact packaging, and no automated testing or release pipeline present in this repository.