/* Feature 5 — Batch engine. Firestore writeBatch() committed in ≤CHUNK-op
 * chunks with optimistic progress callbacks. All mutations are non-destructive
 * (update / set-merge only — never unmerged set on existing docs). */
import { writeBatch, type WriteBatch } from 'firebase/firestore';
import { db } from './firebase';

/* Blueprint ceiling is 500 ops per batch; keep headroom. */
export const BATCH_CHUNK = 450;

export type BatchOp = (b: WriteBatch) => void;

export async function commitInChunks(
  ops: BatchOp[],
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  let done = 0;
  for (let i = 0; i < ops.length; i += BATCH_CHUNK) {
    const batch = writeBatch(db);
    for (const op of ops.slice(i, i + BATCH_CHUNK)) op(batch);
    await batch.commit();
    done = Math.min(i + BATCH_CHUNK, ops.length);
    onProgress?.(done, ops.length); // optimistic: UI advances per committed chunk
  }
  return done;
}
