<script lang="ts">
  import Scanner from '$lib/Scanner.svelte';
  import { inventory, skus, bins, discrepancies, ready, authError } from '$lib/store';
  import { parseScan } from '$lib/qr';

  let scanning = $state(false);
  let lastScan = $state('');
  let lookupBin = $state('');
  let lookupSku = $state('');

  // Autocomplete: bin code or SKU
  let query = $state('');
  let acOpen = $state(false);
  let acFocused = $state(-1);

  const acBins = $derived(
    query ? [...$bins.keys()].filter((k) => k.includes(query.toUpperCase())).slice(0, 6) : []
  );
  const acSkus = $derived(
    query
      ? [...$skus.entries()].filter(([k, v]) => k.includes(query.toUpperCase()) || v.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6)
      : []
  );
  const acTotal = $derived(acBins.length + acSkus.length);

  type AcItem = { kind: 'bin'; code: string } | { kind: 'sku'; sku: string; name: string; total: number };

  const acItems = $derived<AcItem[]>([
    ...acBins.map((c): AcItem => ({ kind: 'bin', code: c })),
    ...acSkus.map(([sku, v]): AcItem => ({ kind: 'sku', sku, name: v.name, total: v.total }))
  ]);

  function acSelect(item: AcItem) {
    acOpen = false;
    if (item.kind === 'bin') {
      lookupBin = item.code;
      lookupSku = '';
      query = item.code;
    } else {
      lookupSku = item.sku;
      lookupBin = '';
      query = item.sku;
    }
  }

  function onAcKeydown(e: KeyboardEvent) {
    if (!acOpen) return;
    if (e.key === 'ArrowDown') { acFocused = Math.min(acFocused + 1, acTotal - 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { acFocused = Math.max(acFocused - 1, 0); e.preventDefault(); }
    else if (e.key === 'Enter') { if (acFocused >= 0) acSelect(acItems[acFocused]); e.preventDefault(); }
    else if (e.key === 'Escape') acOpen = false;
  }

  const stats = $derived({
    docs: $inventory.filter((d) => !d.archived).length,
    skus: $skus.size,
    bins: $bins.size,
    open: $discrepancies.filter((d) => (d.status ?? 'open') === 'open').length
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
  {#if $authError}
    <div class="card" style="max-width:480px;border-color:var(--err)">
      <h3 style="color:var(--err)">Sign-in required</h3>
      <div class="small">{$authError}</div>
      <div class="small muted" style="margin-top:8px">Use the account pill (top-right) to sign in with the same email/password as the legacy app.</div>
    </div>
  {:else}
    <div class="empty"><span class="spin"></span> Syncing…</div>
  {/if}
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
      <div class="ac-wrap" style="margin-top:8px">
        <input class="input" placeholder="Search bin code or SKU / name…"
          bind:value={query}
          oninput={() => { acOpen = query.length >= 1; acFocused = -1; }}
          onkeydown={onAcKeydown}
          onfocus={() => query && acTotal && (acOpen = true)}
          onblur={() => setTimeout(() => (acOpen = false), 120)} />
        {#if acOpen && acTotal > 0}
          <div class="ac-drop">
            {#each acItems as item, i (item.kind === 'bin' ? `b:${item.code}` : `s:${item.sku}`)}
              <button class="ac-item {i === acFocused ? 'focus' : ''}" onclick={() => acSelect(item)}>
                {#if item.kind === 'bin'}
                  <span class="mono badge info">bin</span>
                  <span class="mono">{item.code}</span>
                {:else}
                  <span class="mono badge ok">sku</span>
                  <span style="flex:1">{item.name}</span>
                  <span class="mono muted small">T{item.total}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
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
          <span class="badge {(d.status ?? 'open') === 'open' ? 'err' : 'ok'}">{d.status ?? 'open'}</span>
          <span class="mono badge info">{d.sku}</span>
          <span class="grow small">{d.binCode ?? d.bin ?? ''}</span>
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
