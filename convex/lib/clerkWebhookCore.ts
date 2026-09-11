// The Clerk users webhook, minus the HTTP plumbing (plan section 3.3).
//
// http.ts reads the body once as text, because the signature covers the exact
// bytes and a parsed and re-serialised body would never verify. It hands this
// function the text, the headers, the secret, the time and the verifier, and
// does one thing with the answer: run purge:eraseSubject when purgeSubject is
// not null.
//
// Svix sends every event type to an endpoint, whatever the dashboard
// subscription says, so any verified event that is not a well-formed
// user.deleted is answered 200 and ignored. A non-200 there would make Svix
// retry it for days and then disable the endpoint.

export type HeaderSource = { get(name: string): string | null };

export type Verifier = (
  secret: string,
  msgId: string,
  timestamp: string,
  rawBody: string,
  signatureHeader: string,
) => Promise<boolean>;

/** Svix's own tolerance: a delivery signed more than five minutes from now is refused as a replay. */
export const TOLERANCE_SECONDS = 300;

/** A Clerk user id, which is also the subject of that user's Convex token. */
export const CLERK_USER_ID_RE = /^user_[A-Za-z0-9]+$/;

export async function clerkWebhookCore(
  rawBody: string,
  headers: HeaderSource,
  secret: string | null | undefined,
  nowSeconds: number,
  verify: Verifier,
): Promise<{ status: number; purgeSubject: string | null }> {
  // 503 rather than 400: the delivery is fine and the fix is on our side, and
  // a 5xx is what makes Svix hold the event and retry once the secret is set.
  if (!secret) return { status: 503, purgeSubject: null };

  const msgId = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signature = headers.get("svix-signature");
  if (!msgId || !timestamp || !signature) return { status: 400, purgeSubject: null };

  if (!/^[0-9]+$/.test(timestamp)) return { status: 400, purgeSubject: null };
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return { status: 400, purgeSubject: null };

  if (!(await verify(secret, msgId, timestamp, rawBody, signature))) return { status: 400, purgeSubject: null };

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    // Signed by Svix but not JSON. Retrying cannot change it, so it is
    // acknowledged and dropped rather than left to disable the endpoint.
    return { status: 200, purgeSubject: null };
  }

  const id = event && typeof event === "object" && event.data && typeof event.data === "object" ? event.data.id : undefined;
  // The id becomes a subject the purge deletes by, so only the exact Clerk
  // shape passes; anything else is acknowledged and nothing is erased.
  if (event.type === "user.deleted" && typeof id === "string" && CLERK_USER_ID_RE.test(id)) {
    return { status: 200, purgeSubject: id };
  }
  return { status: 200, purgeSubject: null };
}
