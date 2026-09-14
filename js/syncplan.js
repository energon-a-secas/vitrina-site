// ── Between this browser's shelf and an account shelf ────────────────────────
//
// Pure: no DOM, no storage, no network and no imports, so node tests load it
// exactly as the page does. state.js keeps the shelf in memory and account.js
// talks to Convex; this is the arithmetic in between, which is where a book
// quietly goes missing or a note lands somewhere it should not, so it is the
// part that has to be testable without a browser.
//
// The entry rules mirror convex/lib/entries.ts, which is canonical. The server
// refuses what breaks them; this side clamps instead, because the server refuses
// a whole call on its first invalid entry, and one over-long note in a browser
// shelf would otherwise keep the other 199 books of its chunk out of the
// account. tests/entries-mirror.test.mjs imports both files and fails when the
// caps, the key grammar or the record keys drift apart, and checks that the
// server accepts everything toServerEntry produces.

export const OWN_KEY_RE = /^own[a-z0-9-]{1,60}$/;
export const ADDED_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const ENTRY_KEYS = Object.freeze(['key', 'catalogId', 'shelf', 'note', 'listedAs', 'added', 'record']);
export const RECORD_KEYS = Object.freeze([
  'title', 'authors', 'year', 'pages', 'publisher', 'collection', 'dimensions', 'cover_custom', 'spine_custom',
]);

export const CAPS = Object.freeze({
  shelf: 80,
  note: 1000,
  listedAs: 200,
  title: 200,
  authors: 10,
  author: 200,
  year: 20,
  publisher: 120,
  collection: 120,
  dimensions: 20,
  url: 500,
});

/** The most books one account shelf holds (convex/lib/limits.ts). */
export const MAX_ENTRIES = 2000;
/** The most entries one shelf:upsertEntries call takes, so uploads go in chunks of this. */
export const CALL_MAX = 200;

/**
 * What a catalogue book's record may carry when it is rebuilt in the browser
 * from library.json or catalog.json (plan section 3.2). library.json is the
 * maintainer's own shelf, so its records also hold listed_as, note, note_mine
 * and shelf. Those belong to the maintainer, and on an account shelf the only
 * owner fields are the ones on the person's own row.
 */
export const BIBLIOGRAPHIC_KEYS = Object.freeze([
  'authors', 'collection', 'collection_id', 'collection_number', 'cover_art', 'dimensions', 'format', 'genres',
  'id', 'isbn', 'pages', 'publisher', 'subcollection', 'subcollection_id', 'subcollection_number', 'title',
  'translators', 'year', 'has_spine', 'series', 'series_ids', 'work_id', 'contents', 'awards', 'author_ids',
  'publisher_country', 'slug', 'cover', 'spine', 'url',
]);

/** The title of an account row whose catalogue id is in neither data file. */
export const MISSING_TITLE = 'A book no longer in the catalogue';

// The fields two copies of one book can disagree on. When copies collapse, the
// first copy wins and a later copy only fills what the first left empty.
const MERGED = ['shelf', 'note', 'listed_as', 'added'];

// ── Small readers ────────────────────────────────────────────────────────────

/** A positive safe integer, the only thing a catalogue id can be, or null. */
export function catalogueId(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The catalogue id a tf key names, or null for a book added by hand. */
export function idFromKey(key) {
  const match = /^tf([1-9]\d*)$/.exec(String(key));
  return match ? catalogueId(Number(match[1])) : null;
}

/** Records by id, for the lookups below. Anything without a valid id is left out. */
export function indexById(records) {
  const index = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const id = record ? catalogueId(record.id) : null;
    if (id !== null && !index.has(id)) index.set(id, record);
  }
  return index;
}

function lookup(index, id) {
  return index && typeof index.get === 'function' ? index.get(id) || null : null;
}

function known(index) {
  return Boolean(index && typeof index.size === 'number' && index.size > 0);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Text trimmed and cut to its cap, empty becoming null, as the server reads it.
 * The cut never lands between the two halves of a surrogate pair, which would
 * leave a character no font can draw at the end of a note.
 */
function clip(value, cap) {
  let text = null;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  if (text === null) return null;
  text = text.trim();
  if (text.length > cap) {
    text = text.slice(0, cap);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    text = text.trim();
  }
  return text || null;
}

// Only https: images. A URL cut to its cap is a different URL, so a long one
// is dropped rather than shortened.
function httpsUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > CAPS.url) return null;
  try {
    return new URL(text).protocol === 'https:' ? text : null;
  } catch (err) {
    return null;
  }
}

function copyValue(value) {
  return value !== null && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}

// ── Records ──────────────────────────────────────────────────────────────────

/**
 * A hand-added book's record, rebuilt from exactly RECORD_KEYS in the order the
 * server rebuilds it. There is no id: a record id is what shelf.js writes into
 * data-book-id, and a book added by hand has no catalogue id to write. A record
 * with no usable title is "Untitled", which is what the shelf already calls it.
 */
export function whitelistRecord(raw) {
  const r = isObject(raw) ? raw : {};
  const names = Array.isArray(r.authors) ? r.authors : (typeof r.authors === 'string' ? [r.authors] : []);
  const authors = [];
  for (const name of names) {
    if (authors.length === CAPS.authors) break;
    const text = typeof name === 'string' ? clip(name, CAPS.author) : null;
    if (text) authors.push(text);
  }
  return {
    title: clip(r.title, CAPS.title) || 'Untitled',
    authors,
    year: clip(r.year, CAPS.year),
    pages: typeof r.pages === 'number' && Number.isSafeInteger(r.pages) && r.pages >= 0 ? r.pages : null,
    publisher: clip(r.publisher, CAPS.publisher),
    collection: clip(r.collection, CAPS.collection),
    dimensions: clip(r.dimensions, CAPS.dimensions),
    cover_custom: httpsUrl(r.cover_custom),
    spine_custom: httpsUrl(r.spine_custom),
  };
}

/** A catalogue record reduced to its bibliographic keys, copied so the data files are never shared by reference. */
export function bibliographic(source) {
  const record = {};
  if (!isObject(source)) return record;
  for (const name of BIBLIOGRAPHIC_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, name)) record[name] = copyValue(source[name]);
  }
  return record;
}

// ── Entries ──────────────────────────────────────────────────────────────────

/**
 * A browser entry as shelf:upsertEntries takes it, clamped to the entry rules,
 * or null when its key is in neither grammar. Keys are fixed by
 * normaliseBrowserShelf or importKeys first; this never invents one.
 */
export function toServerEntry(entry) {
  if (!isObject(entry)) return null;
  const key = typeof entry.key === 'string' ? entry.key : '';
  const id = catalogueId(entry.id);
  const shelf = clip(entry.shelf, CAPS.shelf);
  const note = clip(entry.note, CAPS.note);
  const listedAs = clip(entry.listed_as, CAPS.listedAs);
  const added = typeof entry.added === 'string' && ADDED_RE.test(entry.added) ? entry.added : null;
  if (id !== null) {
    // A catalogue book's record is read from the catalogue by whoever shows it,
    // so none is sent.
    if (key !== 'tf' + id) return null;
    return { key, catalogId: id, shelf, note, listedAs, added, record: null };
  }
  if (!OWN_KEY_RE.test(key)) return null;
  return { key, catalogId: null, shelf, note, listedAs, added, record: whitelistRecord(entry.record) };
}

/**
 * The key one stored or imported book should have, with the id that goes with it.
 *
 * A book with a catalogue id keeps tf<id> when that is already its key, or when
 * the id resolves in library.json or catalog.json. A book already keyed own...
 * keeps its key. Anything else is a book added by hand under a new own-<uuid>.
 *
 * An id can only be judged against a catalogue that loaded. With neither file
 * loaded every positive id stays a catalogue book: the normalised shelf is
 * written back, and demoting a real edition to a hand-added book would lose its
 * spine and cover for good.
 */
function keyFor(raw, libraryById, catalogById, mintUuid) {
  const key = typeof raw.key === 'string' ? raw.key : '';
  const id = catalogueId(raw.id);
  if (id !== null) {
    const resolves = lookup(libraryById, id) || lookup(catalogById, id);
    const judged = known(libraryById) || known(catalogById);
    if (key === 'tf' + id || resolves || !judged) return { key: 'tf' + id, id };
  }
  if (OWN_KEY_RE.test(key)) return { key, id: null };
  return { key: 'own-' + mintUuid(), id: null };
}

/** Copies of one book, by key, collapsed to one: the first copy wins, and later copies only fill its empty fields. */
export function collapseByKey(entries) {
  const byKey = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isObject(entry) || typeof entry.key !== 'string') continue;
    const held = byKey.get(entry.key);
    if (!held) {
      byKey.set(entry.key, { ...entry });
      continue;
    }
    for (const field of MERGED) {
      if (held[field] == null && entry[field] != null) held[field] = entry[field];
    }
  }
  return Array.from(byKey.values());
}

/**
 * The browser shelf, as storage holds it, with every key in one of the two
 * grammars (plan section 3.1). Run once when an account shelf arrives, and
 * written back through state.rewriteBrowserShelf, so a minted own-<uuid> is
 * minted once and the same book is the same key on every later count.
 *
 * Nothing but keys, ids and record.id changes: notes and labels stay as long as
 * the person wrote them in this browser, and clamping to the account's caps
 * happens in toServerEntry on the way out.
 */
export function normaliseBrowserShelf(stored, libraryById, catalogById, mintUuid) {
  const rekeyed = [];
  for (const raw of Array.isArray(stored) ? stored : []) {
    if (!isObject(raw)) continue;
    const { key, id } = keyFor(raw, libraryById, catalogById, mintUuid);
    const record = isObject(raw.record) ? raw.record : {};
    rekeyed.push({
      key,
      id,
      slug: textOrNull(raw.slug),
      shelf: textOrNull(raw.shelf),
      note: textOrNull(raw.note),
      listed_as: textOrNull(raw.listed_as),
      added: textOrNull(raw.added),
      // record.id follows the entry: it names the images and data-book-id, and
      // a book added by hand has none (a hostile one stops here).
      record: { ...record, id },
    });
  }
  return collapseByKey(rekeyed);
}

/**
 * Keys for the books in an imported file, in the file's order. Import used to
 * name its books imp<index>, a key in neither grammar that named a different
 * book every time the file changed.
 */
export function importKeys(list, libraryById, catalogById, mintUuid) {
  return (Array.isArray(list) ? list : []).map((raw) => (
    isObject(raw) ? keyFor(raw, libraryById, catalogById, mintUuid).key : 'own-' + mintUuid()
  ));
}

/**
 * Browser entries for the books of an imported file, each under the key
 * importKeys gave it. record.id follows the key and never the file, so a file
 * cannot put an id of its own choosing into data-book-id or an image URL: a
 * book added by hand gets none, a catalogue book the id its key names. A raw
 * catalogue record in the file, with no record of its own, is its own record.
 */
export function importedEntries(list, keys) {
  return (Array.isArray(list) ? list : []).map((raw, i) => {
    const e = isObject(raw) ? raw : {};
    const key = Array.isArray(keys) && typeof keys[i] === 'string' ? keys[i] : null;
    const id = idFromKey(key);
    return {
      key,
      id,
      slug: e.slug || null,
      shelf: e.shelf || null,
      note: e.note || null,
      listed_as: e.listed_as || null,
      added: e.added || null,
      record: { ...(isObject(e.record) ? e.record : e), id },
    };
  });
}

/**
 * Keys of the browser shelf that the account does not have and that were never
 * moved from this browser. A book moved and then taken off the account shelf
 * is not offered again: that removal was the person's answer.
 */
export function keysMissingFromAccount(entries, accountKeys, movedKeys) {
  const inAccount = new Set(accountKeys || []);
  const moved = new Set(movedKeys || []);
  const seen = new Set();
  const missing = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = isObject(entry) ? entry.key : null;
    if (typeof key !== 'string' || seen.has(key)) continue;
    seen.add(key);
    if (!inAccount.has(key) && !moved.has(key)) missing.push(key);
  }
  return missing;
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Browser books the account has too, where the account row lacks a note or a
 * shelf label this browser has. Uploaded with fillEmpty, which only ever fills
 * an empty field: the account copy wins wherever both have a value.
 */
export function fillCandidates(local, accountRowsByKey) {
  const rows = accountRowsByKey instanceof Map ? accountRowsByKey : new Map(Object.entries(accountRowsByKey || {}));
  const seen = new Set();
  const candidates = [];
  for (const entry of Array.isArray(local) ? local : []) {
    if (!isObject(entry) || typeof entry.key !== 'string' || seen.has(entry.key)) continue;
    seen.add(entry.key);
    const row = rows.get(entry.key);
    if (!isObject(row)) continue;
    if ((row.note == null && hasText(entry.note)) || (row.shelf == null && hasText(entry.shelf))) candidates.push(entry);
  }
  return candidates;
}

/**
 * A browser entry from a shelf:mine row, or null for a row in neither grammar.
 *
 * A catalogue book's record comes from library.json, then catalog.json, through
 * BIBLIOGRAPHIC_KEYS only. Its shelf, note, listed_as and date come from the row
 * and from nowhere else, so the maintainer's labels in library.json never
 * appear on anybody's account shelf. An id in neither file is drawn, not
 * fetched: has_spine false keeps the shelf from asking the catalogue for a
 * spine it may not have.
 */
export function fromServerEntry(row, libraryById, catalogById) {
  if (!isObject(row)) return null;
  const key = typeof row.key === 'string' ? row.key : '';
  const owner = {
    shelf: textOrNull(row.shelf),
    note: textOrNull(row.note),
    listed_as: textOrNull(row.listedAs),
    added: typeof row.added === 'string' && ADDED_RE.test(row.added) ? row.added : null,
  };
  const id = catalogueId(row.id);
  if (id !== null) {
    if (key !== 'tf' + id) return null;
    const source = lookup(libraryById, id) || lookup(catalogById, id);
    const record = source ? bibliographic(source) : { title: MISSING_TITLE, has_spine: false };
    record.id = id;
    return { key, id, slug: textOrNull(record.slug), ...owner, record };
  }
  if (!OWN_KEY_RE.test(key)) return null;
  return { key, id: null, slug: null, ...owner, record: { ...whitelistRecord(row.record), id: null } };
}

/**
 * "Start from the demo shelf" on an account: the demo's catalogue books with
 * the demo's shelf labels, and nothing else of the maintainer's. No notes, no
 * listed_as, no dates, and no book added by hand.
 */
export function demoSeedForAccount(seed) {
  const seen = new Set();
  const entries = [];
  for (const item of Array.isArray(seed) ? seed : []) {
    const id = isObject(item) ? catalogueId(item.id) : null;
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    entries.push({ key: 'tf' + id, catalogId: id, shelf: clip(item.shelf, CAPS.shelf), note: null, listedAs: null, added: null, record: null });
  }
  return entries;
}

/**
 * Whether a shelf:mine answer may replace memory.
 *
 * started is what the fetch captured when it went out ({ generation, writeSeq });
 * current is the state now ({ generation, writeSeq, pending }). An answer for
 * an older source is never applied. An answer that raced a write is not
 * applied either, whether that write went out before the fetch and is still
 * pending, or went out after it: the fetch may predate the write, and applying
 * it would put back what the write just changed. Either way the caller fetches
 * again once pending reaches 0.
 */
export function shouldApplyFetch(started, current) {
  if (!isObject(started) || !isObject(current)) return false;
  if (started.generation !== current.generation) return false;
  if (current.pending > 0) return false;
  return started.writeSeq === current.writeSeq;
}
