import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    // SPA mode: single prerendered shell, client-side routing (GitHub Pages safe)
    adapter: adapter({ fallback: 'index.html', precompress: false, strict: false })
  }
};

export default config;
