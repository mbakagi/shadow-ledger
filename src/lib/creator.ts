/* Create per-bin inventory docs (proofinv shape) with a single setDoc(…,merge).
 * Used by the bins explorer's "add item here" and the editor's bulk import. */
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { COL, binDocId, parseBinCode, warehouseFields } from './schema';

export async function createBinDoc(
  sku: string,
  name: string,
  binCode: string,
  qty: number,
  category = ''
): Promise<string> {
  const p = parseBinCode(binCode);
  if (!p.room || !p.aisle || !p.bay || !p.bin)
    throw new Error('Destination must be a full bin: R{room}-A{aisle}-B{bay}-B{bin}');

  const id = binDocId(sku, p);
  await setDoc(
    doc(db, COL.inventory, id),
    {
      sku,
      name,
      item_name: name || sku,
      category,
      room: p.room,
      aisle: p.aisle,
      bay: String(p.bay).padStart(2, '0'),
      bin: String(p.bin).padStart(2, '0'),
      binCode,
      ...warehouseFields(binCode),
      quantity: Math.max(0, Math.round(qty)),
      updated_at: serverTimestamp()
    },
    { merge: true }
  );
  return id;
}
