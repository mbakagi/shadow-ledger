/* Live Firestore snapshot stores (Svelte). One snapshot drives all panes —
 * identical pattern to the legacy app's startSync, so read costs stay flat. */
import { writable, derived, get } from 'svelte/store';
import { collection, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db, onUser, ensureAuth } from './firebase';
import { COL, parseInventory, type InventoryDoc } from './schema';

export const user = writable<User | null>(null);
export const online = writable(true);
export const inventory = writable<InventoryDoc[]>([]);
export const ready = writable(false);

export interface Discrepancy {
  id: string;
  sku: string;
  name: string;
  binCode: string;
  expected_qty: number; // legacy snake_case contract
  actual_qty: number;
  variance: number;
  status: string;
}
export const discrepancies = writable<Discrepancy[]>([]);

/** binCode → docs physically stored there (chaotic storage index). */
export const bins = derived(inventory, ($inv) => {
  const m = new Map<string, InventoryDoc[]>();
  for (const d of $inv) {
    if (d.archived || !d.binCode) continue;
    const arr = m.get(d.binCode) ?? [];
    arr.push(d);
    m.set(d.binCode, arr);
  }
  return m;
});

/** sku → aggregated view across its bin docs. */
export const skus = derived(inventory, ($inv) => {
  const m = new Map<string, { sku: string; name: string; category: string; total: number; docs: InventoryDoc[] }>();
  for (const d of $inv) {
    if (d.archived) continue;
    const e = m.get(d.sku) ?? { sku: d.sku, name: d.name, category: d.category, total: 0, docs: [] };
    e.total += d.totalStock;
    e.docs.push(d);
    m.set(d.sku, e);
  }
  return m;
});

let started = false;

/** Wire auth + snapshots. Idempotent. */
export function startSync() {
  if (started) return;
  started = true;

  online.set(navigator.onLine);
  addEventListener('online', () => online.set(true));
  addEventListener('offline', () => online.set(false));

  onUser(async (u) => {
    user.set(u);
    if (!u) {
      await ensureAuth();
      return;
    }
    onSnapshot(collection(db, COL.inventory), (snap) => {
      inventory.set(snap.docs.map((d) => parseInventory(d.id, d.data())));
      ready.set(true);
    });
    onSnapshot(
      query(collection(db, COL.discrepancies), orderBy('countedAt', 'desc'), limit(20)),
      (snap) => discrepancies.set(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Discrepancy, 'id'>) }))),
      () => discrepancies.set([])
    );
  });
}

/** Non-reactive accessor for one-shot reads. */
export const snapshotInventory = () => get(inventory);
