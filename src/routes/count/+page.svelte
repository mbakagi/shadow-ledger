<script lang="ts">
  import { get } from 'svelte/store';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import Scanner from '$lib/Scanner.svelte';
  import { bins, user } from '$lib/store';
  import { parseScan } from '$lib/qr';
  import { CountSession, type CountLine, type CountResult } from '$lib/count';
  import { toast } from '$lib/toast';

  let binCode = $state('');
  let scanning = $state(false);
  let lines = $state<CountLine[]>([]);
  let committing = $state(false);
  let progress = $state<[number, number]>([0, 0]);
  let result = $state<CountResult | null>(null);

  const counted = $derived(lines.filter((l) => l.counted !== null));
  const flagged = $derived(counted.filter((l) => (l.counted ?? 0) - l.expected !== 0));

  onMount(() => {
    const q = page.url.searchParams.get('bin');
    if (q) loadBin(q.toUpperCase());
  });

  function loadBin(code: string) {
    const docs = get(bins).get(code) ?? [];
    if (!docs.length) return toast(`No docs found at ${code}`, 'err');
    binCode = code;
    lines = docs.map((d) => ({ doc: d, expected: d.quantity, counted: null }));
    result = null;
  }

  function onScan(text: string) {
    const r = parseScan(text);
    if (r.kind === 'bin') {
      scanning = false;
      loadBin(r.bin);
    }
  }

  function setCounted(l: CountLine, v: number) {
    l.counted = Number.isNaN(v) ? null : Math.max(0, v);
  }

  async function commit() {
    const uid = $user?.uid;
    if (!uid) return toast('Not signed in yet', 'err');
    committing = true;
    progress = [0, 1];
    try {
      const s = new CountSession(binCode, []);
      s.lines = lines;
      result = await s.commit(uid, (done, total) => (progress = [done, total]));
      toast(`Committed: ${result.updated} updated, ${result.discrepancies} flagged`, 'ok');
      lines = [];
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      committing = false;
    }
  }
</script>

<h1 class="page-h">Cycle count</h1>
<p class="page-sub">Scan a bin QR, verify contents, commit — variances flag discrepancies automatically.</p>

<div class="card" style="margin-bottom:14px">
  {#if scanning}
    <Scanner onscan={onScan} />
  {:else}
    <div class="row">
      <div style="flex:1">
        <label class="lbl" for="bin-in">Bin code</label>
        <input id="bin-in" class="input mono" placeholder="R1-A1-B01-B04" bind:value={binCode}
          onkeydown={(e) => e.key === 'Enter' && loadBin(binCode.toUpperCase())} />
      </div>
      <button class="btn primary" onclick={() => loadBin(binCode.toUpperCase())}>Load</button>
      <button class="btn" onclick={() => (scanning = true)}>▣ Scan</button>
    </div>
  {/if}
</div>

{#if lines.length}
  <div class="card">
    <h3>{binCode} — {lines.length} expected doc(s)</h3>
    {#each lines as l (l.doc.id)}
      {@const v = (l.counted ?? 0) - l.expected}
      <div class="lrow">
        <span class="mono badge info">{l.doc.sku}</span>
        <span class="grow small">{l.doc.name}</span>
        <span class="mono small muted">exp {l.expected}</span>
        <input class="input qty-in" type="number" min="0" placeholder="count"
          value={l.counted ?? ''} oninput={(e) => setCounted(l, e.currentTarget.valueAsNumber)} />
        {#if l.counted !== null}
          <span class="badge {v === 0 ? 'ok' : 'err'}">{v === 0 ? '✓' : (v > 0 ? '+' : '') + v}</span>
        {:else}
          <span class="badge warn">—</span>
        {/if}
      </div>
    {/each}

    <div class="row" style="margin-top:14px; align-items:center">
      <button class="btn sm ghost" onclick={() => lines.forEach((l) => l.counted === null && setCounted(l, l.expected))}>
        Mark rest as expected
      </button>
      <span class="spacer" style="flex:1"></span>
      <span class="small muted">{counted.length}/{lines.length} counted · {flagged.length} flagged</span>
      <button class="btn primary" disabled={!counted.length || committing} onclick={commit}>
        {committing ? 'Committing…' : 'Commit count'}
      </button>
    </div>
    {#if committing}
      <div class="bar" style="margin-top:10px"><i style:width="{(progress[0] / progress[1]) * 100}%"></i></div>
    {/if}
  </div>
{/if}

{#if result}
  <div class="card" style="margin-top:14px">
    <h3>Committed</h3>
    <div class="small">count <span class="mono">{result.countId.slice(0, 8)}</span> · {result.updated} doc(s) updated ·
      {result.discrepancies} discrepanc{result.discrepancies === 1 ? 'y' : 'ies'} flagged</div>
  </div>
{/if}
