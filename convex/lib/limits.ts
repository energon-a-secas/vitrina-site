// Every number the backend enforces, in one place (plan sections 3.2 and 3.3).
// A number that lives in two files drifts in one of them, so the cores and the
// tests import these rather than repeating them.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The most books one account shelf holds, checked against shelfMeta.count. */
export const MAX_ENTRIES = 2000;

/** The most entries one upsertEntries call may carry; the client sends chunks of this. */
export const CALL_MAX = 200;

/** How long a released handle stays unclaimable, for everyone, its old owner included. */
export const HOLD_MS = 30 * DAY;

/** Entries deleted per purge:run. Well under the 16,000 writes one transaction allows. */
export const PURGE_BATCH = 1000;

/**
 * purge:sweep runs this long after the purge empties a shelf. A Convex token
 * from Clerk lives 60 seconds, so by then no token minted before a Clerk
 * account was deleted can still write.
 */
export const SWEEP_DELAY_MS = 5 * MINUTE;

/** Stale rate rows one check deletes, so a long idle bucket cannot make one call expensive. */
export const RATE_PRUNE_MAX = 100;

/**
 * The daily cron deletes rate rows older than this. It is one day past the
 * longest window (handle.change, 30 days), so no row a live window still
 * counts is ever swept.
 */
export const RATE_SWEEP_AGE_MS = 31 * DAY;

/** Rows per sweepRateEvents run. */
export const RATE_SWEEP_BATCH = 500;

export type LimitName = "handle.claim" | "handle.change" | "profile.publish" | "shelf.write" | "data.delete";

/**
 * Per subject. Every bucket is "<clerk subject>|<name>", never anything the
 * client sent. handle.change counts successful changes only, so it is checked
 * before a change and recorded after the change is written.
 */
export const LIMITS: Record<LimitName, { max: number; windowMs: number }> = {
  "handle.claim": { max: 10, windowMs: HOUR },
  "handle.change": { max: 3, windowMs: 30 * DAY },
  "profile.publish": { max: 30, windowMs: HOUR },
  "shelf.write": { max: 600, windowMs: HOUR },  // one per call, whatever the call carries
  "data.delete": { max: 60, windowMs: HOUR },
};

/** Every bucket name, in a fixed order, for the purge that deletes a subject's rows. */
export const LIMIT_NAMES: readonly LimitName[] = Object.freeze(Object.keys(LIMITS) as LimitName[]);
