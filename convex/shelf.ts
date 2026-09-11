import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { fail } from "./lib/result.ts";
import { mineCore, removeEntryCore, updateEntryCore, upsertEntriesCore } from "./lib/shelfCore.ts";

// Thin wrappers. The rules live in convex/lib/shelfCore.ts, where make validate
// tests them with no deployment and no install; a handler only turns a Convex
// context into the plain arguments a core takes. The person is always the
// token's subject, never an argument.

const NOT_SIGNED_IN = "Sign in to change the shelf kept in your account.";

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await mineCore(ctx.db, identity.subject, { PUBLISHING: process.env.PUBLISHING });
  },
});

export const upsertEntries = mutation({
  // v.any() per entry because the core's whitelist is the validator, and it
  // answers invalid-entry with the index and a reason where a validator error
  // would reach the browser as an opaque throw.
  args: { entries: v.array(v.any()), fillEmpty: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return fail("not-signed-in", NOT_SIGNED_IN);
    return await upsertEntriesCore(ctx.db, identity.subject, args, Date.now());
  },
});

export const updateEntry = mutation({
  args: {
    key: v.string(),
    shelf: v.optional(v.union(v.string(), v.null())),
    note: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return fail("not-signed-in", NOT_SIGNED_IN);
    return await updateEntryCore(ctx.db, identity.subject, args, Date.now());
  },
});

export const removeEntry = mutation({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return fail("not-signed-in", NOT_SIGNED_IN);
    return await removeEntryCore(ctx.db, identity.subject, args, Date.now());
  },
});
