/* Feature 7 — Route mapping. A* over an implicit aisle×bay grid, edge costs
 * weighted by aisle congestion (docs per aisle). Pure SVG output: no canvas,
 * no map library. Returns { orderedBinIds, svgPath, totalDistance } per spec. */
import { parseBinCode, normalizeRoom, normalizeAisle, type InventoryDoc } from './schema';

export interface RouteResult {
  orderedBinIds: string[];
  svgPath: string;
  totalDistance: number;
  room: string;
  aisles: string[]; // x-axis labels (index-aligned)
  maxBay: number;
  stops: { bin: string; x: number; y: number; n: number }[];
  occupied: { x: number; y: number; n: number }[]; // all known bins (grid dots)
}

const AISLE_STEP = 2; // cost to cross one aisle boundary
const CONGESTION = 0.25; // added per step inside a congested aisle

const gx = (ai: number) => ai * 56 + 30;
const gy = (bay: number, maxBay: number) => (maxBay - bay) * 16 + 24;

export function planRoute(binCodes: string[], bins: Map<string, InventoryDoc[]>): RouteResult | null {
  const parsed = [...new Set(binCodes)].map((b) => ({ bin: b, p: parseBinCode(b) })).filter((s) => !s.p.general);
  if (!parsed.length) return null;

  // Dominant room keeps the map single-floor.
  const roomTally = new Map<string, number>();
  for (const s of parsed) roomTally.set(s.p.room, (roomTally.get(s.p.room) ?? 0) + 1);
  const room = [...roomTally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const stopsIn = parsed.filter((s) => s.p.room === room);
  if (!stopsIn.length) return null;

  // Aisle universe (whole room, for congestion + grid) ordered numerically.
  const aisleSet = new Set<string>();
  const congestion = new Map<string, number>();
  for (const [code, docs] of bins) {
    const p = parseBinCode(code);
    if (p.general || p.room !== room) continue;
    aisleSet.add(p.aisle);
    congestion.set(p.aisle, (congestion.get(p.aisle) ?? 0) + docs.length);
  }
  for (const s of stopsIn) aisleSet.add(s.p.aisle);
  const aisles = [...aisleSet].sort((a, b) => normalizeAisle(a) - normalizeAisle(b) || a.localeCompare(b));
  const ai = (a: string) => aisles.indexOf(a);

  let maxBay = 4;
  for (const [code] of bins) {
    const p = parseBinCode(code);
    if (!p.general && p.room === room) maxBay = Math.max(maxBay, p.bay + 1);
  }
  for (const s of stopsIn) maxBay = Math.max(maxBay, s.p.bay + 1);

  // ── A* on implicit grid: (aisleIdx, bay). Cross aisles only at bay 0 or maxBay. ──
  type Cell = [number, number];
  const key = (c: Cell) => `${c[0]}|${c[1]}`;
  function neighbors(c: Cell): { c: Cell; cost: number }[] {
    const [a, b] = c;
    const out: { c: Cell; cost: number }[] = [];
    const stepCost = (aisle: string) => 1 + (congestion.get(aisle) ?? 0) * CONGESTION;
    if (b > 0) out.push({ c: [a, b - 1], cost: stepCost(aisles[a]) });
    if (b < maxBay) out.push({ c: [a, b + 1], cost: stepCost(aisles[a]) });
    if (b === 0 || b === maxBay) {
      if (a > 0) out.push({ c: [a - 1, b], cost: AISLE_STEP + (congestion.get(aisles[a - 1]) ?? 0) * CONGESTION });
      if (a < aisles.length - 1)
        out.push({ c: [a + 1, b], cost: AISLE_STEP + (congestion.get(aisles[a + 1]) ?? 0) * CONGESTION });
    }
    return out;
  }
  const h = (c: Cell, goal: Cell) => Math.abs(c[0] - goal[0]) * AISLE_STEP + Math.abs(c[1] - goal[1]);

  function astar(start: Cell, goal: Cell): { path: Cell[]; cost: number } {
    const g = new Map<string, number>([[key(start), 0]]);
    const from = new Map<string, Cell>();
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
        let k = ck;
        while (from.has(k)) {
          path.unshift(from.get(k)!);
          k = key(from.get(k)!);
        }
        return { path, cost: g.get(ck)! };
      }
      for (const n of neighbors(cur.c)) {
        const nk = key(n.c);
        const ng = g.get(ck)! + n.cost;
        if (ng < (g.get(nk) ?? Infinity)) {
          g.set(nk, ng);
          from.set(nk, cur.c);
          if (!closed.has(nk)) open.push({ c: n.c, f: ng + h(n.c, goal) });
        }
      }
    }
    return { path: [start, goal], cost: h(start, goal) }; // unreachable → straight guess
  }

  // ── Nearest-neighbor stop ordering, starting at the lowest grid corner. ──
  const cells = new Map(stopsIn.map((s) => [s.bin, [ai(s.p.aisle), s.p.bay] as Cell]));
  let cur: Cell = [0, 0];
  const remaining = new Set(cells.keys());
  const orderedBinIds: string[] = [];
  const fullPath: Cell[] = [];
  let totalDistance = 0;
  while (remaining.size) {
    let best: string | null = null;
    let bestD = Infinity;
    for (const b of remaining) {
      const d = h(cur, cells.get(b)!);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    remaining.delete(best!);
    orderedBinIds.push(best!);
    const leg = astar(cur, cells.get(best!)!);
    fullPath.push(...(fullPath.length ? leg.path.slice(1) : leg.path));
    totalDistance += leg.cost;
    cur = cells.get(best!)!;
  }

  const svgPath = fullPath.map((c, i) => `${i ? 'L' : 'M'}${gx(c[0])},${gy(c[1], maxBay)}`).join(' ');
  const stops = orderedBinIds.map((b, i) => {
    const c = cells.get(b)!;
    return { bin: b, x: gx(c[0]), y: gy(c[1], maxBay), n: i + 1 };
  });
  const occupiedMap = new Map<string, number>();
  for (const [code, docs] of bins) {
    const p = parseBinCode(code);
    if (p.general || p.room !== room) continue;
    const k = `${ai(p.aisle)}|${p.bay}`;
    occupiedMap.set(k, (occupiedMap.get(k) ?? 0) + docs.length);
  }
  const occupied = [...occupiedMap.entries()].map(([k, n]) => {
    const [a, b] = k.split('|').map(Number);
    return { x: gx(a), y: gy(b, maxBay), n };
  });

  return { orderedBinIds, svgPath, totalDistance: Math.round(totalDistance * 10) / 10, room, aisles, maxBay, stops, occupied };
}
