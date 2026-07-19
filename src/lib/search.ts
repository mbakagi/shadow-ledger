/* Feature 6 — Search engine. Fuse.js (~12KB, dynamically imported by the page)
 * over the localized Firestore snapshot. Caller debounces input at 150ms. */
import type Fuse from 'fuse.js';

export interface SearchItem {
  sku: string;
  name: string;
  category: string;
  total: number;
  binCodes: string;
  docs: number;
}

export function buildIndex(
  skus: Map<string, { sku: string; name: string; category: string; total: number; docs: { binCode: string }[] }>
): SearchItem[] {
  return [...skus.values()].map((e) => ({
    sku: e.sku,
    name: e.name,
    category: e.category,
    total: e.total,
    docs: e.docs.length,
    binCodes: e.docs.map((d) => d.binCode).filter(Boolean).join(' ')
  }));
}

export async function makeFuse(list: SearchItem[]): Promise<Fuse<SearchItem>> {
  const { default: Fuse } = await import('fuse.js');
  return new Fuse(list, {
    keys: [
      { name: 'sku', weight: 0.5 },
      { name: 'name', weight: 0.3 },
      { name: 'category', weight: 0.12 },
      { name: 'binCodes', weight: 0.08 }
    ],
    threshold: 0.35,
    ignoreLocation: true
  });
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms = 150) {
  let t: ReturnType<typeof setTimeout>;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
