/**
 * Barcode scanning, in the cheapest order that works.
 *
 *   1. The native BarcodeDetector, which costs nothing to use and exists on
 *      Android Chrome. Nothing is downloaded at all.
 *   2. The barcode-detector ponyfill (Sec-ant, MIT), which is a WebAssembly
 *      build of zxing. Measured today: 441 KB brotli, 1.07 MB raw. It is
 *      fetched only when step 1 is missing AND somebody actually opens the
 *      camera, because every iPhone lands here: WebKit still ships Shape
 *      Detection off by default, and every iOS browser is WebKit.
 *   3. Typing the number, which is always available and is the reason the
 *      dialog leads with a text field rather than a camera button.
 *
 * The camera needs a secure context. https://vitrina.neorgon.com qualifies and
 * so does localhost; a plain-http host does not, and that is reported rather
 * than left as a dead button.
 */

const PONYFILL = 'https://esm.sh/barcode-detector@3.2.2/pure';

let DetectorClass = null;

/** Whether a camera can be asked for at all, before asking. */
export function cameraPossible() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);
}

/** Native where it exists, the wasm ponyfill only when it does not. */
async function getDetector() {
  if (DetectorClass) return DetectorClass;
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('ean_13')) {
        DetectorClass = window.BarcodeDetector;
        return DetectorClass;
      }
    } catch { /* fall through to the ponyfill */ }
  }
  const mod = await import(/* @vite-ignore */ PONYFILL);
  DetectorClass = mod.BarcodeDetector;
  return DetectorClass;
}

/**
 * Run the camera until something decodes or stop() is called.
 *
 * Returns a handle with stop(), and stop() is not optional: a camera stream
 * left running keeps the indicator light on and the radio warm, which on a
 * phone in a bookshop is somebody's battery.
 *
 * @param {HTMLVideoElement} video
 * @param {(value: string) => void} onDetect
 */
export async function startScanner(video, onDetect, onStatus = () => {}) {
  if (!cameraPossible()) {
    const why = window.isSecureContext
      ? 'This browser exposes no camera.'
      : 'A camera needs a secure page. Open the site over https.';
    throw new Error(why);
  }

  onStatus('Asking for the camera');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (err) {
    // NotAllowedError is a person saying no, which is not a failure to report
    // as breakage. On iOS Safari it is also what a denied permission looks
    // like forever after, until the site is reset in Settings.
    throw new Error(err && err.name === 'NotAllowedError'
      ? 'Camera permission was refused. Type the number instead, or allow the camera and reopen.'
      : 'The camera could not be started. Type the number instead.');
  }

  onStatus('Loading the decoder');
  let Detector;
  try {
    Detector = await getDetector();
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('The barcode decoder did not load. Type the number instead.');
  }

  const detector = new Detector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');    // iOS refuses to inline play without it
  await video.play().catch(() => {});
  onStatus('Point it at the barcode');

  let live = true;
  let timer = null;
  const stop = () => {
    live = false;
    clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };

  const tick = async () => {
    if (!live) return;
    try {
      const found = await detector.detect(video);
      const hit = found.find((f) => /^\d{8,18}$/.test(f.rawValue));
      if (hit && live) { stop(); onDetect(hit.rawValue); return; }
    } catch { /* a frame that will not decode is the normal case */ }
    // Slower than a frame loop on purpose: decoding every frame heats a phone
    // for no gain, because a hand holding a book does not move that fast.
    timer = setTimeout(tick, 220);
  };
  tick();

  return { stop };
}
