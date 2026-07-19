/* Legacy production schema mapping — OVERRIDES the generic blueprint.
 * Derived from app.js / proofinv.html / mobile.html usage against ledger-d57da.
 *
 * Rules honored:
 *  - Never destructive writes: callers must use updateDoc() or setDoc(…, {merge:true}).
 *  - Firestore rejects `undefined`: every parsed field carries a fallback (§6.3).
 */

export const COL = {
  inventory: 'inventory', // flat docs; one doc per physical bin, SKU may repeat
  locations: 'locations', // { id: 'depot'|'building'|…, name, order }
  transactions: 'transactions',
  discrepancies: 'discrepancies',
  counts: 'counts' // blueprint collection — no legacy conflict
} as const;

export const LOC = { DEPOT: 'depot', BUILDING: 'building' } as const;

/** Canonical bin code: ROOM-AISLE-BAY-BIN-LEVEL-ACTION, e.g. `A-A1-01-01-F-STOCK`.
 *  Tolerates the labeled spec variant `ROOM-AISLE-BAY:02-BIN:02-LEVEL-STOCK`.
 *  `GENERAL-…` zones are unstructured and always sort last. */
export interface BinParts {
  raw: string;
  general: boolean;
  room: string;
  aisle: string;
  bay: number;
  bin: number;
  level: string; // 'F' = floor
}

export interface InventoryDoc {
  id: string;
  sku: string;
  name: string;
  category: string;
  binCode: string; // '' when unassigned
  datasheetUrl: string;
  /** true = proofinv per-bin doc shape ({quantity, room/aisle/bay/bin, updated_at});
   *  false = scalar aggregate ({totalStock/buildingStock/depotStock}). */
  isPerBin: boolean;
  /** On-hand qty at this bin (quantity for per-bin, buildingStock for scalar). */
  quantity: number;
  // Scalar invariant (§app.js reconcileStock): totalStock = buildingStock + depotStock
  totalStock: number;
  buildingStock: number;
  depotStock: number;
  carrierTrigger: number;
  purchasingTrigger: number;
  maxCapacity: number;
  archived: boolean;
}

const PER_BIN_ID = /^[A-Za-z0-9\-_.]+_R[^_]+_A[^_]+_B[^_]+_B[^_]+$/;

/** Defensive parse of a legacy inventory document (both production shapes). */
export function parseInventory(id: string, d: Record<string, unknown>): InventoryDoc {
  const num = (v: unknown) => Math.max(0, Number(v) || 0);
  const isPerBin = PER_BIN_ID.test(id) || 'quantity' in d;
  return {
    id,
    sku: String(d.sku ?? ''),
    name: String(d.name ?? d.item_name ?? ''),
    category: String(d.category ?? ''),
    binCode: String(d.binCode ?? ''),
    datasheetUrl: String(d.datasheetUrl ?? ''),
    isPerBin,
    quantity: isPerBin ? num(d.quantity) : num(d.buildingStock),
    totalStock: num(d.totalStock ?? d.quantity),
    buildingStock: num(d.buildingStock ?? d.quantity),
    depotStock: num(d.depotStock),
    carrierTrigger: num(d.carrierTrigger),
    purchasingTrigger: num(d.purchasingTrigger),
    maxCapacity: num(d.maxCapacity),
    archived: d.archived === true
  };
}

const seg = (s: string | undefined) => {
  const v = String(s ?? '');
  return v.includes(':') ? v.slice(v.lastIndexOf(':') + 1) : v;
};

export function parseBinCode(binCode: string): BinParts {
  const p = String(binCode || '').split('-');
  const general = p[0] === 'GENERAL';
  return {
    raw: binCode,
    general,
    room: seg(p[general ? 1 : 0]),
    aisle: seg(p[general ? 2 : 1]),
    bay: parseInt(seg(p[general ? 3 : 2]), 10) || 0,
    bin: parseInt(seg(p[general ? 4 : 3]), 10) || 0,
    level: seg(p[general ? 5 : 4])
  };
}

export const normalizeRoom = (r: string) => {
  const m = String(r).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 99;
};

export const normalizeAisle = (a: string) => {
  const m = String(a).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : String(a).charCodeAt(0) || 99;
};

/** F(loor)=1, level n → n+1. Golden zone = 2..4. */
export const levelValue = (l: string) => {
  if (!l) return 3;
  if (String(l).toUpperCase() === 'F') return 1;
  const n = parseInt(l, 10);
  return Number.isNaN(n) ? 3 : n + 1;
};

export const isGoldenZone = (binCode: string) => {
  const p = parseBinCode(binCode);
  const lvl = p.general ? 3 : levelValue(p.level);
  return lvl >= 2 && lvl <= 4;
};

/** Re-derive indexed warehouse fields when (re)assigning a bin (per §6.5 backfill). */
export function warehouseFields(binCode: string) {
  const p = parseBinCode(binCode);
  return {
    warehouseRoom: p.room || null,
    warehouseAisle: p.aisle || null,
    warehouseBay: p.bay ? String(p.bay).padStart(2, '0') : null,
    warehouseBin: p.bin ? String(p.bin).padStart(2, '0') : null,
    warehouseLevel: p.level || null
  };
}
