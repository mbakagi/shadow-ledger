# St3s Developer Instructions: instructions.md

A sequential checklist for developers modifying and enhancing the St3s Inventory Tracker codebase. All instructions assume familiarity with JavaScript ES6+, Firestore, and PWA development.

---

## 1. Local Development Setup Workflows

### 1.1 Prerequisites

```bash
# Node.js (LTS version recommended)
node --version  # >= 18.x

# Git
git --version

# Optional: serve for local testing
npm install -g serve
```

### 1.2 Repository Setup

```bash
# Clone the repository
git clone https://github.com/mbakagi/shadow-ledger.git
cd shadow-ledger

# Verify file structure
ls -la
# ├── index.html      # Main HTML shell
# ├── app.js          # Application logic
# ├── firebase-config.js  # Firebase initialization
# ├── sw.js           # Service worker
# ├── manifest.json   # PWA manifest
# └── README.md       # Quick start guide
```

### 1.3 Local Development Server

```bash
# Option 1: Using serve (recommended for PWA testing)
npx serve . -l 3000

# Option 2: Using Python's http.server
python -m http.server 3000

# Option 3: Using Node's built-in server
node -e "require('http').createServer((_,r)=>r.end()).listen(3000)"
```

### 1.4 Firebase Project Setup

```bash
# Install Firebase CLI
npm install -g firebase-tools

# Login to Firebase
firebase login

# Use existing project (or create new)
firebase projects:list
firebase use --add

# Configure Firestore rules
firebase firestore:rules
```

### 1.5 Browser Testing

```bash
# Open in browser
open http://localhost:3000

# Or test PWA installation
# Chrome DevTools → Application → Manifest → Install button

# Test offline behavior
# Chrome DevTools → Network → Offline
```

---

## 2. Implementing Client-Side Firebase Indexing, Offline Tracking, and Barcode Generation

### 2.1 Client-Side Firebase Indexing

Firestore indexes are defined in `firestore.indexes.json` and deployed via Firebase CLI:

**Create composite index** for inventory queries:

```json
{
  "indexes": [
    {
      "collection": "inventory",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "category", "mode": "ASCENDING" },
        { "fieldPath": "totalStock", "mode": "DESCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

Deploy indexes:

```bash
firebase deploy --only firestore:indexes
```

**Query patterns in app.js**:

```javascript
// Filter by category
results.filter(i => i.category === category);

// Sort by totalStock descending
results.sort((a, b) => b.totalStock - a.totalStock);

// For location-aware queries
results.filter(i => locStock(i, LOC_BUILDING) > threshold);
```

### 2.2 Offline Tracking Initialization

The PWA implements offline tracking via service worker and Firestore's built-in offline persistence:

**Service Worker Registration** (`app.js`):

```javascript
function registerSW() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('Service worker registration failed:', err);
    });
  }
}
```

**Firestore Offline Persistence**:

```javascript
// firebase-config.js
firebase.firestore().enablePersistence()
  .catch(err => {
    if (err.code === 'failed-precondition') {
      console.warn('Multiple tabs open, persistence can only be enabled in one tab');
    } else if (err.code === 'unimplemented') {
      console.warn('Browser doesn\'t support persistence');
    }
  });
```

**Offline Indicator UI**:

```javascript
// Network status detection
window.addEventListener('online', () => {
  document.body.classList.remove('offline');
  toast('Connection restored', 'success');
});

window.addEventListener('offline', () => {
  document.body.classList.add('offline');
  toast('Working offline', 'info');
});
```

### 2.3 Barcode String Generation Logic

The barcode/QR generation uses `qrcodejs` for QR codes and inline SVG for barcodes. Both are generated client-side:

**QR Code Generation** (`buildLabelElement` function):

```javascript
function buildLabelElement(item, options) {
  const { sku, name, extra, qrSource, qrCustom } = options;
  
  let qrSvg = '';
  if (qrSource === 'sku') {
    // Generate QR for SKU
    const qr = new QRCode(document.createElement('div'));
    qr.addCode(sku);
    qr.make();
    qrSvg = qr.createSvgMarkup();
  } else if (qrSource === 'custom' && qrCustom) {
    // Generate QR for custom URL
    const qr = new QRCode(document.createElement('div'));
    qr.addCode(qrCustom);
    qr.make();
    qrSvg = qr.createSvgMarkup();
  }
  
  return `
    <div class="shelf-label">
      <div class="shelf-label-top">
        <div class="shelf-label-sku">${sku}</div>
        <div class="shelf-label-sku-qr">${qrSvg}</div>
      </div>
      <div class="shelf-label-info">
        <div class="shelf-label-name">${name}</div>
        <div class="shelf-label-footer">
          <span class="shelf-label-bin">${item.binCode || ''}</span>
          <span class="shelf-label-info">${item.totalStock}</span>
        </div>
      </div>
    </div>
  `;
}
```

**Barcode Generation** (inline SVG):

```javascript
function generateBarcode(sku) {
  // Convert SKU to Code 128 barcode string
  // Simplified implementation - for production, use proper barcode library
  
  const code128 = {
    start: '&#120;',
    stop: '&#121;',
    charset: {
      '0': '&#122;', '1': '&#123;', '2': '&#124;',
      // ... complete mapping for Code 128
    }
  };
  
  let barcode = code128.start;
  for (const char of sku) {
    barcode += code128.charset[char] || '';
  }
  barcode += code128.stop;
  
  return `<svg class="barcode" viewBox="0 0 200 50">${barcode}</svg>`;
}
```

---

## 3. High-Security Firestore Rules Blueprints

### 3.1 Base Security Rules

Create `firestore.rules` file:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    // Allow read/write to inventory collection for authenticated users
    match /inventory/{docId} {
      allow read, write: if request.auth != null;
      
      // Validate required fields on create
      allow create: if request.auth != null
        && request.resource.data.sku is string
        && request.resource.data.sku.size() > 0
        && request.resource.data.name is string
        && request.resource.data.name.size() > 0
        && request.resource.data.totalStock is int
        && request.resource.data.totalStock >= 0
        && request.resource.data.buildingStock is int
        && request.resource.data.buildingStock >= 0
        && request.resource.data.locationStock is map;
      
      // Validate field updates
      allow update: if request.auth != null
        && request.resource.data.keys().hasAll([
          'sku', 'name', 'category', 'binCode', 'datasheetUrl',
          'totalStock', 'buildingStock', 'carrierTrigger',
          'maxCapacity', 'purchasingTrigger', 'locationStock',
          'archived', 'updatedAt'
        ]);
    }
    
    // Allow read/write to locations for authenticated users
    match /locations/{locationId} {
      allow read, write: if request.auth != null;
      
      allow create: if request.auth != null
        && request.resource.data.name is string
        && request.resource.data.name.size() > 0
        && request.resource.data.order is int;
    }
    
    // Allow read/write to transactions for authenticated users
    match /transactions/{transactionId} {
      allow read, write: if request.auth != null;
      
      allow create: if request.auth != null
        && request.resource.data.sku is string
        && request.resource.data.name is string
        && request.resource.data.qtyOut is int
        && request.resource.data.qtyOut > 0
        && request.resource.data.type is string
        && request.resource.data.type in ['scan-out', 'transfer'];
    }
  }
}
```

### 3.2 Deploy Security Rules

```bash
# Test rules locally
firebase emulators:start --only firestore

# Deploy rules to production
firebase deploy --only firestore:rules

# Verify rules are applied
firebase firestore:rules:get
```

### 3.3 Production Security Considerations

1. **Domain Authorization**: Add `malibs.com` to Firebase Console → Auth → Settings → Authorized domains

2. **App Check** (recommended for production):

```bash
# Enable App Check in Firebase Console
# Add reCAPTCHA v3 for web apps
firebase appcheck:debug-token
```

3. **Database Rules for Public Static Host**:

Since GitHub Pages hosts the app statically, security relies entirely on Firebase Auth and Firestore rules:

```javascript
// Enhanced rules with rate limiting
match /inventory/{docId} {
  allow read, write: if request.auth != null
    && request.time < timestamp.date(2026, 1, 1);  // Prevent writes after date
}
```

4. **CORS Configuration**:

GitHub Pages automatically serves with appropriate CORS headers. No additional configuration needed.

### 3.4 Testing Security Rules

```bash
# Run the Firebase emulator suite
firebase emulators:start

# Test with authenticated requests
cd functions
npm run test:rules
```

---

## 4. Testing and Verification Checklist

### 4.1 Pre-Deployment Checklist

- [ ] All bracket types balanced (braces, parentheses, brackets)
- [ ] Firestore rules deployed and verified
- [ ] Service worker cache version updated (`CACHE_VERSION = 'sl-vX'`)
- [ ] PWA manifest icons updated for new version
- [ ] Firebase config domain authorized in console

### 4.2 Post-Deployment Verification

```bash
# Verify git status is clean
git status

# Verify latest commit
git log -1

# Verify push completed
git log --oneline -5
```

### 4.3 Browser Verification Steps

1. Open `https://[your-domain].github.io/`
2. Verify PWA installs correctly
3. Test offline mode (service worker cache)
4. Test Firestore connection (real-time updates)
5. Verify barcode/QR generation on labels
6. Test scan-out workflow with camera

---

## 5. Common Development Patterns

### 5.1 State Management Pattern

```javascript
const State = {
  items: [],
  filteredItems: [],
  currentPage: 1,
  sortField: 'sku',
  sortAsc: true,
  editingId: null,
  selectedIds: new Set(),
  viewMode: 'active',  // 'active' | 'archive'
  locations: [],
  activeLocation: 'all',
  labelGenSelected: new Set()
};
```

### 5.2 Render Update Pattern

```javascript
function applyFilters() {
  // 1. Filter items
  let results = State.items.filter(i => !i.archived);
  
  // 2. Apply search query
  if (query) {
    results = results.filter(i => 
      i.sku.includes(query) || i.name.includes(query)
    );
  }
  
  // 3. Apply category filter
  if (category) {
    results = results.filter(i => i.category === category);
  }
  
  // 4. Sort results
  results.sort(sortComparator);
  
  // 5. Update state and render
  State.filteredItems = results;
  State.currentPage = 1;
  renderTable();
}
```

### 5.3 Firestore Write Pattern

```javascript
async function saveItem(item) {
  // 1. Validate input
  if (!item.sku) throw new Error('SKU is required');
  
  // 2. Prepare data
  const data = {
    ...item,
    ownerId: auth.currentUser?.uid || null,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  
  // 3. Write to Firestore
  if (State.editingId) {
    await db.collection('inventory').doc(State.editingId).set(data, { merge: true });
  } else {
    await db.collection('inventory').doc(DAL.generateId()).set(data);
  }
  
  // 4. Update local state
  State.editingId = null;
  applyFilters();
}
```

## 6. Recent Architectural Learnings & Constraints

### 6.1 Chaotic Storage & Document Aggregation
- The system now uses a flat NoSQL structure where multiple documents can share the same SKU to represent different physical bins.
- `app.js` handles all client-side aggregation. When querying the `inventory` collection, `startSync` groups by SKU and dynamically recalculates total stock.
- NEVER attempt to nest maps or objects within the location data. Always emit flat documents with explicit `room`, `aisle`, `bay`, and `bin` fields.

### 6.2 Firebase SDK Version Matching
- Always ensure that all entry points (`index.html`, `mobile.html`, etc.) are running identical major/minor versions of the Firebase SDK.
- Mismatched SDK versions (e.g., v9 vs v10) across different tabs sharing the same origin will invalidate the IndexedDB Auth token and cause an infinite login/logout loop.

### 6.3 Firestore Data Types Strictness
- Cloud Firestore strictly rejects `undefined` values.
- When parsing legacy documents that lack modern explicit fields, ALWAYS provide a fallback (`|| null` or `|| ''`) before attempting to `set()` or `update()` a document. Failure to do so will instantly crash the transaction.

### 6.4 Guest Checkout PIN — Seeding & Rotation (REP-003 §3.4)

Guest checkout (`guest-out.html` / `guest-move.html`) no longer compares input against a hardcoded string. The master PIN is now stored as a **PBKDF2-SHA256 hash** in `orgSecrets/default`, and guest pages verify by re-deriving the hash via the Web Crypto API.

**Firestore document** — `/orgSecrets/default`:
```json
{
  "guestCheckoutHash": "<64-char hex>",
  "salt":              "<64-char hex>",
  "iterations":        150000,
  "algo":              "PBKDF2-SHA256",
  "updatedBy":         "<admin UID>",
  "updatedAt":         "<server timestamp>"
}
```

> **Prerequisite:** `orgSecrets` is rule-locked (`allow read: if request.auth != null; allow write: if false;`). It must be seeded once before guest checkout works. The browser cannot write it.

**Recommended path — Migration Wizard:**
1. Open `https://<your-domain>/migration-wizard.html` and sign in with an admin account.
2. Tab **4 · Guest PIN** → enter the new PIN + confirm → **Generate Hash**.
3. Copy the produced Firebase CLI command (or the JSON) and run it in your terminal (or paste into the Firebase Console → Firestore → `orgSecrets` → `default`).
4. Open any guest checkout link and confirm the PIN is accepted.

**Fallback path — browser console snippet** (paste in a Firebase-authenticated tab):
```javascript
(async () => {
  const pin = prompt('New guest master PIN?');             if (!pin) return;
  const iterations = 150000;
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const key  = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), { name:'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', salt, iterations, hash:'SHA-256' }, key, 256);
  const hash = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2,'0')).join('');
  const saltHex = [...salt].map(b => b.toString(16).padStart(2,'0')).join('');
  console.log({ guestCheckoutHash: hash, salt: saltHex, iterations, algo:'PBKDF2-SHA256' });
  // Then seed /orgSecrets/default with these values via the Firebase Console or CLI:
  //   firebase firestore:documents:set orgSecrets/default --project ledger-d57da --data '{...}'
})();
```

**Rotation:** re-run either path with a new PIN; `orgSecrets/default` is overwritten. The guest pages pick up the new hash on their next verify (no code deploy needed).

### 6.5 Warehouse Backend Seeding (REP-003 §5 / Phase 0 & 4)

Run these admin tools in **`migration-wizard.html`** after signing in:

1. **Warehouse Template** (Tab 1):
   - Copy the provided Firebase CLI command and run it once to seed the immutable `warehouseTemplates/template-standard-v1` blueprint (rule-locked, write:false).
   - Click **Initialize Instance** to create `warehouseInstances/default` (`binsOccupied:{}`, `binsFree:192`, `totalBins:192`) — this document IS client-writable.
2. **Location Hierarchy** (Tab 2): generate `locations` documents (schema `{id,name,order,description}`) from the template and commit in batches. Choose rooms and levels to subset.
3. **Inventory Backfill** (Tab 3): scans every `inventory` document with a spec-format `binCode` (`ROOM-AISLE-BAY:02-BIN:02-LEVEL-STOCK`) and writes the indexed derived fields `warehouseRoom / warehouseAisle / warehouseBay / warehouseBin / warehouseLevel`. Idempotent — already-correct documents are skipped.