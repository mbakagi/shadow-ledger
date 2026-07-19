/* Feature 4 — Count / reconciliation.
 * Scan bin → expected docs → keyed counts → variance flags → atomic commit.
 * Non-destructive: updateDoc() touches only qty + audit fields; discrepancies
 * and the count record are brand-new docs (addDoc / set with fresh ids). */
import { collection, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { commitInChunks, type BatchOp } from './batch';
import { COL, type InventoryDoc } from './schema';

export interface CountLine {
  doc: InventoryDoc;
  expected: number; // buildingStock at load time
  counted: number | null;
}

export interface CountResult {
  updated: number;
  discrepancies: number;
  countId: string;
}

export class CountSession {
  readonly id = crypto.randomUUID();
  readonly startedAt = new Date();
  lines: CountLine[];

  constructor(
    readonly binCode: string,
    docs: InventoryDoc[]
  ) {
    this.lines = docs.map((doc) => ({ doc, expected: doc.quantity, counted: null }));
  }

  get countedLines() {
    return this.lines.filter((l) => l.counted !== null);
  }

  variance(l: CountLine) {
    return l.counted === null ? 0 : l.counted - l.expected;
  }

  get flagged() {
    return this.countedLines.filter((l) => this.variance(l) !== 0);
  }

  /** Commit via the shared batch engine (≤450-op chunks, progress callbacks). */
  async commit(userId: string, onProgress?: (done: number, total: number) => void): Promise<CountResult> {
    const counted = this.countedLines;
    const ops: BatchOp[] = [];

    for (const l of counted) {
      const v = this.variance(l);
      const qty = Math.max(0, Math.round(l.counted ?? 0)); // rules require int
      const ref = doc(db, COL.inventory, l.doc.id);
      if (l.doc.isPerBin) {
        // proofinv shape — rules allow only these keys to change
        ops.push((b) => b.update(ref, { quantity: qty, updated_at: serverTimestamp() }));
      } else {
        // scalar shape — invariant: total = building + depot
        ops.push((b) =>
          b.update(ref, {
            buildingStock: qty,
            totalStock: qty + l.doc.depotStock,
            lastCounted: serverTimestamp(),
            lastCountedBy: userId,
            countStatus: v === 0 ? 'verified' : 'pending',
            updatedAt: serverTimestamp()
          })
        );
      }
      if (v !== 0) {
        const dRef = doc(collection(db, COL.discrepancies));
        // Legacy snake_case contract per firestore.rules /discrepancies
        ops.push((b) =>
          b.set(dRef, {
            countId: this.id,
            inventory_id: l.doc.id,
            sku: l.doc.sku,
            name: l.doc.name,
            binCode: this.binCode,
            expected_qty: l.expected,
            actual_qty: qty,
            variance: v,
            worker_uid: userId,
            status: 'open',
            timestamp: serverTimestamp() // legacy field name (proofinv contract)
          })
        );
      }
    }

    // Count record — blueprint /counts/{countId} shape.
    const countRef = doc(db, COL.counts, this.id);
    ops.push((b) =>
      b.set(
        countRef,
        {
          userId,
          binCode: this.binCode,
          startedAt: this.startedAt,
          completedAt: serverTimestamp(),
          discrepancies: this.flagged.map((l) => ({
            sku: l.doc.sku,
            expected: l.expected,
            counted: l.counted,
            variance: this.variance(l)
          }))
        },
        { merge: true }
      )
    );

    await commitInChunks(ops, onProgress);
    return { updated: counted.length, discrepancies: this.flagged.length, countId: this.id };
  }
}
