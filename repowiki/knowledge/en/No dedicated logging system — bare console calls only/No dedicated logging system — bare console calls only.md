---
kind: logging_system
name: No dedicated logging system — bare console calls only
category: logging_system
scope:
    - '**'
source_files:
    - app.js
    - firebase-config.js
---

This repository does not implement a structured logging system. All diagnostic output is produced via the browser's native `console` API (`console.error`, `console.warn`) scattered throughout `app.js` and `firebase-config.js`. There is no logging framework, no log-level configuration, no centralized logger module, no log sinks (file, network, remote service), and no convention for log field structure or severity classification beyond the implicit meaning of `error` vs `warn`. The few calls are ad-hoc error/warning messages around Firestore sync failures, persistence setup, QR generation, and UI operations.