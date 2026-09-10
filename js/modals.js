// ── Dialogs: add a book, import, shelf report ───────────────────────────────

import { state, addEntry, restoreSeed, reindex, save } from './state.js';
import { $, escHtml, toast, download, plural } from './utils.js';
import { title, bookYear, hasSpine, bookHeight } from './data.js';
import { resolveIsbn, explain, loadScanIndex } from './scan.js';
import { cameraPossible, startScanner } from './camera.js';

let hideTimer = null;
let opener = null;

/**
 * Work a dialog must undo when it closes. The camera is why this exists: a
 * getUserMedia stream outlives the markup that started it, so closing the
 * dialog without stopping it leaves the indicator light on and the radio warm.
 */
let cleanups = [];

/** Register teardown for the dialog being opened right now. */
export function onModalClose(fn) {
  if (typeof fn === 'function') cleanups.push(fn);
}

function runCleanups() {
  const pending = cleanups;
  cleanups = [];
  pending.forEach((fn) => { try { fn(); } catch { /* teardown must not throw */ } });
}

export function openModal(heading, body, footer) {
  // A dialog replaced without closing still has to release what it held.
  runCleanups();
  $('#modalTitle').textContent = heading;
  $('#modalBody').innerHTML = body;
  $('#modalFooter').innerHTML = footer || '';
  const m = $('#modal');
  // Reopening inside the close transition used to run the old timer and hide
  // the dialog that had just been opened.
  clearTimeout(hideTimer);
  if (m.hidden) opener = document.activeElement;
  m.hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => m.classList.add('is-open'));
  // Fall back to the dialog itself: the Shelf report has no control to land on,
  // so without this the reader stays outside an aria-modal surface.
  const first = $('#modalBody input, #modalBody textarea, #modalBody button')
    || $('#modalFooter button') || $('.modal__dialog');
  if (first) first.focus();
}

export function closeModal() {
  const m = $('#modal');
  if (!m || m.hidden) return;
  runCleanups();
  m.classList.remove('is-open');
  if (!$('#drawer') || $('#drawer').hidden) document.body.classList.remove('modal-open');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { m.hidden = true; }, 200);
  if (opener && document.contains(opener)) opener.focus();
  opener = null;
}

// ── Add a book by hand ───────────────────────────────────────────────────────

export function addDialog() {
  openModal('Add a book',
    `<p class="dialog__lead">For a book the catalogue does not have, or a copy you want to describe yourself.
      To add a catalogued edition instead, use <strong>Browse</strong>: it brings the cover and the spine with it.</p>
     <form class="form" id="addForm">
       <label class="form__row"><span>Title</span><input name="title" required maxlength="200" autocomplete="off"></label>
       <label class="form__row"><span>Author</span><input name="authors" placeholder="Comma separated" maxlength="200" autocomplete="off"></label>
       <div class="form__pair">
         <label class="form__row"><span>Year</span><input name="year" maxlength="20" inputmode="numeric" autocomplete="off"></label>
         <label class="form__row"><span>Pages</span><input name="pages" maxlength="6" inputmode="numeric" autocomplete="off"></label>
       </div>
       <div class="form__pair">
         <label class="form__row"><span>Publisher</span><input name="publisher" maxlength="120" autocomplete="off"></label>
         <label class="form__row"><span>Collection</span><input name="collection" maxlength="120" autocomplete="off"></label>
       </div>
       <div class="form__pair">
         <label class="form__row"><span>Shelf</span><input name="shelf" list="shelfNames" maxlength="80" autocomplete="off"></label>
         <label class="form__row"><span>Size in cm</span><input name="dimensions" placeholder="12x19" maxlength="20" autocomplete="off"></label>
       </div>
       <label class="form__row"><span>Cover image URL</span><input name="cover_custom" type="url" maxlength="500" placeholder="Optional" autocomplete="off"></label>
       <label class="form__row"><span>Spine image URL</span><input name="spine_custom" type="url" maxlength="500" placeholder="Optional. Without one the shelf draws a spine" autocomplete="off"></label>
       <label class="form__row"><span>Note</span><input name="note" maxlength="240" placeholder="Where you found it, condition, anything" autocomplete="off"></label>
       <datalist id="shelfNames">${shelfNames().map((s) => `<option value="${escHtml(s)}">`).join('')}</datalist>
     </form>`,
    `<button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
     <button type="button" class="btn btn--primary" id="addSave">Put it on the shelf</button>`);
}

/**
 * Add by ISBN. Type it or scan it later; the resolution is the same either way.
 *
 * The result is always a list, never a pick. An ISBN identifies a work far more
 * often than it identifies a printing: 48 keys in this catalogue cover 109
 * editions, and choosing for somebody would put the wrong one on a shelf whose
 * whole subject is which printing they own.
 */
export function scanDialog() {
  openModal('Add by ISBN',
    `<p class="dialog__lead">The number under the barcode, 10 or 13 digits. Hyphens and spaces are fine.
      Resolved against the catalogue on your machine, so this works with no network.</p>
     <form class="form" id="isbnForm" onsubmit="return false">
       <label class="form__row">
         <span>ISBN</span>
         <input name="isbn" id="isbnInput" inputmode="numeric" autocomplete="off"
                maxlength="24" placeholder="9788466653954" aria-describedby="isbnNote">
       </label>
     </form>
     <p class="dialog__note" id="isbnNote"></p>
     <div class="scanner" id="scanner" hidden>
       <video id="scanVideo" class="scanner__video" muted playsinline></video>
       <p class="scanner__status" id="scanStatus" role="status" aria-live="polite"></p>
     </div>
     <div id="isbnResults" class="candidates" role="group" aria-label="Matching editions"></div>`,
    `<button type="button" class="btn btn--ghost" data-modal-close>Close</button>
     <button type="button" class="btn btn--secondary" id="scanBtn" hidden>Scan with the camera</button>`);

  const input = $('#isbnInput');
  const note = $('#isbnNote');
  const results = $('#isbnResults');
  if (!input) return;
  input.focus();

  // Warm the index while they are still typing, so the first lookup is instant.
  void loadScanIndex().catch(() => {});

  let timer = null;
  const run = async () => {
    const raw = input.value.trim();
    if (!raw) { note.textContent = ''; results.innerHTML = ''; return; }
    const res = await resolveIsbn(raw);
    if (input.value.trim() !== raw) return;          // they kept typing
    note.textContent = explain(res);
    note.className = 'dialog__note' + (res.candidates.length ? '' : ' dialog__note--warn');
    results.innerHTML = res.candidates.map((c) => `
      <button type="button" class="candidate" data-add="${c.id}">
        <span class="candidate__title">${escHtml(c.title || 'Untitled')}</span>
        <span class="candidate__meta">${escHtml([
          c.author, c.year,
          c.collection ? `${c.collection}${c.collectionNumber ? ' ' + c.collectionNumber : ''}` : null,
          c.publisher,
        ].filter(Boolean).join(' \u00b7 '))}</span>
      </button>`).join('');
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 180); });

  // The camera button only appears when a camera can actually be asked for.
  // A dead button that explains itself after the click is worse than no button.
  const scanBtn = $('#scanBtn');
  const box = $('#scanner');
  const video = $('#scanVideo');
  const status = $('#scanStatus');
  if (!scanBtn || !cameraPossible()) return;
  scanBtn.hidden = false;

  let session = null;
  const stopScanning = () => {
    if (session) { session.stop(); session = null; }
    box.hidden = true;
    scanBtn.textContent = 'Scan with the camera';
  };
  // Closing the dialog must free the camera. Without this the stream survives
  // the dialog and the indicator light stays on.
  onModalClose(stopScanning);

  scanBtn.addEventListener('click', async () => {
    if (session) { stopScanning(); return; }
    box.hidden = false;
    scanBtn.textContent = 'Stop the camera';
    status.textContent = '';
    try {
      session = await startScanner(video, (value) => {
        session = null;
        stopScanning();
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, (msg) => { status.textContent = msg; });
    } catch (err) {
      session = null;
      box.hidden = true;
      scanBtn.textContent = 'Scan with the camera';
      note.textContent = err.message;
      note.className = 'dialog__note dialog__note--warn';
    }
  });
}

function shelfNames() {
  return Array.from(new Set(state.entries.map((e) => e.shelf).filter(Boolean))).sort();
}

export function saveFromAddDialog() {
  const form = $('#addForm');
  if (!form) return false;
  const data = Object.fromEntries(new FormData(form).entries());
  if (!String(data.title || '').trim()) { toast('A title, at least', 'bad'); return false; }
  const record = {
    id: null,
    title: String(data.title).trim(),
    authors: String(data.authors || '').split(',').map((s) => s.trim()).filter(Boolean),
    year: String(data.year || '').trim() || null,
    pages: Number(data.pages) || null,
    publisher: String(data.publisher || '').trim() || null,
    collection: String(data.collection || '').trim() || null,
    dimensions: String(data.dimensions || '').trim().replace(/x/i, '×') || null,
    cover_custom: String(data.cover_custom || '').trim() || null,
    spine_custom: String(data.spine_custom || '').trim() || null,
  };
  addEntry(record, {
    shelf: String(data.shelf || '').trim() || 'Added by hand',
    note: String(data.note || '').trim() || null,
  });
  toast(`${record.title} added to the shelf`);
  return true;
}

// ── Import and export ────────────────────────────────────────────────────────

export function exportShelf() {
  download(`vitrina-shelf-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify({ v: 1, exported: new Date().toISOString(), entries: state.entries }, null, 1));
  toast(`${plural(state.entries.length, 'book', 'books')} exported`);
}

export function importDialog() {
  openModal('Import a shelf',
    `<p class="dialog__lead">Paste a shelf exported from here, or pick the file. Importing replaces what is on the shelf now, so export first if you want to keep it.</p>
     <label class="form__row" for="importFile"><span>Choose an exported shelf</span></label>
     <input type="file" id="importFile" accept="application/json,.json" class="form__file" aria-label="Choose an exported shelf file">
     <textarea id="importText" class="form__area" rows="8" placeholder="or paste the JSON here" spellcheck="false" aria-label="Paste exported shelf JSON"></textarea>`,
    `<button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
     <button type="button" class="btn btn--ghost" id="resetShelf">Start from the demo shelf</button>
     <button type="button" class="btn btn--primary" id="importSave">Replace the shelf</button>`);
}

export function applyImport(text) {
  // Import replaces the whole shelf, so it is the likeliest way to write the
  // demo over somebody's own; state refuses too, this says why first.
  if (state.readOnly) { toast('This is a read-only shelf. Import into your own at /shelf/.', 'bad'); return false; }
  let blob;
  try {
    blob = JSON.parse(text);
  } catch (err) {
    toast('That is not valid JSON', 'bad');
    return false;
  }
  const entries = Array.isArray(blob) ? blob : (blob && blob.entries);
  if (!Array.isArray(entries) || !entries.length) { toast('No books found in that file', 'bad'); return false; }
  const usable = entries.filter((e) => e && (e.record || e.title));
  if (!usable.length) {
    toast('Nothing in that file looked like a book, so the shelf is unchanged', 'bad');
    return false;
  }
  state.entries = usable
    .map((e, i) => ({
      key: e.key || `imp${i}`,
      id: e.id != null ? e.id : null,
      slug: e.slug || null,
      shelf: e.shelf || null,
      note: e.note || null,
      added: e.added || null,
      record: e.record || e,
    }));
  reindex();
  save();
  toast(`${plural(state.entries.length, 'book', 'books')} imported`);
  return true;
}

export function resetShelf() {
  if (!window.confirm('Replace your shelf with the demo shelf? Everything on your shelf now is lost.')) return false;
  restoreSeed();
  toast('Your shelf now matches the demo. Take off what you do not own.');
  return true;
}

// ── Shelf report ─────────────────────────────────────────────────────────────

export function reportDialog() {
  const n = state.entries.length;
  const noSpine = state.entries.filter((e) => !hasSpine(e));
  const years = state.entries.map(bookYear).filter(Boolean).sort((a, b) => a - b);
  const pages = state.entries.reduce((s, e) => s + ((e.record && e.record.pages) || 0), 0);
  const cm = state.entries.reduce((s, e) => s + thick(e), 0);
  const byAuthor = tally(state.entries, (e) => (e.record && e.record.authors && e.record.authors[0]) || 'Unknown');
  const byColl = tally(state.entries, (e) => (e.record && e.record.collection) || 'None');
  const tallest = state.entries.slice().sort((a, b) => bookHeight(b) - bookHeight(a))[0];

  openModal('Shelf report',
    `<dl class="stats">
       ${stat('Books', n)}
       ${stat('Shelf length', `${cm.toFixed(0)} cm`)}
       ${stat('Pages', pages ? pages.toLocaleString() : 'unknown')}
       ${stat('Years', years.length ? `${years[0]} to ${years[years.length - 1]}` : 'unknown')}
       ${stat('Without a spine scan', noSpine.length)}
       ${stat('Tallest', tallest ? `${title(tallest)} (${bookHeight(tallest)} cm)` : '-')}
     </dl>
     <div class="stats__cols">
       <div><h3>Most collected authors</h3><ol class="stats__list">${top(byAuthor)}</ol></div>
       <div><h3>Collections</h3><ol class="stats__list">${top(byColl)}</ol></div>
     </div>
     ${noSpine.length ? `<details class="contents"><summary>The ${noSpine.length} the catalogue has no spine for</summary>
        <ul class="contents__list">${noSpine.map((e) => `<li>${escHtml(title(e))}</li>`).join('')}</ul></details>` : ''}
     <label class="check check--block">
       <input type="checkbox" id="shortcutsToggle"${state.shortcuts ? ' checked' : ''}>
       <span>Single-key shortcuts (<kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>/</kbd> <kbd>a</kbd>). Turn this off if they get in the way of speech or switch input.</span>
     </label>`,
    '<button type="button" class="btn btn--primary" data-modal-close>Close</button>');
}

function thick(e) {
  const p = (e.record && e.record.pages) || 0;
  return p ? Math.min(5.5, Math.max(0.9, p / 190)) : 1.6;
}

function stat(label, value) {
  return `<div class="stat"><dt>${escHtml(label)}</dt><dd>${escHtml(value)}</dd></div>`;
}

function tally(list, keyFn) {
  const m = new Map();
  list.forEach((e) => { const k = keyFn(e); m.set(k, (m.get(k) || 0) + 1); });
  return Array.from(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function top(pairs, n = 6) {
  return pairs.slice(0, n).map(([k, v]) => `<li><span>${escHtml(k)}</span><b>${v}</b></li>`).join('');
}
