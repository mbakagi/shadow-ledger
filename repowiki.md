# St3s Technical Knowledge Base: repowiki.md

A comprehensive technical reference for the St3s Inventory Tracker, a client-side PWA running on GitHub Pages with Firebase Cloud Firestore as the backend.

---

## 1. Architecture Overview

### 1.1 Client-Side Execution Path on GitHub Pages

The application is a **static Single-Page Application (SPA)** with zero server-side infrastructure. Execution flows as follows:

```
User Request → GitHub Pages CDN (HTTPS) → index.html → app.js → Firebase SDKs → Firestore
```

**Execution Sequence:**

1. **Initial Load**: GitHub Pages serves `index.html` via CDN
2. **Bootstrap**: `<script src="firebase-config.js"></script>` loads Firebase initialization
3. **App Entry**: `app.js` DOMContentLoaded handler triggers `init()`
4. **Authentication**: Firebase Auth establishes user session
5. **Data Sync**: `DAL.startSync()` opens real-time listener on `inventory` collection
6. **State Update**: Firestore snapshot → `onUpdate(items)` → State.items populated
7. **UI Render**: `applyFilters()` → `renderTable()` → DOM populated

**Key Files:**

| File | Purpose |
|------|---------|
| `index.html` | Shell, layout, modals, Tailwind CSS via CDN, Firebase SDKs |
| `app.js` | State management, event bindings, rendering, Firestore operations |
| `manifest.json` | PWA metadata, icons, shortcuts |
| `firebase-config.js` | Firebase app initialization, Auth + Firestore instances |
| `sw.js` | Service worker for offline caching, app shell |

### 1.2 Offline Persistence Layers

**Service Worker (`sw.js`)**:

The PWA implements a multi-tier caching strategy:

```javascript
const CACHE_VERSION = 'sl-v4';
const CACHE_NAME = 'st3s-' + CACHE_VERSION;

const APP_SHELL_URLS = [
  '/', '/index.html', '/app.js', '/firebase-config.js',
  '/manifest.json', '/sw.js',
  'https://cdn.jsdelivr.net/npm/tailwindcss@3...',
  'https://www.gstatic.com/firebasejs/...'
];
```

**IndexedDB Integration**:

Implemented in `app.js` via `Storage` abstraction:

```javascript
const Storage = {
  open() { /* returns DB handle */ },
  saveSnapshot(items) { /* writes to inventory store */ },
  loadSnapshot() { /* reads from inventory store */ }
};
```

### 1.3 Module Boundaries (Post-Overhaul)

| Module | Auth Model | Persistence | Entry Point |
|---|---|---|---|
| Main Inventory (`index.html`) | Email / Google | Firestore + IndexedDB | Primary SPA |
| 3D Warehouse Panel | Same session (unified auth) | Firestore `warehouseInstances` | Off-canvas in `index.html` |
| Guest Checkout (`guest-out.html`) | Anonymous | Firestore `orgSecrets` for PIN | Public standalone |

See **REP-003** specification: `.kilo/plans/REP-003-repo-wiki-overhaul-spec.md`

---

## 2. Complete Firestore Schema Matrix

### 2.1 Collection: `inventory`

**Document ID Pattern**: `sl_` + timestamp(base36) + `_` + random suffix

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sku` | string | Yes | Unique Stock Keeping Unit |
| `name` | string | Yes | Human-readable product name |
| `category` | string | No | Item category for filtering |
| `binCode` | string | No | Physical bin/shelf location (e.g., "A-A1-01-01-F-STOCK") |
| `datasheetUrl` | string | No | URL to product specification |
| `totalStock` | number | Yes | Sum across all locations (derived) |
| `buildingStock` | number | Yes | Stock at Company Building location |
| `depotStock` | number | Yes | Stock at Main Depot location |
| `locationStock` | map<string,number> | Yes | Per-location stock breakdown |
| `carrierTrigger` | number | Yes | Alert threshold for carrier transfer |
| `maxCapacity` | number | Yes | Maximum building storage capacity |
| `purchasingTrigger` | number | Yes | Alert threshold for procurement |
| `archived` | boolean | No | Soft-delete flag |
| `ownerId` | string | No | UID of owning user (null = shared) |
| `updatedAt` | timestamp | Auto | Server-side timestamp on write |
| `warehouseRoom` | string | No | Parsed room component of binCode (NEW) |
| `warehouseAisle` | string | No | Parsed aisle component (NEW) |
| `warehouseBay` | number | No | Parsed bay number (NEW) |
| `warehouseBin` | number | No | Parsed bin number (NEW) |
| `warehouseLevel` | string | No | Parsed level: F, 1, 2, 3 (NEW) |

### 2.2 Collection: `locations`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Location identifier |
| `name` | string | Yes | Display name |
| `order` | number | Yes | Sort order for UI display |
| `description` | string | No | Optional description |

### 2.3 Collection: `transactions`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `itemId` | string | Yes | Reference to inventory item ID |
| `sku` | string | Yes | Item SKU at time of transaction |
| `name` | string | Yes | Item name at time of transaction |
| `qtyOut` | number | Yes | Quantity removed |
| `type` | string | Yes | "scan-out", "transfer", or "adjust" |
| `from` | string | No | Source location (for transfers) |
| `to` | string | No | Destination location (for transfers) |
| `remainingMap` | map<string,number> | Yes | Post-transaction stock map |
| `user` | string | No | User email for audit trail |
| `userId` | string | No | User UID for audit trail |
| `timestamp` | timestamp | Auto | Server-side timestamp |

### 2.4 Collection: `warehouseTemplates` (NEW)

Static blueprint defining the physical warehouse structure. Read-only for users.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Template identifier |
| `version` | string | Semver |
| `name` | string | Display name |
| `rooms[]` | array | Room definitions with aisle/bay/bin/level specs |
| `spacing` | map | 3D spatial constants |
| `createdAt` | timestamp | Server timestamp |

**Constraint**: 2 rooms (A: 2 aisles, B: 1 aisle), each aisle = 4 bays × 4 levels, each bay = 4 bins.
**Total slots**: 192 per template instance.

### 2.5 Collection: `warehouseInstances` (NEW)

Runtime occupancy state for a warehouse template.

| Field | Type | Description |
|-------|------|-------------|
| `templateId` | string | FK to `warehouseTemplates` |
| `binsOccupied` | map | Key = binCode, value = `{itemId, sku, assignedAt}` |
| `binsFree` | number | Computed counter |
| `totalBins` | number | Denormalized from template |
| `updatedAt` | timestamp | Server timestamp |

### 2.6 Collection: `userPreferences` (NEW)

| Field | Type | Description |
|-------|------|-------------|
| `userId` | string | FK to auth user |
| `defaultView` | string | "table" or "3d" |
| `3dCameraPreset` | string | "iso", "top", "front" |
| `theme` | string | "dark" or "light" |
| `updatedAt` | timestamp | Server timestamp |

### 2.7 Collection: `orgSecrets` (NEW)

| Field | Type | Description |
|-------|------|-------------|
| `guestCheckoutHash` | string | PBKDF2 hash of master PIN |
| `updatedBy` | string | Admin UID |
| `updatedAt` | timestamp | Server timestamp |

---

## 3. 3D Warehouse Rendering (Post-Overhaul)

### 3.1 InstancedMesh Strategy

| Room | Mesh Count | Instances |
|---|---|---|
| Room A | 2 InstancedMesh (1 per aisle) | 128 |
| Room B | 1 InstancedMesh | 64 |
| **Total** | **3 meshes** | **192 instances** |

Per-frame draw calls: ~400 → **< 10**.

### 3.2 Coordinate System

| Parameter | Value |
|---|---|
| Room A origin | (0, 0, 0) |
| Room B offset | (+20, 0, 0) |
| Aisle gap | 4.0m |
| Bay depth | 2.0m |
| Bin width | 2.0m |
| Level height | 2.0m |
| Floor | y = 0.01 |

---

## 4. Cross-Reference

- **Primary Spec:** `.kilo/plans/REP-003-repo-wiki-overhaul-spec.md`
- **Template Blueprint:** `.kilo/plans/REP-003-A1-warehouse-template-blueprint.md`
- **Original Developer Instructions:** `instructions.md`