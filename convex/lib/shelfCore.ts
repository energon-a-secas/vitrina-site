import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { CALL_MAX, MAX_ENTRIES } from "./limits.ts";
import { checkEntry, checkNote, checkShelf } from "./entries.ts";
import type { Entry } from "./entries.ts";
import { enforce } from "./rate.ts";
import { done, fail } from "./result.ts";
import type { Failure, Success } from "./result.ts";
import { erasingFailure, isErasing, isSuspendedSubject, profileBySubject, publishingOpen } from "./profilesCore.ts";
import type { PublishingEnv } from "./profilesCore.ts";

// The account shelf: one entries row per book, plus a shelfMeta row whose count
// every insert and delete here patches in the same transaction, so the 2000
// book cap is one indexed read instead of a count over the whole shelf.

type Reader = GenericDatabaseReader<any>;
type Db = GenericDatabaseWriter<any>;

const FILLABLE = ["shelf", "note", "listedAs", "added"] as const;

export async function readMeta(db: Reader, subject: string): Promise<any> {
  return await db.query("shelfMeta").withIndex("by_subject", (q: any) => q.eq("clerkSubject", subject)).first();
}

async function findEntry(db: Reader, subject: string, key: string): Promise<any> {
  return await db
    .query("entries")
    .withIndex("by_owner_key", (q: any) => q.eq("clerkSubject", subject).eq("key", key))
    .first();
}

// What the owner's own browser gets back. Field by field for the same reason
// as projectShelf: clerkSubject, _id and updatedAt are the database's, not the
// shelf's.
function privateEntry(row: any) {
  return {
    key: row.key,
    id: row.catalogId,
    shelf: row.shelf,
    note: row.note,
    listedAs: row.listedAs,
    added: row.added,
    record: row.record,
  };
}

// ── mine ─────────────────────────────────────────────────────────────────────

/**
 * The signed-in shelf. null only when there is no subject: the client reads a
 * null while the kit says signed in as a failed request, never as a sign-out.
 */
export async function mineCore(db: Reader, subject: string | null, env: PublishingEnv): Promise<any> {
  if (!subject) return null;
  const meta = await readMeta(db, subject);
  // While erasing, the count is what the Delete dialog polls: purge:run
  // lowers it batch by batch.
  if (await isErasing(db, subject)) return { erasing: true, remaining: meta ? meta.count : 0 };

  const profile = await profileBySubject(db, subject);
  const suspended = profile ? profile.suspendedAt !== null || (await isSuspendedSubject(db, subject)) : false;
  // One past the cap, so a shelf that somehow holds more than MAX_ENTRIES says
  // so instead of silently losing its tail.
  const rows = await db.query("entries").withIndex("by_owner", (q: any) => q.eq("clerkSubject", subject)).take(MAX_ENTRIES + 1);

  return {
    erasing: false,
    profile: profile ? { handle: profile.handle, published: profile.published, suspended } : null,
    entries: rows.slice(0, MAX_ENTRIES).map(privateEntry),
    count: meta ? meta.count : Math.min(rows.length, MAX_ENTRIES),
    max: MAX_ENTRIES,
    truncated: rows.length > MAX_ENTRIES,
    publishingOpen: publishingOpen(env),
  };
}

// ── upsertEntries ────────────────────────────────────────────────────────────

/**
 * Add books, never replace them. The client uploads a browser shelf or an
 * import in chunks of CALL_MAX, and a chunk can be retried after it already
 * committed (a lost response), so an existing key is skipped rather than
 * counted again, and the cap counts only keys that are new.
 *
 * With fillEmpty, an existing row gains the owner fields it lacks and keeps
 * every field it has: the account copy wins wherever both have a value.
 *
 * added + skipped + filled is the length of the call, in-call duplicates
 * counted as skipped, so a client summing chunks accounts for every book it
 * sent. total is the shelf's count after the call.
 */
export async function upsertEntriesCore(
  db: Db,
  subject: string,
  args: { entries: unknown; fillEmpty?: unknown },
  now: number,
): Promise<Success | Failure> {
  if (await isErasing(db, subject)) return erasingFailure();
  const limited = await enforce(db, subject, "shelf.write", now, "changes this hour");
  if (limited) return limited;

  if (!Array.isArray(args.entries)) {
    return fail("invalid-entry", "The books to save must arrive as a list.", { index: null, reason: "entries must be a list" });
  }
  const list = args.entries;
  if (list.length > CALL_MAX) {
    return fail("too-many-in-call", `At most ${CALL_MAX} books can be saved at once.`, { max: CALL_MAX });
  }

  // The whole call is refused on the first invalid entry, before any write, so
  // a chunk is all or nothing and the client never has to work out which half
  // of it landed.
  const checked: Entry[] = [];
  for (let index = 0; index < list.length; index++) {
    const result = checkEntry(list[index]);
    if (!result.ok) {
      return fail("invalid-entry", `Book ${index + 1} could not be saved: ${result.reason}.`, { index, reason: result.reason });
    }
    checked.push(result.value);
  }

  let skipped = 0;
  const seen = new Set<string>();
  const unique: Entry[] = [];
  for (const entry of checked) {
    if (seen.has(entry.key)) {
      skipped++;
      continue;
    }
    seen.add(entry.key);
    unique.push(entry);
  }

  const existing: { row: any; entry: Entry }[] = [];
  const fresh: Entry[] = [];
  for (const entry of unique) {
    const row = await findEntry(db, subject, entry.key);
    if (row) existing.push({ row, entry });
    else fresh.push(entry);
  }

  const meta = await readMeta(db, subject);
  const count = meta ? meta.count : 0;
  if (count + fresh.length > MAX_ENTRIES) {
    return fail("shelf-full", `Your account shelf holds ${MAX_ENTRIES} books, the most it can.`, { max: MAX_ENTRIES, count });
  }

  let filled = 0;
  for (const { row, entry } of existing) {
    if (args.fillEmpty !== true) {
      skipped++;
      continue;
    }
    const patch: Record<string, unknown> = {};
    for (const field of FILLABLE) {
      if (row[field] === null && entry[field] !== null) patch[field] = entry[field];
    }
    if (Object.keys(patch).length === 0) {
      skipped++;
      continue;
    }
    patch.updatedAt = now;
    await db.patch("entries", row._id, patch);
    filled++;
  }

  for (const entry of fresh) {
    await db.insert("entries", {
      clerkSubject: subject,
      key: entry.key,
      catalogId: entry.catalogId,
      shelf: entry.shelf,
      note: entry.note,
      listedAs: entry.listedAs,
      added: entry.added,
      record: entry.record,
      updatedAt: now,
    });
  }

  const total = count + fresh.length;
  if (fresh.length > 0) {
    if (meta) await db.patch("shelfMeta", meta._id, { count: total });
    else await db.insert("shelfMeta", { clerkSubject: subject, count: total });
  }
  return done({ added: fresh.length, skipped, filled, total });
}

// ── updateEntry ──────────────────────────────────────────────────────────────

/** undefined leaves a field alone, null clears it, text replaces it. */
export async function updateEntryCore(
  db: Db,
  subject: string,
  args: { key: unknown; shelf?: unknown; note?: unknown },
  now: number,
): Promise<Success | Failure> {
  if (await isErasing(db, subject)) return erasingFailure();
  const limited = await enforce(db, subject, "shelf.write", now, "changes this hour");
  if (limited) return limited;

  const patch: Record<string, unknown> = {};
  if (args.shelf !== undefined) {
    const shelf = checkShelf(args.shelf);
    if (!shelf.ok) return fail("invalid-entry", `The shelf label could not be saved: ${shelf.reason}.`, { reason: shelf.reason });
    patch.shelf = shelf.value;
  }
  if (args.note !== undefined) {
    const note = checkNote(args.note);
    if (!note.ok) return fail("invalid-entry", `The note could not be saved: ${note.reason}.`, { reason: note.reason });
    patch.note = note.value;
  }

  const row = typeof args.key === "string" ? await findEntry(db, subject, args.key) : null;
  if (!row) return fail("not-found", "That book is not on your account shelf.");
  if (Object.keys(patch).length > 0) {
    patch.updatedAt = now;
    await db.patch("entries", row._id, patch);
  }
  return done();
}

// ── removeEntry ──────────────────────────────────────────────────────────────

/** Removing a book that is already gone is a success with removed: false, so a retry is harmless. */
export async function removeEntryCore(db: Db, subject: string, args: { key: unknown }, now: number): Promise<Success | Failure> {
  if (await isErasing(db, subject)) return erasingFailure();
  const limited = await enforce(db, subject, "shelf.write", now, "changes this hour");
  if (limited) return limited;

  const row = typeof args.key === "string" ? await findEntry(db, subject, args.key) : null;
  if (!row) return done({ removed: false });
  await db.delete("entries", row._id);
  const meta = await readMeta(db, subject);
  if (meta) await db.patch("shelfMeta", meta._id, { count: Math.max(0, meta.count - 1) });
  return done({ removed: true });
}
