<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
  import { db } from '$lib/firebase';
  import { skus, bins } from '$lib/store';
  import { suggestBins } from '$lib/putaway';
  import { moveQty } from '$lib/transfer';
  import { qrSvg, binDeepLink } from '$lib/qr';
  import { warehouseFields, COL, type InventoryDoc } from '$lib/schema';
  import { toast } from '$lib/toast';

  let sku = $state('');

  onMount(() => {
    const q = page.url.searchParams.get('sku');
    if (q) sku = q;
  });

  const entry = $derived($skus.get(sku));
  const suggestions = $derived(
    entry
      ? suggestBins(
          {
            sku: entry.sku,
            category: entry.category,
            highVelocity: entry.total > (entry.docs[0]?.purchasingTrigger ?? 0)
          },
          $bins
        )
      : []
  );
  const best = $derived(suggestions[0]);
  const bestQr = $derived(best ? qrSvg(binDeepLink(best.binCode)) : '');
  // Only scalar docs can be (re)assigned a binCode — per-bin docs' location is
  // their identity and rules deny non-quantity updates on them.
  const unassigned = $derived(entry?.docs.filter((d) => !d.isPerBin && !d.binCode) ?? []);

  const perBinDocs = $derived(entry?.docs.filter((d) => d.isPerBin) ?? []);
  let moveAmounts = $state<Record<string, number>>({});
  let moving = $state(false);

  async function move(d: InventoryDoc, destBinCode: string) {
    if (moving) return;
    moving = true;
    try {
      const qty = moveAmounts[d.id] ?? d.quantity;
      const r = await moveQty(d, destBinCode, qty);
      toast(`Moved ${r.moved} × ${d.sku} → ${destBinCode}${r.srcRemaining === 0 ? ' (source emptied)' : ''}`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      moving = false;
    }
  }

  async function assign(binCode: string) {
    const target = unassigned[0];
    if (!target) return toast('No unassigned doc for this SKU', 'err');
    try {
      await updateDoc(doc(db, COL.inventory, target.id), {
        binCode,
        ...warehouseFields(binCode),
        updatedAt: serverTimestamp()
      });
      toast(`${sku} → ${binCode}`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  }
</script>

<h1 class="page-h">Putaway — chaotic storage</h1>
<p class="page-sub">Weighted nearest-neighbor bin suggestion (category affinity · physical layout · fill rate).</p>

<div class="card" style="margin-bottom:14px">
  <label class="lbl" for="sku-in">SKU</label>
  <input id="sku-in" class="input mono" list="sku-list" placeholder="Type or paste a SKU…" bind:value={sku} />
  <datalist id="sku-list">
    {#each [...$skus.keys()].slice(0, 500) as k (k)}
      <option value={k}></option>
    {/each}
  </datalist>
</div>

{#if sku && !entry}
  <div class="empty">SKU <span class="mono">{sku}</span> not found in inventory.</div>
{/if}

{#if entry && best}
  <div class="grid cols-2">
    <div class="card" style="text-align:center">
      <h3>Best bin</h3>
      <div class="stat mono" style="font-size:24px">{best.binCode}</div>
      <div class="stat-sub">{best.occupants}/8 occupants</div>
      <div style="max-width:180px;margin:12px auto 0">{@html bestQr}</div>
      <div class="small muted mono">sl://bin/{best.binCode}</div>
      <div style="margin-top:10px">
        {#each best.reasons as r (r)}<span class="badge info" style="margin:2px">{r}</span>{/each}
      </div>
      {#if unassigned.length}
        <button class="btn primary" style="margin-top:14px" onclick={() => assign(best.binCode)}>
          Assign unassigned doc ({unassigned.length}) → this bin
        </button>
      {:else}
        <div class="small muted" style="margin-top:14px">All {entry.docs.length} doc(s) of this SKU already have bins.</div>
      {/if}
    </div>
    <div class="card">
      <h3>Alternatives</h3>
      {#each suggestions.slice(1) as s (s.binCode)}
        <div class="lrow">
          <span class="mono grow">{s.binCode}</span>
          <span class="small muted">{s.occupants}/8</span>
          <span class="mono small">score {s.score.toFixed(0)}</span>
          {#if unassigned.length}<button class="btn sm ghost" onclick={() => assign(s.binCode)}>assign</button>{/if}
        </div>
      {/each}
      <div style="margin-top:12px">
        <h3>Item</h3>
        <div class="small">{entry.name} · <span class="badge info">{entry.category || 'uncategorized'}</span></div>
        <div class="small muted">network total: {entry.total} across {entry.docs.length} doc(s)</div>
      </div>
      {#if perBinDocs.length}
        <div style="margin-top:12px">
          <h3>Move stock (bin-to-bin)</h3>
          {#each perBinDocs as d (d.id)}
            <div class="lrow">
              <span class="mono small grow">{d.binCode}</span>
              <span class="mono small">×{d.quantity}</span>
              {#if d.binCode !== best.binCode}
                <input class="input qty-in" type="number" min="1" max={d.quantity} value={moveAmounts[d.id] ?? d.quantity}
                  oninput={(e) => (moveAmounts[d.id] = Math.max(1, Math.min(d.quantity, e.currentTarget.valueAsNumber || 1)))} />
                <button class="btn sm primary" disabled={moving} onclick={() => move(d, best.binCode)}>→ best</button>
              {:else}
                <span class="badge ok">at best</span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}
