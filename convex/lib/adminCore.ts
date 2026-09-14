import type { GenericDatabaseWriter } from "convex/server";
import { isAdminSubject } from "./admin.ts";
import { normalizeHandle } from "./handles.ts";
import { PURGE_BATCH } from "./limits.ts";
import { profileByHandle, profileBySubject, removeProfileCore } from "./profilesCore.ts";
import { done, fail } from "./result.ts";
import type { Failure, Success } from "./result.ts";

// Moderation, for the subjects listed in ADMIN_SUBJECTS. Each core checks the
// caller before it reads anything else, so a non-admin learns nothing about
// whether a handle exists.
//
// A signed-out caller gets not-admin too: the contract gives these functions no
// not-signed-in code, and "you are not an admin" is true of nobody in
// particular.

type Db = GenericDatabaseWriter<any>;

export type AdminEnv = { ADMIN_SUBJECTS?: string | null };

function notAdmin(): Failure {
  return fail("not-admin", "Only a Vitrina admin can do that.");
}

const NOT_FOUND = "No profile has that address.";
const NO_SUBJECT = "Give the account id, as the Clerk dashboard shows it.";

/** Sets or lifts both halves of a suspension for one account. profile says whether a live profile was there to hide. */
async function applySuspension(db: Db, subject: string, suspended: boolean, now: number): Promise<{ profile: boolean }> {
  const profile = await profileBySubject(db, subject);
  const rows = await db
    .query("suspendedSubjects")
    .withIndex("by_subject", (q: any) => q.eq("clerkSubject", subject))
    .take(PURGE_BATCH);
  if (suspended) {
    if (profile && profile.suspendedAt === null) await db.patch("profiles", profile._id, { suspendedAt: now, updatedAt: now });
    if (rows.length === 0) await db.insert("suspendedSubjects", { clerkSubject: subject, since: now });
  } else {
    if (profile && profile.suspendedAt !== null) await db.patch("profiles", profile._id, { suspendedAt: null, updatedAt: now });
    for (const row of rows) await db.delete("suspendedSubjects", row._id);
  }
  return { profile: profile !== null };
}

function subjectFrom(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Suspension lives in two places on purpose: suspendedAt hides a live profile
 * from byHandle, and the suspendedSubjects row outlives the profile, so
 * deleting the data and claiming again does not lift it.
 */
export async function setSuspendedCore(
  db: Db,
  callerSubject: string | null,
  args: { handle: unknown; suspended: unknown },
  now: number,
  env: AdminEnv,
): Promise<Success | Failure> {
  if (!isAdminSubject(callerSubject, env.ADMIN_SUBJECTS)) return notAdmin();
  const handle = normalizeHandle(args.handle);
  const profile = handle ? await profileByHandle(db, handle) : null;
  if (!profile) return fail("not-found", NOT_FOUND);
  await applySuspension(db, profile.clerkSubject, args.suspended === true, now);
  return done();
}

/**
 * Suspension by account id, for what setSuspended cannot reach. A suspended
 * person who erases their Vitrina data has no profile and no handle left, and
 * their suspendedSubjects row stayed with no way to lift it. It can also
 * suspend an account before it claims anything. The operator reads the id from
 * the Clerk dashboard.
 */
export async function setSubjectSuspendedCore(
  db: Db,
  callerSubject: string | null,
  args: { subject: unknown; suspended: unknown },
  now: number,
  env: AdminEnv,
): Promise<Success | Failure> {
  if (!isAdminSubject(callerSubject, env.ADMIN_SUBJECTS)) return notAdmin();
  const subject = subjectFrom(args.subject);
  if (!subject) return fail("not-found", NO_SUBJECT);
  const { profile } = await applySuspension(db, subject, args.suspended === true, now);
  return done({ profile });
}

/** The same erasure deleteMyData starts, for the profile holding a handle. started and subject are the handler's to schedule. */
export async function purgeByHandleCore(
  db: Db,
  callerSubject: string | null,
  args: { handle: unknown },
  now: number,
  env: AdminEnv,
): Promise<(Success | Failure) & { started?: boolean; subject?: string }> {
  if (!isAdminSubject(callerSubject, env.ADMIN_SUBJECTS)) return notAdmin();
  const handle = normalizeHandle(args.handle);
  const profile = handle ? await profileByHandle(db, handle) : null;
  if (!profile) return fail("not-found", NOT_FOUND);
  const { started } = await removeProfileCore(db, profile.clerkSubject, now);
  return { ...done({ status: "erasing" }), started, subject: profile.clerkSubject };
}

/**
 * The same erasure by account id, for a shelf that never had a handle: an
 * erasure request that names no handle could not be served at all before.
 * started and subject are the handler's to schedule.
 */
export async function purgeBySubjectCore(
  db: Db,
  callerSubject: string | null,
  args: { subject: unknown },
  now: number,
  env: AdminEnv,
): Promise<(Success | Failure) & { started?: boolean; subject?: string }> {
  if (!isAdminSubject(callerSubject, env.ADMIN_SUBJECTS)) return notAdmin();
  const subject = subjectFrom(args.subject);
  if (!subject) return fail("not-found", NO_SUBJECT);
  const { started } = await removeProfileCore(db, subject, now);
  return { ...done({ status: "erasing" }), started, subject };
}

/**
 * Lifts the 30-day hold on a handle so it can be claimed today, for example by
 * a person who changed away from it by mistake. It never takes a handle off a
 * live profile: that would be a moderation action with consequences for the
 * owner, and it needs its own name if it is ever wanted.
 */
export async function releaseHandleCore(
  db: Db,
  callerSubject: string | null,
  args: { handle: unknown },
  _now: number,
  env: AdminEnv,
): Promise<Success | Failure> {
  if (!isAdminSubject(callerSubject, env.ADMIN_SUBJECTS)) return notAdmin();
  const handle = normalizeHandle(args.handle);
  if (!handle) return done({ released: false });
  const holds = await db.query("heldHandles").withIndex("by_handle", (q: any) => q.eq("handle", handle)).take(PURGE_BATCH);
  for (const row of holds) await db.delete("heldHandles", row._id);
  return done({ released: holds.length > 0 });
}
