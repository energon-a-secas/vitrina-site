// ── View rendering ───────────────────────────────────────────────────────────

import { state } from './state.js';
import { $, $$, escHtml, plural } from './utils.js';
import { shelves, title, authorLine, bookYear, coverFor, hasSpine, collectionRuns } from './data.js';
import { shelfMarkup, runMarkup, measureSpines, markScrollable } from './shelf.js';
import { renderBrowse } from './browse.js';

export function render() {
  const focused = document.activeElement;
  const focusKey = focused && focused.dataset ? focused.dataset.key : null;
  syncControls();
  if (state.view === 'shelf') renderShelf();
  else if (state.view === 'covers') renderCovers();
  else renderBrowse();
  markSelected();
  if (focusKey) {
    const again = document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}

function syncControls() {
  $$('.viewswitch__btn').forEach((b) => {
    const on = b.dataset.view === state.view;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== state.view; });
  $$('[data-only-view]').forEach((el) => {
    el.hidden = !el.dataset.onlyView.split(' ').includes(state.view);
  });
  // Never write into the box the visitor is typing in. `state.query` is the
  // trimmed value, so echoing it back deleted the space at the end of a word
  // and turned "orson scott" into "orsonscott" mid-search.
  const search = $('#search');
  if (search && search !== document.activeElement && search.value !== state.query) {
    search.value = state.query;
  }
}

function renderShelf() {
  const view = $('#view-shelf');
  if (state.showRuns) { renderRuns(view); return; }
  const { groups, total } = shelves();
  count(total);
  if (!total) { view.innerHTML = empty(); return; }
  view.innerHTML = groups.map((g) => shelfMarkup(g, { trueScale: state.trueScale })).join('');
  measureSpines(view);
  markScrollable(view);
}

/**
 * Every collection the shelf owns from, drawn whole. Grouping and ordering do
 * not apply here: a collection's order is its own numbering, which is the whole
 * point of looking at it this way.
 */
function renderRuns(view) {
  const runs = collectionRuns();
  const owned = runs.reduce((n, r) => n + r.owned, 0);
  const total = runs.reduce((n, r) => n + r.total, 0);
  const el = $('#count');
  if (el) {
    el.textContent = state.query
      ? `${total} matching, ${owned} of them yours`
      : (total ? `${owned} of ${total} across ${runs.length} collections` : '');
  }
  if (!runs.length) {
    view.innerHTML = state.query
      ? `<div class="empty">
          <p class="empty__lead">Nothing in these collections matches that.</p>
          <p class="empty__hint">The search covers every catalogued volume here, not just yours.</p>
        </div>`
      : `<div class="empty">
          <p class="empty__lead">No collection to draw yet.</p>
          <p class="empty__hint">This needs <code>data/catalog.json</code>. Run <code>python3 scripts/scrape.py catalog</code>.</p>
        </div>`;
    return;
  }
  view.innerHTML = runs.map((r) => runMarkup(r, { trueScale: state.trueScale })).join('');
  measureSpines(view);
  markScrollable(view);
}

function renderCovers() {
  const view = $('#view-covers');
  const { groups, total } = shelves();
  count(total);
  if (!total) { view.innerHTML = empty(); return; }
  view.innerHTML = groups.map((g) => `
    <section class="coverset">
      <header class="shelfrow__head">
        <h2 class="shelfrow__label">${escHtml(g.label)}</h2>
        <span class="shelfrow__count">${g.books.length}</span>
      </header>
      <div class="covergrid">${g.books.map(coverCard).join('')}</div>
    </section>`).join('');
}

function coverCard(entry) {
  const src = coverFor(entry);
  const y = bookYear(entry);
  // The flag sits first in the DOM, so without aria-hidden the button announced
  // itself as "no spine" before the title it is actually for.
  const name = `${title(entry)}, ${authorLine(entry)}${y ? ', ' + y : ''}`;
  return `<button type="button" class="cover" data-key="${escHtml(entry.key)}" aria-label="${escHtml(name)}">
      <span class="cover__frame">
        ${src ? `<img src="${escHtml(src)}" alt="" loading="lazy" decoding="async">` : '<span class="cover__none" aria-hidden="true">no scan</span>'}
        ${hasSpine(entry) ? '' : '<span class="cover__flag" aria-hidden="true" title="No spine scan in the catalogue">no spine</span>'}
      </span>
      <span class="cover__title">${escHtml(title(entry))}</span>
      <span class="cover__meta">${escHtml(authorLine(entry))}${y ? ` &middot; ${y}` : ''}</span>
    </button>`;
}

function empty() {
  return `<div class="empty">
      <p class="empty__lead">${state.query ? 'Nothing on the shelf matches that.' : 'The shelf is empty.'}</p>
      <p class="empty__hint">${state.query
        ? 'Clear the search, or look in <strong>Browse</strong> for a book you have not added yet.'
        : 'Open <strong>Browse</strong> to add books from the catalogue, or <strong>Add a book</strong> to enter one by hand.'}</p>
    </div>`;
}

function count(n) {
  const el = $('#count');
  if (!el) return;
  const all = state.entries.length;
  el.textContent = n === all
    ? plural(all, 'book', 'books')
    : `${n} of ${plural(all, 'book', 'books')}`;
}

export function markSelected() {
  $$('.spine, .cover').forEach((el) => {
    el.classList.toggle('is-open', el.dataset.key === state.selected);
  });
}
