// ── Loading, grouping and ordering ───────────────────────────────────────────

import { state } from './state.js';
import { fold, yearOf, heightCm, numberOf, authorKey, titleKey } from './utils.js';

export const SOURCE = 'https://tercerafundacion.net';
export const spineUrl = (id) => `${SOURCE}/imagenes/lomo/L-${String(id).padStart(8, '0')}.jpg`;
export const coverUrl = (id) => `${SOURCE}/imagenes/portada/P-${String(id).padStart(8, '0')}.jpg`;
export const recordUrl = (id) => `${SOURCE}/biblioteca/ver/libro/${id}/`;

// Fallback copies, written by `scripts/scrape.py cache-images`. The catalogue
// serves the originals with a one-year cache header and no hotlink protection,
// so the page asks it first and nothing is republished. These are what the
// shelf falls back to when a request fails: a blocked hotlink, a dead host, or
// a laptop on a plane. Absent by default (data/images/ is gitignored), and the
// drawn spine remains the last resort.
export const localSpine = (id) => `/data/images/lomo-${String(id).padStart(8, '0')}.jpg`;
export const localCover = (id) => `/data/images/portada-${String(id).padStart(8, '0')}.jpg`;

// What is actually in that directory, written by `cache-images`. Without it the
// page cannot tell a cached image from one that was never fetched, and every
// catalogue spine with no scan costs a second doomed request. Absent on the
// published page, where both sets stay empty and nothing is retried.
const cached = { spine: new Set(), cover: new Set() };
export const hasLocalSpine = (id) => cached.spine.has(Number(id));
export const hasLocalCover = (id) => cached.cover.has(Number(id));

// Thumbnails of the shelf's own books, built by `scripts/thumbs.py` and, unlike
// the cache above, committed and served by this site. A spine is 7 KB at the
// source and is drawn about 30px wide; these are sized to what the page paints,
// which takes the shelf's 31 spines from 218 KB to 84 KB and its 39 covers from
// 1.4 MB to 563 KB. Only the books on the shelf have one. The other 525 volumes
// in the whole-collection view stay hotlinked, which is the point: this
// republishes a copy of what is already on the page every time, and nothing more.
const thumbs = { spine: new Set(), cover: new Set() };
const pad = (id) => String(id).padStart(8, '0');
export const thumbSpine = (id) => `/assets/thumbs/lomo-${pad(id)}.webp`;
export const thumbCover = (id) => `/assets/thumbs/portada-${pad(id)}.webp`;
export const hasThumbSpine = (id) => thumbs.spine.has(Number(id));
export const hasThumbCover = (id) => thumbs.cover.has(Number(id));

async function getJson(path, fallback, { quiet = false } = {}) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    if (!quiet) console.warn(`Vitrina could not read ${path}:`, err && err.message);
    return fallback;
  }
}

export async function loadData() {
  const [library, catalog, images, thumbIndex] = await Promise.all([
    getJson('/data/library.json', { books: [] }),
    getJson('/data/catalog.json', { books: [], collections: [] }),
    getJson('/data/images/index.json', null, { quiet: true }),
    getJson('/assets/thumbs/index.json', null, { quiet: true }),
  ]);
  if (images) {
    (images.spine || []).forEach((id) => cached.spine.add(id));
    (images.cover || []).forEach((id) => cached.cover.add(id));
  }
  if (thumbIndex) {
    (thumbIndex.spine || []).forEach((id) => thumbs.spine.add(id));
    (thumbIndex.cover || []).forEach((id) => thumbs.cover.add(id));
  }
  state.catalog = (catalog.books || []).filter((b) => b && b.id != null);
  state.collections = catalog.collections || [];
  return (library.books || []).filter((b) => b && (b.id != null || b.title));
}

// ── Reading a record ─────────────────────────────────────────────────────────

export function title(entry) {
  return (entry.record && entry.record.title) || 'Untitled';
}

export function authors(entry) {
  const a = entry.record && entry.record.authors;
  return Array.isArray(a) && a.length ? a : [];
}

export function authorLine(entry) {
  const a = authors(entry);
  if (!a.length) return 'Unknown author';
  if (a.length <= 3) return a.join(', ');
  return `${a.slice(0, 2).join(', ')} and ${a.length - 2} more`;
}

/** Physical height in cm, used to scale the spine. 19 is the Nova paperback. */
export function bookHeight(entry) {
  return heightCm(entry.record && entry.record.dimensions) || 19;
}

export function bookYear(entry) {
  return yearOf(entry.record && entry.record.year);
}

export function hasSpine(entry) {
  const r = entry.record || {};
  if (r.spine_custom) return true;
  // `false` is a measured answer from `scrape.py spines`; absent means unchecked,
  // which is every book added from Browse. Optimistic on unchecked, because the
  // image `error` handlers in shelf.js and detail.js catch the ones that 404.
  return r.id != null && r.has_spine !== false;
}

export function spineFor(entry) {
  const r = entry.record || {};
  if (r.spine_custom) return r.spine_custom;
  if (r.id == null) return null;
  return hasThumbSpine(r.id) ? thumbSpine(r.id) : spineUrl(r.id);
}

export function coverFor(entry) {
  const r = entry.record || {};
  if (r.cover_custom) return r.cover_custom;
  if (r.id == null) return null;
  return hasThumbCover(r.id) ? thumbCover(r.id) : coverUrl(r.id);
}

// ── Grouping ─────────────────────────────────────────────────────────────────

const GROUPERS = {
  shelf: (e) => e.shelf || (e.record && e.record.collection) || 'Unshelved',
  collection: (e) => {
    const r = e.record || {};
    if (!r.collection) return r.publisher || 'No collection';
    return r.publisher ? `${r.collection} (${r.publisher})` : r.collection;
  },
  author: (e) => (authors(e)[0] || 'Unknown author'),
  series: (e) => {
    const r = e.record || {};
    if (r.subcollection) return r.subcollection;
    if (Array.isArray(r.series) && r.series.length) return r.series[0];
    return 'Standalone';
  },
  decade: (e) => {
    const y = bookYear(e);
    return y ? `${Math.floor(y / 10) * 10}s` : 'Undated';
  },
  none: () => 'The shelf',
};

const SORTERS = {
  number: (a, b) => {
    const na = numberOf(a.record && a.record.collection_number);
    const nb = numberOf(b.record && b.record.collection_number);
    if (na !== nb) return na - nb;
    return titleKey(title(a)).localeCompare(titleKey(title(b)));
  },
  title: (a, b) => titleKey(title(a)).localeCompare(titleKey(title(b))),
  author: (a, b) => {
    const c = authorKey(authors(a)[0] || 'zzz').localeCompare(authorKey(authors(b)[0] || 'zzz'));
    return c || SORTERS.number(a, b);
  },
  year: (a, b) => (bookYear(a) || 9999) - (bookYear(b) || 9999),
  height: (a, b) => bookHeight(b) - bookHeight(a),
};

export function matches(entry, query) {
  if (!query) return true;
  const r = entry.record || {};
  const list = (v) => (Array.isArray(v) ? v.join(' ') : (v || ''));
  const hay = fold([
    r.title, list(r.authors), r.collection, r.subcollection,
    r.publisher, list(r.series), r.isbn, entry.shelf, entry.note,
    list(r.translators), list(r.cover_art),
  ].filter(Boolean).join(' '));
  return fold(query).split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

/** [{ label, books }] ready to render, filtered, grouped and ordered. */
export function shelves() {
  const grouper = GROUPERS[state.groupBy] || GROUPERS.shelf;
  const sorter = SORTERS[state.sortBy] || SORTERS.number;
  const visible = state.entries.filter((e) => matches(e, state.query));
  const map = new Map();
  visible.forEach((e) => {
    const label = grouper(e);
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(e);
  });
  const groups = Array.from(map, ([label, books]) => ({ label, books: books.sort(sorter) }));
  groups.sort((a, b) => {
    if (state.groupBy === 'decade') return a.label.localeCompare(b.label);
    if (b.books.length !== a.books.length) return b.books.length - a.books.length;
    return a.label.localeCompare(b.label);
  });
  return { groups, total: visible.length };
}

/**
 * Volumes of a series the shelf is missing, found by comparing the owned
 * subcollection numbers against every edition of that subcollection in the
 * catalogue. This is the question a collector actually asks.
 */
export function gaps() {
  const owned = new Map();
  state.entries.forEach((e) => {
    const r = e.record || {};
    if (!r.subcollection_id) return;
    if (!owned.has(r.subcollection_id)) owned.set(r.subcollection_id, { name: r.subcollection, have: new Set() });
    owned.get(r.subcollection_id).have.add(numberOf(r.subcollection_number));
  });
  const out = [];
  owned.forEach((info, sid) => {
    const all = state.catalog.filter((b) => b.subcollection_id === sid);
    const missing = all.filter((b) => {
      const n = numberOf(b.subcollection_number);
      return n !== Number.MAX_SAFE_INTEGER && !info.have.has(n) && !state.ownedIds.has(b.id);
    });
    const seen = new Map();
    missing.forEach((b) => {
      const n = numberOf(b.subcollection_number);
      if (!seen.has(n)) seen.set(n, b);
    });
    if (seen.size) {
      out.push({
        series: info.name,
        have: info.have.size,
        missing: Array.from(seen.values()).sort((a, b) => numberOf(a.subcollection_number) - numberOf(b.subcollection_number)),
      });
    }
  });
  return out.sort((a, b) => a.missing.length - b.missing.length);
}


/** Leading integer of a collection number, or null when it is unnumbered. */
function slot(raw) {
  const m = String(raw == null ? '' : raw).match(/\d+/);
  return m ? Number(m[0]) : null;
}

/**
 * The complete run of every collection the shelf owns something from, with the
 * owned volumes marked. This is the collector's actual view: Nova is numbered
 * 0 to 363 and the shelf holds thirteen of them, so the question is which 349
 * are missing, not which thirteen are present.
 *
 * A number can carry several catalogued editions (Nova 205 has six), so each
 * slot keeps one representative: the owned copy when there is one, otherwise
 * the oldest printing with a spine scan, which is the art worth showing.
 */
export function collectionRuns() {
  // A slot holds a LIST, not one book: the catalogue numbers the whole saga
  // del retorno as VIB 11, so three owned volumes share that number and keying
  // by slot alone silently dropped two of them.
  const mine = new Map();          // collection_id -> Map(slot -> [entry])
  const unslotted = new Map();     // collection_id -> [entry]
  state.entries.forEach((e) => {
    const r = e.record || {};
    if (r.collection_id == null) return;
    const n = slot(r.collection_number);
    if (n == null) {
      if (!unslotted.has(r.collection_id)) unslotted.set(r.collection_id, []);
      unslotted.get(r.collection_id).push(e);
      return;
    }
    if (!mine.has(r.collection_id)) mine.set(r.collection_id, new Map());
    const at = mine.get(r.collection_id);
    if (!at.has(n)) at.set(n, []);
    at.get(n).push(e);
  });

  const runs = [];
  const ids = new Set([...mine.keys(), ...unslotted.keys()]);
  ids.forEach((cid) => {
    const owned = mine.get(cid) || new Map();
    const pool = state.catalog.filter((b) => b.collection_id === cid);
    const head = state.collections.find((c) => c.id === cid) || {};
    const bySlot = new Map();
    const loose = [];
    pool.forEach((b) => {
      const n = slot(b.collection_number);
      if (n == null) { loose.push(b); return; }
      const held = bySlot.get(n);
      if (!held || better(b, held)) bySlot.set(n, b);
    });

    const slots = new Set([...bySlot.keys(), ...owned.keys()]);
    const volumes = [];
    Array.from(slots).sort((a, b) => a - b).forEach((n) => {
      const here = owned.get(n);
      if (here && here.length) {
        // Order a shared slot the way the saga runs, by subcollection number.
        here.slice().sort((a, b) => numberOf((a.record || {}).subcollection_number)
                                  - numberOf((b.record || {}).subcollection_number))
          .forEach((e) => volumes.push({ number: n, key: e.key, record: e.record, owned: true }));
        return;
      }
      const rec = bySlot.get(n);
      if (rec) volumes.push({ number: n, key: 'cat' + rec.id, record: rec, owned: false });
    });

    // Volumes the catalogue never numbered. The B de Bolsillo line numbers only
    // two of its ninety-nine, so dropping them would hide the whole collection.
    const ownedLoose = unslotted.get(cid) || [];
    const ownedLooseIds = new Set(ownedLoose.map((e) => e.id));
    ownedLoose.forEach((e) => volumes.push({ number: null, key: e.key, record: e.record, owned: true }));
    loose.filter((b) => !ownedLooseIds.has(b.id) && !state.ownedIds.has(b.id))
      .sort((a, b) => (yearOf(a.year) || 0) - (yearOf(b.year) || 0))
      .forEach((b) => volumes.push({ number: null, key: 'cat' + b.id, record: b, owned: false }));

    if (!volumes.length) return;
    const full = volumes.length;
    // The search box has to reach this view too. Same predicate as the shelf
    // and the browser, so "matches" has one definition: filtering here rather
    // than dimming keeps the count honest and, with a 13,900px Nova row, is
    // the only way a match 300 volumes along is reachable at all.
    const shown = state.query
      ? volumes.filter((v) => matches({ record: v.record, shelf: null, note: null }, state.query))
      : volumes;
    if (!shown.length) return;
    runs.push({
      id: cid,
      label: head.publisher ? `${head.name} (${head.publisher})` : (head.name || 'Collection'),
      volumes: shown,
      owned: shown.filter((v) => v.owned).length,
      total: shown.length,
      full,
      filtered: shown.length !== full,
    });
  });
  return runs.sort((a, b) => b.owned - a.owned || a.label.localeCompare(b.label));
}

/** Prefer a scanned spine, then the older printing: that is the art to show. */
function better(a, b) {
  const sa = a.has_spine !== false, sb = b.has_spine !== false;
  if (sa !== sb) return sa;
  return (yearOf(a.year) || 9999) < (yearOf(b.year) || 9999);
}

/** A catalogue record the shelf does not own, addressed as `cat<id>`. */
export function catalogEntry(key) {
  const id = Number(String(key).replace(/^cat/, ''));
  const rec = state.catalog.find((b) => b.id === id);
  return rec ? { key, id, shelf: null, note: null, record: rec, notOwned: true } : null;
}
