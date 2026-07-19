<script lang="ts">
  import Scanner from '$lib/Scanner.svelte';
  import { inventory, skus, bins, discrepancies, ready } from '$lib/store';
  import { parseScan } from '$lib/qr';

  let scanning = $state(false);
  let lastScan = $state('');
  let lookupBin = $state('');
  let lookupSku = $state('');

  const stats = $derived({
    docs: $inventory.filter((d) => !d.archived).length,
    skus: $skus.size,
    bins: $bins.size,
    open: $discrepancies.filter((d) => d.status === 'open').length
  });
  const binDocs = $derived(lookupBin ? ($bins.get(lookupBin) ?? []) : []);
  const skuEntry = $derived(lookupSku ? $skus.get(lookupSku) : undefined);

  function onScan(text: string) {
    lastScan = text;
    const r = parseScan(text);
    if (r.kind === 'bin') {
      lookupBin = r.bin;
      lookupSku = '';
      scanning = false;
    } else if (r.kind === 'item') {
      lookupSku = r.id;
      lookupBin = '';
      scanning = false;
    } else {
      lookupSku = r.text.toUpperCase();
      lookupBin = '';
    }
  }
</script>

<h1 class="page-h">Warehouse overview</h1>
<p class="page-sub">Live snapshot of the production inventory collection.</p>

{#if !$ready}
  <div class="empty"><span class="spin"></span> Syncing…</div>
{:else}
  <div class="grid cols-4" style="margin-bottom:16px">
    <div class="card"><h3>Bin docs</h3><div class="stat">{stats.docs}</div></div>
    <div class="card"><h3>SKUs</h3><div class="stat">{stats.skus}</div></div>
    <div class="card"><h3>Occupied bins</h3><div class="stat">{stats.bins}</div></div>
    <div class="card"><h3>Open disc.</h3><div class="stat" style:color={stats.open ? 'var(--err)' : 'inherit'}>{stats.open}</div></div>
  </div>

  <div class="grid cols-2">
    <div class="card">
      <h3>Scan to look up</h3>
      {#if scanning}
        <Scanner onscan={onScan} />
      {:else}
        <button class="btn primary" onclick={() => (scanning = true)}>▣ Start scanner</button>
      {/if}
      <div class="scan-last">{lastScan ? `last: ${lastScan}` : ''}</div>
      <div class="row" style="margin-top:8px">
        <input class="input" style="flex:1" placeholder="…or type bin code / SKU" bind:value={lookupBin}
          oninput={(e) => { lookupSku = ''; lookupBin = e.currentTarget.value.toUpperCase(); }} />
      </div>

      {#if lookupBin}
        <div style="margin-top:12px">
          <h3 class="mono">{lookupBin} · {binDocs.length} doc(s)</h3>
          {#each binDocs as d (d.id)}
            <div class="lrow">
              <span class="mono badge info">{d.sku}</span>
              <span class="grow">{d.name}</span>
              <span class="mono">{d.quantity}</span>
            </div>
          {:else}
            <div class="empty">No docs at this bin.</div>
          {/each}
        </div>
      {/if}
      {#if skuEntry}
        <div style="margin-top:12px">
          <h3 class="mono">{skuEntry.sku} · total {skuEntry.total}</h3>
          {#each skuEntry.docs as d (d.id)}
            <div class="lrow">
              <span class="mono badge info">{d.binCode || 'UNASSIGNED'}</span>
              <span class="grow">{d.name}</span>
              <span class="mono">{d.quantity}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="card">
      <h3>Recent discrepancies</h3>
      {#each $discrepancies as d (d.id)}
        <div class="lrow">
          <span class="badge {d.status === 'open' ? 'err' : 'ok'}">{d.status}</span>
          <span class="mono badge info">{d.sku}</span>
          <span class="grow small">{d.binCode}</span>
          <span class="mono" style:color={d.variance > 0 ? 'var(--ok)' : 'var(--err)'}>
            {d.variance > 0 ? '+' : ''}{d.variance}
          </span>
        </div>
      {:else}
        <div class="empty">None recorded.</div>
      {/each}
    </div>
  </div>
{/if}
