import type { GenericDatabaseWriter } from "convex/server";
import { isAdminSubject } from "./admin.ts";
import { normalizeHandle } from "./handles.ts";
import { PURGE_BATCH } from "./limits.ts";
import { profileByHandle, removeProfileCore } from "./profilesCore.ts";
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

  const rows = await db
    .query("suspendedSubjects")
    .withIndex("by_subject", (q: any) => q.eq("clerkSubject", profile.clerkSubject))
    .take(PURGE_BATCH);
  if (args.suspended === true) {
    if (profile.suspendedAt === null) await db.patch("profiles", profile._id, { suspendedAt: now, updatedAt: now });
    if (rows.length === 0) await db.insert("suspendedSubjects", { clerkSubject: profile.clerkSubject, since: now });
  } else {
    if (profile.suspendedAt !== null) await db.patch("profiles", profile._id, { suspendedAt: null, updatedAt: now });
    for (const row of rows) await db.delete("suspendedSubjects", row._id);
  }
  return done();
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
