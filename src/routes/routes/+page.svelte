<script lang="ts">
  import { bins } from '$lib/store';
  import { planRoute } from '$lib/routemap';

  const allBins = $derived([...$bins.keys()].sort());
  let selected = $state<Set<string>>(new Set());
  let planned = $state<ReturnType<typeof planRoute>>(null);

  function toggle(b: string) {
    const s = new Set(selected);
    if (s.has(b)) {
      s.delete(b);
    } else if (s.size < 24) {
      s.add(b);
    }
    selected = s;
    planned = null;
  }

  const W = $derived(planned ? planned.aisles.length * 56 + 60 : 0);
  const H = $derived(planned ? (planned.maxBay + 2) * 16 + 60 : 0);
</script>

<h1 class="page-h">Route mapping</h1>
<p class="page-sub">A* pick-path over the aisle×bay grid, weighted by aisle congestion. Select stops → plan.</p>

<div class="grid cols-2">
  <div class="card" style="max-height:60vh;overflow:auto">
    <h3>
      Stops ({selected.size}/24)
      <button class="btn sm primary" disabled={!selected.size} onclick={() => (planned = planRoute([...selected], $bins))}>Plan</button>
      <button class="btn sm ghost" onclick={() => { selected = new Set(); planned = null; }}>clear</button>
    </h3>
    {#each allBins as b (b)}
      <label class="lrow" style="cursor:pointer">
        <input type="checkbox" checked={selected.has(b)} onchange={() => toggle(b)} />
        <span class="mono small grow">{b}</span>
        <span class="small muted">{($bins.get(b) ?? []).length}</span>
      </label>
    {/each}
  </div>

  <div class="card" style="overflow:auto">
    {#if planned}
      <h3>
        Room {planned.room} · {planned.orderedBinIds.length} stops ·
        <span class="mono">{planned.totalDistance}u</span>
      </h3>
      <svg viewBox="0 0 {W} {H}" style="width:100%;background:var(--bg-3);border-radius:8px" role="img">
        {#each planned.aisles as a, i (a)}
          <text x={i * 56 + 30} y={H - 8} fill="var(--ink-3)" font-size="9" text-anchor="middle" font-family="var(--mono)">{a}</text>
        {/each}
        {#each planned.occupied as o (`${o.x}-${o.y}`)}
          <circle cx={o.x} cy={o.y} r="4" fill="var(--line)" />
        {/each}
        <path d={planned.svgPath} fill="none" stroke="var(--acc)" stroke-width="2.5" stroke-linejoin="round" opacity="0.9" />
        {#each planned.stops as s (s.bin)}
          <circle cx={s.x} cy={s.y} r="9" fill="var(--acc)" />
          <text x={s.x} y={s.y + 3} fill="#fff" font-size="9" text-anchor="middle" font-weight="700">{s.n}</text>
        {/each}
      </svg>
      <div style="margin-top:10px">
        {#each planned.stops as s (s.bin)}
          <div class="lrow"><span class="badge info">{s.n}</span><span class="mono small grow">{s.bin}</span></div>
        {/each}
      </div>
    {:else}
      <div class="empty">{selected.size ? 'Press Plan to compute the route.' : 'Pick stop bins on the left.'}</div>
    {/if}
  </div>
</div>
