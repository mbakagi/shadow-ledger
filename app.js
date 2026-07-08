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
    viewMode: 'active'
  };

  // ─── Data Access Layer (DAL) — Firestore backend ───
  const DAL = {
    _unsub: null,

    // Start real-time listener; calls onUpdate(items[]) whenever Firestore changes
    startSync(onUpdate) {
      if (this._unsub) this._unsub();
      this._unsub = db.collection('inventory')
        .onSnapshot(snapshot => {
          const items = [];
          snapshot.forEach(doc => items.push({ id: doc.id, ...doc.data() }));
          onUpdate(items);
        }, err => console.error('Firestore sync error:', err));
    },

    stopSync() {
      if (this._unsub) { this._unsub(); this._unsub = null; }
    },

    // Write a single item (fire-and-forget is fine — Firestore queues & retries)
    saveOne(item) {
      const { id, ...data } = item;
      db.collection('inventory').doc(id).set(data);
    },

    // Delete a single item
    deleteOne(id) {
      db.collection('inventory').doc(id).delete();
    },

    // Batch-write many items
    saveMany(items) {
      const batch = db.batch();
      items.forEach(item => {
        const { id, ...data } = item;
        batch.set(db.collection('inventory').doc(id), data);
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
    modalAlerts:      $('#modal-alerts'),
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

        // Start Firestore real-time sync
        DAL.startSync(items => {
          // Only re-render if no inline-input is focused (prevents stealing focus)
          const active = document.activeElement;
          State.items = items;
          if (active && active.classList && active.classList.contains('inline-input')) {
            renderDashboard(); // silent update
          } else {
            applyFilters();
            renderDashboard();
            populateCategoryFilter();
          }
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
        btn.textContent = 'Sign In to Shadow Ledger';
        btn.disabled = false;
      }
    });
  }

  // ─── Sample data loader (Firestore version — only runs once on empty DB) ───
  function loadSampleDataToFirestore() {
    const samples = [
      { sku: 'FB-M8-50',    name: 'M8x50 Hex Bolt',         category: 'Fasteners',    totalStock: 500,  buildingStock: 12,  carrierTrigger: 20,  maxCapacity: 100, purchasingTrigger: 80 },
      { sku: 'FB-M10-30',   name: 'M10x30 Flange Bolt',     category: 'Fasteners',    totalStock: 320,  buildingStock: 45,  carrierTrigger: 30,  maxCapacity: 80,  purchasingTrigger: 60 },
      { sku: 'EL-CB-2.5',   name: '2.5mm² Cable (100m)',    category: 'Electrical',   totalStock: 45,   buildingStock: 3,   carrierTrigger: 5,   maxCapacity: 15,  purchasingTrigger: 10 },
      { sku: 'EL-CB-4.0',   name: '4.0mm² Cable (100m)',    category: 'Electrical',   totalStock: 8,    buildingStock: 2,   carrierTrigger: 3,   maxCapacity: 10,  purchasingTrigger: 12 },
      { sku: 'PL-PVC-25',   name: '25mm PVC Conduit (3m)',  category: 'Plumbing',     totalStock: 200,  buildingStock: 35,  carrierTrigger: 15,  maxCapacity: 50,  purchasingTrigger: 40 },
      { sku: 'SF-GG-CLR',   name: 'Clear Safety Goggles',   category: 'Safety',       totalStock: 60,   buildingStock: 4,   carrierTrigger: 8,   maxCapacity: 25,  purchasingTrigger: 15 },
      { sku: 'GN-TAPE-BK',  name: 'Black Electrical Tape',  category: 'General',      totalStock: 300,  buildingStock: 50,  carrierTrigger: 20,  maxCapacity: 80,  purchasingTrigger: 50 },
    ];
    const items = samples.map(s => ({ id: DAL.generateId(), ...s }));
    DAL.saveMany(items).then(() => toast('Sample data loaded', 'success'));
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
    return Math.max(0, item.totalStock - item.buildingStock);
  }

  function needsCarrier(item) {
    return item.buildingStock <= item.carrierTrigger;
  }

  function needsProcurement(item) {
    return item.totalStock <= item.purchasingTrigger;
  }

  function carrierQty(item) {
    return Math.max(0, item.maxCapacity - item.buildingStock);
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
        (i.category && i.category.toLowerCase().includes(query))
      );
    }

    if (category) {
      results = results.filter(i => i.category === category);
    }

    if (alert === 'carrier') results = results.filter(needsCarrier);
    else if (alert === 'procure') results = results.filter(needsProcurement);
    else if (alert === 'ok') results = results.filter(i => !needsCarrier(i) && !needsProcurement(i));

    if (stock === 'in_stock') results = results.filter(i => i.totalStock > 0);
    else if (stock === 'in_building') results = results.filter(i => i.buildingStock > 0);

    // Sort
    results.sort((a, b) => {
      let av = a[State.sortField];
      let bv = b[State.sortField];
      if (State.sortField === 'depotStock') { av = depotStock(a); bv = depotStock(b); }
      if (typeof av === 'string') { av = av.toLowerCase(); bv = bv.toLowerCase(); }
      if (av < bv) return State.sortAsc ? -1 : 1;
      if (av > bv) return State.sortAsc ? 1 : -1;
      return 0;
    });

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

  function renderRow(item) {
    const depot   = depotStock(item);
    const cAlert  = needsCarrier(item);
    const pAlert  = needsProcurement(item);
    const rowClass = [cAlert ? 'row-carrier' : '', pAlert ? 'row-procure' : ''].join(' ').trim();

    // Building stock gauge (percentage of max capacity)
    const gaugePercent = item.maxCapacity > 0 ? Math.min(100, (item.buildingStock / item.maxCapacity) * 100) : 0;
    const gaugeColor   = gaugePercent <= 25 ? 'bg-red-500' : gaugePercent <= 50 ? 'bg-amber-500' : 'bg-emerald-500';

    // Status badge
    let badge = '<span class="badge badge-ok">OK</span>';
    if (cAlert && pAlert) badge = '<span class="badge badge-carrier">CARRIER</span> <span class="badge badge-procure">ORDER</span>';
    else if (cAlert) badge = '<span class="badge badge-carrier">CARRIER</span>';
    else if (pAlert) badge = '<span class="badge badge-procure">ORDER</span>';

    return `
      <tr class="group hover:bg-gray-50/80 dark:hover:bg-surface-700/30 transition-colors ${rowClass}" data-id="${item.id}">
        <td class="px-3 py-2.5 text-center"><input type="checkbox" class="row-checkbox w-4 h-4 rounded border-gray-300 text-accent focus:ring-accent" data-id="${item.id}" ${State.selectedIds.has(item.id) ? 'checked' : ''}></td>
        <td class="px-3 py-2.5 text-center">${badge}</td>
        <td class="px-3 py-2.5 font-mono text-xs font-semibold text-accent">${esc(item.sku)}</td>
        <td class="px-3 py-2.5 font-medium">${esc(item.name)}</td>
        <td class="px-3 py-2.5 text-gray-500 dark:text-gray-400 hidden sm:table-cell">${esc(item.category || '—')}</td>
        <td class="px-3 py-2.5 text-center">
          <input type="number" inputmode="numeric" min="0" class="inline-input" value="${item.totalStock}" data-field="totalStock" data-id="${item.id}" />
        </td>
        <td class="px-3 py-2.5">
          <div class="flex items-center justify-center gap-1.5">
            <button class="adj-btn" data-action="dec" data-id="${item.id}" title="−1">−</button>
            <input type="number" inputmode="numeric" min="0" class="inline-input" value="${item.buildingStock}" data-field="buildingStock" data-id="${item.id}" />
            <button class="adj-btn" data-action="inc" data-id="${item.id}" title="+1">+</button>
          </div>
          <div class="mt-1 w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5 overflow-hidden" title="${Math.round(gaugePercent)}% of max capacity">
            <div class="gauge-bar ${gaugeColor}" style="width:${gaugePercent}%"></div>
          </div>
        </td>
        <td class="px-3 py-2.5 text-center font-semibold tabular-nums ${depot <= 0 ? 'text-red-500' : ''}">${depot}</td>
        <td class="px-3 py-2.5 text-center hidden lg:table-cell">
          <input type="number" inputmode="numeric" min="0" class="inline-input" value="${item.carrierTrigger}" data-field="carrierTrigger" data-id="${item.id}" />
        </td>
        <td class="px-3 py-2.5 text-center hidden lg:table-cell">
          <input type="number" inputmode="numeric" min="0" class="inline-input" value="${item.maxCapacity}" data-field="maxCapacity" data-id="${item.id}" />
        </td>
        <td class="px-3 py-2.5 text-center hidden lg:table-cell">
          <input type="number" inputmode="numeric" min="0" class="inline-input" value="${item.purchasingTrigger}" data-field="purchasingTrigger" data-id="${item.id}" />
        </td>
        <td class="px-3 py-2.5 text-center">
          <div class="action-btns flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button class="p-1.5 rounded-lg hover:bg-accent/10 text-accent transition" data-action="print" data-id="${item.id}" title="Print Label">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
            </button>
            <button class="p-1.5 rounded-lg hover:bg-accent/10 text-accent transition" data-action="edit" data-id="${item.id}" title="Edit">
              <svg class="w-4 h-4 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
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
    const totalUnits = State.items.reduce((s, i) => s + i.totalStock, 0);

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
    if (item[field] === num) return; // no change
    item[field] = num;
    DAL.saveOne(item); // fire-and-forget to Firestore

    // Update just the depot cell and gauge in the same row (without replacing the row)
    const row = dom.tableBody.querySelector(`tr[data-id="${id}"]`);
    if (row) {
      // Update depot stock display
      const depot = depotStock(item);
      const depotCell = row.cells[6]; // 7th cell = depot
      if (depotCell) {
        depotCell.textContent = depot;
        depotCell.className = `px-3 py-2.5 text-center font-semibold tabular-nums ${depot <= 0 ? 'text-red-500' : ''}`;
      }

      // Update the gauge bar
      const gaugePercent = item.maxCapacity > 0 ? Math.min(100, (item.buildingStock / item.maxCapacity) * 100) : 0;
      const gaugeColor = gaugePercent <= 25 ? 'bg-red-500' : gaugePercent <= 50 ? 'bg-amber-500' : 'bg-emerald-500';
      const gaugeBar = row.querySelector('.gauge-bar');
      if (gaugeBar) {
        gaugeBar.style.width = gaugePercent + '%';
        gaugeBar.className = `gauge-bar ${gaugeColor}`;
      }

      // Update row status classes
      const cAlert = needsCarrier(item);
      const pAlert = needsProcurement(item);
      row.classList.toggle('row-carrier', cAlert);
      row.classList.toggle('row-procure', pAlert);

      // Update badge
      const badgeCell = row.cells[0];
      if (badgeCell) {
        let badge = '<span class="badge badge-ok">OK</span>';
        if (cAlert && pAlert) badge = '<span class="badge badge-carrier">CARRIER</span> <span class="badge badge-procure">ORDER</span>';
        else if (cAlert) badge = '<span class="badge badge-carrier">CARRIER</span>';
        else if (pAlert) badge = '<span class="badge badge-procure">ORDER</span>';
        badgeCell.innerHTML = badge;
      }
    }

    renderDashboard();
  }

  // Full row update (used after ± buttons, when we don't need focus preservation)
  function updateFieldFull(id, field, value) {
    const item = State.items.find(i => i.id === id);
    if (!item) return;
    const num = Math.max(0, parseInt(value, 10) || 0);
    item[field] = num;
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

  function adjustStock(id, delta) {
    const item = State.items.find(i => i.id === id);
    if (!item) return;
    item.buildingStock = Math.max(0, item.buildingStock + delta);
    DAL.saveOne(item);
    renderDashboard();
    const row = dom.tableBody.querySelector(`tr[data-id="${id}"]`);
    if (row) {
      const temp = document.createElement('tbody');
      temp.innerHTML = renderRow(item);
      row.replaceWith(temp.firstElementChild);
    }
  }

  function saveItem(data) {
    if (State.editingId) {
      const idx = State.items.findIndex(i => i.id === State.editingId);
      if (idx >= 0) State.items[idx] = { ...State.items[idx], ...data };
    } else {
      State.items.push({ id: DAL.generateId(), ...data });
    }
    DAL.save(State.items);
    State.editingId = null;
    applyFilters();
    renderDashboard();
    populateCategoryFilter();
  }

  function deleteItem(id) {
    if (!confirm('Delete this item? This cannot be undone.')) return;
    State.items = State.items.filter(i => i.id !== id);
    DAL.save(State.items);
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
    $('#field-totalStock').value        = item ? item.totalStock : 0;
    $('#field-buildingStock').value     = item ? item.buildingStock : 0;
    $('#field-carrierTrigger').value    = item ? item.carrierTrigger : 5;
    $('#field-maxCapacity').value       = item ? item.maxCapacity : 20;
    $('#field-purchasingTrigger').value = item ? item.purchasingTrigger : 10;
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
        <div>
          <div class="shelf-label-sku">${esc(item.sku)}</div>
          <div class="shelf-label-name">${esc(item.name)}</div>
        </div>
        <svg class="shelf-label-barcode" id="barcode-${item.id}"></svg>
        <div class="shelf-label-footer">
          <span>Max Cap: ${item.maxCapacity}</span>
          <span>${esc(item.category || '')}</span>
        </div>
      `;
      dom.printContainer.appendChild(wrapper);
      
      // Render Barcode
      try {
        JsBarcode(`#barcode-${item.id}`, item.sku, {
          format: "CODE128",
          displayValue: false,
          margin: 0,
          height: 50,
          width: 2
        });
      } catch (e) {
        console.warn("Could not generate barcode for SKU:", item.sku);
      }
    });
    
    // Trigger print
    document.body.classList.add('printing-label');
    window.print();
    // Remove class after print dialog closes
    setTimeout(() => {
      document.body.classList.remove('printing-label');
    }, 500);
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
      else if (['totalstock', 'total', 'qty', 'quantity', 'stockqty', 'onhand', 'qtyonhand', 'stockonhand', 'available'].includes(hh)) colMap.totalStock = i;
      else if (['buildingstock', 'building', 'bldgstock', 'sitestock', 'localstock', 'buildingqty'].includes(hh)) colMap.buildingStock = i;
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
    return {
      sku:               String(cols[colMap.sku] ?? '').trim(),
      name:              String(cols[colMap.name] ?? '').trim(),
      category:          String(cols[colMap.category] ?? '').trim(),
      totalStock:        parseNum(cols[colMap.totalStock], 0),
      buildingStock:     parseNum(cols[colMap.buildingStock], 0),
      carrierTrigger:    parseNum(cols[colMap.carrierTrigger], 5),
      maxCapacity:       parseNum(cols[colMap.maxCapacity], 20),
      purchasingTrigger: parseNum(cols[colMap.purchasingTrigger], 10),
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
      State.items = State.importParsedData.map(d => ({ id: DAL.generateId(), ...d }));
      DAL.save(State.items);
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
    let updated = 0, added = 0;
    newItems.forEach(ni => {
      const existing = State.items.find(i => 
        (ni.sku && i.sku && i.sku.toLowerCase() === ni.sku.toLowerCase()) || 
        (!ni.sku && i.name && ni.name && i.name.toLowerCase() === ni.name.toLowerCase())
      );
      if (existing) {
        Object.assign(existing, { ...ni, id: existing.id });
        updated++;
      } else {
        State.items.push(ni);
        added++;
      }
    });

    // Write changed/new items to Firestore
    const changedItems = State.parsedData
      ? State.importParsedData.filter(ni => ni._isNew || ni._isUpdated)
      : State.importParsedData;
    DAL.saveMany(State.importParsedData.map(ni => {
      const existing = State.items.find(i => i.sku === ni.sku);
      return existing ? { ...existing, ...ni, id: existing.id } : ni;
    }));
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
    const headers = ['sku','name','category','totalStock','buildingStock','carrierTrigger','maxCapacity','purchasingTrigger'];
    const rows = State.items.map(i => headers.map(h => `"${String(i[h] ?? '').replace(/"/g, '""')}"`).join(','));
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
    dom.btnBulkDelete.addEventListener('click', () => {
      if (!confirm(`Delete ${State.selectedIds.size} items? This cannot be undone.`)) return;
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
      if (action === 'delete') deleteItem(id);
    });

    // Add Item
    $('#btn-add-item').addEventListener('click', () => openItemModal());

    // Item Form
    dom.formItem.addEventListener('submit', (e) => {
      e.preventDefault();
      saveItem({
        sku:               $('#field-sku').value.trim(),
        name:              $('#field-name').value.trim(),
        category:          $('#field-category').value.trim(),
        totalStock:        parseInt($('#field-totalStock').value, 10) || 0,
        buildingStock:     parseInt($('#field-buildingStock').value, 10) || 0,
        carrierTrigger:    parseInt($('#field-carrierTrigger').value, 10) || 5,
        maxCapacity:       parseInt($('#field-maxCapacity').value, 10) || 20,
        purchasingTrigger: parseInt($('#field-purchasingTrigger').value, 10) || 10,
      });
      closeModal(dom.modalItem);
      toast(State.editingId ? 'Item updated' : 'Item added', 'success');
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

    // Close modals on overlay click
    [dom.modalItem, dom.modalImport, dom.modalManifest, dom.modalAlerts].forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal);
      });
    });

    // Close modals on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        [dom.modalItem, dom.modalImport, dom.modalManifest, dom.modalAlerts].forEach(m => {
          if (!m.classList.contains('hidden')) closeModal(m);
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

    // Global Barcode Scanner Listener & Numpad Shortcuts
    let barcodeBuffer = '';
    let barcodeTimer = null;
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
        barcodeTimer = setTimeout(() => { barcodeBuffer = ''; }, 50); 
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
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span>${esc(message)}</span>`;
    container.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; setTimeout(() => el.remove(), 300); }, 3000);
  }

  // ─── Boot ───
  document.addEventListener('DOMContentLoaded', init);

})();
