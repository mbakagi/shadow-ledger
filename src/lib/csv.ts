/* Editor import parsing — CSV (quote-aware) + JSON rows → normalized import rows. */

export interface ImportRow {
  sku: string;
  name: string;
  category: string;
  binCode: string;
  quantity: number;
}

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let cell = '';
  let row: string[] = [];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

const ALIAS: Record<keyof ImportRow, string[]> = {
  sku: ['sku', 'item', 'itemid', 'code'],
  name: ['name', 'itemname', 'item_name', 'description', 'desc'],
  category: ['category', 'cat', 'group'],
  binCode: ['bincode', 'bin', 'binlocation', 'location', 'storagelocation', 'shelf'],
  quantity: ['quantity', 'qty', 'count', 'stock', 'onhand', 'buildingstock']
};

export function mapRows(raw: Record<string, unknown>[]): ImportRow[] {
  const out: ImportRow[] = [];
  for (const r of raw) {
    const lower: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) lower[k.toLowerCase().replace(/[^a-z]/g, '')] = v;
    const pick = (k: keyof ImportRow) => {
      for (const a of ALIAS[k]) if (lower[a] !== undefined) return lower[a];
      return '';
    };
    const sku = String(pick('sku')).trim();
    if (!sku) continue;
    out.push({
      sku,
      name: String(pick('name')).trim(),
      category: String(pick('category')).trim(),
      binCode: String(pick('binCode')).trim().toUpperCase(),
      quantity: Math.max(0, Math.round(Number(pick('quantity')) || 0))
    });
  }
  return out;
}

export function csvToImportRows(text: string): ImportRow[] {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const header = rows[0];
  return mapRows(rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))));
}
