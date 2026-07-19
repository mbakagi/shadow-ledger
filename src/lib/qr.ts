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

const BIN_RE = /^[A-Z0-9]+-[A-Z0-9:]+-[A-Z0-9:]+-[A-Z0-9:]+-[A-Z0-9:]+-?/i;

export function parseScan(text: string): ScanResult {
  const t = text.trim();
  const dl = t.match(/^sl:\/\/bin\/(.+)$/i);
  if (dl) return { kind: 'bin', bin: decodeURIComponent(dl[1]) };
  try {
    const u = new URL(t);
    const id = u.searchParams.get('id');
    if (id) return { kind: 'item', id, loc: u.searchParams.get('loc') ?? 'ANY' };
  } catch {
    /* not a URL */
  }
  if (BIN_RE.test(t)) return { kind: 'bin', bin: t };
  return { kind: 'raw', text: t };
}
