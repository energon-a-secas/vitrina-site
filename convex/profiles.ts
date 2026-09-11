import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { fail } from "./lib/result.ts";
import { byHandleCore, claimHandleCore, deleteMyDataCore, setPublishedCore } from "./lib/profilesCore.ts";

// Thin wrappers over convex/lib/profilesCore.ts. Where a core answers
// started, the handler schedules the purge inside this same mutation, which is
// what makes the erasures row and the purge that ends it commit together.

const NOT_SIGNED_IN = "Sign in to manage your shelf's address.";

export const claimHandle = mutation({
  args: { handle: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return fail("not-signed-in", NOT_SIGNED_IN);
    return await claimHandleCore(ctx.db, identity.subject, args, Date.now());
  },
});

export const setPublished = mutation({
  args: { published: v.boolean(), confirmAge: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return fail("not-signed-in", NOT_SIGNED_IN);
    return await setPublishedCore(ctx.db, identity.subject, args, Date.now(), { PUBLISHING: process.env.PUBLISHING });
  },
});

export const byHandle = query({
  // v.any(), so that a handle of the wrong type is answered null like every
  // other refusal instead of throwing a validation error; the core checks the
  // type before it reads anything.
  args: { handle: v.any() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    return await byHandleCore(ctx.db, identity ? identity.subject : null, args.handle, {
      PUBLISHING: process.env.PUBLISHING,
    });
  },
});

export const deleteMyData = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return fail("not-signed-in", "Sign in to delete your Vitrina data.");
    const { started, ...result } = await deleteMyDataCore(ctx.db, identity.subject, Date.now());
    if (started) await ctx.scheduler.runAfter(0, internal.purge.run, { subject: identity.subject });
    return result;
  },
});
