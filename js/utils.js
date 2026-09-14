// ── Small shared helpers ─────────────────────────────────────────────────────

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Casefold and strip accents. For searching and matching only, never display. */
export function fold(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function debounce(fn, ms = 180) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

let toastTimer;
export function toast(message, kind = '') {
  const node = $('#toast');
  if (!node) return;
  // The live region stays in the DOM and only fades: a change written while the
  // element carries `hidden` is not announced, so toggling `hidden` made this
  // the one piece of error feedback a screen reader never heard.
  clearTimeout(toastTimer);
  node.className = 'toast' + (kind ? ' toast--' + kind : '');
  node.textContent = message;
  requestAnimationFrame(() => node.classList.add('visible'));
  toastTimer = setTimeout(() => {
    node.classList.remove('visible');
    // Clearing the text is deferred past the fade so the region is empty and
    // ready for the next message, and cancelled above if another toast arrives.
    toastTimer = setTimeout(() => { node.textContent = ''; }, 260);
  }, 2600);
}

/** The four-digit year inside `abr 1988`, `dic 2014`, `2004`, or null. */
export function yearOf(raw) {
  const m = String(raw == null ? '' : raw).match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

/** `12×19` -> 19 (height in cm). The shelf scales spines by this. */
export function heightCm(dimensions) {
  const m = String(dimensions == null ? '' : dimensions).match(/(\d+(?:[.,]\d+)?)\s*[×x]\s*(\d+(?:[.,]\d+)?)/);
  return m ? Number(m[2].replace(',', '.')) : null;
}

/** Leading integer of a collection number, for shelf order. Unnumbered last. */
export function numberOf(raw) {
  const m = String(raw == null ? '' : raw).match(/\d+/);
  return m ? Number(m[0]) : Number.MAX_SAFE_INTEGER;
}

/** Surname-first key so `C. J. Cherryh` files under C-h-e-r-r-y-h. */
export function authorKey(name) {
  const parts = fold(name).trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] + ' ' + parts.slice(0, -1).join(' ') : '';
}

export function titleKey(title) {
  return fold(title).replace(/^(el|la|los|las|un|una|the|a)\s+/, '');
}

/**
 * A stable colour for a book with no spine scan, derived from its own title so
 * the drawn spine keeps the same shade between reloads.
 */
export function hueOf(seed) {
  let h = 0;
  const s = String(seed == null ? '' : seed);
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function plural(n, one, many) {
  return n === 1 ? `${n} ${one}` : `${n} ${many}`;
}

/**
 * A random UUID, for the key of a book added by hand. crypto.randomUUID exists
 * only in a secure context, and a phone opening a laptop's dev server over the
 * local network is not one, so the same version 4 layout is built from
 * getRandomValues there.
 */
export function mintUuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Trigger a client-side download of `text`. */
export function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
