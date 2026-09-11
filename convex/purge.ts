import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { SWEEP_DELAY_MS } from "./lib/limits.ts";
import { removeProfileCore } from "./lib/profilesCore.ts";
import { purgeBatchCore, sweepCore, sweepRateEventsCore } from "./lib/purgeCore.ts";

// Internal only: nothing here can be called from a browser. Each function does
// one bounded transaction through a core in convex/lib/purgeCore.ts and
// schedules whatever that core says comes next. Scheduling from a mutation is
// atomic with its commit, so a batch that fails to commit schedules nothing and
// the previous schedule simply runs it again.

export const run = internalMutation({
  args: { subject: v.string() },
  handler: async (ctx, { subject }): Promise<{ deleted: number; more: boolean }> => {
    const result = await purgeBatchCore(ctx.db, subject);
    if (result.more) await ctx.scheduler.runAfter(0, internal.purge.run, { subject });
    else await ctx.scheduler.runAfter(result.sweepAfterMs ?? SWEEP_DELAY_MS, internal.purge.sweep, { subject });
    return { deleted: result.deleted, more: result.more };
  },
});

export const sweep = internalMutation({
  args: { subject: v.string() },
  handler: async (ctx, { subject }): Promise<{ more: boolean; restart: boolean; erased: boolean }> => {
    const result = await sweepCore(ctx.db, subject);
    if (result.restart) await ctx.scheduler.runAfter(0, internal.purge.run, { subject });
    else if (result.more) await ctx.scheduler.runAfter(0, internal.purge.sweep, { subject });
    return result;
  },
});

// The Clerk user.deleted webhook lands here, through the same removeProfileCore
// that deleteMyData and admin:purgeByHandle use.
export const eraseSubject = internalMutation({
  args: { subject: v.string() },
  handler: async (ctx, { subject }): Promise<{ started: boolean }> => {
    const { started } = await removeProfileCore(ctx.db, subject, Date.now());
    if (started) await ctx.scheduler.runAfter(0, internal.purge.run, { subject });
    return { started };
  },
});

export const sweepRateEvents = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ more: boolean; deleted: number }> => {
    const result = await sweepRateEventsCore(ctx.db, Date.now());
    if (result.more) await ctx.scheduler.runAfter(0, internal.purge.sweepRateEvents, {});
    return result;
  },
});
