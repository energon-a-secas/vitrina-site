// ── The detail drawer: one book, pulled off the shelf ────────────────────────

import { state, findEntry, removeEntry, updateEntry, whose } from './state.js';
import { $, escHtml, toast } from './utils.js';
import { markSelected } from './render.js';
import {
  title, authorLine, bookYear, coverFor, spineFor, hasSpine, recordUrl,
  catalogEntry, localCover, localSpine, hasLocalSpine, hasLocalCover,
  spineUrl, coverUrl, hasThumbSpine, hasThumbCover,
} from './data.js';

let hideTimer = null;
let opener = null;

export function openBook(key) {
  const entry = findEntry(key) || catalogEntry(key);
  if (!entry) return;
  const drawer = $('#drawer');
  clearTimeout(hideTimer);
  if (drawer.hidden) opener = document.activeElement;
  state.selected = key;
  const r0 = (entry.record || {}).id;
  $('#drawerBody').innerHTML = detailMarkup(entry);
  drawer.hidden = false;
  // Same walk down the sources as the shelf: our thumbnail, then the
  // catalogue, then the development cache, then give up on the image.
  const art = $('.detail__spine');
  if (art) art.addEventListener('error', () => {
    if (r0 == null) { art.remove(); return; }
    if (hasThumbSpine(r0) && !art.dataset.triedRemote) { art.dataset.triedRemote = '1'; art.src = spineUrl(r0); return; }
    if (hasLocalSpine(r0) && !art.dataset.triedLocal) { art.dataset.triedLocal = '1'; art.src = localSpine(r0); return; }
    art.remove();
  });
  const face = $('.detail__cover');
  if (face && face.tagName === 'IMG') face.addEventListener('error', () => {
    if (r0 == null) return;
    if (hasThumbCover(r0) && !face.dataset.triedRemote) { face.dataset.triedRemote = '1'; face.src = coverUrl(r0); return; }
    if (hasLocalCover(r0) && !face.dataset.triedLocal) { face.dataset.triedLocal = '1'; face.src = localCover(r0); }
  });
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => drawer.classList.add('is-open'));
  $('.drawer__panel').focus();
  markSelected();
}

export function closeBook() {
  const drawer = $('#drawer');
  if (!drawer || drawer.hidden) return;
  drawer.classList.remove('is-open');
  state.selected = null;
  markSelected();
  if (!$('#modal') || $('#modal').hidden) document.body.classList.remove('modal-open');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { drawer.hidden = true; }, 220);
  // Back to the spine that was clicked, not to the top of the document.
  if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  opener = null;
}

/** Close the drawer if the book it is showing is no longer on the shelf. */
export function closeIfGone() {
  if (state.selected && !findEntry(state.selected)) closeBook();
}

function row(label, value) {
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return '';
  const v = Array.isArray(value) ? value.join(', ') : value;
  return `<div class="fact"><dt>${escHtml(label)}</dt><dd>${escHtml(v)}</dd></div>`;
}

function detailMarkup(entry) {
  const r = entry.record || {};
  const cover = coverFor(entry);
  const spine = spineFor(entry);
  const y = bookYear(entry);
  const coll = r.collection
    ? `${r.collection}${r.collection_number ? ' ' + r.collection_number : ''}`
    : null;
  const sub = r.subcollection
    ? `${r.subcollection}${r.subcollection_number ? ' ' + r.subcollection_number : ''}`
    : null;

  const contents = Array.isArray(r.contents) && r.contents.length > 1
    ? `<details class="contents">
         <summary>Contents (${r.contents.length})</summary>
         <ol class="contents__list">
           ${r.contents.map((c) => `<li><span class="contents__pp">${escHtml(c.pages || '')}</span> ${escHtml(c.entry || '')}</li>`).join('')}
         </ol>
       </details>`
    : '';

  return `
    <div class="detail">
      <div class="detail__art">
        ${cover ? `<img class="detail__cover" src="${escHtml(cover)}" alt="Front cover of ${escHtml(title(entry))}" loading="lazy">`
                : '<div class="detail__cover detail__cover--none">no cover scan</div>'}
        ${spine && hasSpine(entry) ? `<img class="detail__spine" src="${escHtml(spine)}" alt="" loading="lazy">` : ''}
      </div>

      <div class="detail__text">
        <h2 id="drawerTitle" class="detail__title">${escHtml(title(entry))}</h2>
        <p class="detail__by">${escHtml(authorLine(entry))}${y ? ` &middot; ${y}` : ''}</p>

        ${entry.notOwned ? `<p class="detail__warn">This one is in the catalogue, not on ${whose('your shelf', 'this shelf')}.</p>` : ''}
        ${entry.note ? `<p class="detail__note">${escHtml(entry.note)}</p>` : ''}

        <dl class="facts">
          ${row('Publisher', r.publisher)}
          ${row('Collection', coll)}
          ${row('Series', sub || (Array.isArray(r.series) ? r.series.join(', ') : null))}
          ${row('Shelf', entry.shelf)}
          ${row('Format', r.format)}
          ${row('ISBN', r.isbn)}
          ${row('Translation', r.translators)}
          ${row('Cover art', r.cover_art)}
          ${row('Awards', r.awards)}
          ${row(whose('Listed by you as', 'Listed by its owner as'), entry.listed_as || (r.listed_as || null))}
        </dl>

        ${contents}

        <div class="detail__actions">
          ${r.id != null ? `<a class="btn btn--secondary btn--sm" href="${escHtml(recordUrl(r.id))}" target="_blank" rel="noopener noreferrer">Read the catalogue record</a>` : ''}
          ${entry.notOwned
            ? `<button type="button" class="btn btn--primary btn--sm" data-add="${r.id}">Put it on the shelf</button>`
            : `<button type="button" class="btn btn--ghost btn--sm" data-act="note" data-key="${escHtml(entry.key)}">${entry.note ? 'Edit note' : 'Add a note'}</button>
               <button type="button" class="btn btn--danger btn--sm" data-act="remove" data-key="${escHtml(entry.key)}">Take off the shelf</button>`}
        </div>

        ${hasSpine(entry) ? '' : '<p class="detail__warn">The catalogue has no spine scan for this edition, so the shelf draws one.</p>'}
      </div>
    </div>`;
}

export function editNote(key) {
  const entry = findEntry(key);
  if (!entry) return;
  const next = window.prompt('A note for this copy (where you found it, condition, anything):', entry.note || '');
  if (next === null) return;
  updateEntry(key, { note: next.trim() || null });
  openBook(key);
  toast('Note saved');
}

export function takeOff(key) {
  const entry = findEntry(key);
  if (!entry) return;
  if (!window.confirm(`Take "${title(entry)}" off the shelf?`)) return;
  removeEntry(key);
  closeBook();
  toast(`${title(entry)} removed`);
  return true;
}
