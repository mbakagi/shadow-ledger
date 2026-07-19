<script lang="ts">
  /* Reusable camera scan box. Mount = camera on, destroy = camera off. */
  import { onMount, onDestroy } from 'svelte';
  import { startScanner, type ScannerHandle } from './scanner';

  let { onscan }: { onscan: (text: string) => void } = $props();

  let box: HTMLElement;
  let handle = $state<ScannerHandle | null>(null);
  let error = $state('');
  let engine = $state('');

  onMount(async () => {
    try {
      handle = await startScanner(box, onscan);
      engine = handle.engine;
    } catch (e) {
      error = (e as Error).message || 'Camera unavailable';
    }
  });

  onDestroy(() => {
    void handle?.stop();
  });
</script>

<div class="scanbox" bind:this={box}>
  {#if error}
    <div class="scan-hint">⚠ {error}<br /><span class="small">Check camera permission, or type the code manually.</span></div>
  {:else if !handle}
    <div class="scan-hint"><span class="spin"></span> Starting camera…</div>
  {/if}
</div>
{#if engine}<div class="small muted" style="margin-top:4px">engine: {engine}</div>{/if}
