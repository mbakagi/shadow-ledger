/* Feature 2 — QR scanner. html5-qrcode (~45KB, dynamically imported) with
 * facingMode:'environment' + 1.5s same-code debounce.
 * Fallback: native BarcodeDetector API when html5-qrcode can't start. */

export interface ScannerHandle {
  stop(): Promise<void>;
  engine: 'html5-qrcode' | 'barcode-detector';
}

const DEBOUNCE_MS = 1500;

export async function startScanner(
  el: HTMLElement,
  onScan: (text: string) => void
): Promise<ScannerHandle> {
  let lastText = '';
  let lastAt = 0;
  const emit = (text: string) => {
    const now = Date.now();
    if (text === lastText && now - lastAt < DEBOUNCE_MS) return;
    lastText = text;
    lastAt = now;
    onScan(text);
  };

  try {
    return await startHtml5(el, emit);
  } catch (err) {
    console.warn('html5-qrcode unavailable, trying BarcodeDetector', err);
    return await startNative(el, emit);
  }
}

async function startHtml5(el: HTMLElement, emit: (t: string) => void): Promise<ScannerHandle> {
  const { Html5Qrcode } = await import('html5-qrcode');
  const id = `sl-scan-${Math.random().toString(36).slice(2, 8)}`;
  const mount = document.createElement('div');
  mount.id = id;
  el.appendChild(mount);

  const qr = new Html5Qrcode(id, { verbose: false });
  await qr.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 240, height: 240 } },
    (text) => emit(text),
    () => {}
  );
  return {
    engine: 'html5-qrcode',
    async stop() {
      try {
        await qr.stop();
        qr.clear();
      } catch {
        /* already stopped */
      }
      mount.remove();
    }
  };
}

/* Minimal typing — BarcodeDetector is not in TS's DOM lib. */
interface BarcodeDetectorLike {
  detect(src: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

async function startNative(el: HTMLElement, emit: (t: string) => void): Promise<ScannerHandle> {
  const w = window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => BarcodeDetectorLike };
  if (!w.BarcodeDetector) throw new Error('No QR engine available on this device');

  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  const video = document.createElement('video');
  video.srcObject = stream;
  video.playsInline = true;
  el.appendChild(video);
  await video.play();

  const detector = new w.BarcodeDetector({ formats: ['qr_code'] });
  let raf = 0;
  let alive = true;
  const tick = async () => {
    if (!alive) return;
    if (video.readyState >= 2) {
      try {
        const codes = await detector.detect(video);
        if (codes.length) emit(codes[0].rawValue);
      } catch {
        /* transient frame error */
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    engine: 'barcode-detector',
    async stop() {
      alive = false;
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      video.remove();
    }
  };
}
