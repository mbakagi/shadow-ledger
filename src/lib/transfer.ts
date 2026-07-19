/* Bin-to-bin transfer — mirrors proofinv's proven move semantics:
 * decrement source (delete when it hits 0) + create/increment destination
 * per-bin doc addressed by normId, inside one transaction.
 * Non-destructive: destination written with set(…, {merge:true}). */
import { doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { COL, binDocId, parseBinCode, parseInventory, warehouseFields, type InventoryDoc } from './schema';

export interface MoveResult {
  moved: number;
  srcRemaining: number;
  dstId: string;
  dstQty: number;
}

export async function moveQty(src: InventoryDoc, destBinCode: string, qty: number): Promise<MoveResult> {
  if (!src.isPerBin) throw new Error('Only per-bin docs can be moved bin-to-bin');
  const p = parseBinCode(destBinCode);
  if (!p.room || !p.aisle || !p.bay || !p.bin)
    throw new Error('Destination must be a full bin: R{room}-A{aisle}-B{bay}-B{bin}');
  if (destBinCode === src.binCode) throw new Error('Source and destination are the same bin');

  const q = Math.min(Math.max(1, Math.round(qty)), src.quantity);
  const srcRef = doc(db, COL.inventory, src.id);
  const dstId = binDocId(src.sku, p);
  const dstRef = doc(db, COL.inventory, dstId);

  return runTransaction(db, async (tx) => {
    const sSnap = await tx.get(srcRef);
    if (!sSnap.exists()) throw new Error('Source doc no longer exists');
    const srcNow = parseInventory(sSnap.id, sSnap.data()).quantity;
    if (q > srcNow) throw new Error(`Only ${srcNow} available at source`);

    const dSnap = await tx.get(dstRef);
    const dstNow = dSnap.exists() ? Math.max(0, Number(dSnap.data().quantity) || 0) : 0;
    const dstQty = dstNow + q;

    tx.set(
      dstRef,
      {
        sku: src.sku,
        item_name: src.name,
        room: p.room,
        aisle: p.aisle,
        bay: String(p.bay).padStart(2, '0'),
        bin: String(p.bin).padStart(2, '0'),
        quantity: dstQty,
        binCode: destBinCode,
        ...warehouseFields(destBinCode),
        updated_at: serverTimestamp()
      },
      { merge: true }
    );

    const srcRemaining = srcNow - q;
    if (srcRemaining <= 0) tx.delete(srcRef);
    else tx.update(srcRef, { quantity: srcRemaining, updated_at: serverTimestamp() });

    return { moved: q, srcRemaining, dstId, dstQty };
  });
}
