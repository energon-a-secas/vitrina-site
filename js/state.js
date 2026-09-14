// ── Shared mutable state, and the only place the shelf meets localStorage ─────
//
// The shelf is a list of entries. Every entry carries its own record, so a book
// stays on the shelf with all its data even if the catalogue file it came from
// is later trimmed, and a hand-added book needs no catalogue at all.
//
// state.source says whose shelf memory holds: the one kept in this browser
// (local); a signed-in person's (account, reached through account-loading, or
// account-error when it could not be read); the demo's; or a shared shelf's
// (profile). vitrina_shelf_v1 holds the browser shelf and nothing else. save()
// writes it only while the source is local, and rewriteBrowserShelf() and
// clearBrowserShelf() read nothing but storage itself. Nothing that came from an
// account can reach that key, so a browser two people share never shows one of
// them the other's shelf. tests/readonly.test.mjs holds this with a note only
// an account row carries.

import { bibliographic, collapseByKey } from './syncplan.js';
import { mintUuid } from './utils.js';

const KEY = 'vitrina_shelf_v1';
const PREFS = 'vitrina_prefs_v1';

/**
 * The modes a page can declare in <body data-mode>. scripts/routes.py reads this
 * list and refuses to generate a route whose mode is not in it, because a mode
 * this file does not know falls back to the editable shelf.
 */
export const MODES = Object.freeze(['shelf', 'demo', 'profile']);

/** Modes that show somebody else's shelf: nothing on them is edited or saved. */
export const READ_ONLY_MODES = Object.freeze(['demo', 'profile']);

export const state = {
  view: 'shelf',
  groupBy: 'shelf',
  sortBy: 'number',
  query: '',
  trueScale: true,
  hideOwned: false,
  browseCollection: '',
  shortcuts: true,    // WCAG 2.1.4: a single-key shortcut needs an off switch
  // The whole collection is the default view. A shelf of 39 answers "what do I
  // have"; the run of 564 answers "what am I missing", which is the question a
  // collector actually opens this with. It also means first paint is 564 spines
  // rather than 39, which is why the rows below are render-gated.
  showRuns: true,

  entries: [],        // the shelf
  catalog: [],        // browsable records from the collections we crawled
  collections: [],    // catalog collection headers
  seed: [],           // library.json, the demo shelf: /demo/ shows it, /shelf/ can copy it
  mode: 'shelf',      // one of MODES, written into the page by scripts/routes.py
  readOnly: false,    // true on /demo/ and /u/: no edit reaches state, and nothing is saved
  source: 'local',    // local, account-loading, account, account-error, demo or profile
  generation: 0,      // moves with every change of shelf, so a late answer about an older one is dropped
  ownedIds: new Set(),
  selected: null,     // entry key currently open in the drawer
  loaded: false,
};

/**
 * A stable key: tf<id> for a catalogue book, else the entry's own, else a new
 * own-<uuid>. Random rather than a clock and a counter, so two devices adding
 * books to one account shelf can never mint the same key.
 */
export function entryKey(entry) {
  if (entry.id != null) return 'tf' + entry.id;
  if (entry.key) return entry.key;
  return 'own-' + mintUuid();
}

export function reindex() {
  state.ownedIds = new Set(state.entries.filter((e) => e.id != null).map((e) => e.id));
}

// ── The browser shelf in storage ─────────────────────────────────────────────

let warnedAboutStorage = false;

/**
 * The only function that writes vitrina_shelf_v1; null removes it. Each of its
 * three callers decides first whether it may.
 */
function writeBrowserShelf(entries) {
  try {
    if (entries === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({ v: 1, entries }));
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

/**
 * True when the browser shelf reached storage. Private: Import used to call it
 * directly, past every check the mutations make.
 */
function save() {
  if (state.readOnly || state.source !== 'local') return false;
  return writeBrowserShelf(state.entries);
}

export function savePrefs() {
  try {
    // On a read-only page, how a visitor arranges somebody else's shelf stays in
    // memory. It used to be saved to the key /shelf/ reads, so browsing the
    // demo in Browse sent a first-time visitor to their own shelf in Browse too,
    // straight past the empty state that shows them how to start. The shortcuts
    // switch is the exception: it is an accessibility choice about the person,
    // not about the shelf, so it follows them.
    if (state.readOnly) {
      const raw = localStorage.getItem(PREFS);
      const kept = raw ? JSON.parse(raw) : {};
      kept.shortcuts = state.shortcuts;
      localStorage.setItem(PREFS, JSON.stringify(kept));
      return;
    }
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
 * Which shelf a page opens on is decided by the page, not by anything a visitor
 * can toggle.
 *
 * On /demo/ the entries are library.json exactly as the maintainer keeps it. On
 * /u/ (profile) they are the shared shelf profile.js passes in. Neither page
 * reads or writes the visitor's saved shelf.
 *
 * On /shelf/ the entries are the visitor's saved shelf, and a first visit starts
 * EMPTY. It used to start as a copy of the maintainer's books, so every new
 * visitor was handed somebody else's collection as their own, and the first edit
 * saved it that way. The demo is still one click away as a starting point, via
 * restoreSeed(), and `seed` is kept for exactly that. A signed-in visitor's
 * account shelf takes its place later, through useAccountShelf().
 */
export function hydrate(library, mode = 'shelf', entries = []) {
  loadPrefs();
  state.mode = MODES.includes(mode) ? mode : 'shelf';
  state.readOnly = READ_ONLY_MODES.includes(state.mode);
  state.generation += 1;
  state.seed = library.map(toEntry);
  if (state.mode === 'demo') {
    state.source = 'demo';
    state.entries = state.seed.map((e) => ({ ...e }));
  } else if (state.mode === 'profile') {
    state.source = 'profile';
    state.entries = (Array.isArray(entries) ? entries : []).map(normalise);
    // A shared shelf opens on its books, not on the whole run of every
    // collection they come from. For this visit only: loadPrefs() has already
    // run, nothing here saves, and on a read-only page savePrefs() keeps nothing
    // but the shortcuts switch, so the visitor's own shelf still opens the way
    // they left it.
    state.view = 'shelf';
    state.showRuns = false;
  } else {
    state.source = 'local';
    const saved = loadSaved();
    state.entries = saved ? saved.map(normalise) : [];
  }
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
    // The owner's own name for the edition, which /demo/ shows as "Listed by its
    // owner as". detail.js reads it from the entry and never from the record: a
    // record can come from a catalogue file, and only the entry belongs to a shelf.
    listed_as: rec.listed_as || null,
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
    listed_as: e.listed_as || null,
    added: e.added || null,
    record: e.record || {},
  };
}

// ── Who may edit, and where an edit goes ─────────────────────────────────────

/**
 * The demo and a shared shelf are not the visitor's. Every mutation checks this
 * and returns before touching state, and save() refuses as a backstop, so no
 * path can write somebody else's shelf into the visitor's saved one. The page
 * hides the controls too; the event is for anything that slips past that.
 */
function refuseEdit(result) {
  document.dispatchEvent(new CustomEvent('vitrina:read-only'));
  return result;
}

/**
 * The account shelf is loading, failed to load, or has nowhere to send edits.
 * An edit now would vanish, and the browser shelf is never a stand-in for it.
 */
function refuseNotReady(result) {
  document.dispatchEvent(new CustomEvent('vitrina:shelf-not-ready', { detail: { source: state.source } }));
  return result;
}

// Every edit to the browser shelf saves the whole shelf, as it always did.
const localPersistence = Object.freeze({
  add: () => save(),
  remove: () => save(),
  update: () => save(),
  addMany: () => save(),
});

const ADAPTER_METHODS = ['add', 'remove', 'update', 'addMany'];
let accountPersistence = null;

/**
 * Where edits to the account shelf go, set by account.js:
 *
 *   add(entry)                  a book just put on the shelf
 *   remove(key, entry)          a book just taken off
 *   update(key, patch, entry)   a note or shelf label just changed
 *   addMany(entries, { kind })  books just gained, kind 'seed' or 'import'
 *
 * Memory changes first and the adapter is told after, so the page never waits
 * on the network. The adapter is consulted only while the source is account:
 * the browser shelf always saves through the local adapter, so an adapter left
 * installed after a sign-out can never receive an edit made to the browser
 * shelf. An object missing any of the four methods counts as no adapter.
 */
export function setPersistence(adapter) {
  const complete = adapter && ADAPTER_METHODS.every((name) => typeof adapter[name] === 'function');
  accountPersistence = complete ? adapter : null;
}

/** The adapter an edit may go through right now, or null when none may. */
function persistence() {
  if (state.source === 'local') return localPersistence;
  if (state.source === 'account') return accountPersistence;
  return null;
}

export function addEntry(record, { shelf = null, note = null } = {}) {
  if (state.readOnly) return refuseEdit(null);
  const persist = persistence();
  if (!persist) return refuseNotReady(null);
  if (record.id != null && state.ownedIds.has(record.id)) return null;
  const entry = {
    key: record.id != null ? 'tf' + record.id : entryKey({}),
    id: record.id != null ? record.id : null,
    slug: record.slug || null,
    shelf: shelf || record.shelf || record.collection || 'Added by hand',
    note,
    listed_as: null,
    added: new Date().toISOString().slice(0, 10),
    record,
  };
  state.entries.push(entry);
  reindex();
  persist.add(entry);
  return entry;
}

export function removeEntry(key) {
  if (state.readOnly) return refuseEdit(false);
  const persist = persistence();
  if (!persist) return refuseNotReady(false);
  const gone = state.entries.find((e) => e.key === key);
  if (!gone) return false;
  state.entries = state.entries.filter((e) => e.key !== key);
  reindex();
  persist.remove(key, gone);
  return true;
}

export function updateEntry(key, patch) {
  if (state.readOnly) return refuseEdit(null);
  const persist = persistence();
  if (!persist) return refuseNotReady(null);
  const entry = state.entries.find((e) => e.key === key);
  if (!entry) return null;
  Object.assign(entry, patch);
  persist.update(key, patch, entry);
  return entry;
}

export function findEntry(key) {
  return state.entries.find((e) => e.key === key) || null;
}

/**
 * "Start from the demo shelf". Returns whether it was saved, so a caller only
 * reports success when it was.
 *
 * The browser shelf becomes a copy of the demo, as it always did. An account
 * shelf only gains the demo's books it lacks, with the demo's shelf labels and
 * nothing else of the maintainer's: no notes, no listed_as, no dates.
 */
export function restoreSeed() {
  if (state.readOnly) { refuseEdit(); return false; }
  const persist = persistence();
  if (!persist) { refuseNotReady(); return false; }
  if (state.source === 'local') {
    state.entries = state.seed.map((e) => ({ ...e }));
    reindex();
    return persist.addMany(state.entries, { kind: 'seed' }) !== false;
  }
  const have = new Set(state.entries.map((e) => e.key));
  const gained = state.seed
    .filter((e) => e.id != null && !have.has(e.key))
    .map((e) => ({
      key: e.key, id: e.id, slug: e.slug, shelf: e.shelf,
      note: null, listed_as: null, added: null, record: bibliographic(e.record),
    }));
  state.entries.push(...gained);
  reindex();
  return persist.addMany(gained, { kind: 'seed' }) !== false;
}

/**
 * Books from an exported file, already keyed by modals.js through
 * syncplan.importKeys. Copies sharing a key collapse to one first.
 *
 * The browser shelf is replaced by the file, as it always was. An account shelf
 * only gains the books it does not have: nothing on it is removed or
 * overwritten, because there is no undo for an account.
 */
export function importEntries(list) {
  if (state.readOnly) return refuseEdit(null);
  const persist = persistence();
  if (!persist) return refuseNotReady(null);
  const incoming = (Array.isArray(list) ? list : []).filter((e) => e && typeof e === 'object');
  const unique = collapseByKey(incoming.map(normalise));
  if (state.source === 'local') {
    state.entries = unique;
    reindex();
    persist.addMany(unique, { kind: 'import' });
    return { added: unique.length, skipped: incoming.length - unique.length };
  }
  const have = new Set(state.entries.map((e) => e.key));
  const fresh = unique.filter((e) => !have.has(e.key));
  state.entries.push(...fresh);
  reindex();
  persist.addMany(fresh, { kind: 'import' });
  return { added: fresh.length, skipped: incoming.length - fresh.length };
}

// ── Which shelf is shown ─────────────────────────────────────────────────────

/**
 * Show a signed-in person's account shelf: browser entries built from shelf:mine
 * rows by syncplan.fromServerEntry. Storage is not touched, so the browser shelf
 * is still there the next time this browser is signed out.
 */
export function useAccountShelf(entries) {
  if (state.readOnly) return false;
  state.source = 'account';
  state.generation += 1;
  state.entries = (Array.isArray(entries) ? entries : []).map(normalise);
  reindex();
  return true;
}

/** Back to the shelf kept in this browser, read fresh from storage: after a sign-out, or before a different person's shelf loads. */
export function useLocalShelf() {
  if (state.readOnly) return false;
  state.source = 'local';
  state.generation += 1;
  const saved = loadSaved();
  state.entries = saved ? saved.map(normalise) : [];
  reindex();
  return true;
}

/** An account shelf is on its way. Memory holds no shelf until it arrives, and every edit is refused. */
export function useAccountLoading() {
  return awaitAccount('account-loading');
}

/** The account shelf could not be read. The page says so; it never shows the browser shelf in its place. */
export function useAccountError() {
  return awaitAccount('account-error');
}

function awaitAccount(source) {
  if (state.readOnly) return false;
  state.source = source;
  state.generation += 1;
  state.entries = [];
  reindex();
  return true;
}

// ── Maintenance of the stored browser shelf ──────────────────────────────────

/**
 * Rewrite the browser shelf in storage without going through memory, which is
 * how its keys are normalised once before a move to an account. transform gets
 * a copy of what storage holds, never state.entries, so while an account shelf
 * is in memory nothing of it can reach this key. Writes only when the result
 * differs. While the browser shelf is the one shown, memory follows storage.
 */
export function rewriteBrowserShelf(transform) {
  if (state.readOnly || typeof transform !== 'function') return false;
  const before = (loadSaved() || []).filter((e) => e && typeof e === 'object');
  const result = transform(before.map((e) => ({ ...e })));
  if (!Array.isArray(result)) return false;
  const next = result.filter((e) => e && typeof e === 'object').map(normalise);
  if (JSON.stringify(next) !== JSON.stringify(before) && !writeBrowserShelf(next)) return false;
  if (state.source === 'local') {
    state.entries = next.map((e) => ({ ...e }));
    reindex();
  }
  return true;
}

/** Forget the browser shelf: after its books reached an account and the person chose to clear this browser's copy. */
export function clearBrowserShelf() {
  if (state.readOnly) return false;
  if (!writeBrowserShelf(null)) return false;
  if (state.source === 'local') {
    state.entries = [];
    reindex();
  }
  return true;
}

/** How many books storage holds for /shelf/, whatever this tab last read. Nothing on a read-only page. */
export function storedShelfSize() {
  if (state.readOnly) return 0;
  const saved = loadSaved();
  return saved ? saved.length : 0;
}

/**
 * Copy that names whose books these are. On /shelf/ they are the visitor's; on
 * /demo/ and /u/ they belong to somebody else, and "the lit ones are yours" told
 * every visitor they owned the maintainer's collection. Any new string that says
 * "your" about the books goes through here.
 */
export function whose(yours, demo) {
  return state.readOnly ? demo : yours;
}
