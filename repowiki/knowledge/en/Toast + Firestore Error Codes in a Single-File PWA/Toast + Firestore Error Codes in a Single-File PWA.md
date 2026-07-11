---
kind: error_handling
name: Toast + Firestore Error Codes in a Single-File PWA
category: error_handling
scope:
    - '**'
source_files:
    - app.js
---

This repository is a single-file, zero-build PWA (app.js ~2700 lines) with no dedicated error-handling module. Errors are handled inline using three lightweight patterns:

1. Firestore client errors: The DAL layer wraps every Firestore call in .catch() and inspects err.code. Known codes (permission-denied, unavailable) map to user-facing toast messages; unknown codes fall back to Save failed: <message>. Real-time listeners pass an onError(err) callback that the caller also routes through toast(). Write failures re-throw so callers can observe them if needed.

2. Auth errors: Email/password sign-in uses a try/catch around signInWithEmailAndPassword with a lookup table mapping Firebase auth error codes (auth/user-not-found, auth/wrong-password, auth/invalid-email, auth/too-many-requests) to friendly strings displayed in a #login-error element. Google popup sign-in has its own code-to-message map and shows a toast before re-throwing.

3. User feedback helpers: Two small utilities centralize UI-side error presentation:
   - toast(message, type = 'info') creates a transient DOM node with class toast toast-${type} (info/success/error), auto-removes after 3s via opacity transition.
   - confirmDialog({ title, message, confirmText, cancelText, danger }) returns a Promise-based modal replacing native confirm(), used for destructive actions like delete.

Conventions observed:
- Network / permission errors surface as red toast(..., 'error'); success/info use 'success' / 'info'.
- Silent failures (e.g., transaction logging, service worker registration, localStorage quota) degrade gracefully with console.warn rather than blocking the UI.
- No custom error classes, sentinel values, or centralized error middleware exist; each failure site handles itself locally.
- No panic/recover equivalent — the app avoids throwing on non-fatal paths and only re-throws when the caller explicitly needs to know.