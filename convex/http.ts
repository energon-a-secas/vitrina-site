import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { clerkWebhookCore } from "./lib/clerkWebhookCore.ts";
import { verifySvixSignature } from "./lib/webhookVerify.ts";

// Clerk's user.deleted webhook, delivered by Svix to
// https://<deployment>.convex.site/clerk-users-webhook (.site, not .cloud).
// Every decision is in convex/lib/clerkWebhookCore.ts; this reads the request
// and acts on the answer.

const http = httpRouter();

const BODIES: Record<number, string> = { 200: "ok", 400: "rejected", 503: "webhook secret not configured" };

http.route({
  path: "/clerk-users-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Read once, as text: the signature covers these exact bytes.
    const rawBody = await request.text();
    const { status, purgeSubject } = await clerkWebhookCore(
      rawBody,
      request.headers,
      process.env.CLERK_WEBHOOK_SECRET,
      Math.floor(Date.now() / 1000),
      verifySvixSignature,
    );
    // runMutation rather than a scheduled call, so a failed erasure answers
    // 500 and Svix delivers the event again; eraseSubject is safe to repeat.
    if (purgeSubject !== null) await ctx.runMutation(internal.purge.eraseSubject, { subject: purgeSubject });
    return new Response(BODIES[status] ?? "", { status });
  }),
});

export default http;
