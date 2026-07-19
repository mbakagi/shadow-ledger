<script lang="ts">
  /* Bins explorer — proofinv-style room → aisle → bay×bin occupancy grid. */
  import { base } from '$app/paths';
  import { bins } from '$lib/store';
  import { parseBinCode, canonicalBinCode } from '$lib/schema';

  interface GridInfo {
    rooms: string[];
    aislesByRoom: Map<string, string[]>;
    maxBay: number;
    maxBin: number;
  }

  const grid = $derived.by((): GridInfo => {
    const rooms = new Set<string>();
    const aislesByRoom = new Map<string, Set<string>>();
    let maxBay = 4;
    let maxBin = 4;
    for (const code of $bins.keys()) {
      const p = parseBinCode(code);
      if (p.general || !p.room || !p.aisle) continue;
      rooms.add(p.room);
      if (!aislesByRoom.has(p.room)) aislesByRoom.set(p.room, new Set());
      aislesByRoom.get(p.room)!.add(p.aisle);
      maxBay = Math.max(maxBay, p.bay);
      maxBin = Math.max(maxBin, p.bin);
    }
    const nat = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
    return {
      rooms: [...rooms].sort(nat),
      aislesByRoom: new Map([...aislesByRoom].map(([r, s]) => [r, [...s].sort(nat)])),
      maxBay,
      maxBin
    };
  });

  let room = $state('');
  let aisle = $state('');
  $effect(() => {
    if (!room && grid.rooms.length) room = grid.rooms[0];
  });
  $effect(() => {
    const aisles = grid.aislesByRoom.get(room) ?? [];
    if (room && !aisles.includes(aisle)) aisle = aisles[0] ?? '';
  });

  let selected = $state<Set<string>>(new Set());
  let inspected = $state('');

  const cellCode = (bay: number, bin: number) =>
    canonicalBinCode({ room, aisle, bay, bin });
  const cellDocs = (code: string) => $bins.get(code) ?? [];
  const inspectedDocs = $derived(inspected ? cellDocs(inspected) : []);

  function click(code: string) {
    inspected = code;
    const s = new Set(selected);
    if (s.has(code)) {
      s.delete(code);
    } else {
      s.add(code);
    }
    selected = s;
  }

  const labelsHref = $derived(`${base}/labels?bins=${[...selected].map(encodeURIComponent).join(',')}`);
  const countHref = $derived(inspected ? `${base}/count?bin=${encodeURIComponent(inspected)}` : '');
</script>

<h1 class="page-h">Bins explorer</h1>
<p class="page-sub">Occupancy grid per room/aisle. Click cells to select — generate labels or jump to count.</p>

<div class="row" style="margin-bottom:14px">
  <div>
    <label class="lbl" for="room-sel">Room</label>
    <select id="room-sel" class="input" bind:value={room}>
      {#each grid.rooms as r (r)}<option value={r}>Room {r}</option>{/each}
    </select>
  </div>
  <div>
    <label class="lbl" for="aisle-sel">Aisle</label>
    <select id="aisle-sel" class="input" bind:value={aisle}>
      {#each grid.aislesByRoom.get(room) ?? [] as a (a)}<option value={a}>Aisle {a}</option>{/each}
    </select>
  </div>
  <span class="spacer" style="flex:1"></span>
  <span class="pill">{selected.size} selected</span>
  {#if selected.size}
    <a class="btn primary sm" href={labelsHref}>🏷 Labels</a>
    <button class="btn ghost sm" onclick={() => (selected = new Set())}>Clear</button>
  {/if}
</div>

{#if room && aisle}
  <div class="grid cols-2">
    <div class="card" style="overflow:auto">
      <h3>R{room}-A{aisle} · {grid.maxBay} bays × {grid.maxBin} bins</h3>
      <div class="bin-grid" style:grid-template-columns={`60px repeat(${grid.maxBin}, minmax(64px,1fr))`}>
        <span></span>
        {#each Array(grid.maxBin) as _, bi (bi)}
          <span class="bin-axis">B{String(bi + 1).padStart(2, '0')}</span>
        {/each}
        {#each Array(grid.maxBay) as _, ba (ba)}
          <span class="bin-axis">B{String(ba + 1).padStart(2, '0')}</span>
          {#each Array(grid.maxBin) as _, bi (bi)}
            {@const code = cellCode(ba + 1, bi + 1)}
            {@const n = cellDocs(code).length}
            <button
              class="bin-cell {n ? 'full' : ''} {selected.has(code) ? 'sel' : ''}"
              title={code}
              onclick={() => click(code)}>
              <span class="bin-cell-n">{n || ''}</span>
            </button>
          {/each}
        {/each}
      </div>
      <div class="small muted" style="margin-top:8px">number = docs stored · shaded = occupied</div>
    </div>

    <div class="card">
      <h3>
        {inspected || 'Inspect'}
        {#if inspected}<a class="btn sm ghost" href={countHref}>Count this bin</a>{/if}
      </h3>
      {#if inspected}
        {#each inspectedDocs as d (d.id)}
          <div class="lrow">
            <span class="mono badge info">{d.sku}</span>
            <span class="grow small">{d.name}</span>
            <span class="mono">×{d.quantity}</span>
            <a class="btn sm ghost" href="{base}/putaway?sku={encodeURIComponent(d.sku)}">move</a>
          </div>
        {:else}
          <div class="empty">Empty bin — still label-able.</div>
        {/each}
      {:else}
        <div class="empty">Click a cell to inspect its contents.</div>
      {/if}
    </div>
  </div>
{:else}
  <div class="empty">No located bins in inventory yet.</div>
{/if}
