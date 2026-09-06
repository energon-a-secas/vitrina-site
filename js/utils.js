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
