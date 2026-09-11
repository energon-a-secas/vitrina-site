import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { HOLD_MS, MAX_ENTRIES } from "./limits.ts";
import { HANDLE_MESSAGES, handleProblem, normalizeHandle } from "./handles.ts";
import { checkRate, enforce, rateLimited, recordRate } from "./rate.ts";
import { done, fail } from "./result.ts";
import type { Failure, Success } from "./result.ts";

// Profiles, handles, publishing and erasure (plan sections 3.3 and 3.6).
//
// Every function takes the database, the Clerk subject the handler read from
// ctx.auth, plain arguments, the time and the environment values it needs. None
// of them calls Date.now() or reads process.env, so the node tests drive them
// with a fake database and a clock they control.

type Reader = GenericDatabaseReader<any>;
type Db = GenericDatabaseWriter<any>;

export type PublishingEnv = { PUBLISHING?: string | null };

const MESSAGES = {
  erasing: "Your Vitrina data is being deleted.",
  suspended: "A moderator has suspended publishing for this account.",
  // Taken and held say the same thing, so a stranger cannot tell a live
  // address from one somebody gave up in the last 30 days.
  taken: "That address is taken. Try another.",
  same: "That is already your address.",
  noHandle: "Choose an address for your shelf first.",
  closed: "Public shelves are not open yet.",
  age: "Publishing needs your statement that you are 16 or older.",
};

export function erasingFailure(): Failure {
  return fail("erasing", MESSAGES.erasing);
}

export function publishingOpen(env: PublishingEnv | null | undefined): boolean {
  return !!env && env.PUBLISHING === "open";
}

export async function profileBySubject(db: Reader, subject: string): Promise<any> {
  return await db.query("profiles").withIndex("by_subject", (q: any) => q.eq("clerkSubject", subject)).first();
}

export async function profileByHandle(db: Reader, handle: string): Promise<any> {
  return await db.query("profiles").withIndex("by_handle", (q: any) => q.eq("handle", handle)).first();
}

/** True from deleteMyData (or the webhook, or an admin purge) until purge:sweep finishes. */
export async function isErasing(db: Reader, subject: string): Promise<boolean> {
  const row = await db.query("erasures").withIndex("by_subject", (q: any) => q.eq("clerkSubject", subject)).first();
  return row !== null;
}

/**
 * Suspension outlives erasure on purpose (plan section 2): a suspended account
 * that deletes its data and signs in again must not get a clean public shelf.
 */
export async function isSuspendedSubject(db: Reader, subject: string): Promise<boolean> {
  const row = await db.query("suspendedSubjects").withIndex("by_subject", (q: any) => q.eq("clerkSubject", subject)).first();
  return row !== null;
}

/**
 * The single hold helper: one heldHandles row per handle, patched rather than
 * duplicated, read with first() so a stray second row can never throw the way
 * unique() would inside somebody's claim.
 */
export async function holdHandle(db: Db, handle: string, now: number): Promise<void> {
  const until = now + HOLD_MS;
  const held = await db.query("heldHandles").withIndex("by_handle", (q: any) => q.eq("handle", handle)).first();
  if (held) {
    if (held.until < until) await db.patch("heldHandles", held._id, { until });
    return;
  }
  await db.insert("heldHandles", { handle, until });
}

// ── claimHandle ──────────────────────────────────────────────────────────────

/**
 * Claim a first handle or change to a new one, in the order section 3.3 fixes.
 * Lookup then insert inside one mutation is race safe: Convex has no unique
 * index, but two claims that read the same by_handle range conflict under OCC
 * and one of them retries into handle-taken.
 */
export async function claimHandleCore(db: Db, subject: string, args: { handle: unknown }, now: number): Promise<Success | Failure> {
  if (await isErasing(db, subject)) return erasingFailure();
  if (await isSuspendedSubject(db, subject)) return fail("suspended", MESSAGES.suspended);
  const limited = await enforce(db, subject, "handle.claim", now, "address attempts");
  if (limited) return limited;

  const handle = normalizeHandle(args.handle);
  const problem = handleProblem(handle);
  if (problem) return fail(problem, HANDLE_MESSAGES[problem]);

  const own = await profileBySubject(db, subject);
  if (own && own.handle === handle) return fail("same-handle", MESSAGES.same);

  const holder = await profileByHandle(db, handle);
  if (holder && holder.clerkSubject !== subject) return fail("handle-taken", MESSAGES.taken);

  const held = await db.query("heldHandles").withIndex("by_handle", (q: any) => q.eq("handle", handle)).first();
  if (held) {
    if (held.until > now) return fail("handle-taken", MESSAGES.taken);
    // An expired hold is cleared by the claim that finds it, so the table
    // shrinks without a cron of its own.
    await db.delete("heldHandles", held._id);
  }

  if (own && own.handle !== null) {
    // Checked here and recorded only after the change is written: the budget
    // is three changes, not three attempts, so a taken handle costs nothing.
    const budget = await checkRate(db, subject, "handle.change", now);
    if (!budget.allowed) return rateLimited(budget, "address changes");
    await holdHandle(db, own.handle, now);
    // published is left alone: changing the address of a public shelf keeps
    // it public at the new address.
    await db.patch("profiles", own._id, { handle, updatedAt: now });
    await recordRate(db, subject, "handle.change", now);
    return done({ handle });
  }

  if (own) {
    await db.patch("profiles", own._id, { handle, updatedAt: now });
    return done({ handle });
  }

  await db.insert("profiles", {
    clerkSubject: subject,
    handle,
    published: false,
    suspendedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return done({ handle });
}

// ── setPublished ─────────────────────────────────────────────────────────────

export async function setPublishedCore(
  db: Db,
  subject: string,
  args: { published: unknown; confirmAge?: unknown },
  now: number,
  env: PublishingEnv,
): Promise<Success | Failure> {
  if (await isErasing(db, subject)) return erasingFailure();
  const profile = await profileBySubject(db, subject);

  // Going private is never refused to somebody who has a profile: not by a
  // suspension, a rate limit or publishing being closed. Those gates exist to
  // stop a shelf becoming public, and none of them is a reason to keep one so.
  if (args.published !== true) {
    if (!profile) return fail("no-handle", MESSAGES.noHandle);
    if (profile.published) await db.patch("profiles", profile._id, { published: false, updatedAt: now });
    return done({ published: false });
  }

  if ((profile && profile.suspendedAt !== null) || (await isSuspendedSubject(db, subject))) {
    return fail("suspended", MESSAGES.suspended);
  }
  const limited = await enforce(db, subject, "profile.publish", now, "publishing changes");
  if (limited) return limited;
  if (!profile || profile.handle === null) return fail("no-handle", MESSAGES.noHandle);
  if (!publishingOpen(env)) return fail("publishing-closed", MESSAGES.closed);
  if (args.confirmAge !== true) return fail("age-confirmation-required", MESSAGES.age);

  if (!profile.published) await db.patch("profiles", profile._id, { published: true, updatedAt: now });
  return done({ published: true });
}

// ── byHandle ─────────────────────────────────────────────────────────────────

/**
 * The public projection, built field by field. Nothing from a stored row is
 * spread into the result, so a field added to the schema later stays private
 * until somebody adds it here by name.
 *
 * Catalogue books only, as { id, shelf }: a hand-added book's record is
 * whatever its owner typed, notes and dates are the owner's alone, and
 * listedAs is how the owner wrote the title down (plan decision O2).
 */
export function projectShelf(
  profile: any,
  entries: any[],
  opts: { isOwner: boolean; publishingOpen: boolean; suspended?: boolean },
): any {
  const books: { id: number; shelf: string | null }[] = [];
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    if (typeof entry.catalogId !== "number") continue;
    books.push({ id: entry.catalogId, shelf: typeof entry.shelf === "string" ? entry.shelf : null });
  }
  const shelf = { handle: profile.handle, books };
  if (!opts.isOwner) return shelf;
  return {
    handle: shelf.handle,
    books: shelf.books,
    isOwner: true,
    published: profile.published === true,
    suspended: opts.suspended ?? (profile.suspendedAt !== null),
    publishingOpen: opts.publishingOpen,
  };
}

/**
 * Every refusal is null and looks the same, so the answer never says whether a
 * handle exists, is private or is suspended. The entries are read last, only
 * once the answer is known to be a shelf: a private or missing shelf costs one
 * profile read and nothing more.
 */
export async function byHandleCore(db: Reader, viewerSubject: string | null, handle: unknown, env: PublishingEnv): Promise<any> {
  // Only the canonical spelling answers, so "?Ana" and "?ana" are not two
  // cache keys for one shelf, and a malformed handle costs no read at all.
  if (typeof handle !== "string" || handle !== normalizeHandle(handle) || handleProblem(handle) !== null) return null;

  const profile = await profileByHandle(db, handle);
  if (!profile) return null;

  const isOwner = typeof viewerSubject === "string" && viewerSubject === profile.clerkSubject;
  const suspended = profile.suspendedAt !== null || (await isSuspendedSubject(db, profile.clerkSubject));
  if (suspended && !isOwner) return null;
  const open = publishingOpen(env);
  if ((!profile.published || !open) && !isOwner) return null;

  const entries = await db
    .query("entries")
    .withIndex("by_owner", (q: any) => q.eq("clerkSubject", profile.clerkSubject))
    .take(MAX_ENTRIES + 1);
  return projectShelf(profile, entries, { isOwner, publishingOpen: open, suspended });
}

// ── deleteMyData and erasure ─────────────────────────────────────────────────

/**
 * The first step of every erasure: the user's own Delete, the Clerk
 * user.deleted webhook and an admin purge all come through here, so all three
 * hold the handle and stop writes the same way.
 *
 * Returns an intent rather than scheduling: started means the caller must
 * schedule purge:run for this subject, in the same mutation, so the erasures
 * row and the purge that ends it commit together or not at all.
 */
export async function removeProfileCore(db: Db, subject: string, now: number): Promise<{ started: boolean }> {
  if (await isErasing(db, subject)) return { started: false };
  const profile = await profileBySubject(db, subject);
  if (profile) {
    // Private first, then gone. The delete below makes the patch look
    // redundant, and it is meant to be: if this ever becomes a soft delete,
    // the shelf is still not left public.
    await db.patch("profiles", profile._id, { published: false, updatedAt: now });
    // Held for 30 days so a link to the deleted shelf cannot be picked up by
    // somebody else and point at their books instead.
    if (profile.handle !== null) await holdHandle(db, profile.handle, now);
    await db.delete("profiles", profile._id);
  }
  await db.insert("erasures", { clerkSubject: subject, at: now });
  return { started: true };
}

export async function deleteMyDataCore(db: Db, subject: string, now: number): Promise<(Success | Failure) & { started?: boolean }> {
  // A second press while the first is still running is a success that
  // changes nothing, never an error and never a second purge.
  if (await isErasing(db, subject)) return { ...done({ status: "erasing" }), started: false };
  const limited = await enforce(db, subject, "data.delete", now, "deletion requests");
  if (limited) return limited;
  const { started } = await removeProfileCore(db, subject, now);
  return { ...done({ status: "erasing" }), started };
}
