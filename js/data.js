// ── Loading, grouping and ordering ───────────────────────────────────────────

import { state } from './state.js';
import { fold, yearOf, heightCm, numberOf, authorKey, titleKey } from './utils.js';

export const SOURCE = 'https://tercerafundacion.net';
export const spineUrl = (id) => `${SOURCE}/imagenes/lomo/L-${String(id).padStart(8, '0')}.jpg`;
export const coverUrl = (id) => `${SOURCE}/imagenes/portada/P-${String(id).padStart(8, '0')}.jpg`;
export const recordUrl = (id) => `${SOURCE}/biblioteca/ver/libro/${id}/`;

async function getJson(path, fallback) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    console.warn(`Vitrina could not read ${path}:`, err && err.message);
    return fallback;
  }
}

export async function loadData() {
  const [library, catalog] = await Promise.all([
    getJson('data/library.json', { books: [] }),
    getJson('data/catalog.json', { books: [], collections: [] }),
  ]);
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
  return r.id != null ? spineUrl(r.id) : null;
}

export function coverFor(entry) {
  const r = entry.record || {};
  if (r.cover_custom) return r.cover_custom;
  return r.id != null ? coverUrl(r.id) : null;
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
