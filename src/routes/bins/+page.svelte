<script lang="ts">
  /* Bins explorer — proofinv-style room→aisle→bay×bin occupancy grid.
   * Rooms and aisles can be added (localStorage). Click an empty cell to
   * create an item directly at that bin. */
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import { bins } from '$lib/store';
  import { parseBinCode, canonicalBinCode } from '$lib/schema';
  import { createBinDoc } from '$lib/creator';
  import { toast } from '$lib/toast';

  const LS_ROOMS = 'sl-rooms';
  const LS_AISLES = 'sl-aisles'; // stored as JSON: { [room]: string[] }

  // ── merge localStorage rooms / aisles with the live snapshot ──
  let lsRooms = $state<string[]>([]);
  let lsAisles = $state<Record<string, string[]>>({});
  onMount(() => {
    try {
      lsRooms = JSON.parse(localStorage.getItem(LS_ROOMS) ?? '[]');
    } catch { lsRooms = []; }
    try {
      lsAisles = JSON.parse(localStorage.getItem(LS_AISLES) ?? '{}');
    } catch { lsAisles = {}; }
  });

  function persistRooms() { localStorage.setItem(LS_ROOMS, JSON.stringify(lsRooms)); }
  function persistAisles() { localStorage.setItem(LS_AISLES, JSON.stringify(lsAisles)); }

  interface GridInfo {
    rooms: string[];
    aislesByRoom: Map<string, string[]>;
    maxBay: number;
    maxBin: number;
  }

  const grid = $derived.by((): GridInfo => {
    const rooms = new Set(lsRooms);
    const aislesByRoom = new Map<string, Set<string>>();
    let maxBay = 4;
    let maxBin = 4;
    for (const room of rooms) {
      aislesByRoom.set(room, new Set(lsAisles[room] ?? []));
    }
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

  // Adding rooms / aisles
  let newRoom = $state('');
  let newAisleFor = $state('');
  let newAisleVal = $state('');

  function addRoom() {
    const v = newRoom.trim().toUpperCase();
    if (!v || lsRooms.includes(v)) { newRoom = ''; return; }
    lsRooms.push(v); persistRooms();
    room = v;
    newRoom = '';
  }
  function addAisle(roomId: string) {
    const v = newAisleVal.trim().toUpperCase();
    if (!v) return;
    const arr = lsAisles[roomId] ?? [];
    if (arr.includes(v)) { newAisleVal = ''; return; }
    lsAisles[roomId] = arr.concat(v); persistAisles();
    aisle = v;
    newAisleFor = '';
    newAisleVal = '';
  }

  // ── grid cell selection + create-item form ──
  let selected = $state<Set<string>>(new Set());
  let inspected = $state('');

  let creating = $state(false);
  let newSku = $state('');
  let newName = $state('');
  let newQty = $state(1);

  const cellCode = (bay: number, bin: number) =>
    canonicalBinCode({ room, aisle, bay, bin });
  const cellDocs = (code: string) => $bins.get(code) ?? [];
  const inspectedDocs = $derived(inspected ? cellDocs(inspected) : []);

  function click(code: string) {
    creating = false; // close any open form
    inspected = code;
    const s = new Set(selected);
    if (s.has(code)) {
      s.delete(code);
    } else {
      s.add(code);
    }
    selected = s;
  }

  function openCreate(code: string) {
    inspected = code;
    creating = true;
    newSku = '';
    newName = '';
    newQty = 1;
  }

  async function doCreate(code: string) {
    if (!newSku.trim()) return toast('SKU is required', 'err');
    try {
      await createBinDoc(newSku.trim().toUpperCase(), newName.trim() || newSku.trim(), code, newQty);
      toast(`Created ${newSku} at ${code}`, 'ok');
      creating = false;
      newSku = '';
      newName = '';
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  }

  const labelsHref = $derived(`${base}/labels?bins=${[...selected].map(encodeURIComponent).join(',')}`);
  const countHref = $derived(inspected ? `${base}/count?bin=${encodeURIComponent(inspected)}` : '');
</script>

<h1 class="page-h">Bins explorer</h1>
<p class="page-sub">Occupancy grid per room/aisle. Add rooms/aisles, create items in empty cells.</p>

<!-- ── manage rooms + aisles ── -->
<div class="row" style="margin-bottom:10px;flex-wrap:wrap;gap:8px">
  <div class="row" style="gap:6px">
    <input class="input" style="width:100px" placeholder="Room ID" bind:value={newRoom}
      onkeydown={(e) => e.key === 'Enter' && addRoom()} />
    <button class="btn sm" onclick={addRoom}>+ Room</button>
  </div>
  <div class="row" style="gap:6px">
    <select class="input" style="width:100px" bind:value={newAisleFor}>
      <option value="">in…</option>
      {#each grid.rooms as r (r)}<option value={r}>Room {r}</option>{/each}
    </select>
    <input class="input" style="width:100px" placeholder="Aisle ID" bind:value={newAisleVal}
      onkeydown={(e) => e.key === 'Enter' && addAisle(newAisleFor)} />
    <button class="btn sm" disabled={!newAisleFor} onclick={() => addAisle(newAisleFor)}>+ Aisle</button>
  </div>
</div>

<!-- ── room / aisle selectors ── -->
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
              onclick={() => click(code)}
              ondblclick={() => openCreate(code)}>
              <span class="bin-cell-n">{n || ''}</span>
            </button>
          {/each}
        {/each}
      </div>
      <div class="small muted" style="margin-top:8px">number = docs stored · shaded = occupied · <b>double-click</b> empty cell to create item</div>
    </div>

    <div class="card">
      <h3>
        {inspected || 'Inspect'}
        {#if inspected}
          <a class="btn sm ghost" href={countHref}>Count this bin</a>
          {#if !cellDocs(inspected).length}
            <button class="btn sm primary" onclick={() => openCreate(inspected)}>+ New item here</button>
          {/if}
        {/if}
      </h3>

      {#if creating && inspected}
        <div class="inline-form" style="margin-bottom:12px">
          <input class="input" style="width:110px" placeholder="SKU" bind:value={newSku} />
          <input class="input" style="width:140px" placeholder="Name" bind:value={newName} />
          <input class="input" style="width:70px" type="number" min="1" bind:value={newQty} />
          <button class="btn primary sm" onclick={() => doCreate(inspected)}>Create</button>
          <button class="btn ghost sm" onclick={() => (creating = false)}>✕</button>
        </div>
      {/if}

      {#if inspected}
        {#each inspectedDocs as d (d.id)}
          <div class="lrow">
            <span class="mono badge info">{d.sku}</span>
            <span class="grow small">{d.name}</span>
            <span class="mono">×{d.quantity}</span>
            <a class="btn sm ghost" href="{base}/putaway?sku={encodeURIComponent(d.sku)}">move</a>
          </div>
        {:else}
          {#if !creating}
            <div class="empty">Empty bin — double-click to create an item here.</div>
          {/if}
        {/each}
      {:else}
        <div class="empty">Click a cell to inspect its contents.</div>
      {/if}
    </div>
  </div>
{:else}
  <div class="empty">No rooms yet. Add one above to get started.</div>
{/if}
