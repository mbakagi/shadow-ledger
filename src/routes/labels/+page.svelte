<script lang="ts">
  import { bins } from '$lib/store';
  import { qrSvg, binDeepLink } from '$lib/qr';

  const allBins = $derived([...$bins.keys()].sort());
  let selected = $state<Set<string>>(new Set());

  function toggle(b: string) {
    const s = new Set(selected);
    if (s.has(b)) {
      s.delete(b);
    } else {
      s.add(b);
    }
    selected = s;
  }

  const cells = $derived(
    [...selected].sort().map((b) => ({ bin: b, svg: qrSvg(binDeepLink(b), 140) }))
  );
</script>

<h1 class="page-h">Bin QR labels</h1>
<p class="page-sub">Deep-link <span class="mono">sl://bin/&#123;id&#125;</span> codes for the floor. Print and stick.</p>

<div class="grid cols-2">
  <div class="card no-print" style="max-height:60vh;overflow:auto">
    <h3>
      Bins ({selected.size}/{allBins.length})
      <button class="btn sm ghost" onclick={() => (selected = new Set(allBins))}>all</button>
      <button class="btn sm ghost" onclick={() => (selected = new Set())}>none</button>
    </h3>
    {#each allBins as b (b)}
      <label class="lrow" style="cursor:pointer">
        <input type="checkbox" checked={selected.has(b)} onchange={() => toggle(b)} />
        <span class="mono small grow">{b}</span>
        <span class="small muted">{($bins.get(b) ?? []).length}</span>
      </label>
    {/each}
  </div>

  <div class="card">
    <h3>
      Sheet
      {#if cells.length}<button class="btn sm primary no-print" onclick={() => print()}>Print</button>{/if}
    </h3>
    <div class="qr-grid">
      {#each cells as c (c.bin)}
        <div class="qr-cell">
          {@html c.svg}
          <div class="small mono" style="margin-top:6px">{c.bin}</div>
        </div>
      {:else}
        <div class="empty">Select bins to build the sheet.</div>
      {/each}
    </div>
  </div>
</div>
