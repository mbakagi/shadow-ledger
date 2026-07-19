/* Feature 1 — QR engine. qrcode-svg (~6KB), inline SVG output.
 * Bin deep-link schema: sl://bin/{binCode}
 * Scanner-side compat: also recognizes legacy guest URLs and bare bin codes. */
import QRCode from 'qrcode-svg';

export const binDeepLink = (binCode: string) => `sl://bin/${encodeURIComponent(binCode)}`;

export function qrSvg(content: string, size = 160): string {
  return new QRCode({ content, padding: 2, ecl: 'M', width: size, height: size, join: true }).svg();
}

export type ScanResult =
  | { kind: 'bin'; bin: string }
  | { kind: 'item'; id: string; loc: string }
  | { kind: 'raw'; text: string };

const BIN_RE = /^(?:R?[A-Z0-9]+)(?:-[A-Z0-9:]+){1,5}$/i;

export function parseScan(text: string): ScanResult {
  const t = text.trim();
  const dl = t.match(/^sl:\/\/bin\/(.+)$/i);
  if (dl) return { kind: 'bin', bin: decodeURIComponent(dl[1]) };
  try {
    const u = new URL(t);
    // guest item links: ?id={itemId}&loc={binCode}
    const id = u.searchParams.get('id');
    if (id) return { kind: 'item', id, loc: u.searchParams.get('loc') ?? 'ANY' };
    // proofinv bin labels: ?room=&aisle=&bay=&bin= → canonical code
    const room = u.searchParams.get('room');
    if (room) {
      const parts = [`R${room}`];
      const aisle = u.searchParams.get('aisle');
      const bay = u.searchParams.get('bay');
      const bin = u.searchParams.get('bin');
      if (aisle) parts.push(`A${aisle}`);
      if (bay) parts.push(`B${bay.padStart(2, '0')}`);
      if (bin) parts.push(`B${bin.padStart(2, '0')}`);
      return { kind: 'bin', bin: parts.join('-') };
    }
  } catch {
    /* not a URL */
  }
  if (BIN_RE.test(t)) return { kind: 'bin', bin: t.toUpperCase() };
  return { kind: 'raw', text: t };
}
