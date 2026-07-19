<script lang="ts">
  import { collection, doc, runTransaction, serverTimestamp, setDoc } from 'firebase/firestore';
  import { db } from '$lib/firebase';
  import { inventory } from '$lib/store';
  import { COL, parseBinCode, parseInventory, warehouseFields, type InventoryDoc } from '$lib/schema';
  import { commitInChunks, type BatchOp } from '$lib/batch';
  import { csvToImportRows, mapRows, type ImportRow } from '$lib/csv';
  import { UndoStack, type UndoOp } from '$lib/undo';
  import { toast } from '$lib/toast';

  // ── quantity adjusters (transaction-protected) + undo stack ──
  let filter = $state('');
  const shown = $derived(
    $inventory
      .filter((d) => !d.archived)
      .filter((d) => {
        const f = filter.toLowerCase();
        return !f || d.sku.toLowerCase().includes(f) || d.name.toLowerCase().includes(f) || d.binCode.toLowerCase().includes(f);
      })
      .slice(0, 200)
  );

  const stack = new UndoStack();
  let undoOps = $state<UndoOp[]>([]);
  const syncUndo = () => (undoOps = [...stack.ops].reverse());
  let busy = $state(false);

  async function setQty(d: InventoryDoc, next: number): Promise<number> {
    const ref = doc(db, COL.inventory, d.id);
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('doc vanished');
      const cur = parseInventory(snap.id, snap.data());
      const q = Math.max(0, Math.round(next));
      if (cur.isPerBin) tx.update(ref, { quantity: q, updated_at: serverTimestamp() });
      else tx.update(ref, { buildingStock: q, totalStock: q + cur.depotStock, updatedAt: serverTimestamp() });
      return cur.quantity;
    });
  }

  async function adjust(d: InventoryDoc, target: number) {
    if (busy || target === d.quantity) return;
    busy = true;
    try {
      const before = await setQty(d, target);
      stack.push({
        label: `${d.sku} @ ${d.binCode || '—'}: ${before} → ${Math.max(0, Math.round(target))}`,
        undo: async () => {
          await setQty(d, before);
        }
      });
      syncUndo();
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      busy = false;
    }
  }

  async function doUndo() {
    const op = await stack.pop();
    syncUndo();
    if (op) toast(`Undid: ${op.label}`, 'ok');
  }

  // ── drag-and-drop file configuration (CSV / JSON) ──
  let dragging = $state(false);
  let preview = $state<ImportRow[]>([]);
  let importing = $state(false);
  let progress = $state<[number, number]>([0, 0]);

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const text = await file.text();
    const rows = file.name.toLowerCase().endsWith('.json')
      ? mapRows(JSON.parse(text) as Record<string, unknown>[])
      : csvToImportRows(text);
    if (!rows.length) return toast('No valid rows (need at least a sku column)', 'err');
    preview = rows;
  }

  function importOp(r: ImportRow): BatchOp {
    if (r.binCode) {
      const p = parseBinCode(r.binCode);
      const id = `${r.sku}_R${p.room}_A${p.aisle}_B${String(p.bay).padStart(2, '0')}_B${String(p.bin).padStart(2, '0')}`;
      return (b) =>
        b.set(
          doc(db, COL.inventory, id),
          {
            sku: r.sku,
            name: r.name || r.sku,
            category: r.category,
            room: p.room,
            aisle: p.aisle,
            bay: String(p.bay).padStart(2, '0'),
            bin: String(p.bin).padStart(2, '0'),
            quantity: r.quantity,
            binCode: r.binCode,
            ...warehouseFields(r.binCode),
            updated_at: serverTimestamp()
          },
          { merge: true }
        );
    }
    return (b) =>
      b.set(
        doc(collection(db, COL.inventory)),
        {
          sku: r.sku,
          name: r.name || r.sku,
          category: r.category,
          binCode: '',
          totalStock: r.quantity,
          buildingStock: r.quantity,
          depotStock: 0,
          carrierTrigger: 0,
          maxCapacity: 0,
          purchasingTrigger: 0,
          archived: false,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
  }

  async function runImport() {
    importing = true;
    progress = [0, preview.length];
    try {
      await commitInChunks(preview.map(importOp), (d, t) => (progress = [d, t]));
      toast(`Imported ${preview.length} rows`, 'ok');
      preview = [];
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      importing = false;
    }
  }
</script>

<h1 class="page-h">Editor</h1>
<p class="page-sub">File-driven configuration, transactional quantity adjusters, 20-op undo.</p>

<div class="grid cols-2">
  <div>
    <div class="card"
      role="button" tabindex="0" aria-label="Drop a CSV or JSON file to import"
      style:border-color={dragging ? 'var(--acc)' : undefined}
      style:border-style={dragging ? 'dashed' : 'solid'}
      ondragover={(e) => { e.preventDefault(); dragging = true; }}
      ondragleave={() => (dragging = false)}
      ondrop={onDrop}>
      <h3>Import configuration</h3>
      {#if preview.length}
        <div class="small muted">{preview.length} rows parsed — first 5:</div>
        {#each preview.slice(0, 5) as r, i (i)}
          <div class="lrow small">
            <span class="mono badge info">{r.sku}</span><span class="grow">{r.name}</span>
            <span class="mono">{r.binCode || 'no-bin'}</span><span class="mono">×{r.quantity}</span>
          </div>
        {/each}
        <div class="row" style="margin-top:10px">
          <button class="btn primary" disabled={importing} onclick={runImport}>{importing ? 'Importing…' : `Commit ${preview.length} rows`}</button>
          <button class="btn ghost" onclick={() => (preview = [])}>Discard</button>
        </div>
        {#if importing}<div class="bar" style="margin-top:10px"><i style:width="{(progress[0] / progress[1]) * 100}%"></i></div>{/if}
      {:else}
        <div class="empty">Drop a <b>.csv</b> or <b>.json</b> file here.<br />
          <span class="small">Columns: sku, name, category, binCode, quantity (aliases tolerated).</span>
        </div>
      {/if}
    </div>

    <div class="card" style="margin-top:14px">
      <h3>Undo ({undoOps.length}/20) {#if undoOps.length}<button class="btn sm primary" onclick={doUndo}>Undo last</button>{/if}</h3>
      {#each undoOps.slice(0, 6) as op (op.label + op.at.getTime())}
        <div class="lrow small"><span class="grow">{op.label}</span><span class="muted small">{op.at.toLocaleTimeString()}</span></div>
      {:else}
        <div class="empty">No operations yet.</div>
      {/each}
    </div>
  </div>

  <div class="card">
    <h3>Quantities <input class="input sm" style="width:180px;display:inline-block;margin-left:8px" placeholder="filter…" bind:value={filter} /></h3>
    <div style="max-height:62vh;overflow:auto">
      {#each shown as d (d.id)}
        <div class="lrow">
          <span class="mono badge info">{d.sku}</span>
          <span class="grow small">{d.name}<br /><span class="muted mono small">{d.binCode || 'UNASSIGNED'}</span></span>
          <button class="btn sm" disabled={busy || d.quantity === 0} onclick={() => adjust(d, d.quantity - 1)}>−</button>
          <input class="input qty-in" type="number" min="0" value={d.quantity} disabled={busy}
            onchange={(e) => adjust(d, e.currentTarget.valueAsNumber || 0)} />
          <button class="btn sm" disabled={busy} onclick={() => adjust(d, d.quantity + 1)}>+</button>
        </div>
      {:else}
        <div class="empty">No matching docs.</div>
      {/each}
    </div>
  </div>
</div>
