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

/** Canonical bin code (production, per proofinv labels): `R{room}-A{aisle}-B{bay}-B{bin}`
 *  e.g. `R1-A1-B01-B04`. Tolerated variants: plain segments (`A-A1-01-01-F-STOCK`),
 *  colon labels (`ROOM-AISLE-BAY:02-…`), partials (`R1`, `R1-A1`), `GENERAL-…`. */
export interface BinParts {
  raw: string;
  general: boolean;
  room: string;
  aisle: string;
  bay: number;
  bin: number;
  level: string; // '' unless the old 6-segment format carries one ('F' = floor)
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
  const binCode = String(d.binCode ?? '') || synthesizeBinCode(d);
  return {
    id,
    sku: String(d.sku ?? ''),
    name: String(d.name ?? d.item_name ?? ''),
    category: String(d.category ?? ''),
    binCode,
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

/** Build the canonical code from per-bin location fields (proofinv format).
 *  Partial locations are legal: room-only → `R1`, +aisle → `R1-A1`, etc. */
export function synthesizeBinCode(d: Record<string, unknown>): string {
  const r = String(d.room ?? '').trim();
  const a = String(d.aisle ?? '').trim();
  const bay = String(d.bay ?? '').trim();
  const bin = String(d.bin ?? '').trim();
  if (!r && !a && !bay && !bin) return '';
  const parts: string[] = [];
  if (r) parts.push(`R${r}`);
  if (a) parts.push(`A${a}`);
  if (bay) parts.push(`B${bay.padStart(2, '0')}`);
  if (bin) parts.push(`B${bin.padStart(2, '0')}`);
  return parts.join('-');
}

/* Segment value: strip colon labels (`BAY:02`→`02`) and single letter prefixes
 * used by the canonical format (`R1`→`1`, `B01`→`01`). Aisle keeps letters. */
const seg = (s: string | undefined, stripPrefix: boolean) => {
  let v = String(s ?? '');
  if (v.includes(':')) v = v.slice(v.lastIndexOf(':') + 1);
  if (stripPrefix) v = v.replace(/^[A-Z]+(?=\d)/, '');
  return v;
};

export function parseBinCode(binCode: string): BinParts {
  const p = String(binCode || '').split('-');
  const general = p[0] === 'GENERAL';
  const g = general ? 1 : 0;
  const hasLevel = p.length - g >= 6; // old ROOM-AISLE-BAY-BIN-LEVEL-ACTION shape
  return {
    raw: binCode,
    general,
    room: seg(p[g], true),
    aisle: seg(p[g + 1], true),
    bay: parseInt(seg(p[g + 2], true), 10) || 0,
    bin: parseInt(seg(p[g + 3], true), 10) || 0,
    level: hasLevel ? seg(p[g + 4], false) : ''
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

/** Per-bin location fields (for cross-shape inspection/debug). */
export function locationFields(binCode: string) {
  const p = parseBinCode(binCode);
  return {
    room: p.room || '',
    aisle: p.aisle || '',
    bay: p.bay ? String(p.bay).padStart(2, '0') : '',
    bin: p.bin ? String(p.bin).padStart(2, '0') : ''
  };
}

/** proofinv normId — composite per-bin document ID. */
export function binDocId(sku: string, p: { room: string; aisle: string; bay: number; bin: number }) {
  return `${sku}_R${p.room}_A${p.aisle}_B${String(p.bay).padStart(2, '0')}_B${String(p.bin).padStart(2, '0')}`;
}

/** Canonical bin code from parsed parts: R{room}-A{aisle}-B{bay}-B{bin}. */
export function canonicalBinCode(p: { room: string; aisle: string; bay: number; bin: number }) {
  return `R${p.room}-A${p.aisle}-B${String(p.bay).padStart(2, '0')}-B${String(p.bin).padStart(2, '0')}`;
}
