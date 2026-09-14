// Plain node, no install. Run with: make validate
//
// What the backend contract (plan 2026-09-11, sections 3.2 to 3.4) fixes and
// no behaviour test can see.
//
// The other tests read their numbers from convex/lib/limits.ts, so a number
// changed there moves its tests with it and they still pass, even when the
// change breaks a guarantee: a sweep shorter than a token's life, or a rate
// sweep that deletes rows a 30-day window still counts. The numbers are stated
// here literally, once.
//
// Two checks read text rather than behaviour: what README and make help say
// make validate needs, and one TypeScript spelling in convex/ that the Convex
// CLI refuses once typescript is installed.

import { readFileSync, readdirSync } from 'node:fs';
import {
  CALL_MAX, HOLD_MS, LIMIT_NAMES, LIMITS, MAX_ENTRIES, PURGE_BATCH, RATE_PRUNE_MAX, RATE_SWEEP_AGE_MS, RATE_SWEEP_BATCH, ROW_OVERHEAD_BYTES, SHELF_BYTES_MAX, SWEEP_DELAY_MS,
} from '../convex/lib/limits.ts';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ── The numbers, as the plan writes them ────────────────────────────────────
eq({ MAX_ENTRIES, CALL_MAX, HOLD_MS, PURGE_BATCH, SWEEP_DELAY_MS, RATE_PRUNE_MAX, RATE_SWEEP_AGE_MS, RATE_SWEEP_BATCH },
  { MAX_ENTRIES: 2000, CALL_MAX: 200, HOLD_MS: 30 * DAY, PURGE_BATCH: 1000, SWEEP_DELAY_MS: 5 * MINUTE, RATE_PRUNE_MAX: 100, RATE_SWEEP_AGE_MS: 31 * DAY, RATE_SWEEP_BATCH: 500 },
  '2000 books, 200 per call, a 30-day hold, purges of 1000, a sweep 5 minutes on, 100 pruned per check, rate rows kept 31 days and swept 500 at a time');
eq(LIMITS, {
  'handle.claim': { max: 10, windowMs: HOUR },
  'handle.change': { max: 3, windowMs: 30 * DAY },
  'profile.publish': { max: 30, windowMs: HOUR },
  'shelf.write': { max: 600, windowMs: HOUR },
  'data.delete': { max: 60, windowMs: HOUR },
}, 'rate limits: 10 claims an hour, 3 changes in 30 days, 30 publish changes an hour, 600 shelf writes an hour, 60 deletion requests an hour');
eq([...LIMIT_NAMES], ['handle.claim', 'handle.change', 'profile.publish', 'shelf.write', 'data.delete'], 'and the purge deletes exactly those five buckets');
eq({ SHELF_BYTES_MAX, ROW_OVERHEAD_BYTES }, { SHELF_BYTES_MAX: 8 * 1024 * 1024, ROW_OVERHEAD_BYTES: 150 },
  'an account shelf weighs at most 8 MiB, counting 150 bytes a row for what the budget does not weigh');

// ── The guarantees that rest on them ────────────────────────────────────────
// A Clerk token for Convex lives 60 s (plan section 1). The sweep is what ends
// an erasure, so it has to wait out any token minted before the deletion.
eq(SWEEP_DELAY_MS > 60 * 1000, true, 'purge:sweep waits longer than a Clerk token lives');
// A Convex function reads at most 16 MiB, and shelf:mine and profiles:byHandle
// read a whole shelf, so the byte budget has to leave that read well clear.
eq(SHELF_BYTES_MAX <= 8 * 1024 * 1024, true, 'a whole shelf at its byte budget reads at most half of the 16 MiB a function may read');
// The daily sweep deletes by age alone, so a row younger than a window would
// be gone while that window still counts it, lifting the limit early.
eq(Object.entries(LIMITS).filter(([, limit]) => RATE_SWEEP_AGE_MS <= limit.windowMs).map(([name]) => name), [],
  'the daily rate sweep never deletes a row that a window still counts');

// ── What make validate needs, where a person reads it (plan section 3.4) ────
// The backend tests import convex/lib/*.ts, so on a Node that does not strip
// types by default make validate stops at the first of those imports.
const NEEDS = /a Node that strips TypeScript types by default \(verified on v25\.4\.0\)/i;
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const makeHelp = readFileSync(new URL('../Makefile', import.meta.url), 'utf8').split('\n').filter((line) => /^\t@echo /.test(line)).join('\n');
eq(NEEDS.test(readme), true, 'README says make validate needs a Node that strips TypeScript types by default');
eq(NEEDS.test(makeHelp), true, 'and so does make help');

// ── A spelling the Convex CLI refuses ───────────────────────────────────────
// Since TypeScript 5.7 a bare Uint8Array type means Uint8Array<ArrayBufferLike>,
// which Web Crypto's BufferSource does not accept. Once typescript is installed
// (plan section 3.4 allows it, pinned exactly), the CLI runs tsc before every
// push, and both its default --typecheck=try and enable fail the push on an
// error. make validate has no tsc, so it keeps the bare spelling out instead.
const CONVEX = new URL('../convex/', import.meta.url);
const bare = [];
const sources = readdirSync(CONVEX, { recursive: true }).map((name) => String(name).replace(/\\/g, '/'))
  .filter((name) => name.endsWith('.ts') && !name.startsWith('_generated')).sort();
for (const name of sources) {
  const code = readFileSync(new URL(name, CONVEX), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/\/\/[^\n]*/g, '');
  code.split('\n').forEach((line, i) => {
    if (/(?::|<|,|\||\bas)\s*Uint8Array\b(?!\s*<)/.test(line)) bare.push(`convex/${name}:${i + 1}`);
  });
}
eq(sources.includes('lib/webhookVerify.ts'), true, 'the scan reads convex/lib, where the byte arrays are');
eq(bare, [], 'no type in convex/ is a bare Uint8Array: each one says Uint8Array<ArrayBuffer>');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
