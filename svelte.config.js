import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    // GitHub Pages project site: https://mbakagi.github.io/shadow-ledger
    paths: { base: '/shadow-ledger' },
    // SPA mode: single prerendered shell, client-side routing (GitHub Pages safe)
    adapter: adapter({ fallback: 'index.html', precompress: false, strict: false })
  }
};

export default config;
