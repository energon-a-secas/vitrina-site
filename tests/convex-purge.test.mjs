// Plain node, no install. Run with: make validate
//
// Erasure after the erasures row exists, through convex/lib/purgeCore.ts. The
// promise on the privacy page is that every book and every rate record goes,
// and that suspension is the one thing kept, so each of those is counted here
// row by row, next to another subject whose rows must all survive.

import { createFakeDb } from './support/fakedb.mjs';
import { purgeBatchCore, sweepCore, sweepRateEventsCore } from '../convex/lib/purgeCore.ts';
import { deleteMyDataCore } from '../convex/lib/profilesCore.ts';
import { mineCore } from '../convex/lib/shelfCore.ts';
import { bucketFor } from '../convex/lib/rate.ts';
import { LIMIT_NAMES, PURGE_BATCH, RATE_SWEEP_AGE_MS, RATE_SWEEP_BATCH, SWEEP_DELAY_MS } from '../convex/lib/limits.ts';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

const T0 = Date.UTC(2026, 8, 11, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const ALICE = 'user_alice';
const BOB = 'user_bob';
const ALICE2 = 'user_alice2';   // starts with Alice's subject: exact bucket equality must spare it

async function shelf(db, subject, n) {
  for (let i = 1; i <= n; i++) {
    await db.insert('entries', { clerkSubject: subject, key: 'tf' + i, catalogId: i, shelf: null, note: 'n', listedAs: null, added: null, record: null, updatedAt: T0 });
  }
  await db.insert('shelfMeta', { clerkSubject: subject, count: n });
}
async function rates(db, subject, perBucket) {
  for (const name of LIMIT_NAMES) {
    for (let i = 0; i < perBucket; i++) await db.insert('rateEvents', { bucket: bucketFor(subject, name), at: T0 - i });
  }
}
const entriesOf = (db, subject) => db.rows('entries').filter((e) => e.clerkSubject === subject).length;
const metaOf = (db, subject) => db.rows('shelfMeta').filter((m) => m.clerkSubject === subject).map((m) => m.count);
const bucketsOf = (db, subject) => LIMIT_NAMES.map((name) => db.rows('rateEvents').filter((r) => r.bucket === bucketFor(subject, name)).length);
const rowsFor = (db, table, subject) => db.rows(table).filter((r) => r.clerkSubject === subject).length;

// ── A 1,500-book shelf, in batches of 1000 ──────────────────────────────────
{
  const db = createFakeDb();
  await db.insert('profiles', { clerkSubject: ALICE, handle: 'alice', published: true, suspendedAt: T0, createdAt: T0, updatedAt: T0 });
  await db.insert('suspendedSubjects', { clerkSubject: ALICE, since: T0 });
  await shelf(db, ALICE, 1500);
  await rates(db, ALICE, 3);
  await shelf(db, BOB, 2);
  await rates(db, BOB, 2);
  await rates(db, ALICE2, 1);

  const started = await deleteMyDataCore(db, ALICE, T0 + 1);
  eq(started.started, true, 'deleteMyData started the erasure');

  eq(await purgeBatchCore(db, ALICE), { more: true, deleted: PURGE_BATCH }, 'the first run deletes 1000 and asks to run again');
  eq([entriesOf(db, ALICE), metaOf(db, ALICE)], [500, [500]], '500 books remain and shelfMeta says so');
  eq(await mineCore(db, ALICE, {}), { erasing: true, remaining: 500 }, 'which is what the Delete dialog polls');

  eq(await purgeBatchCore(db, ALICE), { more: false, deleted: 500, sweepAfterMs: SWEEP_DELAY_MS }, 'the second run finishes and asks for the sweep in 5 minutes');
  eq(entriesOf(db, ALICE), 0, 'every book is gone');
  eq(metaOf(db, ALICE), [], 'the shelfMeta row is gone');
  eq(bucketsOf(db, ALICE), LIMIT_NAMES.map(() => 0), `every rate bucket is empty: ${LIMIT_NAMES.join(', ')}`);

  eq([entriesOf(db, BOB), metaOf(db, BOB), bucketsOf(db, BOB)], [2, [2], LIMIT_NAMES.map(() => 2)], "Bob's books, count and rate rows are untouched");
  eq(bucketsOf(db, ALICE2), LIMIT_NAMES.map(() => 1), 'a subject that merely starts with the same text keeps its rate rows');
  eq(rowsFor(db, 'erasures', ALICE), 1, 'the erasure is not over until the sweep');

  // Something wrote in the gap; the sweep repeats the deletion.
  await db.insert('rateEvents', { bucket: bucketFor(ALICE, 'data.delete'), at: T0 + 2 });
  await db.insert('shelfMeta', { clerkSubject: ALICE, count: 0 });
  eq(await sweepCore(db, ALICE), { more: false, restart: false, erased: true }, 'the sweep ends the erasure');
  eq([bucketsOf(db, ALICE), metaOf(db, ALICE)], [LIMIT_NAMES.map(() => 0), []], 'after deleting the rate rows and shelfMeta again');
  eq(rowsFor(db, 'erasures', ALICE), 0, 'the erasures row is deleted');
  eq(rowsFor(db, 'suspendedSubjects', ALICE), 1, 'suspendedSubjects survives the erasure');
  eq(rowsFor(db, 'erasures', BOB) + rowsFor(db, 'suspendedSubjects', BOB), 0, 'and Bob was never involved');
  eq((await mineCore(db, ALICE, {})).erasing, false, 'Alice can use Vitrina again, with an empty shelf');
}

// ── A sweep never ends an erasure while books exist ─────────────────────────
{
  const db = createFakeDb();
  await db.insert('erasures', { clerkSubject: ALICE, at: T0 });
  await shelf(db, ALICE, 1);
  eq(await sweepCore(db, ALICE), { more: false, restart: true, erased: false }, 'a sweep that finds a book asks for the purge again');
  eq(rowsFor(db, 'erasures', ALICE), 1, 'and keeps the erasures row');
}

// ── A rate bucket with a full batch ─────────────────────────────────────────
{
  const db = createFakeDb();
  await db.insert('erasures', { clerkSubject: ALICE, at: T0 });
  for (let i = 0; i < PURGE_BATCH + 3; i++) await db.insert('rateEvents', { bucket: bucketFor(ALICE, 'shelf.write'), at: T0 - i });
  eq(await purgeBatchCore(db, ALICE), { more: true, deleted: 0 }, 'a bucket holding a full batch makes the run go again');
  eq(await purgeBatchCore(db, ALICE), { more: false, deleted: 0, sweepAfterMs: SWEEP_DELAY_MS }, 'and the next run finishes it');
  eq(bucketsOf(db, ALICE), LIMIT_NAMES.map(() => 0), 'leaving no rate rows');
}

// ── The daily rate sweep ────────────────────────────────────────────────────
{
  const db = createFakeDb();
  const now = T0 + 40 * DAY;
  const cutoff = now - RATE_SWEEP_AGE_MS;
  for (const [bucket, at] of [['user_a|shelf.write', cutoff - 1], ['user_b|handle.change', cutoff - DAY], ['user_c|handle.change', cutoff],
    ['user_d|shelf.write', cutoff + 1], ['user_e|data.delete', now]]) {
    await db.insert('rateEvents', { bucket, at });
  }
  eq(await sweepRateEventsCore(db, now), { more: false, deleted: 2 }, 'the daily sweep deletes the two rows older than 31 days');
  eq(db.rows('rateEvents').map((r) => r.bucket), ['user_c|handle.change', 'user_d|shelf.write', 'user_e|data.delete'],
    'and keeps a row exactly 31 days old and everything newer');

  const busy = createFakeDb();
  for (let i = 0; i < RATE_SWEEP_BATCH + 5; i++) await busy.insert('rateEvents', { bucket: 'user_a|shelf.write', at: cutoff - 1 - i });
  await busy.insert('rateEvents', { bucket: 'user_a|shelf.write', at: now });
  eq(await sweepRateEventsCore(busy, now), { more: true, deleted: RATE_SWEEP_BATCH }, 'at most 500 per run, asking to run again');
  eq(await sweepRateEventsCore(busy, now), { more: false, deleted: 5 }, 'the next run takes the rest');
  eq(busy.count('rateEvents'), 1, 'leaving the recent row');
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
