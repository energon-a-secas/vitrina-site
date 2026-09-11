// Admin identity, as projects/sash-site/convex/lib/admin.ts, with one change:
// the list arrives as an argument. Cores never read process.env, so the node
// tests can hand in a list without touching the environment, and a handler
// cannot forget which variable it came from because there is only one place
// that reads it (the handler passes process.env.ADMIN_SUBJECTS).

/** ADMIN_SUBJECTS is comma separated Clerk subjects; blanks and surrounding space are ignored. */
export function adminSubjects(raw: string | null | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Exact match only. An unset list means nobody is an admin, never everybody. */
export function isAdminSubject(subject: string | null | undefined, raw: string | null | undefined): boolean {
  if (!subject) return false;
  return adminSubjects(raw).includes(subject);
}
