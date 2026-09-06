// ── Browse: the catalogue, with what you already own marked ─────────────────
//
// This is the "what am I missing" view. It reads catalog.json, which holds
// every edition in the collections the shelf touches, and marks the ones
// already standing on the shelf.

import { state, addEntry } from './state.js';
import { $, escHtml, fold, toast, plural, numberOf } from './utils.js';
import { coverUrl, gaps } from './data.js';

const PAGE = 60;
let shown = PAGE;

export function resetBrowsePaging() { shown = PAGE; }

export function fillCollectionFilter() {
  const sel = $('#browseCollection');
  if (!sel || sel.dataset.filled) return;
  const seen = new Map();
  state.catalog.forEach((b) => {
    if (!b.collection_id) return;
    const label = b.publisher ? `${b.collection} (${b.publisher})` : b.collection;
    seen.set(b.collection_id, { label, n: (seen.get(b.collection_id) || { n: 0 }).n + 1 });
  });
  Array.from(seen.entries())
    .sort((a, b) => b[1].n - a[1].n)
    .forEach(([id, info]) => {
      const opt = document.createElement('option');
      opt.value = String(id);
      opt.textContent = `${info.label} (${info.n})`;
      sel.appendChild(opt);
    });
  sel.dataset.filled = '1';
}

function filtered() {
  const q = fold(state.query);
  const terms = q.split(/\s+/).filter(Boolean);
  const cid = state.browseCollection ? Number(state.browseCollection) : null;
  return state.catalog.filter((b) => {
    if (cid && b.collection_id !== cid) return false;
    if (state.hideOwned && state.ownedIds.has(b.id)) return false;
    if (!terms.length) return true;
    const hay = fold([b.title, (b.authors || []).join(' '), b.collection, b.subcollection, b.publisher, b.isbn]
      .filter(Boolean).join(' '));
    return terms.every((t) => hay.includes(t));
  });
}

export function renderBrowse() {
  fillCollectionFilter();
  const view = $('#view-browse');
  const list = filtered();
  const owned = list.filter((b) => state.ownedIds.has(b.id)).length;

  $('#count').textContent = state.catalog.length
    ? `${list.length} in the catalogue, ${owned} on your shelf`
    : 'catalogue not built yet';

  if (!state.catalog.length) {
    view.innerHTML = `<div class="empty">
        <p class="empty__lead">The catalogue file is not here yet.</p>
        <p class="empty__hint">Run <code>python3 scripts/scrape.py catalog</code> to build <code>data/catalog.json</code> from the collections your shelf already touches.</p>
      </div>`;
    return;
  }

  const slice = list.slice(0, shown);
  view.innerHTML = `
    ${gapsMarkup()}
    <div class="browsegrid">${slice.map(browseCard).join('')}</div>
    ${list.length > shown
      ? `<div class="more"><button type="button" class="btn btn--secondary" id="moreBtn">Show ${Math.min(PAGE, list.length - shown)} more of ${list.length - shown}</button></div>`
      : ''}`;
}

function browseCard(b) {
  const own = state.ownedIds.has(b.id);
  const num = b.collection_number && numberOf(b.collection_number) !== Number.MAX_SAFE_INTEGER
    ? b.collection_number : null;
  return `<article class="bcard${own ? ' is-own' : ''}">
      <div class="bcard__art">
        <img src="${escHtml(coverUrl(b.id))}" alt="" loading="lazy" decoding="async">
        ${own ? '<span class="bcard__own">On your shelf</span>' : ''}
      </div>
      <h3 class="bcard__title">${escHtml(b.title)}</h3>
      <p class="bcard__by">${escHtml((b.authors || []).slice(0, 2).join(', ') || 'Unknown')}</p>
      <p class="bcard__meta">${escHtml(b.collection || '')}${num ? ' ' + escHtml(num) : ''}${b.year ? ' &middot; ' + escHtml(b.year) : ''}</p>
      <button type="button" class="btn btn--ghost btn--sm bcard__add" data-add="${b.id}"${own ? ' disabled' : ''}>
        ${own ? 'Already yours' : 'Add to shelf'}
      </button>
    </article>`;
}

function gapsMarkup() {
  const g = gaps();
  if (!g.length) return '';
  const top = g.slice(0, 4);
  return `<section class="gaps">
      <h2 class="gaps__title">Gaps in your series</h2>
      <p class="gaps__lead">Volumes the catalogue numbers in a series you already collect.</p>
      <ul class="gaps__list">
        ${top.map((s) => `<li>
            <strong>${escHtml(s.series)}</strong>
            <span class="gaps__have">${plural(s.have, 'volume', 'volumes')} on the shelf</span>
            <span class="gaps__missing">${s.missing.map((b) =>
              `<button type="button" class="chip" data-add="${b.id}" title="Add to shelf">${escHtml(b.subcollection_number || '?')}. ${escHtml(b.title)}</button>`).join('')}</span>
          </li>`).join('')}
      </ul>
    </section>`;
}

export function showMore() {
  shown += PAGE;
}

export function addFromCatalog(id) {
  const rec = state.catalog.find((b) => b.id === Number(id));
  if (!rec) { toast('That book is not in the catalogue file', 'bad'); return false; }
  const entry = addEntry({ ...rec }, { shelf: rec.publisher === 'Ediciones B' && rec.collection === 'Nova' ? 'Nova' : rec.collection });
  if (!entry) { toast('Already on your shelf'); return false; }
  toast(`${rec.title} added to the shelf`);
  return true;
}
