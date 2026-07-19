<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { bins } from '$lib/store';
  import { qrSvg, binDeepLink } from '$lib/qr';
  import { groupLabels, binMetadata, emptyBins, allCellCodes, type LabelGroup, type BinMeta } from '$lib/labelgen';
  import { parseBinCode } from '$lib/schema';

  // Occupied bins ∪ any codes passed via ?bins=
  let extra = $state<string[]>([]);
  onMount(() => {
    const q = page.url.searchParams.get('bins');
    if (q) extra = q.split(',').filter(Boolean);
  });

  const groups = $derived(groupLabels($bins));
  const occupiedSet = $derived(new Set($bins.keys()));

  let selected = $state<Set<string>>(new Set());

  // metadata for hovered/selected bin
  let previewCode = $state('');
  const preview = $derived.by(() => {
    if (!previewCode) return null;
    const docs = $bins.get(previewCode) ?? [];
    return binMetadata(previewCode, docs);
  });

  // Quick presets — from zones or empty bins
  let selectedRoom = $state('');
  let selectedAisle = $state('');

  const filteredGroups = $derived(
    groups.filter(
      (g) =>
        (!selectedRoom || g.room === selectedRoom) &&
        (!selectedAisle || g.aisle === selectedAisle)
    )
  );

  function addAll(group: string[]) {
    const s = new Set(selected);
    for (const c of group) s.add(c);
    selected = s;
  }

  // Empty-bin one-click (max 4x4 unless overridden)
  let maxBay = $state(5);
  let maxBin = $state(5);

  function addAllEmpty() {
    // derive rooms/aisles from occupied keys
    const rSet = new Set<string>();
    const aMap: Record<string, string[]> = {};
    for (const code of $bins.keys()) {
      const p = parseBinCode(code);
      if (!p.general && p.room && p.aisle) {
        rSet.add(p.room);
        (aMap[p.room] ??= []).push(p.aisle);
      }
    }
    const all = allCellCodes([...rSet], aMap, maxBay, maxBin);
    const s = new Set(selected);
    for (const c of all) {
      if (!$bins.has(c)) s.add(c);
    }
    selected = s;
  }

  // label sheet
  const sorted = $derived([...selected].sort());
  const cells = $derived(
    sorted.map((code) => {
      const docs = $bins.get(code) ?? [];
      const meta = binMetadata(code, docs);
      return { code, meta, svg: qrSvg(binDeepLink(code), 130) };
    })
  );

  const roomList = $derived([...new Set(groups.map((g) => g.room))].sort(
    (a, b) => a.localeCompare(b, undefined, { numeric: true })
  ));
</script>

<h1 class="page-h">Smart labels</h1>
<p class="page-sub">
  Zone-grouped bin selection with metadata. Quick presets for empty bins.
  <span class="pill">{$bins.size} occupied · {selected.size} on sheet</span>
</p>

<div class="grid cols-2">
  <!-- ── left: zone tree + selection ── -->
  <div class="card" style="max-height:64vh;overflow:auto">
    <div class="row" style="gap:6px;margin-bottom:10px">
      <button class="btn sm ghost" onclick={() => (selected = new Set())}>Clear</button>
      <button class="btn sm ghost" onclick={() => (selected = new Set([...occupiedSet]))}>All occupied</button>
      <button class="btn sm ghost" onclick={addAllEmpty}>All empty</button>
    </div>

    <div class="row" style="margin-bottom:10px;gap:6px">
      <div style="width:80px">
        <label class="lbl">Bays</label>
        <input class="input" type="number" min="2" max="20" bind:value={maxBay} />
      </div>
      <div style="width:80px">
        <label class="lbl">Bins</label>
        <input class="input" type="number" min="2" max="20" bind:value={maxBin} />
      </div>
    </div>

    <div class="row" style="gap:6px;margin-bottom:12px">
      <select class="input" style="width:100px" bind:value={selectedRoom}>
        <option value="">All rooms</option>
        {#each roomList as r (r)}<option value={r}>Room {r}</option>{/each}
      </select>
      <select class="input" style="width:100px" bind:value={selectedAisle}>
        <option value="">All aisles</option>
        {#each filteredGroups.map((g) => g.aisle) as a (a)}<option value={a}>Aisle {a}</option>{/each}
      </select>
    </div>

    {#each filteredGroups as g (g.room + g.aisle)}
      <div style="margin-bottom:8px">
        <div class="row" style="align-items:center">
          <span class="mono" style="font-weight:700">R{g.room}-A{g.aisle}</span>
          <span class="badge info" style="margin-left:8px">{g.occupied} filled</span>
          {#if g.empty}<span class="badge">{g.empty} empty</span>{/if}
          <span class="spacer" style="flex:1"></span>
          <button class="btn sm ghost" onclick={() => addAll(g.bins)}>+ all</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:2px;margin-top:4px">
          {#each g.bins as code (code)}
            <span
              class="badge {selected.has(code) ? 'ok' : ($bins.has(code) ? 'info' : '')}"
              style="cursor:pointer"
              role="checkbox"
              aria-checked={selected.has(code)}
              tabindex="0"
              onclick={() => {
                previewCode = code;
                const s = new Set(selected);
                if (s.has(code)) s.delete(code);
                else s.add(code);
                selected = s;
              }}
              onmouseenter={() => (previewCode = code)}>
              {code.split('-').at(-1) ?? code}
            </span>
          {/each}
        </div>
      </div>
    {/each}
  </div>

  <!-- ── right: preview + sheet ── -->
  <div class="card" style="overflow:auto">
    <div class="row" style="margin-bottom:10px;align-items:center">
      <h3 style="margin:0">Sheet · {cells.length} labels</h3>
      {#if cells.length}
        <span class="spacer" style="flex:1"></span>
        <button class="btn sm primary no-print" onclick={() => print()}>Print</button>
      {/if}
    </div>

    {#if preview}
      <div class="row" style="padding:8px 0;gap:16px;margin-bottom:12px;flex-wrap:wrap">
        <div><span class="lbl">Bin</span><span class="mono">{preview.code}</span></div>
        <div><span class="lbl">Occupancy</span>{preview.occupancy}/{preview.maxCapacity}</div>
        <div><span class="lbl">Total qty</span><span class="mono">{preview.totalQty}</span></div>
        <div><span class="lbl">Category</span><span class="badge info">{preview.topCategory}</span></div>
        {#if preview.golden}<span class="badge ok">golden zone</span>{/if}
      </div>
    {/if}

    <div class="qr-grid">
      {#each cells as c (c.code)}
        <div class="qr-cell">
          {@html c.svg}
          <div class="small mono" style="margin-top:6px">
            <b>{c.code}</b>
          </div>
          <div class="small muted mono">
            {c.meta.occupancy}/{c.meta.maxCapacity} · {c.meta.totalQty}u
          </div>
        </div>
      {:else}
        <div class="empty">Select bins on the left, or use a quick preset above.</div>
      {/each}
    </div>
  </div>
</div>
