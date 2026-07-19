<script lang="ts">
  import { base } from '$app/paths';
  import { skus, ready } from '$lib/store';
  import { buildIndex, makeFuse, debounce, type SearchItem } from '$lib/search';

  type FuseInst = Awaited<ReturnType<typeof makeFuse>>;

  let q = $state('');
  let fuse = $state<FuseInst | null>(null);
  let results = $state<SearchItem[]>([]);
  let searched = $state(false);
  let focused = $state(-1);
  let open = $state(false);

  $effect(() => {
    const list = buildIndex($skus);
    void makeFuse(list).then((f) => (fuse = f));
  });

  const run = debounce((query: string) => {
    searched = !!query;
    results = query && fuse ? fuse.search(query, { limit: 25 }).map((r) => r.item) : [];
    open = results.length > 0;
    focused = -1;
  }, 150);

  function select(item: SearchItem) {
    q = item.sku;
    open = false;
    location.href = `${base}/putaway?sku=${encodeURIComponent(item.sku)}`;
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'ArrowDown') { focused = Math.min(focused + 1, results.length - 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { focused = Math.max(focused - 1, 0); e.preventDefault(); }
    else if (e.key === 'Enter') { if (focused >= 0) select(results[focused]); e.preventDefault(); }
    else if (e.key === 'Escape') { open = false; }
  }
</script>

<h1 class="page-h">Search</h1>
<p class="page-sub">Fuzzy search over SKU, name, category, bin codes — 150ms debounce, zero Firestore reads per keystroke.</p>

<div class="ac-wrap" style="max-width:520px">
  <input class="input" placeholder="Type a SKU, name, category, or bin code…"
    value={q} oninput={(e) => run(e.currentTarget.value)}
    onkeydown={onKeydown}
    onfocus={() => results.length && (open = true)}
    onblur={() => setTimeout(() => (open = false), 120)} />

  {#if open && results.length}
    <div class="ac-drop">
      {#each results.slice(0, 8) as r, i (r.sku)}
        <button class="ac-item {i === focused ? 'focus' : ''}" onclick={() => select(r)}>
          <span class="mono badge info">{r.sku}</span>
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{r.name}</span>
          {#if r.category}<span class="badge warn">{r.category}</span>{/if}
          <span class="muted small mono">T{r.total}</span>
        </button>
      {/each}
      {#if results.length > 8}
        <div class="ac-item small muted" style="cursor:default">↓ {results.length - 8} more below</div>
      {/if}
    </div>
  {/if}
</div>

{#if !$ready}
  <div class="empty" style="margin-top:30px"><span class="spin"></span> Syncing…</div>
{:else if searched}
  <div style="margin-top:18px">
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
{/if}
