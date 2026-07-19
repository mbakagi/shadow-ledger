/* Smart label generator — zone grouping, bin metadata, empty-bin enumeration.
 * Inspired by FBA slotting: labels grouped by zone, enriched with metadata
 * (occupancy, last counted, category affinity), and one-click presets. */
import { parseBinCode, isGoldenZone, type InventoryDoc } from './schema';

export interface LabelGroup {
  room: string;
  aisle: string;
  bins: string[]; // sorted pick-path (bay then bin)
  occupied: number;
  empty: number;
}

export interface BinMeta {
  code: string;
  occupancy: number; // doc count
  totalQty: number;
  maxCapacity: number;
  lastCounted?: string;
  topCategory: string;
  golden: boolean;
}

/** Group bins by room→aisle, sorted in pick-path order. */
export function groupLabels(bins: Map<string, InventoryDoc[]>): LabelGroup[] {
  const gs = new Map<string, LabelGroup>();
  for (const [code, docs] of bins) {
    const p = parseBinCode(code);
    if (p.general) continue;
    const k = `${p.room}|${p.aisle}`;
    let g = gs.get(k);
    if (!g) {
      g = { room: p.room, aisle: p.aisle, bins: [], occupied: 0, empty: 0 };
      gs.set(k, g);
    }
    g.bins.push(code);
    if (docs.length) g.occupied++;
  }
  // sort each group's bins by bay then bin
  for (const g of gs.values()) {
    g.bins.sort((a, b) => {
      const pa = parseBinCode(a);
      const pb = parseBinCode(b);
      return pa.bay - pb.bay || pa.bin - pb.bin;
    });
  }
  const nat = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  return [...gs.values()].sort((a, b) => nat(a.room, b.room) || nat(a.aisle, b.aisle));
}

export function binMetadata(code: string, docs: InventoryDoc[]): BinMeta {
  const d = parseBinCode(code);
  const cats = new Map<string, number>();
  let totalQty = 0;
  let maxCap = 0;
  let lastCounted = '';
  for (const doc of docs) {
    totalQty += doc.quantity;
    maxCap = Math.max(maxCap, doc.maxCapacity);
    const c = doc.category || '—';
    cats.set(c, (cats.get(c) ?? 0) + 1);
    // best-effort last counted date — use updatedAt field if present in raw data
  }
  const top = [...cats.entries()].sort((a, b) => b[1] - a[1]);
  return {
    code,
    occupancy: docs.length,
    totalQty,
    maxCapacity: maxCap || 8,
    lastCounted,
    topCategory: top[0]?.[0] ?? '—',
    golden: d.general ? false : isGoldenZone(code)
  };
}

/** Enumerate all possible bin codes for a room/aisle up to (maxBay, maxBin). */
export function allCellCodes(
  rooms: string[],
  aisles: Record<string, string[]>,
  maxBay: number,
  maxBin: number
): string[] {
  const out: string[] = [];
  for (const room of rooms) {
    for (const aisle of aisles[room] ?? []) {
      for (let bay = 1; bay <= maxBay; bay++) {
        for (let bin = 1; bin <= maxBin; bin++) {
          out.push(
            `R${room}-A${aisle}-B${String(bay).padStart(2, '0')}-B${String(bin).padStart(2, '0')}`
          );
        }
      }
    }
  }
  return out;
}

/** Find empty bins: union of all cells minus occupied codes. */
export function emptyBins(
  occupied: Set<string>,
  rooms: string[],
  aisles: Record<string, string[]>,
  maxBay: number,
  maxBin: number
): string[] {
  const all = allCellCodes(rooms, aisles, maxBay, maxBin);
  return all.filter((c) => !occupied.has(c));
}
