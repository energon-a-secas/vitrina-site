// ── Dialogs: add a book, import, shelf report ───────────────────────────────

import { state, addEntry, restoreSeed, reindex, save } from './state.js';
import { $, escHtml, toast, download, plural } from './utils.js';
import { title, bookYear, hasSpine, bookHeight } from './data.js';

let hideTimer = null;
let opener = null;

export function openModal(heading, body, footer) {
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
     <button type="button" class="btn btn--ghost" id="resetShelf">Back to the original shelf</button>
     <button type="button" class="btn btn--primary" id="importSave">Replace the shelf</button>`);
}

export function applyImport(text) {
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
  if (!window.confirm('Put the original shelf back? Anything you added here is lost.')) return false;
  restoreSeed();
  toast('Original shelf restored');
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
