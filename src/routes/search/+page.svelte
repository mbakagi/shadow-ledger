<script lang="ts">
  import { base } from '$app/paths';
  import { skus, ready } from '$lib/store';
  import { buildIndex, makeFuse, debounce, type SearchItem } from '$lib/search';

  type FuseInst = Awaited<ReturnType<typeof makeFuse>>;

  let q = $state('');
  let fuse = $state<FuseInst | null>(null);
  let results = $state<SearchItem[]>([]);
  let searched = $state(false);

  // Rebuild the local index whenever the Firestore snapshot changes.
  $effect(() => {
    const list = buildIndex($skus);
    void makeFuse(list).then((f) => (fuse = f));
  });

  const run = debounce((query: string) => {
    searched = !!query;
    results = query && fuse ? fuse.search(query, { limit: 25 }).map((r) => r.item) : [];
  }, 150);
</script>

<h1 class="page-h">Search</h1>
<p class="page-sub">Client-side fuzzy search over the local snapshot (150ms debounce, zero reads per keystroke).</p>

<input class="input" style="max-width:480px" placeholder="SKU, name, category, or bin…"
  value={q} oninput={(e) => run(e.currentTarget.value)} />

{#if !$ready}
  <div class="empty"><span class="spin"></span> Syncing…</div>
{:else if results.length}
  <div style="margin-top:14px">
    {#each results as r (r.sku)}
      <div class="lrow">
        <span class="mono badge info">{r.sku}</span>
        <span class="grow">{r.name}</span>
        {#if r.category}<span class="badge warn">{r.category}</span>{/if}
        <span class="mono small muted" title="bin(s)">{r.binCodes || '—'}</span>
        <span class="mono">T:{r.total}</span>
        <a class="btn sm ghost" href="{base}/putaway?sku={encodeURIComponent(r.sku)}">putaway</a>
      </div>
    {/each}
  </div>
{:else if searched}
  <div class="empty">No matches.</div>
{/if}
