// ── Shared mutable state, and the only place localStorage is touched ──────────
//
// The shelf is a list of entries. Every entry carries its own record, so a book
// stays on the shelf with all its data even if the catalogue file it came from
// is later trimmed, and a hand-added book needs no catalogue at all.

const KEY = 'vitrina_shelf_v1';
const PREFS = 'vitrina_prefs_v1';

export const state = {
  view: 'shelf',
  groupBy: 'shelf',
  sortBy: 'number',
  query: '',
  trueScale: true,
  hideOwned: false,
  browseCollection: '',
  shortcuts: true,    // WCAG 2.1.4: a single-key shortcut needs an off switch
  showRuns: false,    // draw the whole collection, not just what is owned

  entries: [],        // the shelf
  catalog: [],        // browsable records from the collections we crawled
  collections: [],    // catalog collection headers
  seed: [],           // library.json, kept so "reset to the original shelf" works
  ownedIds: new Set(),
  selected: null,     // entry key currently open in the drawer
  loaded: false,
};

/** A stable key: the catalogue id when there is one, else a minted local id. */
let localSeq = 0;
export function entryKey(entry) {
  if (entry.id != null) return 'tf' + entry.id;
  if (entry.key) return entry.key;
  localSeq += 1;
  return 'own' + Date.now().toString(36) + localSeq;
}

export function reindex() {
  state.ownedIds = new Set(state.entries.filter((e) => e.id != null).map((e) => e.id));
}

let warnedAboutStorage = false;

/** True when the shelf reached storage. Callers report their own failure. */
export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, entries: state.entries }));
    return true;
  } catch (err) {
    // A private window, or a browser set to block site data. The shelf still
    // works for this session; it just will not be here next time. Say so once,
    // rather than letting every "added to the shelf" toast be a quiet lie.
    console.warn('Vitrina could not save the shelf:', err && err.message);
    if (!warnedAboutStorage) {
      warnedAboutStorage = true;
      document.dispatchEvent(new CustomEvent('vitrina:storage-blocked'));
    }
    return false;
  }
}

export function savePrefs() {
  try {
    localStorage.setItem(PREFS, JSON.stringify({
      view: state.view, groupBy: state.groupBy, sortBy: state.sortBy,
      trueScale: state.trueScale, hideOwned: state.hideOwned,
      shortcuts: state.shortcuts, showRuns: state.showRuns,
    }));
  } catch (err) { /* preferences are a convenience, never a blocker */ }
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.view) state.view = p.view;
    if (p.groupBy) state.groupBy = p.groupBy;
    if (p.sortBy) state.sortBy = p.sortBy;
    if (typeof p.trueScale === 'boolean') state.trueScale = p.trueScale;
    if (typeof p.hideOwned === 'boolean') state.hideOwned = p.hideOwned;
    if (typeof p.shortcuts === 'boolean') state.shortcuts = p.shortcuts;
    if (typeof p.showRuns === 'boolean') state.showRuns = p.showRuns;
  } catch (err) { /* fall through to defaults */ }
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const blob = JSON.parse(raw);
    // An empty array is a real answer: the visitor took every book off. Only a
    // missing or unparseable record means "never saved", and it is the only
    // case that may fall back to the seed.
    return Array.isArray(blob && blob.entries) ? blob.entries : null;
  } catch (err) {
    return null;
  }
}

/**
 * Seed from library.json the first time, then let the browser copy win.
 * `seed` is kept so the shelf can be restored after an edit goes wrong.
 */
export function hydrate(library) {
  loadPrefs();
  state.seed = library.map(toEntry);
  const saved = loadSaved();
  state.entries = saved ? saved.map(normalise) : state.seed.map((e) => ({ ...e }));
  reindex();
  state.loaded = true;
}

function toEntry(rec) {
  return {
    key: rec.id != null ? 'tf' + rec.id : entryKey(rec),
    id: rec.id != null ? rec.id : null,
    slug: rec.slug || null,
    shelf: rec.shelf || null,
    note: rec.note_mine || null,
    added: null,
    record: rec,
  };
}

function normalise(e) {
  return {
    key: e.key || entryKey(e),
    id: e.id != null ? e.id : null,
    slug: e.slug || null,
    shelf: e.shelf || null,
    note: e.note || null,
    added: e.added || null,
    record: e.record || {},
  };
}

export function addEntry(record, { shelf = null, note = null } = {}) {
  if (record.id != null && state.ownedIds.has(record.id)) return null;
  const entry = {
    key: record.id != null ? 'tf' + record.id : entryKey({}),
    id: record.id != null ? record.id : null,
    slug: record.slug || null,
    shelf: shelf || record.shelf || record.collection || 'Added by hand',
    note,
    added: new Date().toISOString().slice(0, 10),
    record,
  };
  state.entries.push(entry);
  reindex();
  save();
  return entry;
}

export function removeEntry(key) {
  const before = state.entries.length;
  state.entries = state.entries.filter((e) => e.key !== key);
  if (state.entries.length !== before) {
    reindex();
    save();
    return true;
  }
  return false;
}

export function updateEntry(key, patch) {
  const entry = state.entries.find((e) => e.key === key);
  if (!entry) return null;
  Object.assign(entry, patch);
  save();
  return entry;
}

export function findEntry(key) {
  return state.entries.find((e) => e.key === key) || null;
}

export function restoreSeed() {
  state.entries = state.seed.map((e) => ({ ...e }));
  reindex();
  save();
}
