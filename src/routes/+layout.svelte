<script lang="ts">
  import '$lib/styles.css';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { base } from '$app/paths';
  import { startSync, user, online } from '$lib/store';
  import { completeEmailLink, sendEmailLink } from '$lib/firebase';
  import { toasts, toast } from '$lib/toast';

  let { children } = $props();

  const nav = [
    ['/', 'Home'],
    ['/search', 'Search'],
    ['/putaway', 'Putaway'],
    ['/count', 'Count'],
    ['/routes', 'Routes'],
    ['/editor', 'Editor'],
    ['/labels', 'Labels']
  ] as const;

  let email = $state('');
  let linkSent = $state(false);

  onMount(() => {
    startSync();
    void completeEmailLink().then((u) => u && toast(`Signed in as ${u.email}`, 'ok'));
  });

  async function sendLink() {
    if (!email) return;
    try {
      await sendEmailLink(email);
      linkSent = true;
      toast('Sign-in link sent', 'ok');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  }

  const userLabel = $derived(
    $user ? ($user.isAnonymous ? `anon·${$user.uid.slice(0, 6)}` : ($user.email ?? 'user')) : '…'
  );
</script>

<header class="topbar">
  <span class="brand"><img src="{base}/icon.svg" alt="" /> Shadow Ledger</span>
  <nav class="nav">
    {#each nav as [path, label] (path)}
      <a href={path} class:active={page.url.pathname === path}>{label}</a>
    {/each}
  </nav>
  <span class="spacer"></span>
  <span class="pill {$online ? 'ok' : 'err'}">{$online ? 'online' : 'offline'}</span>
  <details class="authpop">
    <summary class="pill">{userLabel}</summary>
    <div class="card pop">
      {#if $user && !$user.isAnonymous}
        <div class="small">Signed in as <b>{$user.email}</b></div>
      {:else if linkSent}
        <div class="small">Check your inbox for the sign-in link.</div>
      {:else}
        <label class="lbl" for="auth-email">Email sign-in link</label>
        <input id="auth-email" class="input" type="email" placeholder="you@example.com" bind:value={email} />
        <button class="btn primary sm" style="margin-top:8px" onclick={sendLink}>Send link</button>
      {/if}
    </div>
  </details>
</header>

<main class="shell">
  {@render children()}
</main>

<div class="toasts">
  {#each $toasts as t (t.id)}
    <div class="toast {t.kind}">{t.msg}</div>
  {/each}
</div>
