import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Rate rows older than 31 days count toward no window, and the per-call pruning
// only reaches a bucket its subject writes to again. Daily is enough: a row is
// never needed after its window, and the privacy page promises no more than a
// day past it for the longest one.
crons.daily("sweep stale rate events", { hourUTC: 4, minuteUTC: 17 }, internal.purge.sweepRateEvents, {});

// Holds past their 30 days. A claim clears one it finds, but a handle nobody
// tries again would otherwise keep its row, a bare name, for good.
crons.daily("sweep expired handle holds", { hourUTC: 4, minuteUTC: 29 }, internal.purge.sweepHeldHandles, {});

export default crons;
