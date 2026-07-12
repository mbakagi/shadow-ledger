/* ═══════════════════════════════════════════════════════
   Shadow Ledger — Application Logic
   Clean state management ready for future DB migration
   ═══════════════════════════════════════════════════════ */

;(function () {
  'use strict';

  // ─── Constants ───
  const STORAGE_KEY = 'shadowLedger_inventory';
  const THEME_KEY   = 'shadowLedger_theme';
  const PAGE_SIZE   = 50;

  const State = {
    items: [],
    filteredItems: [],
    currentPage: 1,
    sortField: 'sku',
    sortAsc: true,
    editingId: null,
    importParsedData: [],
    importRawHeaders: [],
    importRawData: [],
    importFormat: 'csv',
    selectedIds: new Set(),
    viewMode: 'active',
    locations: [],            // [{ id, name, order }]
    activeLocation: 'all',    // 'all' | locationId
    labelGenSelected: new Set() // SKUs chosen for bulk label print
  };

  // ─── IndexedDB Offline Storage ───
  const IDB_NAME = 'st3s_db';
  const IDB_VERSION = 1;
  const IDB_STORE = 'inventory';
  const IDB_KEY = 'snapshot';

  const Storage = {
    _db: null,

    open() {
      return new Promise((resolve, reject) => {
        if (this._db) return resolve(this._db);
        if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
        req.onerror = (e) => reject(e.target.error);
      });
    },

    async save(items) {
      try {
        const db = await this.open();
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        store.clear();
        items.forEach(item => store.put({ id: IDB_KEY, data: item, ts: Date.now() }));
        return new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve(items.length);
          tx.onerror = () => reject(tx.error);
        });
      } catch (err) {
        console.warn('IDB save failed:', err);
        return 0;
      }
    },

    async load() {
      try {
        const db = await this.open();
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(IDB_KEY);
        return new Promise((resolve) => {
          req.onsuccess = () => resolve(req.result ? [req.result.data] : []);
          req.onerror = () => resolve([]);
        });
      } catch (err) {
        console.warn('IDB load failed:', err);
        return [];
      }
    },

    async saveSnapshot(items) {
      try {
        const db = await this.open();
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        store.clear();
        store.put({ id: IDB_KEY, items, ts: Date.now() });
        return new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve(items.length);
          tx.onerror = () => reject(tx.error);
        });
      } catch (err) {
        console.warn('IDB snapshot save failed:', err);
        return 0;
      }
    },

    async loadSnapshot() {
      try {
        const db = await this.open();
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(IDB_KEY);
        return new Promise((resolve) => {
          req.onsuccess = () => resolve(req.result ? req.result.items : []);
          req.onerror = () => resolve([]);
        });
      } catch (err) {
        console.warn('IDB snapshot load failed:', err);
        return [];
      }
    }
  };

  // ─── Data Access Layer (DAL) — Firestore backend ───
  const DAL = {
    _unsub: null,

    // Start real-time listener; calls onUpdate(items[]) whenever Firestore changes
    startSync(onUpdate, onError) {
      if (this._unsub) this._unsub();
      this._unsub = db.collection('inventory')
        .onSnapshot(snapshot => {
          const itemMap = new Map();

          snapshot.forEach(doc => {
            const d = doc.data();
            const sku = (d.sku || d.id || 'UNKNOWN').toUpperCase();
            
            if (!itemMap.has(sku)) {
              itemMap.set(sku, {
                id: sku,
                sku: sku,
                name: d.item_name || d.name || 'Unknown Item',
                category: d.category || '',
                totalStock: 0,
                buildingStock: 0,
                depotStock: 0,
                carrierTrigger: d.carrierTrigger || d.carrier_trigger || 0,
                maxCapacity: d.maxCap || d.maxCapacity || 0,
                purchasingTrigger: d.purchaseTrigger || d.purchasingTrigger || 0,
                locationStock: undefined,
                _explicitLocs: [] // temporary array for concatenated string
              });
            }
            const item = itemMap.get(sku);
            const qty = parseFloat(d.quantity || 0);
            
            if (d.room !== undefined || d.bin !== undefined) {
               // New explicit 4-field schema
               const locStr = `${d.room || '-'}-${d.aisle || '-'}-${d.bay || '-'}-${d.bin || '-'}`;
               if (!item.locationStock) item.locationStock = {};
               item.locationStock[locStr] = (item.locationStock[locStr] || 0) + qty;
               item.totalStock += qty;
               item.buildingStock += qty; // Assume explicit bins are in Building
               item._explicitLocs.push({ str: locStr, qty: qty });
            } else {
               // Legacy flat document schema
               item.totalStock = d.totalStock || 0;
               item.buildingStock = d.buildingStock || 0;
               item.depotStock = d.depotStock || 0;
               
               if (d.locationStock) {
                 item.locationStock = d.locationStock;
                 Object.keys(item.locationStock).forEach(k => {
                   if (k !== LOC_DEPOT && k !== LOC_BUILDING) {
                     item._explicitLocs.push({ str: k, qty: item.locationStock[k] });
                   }
                 });
               } else {
                 item.locationStock = undefined; // Important: triggers legacy totalStock fallback
               }
            }
          });

          const items = Array.from(itemMap.values());
          
          // Generate the concatenated 'Added to Bin' string
          items.forEach(item => {
             item.binCode = item._explicitLocs
               .sort((a,b) => b.qty - a.qty)
               .map(l => `${l.str} (Qty: ${l.qty})`)
               .join(' | ');
             delete item._explicitLocs;
          });

          Storage.saveSnapshot(items);
          onUpdate(items);
        }, err => {
          console.error('Firestore sync error:', err);
          if (onError) onError(err);
        });
    },

    stopSync() {
      if (this._unsub) { this._unsub(); this._unsub = null; }
    },

    // Atomic stock adjustment via Firestore runTransaction
    adjustStockAtomic(id, delta, locId) {
      const itemRef = db.collection('inventory').doc(id);
      const txRef = db.collection('transactions').doc();

      return db.runTransaction(async (tx) => {
        const doc = await tx.get(itemRef);
        if (!doc.exists) throw new Error('Item not found: ' + id);

        const data = doc.data();
        const ls = { ...(data.locationStock || {}) };
        
        let targetLocId = locId;
        if (locId === 'building') {
          const bins = Object.keys(ls).filter(k => k !== 'depot' && k !== 'building');
          targetLocId = bins.length > 0 ? bins[0] : (data.binCode || 'UNASSIGNED_BIN');
        }

        const currentVal = Number(ls[targetLocId]) || 0;
        const newVal = Math.max(0, currentVal + delta);
        const actualDelta = newVal - currentVal;
        
        ls[targetLocId] = newVal;
        delete ls['building']; // Cleanup legacy key

        let newTotal = 0;
        let newBuilding = 0;
        for (const [k, v] of Object.entries(ls)) {
          const qty = Number(v) || 0;
          newTotal += qty;
          if (k !== 'depot') newBuilding += qty;
        }

        const updatedData = {
          locationStock: ls,
          buildingStock: newBuilding,
          depotStock: Number(ls['depot']) || 0,
          totalStock: newTotal,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        tx.set(itemRef, updatedData, { merge: true });

        tx.set(txRef, {
          itemId: id,
          sku: data.sku || '',
          name: data.name || '',
          qtyOut: Math.abs(actualDelta),
          type: 'adjust',
          locationId: targetLocId,
          direction: actualDelta < 0 ? 'out' : 'in',
          remainingMap: ls,
          user: auth.currentUser?.email || 'unknown',
          userId: auth.currentUser?.uid || null,
          timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });

        return { locationStock: ls, buildingStock: newBuilding, totalStock: newTotal };
      });
    },

    // Write a single item; returns a Promise so callers can surface errors
    saveOne(item) {
      const { id, ...rest } = item;
      const data = { ...rest, ownerId: auth.currentUser?.uid || null, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      return db.collection('inventory').doc(id).set(data, { merge: true })
        .catch(err => {
          console.error('Firestore write error:', err);
          if (err.code === 'permission-denied') {
            toast('Firestore: permission denied. Check database rules.', 'error');
          } else if (err.code === 'unavailable') {
            toast('Firebase unavailable. Check your connection.', 'error');
          } else {
            toast('Save failed: ' + (err.message || err.code), 'error');
          }
          throw err;
        });
    },

    // Delete a single item
    deleteOne(id) {
      return db.collection('inventory').doc(id).delete()
        .catch(err => {
          if (err.code !== 'permission-denied') console.error('Firestore delete error:', err);
          throw err;
        });
    },

    // Batch-write many items
    saveMany(items) {
      const batch = db.batch();
      items.forEach(item => {
        const { id, ...rest } = item;
        const data = { ...rest, ownerId: auth.currentUser?.uid || null, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
        batch.set(db.collection('inventory').doc(id), data, { merge: true });
      });
      return batch.commit();
    },

    // Batch-delete by ID array
    deleteMany(ids) {
      const batch = db.batch();
      ids.forEach(id => batch.delete(db.collection('inventory').doc(id)));
      return batch.commit();
    },

    generateId() {
      return 'sl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    },

    // ─── Locations CRUD ───
    startLocationsSync(onUpdate, onError) {
      return db.collection('locations').orderBy('order', 'asc')
        .onSnapshot(snapshot => {
          const locs = [];
          snapshot.forEach(doc => locs.push({ id: doc.id, ...doc.data() }));
          onUpdate(locs);
        }, err => { console.error('Locations sync error:', err); if (onError) onError(err); });
    },

    saveLocation(loc) {
      const { id, ...data } = loc;
      if (id) return db.collection('locations').doc(id).set(data, { merge: true });
      return db.collection('locations').add({ ...data, order: Date.now() });
    },

    deleteLocation(id) {
      return db.collection('locations').doc(id).delete();
    },

    // Log a stock movement (transfer or scan-out)
    logTransaction(txData) {
      return db.collection('transactions').add({
        ...txData,
        user: auth.currentUser?.email || 'unknown',
        userId: auth.currentUser?.uid || null,
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      }).catch(e => console.warn('Transaction log failed', e));
    },

    // ─── WMS: Bin reservation (optimistic locking via Firestore transaction) ───
    // Atomically increments reservedStock for a specific item+location so two
    // pickers cannot grab the same stock simultaneously.
    // Returns the new reservedStock value.
    reserveStock(itemId, locationId, qty) {
      const itemRef = db.collection('inventory').doc(itemId);
      return db.runTransaction(async (tx) => {
        const doc = await tx.get(itemRef);
        if (!doc.exists) throw new Error('Item not found: ' + itemId);
        const data = doc.data();
        // Guard: only allow reservation from the item's current bin
        if (data.binCode !== locationId && locationId !== 'ANY') {
          throw new Error(`Item ${data.sku} is not in bin ${locationId}`);
        }
        const ls        = { ...(data.locationStock || {}) };
        const onHand    = ls['building'] || 0;
        const reserved  = data.reservedStock || 0;
        const available = onHand - reserved;
        if (available < qty) {
          throw new Error(`Insufficient available: need ${qty}, have ${available} (${reserved} already reserved)`);
        }
        tx.set(itemRef, {
          reservedStock: firebase.firestore.FieldValue.increment(qty),
          updatedAt:     firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return { newReserved: reserved + qty, available: available - qty };
      });
    },

    // ─── WMS: Release a reservation (on pick completion or timeout) ───
    releaseStock(itemId, qty, committed = false) {
      const itemRef = db.collection('inventory').doc(itemId);
      return db.runTransaction(async (tx) => {
        const doc = await tx.get(itemRef);
        if (!doc.exists) return;
        const data    = doc.data();
        const current = data.reservedStock || 0;
        const release = Math.min(qty, current); // never go negative
        const updates = {
          reservedStock: firebase.firestore.FieldValue.increment(-release),
          updatedAt:     firebase.firestore.FieldValue.serverTimestamp()
        };
        if (committed) {
          // Stock was actually picked — decrement on-hand building stock too
          const ls = { ...(data.locationStock || {}) };
          ls['building'] = Math.max(0, (ls['building'] || 0) - qty);
          ls['depot']    = Math.max(0, (ls['depot'] || 0));
          updates.locationStock = ls;
          updates.buildingStock = ls['building'];
          updates.totalStock    = Object.values(ls).reduce((s, v) => s + (Number(v) || 0), 0);
        }
        tx.set(itemRef, updates, { merge: true });
        return { released: release };
      });
    },

    // ─── WMS: Assign a bin (adds to locationStock) ───
    assignBin(itemId, binCode) {
      if (!binCode) return Promise.resolve();
      return db.collection('inventory').doc(itemId).set({
        // Merge true does a deep merge, so it will add this key to the map without overwriting others
        locationStock: { [binCode]: 0 },
        // Null out legacy single-bin fields to prevent ghost data
        binCode: firebase.firestore.FieldValue.delete(),
        warehouseRoom: firebase.firestore.FieldValue.delete(),
        warehouseAisle: firebase.firestore.FieldValue.delete(),
        warehouseBay: firebase.firestore.FieldValue.delete(),
        warehouseBin: firebase.firestore.FieldValue.delete(),
        warehouseLevel: firebase.firestore.FieldValue.delete(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    },

    clearBin(itemId, binCode) {
      if (!binCode) return Promise.resolve();
      return db.collection('inventory').doc(itemId).set({
        // Delete the specific bin from the map
        [`locationStock.${binCode}`]: firebase.firestore.FieldValue.delete(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    },

    // ─── WMS: Fragmentation report ───
    // Returns items sorted by bin count descending.
    // bin_count > 1 = fragmented (same SKU, multiple physical locations).
    // In the current single-bin-per-item model, fragmentation is detected
    // when the same SKU string appears in multiple inventory documents.
    getFragmentationReport() {
      const skuMap = {};
      State.items.forEach(item => {
        if (item.archived) return;
        const s = item.sku;
        if (!skuMap[s]) skuMap[s] = { sku: s, name: item.name, items: [] };
        skuMap[s].items.push(item);
      });
      return Object.values(skuMap)
        .filter(g => g.items.length > 1 || !g.items[0]?.binCode)
        .map(g => ({
          sku:         g.sku,
          name:        g.name,
          binCount:    g.items.filter(i => getItemBins(i).length > 0).length,
          unassigned:  g.items.filter(i => getItemBins(i).length === 0).length,
          totalQty:    g.items.reduce((s, i) => s + (i.totalStock || 0), 0),
          bins:        g.items.flatMap(i => getItemBins(i))
        }))
        .sort((a, b) => b.binCount - a.binCount || b.unassigned - a.unassigned);
    }
  };


  // ─── DOM Refs ───
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    body:             document.documentElement,
    tableBody:        $('#table-body'),
    emptyState:       $('#empty-state'),
    searchInput:      $('#input-search'),
    categorySelect:   $('#select-category'),
    alertSelect:      $('#select-alert'),
    statTotalItems:   $('#stat-total-items'),
    statCategories:   $('#stat-categories'),
    statTotalUnits:   $('#stat-total-units'),
    statCarrierCount: $('#stat-carrier-count'),
    statProcureCount: $('#stat-procure-count'),
    carrierQuicklist: $('#carrier-quicklist'),
    procureQuicklist: $('#procure-quicklist'),
    carrierPulse:     $('#carrier-pulse'),
    procurePulse:     $('#procure-pulse'),
    tableCount:       $('#table-count'),
    pageIndicator:    $('#page-indicator'),
    btnPrev:          $('#btn-prev-page'),
    btnNext:          $('#btn-next-page'),
    
    // Filters & Actions
    filterStock:      $('#filter-stock'),
    btnToggleArchive: $('#btn-toggle-archive'),
    bulkActionsBar:   $('#bulk-actions-bar'),
    bulkCount:        $('#bulk-count'),
    btnBulkArchive:   $('#btn-bulk-archive'),
    btnBulkRestore:   $('#btn-bulk-restore'),
    btnBulkDelete:    $('#btn-bulk-delete'),
    checkAll:         $('#check-all'),
    
    // Print Container
    printContainer:   $('#print-container'),
    btnBulkPrint:     $('#btn-bulk-print'),
    modalItem:        $('#modal-item'),
    modalImport:      $('#modal-import'),
    modalManifest:    $('#modal-manifest'),
    modalAlerts:    $('#modal-alerts'),
    modalSkuSearch: $('#modal-sku-search'),
    formSkuSearch:  $('#form-sku-search'),
    inputSkuSearch: $('#input-sku-search'),
    skuDatalist:    $('#sku-datalist'),
    assignTargetBin:$('#assign-target-bin'),
    formItem:         $('#form-item'),
    manifestContent:  $('#manifest-content'),
    importPreview:    $('#import-preview'),
    importPreviewCount: $('#import-preview-count'),
    importPreviewBody:  $('#import-preview-body'),
    importDropZone:   $('#import-drop-zone'),
    importDropText:   $('#import-drop-text'),
    importFileInput:  $('#import-file-input'),
    importMapping:    $('#import-mapping'),
    btnImportMappingConfirm: $('#btn-import-mapping-confirm'),
    btnImportMappingCancel:  $('#btn-import-mapping-cancel'),
    btnImportConfirm: $('#btn-import-confirm'),
    modalAlertsTitle: $('#modal-alerts-title'),
    modalAlertsList:  $('#modal-alerts-list'),
    // User-info elements
    loginOverlay:     document.getElementById('login-overlay'),
    userInfo:         document.getElementById('user-info'),
    currentUserEmail: document.getElementById('current-user-email'),
    btnLogout:        document.getElementById('btn-logout'),
    // Bin / Pareto modals
    modalBins:        $('#modal-bins'),
    modalPareto:      $('#modal-pareto'),
  };

  // ═══════════════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════════════
  function init() {
    loadTheme();
    bindEvents();

    // ─── Firebase Auth state ───
    auth.onAuthStateChanged(user => {
      if (user) {
        // Logged in — hide overlay, show user info
        dom.loginOverlay.classList.add('hidden');
        dom.userInfo.classList.remove('hidden');
        dom.userInfo.classList.add('flex');
        dom.currentUserEmail.textContent = user.email;

        // Start inventory Firestore real-time sync
        DAL.startSync(
          // Success callback
          items => {
            const active = document.activeElement;
            // Auto-migrate old items: ensure locationStock map exists
            State.items = items.map(migrateItemLocations);
            if (active && active.classList && active.classList.contains('inline-input')) {
              renderDashboard();
            } else {
              applyFilters();
              renderDashboard();
              populateCategoryFilter();
            }
          },
          // Error callback — show visible message
          err => {
            console.error('Firestore error:', err);
            if (err.code === 'permission-denied') {
              toast('⚠ Database rules blocking access. Check Firebase Console → Firestore → Rules.', 'error');
            } else if (err.code === 'unavailable') {
              toast('⚠ Firebase unavailable. Check your internet connection.', 'error');
            } else {
              toast('⚠ Firebase error: ' + err.message, 'error');
            }
          }
        );

        // Start locations sync (and seed defaults on first run)
        DAL.startLocationsSync(locs => {
          State.locations = locs;
          if (locs.length === 0) seedDefaultLocations();
          populateLocationFilters();
        });

        // Load sample data on first ever use (empty Firestore)
        setTimeout(() => {
          if (State.items.length === 0) loadSampleDataToFirestore();
        }, 2000);

      } else {
        // Logged out — show overlay, stop sync
        DAL.stopSync();
        dom.loginOverlay.classList.remove('hidden');
        dom.userInfo.classList.add('hidden');
        dom.userInfo.classList.remove('flex');
        State.items = [];
        State.locations = [];
        State.selectedIds.clear();
        applyFilters();
        renderDashboard();
      }
    });

    // ─── Login form ───
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email    = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      const errEl    = document.getElementById('login-error');
      const btn      = document.getElementById('login-btn');

      errEl.style.display = 'none';
      btn.textContent = 'Signing in…';
      btn.disabled = true;

      try {
        await auth.signInWithEmailAndPassword(email, password);
      } catch (err) {
        const msgs = {
          'auth/user-not-found':  'No account found with this email.',
          'auth/wrong-password':  'Incorrect password.',
          'auth/invalid-email':   'Please enter a valid email address.',
          'auth/too-many-requests': 'Too many failed attempts. Try again later.',
        };
        errEl.textContent = msgs[err.code] || err.message;
        errEl.style.display = 'block';
      } finally {
        btn.textContent = 'Sign In to St3s';
        btn.disabled = false;
      }
    });

    // Google sign-in
    const googleBtn = document.getElementById('btn-google-signin');
    if (googleBtn) {
      googleBtn.addEventListener('click', async () => {
        googleBtn.disabled = true;
        try { await signInWithGoogle(); }
        catch (_) { /* toast already shown */ }
        finally { googleBtn.disabled = false; }
      });
    }

    // ─── Offline indicator ───
    const offlineEl = document.getElementById('offline-indicator');
    const updateOnlineStatus = () => {
      if (!offlineEl) return;
      offlineEl.classList.toggle('hidden', navigator.onLine);
    };
    window.addEventListener('online',  updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    updateOnlineStatus();
  }

  // ─── Sample data loader (Firestore version — only runs once on empty DB) ───
  let samplesLoaded = false;
  function loadSampleDataToFirestore() {
    if (samplesLoaded) return;
    samplesLoaded = true;
    const samples = [
      { sku: 'FB-M8-50',    name: 'M8x50 Hex Bolt',         category: 'Détection Incendie - Conventionnel - Centrales', datasheetUrl: '', totalStock: 500,  buildingStock: 12,  carrierTrigger: 20,  maxCapacity: 100, purchasingTrigger: 80 },
      { sku: 'FB-M10-30',   name: 'M10x30 Flange Bolt',     category: 'Détection Incendie - Conventionnel - Détecteurs', datasheetUrl: '', totalStock: 320,  buildingStock: 45,  carrierTrigger: 30,  maxCapacity: 80,  purchasingTrigger: 60 },
      { sku: 'EL-CB-2.5',   name: '2.5mm² Cable (100m)',    category: 'Détection Incendie - Adressable - Centrales',    datasheetUrl: '', totalStock: 45,   buildingStock: 3,   carrierTrigger: 5,   maxCapacity: 15,  purchasingTrigger: 10 },
      { sku: 'EL-CB-4.0',   name: '4.0mm² Cable (100m)',    category: 'Réseau - Switch',             datasheetUrl: '', totalStock: 8,    buildingStock: 2,   carrierTrigger: 3,   maxCapacity: 10,  purchasingTrigger: 12 },
      { sku: 'PL-PVC-25',   name: '25mm PVC Conduit (3m)',  category: 'Alarme - Filaire - Centrale', datasheetUrl: '', totalStock: 200,  buildingStock: 35,  carrierTrigger: 15,  maxCapacity: 50,  purchasingTrigger: 40 },
      { sku: 'SF-GG-CLR',   name: 'Clear Safety Goggles',   category: 'Vidéosurveillance',            datasheetUrl: '', totalStock: 60,   buildingStock: 4,   carrierTrigger: 8,   maxCapacity: 25,  purchasingTrigger: 15 },
      { sku: 'GN-TAPE-BK',  name: 'Black Electrical Tape',  category: 'Alimentations',                datasheetUrl: '',   totalStock: 300,  buildingStock: 50,  carrierTrigger: 20,  maxCapacity: 80,  purchasingTrigger: 50 },
    ];
    const items = samples.map(s => ({ id: DAL.generateId(), ...s }));
    DAL.saveMany(items).then(() => toast('Sample data loaded', 'success'));
  }

  // ═══════════════════════════════════════════════════════
  //  LOCATION HELPERS + MIGRATION + SEEDING
  // ═══════════════════════════════════════════════════════

  const LOC_DEPOT    = 'depot';     // fixed id for "Main Depot"
  const LOC_BUILDING  = 'building'; // fixed id for "Company Building"

  // ─── Guest Checkout URL builder ───
  // QR codes must encode a URL that any phone camera can open natively.
  // Uses the live GitHub Pages deployment as the canonical base.
  // IMPORTANT: must match the actual GitHub Pages subdirectory path.
  const GUEST_BASE_URL = 'https://mbakagi.github.io/shadow-ledger';

  function guestUrl(itemId, loc) {
    // loc is the binCode (e.g. 'A-A1-01-01-F-STOCK').
    // If the item has no binCode yet we still encode the item ID — the guest
    // page will load the item and skip the location-mismatch check.
    const safeLoc = (loc && loc.trim()) ? loc.trim() : 'ANY';
    return `${GUEST_BASE_URL}/guest-out.html?id=${encodeURIComponent(itemId)}&loc=${encodeURIComponent(safeLoc)}`;
  }

  // Convert legacy items (only totalStock + buildingStock) to per-location map
  function migrateItemLocations(item) {
    if (item.locationStock && typeof item.locationStock === 'object') {
      // Already migrated; derive totals for backward compat
      return { ...item, buildingStock: locStock(item, LOC_BUILDING), totalStock: totalStockFromLocs(item) };
    }
    // Legacy: buildingStock was on-site, depot = totalStock - buildingStock
    const building = item.buildingStock || 0;
    const depot    = Math.max(0, (item.totalStock || 0) - building);
    return {
      ...item,
      locationStock: { [LOC_DEPOT]: depot, [LOC_BUILDING]: building }
    };
  }

  // Get stock at a specific location for an item (0 if missing)
  function locStock(item, locId) {
    if (!item.locationStock) {
      if (locId === LOC_BUILDING) return item.buildingStock || 0;
      if (locId === LOC_DEPOT) return item.depotStock || 0;
      return 0;
    }
    if (locId === LOC_BUILDING) {
      // Building stock is the sum of all keys except depot
      let sum = 0;
      for (const [key, qty] of Object.entries(item.locationStock)) {
        if (key !== LOC_DEPOT) {
          sum += Math.max(0, Number(qty) || 0);
        }
      }
      return sum;
    }
    return Math.max(0, Number(item.locationStock[locId]) || 0);
  }

  // Sum stock across all locations
  function totalStockFromLocs(item) {
    if (!item.locationStock) return item.totalStock || 0;
    let sum = 0;
    for (const [key, qty] of Object.entries(item.locationStock)) {
      sum += Math.max(0, Number(qty) || 0);
    }
    return sum;
  }

  // Get the friendly name of a location by id
  function getLocName(locId) {
    const loc = State.locations.find(l => l.id === locId);
    return loc ? loc.name : locId;
  }

  // Seed the 2 default locations on first run
  function seedDefaultLocations() {
    DAL.saveLocation({ id: LOC_DEPOT,    name: 'Main Depot',      order: 1 });
    DAL.saveLocation({ id: LOC_BUILDING, name: 'Company Building', order: 2 });
  }

  // ─── Amazon-style chaotic storage helpers ───
  function normalizeRoom(roomPart) {
    if (!roomPart) return 99;
    const m = String(roomPart).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 99;
  }

  function normalizeAisle(aislePart) {
    if (!aislePart) return 99;
    const m = String(aislePart).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : (String(aislePart).charCodeAt(0) || 99);
  }

  function levelValue(levelPart) {
    if (!levelPart) return 3;
    if (String(levelPart).toUpperCase() === 'F') return 1;
    const n = parseInt(levelPart, 10);
    if (!isNaN(n)) return n + 1; // F=1, 1=2, 2=3, 3=4, 4=5
    return 3;
  }

  function parseBinSortKey(binCode) {
    if (!binCode) return [99, 99, 99, 99, 99, 99, ''];
    const parts = String(binCode).split('-');
    if (parts[0] === 'GENERAL') {
      // General zones always walk last
      return [9, 9, normalizeRoom(parts[1]), normalizeAisle(parts[2]), 0, 0, binCode];
    }
    // Structured: ROOM-AISLE-BAY-BIN-LEVEL-ACTION
    return [
      normalizeRoom(parts[0]),
      normalizeAisle(parts[1]),
      parseInt(parts[2], 10) || 0,
      parseInt(parts[3], 10) || 0,
      levelValue(parts[4]),
      0,
      binCode
    ];
  }

  function sortByPickPath(items) {
    return [...items].sort((a, b) => {
      const ka = parseBinSortKey(a.binCode);
      const kb = parseBinSortKey(b.binCode);
      for (let i = 0; i < 6; i++) {
        if (ka[i] !== kb[i]) return ka[i] - kb[i];
      }
      return (a.sku || '').localeCompare(b.sku || '');
    });
  }

  function isHighVelocity(item) {
    // Proxy: items actively consumed or with high total volume
    return locStock(item, LOC_BUILDING) > (item.carrierTrigger || 0) ||
           totalStockFromLocs(item) > (item.purchasingTrigger || 0);
  }

  function isGoldenZone(binCode) {
    if (!binCode) return true;
    const parts = String(binCode).split('-');
    const lvl = parts[0] === 'GENERAL' ? 3 : levelValue(parts[4]);
    return lvl >= 2 && lvl <= 4;
  }

  function needsGoldenZoneWarning(item) {
    return isHighVelocity(item) && !isGoldenZone(item.binCode);
  }

  // Populate location filter + transfer dropdowns
  function populateLocationFilters() {
    const locs = State.locations;
    // Build options once
    const opts = '<option value="all">All Locations</option>' +
      locs.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');

    // Insert a location filter dropdown next to category filter (only if not present)
    let filter = $('#filter-location');
    if (!filter) {
      const cat = dom.categorySelect;
      filter = document.createElement('select');
      filter.id = 'filter-location';
      filter.className = 'input-field w-full sm:w-44';
      cat.parentNode.insertBefore(filter, cat.nextSibling);
      filter.addEventListener('change', applyFilters);
    }
    const cur = filter.value;
    filter.innerHTML = opts;
    if (cur && (cur === 'all' || locs.some(l => l.id === cur))) filter.value = cur;
  }

  // ═══════════════════════════════════════════════════════
  //  THEME
  // ═══════════════════════════════════════════════════════
  function loadTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light') dom.body.classList.remove('dark');
    else dom.body.classList.add('dark');
  }

  function toggleTheme() {
    dom.body.classList.toggle('dark');
    localStorage.setItem(THEME_KEY, dom.body.classList.contains('dark') ? 'dark' : 'light');
  }

  // ═══════════════════════════════════════════════════════
  //  COMPUTED HELPERS
  // ═══════════════════════════════════════════════════════
  function depotStock(item) {
    return locStock(item, LOC_DEPOT);
  }

  function needsCarrier(item) {
    return locStock(item, LOC_BUILDING) <= item.carrierTrigger;
  }

  function needsProcurement(item) {
    return totalStockFromLocs(item) <= item.purchasingTrigger;
  }

  function carrierQty(item) {
    return Math.max(0, (item.maxCapacity || 0) - locStock(item, LOC_BUILDING));
  }

  function getCarrierAlerts() {
    return State.items.filter(i => !i.archived && needsCarrier(i));
  }

  function getProcureAlerts() {
    return State.items.filter(i => !i.archived && needsProcurement(i));
  }

  function getCategories() {
    return [...new Set(State.items.map(i => i.category).filter(Boolean))].sort();
  }

  // ═══════════════════════════════════════════════════════
  //  FILTERING & SORTING
  // ═══════════════════════════════════════════════════════
  function applyFilters() {
    const query    = dom.searchInput.value.trim().toLowerCase();
    const category = dom.categorySelect.value;
    const alert    = dom.alertSelect.value;
    const stock    = dom.filterStock ? dom.filterStock.value : 'all';

    let results = State.items.filter(i => (State.viewMode === 'archive') ? i.archived : !i.archived);

    if (query) {
      results = results.filter(i =>
        i.sku.toLowerCase().includes(query) ||
        i.name.toLowerCase().includes(query) ||
        (getItemBins(i).some(b => b.toLowerCase().includes(query))) ||
        (i.category && i.category.toLowerCase().includes(query)) ||
        (i.datasheetUrl && i.datasheetUrl.toLowerCase().includes(query))
      );
    }

    if (category) {
      results = results.filter(i => i.category === category);
    }

    if (alert === 'carrier') results = results.filter(needsCarrier);
    else if (alert === 'procure') results = results.filter(needsProcurement);
    else if (alert === 'ok') results = results.filter(i => !needsCarrier(i) && !needsProcurement(i));

    if (stock === 'in_stock') results = results.filter(i => totalStockFromLocs(i) > 0);
    else if (stock === 'in_building') results = results.filter(i => locStock(i, LOC_BUILDING) > 0);

    // Sort
    if (State.sortField === 'binCode') {
      results = sortByPickPath(results);
      if (!State.sortAsc) results.reverse();
    } else {
      results.sort((a, b) => {
        let av, bv;
        if (State.sortField === 'depotStock') { av = depotStock(a); bv = depotStock(b); }
        else if (State.sortField === 'totalStock') { av = totalStockFromLocs(a); bv = totalStockFromLocs(b); }
        else if (State.sortField === 'buildingStock') { av = locStock(a, LOC_BUILDING); bv = locStock(b, LOC_BUILDING); }
        else { av = a[State.sortField]; bv = b[State.sortField]; }
        if (typeof av === 'string') { av = av.toLowerCase(); bv = bv.toLowerCase(); }
        if (av < bv) return State.sortAsc ? -1 : 1;
        if (av > bv) return State.sortAsc ? 1 : -1;
        return 0;
      });
    }

    State.filteredItems = results;
    State.currentPage = 1;
    renderTable();
  }

  // ═══════════════════════════════════════════════════════
  //  RENDER TABLE
  // ═══════════════════════════════════════════════════════
  function renderTable() {
    const items = State.filteredItems;
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    State.currentPage = Math.min(State.currentPage, totalPages);

    const start = (State.currentPage - 1) * PAGE_SIZE;
    const page  = items.slice(start, start + PAGE_SIZE);

    if (items.length === 0) {
      dom.tableBody.innerHTML = '';
      dom.emptyState.classList.remove('hidden');
    } else {
      dom.emptyState.classList.add('hidden');
      dom.tableBody.innerHTML = page.map(renderRow).join('');
    }

    // Reset check-all based on current page selection
    const pageIds = page.map(i => i.id);
    dom.checkAll.checked = pageIds.length > 0 && pageIds.every(id => State.selectedIds.has(id));
    updateBulkActions();

    // Pagination info
    const showStart = items.length ? start + 1 : 0;
    const showEnd   = Math.min(start + PAGE_SIZE, items.length);
    dom.tableCount.textContent = `Showing ${showStart}–${showEnd} of ${items.length} items`;
    dom.pageIndicator.textContent = `${State.currentPage} / ${totalPages}`;
    dom.btnPrev.disabled = State.currentPage <= 1;
    dom.btnNext.disabled = State.currentPage >= totalPages;
  }

  function updateBulkActions() {
    if (State.selectedIds.size > 0) {
      dom.bulkActionsBar.classList.remove('hidden');
      dom.bulkCount.textContent = State.selectedIds.size;
      
      if (State.viewMode === 'archive') {
        dom.btnBulkArchive.classList.add('hidden');
        dom.btnBulkRestore.classList.remove('hidden');
      } else {
        dom.btnBulkArchive.classList.remove('hidden');
        dom.btnBulkRestore.classList.add('hidden');
      }
    } else {
      dom.bulkActionsBar.classList.add('hidden');
    }
  }

  // Extract all assigned bin codes for an item
  function getItemBins(item) {
    if (!item.locationStock) return [];
    return Object.keys(item.locationStock).filter(k => k !== LOC_DEPOT && k !== LOC_BUILDING);
  }

  function renderRow(item) {
    const depot   = locStock(item, LOC_DEPOT); // Use updated locStock instead of deprecated depotStock function
    const cAlert  = needsCarrier(item);
    const pAlert  = needsProcurement(item);
    const bins    = getItemBins(item);
    const primaryBin = bins.length > 0 ? bins[0] : (item.binCode || '—');
    const binLabel = bins.length > 1 ? `${primaryBin} (+${bins.length - 1} more)` : primaryBin;
    
    // Check if any bin is a golden zone violation (for the warning)
    const gzWarn  = isHighVelocity(item) && bins.length > 0 && !bins.some(isGoldenZone);
    const rowClass = [cAlert ? 'row-carrier' : '', pAlert ? 'row-procure' : '', gzWarn ? 'row-golden-zone' : ''].join(' ').trim();

    const buildingNow = locStock(item, LOC_BUILDING);
    const totalNow = totalStockFromLocs(item);
    const gaugePercent = item.maxCapacity > 0 ? Math.min(100, (buildingNow / item.maxCapacity) * 100) : 0;
    const gaugeColor   = gaugePercent <= 25 ? 'bg-red-500' : gaugePercent <= 50 ? 'bg-amber-500' : 'bg-emerald-500';

    let badge = '<span class="badge badge-ok">OK</span>';
    if (cAlert && pAlert) badge = '<span class="badge badge-carrier">CARRIER</span> <span class="badge badge-procure">ORDER</span>';
    else if (cAlert) badge = '<span class="badge badge-carrier">CARRIER</span>';
    else if (pAlert) badge = '<span class="badge badge-procure">ORDER</span>';

    const stockColor = (val, trigger) =>
      val <= 0 ? 'text-red-600 dark:text-red-400'
      : (trigger !== undefined && val <= trigger) ? 'text-amber-600 dark:text-amber-400'
      : 'text-emerald-600 dark:text-emerald-400';

    const totalCls   = stockColor(totalNow, item.purchasingTrigger);
    const bldgCls    = stockColor(buildingNow, item.carrierTrigger);
    const depotCls   = stockColor(depot, undefined);

    const binCell = gzWarn
      ? `<span class="text-red-600 dark:text-red-400 font-bold" title="High-velocity item not in Golden Zone (Levels 2-4)">${esc(binLabel)}</span><span class="ml-1 inline-block w-2 h-2 rounded-full bg-red-500"></span>`
      : esc(binLabel);

    return `
      <tr class="group hover:bg-gray-50/80 dark:hover:bg-surface-700/30 transition-colors ${rowClass}" data-id="${item.id}">
        <td class="px-2 py-1.5 text-center"><input type="checkbox" class="row-checkbox w-4 h-4 rounded border-gray-300 text-accent focus:ring-accent" data-id="${item.id}" ${State.selectedIds.has(item.id) ? 'checked' : ''}></td>
        <td class="px-2 py-1.5 text-center">${badge}</td>
        <td class="px-2 py-1.5 text-xs font-semibold text-accent" style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">${esc(item.sku)}</td>
        <td class="px-2 py-1.5 font-medium">${esc(item.name)}</td>
        <td class="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400 hidden md:table-cell" style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">${binCell}</td>
        <td class="px-2 py-1.5 text-gray-500 dark:text-gray-400 hidden sm:table-cell">${esc(item.category || '—')}</td>
        <td class="px-2 py-1.5 text-center hidden lg:table-cell">
          ${item.datasheetUrl
            ? `<a href="${esc(item.datasheetUrl)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center text-accent hover:text-accent-dark transition" title="${esc(item.datasheetUrl)}">
                 <svg class="w-4 h-4 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
               </a>`
            : '<span class="text-gray-300 dark:text-gray-600">—</span>'}
        </td>
        <td class="px-2 py-1.5 text-center">
          <input type="number" inputmode="numeric" min="0" class="inline-input ${totalCls}" value="${totalNow}" data-field="totalStock" data-id="${item.id}" title="Sum across all locations — edits adjust Main Depot" />
        </td>
        <td class="px-2 py-1.5">
          <div class="flex items-center justify-center gap-1.5">
            <button class="adj-btn" data-action="dec" data-id="${item.id}" title="−1">−</button>
            <input type="number" inputmode="numeric" min="0" class="inline-input ${bldgCls}" value="${buildingNow}" data-field="buildingStock" data-id="${item.id}" />
            <button class="adj-btn" data-action="inc" data-id="${item.id}" title="+1">+</button>
          </div>
          <div class="mt-1 w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5 overflow-hidden" title="${Math.round(gaugePercent)}% of max capacity">
            <div class="gauge-bar ${gaugeColor}" style="width:${gaugePercent}%"></div>
          </div>
        </td>
        <td class="px-2 py-1.5 text-center font-semibold tabular-nums ${depotCls}">
          <input type="number" inputmode="numeric" min="0" class="inline-input ${depotCls}" value="${depot}" data-field="depotStock" data-id="${item.id}" />
        </td>
        <td class="px-2 py-1.5 text-center hidden lg:table-cell">
          <input type="number" inputmode="numeric" min="0" class="inline-input" value="${item.carrierTrigger}" data-field="carrierTrigger" data-id="${item.id}" />
        </td>
        <td class="px-2 py-1.5 text-center hidden lg:table-cell">
          <input type="number" inputmode="numeric" min="0" class="inline-input" value="${item.maxCapacity}" data-field="maxCapacity" data-id="${item.id}" />
        </td>
        <td class="px-2 py-1.5 text-center hidden lg:table-cell">
          <input type="number" inputmode="numeric" min="0" class="inline-input" value="${item.purchasingTrigger}" data-field="purchasingTrigger" data-id="${item.id}" />
        </td>
        <td class="px-2 py-1.5 text-center">
          <div class="action-btns flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button class="p-1.5 rounded-lg hover:bg-accent/10 text-accent transition" data-action="print" data-id="${item.id}" title="Print Label">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
            </button>
            <button class="p-1.5 rounded-lg hover:bg-emerald-500/10 text-emerald-500 transition" data-action="transfer" data-id="${item.id}" title="Transfer stock between locations">
              <svg class="w-4 h-4 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/></svg>
            </button>
            <button class="p-1.5 rounded-lg hover:bg-accent/10 text-accent transition" data-action="edit" data-id="${item.id}" title="Edit">
              <svg class="w-4 h-4 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
            </button>
            <button class="p-1.5 rounded-lg hover:bg-indigo-500/10 text-indigo-500 transition" data-action="history" data-id="${item.id}" title="Item history — stock movements">
              <svg class="w-4 h-4 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </button>
            <button class="p-1.5 rounded-lg hover:bg-red-500/10 text-red-500 transition" data-action="delete" data-id="${item.id}" title="Delete">
              <svg class="w-4 h-4 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
  }

  // ═══════════════════════════════════════════════════════
  //  RENDER DASHBOARD
  // ═══════════════════════════════════════════════════════
  function renderDashboard() {
    const carriers = getCarrierAlerts();
    const procures = getProcureAlerts();
    const categories = getCategories();
    const totalUnits = State.items.reduce((s, i) => s + totalStockFromLocs(i), 0);

    dom.statTotalItems.textContent   = State.items.length.toLocaleString();
    dom.statCategories.textContent   = categories.length;
    dom.statTotalUnits.textContent   = totalUnits.toLocaleString();
    dom.statCarrierCount.textContent = carriers.length;
    dom.statProcureCount.textContent = procures.length;

    // Carrier quicklist
    if (carriers.length) {
      dom.carrierPulse.classList.remove('hidden');
      dom.carrierQuicklist.innerHTML = carriers.slice(0, 5).map(i =>
        `<li class="flex items-center justify-between text-xs">
          <span class="truncate font-medium">${esc(i.sku)} — ${esc(i.name)}</span>
          <span class="text-carrier font-bold ml-2 shrink-0">${i.buildingStock}/${i.maxCapacity}</span>
        </li>`
      ).join('') + (carriers.length > 5 ? `<li class="text-xs text-gray-400">+ ${carriers.length - 5} more…</li>` : '');
    } else {
      dom.carrierPulse.classList.add('hidden');
      dom.carrierQuicklist.innerHTML = '<li class="text-gray-400 italic text-xs">All clear ✓</li>';
    }

    // Procure quicklist
    if (procures.length) {
      dom.procurePulse.classList.remove('hidden');
      dom.procureQuicklist.innerHTML = procures.slice(0, 5).map(i =>
        `<li class="flex items-center justify-between text-xs">
          <span class="truncate font-medium">${esc(i.sku)} — ${esc(i.name)}</span>
          <span class="text-procure font-bold ml-2 shrink-0">${i.totalStock} left</span>
        </li>`
      ).join('') + (procures.length > 5 ? `<li class="text-xs text-gray-400">+ ${procures.length - 5} more…</li>` : '');
    } else {
      dom.procurePulse.classList.add('hidden');
      dom.procureQuicklist.innerHTML = '<li class="text-gray-400 italic text-xs">All clear ✓</li>';
    }
  }

  function populateCategoryFilter() {
    const cats = getCategories();
    const current = dom.categorySelect.value;
    
    // Get all predefined options from the add item form
    const predefinedSelect = $('#field-category');
    if (!predefinedSelect) return;
    
    const predefinedHTML = predefinedSelect.innerHTML;
    // Extract values to know what is already predefined
    const predefinedValues = Array.from(predefinedSelect.querySelectorAll('option')).map(o => o.value).filter(Boolean);
    
    // Find custom categories
    const customCats = cats.filter(c => !predefinedValues.includes(c));
    
    let html = '<option value="">All Categories</option>' + predefinedHTML.replace('<option value="">-- Select Category --</option>', '');
    
    if (customCats.length > 0) {
      html += '<optgroup label="Custom Categories">';
      html += customCats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
      html += '</optgroup>';
    }
    
    dom.categorySelect.innerHTML = html;
    if (dom.categorySelect.querySelector(`option[value="${esc(current)}"]`)) {
      dom.categorySelect.value = current;
    } else {
      dom.categorySelect.value = '';
    }
  }

  // ═══════════════════════════════════════════════════════
  //  ITEM CRUD — KEYBOARD-FRIENDLY INLINE EDITING
  // ═══════════════════════════════════════════════════════

  // Save field without re-rendering the row (preserves focus & cursor)
  function saveFieldSilently(id, field, value) {
    const item = State.items.find(i => i.id === id);
    if (!item) return;
    const num = Math.max(0, parseInt(value, 10) || 0);

    if (field === 'buildingStock') {
      const ls = { ...(item.locationStock || {}) };
      const cur = locStock(item, LOC_BUILDING);
      if (cur === num) return;
      const ceiling = totalStockFromLocs(item);
      const clampedBuilding = Math.min(num, ceiling);
      const newDepot = Math.max(0, ceiling - clampedBuilding);
      ls[LOC_BUILDING] = clampedBuilding;
      ls[LOC_DEPOT] = newDepot;
      item.locationStock = ls;
      item.buildingStock = clampedBuilding;
      item.depotStock = newDepot;
    } else if (field === 'depotStock') {
      const ls = { ...(item.locationStock || {}) };
      const cur = locStock(item, LOC_DEPOT);
      if (cur === num) return;
      const ceiling = totalStockFromLocs(item);
      const clampedDepot = Math.min(num, ceiling);
      const newBuilding = Math.max(0, ceiling - clampedDepot);
      ls[LOC_DEPOT] = clampedDepot;
      ls[LOC_BUILDING] = newBuilding;
      item.locationStock = ls;
      item.depotStock = clampedDepot;
      item.buildingStock = newBuilding;
    } else if (field === 'totalStock') {
      const currentTotal = totalStockFromLocs(item);
      if (currentTotal === num) return;
      const currentBuilding = locStock(item, LOC_BUILDING);
      const newDepot = Math.max(0, num - currentBuilding);
      const ls = { ...(item.locationStock || {}) };
      ls[LOC_DEPOT] = newDepot;
      item.locationStock = ls;
      item.depotStock = newDepot;
    } else {
      if (item[field] === num) return;
      item[field] = num;
    }
    DAL.saveOne(item);

    const row = dom.tableBody.querySelector(`tr[data-id="${id}"]`);
    if (row) {
      // Layout reminder (renderRow cells):
      // 0=checkbox 1=badge 2=SKU 3=Name 4=Bin 5=Category 6=Datasheet
      // 7=TotalInput 8=BuildingInput 9=DepotInput 10=CarrierTrig 11=MaxCap 12=PurchTrig 13=Actions
      const depotCell = row.cells[9];
      if (depotCell) {
        const depot = depotStock(item);
        const inp = depotCell.querySelector('input.inline-input');
        if (inp && document.activeElement !== inp) {
          inp.value = depot;
          inp.className = `inline-input ${depot <= 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`;
        }
      }

      const buildingNow = locStock(item, LOC_BUILDING);
      const gaugePercent = item.maxCapacity > 0 ? Math.min(100, (buildingNow / item.maxCapacity) * 100) : 0;
      const gaugeColor = gaugePercent <= 25 ? 'bg-red-500' : gaugePercent <= 50 ? 'bg-amber-500' : 'bg-emerald-500';
      const gaugeBar = row.querySelector('.gauge-bar');
      if (gaugeBar) {
        gaugeBar.style.width = gaugePercent + '%';
        gaugeBar.className = `gauge-bar ${gaugeColor}`;
      }

      const cAlert = needsCarrier(item);
      const pAlert = needsProcurement(item);
      row.classList.toggle('row-carrier', cAlert);
      row.classList.toggle('row-procure', pAlert);

      const badgeCell = row.cells[1];
      if (badgeCell) {
        let badge = '<span class="badge badge-ok">OK</span>';
        if (cAlert && pAlert) badge = '<span class="badge badge-carrier">CARRIER</span> <span class="badge badge-procure">ORDER</span>';
        else if (cAlert) badge = '<span class="badge badge-carrier">CARRIER</span>';
        else if (pAlert) badge = '<span class="badge badge-procure">ORDER</span>';
        badgeCell.innerHTML = badge;
      }

      // Update the Total INPUT (cells[7]) without touching the focused element.
      // Only update the cell the user is NOT editing.
      const totalCell = row.cells[7];
      if (totalCell) {
        const inp = totalCell.querySelector('input.inline-input');
        if (inp && document.activeElement !== inp) inp.value = totalStockFromLocs(item);
      }
      // Same defensive update for Building cell (cells[8])
      const bldgCell = row.cells[8];
      if (bldgCell) {
        const inp = bldgCell.querySelector('input.inline-input');
        if (inp && document.activeElement !== inp && field !== 'buildingStock') {
          inp.value = buildingNow;
        }
      }
    }

    renderDashboard();
  }

  function updateFieldFull(id, field, value) {
    const item = State.items.find(i => i.id === id);
    if (!item) return;
    const num = Math.max(0, parseInt(value, 10) || 0);

    if (field === 'buildingStock') {
      const ls = { ...(item.locationStock || {}) };
      const ceiling = totalStockFromLocs(item);
      const clampedBuilding = Math.min(num, ceiling);
      const newDepot = Math.max(0, ceiling - clampedBuilding);
      ls[LOC_BUILDING] = clampedBuilding;
      ls[LOC_DEPOT] = newDepot;
      item.locationStock = ls;
      item.buildingStock = clampedBuilding;
      item.depotStock = newDepot;
    } else if (field === 'totalStock') {
      const currentBuilding = locStock(item, LOC_BUILDING);
      const newDepot = Math.max(0, num - currentBuilding);
      const ls = { ...(item.locationStock || {}) };
      ls[LOC_DEPOT] = newDepot;
      item.locationStock = ls;
      item.depotStock = newDepot;
    } else {
      item[field] = num;
    }
    DAL.saveOne(item);
    renderDashboard();
    populateCategoryFilter();
    const row = dom.tableBody.querySelector(`tr[data-id="${id}"]`);
    if (row) {
      const temp = document.createElement('tbody');
      temp.innerHTML = renderRow(item);
      row.replaceWith(temp.firstElementChild);
    }
  }

  async function adjustStock(id, delta) {
    const item = State.items.find(i => i.id === id);
    if (!item) return;

    let targetLoc = LOC_BUILDING;
    const bins = getItemBins(item);
    if (bins.length > 1) {
      const binList = bins.map((b, i) => `${i + 1}: ${b} (Qty: ${item.locationStock[b]})`).join('\n');
      const pick = window.prompt(`This item is in multiple bins. Which bin do you want to adjust?\n\n${binList}\n\nEnter the number (1-${bins.length}):`);
      if (!pick) return; // Cancelled
      const idx = parseInt(pick, 10) - 1;
      if (idx >= 0 && idx < bins.length) {
        targetLoc = bins[idx];
      } else {
        toast('Invalid selection', 'error');
        return;
      }
    }

    try {
      const result = await DAL.adjustStockAtomic(id, delta, targetLoc);
      item.locationStock = result.locationStock;
      item.buildingStock = result.buildingStock;
      item.totalStock = result.totalStock;
      renderDashboard();
      const row = dom.tableBody.querySelector(`tr[data-id="${id}"]`);
      if (row) {
        const temp = document.createElement('tbody');
        temp.innerHTML = renderRow(item);
        row.replaceWith(temp.firstElementChild);
      }
    } catch (err) {
      console.error('Atomic adjustStock failed:', err);
      const cached = await Storage.loadSnapshot();
      if (cached.length) {
        State.items = cached;
        applyFilters();
        renderDashboard();
        toast('Connection error — loaded cached snapshot', 'info');
      } else {
        toast('Stock adjustment failed: ' + (err.message || err.code), 'error');
      }
    }
  }

  function saveItem(data) {
    let item;
    let result;
    // Build locationStock map from form fields if not already present
    const locData = data.locationStock || {};
    if (!locData[LOC_DEPOT])    locData[LOC_DEPOT]   = data.totalStock || 0;
    if (!locData[LOC_BUILDING]) locData[LOC_BUILDING] = data.buildingStock || 0;
    const merged = { ...data, locationStock: locData };

    if (State.editingId) {
      const idx = State.items.findIndex(i => i.id === State.editingId);
      if (idx >= 0) {
        // Merge new data into existing, preserving other location entries
        const existing = State.items[idx];
        const mergedLS = { ...(existing.locationStock || {}), ...locData };
        State.items[idx] = { ...existing, ...merged, id: State.editingId, locationStock: mergedLS };
        item = State.items[idx];
      }
    } else {
      // New item: initialize locationStock from seed
      const mergedLS = { ...locData };
      item = { id: DAL.generateId(), ...merged, locationStock: mergedLS };
      State.items.push(item);
    }
    if (item) result = DAL.saveOne(item);
    State.editingId = null;
    applyFilters();
    renderDashboard();
    populateCategoryFilter();
    return result;
  }

  async function deleteItem(id) {
    const ok = await confirmDialog({
      title: 'Delete item?',
      message: 'This cannot be undone. The item will be permanently removed from Firestore.',
      confirmText: 'Delete',
      danger: true
    });
    if (!ok) return;
    State.items = State.items.filter(i => i.id !== id);
    DAL.deleteOne(id);
    State.selectedIds.delete(id);
    applyFilters();
    renderDashboard();
    populateCategoryFilter();
    toast('Item deleted', 'info');
  }

  // ═══════════════════════════════════════════════════════
  //  MODALS
  // ═══════════════════════════════════════════════════════
  function openModal(el)  { el.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
  function closeModal(el) { el.classList.add('hidden');    document.body.style.overflow = ''; }

  function openItemModal(item = null) {
    State.editingId = item ? item.id : null;
    $('#modal-item-title').textContent = item ? 'Edit Item' : 'Add New Item';
    $('#field-id').value               = item ? item.id : '';
    $('#field-sku').value               = item ? item.sku : '';
    $('#field-name').value              = item ? item.name : '';
    $('#field-category').value          = item ? item.category : '';
    $('#field-totalStock').value        = item ? totalStockFromLocs(item) : 0;
    $('#field-buildingStock').value     = item ? locStock(item, LOC_BUILDING) : 0;
    $('#field-carrierTrigger').value    = item ? item.carrierTrigger : 5;
    $('#field-maxCapacity').value       = item ? item.maxCapacity : 20;
    $('#field-purchasingTrigger').value = item ? item.purchasingTrigger : 10;
    $('#field-datasheetUrl').value      = item ? (item.datasheetUrl || '') : '';
    if ($('#field-binCode')) $('#field-binCode').value = item ? (item.binCode || '') : '';
    openModal(dom.modalItem);
    setTimeout(() => $('#field-sku').focus(), 100);
  }

  // ─── Carrier Manifest ───
  function generateManifest() {
    const alerts = getCarrierAlerts();
    if (!alerts.length) {
      dom.manifestContent.innerHTML = `
        <div class="text-center py-8 text-gray-400">
          <svg class="w-12 h-12 mx-auto mb-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          <p class="font-medium">No carrier transfers needed!</p>
          <p class="text-sm mt-1">All building stock levels are adequate.</p>
        </div>`;
      openModal(dom.modalManifest);
      return;
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    let totalItems = 0;
    const rows = alerts.map(i => {
      const qty = carrierQty(i);
      totalItems += qty;
      return { sku: i.sku, name: i.name, qty, current: i.buildingStock, max: i.maxCapacity, depot: depotStock(i) };
    });

    dom.manifestContent.innerHTML = `
      <div class="manifest-print-area">
        <div class="text-center mb-4 pb-3 border-b border-gray-200 dark:border-gray-700">
          <p class="text-lg font-bold">🚚 CARRIER TRANSFER MANIFEST</p>
          <p class="text-xs text-gray-500">${dateStr} at ${timeStr}</p>
        </div>
        <p class="text-xs text-gray-500 mb-3">FROM: <strong>Main Depot</strong> → TO: <strong>Company Building</strong></p>
        <table class="w-full text-xs border-collapse">
          <thead>
            <tr class="border-b-2 border-gray-300 dark:border-gray-600 text-left">
              <th class="py-1.5 pr-2">SKU</th>
              <th class="py-1.5 pr-2">Item</th>
              <th class="py-1.5 text-right pr-2">Bring Qty</th>
              <th class="py-1.5 text-right pr-2">Current</th>
              <th class="py-1.5 text-right">Depot Avail.</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr class="border-b border-gray-100 dark:border-gray-700/50 ${r.qty > r.depot ? 'text-red-500' : ''}">
                <td class="py-1.5 pr-2 font-mono font-semibold">${esc(r.sku)}</td>
                <td class="py-1.5 pr-2">${esc(r.name)}</td>
                <td class="py-1.5 text-right pr-2 font-bold">${r.qty}</td>
                <td class="py-1.5 text-right pr-2">${r.current}/${r.max}</td>
                <td class="py-1.5 text-right ${r.qty > r.depot ? 'font-bold' : ''}">${r.depot}${r.qty > r.depot ? ' ⚠' : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <div class="mt-4 pt-3 border-t border-gray-200 dark:border-gray-700 flex justify-between text-xs font-bold">
          <span>Total Line Items: ${alerts.length}</span>
          <span>Total Units to Transfer: ${totalItems}</span>
        </div>
        ${rows.some(r => r.qty > r.depot) ? '<p class="mt-2 text-red-500 text-xs font-semibold">⚠ Some items have insufficient depot stock — consider placing a supplier order first.</p>' : ''}
      </div>`;

    openModal(dom.modalManifest);
  }

  function getManifestText() {
    const alerts = getCarrierAlerts();
    if (!alerts.length) return 'No carrier transfers needed.';
    const now = new Date();
    let text = `CARRIER TRANSFER MANIFEST\n${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}\nFROM: Main Depot → TO: Company Building\n${'─'.repeat(60)}\n`;
    alerts.forEach(i => {
      const qty = carrierQty(i);
      text += `• Bring ${qty} units of ${i.sku} (${i.name}) — currently ${i.buildingStock}/${i.maxCapacity} in building\n`;
    });
    text += `${'─'.repeat(60)}\nTotal items: ${alerts.length}\n`;
    return text;
  }

  // ─── Walking-Route Pick Sheet ───
  function generatePickSheet() {
    const items = State.items.filter(i => !i.archived && locStock(i, LOC_BUILDING) > 0);
    if (!items.length) {
      toast('No active building stock to pick', 'info');
      return;
    }

    const sorted = sortByPickPath(items);
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    // Group by physical zone for section headers
    let currentZone = null;
    let rowsHtml = '';
    sorted.forEach(item => {
      const bc = item.binCode || 'UNASSIGNED';
      const zone = bc.startsWith('GENERAL-') ? 'GENERAL ZONES' : (bc.split('-')[0] || 'UNASSIGNED');
      if (zone !== currentZone) {
        currentZone = zone;
        rowsHtml += `<div class="pick-section">${esc(zone)}</div>`;
      }
      const qty = locStock(item, LOC_BUILDING);
      rowsHtml += `
        <div class="pick-row">
          <div class="pick-loc">${esc(bc)}</div>
          <div class="pick-item">
            <span class="pick-qty">${qty}</span>
            <span class="pick-sku">${esc(item.sku)}</span>
            <span class="text-gray-600">${esc(item.name)}</span>
          </div>
        </div>`;
    });

    const container = $('#pick-sheet-print');
    container.innerHTML = `
      <div class="pick-header">
        <h1>PICK SHEET — Walking Route</h1>
      </div>
      <div class="pick-meta">${dateStr} ${timeStr} • ${sorted.length} SKUs • Route: Room 1 → Aisle 1 → Aisle 2 → Room 2 → Aisle 3 → General Zones</div>
      <div class="pick-row" style="border-bottom:2px solid #000;font-weight:900;">
        <div class="pick-loc">LOCATION</div>
        <div class="pick-item">QTY / SKU / DESCRIPTION</div>
      </div>
      ${rowsHtml}
    `;

    document.body.classList.add('printing-pick-sheet');
    setTimeout(() => {
      window.print();
      setTimeout(() => {
        document.body.classList.remove('printing-pick-sheet');
        container.innerHTML = '';
      }, 500);
    }, 200);
  }

  // ─── Alert Detail Modal ───
  function openAlertDetail(type) {
    const items = type === 'carrier' ? getCarrierAlerts() : getProcureAlerts();
    dom.modalAlertsTitle.textContent = type === 'carrier' ? '🔴 Carrier Transfer Alerts' : '🟡 Procurement Alerts';

    if (!items.length) {
      dom.modalAlertsList.innerHTML = '<p class="text-center text-gray-400 py-6">No alerts — all clear!</p>';
    } else {
      dom.modalAlertsList.innerHTML = items.map(i => {
        if (type === 'carrier') {
          return `<div class="flex items-center justify-between p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40">
            <div>
              <p class="font-semibold text-sm">${esc(i.sku)} — ${esc(i.name)}</p>
              <p class="text-xs text-gray-500">Building: ${i.buildingStock}/${i.maxCapacity} • Need ${carrierQty(i)} units from depot</p>
            </div>
            <span class="badge badge-carrier shrink-0 ml-2">LOW</span>
          </div>`;
        } else {
          return `<div class="flex items-center justify-between p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40">
            <div>
              <p class="font-semibold text-sm">${esc(i.sku)} — ${esc(i.name)}</p>
              <p class="text-xs text-gray-500">Total Stock: ${i.totalStock} • Trigger: ${i.purchasingTrigger}</p>
            </div>
            <span class="badge badge-procure shrink-0 ml-2">ORDER</span>
          </div>`;
        }
      }).join('');
    }
    openModal(dom.modalAlerts);
  }

  // ─── Print Labels ───
  function printLabels(itemsToPrint) {
    if (!itemsToPrint || itemsToPrint.length === 0) return;
    
    // Clear the print container
    dom.printContainer.innerHTML = '';
    
    // Generate label HTML
    itemsToPrint.forEach(item => {
      const wrapper = document.createElement('div');
      wrapper.className = 'shelf-label';
      wrapper.innerHTML = `
        <div class="shelf-label-top">
          <div class="shelf-label-info">
            <div class="shelf-label-sku">${esc(item.sku)}</div>
            <div class="shelf-label-name">${esc(item.name)}</div>
          </div>
          <div class="shelf-label-sku-qr" id="sku-qr-${item.id}"></div>
          ${item.datasheetUrl ? '<div class="shelf-label-url-qr" id="url-qr-' + item.id + '"></div>' : ''}
        </div>
        <div class="shelf-label-footer">
          <span>${esc(item.category || '')}</span>
        </div>
      `;
      dom.printContainer.appendChild(wrapper);
      
      // Render SKU QR Code — encodes the public guest checkout URL
      try {
        new QRCode(document.getElementById(`sku-qr-${item.id}`), {
          text: guestUrl(item.id, item.binCode),
          width: 200,
          height: 200,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.H
        });
      } catch (e) {
        console.warn('Could not generate SKU QR for:', item.sku);
      }
      
      // Render Datasheet URL QR Code (if URL exists)
      if (item.datasheetUrl) {
        try {
          new QRCode(document.getElementById(`url-qr-${item.id}`), {
            text: item.datasheetUrl,
            width: 160,
            height: 160,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.H
          });
        } catch (e) {
          console.warn('Could not generate URL QR for:', item.datasheetUrl);
        }
      }
    });
    
    // Trigger print (deferred so qrcodejs canvas finishes rasterizing)
    document.body.classList.add('printing-label');
    // qrcodejs renders synchronously to canvas/svg, but makeImage() is async.
    // A short delay ensures the QR pixels are committed before the print spooler reads them.
    setTimeout(() => {
      window.print();
      setTimeout(() => {
        document.body.classList.remove('printing-label');
        dom.printContainer.innerHTML = '';
        dom.printContainer.className = '';
      }, 500);
    }, 150);
  }

  // ═══════════════════════════════════════════════════════
  //  LABEL GENERATOR + TRANSACTIONS + SCAN OUT
  // ═══════════════════════════════════════════════════════

  const LG_LOGO_KEY = 'st3s_label_logo';   // localStorage key

  // Read saved logo (data URL) on demand
  function getSavedLogo() {
    try { return localStorage.getItem(LG_LOGO_KEY) || ''; } catch { return ''; }
  }
  function setSavedLogo(dataUrl) {
    try { localStorage.setItem(LG_LOGO_KEY, dataUrl); } catch (e) { console.warn('Logo save failed', e); }
  }

  // ─── Label size presets (returns {w, h} in inches) ───
  function getLabelSize() {
    const preset = $('#labelgen-size').value;
    if (preset === 'custom')   return { w: parseFloat($('#labelgen-w').value) || 4, h: parseFloat($('#labelgen-h').value) || 2, isGrid: false, isA4Land: false };
    if (preset === '4x2')     return { w: 4, h: 2, isGrid: false, isA4Land: false };
    if (preset === '2x1')     return { w: 2, h: 1, isGrid: false, isA4Land: false };
    if (preset === 'a4-land') return { w: 2.6, h: 1.4, isGrid: false, isA4Land: true };
    if (preset === 'a4-grid') return { w: 2, h: 1.33, isGrid: true, isA4Land: false }; // legacy compat
    return { w: 4, h: 2, isGrid: false, isA4Land: false };
  }

  // ─── Build a single label DOM node (used for both preview and print rows) ───
  function buildLabelElement(item, opts) {
    const { w, h, logoDataUrl, sku, name, extra, qrSource, qrCustom } = opts;
    const label = document.createElement('div');
    label.className = 'shelf-label';
    label.style.width  = `${w}in`;
    label.style.height = `${h}in`;
    label.style.padding = `${Math.max(0.08, h * 0.08)}in ${Math.max(0.1, w * 0.06)}in`;

    const finalSku  = sku  || item?.sku  || '';
    const finalName = name || item?.name || '';
    const finalExtra = extra || '';
    const fontSize  = Math.max(8, Math.min(20, h * 10));
    const skuFont   = Math.max(10, Math.min(28, h * 14));
    const nameFont  = Math.max(8, Math.min(14, h * 7));

    let qrContent = '';
    if (qrSource === 'sku' && item) qrContent = guestUrl(item.id, item.binCode);
    else if (qrSource === 'datasheet' && item?.datasheetUrl) qrContent = item.datasheetUrl;
    else if (qrSource === 'custom' && qrCustom) qrContent = qrCustom;
    const qrId = 'lg-qr-' + Math.random().toString(36).slice(2, 9);

    const hasDatasheetQR = item?.datasheetUrl && qrSource !== 'datasheet';
    const dsQrId = 'lg-dsqr-' + Math.random().toString(36).slice(2, 9);

    label.innerHTML = `
      <div class="shelf-label-top">
        <div class="shelf-label-info">
          ${logoDataUrl ? `<img src="${logoDataUrl}" alt="logo" style="max-height:${Math.min(0.4, h*0.3)}in; max-width:${w*0.5}in; object-fit:contain; margin-bottom:2px;">` : ''}
          <div class="shelf-label-sku" style="font-size:${skuFont}pt;">${esc(finalSku)}</div>
          <div class="shelf-label-name" style="font-size:${nameFont}pt;">${esc(finalName)}</div>
          ${finalExtra ? `<div style="font-size:${fontSize-2}pt; color:#444; margin-top:2px;">${esc(finalExtra)}</div>` : ''}
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:0; flex-shrink:0;">
          <div style="display:flex; gap:0.08in; align-items:flex-end;">
            ${qrContent ? `<div class="shelf-label-sku-qr" id="${qrId}" style="width:${Math.min(1.1, h*0.7)}in; height:${Math.min(1.1, h*0.7)}in;"></div>` : ''}
            ${hasDatasheetQR ? `<div class="shelf-label-url-qr" id="${dsQrId}" style="width:${Math.min(0.9, h*0.55)}in; height:${Math.min(0.9, h*0.55)}in;"></div>` : ''}
          </div>
          ${item?.binCode ? `<span class="shelf-label-bin" style="margin-top:1px; font-size:${Math.max(7, h*4)}pt;">${esc(item.binCode)}</span>` : ''}
        </div>
      </div>
      <div class="shelf-label-footer">
        <span>${esc(item?.category || '')}</span>
        <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:7pt;letter-spacing:0.05em;">${esc(item?.binCode || '')}</span>
      </div>
    `;

    if (qrContent) {
      try {
        const qrSize = Math.max(200, Math.min(1.1, h*0.7) * 144);
        new QRCode(label.querySelector('#' + qrId), {
          text: qrContent,
          width: qrSize, height: qrSize,
          colorDark: '#000000', colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.H
        });
      } catch (e) { console.warn('QR render failed', e); }
    }

    if (hasDatasheetQR) {
      try {
        const dsSize = Math.max(160, Math.min(0.9, h*0.55) * 144);
        new QRCode(label.querySelector('#' + dsQrId), {
          text: item.datasheetUrl,
          width: dsSize, height: dsSize,
          colorDark: '#000000', colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.H
        });
      } catch (e) { console.warn('Datasheet QR render failed', e); }
    }

    return label;
  }

  // ─── Render the live preview (single or first-of-bulk) ───
  function renderLabelGenPreview() {
    const source = document.querySelector('input[name="labelgen-source"]:checked')?.value || 'single';
    let item = null;
    if (source === 'single') {
      const sku = $('#labelgen-item').value;
      item = State.items.find(i => i.sku === sku) || null;
    } else {
      item = State.filteredItems[0] || State.items[0] || null;
    }

    const size = getLabelSize();
    const logoDataUrl = getSavedLogo();
    const sku   = $('#labelgen-sku').value.trim()   || item?.sku || '';
    const name  = $('#labelgen-name').value.trim()  || item?.name || '';
    const extra = $('#labelgen-extra').value.trim();
    const qrSource = $('#labelgen-qr-source').value;
    const qrCustom = $('#labelgen-qr-custom').value.trim();

    // Dark surface behind preview to show through the print label
    const previewBox = $('#labelgen-preview');
    previewBox.innerHTML = '';
    previewBox.style.background = 'transparent';
    if (!item && !sku && !name) {
      previewBox.innerHTML = '<p class="text-gray-400 text-sm italic">Pick an item or enter text to see preview</p>';
      return;
    }

    const labelEl = buildLabelElement(item, { ...size, logoDataUrl, sku, name, extra, qrSource, qrCustom });
    previewBox.appendChild(labelEl);
  }

  // ─── Populate item dropdown ───
  function populateLabelGenItems() {
    const select = $('#labelgen-item');
    if (!select) return;
    const cur = select.value;
    select.innerHTML = '<option value="">— Custom (enter text below) —</option>' +
      State.items.map(i => `<option value="${esc(i.sku)}">${esc(i.sku)} — ${esc(i.name)}</option>`).join('');
    if (cur && State.items.some(i => i.sku === cur)) select.value = cur;
  }

  // ─── Open label generator modal ───
  function openLabelGen() {
    if (State.items.length === 0) return toast('Add inventory items first', 'info');
    populateLabelGenItems();
    renderLogoPreview();
    // Reset QR source selector (default depends on item)
    $('#labelgen-qr-source').value = 'sku';
    $('#labelgen-qr-custom').classList.add('hidden');
    openModal($('#modal-labelgen'));
    setTimeout(renderLabelGenPreview, 100);
  }

  function renderLogoPreview() {
    const logo = getSavedLogo();
    const box = $('#labelgen-logo-preview');
    if (logo) box.innerHTML = `<img src="${logo}" style="max-width:100%; max-height:100%; object-fit:contain;">`;
    else      box.innerHTML = '<span class="text-[10px] text-gray-400">No logo</span>';
  }

  // ─── Generate & print labels (single or bulk) ───
  function generateLabels() {
    const source = document.querySelector('input[name="labelgen-source"]:checked')?.value || 'single';
    const size = getLabelSize();
    const logoDataUrl = getSavedLogo();
    const sku   = $('#labelgen-sku').value.trim();
    const name  = $('#labelgen-name').value.trim();
    const extra = $('#labelgen-extra').value.trim();
    const qrSource = $('#labelgen-qr-source').value;
    const qrCustom = $('#labelgen-qr-custom').value.trim();
    const qty = Math.max(1, Math.min(20, parseInt($('#labelgen-qty')?.value, 10) || 1));

    let itemsToLabel = [];
    if (source === 'single') {
      const selectedSku = $('#labelgen-item').value;
      const item = State.items.find(i => i.sku === selectedSku) || null;
      itemsToLabel = [{ item, overrides: { sku, name, extra } }];
    } else {
      itemsToLabel = State.filteredItems.map(item => ({ item, overrides: { extra } }));
    }

    if (itemsToLabel.length === 0) return toast('No items to label', 'info');

    dom.printContainer.innerHTML = '';
    const modeClass = size.isGrid ? 'a4-grid-mode' : (size.isA4Land ? 'a4-landscape-mode' : '');
    
    // CRITICAL: Unhide and position off-screen so canvas can render and img onload fires
    dom.printContainer.className = modeClass;
    dom.printContainer.classList.remove('hidden');
    dom.printContainer.style.visibility = 'hidden';
    dom.printContainer.style.position = 'fixed';
    dom.printContainer.style.top = '-9999px';
    dom.printContainer.style.left = '0';
    dom.printContainer.style.background = 'white';
    dom.printContainer.style.zIndex = '-1';

    itemsToLabel.forEach(({ item, overrides }) => {
      for (let c = 0; c < qty; c++) {
        const labelEl = buildLabelElement(item, {
          ...size, logoDataUrl,
          sku:   overrides.sku   || item?.sku   || '',
          name:  overrides.name  || item?.name  || '',
          extra: overrides.extra || '',
          qrSource, qrCustom
        });
        dom.printContainer.appendChild(labelEl);
      }
    });

    if (size.isA4Land) document.body.classList.add('print-a4-landscape');
    
    // Wait for all generated QR images to load
    const imgs = dom.printContainer.querySelectorAll('img');
    const loadPromises = [];
    imgs.forEach(img => {
      if (!img.complete) {
        loadPromises.push(new Promise(res => {
          img.onload = res;
          img.onerror = res;
          setTimeout(res, 800); // 800ms fallback
        }));
      }
    });

    Promise.all(loadPromises).then(() => {
      // Restore flow and hand off to print CSS
      dom.printContainer.style.visibility = '';
      dom.printContainer.style.position = '';
      dom.printContainer.style.top = '';
      dom.printContainer.style.left = '';
      dom.printContainer.style.background = '';
      dom.printContainer.style.zIndex = '';
      
      document.body.classList.add('printing-label');
      requestAnimationFrame(() => {
        setTimeout(() => {
          window.print();
          setTimeout(() => {
            document.body.classList.remove('printing-label');
            document.body.classList.remove('print-a4-landscape');
            dom.printContainer.innerHTML = '';
            dom.printContainer.className = 'hidden';
            dom.printContainer.style.cssText = '';
          }, 600);
        }, 80);
      });
    });

    toast(`Generated ${itemsToLabel.length * qty} label${itemsToLabel.length * qty === 1 ? '' : 's'}`, 'success');
  }

  // ═══════════════════════════════════════════════════════
  //  SCAN OUT — camera + jsQR + decrement + log
  // ═══════════════════════════════════════════════════════

  const ScanOut = {
    stream: null,
    rafId: null,
    capturedSku: '',
    capturedItem: null,
    capturedLocation: '',
    locationVerified: false
  };

  async function startScanCamera() {
    const video = $('#scanout-video');
    if (!video) return;
    try {
      ScanOut.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false
      });
      video.srcObject = ScanOut.stream;
      video.play();
      ScanOut.rafId = requestAnimationFrame(decodeFrame);
      $('#scanout-camera-toggle').textContent = 'Stop camera';
    } catch (err) {
      const errEl = $('#scanout-error');
      errEl.textContent = 'Camera unavailable: ' + (err.message || err.name) + '. You can still type the SKU.';
      errEl.classList.remove('hidden');
    }
  }

  function stopScanCamera() {
    if (ScanOut.rafId) cancelAnimationFrame(ScanOut.rafId);
    ScanOut.rafId = null;
    if (ScanOut.stream) {
      ScanOut.stream.getTracks().forEach(t => t.stop());
      ScanOut.stream = null;
    }
    const video = $('#scanout-video');
    if (video) video.srcObject = null;
    const btn = $('#scanout-camera-toggle');
    if (btn) btn.textContent = 'Start camera';
  }

  function decodeFrame() {
    const video = $('#scanout-video');
    const canvas = $('#scanout-canvas');
    if (!video || !canvas || video.readyState < 2) {
      ScanOut.rafId = requestAnimationFrame(decodeFrame);
      return;
    }
    const ctx = canvas.getContext('2d');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    try {
      const result = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
      if (result && result.data) {
        handleScanResult(result.data.trim());
        return; // stop after first decode
      }
    } catch (e) { /* ignore decode error — keep trying */ }
    ScanOut.rafId = requestAnimationFrame(decodeFrame);
  }

  function handleScanResult(scanData) {
    let token = scanData;
    if (token.includes(' ')) token = token.split(/\s+/)[0];
    token = token.toUpperCase();

    // If we already captured an item, this scan is the location verification
    if (ScanOut.capturedItem && !ScanOut.locationVerified) {
      verifyScanOutLocation(token);
      return;
    }

    // Otherwise treat as SKU scan
    const item = State.items.find(i => i.sku && i.sku.toUpperCase() === token && !i.archived);
    if (!item) {
      const errEl = $('#scanout-error');
      errEl.textContent = `No matching SKU found for "${token}". Try again or type the SKU manually.`;
      errEl.classList.remove('hidden');
      ScanOut.rafId = requestAnimationFrame(decodeFrame);
      return;
    }
    stopScanCamera();
    showScanOutStep2(item);
  }

  function verifyScanOutLocation(scannedLoc) {
    const item = ScanOut.capturedItem;
    const expected = (item?.binCode || '').toUpperCase();
    const errEl = $('#scanout-location-error');
    const okPanel = $('#scanout-qty-panel');
    const verifyPanel = $('#scanout-location-verify');

    if (!expected) {
      errEl.textContent = 'Item has no assigned bin location. Assign a bin before scanning out.';
      errEl.classList.remove('hidden');
      return;
    }

    if (scannedLoc !== expected) {
      errEl.textContent = `LOCATION MISMATCH: scanned "${scannedLoc}" expected "${expected}". Check placement and rescan.`;
      errEl.classList.remove('hidden');
      ScanOut.capturedLocation = '';
      ScanOut.locationVerified = false;
      return;
    }

    ScanOut.capturedLocation = scannedLoc;
    ScanOut.locationVerified = true;
    errEl.classList.add('hidden');
    verifyPanel.classList.add('hidden');
    okPanel.classList.remove('hidden');
    updateScanOutNewStock();
  }

  function showScanOutStep2(item) {
    ScanOut.capturedItem = item;
    ScanOut.capturedLocation = '';
    ScanOut.locationVerified = false;
    $('#scanout-step1').classList.add('hidden');
    $('#scanout-step2').classList.remove('hidden');
    $('#scanout-success').classList.add('hidden');
    $('#scanout-error').classList.add('hidden');
    $('#scanout-location-error').classList.add('hidden');
    $('#scanout-location-verify').classList.remove('hidden');
    $('#scanout-qty-panel').classList.add('hidden');
    $('#scanout-location-input').value = '';
    $('#scanout-location-expected').textContent = `Expected location: ${item.binCode || '— (not assigned)'}`;
    $('#scanout-item-sku').textContent = item.sku;
    $('#scanout-item-name').textContent = item.name;
    $('#scanout-current-stock').textContent = item.buildingStock;
    $('#scanout-qty').value = 1;
    updateScanOutNewStock();
  }

  function updateScanOutNewStock() {
    const qty = Math.max(1, parseInt($('#scanout-qty').value, 10) || 1);
    const current = ScanOut.capturedItem ? ScanOut.capturedItem.buildingStock : 0;
    const newVal = Math.max(0, current - qty);
    $('#scanout-new-stock').textContent = newVal;
    $('#scanout-confirm-qty').textContent = qty;
  }

  async function confirmScanOut() {
    const item = ScanOut.capturedItem;
    if (!item) return;
    if (!ScanOut.locationVerified || !ScanOut.capturedLocation) {
      const errEl = $('#scanout-location-error');
      errEl.textContent = 'Location verification required before confirming stock removal.';
      errEl.classList.remove('hidden');
      return;
    }
    const qty = Math.max(1, parseInt($('#scanout-qty').value, 10) || 1);
    const currentBuilding = locStock(item, LOC_BUILDING);
    if (qty > currentBuilding) {
      const ok = await confirmDialog({
        title: 'Quantity exceeds stock',
        message: `Scanning out ${qty} but only ${currentBuilding} on hand. Stock will go to 0. Continue?`,
        confirmText: 'Continue',
        danger: true
      });
      if (!ok) return;
    }

    const newBuilding = Math.max(0, currentBuilding - qty);
    const newLS = { ...(item.locationStock || {}) };
    newLS[LOC_BUILDING] = newBuilding;
    item.locationStock = newLS;
    item.buildingStock = newBuilding;
    item.totalStock = totalStockFromLocs(item);
    await DAL.saveOne(item);

    // Log transaction
    try {
      await db.collection('transactions').add({
        itemId: item.id,
        sku: item.sku,
        name: item.name,
        qtyOut: qty,
        remainingBuilding: item.buildingStock,
        verifiedLocation: ScanOut.capturedLocation,
        type: 'scan-out',
        user: auth.currentUser?.email || 'unknown',
        userId: auth.currentUser?.uid || null,
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) { console.warn('Transaction log failed', e); }

    // UI
    $('#scanout-step2').classList.add('hidden');
    $('#scanout-success').classList.remove('hidden');
    $('#scanout-success-msg').textContent = `Removed ${qty} from ${item.sku}. Building stock: ${item.buildingStock}.`;

    // Refresh table + dashboard
    applyFilters();
    renderDashboard();

    // Re-render the row inline
    const row = dom.tableBody.querySelector(`tr[data-id="${item.id}"]`);
    if (row) {
      const temp = document.createElement('tbody');
      temp.innerHTML = renderRow(item);
      row.replaceWith(temp.firstElementChild);
    }
  }

  function resetScanOut() {
    stopScanCamera();
    ScanOut.capturedItem = null;
    ScanOut.capturedSku = '';
    ScanOut.capturedLocation = '';
    ScanOut.locationVerified = false;
    $('#scanout-step1').classList.remove('hidden');
    $('#scanout-step2').classList.add('hidden');
    $('#scanout-success').classList.add('hidden');
    $('#scanout-error').classList.add('hidden');
    $('#scanout-location-error').classList.add('hidden');
    $('#scanout-location-verify').classList.remove('hidden');
    $('#scanout-qty-panel').classList.add('hidden');
    $('#scanout-manual-sku').value = '';
    $('#scanout-location-input').value = '';
    $('#scanout-qty').value = 1;
    startScanCamera();
  }

  // ═══════════════════════════════════════════════════════
  //  TRANSACTION HISTORY
  // ═══════════════════════════════════════════════════════

  async function openHistory() {
    openModal($('#modal-history'));
    const list = $('#history-list');
    list.innerHTML = '<p class="text-center text-gray-400 py-6">Loading…</p>';
    try {
      const snap = await db.collection('transactions')
        .orderBy('timestamp', 'desc')
        .limit(100)
        .get();
      if (snap.empty) {
        list.innerHTML = '<p class="text-center text-gray-400 py-6">No transactions logged yet.</p>';
        return;
      }
      list.innerHTML = snap.docs.map(doc => {
        const t = doc.data();
        const ts = t.timestamp?.toDate?.() || new Date();
        const tsStr = ts.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        return `
          <div class="flex items-center justify-between p-3 rounded-xl bg-emerald-50/60 dark:bg-emerald-900/10 border border-emerald-200/60 dark:border-emerald-900/40">
            <div>
              <p class="font-semibold text-sm">${esc(t.sku || '—')} — ${esc(t.name || '')}</p>
              <p class="text-xs text-gray-500">
                Remaining: <span class="font-semibold">${t.remainingBuilding ?? '?'}</span> ·
                by <span class="font-medium">${esc(t.user || '?')}</span>
              </p>
            </div>
            <div class="text-right">
              <p class="font-bold text-emerald-600">−${t.qtyOut}</p>
              <p class="text-xs text-gray-400">${tsStr}</p>
            </div>
          </div>`;
      }).join('');
    } catch (err) {
      console.error('History load failed:', err);
      list.innerHTML = '<p class="text-center text-red-500 py-6">Failed to load history. Check Firestore rules for the `transactions` collection.</p>';
    }
  }

  // ═══════════════════════════════════════════════════════
  //  PER-ITEM TRANSACTION HISTORY
  // ═══════════════════════════════════════════════════════

  async function openItemHistory(item) {
    openModal($('#modal-item-history'));
    $('#item-history-title').textContent = `${item.sku} — ${item.name}`;
    $('#ih-current-bldg').textContent = locStock(item, LOC_BUILDING);
    $('#ih-total-out').textContent = '?';
    $('#ih-count').textContent = '?';
    const list = $('#item-history-list');
    list.innerHTML = '<p class="text-center text-gray-400 py-6">Loading movements…</p>';
    try {
      const snap = await db.collection('transactions')
        .where('itemId', '==', item.id)
        .orderBy('timestamp', 'desc')
        .limit(200)
        .get();
      if (snap.empty) {
        $('#ih-count').textContent = '0';
        $('#ih-total-out').textContent = '0';
        list.innerHTML = `<p class="text-center text-gray-400 py-6">No stock movements recorded for ${esc(item.sku)} yet.</p>`;
        return;
      }
      const txns = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      $('#ih-count').textContent = txns.length;
      const totalOut = txns.reduce((s, t) => {
        const isOut = t.type === 'scan-out' || (t.type === 'adjust' && t.direction === 'out');
        const isTransferOut = t.type === 'transfer' && t.from === LOC_BUILDING;
        return (isOut || isTransferOut) ? s + (t.qtyOut || 0) : s;
      }, 0);
      $('#ih-total-out').textContent = totalOut;

      list.innerHTML = txns.map(t => {
        const ts = t.timestamp?.toDate?.() || new Date();
        const tsStr = ts.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const isOut = t.type === 'scan-out' || t.type === 'adjust' && t.direction === 'out';
        const isIn = t.type === 'transfer' && t.to === LOC_BUILDING;
        const isTransferOut = t.type === 'transfer' && t.from === LOC_BUILDING;
        const color = (isOut || isTransferOut) ? 'text-red-600' : 'text-emerald-600';
        const icon = (isOut || isTransferOut) ? '−' : '+';
        const label = t.type === 'scan-out' ? 'Scan out' :
                      t.type === 'transfer' ? `Transfer ${t.from}→${t.to}` :
                      t.type === 'adjust' ? `Adjust (${t.direction})` : t.type;
        const remaining = t.remainingBuilding ?? t.remainingMap?.[LOC_BUILDING] ?? '?';
        const source = t.source === 'guest-checkout' ? ' · Guest' : '';
        return `
          <div class="flex items-start justify-between p-3 rounded-xl bg-gray-50/80 dark:bg-surface-700/40 border border-gray-200 dark:border-gray-700/50">
            <div class="flex-1">
              <div class="flex items-center gap-2">
                <span class="font-mono text-xs font-semibold text-accent">${esc(t.sku || '—')}</span>
                <span class="text-xs text-gray-500 dark:text-gray-400">${esc(label)}${source}</span>
              </div>
              <p class="text-xs text-gray-500 mt-0.5">
                Remaining bldg: <span class="font-semibold">${remaining}</span> ·
                by <span class="font-medium">${esc(t.user || '?')}</span>
              </p>
            </div>
            <div class="text-right shrink-0 ml-3">
              <p class="font-bold ${color}">${icon}${t.qtyOut || 0}</p>
              <p class="text-xs text-gray-400">${tsStr}</p>
            </div>
          </div>`;
      }).join('');
    } catch (err) {
      console.error('Item history load failed:', err);
      list.innerHTML = '<p class="text-center text-red-500 py-6">Failed to load. The Firestore index may still be building — try again in a minute.</p>';
    }
  }

  // ═══════════════════════════════════════════════════════
  //  LOCATIONS MANAGER UI
  // ═══════════════════════════════════════════════════════

  function openLocationsModal() {
    openModal($('#modal-locations'));
    renderLocationsList();
  }

  function renderLocationsList() {
    const list = $('#locations-list');
    if (!list) return;
    const locs = State.locations;
    if (!locs.length) {
      list.innerHTML = '<p class="text-center text-gray-400 py-6">No locations defined. Core locations (Main Depot, Company Building) will be seeded automatically.</p>';
      return;
    }
    list.innerHTML = locs.map(l => {
      const isCore = (l.id === LOC_DEPOT || l.id === LOC_BUILDING);
      const total = State.items.reduce((s, i) => s + locStock(i, l.id), 0);
      return `
        <div class="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-surface-700/40 border border-gray-200 dark:border-gray-700">
          <div>
            <p class="font-semibold text-sm">${esc(l.name)}</p>
            <p class="text-xs text-gray-500">${total.toLocaleString()} total units across all SKUs</p>
          </div>
          ${isCore
            ? '<span class="text-[10px] text-gray-400 dark:text-gray-600 font-semibold uppercase bg-gray-200 dark:bg-gray-700 px-2 py-0.5 rounded-full">Core</span>'
            : `<button data-delete-loc="${esc(l.id)}" class="p-1.5 rounded-lg hover:bg-red-500/10 text-red-500 transition" title="Delete">
                 <svg class="w-4 h-4 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
               </button>`}
        </div>`;
    }).join('');
  }

  // ═══════════════════════════════════════════════════════
  //  TRANSFER MODAL UI
  // ═══════════════════════════════════════════════════════

  function openTransferModal(item) {
    State.transferItem = item;
    $('#transfer-item-sku').textContent = item.sku;
    $('#transfer-item-name').textContent = item.name;

    // Populate location dropdowns
    const locs = State.locations;
    const opts = locs.map(l => `<option value="${esc(l.id)}">${esc(l.name)} (${locStock(item, l.id)} available)</option>`).join('');
    $('#transfer-from').innerHTML = opts;
    $('#transfer-to').innerHTML = opts;
    // Default: from the first location that has stock, or the first overall
    const firstWithStock = locs.find(l => locStock(item, l.id) > 0);
    if (firstWithStock) $('#transfer-from').value = firstWithStock.id;
    $('#transfer-to').value = locs.length > 1 ? locs[1].id : locs[0]?.id || '';
    $('#transfer-qty').value = 1;
    updateTransferAvail();
    openModal($('#modal-transfer'));
  }

  function updateTransferAvail() {
    const item = State.transferItem;
    if (!item) return;
    const from = $('#transfer-from')?.value || '';
    const qty = parseInt($('#transfer-qty')?.value, 10) || 1;
    const avail = locStock(item, from);
    $('#transfer-avail-text').textContent = `Available at source: ${avail}. ${qty > avail ? 'WARNING: exceeds stock!' : ''}`;
    $('#transfer-avail-text').classList.toggle('text-red-500', qty > avail);
    $('#transfer-confirm').disabled = qty > avail;
  }

  // ═══════════════════════════════════════════════════════
  //  MULTI-FORMAT IMPORT / EXPORT
  // ═══════════════════════════════════════════════════════

  // ─── Unified column mapper ───
  function mapColumns(headers) {
    const colMap = {};
    headers.forEach((h, i) => {
      const hh = String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      if (['sku', 'itemcode', 'code', 'productcode', 'stockcode', 'partno', 'partnumber', 'articlenumber'].includes(hh)) colMap.sku = i;
      else if (['name', 'itemname', 'productname', 'description', 'item', 'itemdescription', 'desc'].includes(hh)) colMap.name = i;
      else if (['category', 'cat', 'group', 'type', 'productgroup', 'itemgroup'].includes(hh)) colMap.category = i;
      else if (['datasheeturl', 'datasheet', 'url', 'link', 'producturl', 'productlink', 'specsheet', 'productpage'].includes(hh)) colMap.datasheetUrl = i;
      else if (['totalstock', 'total', 'qty', 'quantity', 'stockqty', 'onhand', 'qtyonhand', 'stockonhand', 'available'].includes(hh)) colMap.totalStock = i;
      else if (['buildingstock', 'building', 'bldgstock', 'sitestock', 'localstock', 'buildingqty'].includes(hh)) colMap.buildingStock = i;
      else if (['bincode', 'bin', 'binlocation', 'shelf', 'shelfcode', 'location', 'storagelocation'].includes(hh)) colMap.binCode = i;
      else if (['carriertrigger', 'carrier', 'carriermin', 'mintransfer', 'transfermin'].includes(hh)) colMap.carrierTrigger = i;
      else if (['maxcapacity', 'max', 'maxbuilding', 'maxbldg', 'capacity', 'maxqty'].includes(hh)) colMap.maxCapacity = i;
      else if (['purchasingtrigger', 'purchasing', 'reorder', 'reorderlevel', 'minstock', 'reorderpoint'].includes(hh)) colMap.purchasingTrigger = i;
    });
    return colMap;
  }

  function rowToItem(cols, colMap) {
    const parseNum = (val, def) => {
      const n = parseInt(val, 10);
      return isNaN(n) ? def : n;
    };
    
    const buildingStock = parseNum(cols[colMap.buildingStock], 0);
    const totalStock = parseNum(cols[colMap.totalStock], 0);
    const depotStock = Math.max(0, totalStock - buildingStock);
    
    const locationStock = { [LOC_DEPOT]: depotStock };
    const rawBins = String(cols[colMap.binCode] ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    
    if (rawBins.length > 0) {
      const perBin = Math.floor(buildingStock / rawBins.length);
      const remainder = buildingStock % rawBins.length;
      rawBins.forEach((b, idx) => {
        locationStock[b] = perBin + (idx === 0 ? remainder : 0);
      });
    } else {
      locationStock[LOC_BUILDING] = buildingStock;
    }

    return {
      sku:               String(cols[colMap.sku] ?? '').trim(),
      name:              String(cols[colMap.name] ?? '').trim(),
      category:          String(cols[colMap.category] ?? '').trim(),
      datasheetUrl:      String(cols[colMap.datasheetUrl] ?? '').trim(),
      totalStock:        totalStock,
      buildingStock:     buildingStock,
      carrierTrigger:    parseNum(cols[colMap.carrierTrigger], 5),
      maxCapacity:       parseNum(cols[colMap.maxCapacity], 20),
      purchasingTrigger: parseNum(cols[colMap.purchasingTrigger], 10),
      locationStock:     locationStock
    };
  }

  // ─── CSV / TSV Extractor ───
  function extractDelimited(text, forceDelimiter) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return null;

    const headerLine = lines[0];
    const delimiter = forceDelimiter || (headerLine.includes('\t') ? '\t' : ',');
    const headers = headerLine.split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));

    const rows = lines.slice(1).map(line => parseDelimitedLine(line, delimiter));
    return { headers, rows };
  }

  function parseDelimitedLine(line, delimiter) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { current += '"'; i++; }
          else inQuotes = false;
        } else { current += ch; }
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === delimiter) { result.push(current); current = ''; }
        else current += ch;
      }
    }
    result.push(current);
    return result;
  }

  // ─── JSON Extractor ───
  function extractJSON(text) {
    try {
      let data = JSON.parse(text);
      if (!Array.isArray(data)) {
        const keys = Object.keys(data);
        const arrKey = keys.find(k => Array.isArray(data[k]));
        if (arrKey) data = data[arrKey];
        else return null;
      }
      if (data.length === 0) return null;
      const headersSet = new Set();
      data.forEach(obj => Object.keys(obj).forEach(k => headersSet.add(k)));
      const headers = Array.from(headersSet);
      const rows = data.map(obj => headers.map(h => String(obj[h] ?? '')));
      return { headers, rows };
    } catch {
      return null;
    }
  }

  // ─── File Handler ───
  const ACCEPT_MAP = {
    csv:   '.csv',
    tsv:   '.tsv,.txt',
    json:  '.json',
    excel: '.xlsx,.xls',
  };

  const DROP_TEXT_MAP = {
    csv:   'Drag & drop a <strong>.csv</strong> file here, or <span class="text-accent font-semibold cursor-pointer underline">click to browse</span>',
    tsv:   'Drag & drop a <strong>.tsv</strong> or <strong>.txt</strong> file here, or <span class="text-accent font-semibold cursor-pointer underline">click to browse</span>',
    json:  'Drag & drop a <strong>.json</strong> file here, or <span class="text-accent font-semibold cursor-pointer underline">click to browse</span>',
    excel: 'Drag & drop an <strong>.xlsx</strong> or <strong>.xls</strong> file here, or <span class="text-accent font-semibold cursor-pointer underline">click to browse</span>',
  };

  function setImportFormat(format) {
    State.importFormat = format;
    $$('.import-tab').forEach(t => t.classList.toggle('active', t.dataset.format === format));
    $$('.import-help').forEach(h => h.classList.add('hidden'));
    const help = $(`#import-help-${format}`);
    if (help) help.classList.remove('hidden');
    dom.importFileInput.setAttribute('accept', ACCEPT_MAP[format] || '*');
    dom.importDropText.innerHTML = DROP_TEXT_MAP[format] || DROP_TEXT_MAP.csv;
    resetImportPreview();
  }

  function handleImportFile(file) {
    if (!file) return;

    const ext = file.name.split('.').pop().toLowerCase();
    const format = State.importFormat;

    // Auto-detect format from extension if mismatch
    let effectiveFormat = format;
    if (['xlsx', 'xls'].includes(ext)) effectiveFormat = 'excel';
    else if (ext === 'json') effectiveFormat = 'json';
    else if (ext === 'tsv') effectiveFormat = 'tsv';
    else if (ext === 'csv') effectiveFormat = 'csv';

    if (effectiveFormat !== format) setImportFormat(effectiveFormat);

    const reader = new FileReader();
    reader.onload = (e) => {
      let extracted = null;
      if (effectiveFormat === 'excel') {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          if (data.length >= 2) extracted = { headers: data[0].map(String), rows: data.slice(1) };
        } catch {}
      } else {
        if (effectiveFormat === 'json') extracted = extractJSON(e.target.result);
        else if (effectiveFormat === 'tsv') extracted = extractDelimited(e.target.result, '\t');
        else extracted = extractDelimited(e.target.result);
      }

      if (!extracted || !extracted.headers.length || !extracted.rows.length) { 
        toast('No valid data found. Check file format and headers.', 'error'); 
        return; 
      }
      showColumnMapping(extracted.headers, extracted.rows);
    };

    if (effectiveFormat === 'excel') reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  }

  const IMPORT_FIELDS = [
    { id: 'sku', label: 'SKU' },
    { id: 'name', label: 'Item Name' },
    { id: 'category', label: 'Category' },
    { id: 'datasheetUrl', label: 'Datasheet URL' },
    { id: 'totalStock', label: 'Total Stock' },
    { id: 'buildingStock', label: 'Building Stock' },
    { id: 'carrierTrigger', label: 'Carrier Trigger' },
    { id: 'maxCapacity', label: 'Max Capacity' },
    { id: 'purchasingTrigger', label: 'Purch. Trigger' }
  ];

  function showColumnMapping(headers, rows) {
    State.importRawHeaders = headers;
    State.importRawData = rows;
    
    // Attempt auto-mapping
    const autoMap = mapColumns(headers);
    
    // Populate dropdowns
    IMPORT_FIELDS.forEach(field => {
      const select = $(`#map-${field.id}`);
      if (!select) return;
      select.innerHTML = '<option value="-1">-- Skip / Default --</option>' + 
        headers.map((h, i) => `<option value="${i}">${esc(h)}</option>`).join('');
      if (autoMap[field.id] !== undefined) select.value = autoMap[field.id];
      else select.value = '-1';
    });
    
    dom.importDropZone.classList.add('hidden');
    dom.importMapping.classList.remove('hidden');
  }

  function applyMapping() {
    const colMap = {};
    IMPORT_FIELDS.forEach(field => {
      const select = $(`#map-${field.id}`);
      if (select) {
        const val = parseInt(select.value, 10);
        if (val >= 0) colMap[field.id] = val;
      }
    });
    
    if (colMap.sku === undefined && colMap.name === undefined) {
      toast('You must map at least SKU or Name', 'error');
      return;
    }
    
    const parsed = State.importRawData.map(row => rowToItem(row, colMap)).filter(i => i.sku || i.name);
    
    dom.importMapping.classList.add('hidden');
    showImportPreview(parsed);
  }

  function showImportPreview(parsed) {
    State.importParsedData = parsed;
    dom.importPreviewCount.textContent = parsed.length;
    dom.importPreviewBody.innerHTML = parsed.slice(0, 10).map(i =>
      `<tr class="border-b border-gray-100 dark:border-gray-700/50">
        <td class="px-2 py-1 font-mono">${esc(i.sku)}</td>
        <td class="px-2 py-1">${esc(i.name)}</td>
        <td class="px-2 py-1">${esc(i.category)}</td>
        <td class="px-2 py-1 text-right">${i.totalStock}</td>
        <td class="px-2 py-1 text-right">${i.buildingStock}</td>
      </tr>`
    ).join('') + (parsed.length > 10 ? '<tr><td colspan="5" class="px-2 py-1 text-center text-gray-400">…and more</td></tr>' : '');
    dom.importPreview.classList.remove('hidden');
    dom.btnImportConfirm.disabled = false;
  }

  function confirmImport() {
    if (!State.importParsedData.length) return;

    const mode = document.querySelector('input[name="import-mode"]:checked')?.value || 'merge';

    if (mode === 'replace') {
      const oldIds = State.items.map(i => i.id);
      State.items = State.importParsedData.map(d => ({ id: DAL.generateId(), ...d }));
      DAL.deleteMany(oldIds);
      DAL.saveMany(State.items);
      closeModal(dom.modalImport);
      resetImportModal();
      applyFilters();
      renderDashboard();
      populateCategoryFilter();
      toast(`Replaced with ${State.items.length} items`, 'success');
      return;
    }

    // Merge mode
    const newItems = State.importParsedData.map(d => ({ id: DAL.generateId(), ...d }));
    const toWrite = [];
    let updated = 0, added = 0;
    newItems.forEach(ni => {
      const existing = State.items.find(i => 
        (ni.sku && i.sku && i.sku.toLowerCase() === ni.sku.toLowerCase()) || 
        (!ni.sku && i.name && ni.name && i.name.toLowerCase() === ni.name.toLowerCase())
      );
      if (existing) {
        Object.assign(existing, { ...ni, id: existing.id });
        toWrite.push(existing);
        updated++;
      } else {
        State.items.push(ni);
        toWrite.push(ni);
        added++;
      }
    });

    DAL.saveMany(toWrite);
    closeModal(dom.modalImport);
    resetImportModal();
    applyFilters();
    renderDashboard();
    populateCategoryFilter();
    toast(`Imported: ${added} new, ${updated} updated`, 'success');
  }

  function resetImportPreview() {
    State.importParsedData = [];
    State.importRawHeaders = [];
    State.importRawData = [];
    dom.importPreview.classList.add('hidden');
    dom.importMapping.classList.add('hidden');
    dom.importDropZone.classList.remove('hidden');
    dom.importPreviewBody.innerHTML = '';
    dom.btnImportConfirm.disabled = true;
  }

  function resetImportModal() {
    resetImportPreview();
    dom.importFileInput.value = '';
  }

  function exportCSV() {
    const headers = ['sku','name','category','binCode','datasheetUrl','totalStock','buildingStock','carrierTrigger','maxCapacity','purchasingTrigger','locationStock'];
    const rows = State.items.map(i =>
      headers.map(h => {
        const val = h === 'locationStock'
          ? JSON.stringify(i.locationStock || {})
          : i[h];
        return `"${String(val ?? '').replace(/"/g, '""')}"`;
      }).join(',')
    );
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shadow_ledger_export_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('CSV exported successfully', 'success');
  }

  // ═══════════════════════════════════════════════════════
  //  EVENT BINDINGS
  // ═══════════════════════════════════════════════════════
  function bindEvents() {
    // Theme
    $('#btn-theme').addEventListener('click', toggleTheme);

    // Search & Filters
    dom.searchInput.addEventListener('input', debounce(applyFilters, 200));
    dom.categorySelect.addEventListener('change', applyFilters);
    dom.alertSelect.addEventListener('change', applyFilters);
    dom.filterStock.addEventListener('change', applyFilters);

    // Archive Toggle
    dom.btnToggleArchive.addEventListener('click', () => {
      State.viewMode = State.viewMode === 'active' ? 'archive' : 'active';
      dom.btnToggleArchive.classList.toggle('text-accent', State.viewMode === 'archive');
      dom.btnToggleArchive.classList.toggle('bg-accent/10', State.viewMode === 'archive');
      
      State.selectedIds.clear();
      applyFilters();
    });

    // Check All Checkbox
    dom.checkAll.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      const start = (State.currentPage - 1) * PAGE_SIZE;
      const page  = State.filteredItems.slice(start, start + PAGE_SIZE);
      
      page.forEach(item => {
        if (isChecked) State.selectedIds.add(item.id);
        else State.selectedIds.delete(item.id);
      });
      renderTable();
    });

    // Bulk Archive
    dom.btnBulkArchive.addEventListener('click', () => {
      const toArchive = State.items.filter(i => State.selectedIds.has(i.id));
      toArchive.forEach(i => { i.archived = true; });
      State.selectedIds.clear();
      DAL.saveMany(toArchive);
      applyFilters();
      renderDashboard();
      toast('Selected items archived', 'success');
    });

    // Bulk Print
    dom.btnBulkPrint.addEventListener('click', () => {
      const itemsToPrint = State.items.filter(i => State.selectedIds.has(i.id));
      printLabels(itemsToPrint);
      State.selectedIds.clear();
      renderTable();
    });

    // Bulk Restore
    dom.btnBulkRestore.addEventListener('click', () => {
      const toRestore = State.items.filter(i => State.selectedIds.has(i.id));
      toRestore.forEach(i => { i.archived = false; });
      State.selectedIds.clear();
      DAL.saveMany(toRestore);
      applyFilters();
      renderDashboard();
      toast('Selected items restored', 'success');
    });

    // Bulk Delete
    dom.btnBulkDelete.addEventListener('click', async () => {
      const count = State.selectedIds.size;
      const ok = await confirmDialog({
        title: `Delete ${count} items?`,
        message: `This cannot be undone. ${count} item${count === 1 ? '' : 's'} will be permanently removed from Firestore.`,
        confirmText: 'Delete all',
        danger: true
      });
      if (!ok) return;
      const ids = [...State.selectedIds];
      State.items = State.items.filter(i => !State.selectedIds.has(i.id));
      State.selectedIds.clear();
      DAL.deleteMany(ids);
      applyFilters();
      renderDashboard();
      populateCategoryFilter();
      toast('Selected items deleted', 'info');
    });

    // Logout
    dom.btnLogout.addEventListener('click', () => auth.signOut());

    // Sort headers
    $$('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (State.sortField === field) State.sortAsc = !State.sortAsc;
        else { State.sortField = field; State.sortAsc = true; }
        applyFilters();
      });
    });

    // Pagination
    dom.btnPrev.addEventListener('click', () => { if (State.currentPage > 1) { State.currentPage--; renderTable(); } });
    dom.btnNext.addEventListener('click', () => { State.currentPage++; renderTable(); });

    // Table delegation — KEYBOARD-FRIENDLY inline edits
    // Use 'input' event with debounce for live typing, save silently to preserve focus
    const debouncedSave = debounce((id, field, value) => {
      saveFieldSilently(id, field, value);
    }, 400);

    dom.tableBody.addEventListener('input', (e) => {
      const input = e.target;
      if (input.tagName === 'INPUT' && input.dataset.field && input.dataset.id) {
        debouncedSave(input.dataset.id, input.dataset.field, input.value);
      }
    });

    // Also handle blur for final commit
    dom.tableBody.addEventListener('focusout', (e) => {
      const input = e.target;
      if (input.tagName === 'INPUT' && input.dataset.field && input.dataset.id) {
        saveFieldSilently(input.dataset.id, input.dataset.field, input.value);
      }
    });

    // Handle Enter key — move to next input in the row or blur
    dom.tableBody.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault();
        const inputs = Array.from(e.target.closest('tr').querySelectorAll('input.inline-input'));
        const idx = inputs.indexOf(e.target);
        if (idx < inputs.length - 1) {
          inputs[idx + 1].focus();
          inputs[idx + 1].select();
        } else {
          e.target.blur();
        }
      }
      // Tab should work naturally — browser handles it
    });

    // Select all text on focus for easy overwrite
    dom.tableBody.addEventListener('focus', (e) => {
      if (e.target.tagName === 'INPUT' && e.target.classList.contains('inline-input')) {
        setTimeout(() => e.target.select(), 0);
      }
    }, true); // use capture for focus events

    dom.tableBody.addEventListener('click', (e) => {
      // Row checkboxes
      if (e.target.classList.contains('row-checkbox')) {
        const id = e.target.dataset.id;
        if (e.target.checked) State.selectedIds.add(id);
        else State.selectedIds.delete(id);
        updateBulkActions();
        
        const start = (State.currentPage - 1) * PAGE_SIZE;
        const page  = State.filteredItems.slice(start, start + PAGE_SIZE);
        const pageIds = page.map(i => i.id);
        dom.checkAll.checked = pageIds.length > 0 && pageIds.every(pid => State.selectedIds.has(pid));
        return;
      }

      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const { action, id } = btn.dataset;
      if (action === 'inc')    adjustStock(id, 1);
      if (action === 'dec')    adjustStock(id, -1);
      if (action === 'edit')   openItemModal(State.items.find(i => i.id === id));
      if (action === 'print')  printLabels([State.items.find(i => i.id === id)]);
      if (action === 'transfer') openTransferModal(State.items.find(i => i.id === id));
      if (action === 'delete') deleteItem(id);
      if (action === 'history') openItemHistory(State.items.find(i => i.id === id));
    });

    // Add Item
    $('#btn-add-item').addEventListener('click', () => openItemModal());

    // Item Form
    dom.formItem.addEventListener('submit', (e) => {
      e.preventDefault();
      const wasEditing = !!State.editingId;
      const item = saveItem({
        sku:               $('#field-sku').value.trim(),
        name:              $('#field-name').value.trim(),
        category:          $('#field-category').value.trim(),
        datasheetUrl:      $('#field-datasheetUrl').value.trim(),
        totalStock:        parseInt($('#field-totalStock').value, 10) || 0,
        buildingStock:     parseInt($('#field-buildingStock').value, 10) || 0,
        carrierTrigger:    parseInt($('#field-carrierTrigger').value, 10) || 5,
        maxCapacity:       parseInt($('#field-maxCapacity').value, 10) || 20,
        purchasingTrigger: parseInt($('#field-purchasingTrigger').value, 10) || 10,
        binCode:           $('#field-binCode')?.value.trim() || '',
      });
      Promise.resolve(item).then(() => {
        closeModal(dom.modalItem);
        toast(wasEditing ? 'Item updated ✓' : 'Item added ✓', 'success');
      }).catch(() => {
        // saveOne already toasted the specific error; keep modal open so the user can retry
      });
    });

    // Modal closes
    $('#modal-item-close').addEventListener('click', () => closeModal(dom.modalItem));
    $('#btn-cancel-item').addEventListener('click', () => closeModal(dom.modalItem));
    
    // Import flow buttons
    dom.btnImportMappingConfirm.addEventListener('click', applyMapping);
    dom.btnImportMappingCancel.addEventListener('click', () => { closeModal(dom.modalImport); resetImportModal(); });
    $('#modal-import-close').addEventListener('click', () => { closeModal(dom.modalImport); resetImportModal(); });
    $('#btn-import-cancel').addEventListener('click', () => { closeModal(dom.modalImport); resetImportModal(); });
    
    $('#modal-manifest-close').addEventListener('click', () => closeModal(dom.modalManifest));
    $('#modal-alerts-close').addEventListener('click', () => closeModal(dom.modalAlerts));
    $('#modal-sku-search-close').addEventListener('click', () => closeModal(dom.modalSkuSearch));
    $('#btn-sku-search-cancel').addEventListener('click', () => closeModal(dom.modalSkuSearch));

    // Close modals on overlay click (includes new modals)
    [dom.modalItem, dom.modalImport, dom.modalManifest, dom.modalAlerts, $('#modal-labelgen'), $('#modal-scanout'), $('#modal-history'), $('#modal-item-history'), dom.modalBins, dom.modalPareto, dom.modalSkuSearch].forEach(modal => {
      if (!modal) return;
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          // Stop camera if closing scan-out modal
          if (modal.id === 'modal-scanout') stopScanCamera();
          closeModal(modal);
        }
      });
    });

    // Close modals on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        [dom.modalItem, dom.modalImport, dom.modalManifest, dom.modalAlerts, $('#modal-labelgen'), $('#modal-scanout'), $('#modal-history'), $('#modal-item-history'), dom.modalBins, dom.modalPareto].forEach(m => {
          if (m && !m.classList.contains('hidden')) {
            if (m.id === 'modal-scanout') stopScanCamera();
            closeModal(m);
          }
        });
      }
    });

    // Import modal
    $('#btn-import').addEventListener('click', () => { setImportFormat('csv'); openModal(dom.modalImport); });

    // Import format tabs
    $$('.import-tab').forEach(tab => {
      tab.addEventListener('click', () => setImportFormat(tab.dataset.format));
    });

    // File input
    dom.importDropZone.addEventListener('click', () => dom.importFileInput.click());
    dom.importFileInput.addEventListener('change', (e) => handleImportFile(e.target.files[0]));
    dom.importDropZone.addEventListener('dragover', (e) => { e.preventDefault(); dom.importDropZone.classList.add('border-accent'); });
    dom.importDropZone.addEventListener('dragleave', () => dom.importDropZone.classList.remove('border-accent'));
    dom.importDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dom.importDropZone.classList.remove('border-accent');
      handleImportFile(e.dataTransfer.files[0]);
    });
    dom.btnImportConfirm.addEventListener('click', confirmImport);

    // Export
    $('#btn-export-csv').addEventListener('click', exportCSV);

    // Manifest
    $('#btn-manifest').addEventListener('click', generateManifest);
    $('#btn-pick-sheet').addEventListener('click', generatePickSheet);
    $('#btn-3d-route').addEventListener('click', () => {
      if (State.selectedIds.size === 0) return toast('Select at least one item to route', 'error');
      const ids = Array.from(State.selectedIds).join(',');
      window.open(`warehouse-3d.html?route=${ids}`, '_blank');
    });
    $('#btn-manifest-print').addEventListener('click', () => {
      const printWin = window.open('', '_blank', 'width=700,height=900');
      printWin.document.write(`<!DOCTYPE html><html><head><title>Carrier Manifest</title>
        <style>body{font-family:'Courier New',monospace;padding:24px;font-size:13px;line-height:1.6}
        table{width:100%;border-collapse:collapse}th,td{padding:4px 8px;text-align:left;border-bottom:1px solid #ddd}
        th{border-bottom:2px solid #333;font-weight:bold}.text-right{text-align:right}.font-bold{font-weight:bold}
        .text-red-500{color:#ef4444}</style></head><body>${dom.manifestContent.innerHTML}</body></html>`);
      printWin.document.close();
      printWin.print();
    });
    $('#btn-manifest-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(getManifestText()).then(() => toast('Manifest copied to clipboard', 'success'));
    });

    // Dashboard card clicks → alert detail
    $('#card-carrier').addEventListener('click', () => openAlertDetail('carrier'));
    $('#card-procure').addEventListener('click', () => openAlertDetail('procure'));

    // Keyboard accessibility for dashboard cards (role="button" must be keyboard-activatable)
    const makeCardKeyboardButton = (el, handler) => {
      if (!el) return;
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handler();
        }
      });
    };
    makeCardKeyboardButton($('#card-carrier'), () => openAlertDetail('carrier'));
    makeCardKeyboardButton($('#card-procure'), () => openAlertDetail('procure'));

    // Global Barcode Scanner Listener & Numpad Shortcuts
    let barcodeBuffer = '';
    let barcodeTimer = null;
    const BARCODE_IDLE_MS = 250; // forgiving timeout for slower scanners
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        if (e.target.classList.contains('inline-input') && e.target.dataset.id && e.target.dataset.field === 'buildingStock') {
          if (e.key === '+') {
            e.preventDefault();
            adjustStock(e.target.dataset.id, 1);
          } else if (e.key === '-') {
            e.preventDefault();
            adjustStock(e.target.dataset.id, -1);
          }
        }
        return;
      }
      
      if (e.key.length === 1) {
        barcodeBuffer += e.key;
        clearTimeout(barcodeTimer);
        barcodeTimer = setTimeout(() => { barcodeBuffer = ''; }, BARCODE_IDLE_MS);
      } else if (e.key === 'Enter' && barcodeBuffer.length > 2) {
        const scannedSku = barcodeBuffer.toUpperCase();
        barcodeBuffer = '';
        
        const item = State.items.find(i => i.sku.toUpperCase() === scannedSku && !i.archived);
        if (item) {
          const input = dom.tableBody.querySelector(`input[data-id="${item.id}"][data-field="buildingStock"]`);
          if (input) {
            input.focus();
            input.select();
            toast('Scanned: ' + item.sku, 'info');
          } else {
            dom.searchInput.value = scannedSku;
            applyFilters();
            setTimeout(() => {
              const newInput = dom.tableBody.querySelector(`input[data-id="${item.id}"][data-field="buildingStock"]`);
              if (newInput) {
                newInput.focus();
                newInput.select();
              }
            }, 50);
            toast('Filtered to: ' + item.sku, 'info');
          }
        } else {
          toast('Barcode not found: ' + scannedSku, 'error');
        }
      }
    });

    // ═══════════════════════════════════════════════════════
    //  LABEL GENERATOR EVENTS
    // ═══════════════════════════════════════════════════════
    $('#btn-labelgen').addEventListener('click', openLabelGen);
    $('#modal-labelgen-close').addEventListener('click', () => closeModal($('#modal-labelgen')));

    // Logo upload
    $('#labelgen-logo-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        setSavedLogo(ev.target.result);
        renderLogoPreview();
        renderLabelGenPreview();
      };
      reader.readAsDataURL(file);
    });
    $('#labelgen-logo-clear').addEventListener('click', () => {
      { try { localStorage.removeItem(LG_LOGO_KEY); } catch {} }
      renderLogoPreview();
      renderLabelGenPreview();
    });

    // Size change → show/hide custom dims + re-preview
    $('#labelgen-size').addEventListener('change', () => {
      $('#labelgen-custom-dims').classList.toggle('hidden', $('#labelgen-size').value !== 'custom');
      renderLabelGenPreview();
    });
    $('#labelgen-w').addEventListener('input', renderLabelGenPreview);
    $('#labelgen-h').addEventListener('input', renderLabelGenPreview);

    // Source change → enable/disable single item picker
    $$('input[name="labelgen-source"]').forEach(r => {
      r.addEventListener('change', () => {
        $('#labelgen-single').classList.toggle('hidden', document.querySelector('input[name="labelgen-source"]:checked')?.value !== 'single');
        renderLabelGenPreview();
      });
    });

    // Item picker change → auto-fill override fields
    $('#labelgen-item').addEventListener('change', () => {
      const item = State.items.find(i => i.sku === $('#labelgen-item').value);
      if (item) {
        if (!$('#labelgen-sku').value) $('#labelgen-sku').value = item.sku;
        if (!$('#labelgen-name').value) $('#labelgen-name').value = item.name;
      }
      renderLabelGenPreview();
    });

    // Override fields
    $('#labelgen-sku').addEventListener('input', renderLabelGenPreview);
    $('#labelgen-name').addEventListener('input', renderLabelGenPreview);
    $('#labelgen-extra').addEventListener('input', renderLabelGenPreview);

    // QR source
    $('#labelgen-qr-source').addEventListener('change', () => {
      $('#labelgen-qr-custom').classList.toggle('hidden', $('#labelgen-qr-source').value !== 'custom');
      renderLabelGenPreview();
    });
    $('#labelgen-qr-custom').addEventListener('input', renderLabelGenPreview);

    // Print & clear
    $('#btn-labelgen-print').addEventListener('click', generateLabels);
    $('#btn-labelgen-clear').addEventListener('click', () => {
      $('#labelgen-sku').value = '';
      $('#labelgen-name').value = '';
      $('#labelgen-extra').value = '';
      $('#labelgen-qr-source').value = 'sku';
      $('#labelgen-qr-custom').classList.add('hidden');
      renderLabelGenPreview();
    });

    // ═══════════════════════════════════════════════════════
    //  SCAN OUT EVENTS
    // ═══════════════════════════════════════════════════════
    $('#btn-scan-out').addEventListener('click', () => {
      resetScanOut();
      openModal($('#modal-scanout'));
      // Start camera after modal is visible (DOM ready)
      setTimeout(startScanCamera, 300);
    });
    $('#modal-scanout-close').addEventListener('click', () => {
      stopScanCamera();
      closeModal($('#modal-scanout'));
      ScanOut.capturedItem = null;
    });

    // Camera toggle
    $('#scanout-camera-toggle').addEventListener('click', () => {
      if (ScanOut.stream) stopScanCamera();
      else startScanCamera();
    });

    // Manual SKU entry
    const lookupManualSku = () => {
      const sku = $('#scanout-manual-sku').value.trim().toUpperCase();
      if (!sku) return;
      const item = State.items.find(i => i.sku && i.sku.toUpperCase() === sku && !i.archived);
      if (!item) {
        $('#scanout-error').textContent = `No matching item for "${sku}". Check the spelling.`;
        $('#scanout-error').classList.remove('hidden');
        return;
      }
      stopScanCamera();
      showScanOutStep2(item);
    };
    $('#scanout-manual-sku').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        lookupManualSku();
      }
    });
    $('#scanout-manual-go').addEventListener('click', lookupManualSku);

    // Location verification
    $('#scanout-location-go').addEventListener('click', () => {
      const val = $('#scanout-location-input').value.trim().toUpperCase();
      if (val) verifyScanOutLocation(val);
    });
    $('#scanout-location-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = $('#scanout-location-input').value.trim().toUpperCase();
        if (val) verifyScanOutLocation(val);
      }
    });

    // Qty adjustments
    $('#scanout-qty').addEventListener('input', () => {
      const val = parseInt($('#scanout-qty').value, 10);
      if (isNaN(val) || val < 1) $('#scanout-qty').value = 1;
      updateScanOutNewStock();
    });
    $('#scanout-qty-dec').addEventListener('click', () => {
      let v = parseInt($('#scanout-qty').value, 10) || 1;
      if (v > 1) $('#scanout-qty').value = v - 1;
      updateScanOutNewStock();
    });
    $('#scanout-qty-inc').addEventListener('click', () => {
      let v = parseInt($('#scanout-qty').value, 10) || 1;
      $('#scanout-qty').value = v + 1;
      updateScanOutNewStock();
    });

    // Confirm / cancel
    $('#scanout-confirm').addEventListener('click', confirmScanOut);
    $('#scanout-cancel').addEventListener('click', () => {
      $('#scanout-step2').classList.add('hidden');
      $('#scanout-step1').classList.remove('hidden');
      ScanOut.capturedItem = null;
      startScanCamera();
    });
    $('#scanout-again').addEventListener('click', resetScanOut);

    // ═══════════════════════════════════════════════════════
    //  HISTORY
    // ═══════════════════════════════════════════════════════
    $('#btn-history').addEventListener('click', openHistory);
    $('#modal-history-close').addEventListener('click', () => closeModal($('#modal-history')));

    // ═══════════════════════════════════════════════════════
    //  PER-ITEM HISTORY
    // ═══════════════════════════════════════════════════════
    $('#modal-item-history-close').addEventListener('click', () => closeModal($('#modal-item-history')));
    // Double-click on a table row opens item history
    // (but ignore double-clicks inside inline input fields — user is selecting text)
    dom.tableBody.addEventListener('dblclick', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      const row = e.target.closest('tr[data-id]');
      if (!row) return;
      const item = State.items.find(i => i.id === row.dataset.id);
      if (item) openItemHistory(item);
    });

    // ═══════════════════════════════════════════════════════
    //  LOCATIONS MANAGER
    // ═══════════════════════════════════════════════════════
    $('#btn-locations').addEventListener('click', openLocationsModal);
    $('#modal-locations-close').addEventListener('click', () => closeModal($('#modal-locations')));

    // Add new location
    $('#add-location-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#new-location-name').value.trim();
      if (!name) return;
      await DAL.saveLocation({ name, order: Date.now() });
      $('#new-location-name').value = '';
      toast('Location added', 'success');
      // Locations list refreshed via onSnapshot
    });

    // Delete location (delegated on the list)
    $('#locations-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-delete-loc]');
      if (!btn) return;
      const locId = btn.dataset.deleteLoc;
      // Prevent deleting the 2 core locations
      if (locId === LOC_DEPOT || locId === LOC_BUILDING) {
        return toast('Cannot delete core locations (Main Depot, Company Building).', 'error');
      }
      DAL.deleteLocation(locId).catch(() => toast('Delete failed.', 'error'));
    });

    // ═══════════════════════════════════════════════════════
    //  TRANSFER MODAL
    // ═══════════════════════════════════════════════════════
    $('#modal-transfer-close').addEventListener('click', () => closeModal($('#modal-transfer')));
    $('#transfer-qty').addEventListener('input', updateTransferAvail);
    $('#transfer-from').addEventListener('change', updateTransferAvail);
    $('#transfer-qty-dec').addEventListener('click', () => {
      let v = parseInt($('#transfer-qty').value, 10) || 1;
      if (v > 1) $('#transfer-qty').value = v - 1;
      updateTransferAvail();
    });
    $('#transfer-qty-inc').addEventListener('click', () => {
      $('#transfer-qty').value = (parseInt($('#transfer-qty').value, 10) || 1) + 1;
      updateTransferAvail();
    });
    $('#transfer-confirm').addEventListener('click', async () => {
      const item = State.transferItem;
      if (!item) return;
      const from = $('#transfer-from').value;
      const to   = $('#transfer-to').value;
      const qty  = parseInt($('#transfer-qty').value, 10) || 1;
      if (!from || !to || from === to) return toast('Select different locations.', 'error');
      const fromStock = locStock(item, from);
      if (qty > fromStock) return toast(`Only ${fromStock} available at source.`, 'error');

      // Move stock
      const newLS = { ...(item.locationStock || {}) };
      newLS[from] = Math.max(0, (newLS[from] || 0) - qty);
      newLS[to]   = (newLS[to] || 0) + qty;
      item.locationStock = newLS;
      item.buildingStock = locStock(item, LOC_BUILDING);
      item.totalStock = totalStockFromLocs(item);
      await DAL.saveOne(item);

      // Log
      DAL.logTransaction({
        itemId: item.id, sku: item.sku, name: item.name,
        qtyOut: qty, type: 'transfer', from: from, to: to,
        remainingMap: newLS
      });

      closeModal($('#modal-transfer'));
      State.transferItem = null;
      applyFilters(); renderDashboard();
      toast(`Transferred ${qty} ${item.sku}`, 'success');
    });

    // ═══════════════════════════════════════════════════════
    //  LABEL GENERATOR — MULTI-SELECT SEARCH
    // ═══════════════════════════════════════════════════════
    // Override the old "item picker" with a searchable multi-select
    const labelSearchInput = document.createElement('input');
    labelSearchInput.type = 'text';
    labelSearchInput.placeholder = 'Search SKU or name… (click to add)';
    labelSearchInput.className = 'input-field w-full mt-2';
    const labelResults = document.createElement('div');
    labelResults.className = 'max-h-32 overflow-y-auto scrollbar-thin rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-surface-800 mt-1 hidden';

    // Move them into the DOM (if labelgen-single exists)
    const singleEl = $('#labelgen-single');
    if (singleEl) {
      singleEl.appendChild(labelSearchInput);
      singleEl.appendChild(labelResults);
    }

    // Search → dropdown
    const renderSearchResults = debounce(() => {
      const q = labelSearchInput.value.trim().toLowerCase();
      if (!q || q.length < 1) { labelResults.classList.add('hidden'); return; }
      const hits = State.items.filter(i =>
        i.sku.toLowerCase().includes(q) ||
        i.name.toLowerCase().includes(q)
      ).slice(0, 8);
      if (hits.length === 0) { labelResults.classList.add('hidden'); return; }
      labelResults.innerHTML = hits.map(i => `
        <div class="px-3 py-2 cursor-pointer hover:bg-blue-50 dark:hover:bg-surface-700/50 border-b border-gray-100 dark:border-gray-700/40 text-sm flex justify-between"
             data-add-sku="${esc(i.sku)}">
          <span class="font-mono text-accent">${esc(i.sku)}</span>
          <span class="truncate ml-3">${esc(i.name)}</span>
          ${State.labelGenSelected.has(i.sku) ? '<span class="text-green-500 ml-2">✓</span>' : '<span class="text-gray-400 ml-2">+</span>'}
        </div>`).join('');
      labelResults.classList.remove('hidden');
    }, 200);
    labelSearchInput.addEventListener('input', renderSearchResults);

    // Click → add / remove
    labelResults.addEventListener('click', (e) => {
      const row = e.target.closest('[data-add-sku]');
      if (!row) return;
      const sku = row.dataset.addSku;
      if (State.labelGenSelected.has(sku)) State.labelGenSelected.delete(sku);
      else State.labelGenSelected.add(sku);
      renderSearchResults();
      renderLabelGenMulti();
    });

    // Chip list (selected items)
    const chipBox = document.createElement('div');
    chipBox.className = 'flex flex-wrap gap-1 mt-2';
    chipBox.id = 'labelgen-chips';
    if (singleEl) singleEl.appendChild(chipBox);

    function renderLabelGenMulti() {
      const chips = $('#labelgen-chips');
      if (!chips) return;
      const selected = [...State.labelGenSelected].map(sku => State.items.find(i => i.sku === sku)).filter(Boolean);
      chips.innerHTML = selected.map(i => `
        <span class="inline-flex items-center gap-1 bg-accent/10 text-accent text-xs font-semibold px-2 py-1 rounded-full">
          ${esc(i.sku)}
          <button data-remove-sku="${esc(i.sku)}" class="ml-0.5 text-red-500 hover:text-red-700 font-bold">&times;</button>
        </span>`).join('')
        + (selected.length === 0 ? '<span class="text-xs text-gray-400 italic">No items selected — search above</span>' : '');
      // Update count
      const countEl = $('#labelgen-bulk-count');
      if (countEl) countEl.textContent = selected.length;
      // Auto-trigger preview
      renderLabelGenPreview();
    }

    // Remove chip
    chipBox.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove-sku]');
      if (!btn) return;
      State.labelGenSelected.delete(btn.dataset.removeSku);
      renderLabelGenMulti();
    });

    // Bulk count display next to the source radio
    const countSpan = document.createElement('span');
    countSpan.id = 'labelgen-bulk-count';
    countSpan.className = 'text-accent font-bold';
    const sourceDiv = $('[name="labelgen-source"]')?.parentElement?.parentElement;
    if (sourceDiv) sourceDiv.appendChild(countSpan);

    // Qty +/- button bindings
    const qtyInput = () => $('#labelgen-qty');
    const adjustQty = (delta) => {
      const el = qtyInput();
      if (!el) return;
      el.value = Math.max(1, Math.min(20, (parseInt(el.value, 10) || 1) + delta));
    };
    $('#labelgen-qty-dec')?.addEventListener('click', () => adjustQty(-1));
    $('#labelgen-qty-inc')?.addEventListener('click', () => adjustQty(1));

    // Print button for multi-select
    $('#btn-labelgen-print').addEventListener('click', () => {
      const source = document.querySelector('input[name="labelgen-source"]:checked')?.value || 'single';
      if (source === 'single') { generateLabels(); return; }
      // Bulk → use the chip set
      if (State.labelGenSelected.size === 0) return toast('Select items to label first', 'info');
      generateLabels();
    });

    // Make renderLabelGenPreview handle multi-select:
    // (override the old function with a wrapper)
    const origRenderPreview = renderLabelGenPreview;
    renderLabelGenPreview = function() {
      const source = document.querySelector('input[name="labelgen-source"]:checked')?.value || 'single';
      if (source === 'single') return origRenderPreview();
      // Preview first selected item
      const sku = [...State.labelGenSelected][0];
      if (!sku) {
        const previewBox = $('#labelgen-preview');
        if (previewBox) previewBox.innerHTML = '<p class="text-gray-400 text-sm italic">Search & pick items above</p>';
        return;
      }
      const item = State.items.find(i => i.sku === sku) || null;
      const size = getLabelSize();
      const logoDataUrl = getSavedLogo();
      const name = $('#labelgen-name').value.trim()  || item?.name || '';
      const extra = $('#labelgen-extra').value.trim();
      const qrSource = $('#labelgen-qr-source').value;
      const qrCustom = $('#labelgen-qr-custom').value.trim();
      const previewBox = $('#labelgen-preview');
      if (previewBox) {
        previewBox.innerHTML = '';
        const labelEl = buildLabelElement(item, { ...size, logoDataUrl, sku, name, extra, qrSource, qrCustom });
        previewBox.appendChild(labelEl);
      }
    };

    // Override generateLabels for multi mode
    const origGenerateLabels = generateLabels;
    generateLabels = function() {
      const source = document.querySelector('input[name="labelgen-source"]:checked')?.value || 'single';
      if (source === 'single') return origGenerateLabels();
      // Multi mode — use chip selections
      const selected = [...State.labelGenSelected].map(sku => State.items.find(i => i.sku === sku)).filter(Boolean);
      if (selected.length === 0) return toast('No items in selection', 'info');

      const size = getLabelSize();
      const logoDataUrl = getSavedLogo();
      const extra = $('#labelgen-extra').value.trim();
      const qrSource = $('#labelgen-qr-source').value;
      const qrCustom = $('#labelgen-qr-custom').value.trim();
      const qty = Math.max(1, Math.min(20, parseInt($('#labelgen-qty')?.value, 10) || 1));

      dom.printContainer.innerHTML = '';
      dom.printContainer.className = size.isGrid ? 'a4-grid-mode' : (size.isA4Land ? 'a4-landscape-mode' : '');
      selected.forEach(item => {
        for (let c = 0; c < qty; c++) {
          const labelEl = buildLabelElement(item, {
            ...size, logoDataUrl,
            sku: item.sku, name: item.name, extra,
            qrSource, qrCustom
          });
          dom.printContainer.appendChild(labelEl);
        }
      });

      if (size.isA4Land) document.body.classList.add('print-a4-landscape');
      document.body.classList.add('printing-label');
      setTimeout(() => {
        window.print();
        setTimeout(() => {
          document.body.classList.remove('printing-label');
          document.body.classList.remove('print-a4-landscape');
          dom.printContainer.innerHTML = '';
          dom.printContainer.className = '';
        }, 500);
      }, 200);
      const total = selected.length * qty;
      toast(`Generated ${total} label${total === 1 ? '' : 's'}`, 'success');
    };

    // ════════════════════════════════════════
    //  Bins & Pareto
    // ════════════════════════════════════════
    $('#btn-bins').addEventListener('click', openBinsModal);
    $('#btn-pareto').addEventListener('click', () => openPareto('transactions'));
    $('#modal-bins-close').addEventListener('click', () => closeModal(dom.modalBins));
    $('#modal-pareto-close').addEventListener('click', () => closeModal(dom.modalPareto));

    // Bin mode toggle (Structured / General)
    $$('.bin-mode-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.bin-mode-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const mode = tab.dataset.binMode;
        const structured = $('#bins-structured-panel');
        const general = $('#bins-general-panel');
        if (structured) structured.classList.toggle('hidden', mode !== 'structured');
        if (general) general.classList.toggle('hidden', mode !== 'general');
      });
    });

    // Bin: generate button
    $('#bins-generate').addEventListener('click', openBinsModal);

    // Bin: print sheet
    $('#bins-print').addEventListener('click', () => {
      const size = $('#bins-label-size').value;
      const grid = $('#bins-grid');
      const labels = grid.querySelectorAll('.bin-cell');
      if (!labels.length) { toast('No bins to print', 'error'); return; }

      dom.printContainer.innerHTML = '';
      dom.printContainer.className = 'print-grid';

      // CRITICAL: remove 'hidden' BEFORE generating QRs.
      // qrcodejs creates a canvas then converts to an <img> via canvas.toDataURL().
      // If the container is display:none the canvas context can still work, but
      // the img.onload fires asynchronously — we need the element to be in the
      // layout so we can wait for every img to fully load before printing.
      dom.printContainer.classList.remove('hidden');
      dom.printContainer.style.visibility = 'hidden'; // visible to paint engine but off-screen
      dom.printContainer.style.position   = 'fixed';
      dom.printContainer.style.top        = '-9999px';
      dom.printContainer.style.left       = '0';
      dom.printContainer.style.background = 'white';
      dom.printContainer.style.zIndex     = '-1';

      const qrTargets = [];
      labels.forEach(cell => {
        const code = cell.dataset.bincode;
        if (!code) return;
        const parts = code.split('-');
        const isGeneral = parts[0] === 'GENERAL';
        const header = isGeneral ? `${parts[1]} · ${parts[2]}` : `${parts[0]} · ${parts[1]}`;
        const sub    = isGeneral
          ? `${parts[3] || ''}`
          : `Bay ${parts[2] || ''} · Bin ${parts[3] || ''} · Lvl ${parts[4] || ''}`;
        const div = document.createElement('div');
        div.className = 'print-label-bin';
        const qrId = 'binqr-' + Math.random().toString(36).slice(2, 9);
        div.innerHTML = `
          <div class="bin-print-header">${esc(header)}</div>
          <div class="bin-print-qr" id="${qrId}"></div>
          <div class="bin-print-sub">${esc(sub)}</div>
          <div class="bin-print-code">${esc(code)}</div>
        `;
        dom.printContainer.appendChild(div);
        const assignedItem = State.items.find(i => getItemBins(i).map(b => b.toUpperCase()).includes(code.toUpperCase()));
        qrTargets.push({ id: qrId, code, itemId: assignedItem?.id || '' });
      });

      // Generate QRs and collect all img load promises
      const loadPromises = [];
      qrTargets.forEach(({ id, code, itemId }) => {
        try {
          const el = document.getElementById(id); // direct getElementById — no selector escaping issues
          if (!el) return;
          const url = itemId
            ? guestUrl(itemId, code)
            : `${GUEST_BASE_URL}/guest-out.html?loc=${encodeURIComponent(code)}`;
          new QRCode(el, {
            text: url,
            width: 120, height: 120,   // fits inside 1.8in label
            colorDark: '#000000', colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M  // M = shorter data → smaller code, more reliable
          });
          // Wait for the img qrcodejs inserts to fully load
          const img = el.querySelector('img');
          if (img && !img.complete) {
            loadPromises.push(new Promise(res => {
              img.onload  = res;
              img.onerror = res;  // don't block on error
              // Safety timeout: if img never fires, unblock after 800ms
              setTimeout(res, 800);
            }));
          }
        } catch (e) { console.warn('Bin QR render failed', e); }
      });

      // Wait for all QR images to be ready, then print
      Promise.all(loadPromises).then(() => {
        // Restore normal positioning, hand off to print CSS
        dom.printContainer.style.visibility = '';
        dom.printContainer.style.position   = '';
        dom.printContainer.style.top        = '';
        dom.printContainer.style.left       = '';
        dom.printContainer.style.background = '';
        dom.printContainer.style.zIndex     = '';
        document.body.classList.add('printing-label');
        // Small RAF delay to let the browser repaint before the print dialog
        requestAnimationFrame(() => {
          setTimeout(() => {
            window.print();
            setTimeout(() => {
              document.body.classList.remove('printing-label');
              dom.printContainer.innerHTML = '';
              dom.printContainer.className = 'hidden';
              dom.printContainer.style.cssText = '';
            }, 600);
          }, 80);
        });
      });

      toast(`Printing ${labels.length} bin label${labels.length !== 1 ? 's' : ''} with QR codes`, 'success');
    });

    // Pareto tab switching
    $$('.pareto-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.pareto-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        renderPareto(tab.dataset.paretoMode);
      });
    });
  }

  // ═══════════════════════════════════════════════════════
  //  BIN SETUP
  // ═══════════════════════════════════════════════════════
  function getBinMode() {
    const active = document.querySelector('.bin-mode-tab.active');
    return active?.dataset?.binMode || 'structured';
  }

  function openBinsModal() {
    const mode = getBinMode();
    const existingBins = new Set();
    State.items.forEach(i => getItemBins(i).forEach(b => existingBins.add(b.toUpperCase())));
    let codes = [];

    if (mode === 'general') {
      const zone     = ($('#bins-zone')?.value || 'STAGING').toUpperCase();
      const label    = ($('#bins-zone-label')?.value || '').trim().toUpperCase() || 'AREA_1';
      const count    = parseInt($('#bins-zone-count')?.value, 10) || 6;
      const action   = ($('#bins-action')?.value || 'STOCK').toUpperCase();

      for (let i = 0; i < count; i++) {
        const suffix = count > 1 ? `_${String(i + 1).padStart(2, '0')}` : '';
        codes.push(`GENERAL-${zone}-${label}${suffix}-${action}`);
      }
    } else {
      const room    = ($('#bins-room')?.value || '').trim().toUpperCase() || 'WH';
      const aisle   = ($('#bins-aisle')?.value || '').trim().toUpperCase() || 'A';
      const bay     = parseInt($('#bins-bay')?.value, 10) || 1;
      const start   = parseInt($('#bins-start')?.value, 10) || 1;
      const count   = parseInt($('#bins-count')?.value, 10) || 12;
      const level   = ($('#bins-level')?.value || '1').toUpperCase();
      const action  = ($('#bins-action')?.value || 'STOCK').toUpperCase();

      for (let i = 0; i < count; i++) {
        const binNum = String(start + i).padStart(2, '0');
        const bayNum = String(bay).padStart(2, '0');
        codes.push(`${room}-${aisle}-${bayNum}-${binNum}-${level}-${action}`);
      }
    }


    const grid = $('#bins-grid');
    grid.innerHTML = codes.map((code, idx) => {
      const taken = existingBins.has(code.toUpperCase());
      const isGeneral = code.startsWith('GENERAL-');
      let sub1 = '', sub2 = '', sub3 = '';

      if (isGeneral) {
        const parts = code.split('-');
        sub1 = parts[1] || '';
        sub2 = parts[2] || '';
        sub3 = parts[3] || '';
      } else {
        const parts = code.split('-');
        sub1 = `${parts[0] || ''} · Aisle ${parts[1] || ''} · Bay ${parts[2] || ''}`;
        sub2 = `Bin ${parts[3] || ''} Lvl ${parts[4] || ''}`;
        sub3 = parts[5] || '';
      }

      return `<div class="bin-cell ${taken ? 'bin-taken' : 'bin-free'}" data-bincode="${esc(code)}" title="${taken ? 'Already assigned' : 'Free bin — click to assign'}">
        <span class="text-[9px] opacity-50">${isGeneral ? 'ZONE' : esc(sub1)}</span>
        <span class="font-mono text-xs font-bold">${isGeneral ? esc(sub1) + ' · ' + esc(sub2) : esc(sub2)}</span>
        <span class="text-[9px] opacity-60">${esc(sub3)}</span>
        <span class="text-[10px] opacity-70">${taken ? 'in use' : 'free'}</span>
      </div>`;
    }).join('') + (codes.length === 0 ? '<p class="col-span-full text-gray-400 text-xs">No codes generated</p>' : '');

    // "Unassigned" logic is now: items that have 0 bins
    const unassigned = State.items.filter(i => getItemBins(i).length === 0 && !i.archived);

    const free = codes.filter(c => !existingBins.has(c.toUpperCase()));
    $('#bins-stats').textContent = `${free.length} free · ${codes.length - free.length} taken · ${unassigned.length} items without bins`;

    let activeBinCell = null;
    let activeBinCode = null;

    // Handle form submit on the new search modal
    dom.formSkuSearch.onsubmit = async (e) => {
      e.preventDefault();
      if (!activeBinCell || !activeBinCode) return;
      
      const inputValue = dom.inputSkuSearch.value.trim();
      // The user might select "SKU — Name" from datalist, so extract SKU
      const targetSku = inputValue.split(' — ')[0].trim().toUpperCase();
      
      const item = State.items.find(i => i.sku.toUpperCase() === targetSku);
      if (!item) {
        toast(`SKU "${targetSku}" not found in inventory.`, 'error');
        return;
      }

      await DAL.assignBin(item.id, activeBinCode);
      
      activeBinCell.classList.remove('bin-free');
      activeBinCell.classList.add('bin-taken');
      activeBinCell.querySelector('span:last-child').textContent = 'assigned';
      toast(`${item.sku} → ${activeBinCode}`, 'success');
      
      const newUnassignedCount = State.items.filter(i => getItemBins(i).length === 0 && !i.archived).length;
      $('#bins-stats').textContent = `${free.length - 1 ? 'more' : 'no more'} free · ${newUnassignedCount} items without bins`;
      
      closeModal(dom.modalSkuSearch);
    };

    grid.querySelectorAll('.bin-cell.bin-free').forEach(cell => {
      cell.addEventListener('click', () => {
        activeBinCode = cell.dataset.bincode;
        activeBinCell = cell;
        
        // Populate datalist with active items
        dom.skuDatalist.innerHTML = State.items
          .filter(i => !i.archived)
          .map(i => `<option value="${esc(i.sku)} — ${esc(i.name)}"></option>`)
          .join('');
          
        dom.assignTargetBin.textContent = activeBinCode;
        dom.inputSkuSearch.value = '';
        openModal(dom.modalSkuSearch);
        setTimeout(() => dom.inputSkuSearch.focus(), 100);
      });
    });

    openModal(dom.modalBins);
  }

  // ═══════════════════════════════════════════════════════
  //  PARETO DASHBOARD
  // ═══════════════════════════════════════════════════════
  function openPareto(mode) {
    renderPareto(mode || 'transactions');
    openModal(dom.modalPareto);
  }

  function renderPareto(mode) {
    const items = State.items.filter(i => !i.archived);
    if (items.length === 0) {
      $('#pareto-total-skus').textContent = '0';
      $('#pareto-top20c').textContent = '0%';
      $('#pareto-coverage').textContent = '0%';
      $('#pareto-vital').textContent = '0';
      $('#pareto-body').innerHTML = '<tr><td colspan="7" class="text-center py-8 text-gray-400">No items yet.</td></tr>';
      $('#pareto-chart').innerHTML = '';
      $('#pareto-explainer').textContent = '';
      return;
    }

    // Compute a "movement" score per item based on mode
    let scored;
    if (mode === 'lowstock') {
      // Items closest to needing reorder = lowest building stock as % of capacity
      scored = items.map(i => {
        const measure = Math.max(0, (i.maxCapacity || 20) - locStock(i, LOC_BUILDING));
        return { ...i, measure };
      });
    } else if (mode === 'value') {
      // By total stock value (BS Comm quantity)
      scored = items.map(i => {
        const measure = totalStockFromLocs(i);
        return { ...i, measure };
      });
    } else {
      // Default: transactions mode — count from Firestore transactions, or fallback to totalStock
      scored = items.map(i => {
        const measure = totalStockFromLocs(i); // simplified proxy for active items
        return { ...i, measure };
      });
    }

    // Sort descending by measure
    scored.sort((a, b) => b.measure - a.measure);

    const totalMeasure = scored.reduce((s, i) => s + i.measure, 0) || 1;
    let cum = 0;
    let vitalCount = 0;
    const tableRows = scored.map((i, idx) => {
      const pct = totalMeasure > 0 ? (i.measure / totalMeasure) * 100 : 0;
      cum += pct;
      const tier = cum <= 80 ? 'A' : cum <= 95 ? 'B' : 'C';
      if (cum <= 80) vitalCount = idx + 1;
      return { idx: idx + 1, item: i, pct, cum: Math.min(cum, 100), tier };
    });

    const top20Cum = tableRows.slice(0, Math.max(1, Math.ceil(tableRows.length * 0.2))).reduce((s, r) => s + r.pct, 0);

    // Summary cards
    $('#pareto-total-skus').textContent = scored.length;
    $('#pareto-top20c').textContent = Math.round(top20Cum) + '%';
    $('#pareto-coverage').textContent = Math.round(tableRows.filter(r => r.tier === 'A').reduce((s, r) => s + r.pct, 0)) + '%';
    $('#pareto-vital').textContent = vitalCount;

    // Explainer
    const modeLabels = { transactions: 'Scan-out activity (proxy: total stock)', lowstock: 'Distance from carrier trigger', value: 'Total stock value' };
    $('#pareto-explainer').textContent = `Mode: ${modeLabels[mode] || mode}. Sorting by most active → least active.`;

    // Table
    $('#pareto-body').innerHTML = tableRows.map(r => `
      <tr class="border-b border-gray-100 dark:border-gray-700/30 text-sm hover:bg-gray-50 dark:hover:bg-surface-700/30 transition-colors">
        <td class="py-2 pr-3 text-xs text-gray-400 font-mono">${r.idx}</td>
        <td class="py-2 pr-3 font-mono text-xs font-semibold text-accent">${esc(r.item.sku)}</td>
        <td class="py-2 pr-3 text-gray-700 dark:text-gray-200">${esc(r.item.name)}</td>
        <td class="py-2 pr-3 text-right font-semibold tabular-nums">${r.item.measure}</td>
        <td class="py-2 pr-3 text-right text-xs text-gray-500 tabular-nums">${r.pct.toFixed(1)}%</td>
        <td class="py-2 pr-3 text-right text-xs font-semibold tabular-nums" style="color:${r.cum <= 80 ? '#10b981' : r.cum <= 95 ? '#f59e0b' : '#ef4444'}">${r.cum.toFixed(1)}%</td>
        <td class="py-2 pr-3 text-center">
          <span class="inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold
            ${r.tier === 'A' ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400' :
              r.tier === 'B' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' :
              'bg-red-100 dark:bg-red-900/30 text-red-500'}">${r.tier}
          </span>
          <span class="ml-1 text-xs text-gray-400">
            <input type="text" class="bin-inline-edit" value="${esc(getItemBins(r.item)[0] || '')}"
              placeholder="Bin…" maxlength="20"
              data-sku="${esc(r.item.sku)}" title="Click to edit primary bin code" />
          </span>
        </td>
      </tr>
    `).join('');

    // Inline bin edit saves
    $('#pareto-body').querySelectorAll('.bin-inline-edit').forEach(inp => {
      inp.addEventListener('change', async () => {
        const item = State.items.find(i => i.sku === inp.dataset.sku);
        if (!item) return;
        const newBin = inp.value.trim().toUpperCase();
        if (newBin) {
          await DAL.assignBin(item.id, newBin);
          toast(`Bin assigned to ${item.sku}: ${newBin}`, 'success');
        } else {
          const oldBins = getItemBins(item);
          if (oldBins.length > 0) {
            await DAL.clearBin(item.id, oldBins[0]);
            toast(`Cleared primary bin for ${item.sku}`, 'success');
          }
        }
      });
    });

    // Chart bars (top 30 items)
    const chart = $('#pareto-chart');
    const topN = tableRows.slice(0, 30);
    const maxMeasure = topN.length ? Math.max(...topN.map(r => r.item.measure), 1) : 1;
    chart.innerHTML = topN.map(r => {
      const h = Math.max(4, (r.item.measure / maxMeasure) * 100);
      return `<div class="flex flex-col items-center justify-end h-full min-w-[24px]" title="#${r.idx} ${esc(r.item.sku)}: ${r.item.measure}">
        <div class="w-5 rounded-t-sm transition-all duration-300 hover:opacity-80 cursor-pointer"
             style="height:${h.toFixed(0)}%;background:${r.tier === 'A' ? '#10b981' : r.tier === 'B' ? '#f59e0b' : '#ef4444'}"></div>
      </div>`;
    }).join('') + (topN.length === 0 ? '<p class="text-gray-400 text-xs self-center w-full text-center">No data</p>' : '');
  }

  // ═══════════════════════════════════════════════════════
  //  UTILITIES
  // ═══════════════════════════════════════════════════════
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  }

  function toast(message, type = 'info') {
    const container = $('#toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span>${esc(message)}</span>`;
    container.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; setTimeout(() => el.remove(), 300); }, 3000);
  }

  // ─── Custom confirm modal (Promise-based; replaces native confirm()) ───
  function confirmDialog({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-content w-full max-w-md">
          <div class="flex items-center gap-3 mb-4">
            <div class="w-10 h-10 rounded-xl ${danger ? 'bg-red-500/10 text-red-500' : 'bg-accent/10 text-accent'} flex items-center justify-center shrink-0">
              ${danger
                ? '<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>'
                : '<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>'}
            </div>
            <h3 class="text-lg font-bold">${esc(title)}</h3>
          </div>
          <p class="text-sm text-gray-600 dark:text-gray-300 mb-6 leading-relaxed">${esc(message)}</p>
          <div class="flex gap-3">
            <button data-confirm class="${danger ? 'btn-accent' : 'btn-secondary'} flex-1 justify-center text-sm font-semibold py-2.5" style="${danger ? 'background:linear-gradient(135deg,#ef4444,#dc2626);box-shadow:0 4px 14px rgba(239,68,68,0.35);' : ''}">${esc(confirmText)}</button>
            <button data-cancel class="btn-secondary flex-1 justify-center text-sm font-semibold py-2.5">${esc(cancelText)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      let keyHandler;
      const finish = (val) => {
        overlay.remove();
        document.body.style.overflow = '';
        if (keyHandler) document.removeEventListener('keydown', keyHandler);
        resolve(val);
      };
      overlay.addEventListener('click', e => {
        if (e.target === overlay || e.target.dataset.cancel !== undefined) finish(false);
        else if (e.target.dataset.confirm !== undefined) finish(true);
      });
      keyHandler = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
        if (e.key === 'Enter')  { e.stopPropagation(); finish(true); }
      };
      document.addEventListener('keydown', keyHandler);
      overlay.querySelector('[data-cancel]').focus();
      document.body.style.overflow = 'hidden';
    });
  }

  // ─── Custom Google sign-in handler ───
  async function signInWithGoogle() {
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await auth.signInWithPopup(provider);
    } catch (err) {
      const msgs = {
        'auth/popup-blocked':         'Popup blocked — allow popups for this site.',
        'auth/popup-closed-by-user':  'Sign-in cancelled.',
        'auth/unauthorized-domain':   'This domain is not authorized for Google sign-in. Add it in Firebase Console → Auth → Settings → Authorized domains.',
        'auth/operation-not-allowed': 'Google sign-in not enabled. Enable it in Firebase Console → Auth → Sign-in method.'
      };
      toast(msgs[err.code] || err.message, 'error');
      throw err;
    }
  }

  // ─── Service worker registration ───
  function registerSW() {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('/sw.js').catch(err =>
        console.warn('Service worker registration failed:', err)
      );
    }
  }

  // ─── Boot ───
  document.addEventListener('DOMContentLoaded', () => {
    registerSW();
    init();
    // Handle PWA shortcuts from manifest (?action=add / ?action=manifest)
    const params = new URLSearchParams(location.search);
    if (params.get('action') === 'add')      setTimeout(() => openItemModal(), 800);
    if (params.get('action') === 'manifest') setTimeout(() => generateManifest(), 800);
  });

})();
