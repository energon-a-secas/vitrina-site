// What one book on an account shelf may look like (plan section 3.2).
//
// The browser mirrors these rules as clamping in js/syncplan.js, so a well
// behaved client never sees invalid-entry. The server refuses instead of
// clamping because anything reaching it unclamped came from something other
// than that client, and quietly repairing it would hide that.
//
// Every accepted value is rebuilt field by field. Nothing is copied from the
// argument object, so a key the whitelist does not name cannot ride along into
// the database, and a record can never carry an id: record.id is what
// js/shelf.js writes into data-book-id, which is how a hostile id became an
// onerror handler.

export const OWN_KEY_RE = /^own[a-z0-9-]{1,60}$/;
export const ADDED_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const ENTRY_KEYS: readonly string[] = Object.freeze(["key", "catalogId", "shelf", "note", "listedAs", "added", "record"]);
export const RECORD_KEYS: readonly string[] = Object.freeze([
  "title", "authors", "year", "pages", "publisher", "collection", "dimensions", "cover_custom", "spine_custom",
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

export type BookRecord = {
  title: string;
  authors: string[];
  year: string | null;
  pages: number | null;
  publisher: string | null;
  collection: string | null;
  dimensions: string | null;
  cover_custom: string | null;
  spine_custom: string | null;
};

export type Entry = {
  key: string;
  catalogId: number | null;
  shelf: string | null;
  note: string | null;
  listedAs: string | null;
  added: string | null;
  record: BookRecord | null;
};

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

function bad(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

// Convex hands arguments over as plain objects; anything with another
// prototype did not come from JSON.
function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

// A field name echoed into a reason is clipped and quoted, so a hostile key
// cannot make the message itself long or ambiguous.
function named(key: string): string {
  return JSON.stringify(key.slice(0, 40));
}

/** Text or null, trimmed, empty becomes null, refused past its cap rather than cut. */
export function optionalText(value: unknown, cap: number, field: string): Checked<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return bad(`${field} must be text or null`);
  const text = value.trim();
  if (text.length > cap) return bad(`${field} is limited to ${cap} characters`);
  return { ok: true, value: text || null };
}

export function checkShelf(value: unknown): Checked<string | null> {
  return optionalText(value, CAPS.shelf, "shelf");
}

export function checkNote(value: unknown): Checked<string | null> {
  return optionalText(value, CAPS.note, "note");
}

// Only https: images, so a stored URL can never be javascript: or a plain
// http request that leaks the page over the network in the clear.
function optionalUrl(value: unknown, field: string): Checked<string | null> {
  const text = optionalText(value, CAPS.url, field);
  if (!text.ok || text.value === null) return text;
  let url: URL;
  try {
    url = new URL(text.value);
  } catch {
    return bad(`${field} must be an https: address`);
  }
  if (url.protocol !== "https:") return bad(`${field} must be an https: address`);
  return text;
}

/** A hand-added book's record, rebuilt from exactly the whitelisted keys. */
export function checkRecord(raw: unknown): Checked<BookRecord> {
  if (!isPlainObject(raw)) return bad("a book added by hand needs a record object");
  for (const key of Object.keys(raw)) {
    if (!RECORD_KEYS.includes(key)) return bad(`record field ${named(key)} is not allowed`);
  }

  if (typeof raw.title !== "string") return bad("record.title must be text");
  const title = raw.title.trim();
  if (!title) return bad("record.title is required");
  if (title.length > CAPS.title) return bad(`record.title is limited to ${CAPS.title} characters`);

  const authors: string[] = [];
  if (raw.authors !== undefined && raw.authors !== null) {
    if (!Array.isArray(raw.authors)) return bad("record.authors must be a list");
    if (raw.authors.length > CAPS.authors) return bad(`record.authors holds at most ${CAPS.authors} names`);
    for (const author of raw.authors) {
      if (typeof author !== "string") return bad("record.authors must hold text");
      const name = author.trim();
      if (name.length > CAPS.author) return bad(`an author name is limited to ${CAPS.author} characters`);
      if (name) authors.push(name);
    }
  }

  let pages: number | null = null;
  if (raw.pages !== undefined && raw.pages !== null) {
    if (typeof raw.pages !== "number" || !Number.isSafeInteger(raw.pages) || raw.pages < 0) {
      return bad("record.pages must be a whole number or null");
    }
    pages = raw.pages;
  }

  const year = optionalText(raw.year, CAPS.year, "record.year");
  if (!year.ok) return year;
  const publisher = optionalText(raw.publisher, CAPS.publisher, "record.publisher");
  if (!publisher.ok) return publisher;
  const collection = optionalText(raw.collection, CAPS.collection, "record.collection");
  if (!collection.ok) return collection;
  const dimensions = optionalText(raw.dimensions, CAPS.dimensions, "record.dimensions");
  if (!dimensions.ok) return dimensions;
  const cover = optionalUrl(raw.cover_custom, "record.cover_custom");
  if (!cover.ok) return cover;
  const spine = optionalUrl(raw.spine_custom, "record.spine_custom");
  if (!spine.ok) return spine;

  return {
    ok: true,
    value: {
      title,
      authors,
      year: year.value,
      pages,
      publisher: publisher.value,
      collection: collection.value,
      dimensions: dimensions.value,
      cover_custom: cover.value,
      spine_custom: spine.value,
    },
  };
}

/**
 * One entry as upsertEntries receives it. A catalogue book is its id and the
 * owner's own fields; a book added by hand is an own- key and a whitelisted
 * record. Absent optional fields read as null.
 */
export function checkEntry(raw: unknown): Checked<Entry> {
  if (!isPlainObject(raw)) return bad("an entry must be an object");
  for (const key of Object.keys(raw)) {
    if (!ENTRY_KEYS.includes(key)) return bad(`entry field ${named(key)} is not allowed`);
  }

  let catalogId: number | null = null;
  if (raw.catalogId !== undefined && raw.catalogId !== null) {
    if (typeof raw.catalogId !== "number" || !Number.isSafeInteger(raw.catalogId) || raw.catalogId <= 0) {
      return bad("catalogId must be a positive whole number or null");
    }
    catalogId = raw.catalogId;
  }

  if (typeof raw.key !== "string") return bad("key must be text");
  const key = raw.key;

  let record: BookRecord | null = null;
  if (catalogId !== null) {
    // The key is derived, never chosen, so one catalogue book is one row.
    if (key !== "tf" + catalogId) return bad(`a catalogue book's key is tf${catalogId}`);
    if (raw.record !== undefined && raw.record !== null) {
      return bad("a catalogue book carries no record; the browser reads it from the catalogue");
    }
  } else {
    if (!OWN_KEY_RE.test(key)) return bad("a book added by hand has a key of own and up to 60 of a to z, digits and hyphens");
    const checked = checkRecord(raw.record);
    if (!checked.ok) return checked;
    record = checked.value;
  }

  const shelf = checkShelf(raw.shelf);
  if (!shelf.ok) return shelf;
  const note = checkNote(raw.note);
  if (!note.ok) return note;
  const listedAs = optionalText(raw.listedAs, CAPS.listedAs, "listedAs");
  if (!listedAs.ok) return listedAs;

  let added: string | null = null;
  if (raw.added !== undefined && raw.added !== null) {
    if (typeof raw.added !== "string" || !ADDED_RE.test(raw.added)) return bad("added must be a YYYY-MM-DD date or null");
    added = raw.added;
  }

  return {
    ok: true,
    value: { key, catalogId, shelf: shelf.value, note: note.value, listedAs: listedAs.value, added, record },
  };
}
