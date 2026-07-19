/* Copies the SvelteKit build output to the repo root so GitHub Pages
 * (source: main / root) serves it — no repo-settings change required.
 * Legacy pages coexist because they are passed through static/. */
import { cpSync, copyFileSync, rmSync, readdirSync } from 'node:fs';

// Drop stale hashed assets from the previous deploy.
rmSync(new URL('../_app/', import.meta.url), { recursive: true, force: true });

const root = new URL('../', import.meta.url);
const build = new URL('../build/', import.meta.url);
for (const entry of readdirSync(build)) {
  cpSync(new URL(`../build/${entry}`, import.meta.url), new URL(`../${entry}`, import.meta.url), {
    recursive: true,
    force: true
  });
}
// GitHub Pages serves 404.html for unknown paths → SPA shell takes over routing.
copyFileSync(new URL('../build/index.html', import.meta.url), new URL('../404.html', import.meta.url));

console.log('Synced build/ → repo root for GitHub Pages.');
void root;
