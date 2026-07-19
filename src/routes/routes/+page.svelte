<script lang="ts">
  import { bins } from '$lib/store';
  import { compareRoutes, planRoute, METHOD_LABELS, type RouteMethod, type RouteResult } from '$lib/routemap';

  const AISLE_STEP = 56; const BAY_STEP = 16; const PAD = 40;
  const gxFn = (ai: number) => ai * AISLE_STEP + PAD;
  const gyFn = (bay: number, maxBay: number) => (maxBay - bay) * BAY_STEP + PAD;

  const allBins = $derived([...$bins.keys()].sort());
  let selected = $state<Set<string>>(new Set());

  let method: RouteMethod = $state('s-shaped');
  let planned = $state<RouteResult | null>(null);
  let comparisons = $state<RouteResult[]>([]);

  function toggle(b: string) {
    const s = new Set(selected);
    if (s.has(b)) s.delete(b);
    else if (s.size < 30) s.add(b);
    selected = s;
  }

  function plan() {
    planned = planRoute([...selected], $bins, method);
    comparisons = compareRoutes([...selected], $bins);
  }
</script>

<h1 class="page-h">Route mapping</h1>
<p class="page-sub">
  Research-grade picking algorithms. S‑shaped traversal is the warehouse gold standard (Roodbergen & De Koster, 2001).
</p>

<div class="grid cols-2">
  <div class="card" style="max-height:60vh;overflow:auto">
    <div class="row" style="align-items:center;gap:8px;margin-bottom:10px">
      <h3 style="margin:0">Stops ({selected.size}/30)</h3>
      <span class="spacer" style="flex:1"></span>
      <button class="btn sm primary" disabled={!selected.size} onclick={plan}>Plan</button>
      <button class="btn sm ghost" onclick={() => { selected = new Set(); planned = null; comparisons = []; }}>clear</button>
    </div>

    <select class="input" style="margin-bottom:10px" bind:value={method}>
      {#each Object.entries(METHOD_LABELS) as [k, v] (k)}
        <option value={k}>{v}</option>
      {/each}
    </select>

    {#each allBins as b (b)}
      <label class="lrow" style="cursor:pointer">
        <input type="checkbox" checked={selected.has(b)} onchange={() => toggle(b)} />
        <span class="mono small grow">{b}</span>
        <span class="small muted">{($bins.get(b) ?? []).length}</span>
      </label>
    {/each}
  </div>

  <div class="card" style="overflow:auto">
    {#if comparisons.length}
      <h3>Comparison · Room {comparisons[0].room}</h3>
      <div class="row" style="gap:8px;margin-bottom:12px">
        {#each comparisons as r (r.method)}
          <div class="card" style="padding:10px;flex:1;min-width:130px;text-align:center;
            border-color:{r.method === method ? 'var(--acc)' : 'var(--line)'}">
            <div class="small">{METHOD_LABELS[r.method]}</div>
            <div class="stat" style="font-size:20px">{r.totalDistance}u</div>
            {#if r.method === comparisons[0].method}<span class="badge ok">best</span>{/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if planned}
      <h3>
        {METHOD_LABELS[planned.method]} · {planned.stops.length} stops · <span class="mono">{planned.totalDistance}u</span>
      </h3>
      <svg viewBox="0 0 {planned.gridW} {planned.gridH}" style="width:100%;background:var(--bg-3);border-radius:8px"
        role="img" aria-label="Picking route for Room {planned.room} using {METHOD_LABELS[planned.method]}">

        <!-- grid lines: aisle separators + bay lines -->
        {#each planned.aisles as a, i (a)}
          {#if i > 0}
            <line x1={gxFn(i)} y1={0} x2={gxFn(i)} y2={planned.gridH} stroke="var(--line)" stroke-width="1"
              stroke-dasharray="4,4" opacity="0.5" />
          {/if}
          <text x={gxFn(i)} y={planned.gridH - 8} fill="var(--ink-3)" font-size="9" text-anchor="middle"
            font-family="var(--mono)">{a}</text>
        {/each}
        {#each Array(planned.maxBay + 1) as _, bi (bi)}
          <line x1={0} y1={gyFn(bi, planned.maxBay)} x2={planned.gridW} y2={gyFn(bi, planned.maxBay)}
            stroke="var(--line)" stroke-width="1" stroke-dasharray="4,4" opacity="0.5" />
        {/each}

        <!-- occupied dots -->
        {#each planned.occupied as o (`${o.x}-${o.y}`)}
          <circle cx={o.x} cy={o.y} r={Math.min(6, 2 + o.n * 1.2)}
            fill={o.n > 2 ? 'var(--acc)' : 'var(--line)'} opacity={o.n > 2 ? 0.5 : 0.7} />
        {/each}

        <!-- path -->
        <path d={planned.svgPath} fill="none" stroke="var(--acc-2)" stroke-width="2.8" stroke-linejoin="round"
          stroke-linecap="round" opacity="0.9" />

        <!-- stop markers with directional triangle -->
        {#each planned.stops as s, i (s.bin)}
          <circle cx={s.x} cy={s.y} r="10" fill="var(--acc)" />
          <text x={s.x} y={s.y + 3} fill="#fff" font-size="9" text-anchor="middle" font-weight="700">{s.n}</text>
        {/each}

        <!-- start / end markers -->
        {#if planned.stops.length > 1}
          {@const first = planned.stops[0]}
          <circle cx={first.x} cy={first.y} r="13" fill="none" stroke="var(--ok)" stroke-width="3" />
          <text x={first.x} y={first.y + 22} fill="var(--ok)" font-size="10" text-anchor="middle"
            font-weight="700">START</text>
          {@const last = planned.stops[planned.stops.length - 1]}
          <rect x={last.x - 10} y={last.y - 10} width="20" height="20" fill="none" stroke="var(--err)"
            stroke-width="3" rx="3" />
          <text x={last.x} y={last.y + 22} fill="var(--err)" font-size="10" text-anchor="middle"
            font-weight="700">END</text>
        {/if}
      </svg>

      <div style="margin-top:10px;max-height:200px;overflow:auto">
        {#each planned.stops as s (s.bin)}
          <div class="lrow"><span class="badge info">{s.n}</span><span class="mono small grow">{s.bin}</span></div>
        {/each}
      </div>
    {:else}
      <div class="empty">{selected.size ? 'Press Plan to compute the route.' : 'Pick stops on the left.'}</div>
    {/if}
  </div>
</div>
