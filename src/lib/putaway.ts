/* Feature 3 — Chaotic storage: weighted nearest-neighbor bin selection.
 * Production mapping notes:
 *  - No /bins collection exists; the bin universe is derived from inventory
 *    docs' binCode values (see store.bins).
 *  - Blueprint's `itemCount < MAX_BIN_CAPACITY` → occupants (docs sharing a
 *    binCode) < MAX_BIN_CAPACITY below. */
import {
  parseBinCode,
  normalizeRoom,
  normalizeAisle,
  isGoldenZone,
  type InventoryDoc
} from './schema';

export const MAX_BIN_CAPACITY = 8;

export interface BinSuggestion {
  binCode: string;
  score: number; // lower = better
  occupants: number;
  reasons: string[];
}

const W = { room: 40, aisle: 10, bay: 2, category: -15, fill: 10, golden: -8, sameSku: -1000 };

type Coord = { room: string; aisle: string; bay: number };

/** Physical distance between two bin coordinates (aisle congestion ≈ aisle delta). */
function physicalDelta(a: Coord, b: Coord) {
  return (
    Math.abs(normalizeRoom(a.room) - normalizeRoom(b.room)) * W.room +
    Math.abs(normalizeAisle(a.aisle) - normalizeAisle(b.aisle)) * W.aisle +
    Math.abs(a.bay - b.bay) * W.bay
  );
}

/**
 * Score every known, non-full bin for `item` and return the best `top` results.
 * Anchor = this SKU's existing bin, else the category's centroid (most common
 * room+aisle among siblings). Score = proximity + affinity + fill-rate factors.
 */
export function suggestBins(
  item: { sku: string; category: string; highVelocity?: boolean },
  bins: Map<string, InventoryDoc[]>,
  top = 5
): BinSuggestion[] {
  const sameSkuBins = [...bins.entries()].filter(([, docs]) => docs.some((d) => d.sku === item.sku));

  // Category centroid anchor
  const catCount = new Map<string, number>();
  for (const docs of bins.values())
    for (const d of docs)
      if (d.category === item.category && d.binCode) {
        const p = parseBinCode(d.binCode);
        const k = `${p.room}|${p.aisle}`;
        catCount.set(k, (catCount.get(k) ?? 0) + 1);
      }
  const centroidKey = [...catCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const centroid = centroidKey
    ? { room: centroidKey.split('|')[0], aisle: centroidKey.split('|')[1], bay: 0 }
    : null;

  const out: BinSuggestion[] = [];
  for (const [binCode, docs] of bins) {
    const occupants = docs.length;
    if (occupants >= MAX_BIN_CAPACITY) continue;

    const p = parseBinCode(binCode);
    const reasons: string[] = [];
    let score = 0;

    if (sameSkuBins.some(([b]) => b === binCode)) {
      score += W.sameSku;
      reasons.push('already holds this SKU');
    } else {
      const anchor: Coord | null = sameSkuBins.length ? parseBinCode(sameSkuBins[0][0]) : centroid;
      if (anchor) {
        const d = physicalDelta(p, anchor);
        score += d;
        if (d === 0) reasons.push('same aisle as siblings');
      }
      if (docs.some((d) => d.category === item.category && item.category)) {
        score += W.category;
        reasons.push('category affinity');
      }
    }

    const fill = occupants / MAX_BIN_CAPACITY;
    score += fill * W.fill;
    if (fill > 0.6) reasons.push(`fill ${occupants}/${MAX_BIN_CAPACITY}`);

    if (item.highVelocity && isGoldenZone(binCode)) {
      score += W.golden;
      reasons.push('golden zone');
    }

    out.push({ binCode, score, occupants, reasons });
  }

  return out.sort((a, b) => a.score - b.score || a.binCode.localeCompare(b.binCode)).slice(0, top);
}
