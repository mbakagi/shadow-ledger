---
kind: external_dependency
name: Firebase (Auth + Firestore) — backend for St3s Inventory
slug: firebase
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### Identity
Google Firebase project `ledger-d57da` (`authDomain: ledger-d57da.firebaseapp.com`) provides both Authentication and Firestore as the live backend; `firebase.json` also declares hosting and points `firestore.rules`.

### Role in this repo
- **Firestore**: three collections are used — `inventory` (items), `locations` (warehouse/depot entries), `transactions` (scan-out audit log). All reads/writes go through the DAL in `app.js` which opens real-time `onSnapshot` listeners.

### Integration shape
- SDK loaded from `gstatic.com` compat bundles (v9.23.0); config object lives in `firebase-config.js` and exposes globals `db`, `auth` consumed by `app.js`.
- Security rules in `firestore.rules` enforce `ownerId == request.auth.uid` on `inventory` and `userId == request.auth.uid` on `transactions`; catch-all denies everything else.
- Hosting rewrites all routes to `index.html`; `sw.js` is served with `no-cache` while other assets get 1h cache.

### Direction
To migrate off Firebase, replace the DAL methods (`startSync`, `saveOne`, `saveMany`, `deleteOne`, `deleteMany`, `logTransaction`, location CRUD) with an equivalent adapter; the rest of the app talks only to DAL.