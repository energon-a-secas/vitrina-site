import { mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { purgeByHandleCore, releaseHandleCore, setSuspendedCore } from "./lib/adminCore.ts";

// Moderation, thin wrappers over convex/lib/adminCore.ts. ADMIN_SUBJECTS is read
// here and nowhere else. A signed-out caller is passed as null and refused as
// not-admin, the only refusal these functions have for who is asking.

export const setSuspended = mutation({
  args: { handle: v.string(), suspended: v.boolean() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    return await setSuspendedCore(ctx.db, identity ? identity.subject : null, args, Date.now(), {
      ADMIN_SUBJECTS: process.env.ADMIN_SUBJECTS,
    });
  },
});

export const purgeByHandle = mutation({
  args: { handle: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const { started, subject, ...result } = await purgeByHandleCore(ctx.db, identity ? identity.subject : null, args, Date.now(), {
      ADMIN_SUBJECTS: process.env.ADMIN_SUBJECTS,
    });
    // The purge runs for the profile's owner, never for the admin who asked.
    if (started && subject) await ctx.scheduler.runAfter(0, internal.purge.run, { subject });
    return result;
  },
});

export const releaseHandle = mutation({
  args: { handle: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    return await releaseHandleCore(ctx.db, identity ? identity.subject : null, args, Date.now(), {
      ADMIN_SUBJECTS: process.env.ADMIN_SUBJECTS,
    });
  },
});
