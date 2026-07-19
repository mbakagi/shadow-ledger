/* Route mapping — research-grade algorithms.
 *   "Nearest neighbor + A*"  — TSP-like, fine for sparse pick lists.
 *   "S‑shaped traversal"     — warehouse gold standard (Roodbergen & De Koster,
 *                              2001): enter each aisle at one end, pick every
 *                              stop sequentially, exit at the opposite end,
 *                              cross-alley travel at extremes only.
 *   "Return routing"         — enter and return from the same aisle end. */
import { parseBinCode, normalizeRoom, normalizeAisle, type InventoryDoc } from './schema';

export type RouteMethod = 'nearest-astar' | 's-shaped' | 'return';

export interface RouteResult {
  method: RouteMethod;
  orderedBinIds: string[];
  svgPath: string;
  totalDistance: number;
  room: string;
  aisles: string[]; // x-axis labels
  maxBay: number;
  stops: { bin: string; x: number; y: number; n: number }[];
  occupied: { x: number; y: number; n: number }[];
  gridW: number;
  gridH: number;
}

const AISLE_STEP = 56;
const BAY_STEP = 16;
const PAD = 40;

const gx = (ai: number) => ai * AISLE_STEP + PAD;
const gy = (bay: number, maxBay: number) => (maxBay - bay) * BAY_STEP + PAD;

// ──────────── helpers (shared) ────────────

function prep(binCodes: string[], bins: Map<string, InventoryDoc[]>) {
  const parsed = [...new Set(binCodes)].map((b) => ({ bin: b, p: parseBinCode(b) })).filter((s) => !s.p.general);
  if (!parsed.length) return null;
  const roomTally = new Map<string, number>();
  for (const s of parsed) roomTally.set(s.p.room, (roomTally.get(s.p.room) ?? 0) + 1);
  const room = [...roomTally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const stopsIn = parsed.filter((s) => s.p.room === room);
  if (!stopsIn.length) return null;
  const aisleSet = new Set<string>();
  let maxBay = 4;
  for (const s of stopsIn) {
    aisleSet.add(s.p.aisle);
    maxBay = Math.max(maxBay, s.p.bay);
  }
  const aisles = [...aisleSet].sort((a, b) => normalizeAisle(a) - normalizeAisle(b) || a.localeCompare(b));
  const ai = (a: string) => aisles.indexOf(a);
  const occupiedMap = new Map<string, number>();
  for (const [code, docs] of bins) {
    const p = parseBinCode(code);
    if (p.general || p.room !== room) continue;
    occupiedMap.set(`${ai(p.aisle)}|${p.bay}`, (occupiedMap.get(`${ai(p.aisle)}|${p.bay}`) ?? 0) + docs.length);
  }
  const occupied = [...occupiedMap.entries()].map(([k, n]) => {
    const [a, b] = k.split('|').map(Number);
    return { x: gx(a), y: gy(b, maxBay), n };
  });
  const gridW = aisles.length * AISLE_STEP + PAD * 2;
  const gridH = (maxBay + 1) * BAY_STEP + PAD * 2;
  return { room, aisles, maxBay, ai, stopsIn, occupied, gridW, gridH };
}

type Prep = NonNullable<ReturnType<typeof prep>>;

function resultStops(
  ordered: string[],
  prep: Prep & { method: RouteMethod }
): RouteResult['stops'] {
  const set = new Set(ordered);
  return [...set].map((bin, i) => {
    const p = parseBinCode(bin);
    return {
      bin,
      x: gx(prep.ai(p.aisle)),
      y: gy(p.bay, prep.maxBay),
      n: i + 1
    };
  });
}

function svgLine(stops: RouteResult['stops']): string {
  return stops.map((s, i) => `${i ? 'L' : 'M'}${s.x},${s.y}`).join(' ');
}

// ──────────── S-shaped traversal ────────────
//  Enter warehouse at (aisle 0, bay 0 = bottom-left).
//  For each aisle that has stops:
//   • if arriving from bottom → visit stops bay-ascending, exit top
//   • if arriving from top    → visit stops bay-descending, exit bottom
//  Aisles without stops are skipped (cross at bay 0, no detour).

function planSShape(binCodes: string[], bins: Map<string, InventoryDoc[]>): RouteResult | null {
  const p = prep(binCodes, bins);
  if (!p) return null;
  const { aisles, ai, stopsIn, maxBay } = p;
  const stopsByAisle = new Map<number, string[]>();
  for (const s of stopsIn) {
    const idx = ai(s.p.aisle);
    if (!stopsByAisle.has(idx)) stopsByAisle.set(idx, []);
    stopsByAisle.get(idx)!.push(s.bin);
  }
  const activeAisles = [...stopsByAisle.keys()].sort((a, b) => a - b);
  if (!activeAisles.length) return null;

  const ordered: string[] = [];
  const fullPath: { x: number; y: number }[] = [];
  let atBottom = true; // current cross-aisle position
  let curX = gx(aisles.length ? 0 : activeAisles[0]);
  let curY = gy(0, maxBay);
  let total = 0;

  for (const aiIdx of activeAisles) {
    const codes = stopsByAisle.get(aiIdx)!;
    const parsed = codes.map((c) => ({ code: c, p: parseBinCode(c) }));
    parsed.sort((a, b) => a.p.bay - b.p.bay);

    // Travel to aisle entry
    const entryX = gx(aiIdx);

    if (atBottom) {
      // Cross to this aisle at bay 0
      total += Math.abs(curX - entryX);
      curX = entryX;
      curY = gy(0, maxBay);
      fullPath.push({ x: curX, y: curY });
      // Walk aisle bay-ascending, picking stops
      for (const s of parsed) {
        total += Math.abs(s.p.bay - 0);
        curY = gy(s.p.bay, maxBay);
        fullPath.push({ x: curX, y: curY });
        ordered.push(s.code);
        total += 0; // dwell at stop
      }
      // Exit at top
      total += Math.abs((parsed[parsed.length - 1]?.p.bay ?? 0) - maxBay);
      curY = gy(maxBay, maxBay);
    } else {
      // Cross to this aisle at maxBay
      total += Math.abs(curX - entryX);
      curX = entryX;
      curY = gy(maxBay, maxBay);
      fullPath.push({ x: curX, y: curY });
      // Walk aisle bay-descending
      for (let i = parsed.length - 1; i >= 0; i--) {
        const s = parsed[i];
        total += Math.abs(maxBay - s.p.bay);
        curY = gy(s.p.bay, maxBay);
        fullPath.push({ x: curX, y: curY });
        ordered.push(s.code);
      }
      // Exit at bottom
      total += Math.abs((parsed[0]?.p.bay ?? 0) - 0);
      curY = gy(0, maxBay);
    }
    atBottom = !atBottom;
  }

  const stops = resultStops(ordered, { ...p, method: 's-shaped' });
  const svgPath = fullPath.map((c, i) => `${i ? 'L' : 'M'}${c.x},${c.y}`).join(' ');
  return {
    method: 's-shaped',
    orderedBinIds: ordered,
    svgPath,
    totalDistance: Math.round(total * 10) / 10,
    room: p.room,
    aisles,
    maxBay,
    stops,
    occupied: p.occupied,
    gridW: p.gridW,
    gridH: p.gridH
  };
}

// ──────────── Return routing ────────────
//  Enter and exit each aisle at bay 0 (go in, pick all, return out).
//  Only aisles with stops are entered. Simplest possible pattern.

function planReturn(binCodes: string[], bins: Map<string, InventoryDoc[]>): RouteResult | null {
  const p = prep(binCodes, bins);
  if (!p) return null;
  const { aisles, ai, stopsIn, maxBay } = p;
  const stopsByAisle = new Map<number, string[]>();
  for (const s of stopsIn) {
    const idx = ai(s.p.aisle);
    if (!stopsByAisle.has(idx)) stopsByAisle.set(idx, []);
    stopsByAisle.get(idx)!.push(s.bin);
  }
  const activeAisles = [...stopsByAisle.keys()].sort((a, b) => a - b);
  if (!activeAisles.length) return null;

  const ordered: string[] = [];
  const fullPath: { x: number; y: number }[] = [];
  let curX = gx(0);
  let curY = gy(0, maxBay);
  let total = 0;

  for (const aiIdx of activeAisles) {
    const codes = stopsByAisle.get(aiIdx)!;
    const parsed = codes.map((c) => ({ code: c, p: parseBinCode(c) }));
    parsed.sort((a, b) => a.p.bay - b.p.bay);
    const entryX = gx(aiIdx);

    // Cross to aisle at bay 0
    total += Math.abs(curX - entryX);
    curX = entryX;
    curY = gy(0, maxBay);
    fullPath.push({ x: curX, y: curY });

    // Walk into aisle picking all stops ascending, then return to bay 0
    let lastBay = 0;
    for (const s of parsed) {
      total += Math.abs(s.p.bay - lastBay);
      lastBay = s.p.bay;
      curY = gy(s.p.bay, maxBay);
      fullPath.push({ x: curX, y: curY });
      ordered.push(s.code);
    }
    // Return to bay 0
    total += Math.abs(lastBay - 0);
    curY = gy(0, maxBay);
  }

  const stops = resultStops(ordered, { ...p, method: 'return' });
  const svgPath = fullPath.map((c, i) => `${i ? 'L' : 'M'}${c.x},${c.y}`).join(' ');
  return {
    method: 'return',
    orderedBinIds: ordered,
    svgPath,
    totalDistance: Math.round(total * 10) / 10,
    room: p.room,
    aisles,
    maxBay,
    stops,
    occupied: p.occupied,
    gridW: p.gridW,
    gridH: p.gridH
  };
}

// ──────────── Nearest neighbor + A* (existing, refactored) ────────────

function planNearestAStar(binCodes: string[], bins: Map<string, InventoryDoc[]>): RouteResult | null {
  const p = prep(binCodes, bins);
  if (!p) return null;
  const { aisles, ai, stopsIn, maxBay } = p;

  // Simplified manhattan A* — no congestion this time (purely geometric for fair comparison)
  type Cell = [number, number];
  const h = (c: Cell, g: Cell) => Math.abs(c[0] - g[0]) * 2 + Math.abs(c[1] - g[1]);
  function astar(start: Cell, goal: Cell): { path: Cell[]; cost: number } {
    const key = (c: Cell) => `${c[0]}|${c[1]}`;
    const g = new Map([[key(start), 0]]);
    const open: { c: Cell; f: number }[] = [{ c: start, f: h(start, goal) }];
    const closed = new Set<string>();
    while (open.length) {
      open.sort((x, y) => x.f - y.f);
      const cur = open.shift()!;
      const ck = key(cur.c);
      if (closed.has(ck)) continue;
      closed.add(ck);
      if (cur.c[0] === goal[0] && cur.c[1] === goal[1]) {
        const path: Cell[] = [cur.c];
        return { path, cost: g.get(ck)! };
      }
      const [a, b] = cur.c;
      for (const [na, nb] of [[a, b - 1], [a, b + 1], [a - 1, b], [a + 1, b]]) {
        if (na < 0 || na >= aisles.length || nb < 0 || nb > maxBay) continue;
        const nk = key([na, nb]);
        const ng = g.get(ck)! + 1;
        if (ng < (g.get(nk) ?? Infinity)) {
          g.set(nk, ng);
          if (!closed.has(nk)) open.push({ c: [na, nb], f: ng + h([na, nb], goal) });
        }
      }
    }
    return { path: [start, goal], cost: h(start, goal) };
  }

  const cells = new Map(stopsIn.map((s) => [s.bin, [ai(s.p.aisle), s.p.bay] as Cell]));
  let cur: Cell = [0, 0];
  const remaining = new Set(cells.keys());
  const ordered: string[] = [];
  const fullPath: Cell[] = [];
  let total = 0;
  while (remaining.size) {
    let best: string | null = null;
    let bestD = Infinity;
    for (const b of remaining) {
      const d = h(cur, cells.get(b)!);
      if (d < bestD) { bestD = d; best = b; }
    }
    remaining.delete(best!);
    ordered.push(best!);
    const leg = astar(cur, cells.get(best!)!);
    fullPath.push(...(fullPath.length ? leg.path.slice(1) : leg.path));
    total += leg.cost;
    cur = cells.get(best!)!;
  }

  const stops = resultStops(ordered, { ...p, method: 'nearest-astar' });
  const svgPath = fullPath.map((c, i) => `${i ? 'L' : 'M'}${gx(c[0])},${gy(c[1], maxBay)}`).join(' ');
  return {
    method: 'nearest-astar',
    orderedBinIds: ordered,
    svgPath,
    totalDistance: Math.round(total * 10) / 10,
    room: p.room,
    aisles,
    maxBay,
    stops,
    occupied: p.occupied,
    gridW: p.gridW,
    gridH: p.gridH
  };
}

// ──────────── Public API ────────────

export function planRoute(binCodes: string[], bins: Map<string, InventoryDoc[]>, method: RouteMethod): RouteResult | null {
  switch (method) {
    case 's-shaped': return planSShape(binCodes, bins);
    case 'return': return planReturn(binCodes, bins);
    case 'nearest-astar':
    default: return planNearestAStar(binCodes, bins);
  }
}

export function compareRoutes(binCodes: string[], bins: Map<string, InventoryDoc[]>) {
  const methods: RouteMethod[] = ['nearest-astar', 's-shaped', 'return'];
  return methods
    .map((m) => planRoute(binCodes, bins, m))
    .filter((r): r is RouteResult => r !== null)
    .sort((a, b) => a.totalDistance - b.totalDistance);
}

/** Route method labels for UI. */
export const METHOD_LABELS: Record<RouteMethod, string> = {
  'nearest-astar': 'Nearest Neighbor + A*',
  's-shaped': 'S‑Shaped Traversal',
  'return': 'Return Routing'
};
