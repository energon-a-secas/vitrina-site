import type { GenericDatabaseWriter } from "convex/server";
import { LIMIT_NAMES, PURGE_BATCH, RATE_SWEEP_AGE_MS, RATE_SWEEP_BATCH, SWEEP_DELAY_MS } from "./limits.ts";
import { bucketFor } from "./rate.ts";
import { readMeta } from "./shelfCore.ts";

// Erasure after the erasures row exists (plan section 3.3). Each core does one
// bounded transaction and returns what the handler must schedule next, so a
// 2000-book shelf is deleted in a few small mutations instead of one that
// brushes against the per-transaction write limit.
//
// suspendedSubjects is never touched here. Suspension is kept after erasure as
// abuse prevention, and the privacy page says so.

type Db = GenericDatabaseWriter<any>;

// Exact bucket equality on by_bucket_at, one bucket per limit name. A prefix
// range over "<subject>|" would also match a subject that merely starts with
// this one.
async function deleteRateBuckets(db: Db, subject: string): Promise<{ more: boolean; deleted: number }> {
  let deleted = 0;
  let more = false;
  for (const name of LIMIT_NAMES) {
    const bucket = bucketFor(subject, name);
    const rows = await db.query("rateEvents").withIndex("by_bucket_at", (q: any) => q.eq("bucket", bucket)).take(PURGE_BATCH);
    for (const row of rows) await db.delete("rateEvents", row._id);
    deleted += rows.length;
    if (rows.length === PURGE_BATCH) more = true;
  }
  return { more, deleted };
}

async function deleteMeta(db: Db, subject: string): Promise<void> {
  const meta = await readMeta(db, subject);
  if (meta) await db.delete("shelfMeta", meta._id);
}

/**
 * purge:run. more: run again now. Otherwise schedule purge:sweep after
 * sweepAfterMs. The count on shelfMeta goes down with each full batch, which
 * is what shelf:mine reports as remaining while the Delete dialog polls.
 */
export async function purgeBatchCore(db: Db, subject: string): Promise<{ more: boolean; deleted: number; sweepAfterMs?: number }> {
  const rows = await db.query("entries").withIndex("by_owner", (q: any) => q.eq("clerkSubject", subject)).take(PURGE_BATCH);
  for (const row of rows) await db.delete("entries", row._id);
  if (rows.length === PURGE_BATCH) {
    const meta = await readMeta(db, subject);
    if (meta) await db.patch("shelfMeta", meta._id, { count: Math.max(0, meta.count - rows.length) });
    return { more: true, deleted: rows.length };
  }

  await deleteMeta(db, subject);
  const rate = await deleteRateBuckets(db, subject);
  if (rate.more) return { more: true, deleted: rows.length };
  return { more: false, deleted: rows.length, sweepAfterMs: SWEEP_DELAY_MS };
}

/**
 * purge:sweep, run SWEEP_DELAY_MS after the shelf emptied. It repeats the
 * shelfMeta and rate deletion, then deletes the erasures row, which is the
 * moment the subject may use Vitrina again.
 *
 * more: run the sweep again now (a bucket held a full batch). restart: entries
 * exist again, so schedule purge:run instead of ending the erasure. Nothing
 * should be able to write while the erasures row exists, and this is the check
 * that keeps a deleted shelf from reappearing if something ever does.
 */
export async function sweepCore(db: Db, subject: string): Promise<{ more: boolean; restart: boolean; erased: boolean }> {
  const leftover = await db.query("entries").withIndex("by_owner", (q: any) => q.eq("clerkSubject", subject)).first();
  if (leftover) return { more: false, restart: true, erased: false };

  await deleteMeta(db, subject);
  const rate = await deleteRateBuckets(db, subject);
  if (rate.more) return { more: true, restart: false, erased: false };

  const rows = await db.query("erasures").withIndex("by_subject", (q: any) => q.eq("clerkSubject", subject)).take(PURGE_BATCH);
  for (const row of rows) await db.delete("erasures", row._id);
  return { more: false, restart: false, erased: true };
}

/**
 * The daily cron. Rows older than RATE_SWEEP_AGE_MS count toward no window, and
 * a subject that never writes again never triggers the per-call pruning, so
 * without this their rows would stay forever. more: run again now.
 */
export async function sweepRateEventsCore(db: Db, now: number): Promise<{ more: boolean; deleted: number }> {
  const cutoff = now - RATE_SWEEP_AGE_MS;
  const rows = await db.query("rateEvents").withIndex("by_at", (q: any) => q.lt("at", cutoff)).take(RATE_SWEEP_BATCH);
  for (const row of rows) await db.delete("rateEvents", row._id);
  return { more: rows.length === RATE_SWEEP_BATCH, deleted: rows.length };
}
