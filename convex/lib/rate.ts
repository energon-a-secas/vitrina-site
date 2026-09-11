import type { GenericDatabaseWriter } from "convex/server";
import { LIMITS, RATE_PRUNE_MAX } from "./limits.ts";
import type { LimitName } from "./limits.ts";
import { fail } from "./result.ts";
import type { Failure } from "./result.ts";

// Rate limiting per Clerk subject, the sash pattern
// (projects/sash-site/convex/rate.ts): a sliding window over rateEvents rows,
// checked inside the caller's own transaction, returning a failure rather than
// throwing so the client can name what was refused.
//
// Two changes from sash. The window is read with take(max) instead of
// collect(), because the only question is whether the window is full, and
// take(max) answers it without reading an unbounded range. And check and
// record are separate calls, because handle.change counts successful changes:
// a change refused as taken must not spend one of the three.

type Db = GenericDatabaseWriter<any>;

export type Verdict = { allowed: boolean; used: number; max: number; retryAfterMs: number };

export function bucketFor(subject: string, name: LimitName): string {
  return `${subject}|${name}`;
}

/** Reads the window and prunes a bounded number of rows that have aged out. Records nothing. */
export async function checkRate(db: Db, subject: string, name: LimitName, now: number): Promise<Verdict> {
  const { max, windowMs } = LIMITS[name];
  const bucket = bucketFor(subject, name);
  const cutoff = now - windowMs;

  // Ascending by at, so the first row is the one that has to age out next.
  const recent = await db
    .query("rateEvents")
    .withIndex("by_bucket_at", (q: any) => q.eq("bucket", bucket).gte("at", cutoff))
    .take(max);

  // At most RATE_PRUNE_MAX per call. A bucket left idle for a month would
  // otherwise make the next call pay for deleting all of it at once; the daily
  // sweep in purge:sweepRateEvents catches whatever this leaves behind.
  const stale = await db
    .query("rateEvents")
    .withIndex("by_bucket_at", (q: any) => q.eq("bucket", bucket).lt("at", cutoff))
    .take(RATE_PRUNE_MAX);
  for (const row of stale) await db.delete("rateEvents", row._id);

  if (recent.length >= max) {
    return { allowed: false, used: recent.length, max, retryAfterMs: Math.max(0, recent[0].at + windowMs - now) };
  }
  return { allowed: true, used: recent.length, max, retryAfterMs: 0 };
}

export async function recordRate(db: Db, subject: string, name: LimitName, now: number): Promise<void> {
  await db.insert("rateEvents", { bucket: bucketFor(subject, name), at: now });
}

function unit(n: number, name: string): string {
  return `${n} ${name}${n === 1 ? "" : "s"}`;
}

/** Rounded up, in the largest unit that does not under-state the wait (sash C15 A42.3). */
export function retryAfterText(ms: number): string {
  const safe = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
  const minutes = Math.max(1, Math.ceil(safe / 60000));
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return unit(hours, "hour");
  return unit(Math.ceil(hours / 24), "day");
}

export function rateLimited(verdict: Verdict, what: string): Failure {
  return fail("rate-limited", `Too many ${what}. Try again in ${retryAfterText(verdict.retryAfterMs)}.`, {
    retryAfterMs: verdict.retryAfterMs,
  });
}

/** Check and record in one step: the shape every bucket but handle.change uses. */
export async function enforce(db: Db, subject: string, name: LimitName, now: number, what: string): Promise<Failure | null> {
  const verdict = await checkRate(db, subject, name, now);
  if (!verdict.allowed) return rateLimited(verdict, what);
  await recordRate(db, subject, name, now);
  return null;
}
