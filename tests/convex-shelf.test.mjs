// Plain node, no install. Run with: make validate
//
// The account shelf through convex/lib/shelfCore.ts, over the in-memory
// database in tests/support/fakedb.mjs. The client moves a browser shelf up in
// chunks of 200 and retries a chunk whose answer it never saw, so the cases
// that matter most are the ones near the cap and the ones that arrive twice.

import { createFakeDb } from './support/fakedb.mjs';
import { mineCore, removeEntryCore, updateEntryCore, upsertEntriesCore } from '../convex/lib/shelfCore.ts';
import { CALL_MAX, LIMITS, MAX_ENTRIES, RATE_PRUNE_MAX } from '../convex/lib/limits.ts';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

const T0 = Date.UTC(2026, 8, 11, 12, 0, 0);
const ALICE = 'user_alice';
const BOB = 'user_bob';
const x = (n) => 'x'.repeat(n);
const book = (id, over = {}) => ({ key: 'tf' + id, catalogId: id, shelf: null, note: null, listedAs: null, added: null, ...over });
const own = (slug, title) => ({ key: 'own-' + slug, catalogId: null, record: { title } });
const upsert = (db, subject, entries, now = T0, fillEmpty) =>
  upsertEntriesCore(db, subject, fillEmpty === undefined ? { entries } : { entries, fillEmpty }, now);
const entryFor = (db, subject, key) => db.rows('entries').find((r) => r.clerkSubject === subject && r.key === key) || null;
const metaCount = (db, subject) => { const m = db.rows('shelfMeta').find((r) => r.clerkSubject === subject); return m ? m.count : null; };

// ── Adding books ────────────────────────────────────────────────────────────
{
  const db = createFakeDb();
  const result = await upsert(db, ALICE, [book(1, { shelf: 'Nova', note: 'firmado', listedAs: 'Dune I', added: '2026-09-01' }), own('a1', 'Un libro')]);
  eq(result, { ok: true, added: 2, skipped: 0, filled: 0, total: 2 }, 'two new books are added');
  const rows = db.rows('entries');
  eq(rows.map((r) => r.clerkSubject), [ALICE, ALICE], 'every row belongs to the subject the handler passed');
  eq(rows[0].record, null, 'a catalogue book stores no record');
  eq(rows[1].record, { title: 'Un libro', authors: [], year: null, pages: null, publisher: null, collection: null, dimensions: null, cover_custom: null, spine_custom: null },
    'a book added by hand stores the rebuilt record');
  eq(metaCount(db, ALICE), 2, 'shelfMeta counts both in the same call');
}

// ── Duplicates and existing keys ────────────────────────────────────────────
{
  const db = createFakeDb();
  eq(await upsert(db, ALICE, [book(1, { note: 'first' }), book(1, { note: 'second' })]),
    { ok: true, added: 1, skipped: 1, filled: 0, total: 1 }, 'a key twice in one call is added once and the second counted as skipped');
  eq(entryFor(db, ALICE, 'tf1').note, 'first', 'the first occurrence wins');
  eq(await upsert(db, ALICE, [book(1, { note: 'third' }), book(2)]),
    { ok: true, added: 1, skipped: 1, filled: 0, total: 2 }, 'an existing key is skipped, a new one added');
  eq(entryFor(db, ALICE, 'tf1').note, 'first', 'skipping never overwrites what the account has');
}

// ── fillEmpty ───────────────────────────────────────────────────────────────
{
  const db = createFakeDb();
  await upsert(db, ALICE, [book(1, { shelf: 'Nova' })]);
  const richer = book(1, { shelf: 'B de Bolsillo', note: 'dedicado', listedAs: 'Dune', added: '2026-01-02' });
  eq(await upsert(db, ALICE, [richer], T0, true), { ok: true, added: 0, skipped: 0, filled: 1, total: 1 },
    'fillEmpty fills an existing row');
  const row = entryFor(db, ALICE, 'tf1');
  eq([row.shelf, row.note, row.listedAs, row.added], ['Nova', 'dedicado', 'Dune', '2026-01-02'],
    'only the null fields are filled; the shelf label the account had is kept');
  eq(await upsert(db, ALICE, [richer], T0, true), { ok: true, added: 0, skipped: 1, filled: 0, total: 1 },
    'with nothing left to fill, the row counts as skipped');
  await upsert(db, ALICE, [book(1, { note: 'other' })]);
  eq(entryFor(db, ALICE, 'tf1').note, 'dedicado', 'without fillEmpty an existing row is left alone');
}

// ── Call size and invalid entries ───────────────────────────────────────────
{
  const db = createFakeDb();
  const many = Array.from({ length: CALL_MAX + 1 }, (_, i) => book(i + 1));
  const tooMany = await upsert(db, ALICE, many);
  eq([tooMany.ok, tooMany.code], [false, 'too-many-in-call'], `${CALL_MAX + 1} entries in one call are refused`);
  eq(db.count('entries'), 0, 'and nothing from that call is written');
  eq((await upsert(db, ALICE, many.slice(0, CALL_MAX))).added, CALL_MAX, `${CALL_MAX} are accepted`);

  const clean = createFakeDb();
  const invalid = await upsert(clean, ALICE, [book(1), { ...book(2), key: 'tf3' }]);
  eq([invalid.code, invalid.index, typeof invalid.reason], ['invalid-entry', 1, 'string'], 'an invalid entry refuses the call, naming its index and reason');
  eq(clean.count('entries'), 0, 'the valid entry before it was not written either');
  const hostile = await upsert(clean, ALICE, [{ key: 'own-x1', catalogId: null, record: { title: 'X', id: '"><img src=x onerror=alert(1)>' } }]);
  eq([hostile.code, hostile.index], ['invalid-entry', 0], 'a record carrying a hostile id is refused');
}

// ── The cap, and a chunk that arrives twice ─────────────────────────────────
{
  const db = createFakeDb();
  const chunk = (c) => Array.from({ length: CALL_MAX }, (_, i) => book(c * CALL_MAX + i + 1));
  let accepted = 0;
  for (let c = 0; c < MAX_ENTRIES / CALL_MAX; c++) {
    const result = await upsert(db, ALICE, chunk(c), T0 + c);
    if (result.ok) accepted += result.added;
  }
  eq([accepted, metaCount(db, ALICE)], [MAX_ENTRIES, MAX_ENTRIES], `ten chunks fill the shelf to ${MAX_ENTRIES}`);

  const lastChunk = chunk(MAX_ENTRIES / CALL_MAX - 1);
  eq(await upsert(db, ALICE, lastChunk, T0 + 20), { ok: true, added: 0, skipped: CALL_MAX, filled: 0, total: MAX_ENTRIES },
    'a retried chunk that already committed is ok at the cap, every key skipped');

  const full = await upsert(db, ALICE, [book(5001)], T0 + 21);
  eq([full.code, full.max, full.count], ['shelf-full', MAX_ENTRIES, MAX_ENTRIES], 'one book past the cap is refused with max and count');
  eq(db.count('entries'), MAX_ENTRIES, 'and not written');

  await removeEntryCore(db, ALICE, { key: 'tf1' }, T0 + 22);
  eq(await upsert(db, ALICE, [book(2), book(3), book(5001)], T0 + 23), { ok: true, added: 1, skipped: 2, filled: 0, total: MAX_ENTRIES },
    'with one slot free, only the new key counts against the cap');
  const two = await upsert(db, ALICE, [book(5002), book(5003)], T0 + 24);
  eq([two.code, two.count], ['shelf-full', MAX_ENTRIES], 'and the next new keys are refused again');
}

// ── updateEntry ─────────────────────────────────────────────────────────────
{
  const db = createFakeDb();
  await upsert(db, ALICE, [book(1, { shelf: 'Nova', note: 'firmado' })]);
  eq(await updateEntryCore(db, ALICE, { key: 'tf1', shelf: '  Estante 2  ' }, T0), { ok: true }, 'a shelf label is updated');
  const row = entryFor(db, ALICE, 'tf1');
  eq([row.shelf, row.note], ['Estante 2', 'firmado'], 'trimmed, and the note it was not given is left alone');
  eq(await updateEntryCore(db, ALICE, { key: 'tf1', shelf: null, note: null }, T0), { ok: true }, 'null is accepted for both');
  const cleared = entryFor(db, ALICE, 'tf1');
  eq([cleared.shelf, cleared.note], [null, null], 'and null clears both');
  eq((await updateEntryCore(db, ALICE, { key: 'tf9', note: 'x' }, T0)).code, 'not-found', 'a key not on the shelf is not-found');
  eq((await updateEntryCore(db, ALICE, { key: 'tf1', shelf: x(81) }, T0)).code, 'invalid-entry', 'an 81-character label is refused');
  eq((await updateEntryCore(db, ALICE, { key: 'tf1', note: x(1001) }, T0)).code, 'invalid-entry', 'a 1001-character note is refused');
  await updateEntryCore(db, ALICE, { key: 'tf1', note: 'algo' }, T0);
  eq((await updateEntryCore(db, BOB, { key: 'tf1', note: 'mine now' }, T0)).code, 'not-found', "another subject cannot reach Alice's row");
  eq(entryFor(db, ALICE, 'tf1').note, 'algo', "and Alice's note is unchanged");
}

// ── removeEntry ─────────────────────────────────────────────────────────────
{
  const db = createFakeDb();
  await upsert(db, ALICE, [book(1), book(2)]);
  await upsert(db, BOB, [book(2)]);
  eq(await removeEntryCore(db, ALICE, { key: 'tf1' }, T0), { ok: true, removed: true }, 'a book is removed');
  eq(metaCount(db, ALICE), 1, 'and the count goes down with it');
  eq(await removeEntryCore(db, ALICE, { key: 'tf1' }, T0), { ok: true, removed: false }, 'removing it again is ok, removed false');
  eq(metaCount(db, ALICE), 1, 'without touching the count');
  eq(await removeEntryCore(db, BOB, { key: 'tf1' }, T0), { ok: true, removed: false }, "Bob removing a key only Alice has removes nothing");
  await removeEntryCore(db, BOB, { key: 'tf2' }, T0);
  eq(entryFor(db, ALICE, 'tf2') !== null, true, "and Bob removing his own tf2 leaves Alice's");
}

// ── Erasing comes before everything ─────────────────────────────────────────
{
  const db = createFakeDb();
  await upsert(db, ALICE, [book(1)]);
  await db.insert('erasures', { clerkSubject: ALICE, at: T0 });
  const ratesBefore = db.count('rateEvents');
  eq((await upsert(db, ALICE, [book(2)])).code, 'erasing', 'upsertEntries answers erasing');
  eq((await updateEntryCore(db, ALICE, { key: 'tf1', note: 'x' }, T0)).code, 'erasing', 'updateEntry answers erasing');
  eq((await removeEntryCore(db, ALICE, { key: 'tf1' }, T0)).code, 'erasing', 'removeEntry answers erasing');
  eq((await upsert(db, ALICE, Array.from({ length: CALL_MAX + 1 }, (_, i) => book(i + 1)))).code, 'erasing', 'even ahead of too-many-in-call');
  eq(db.count('rateEvents'), ratesBefore, 'before its rate check: no rate event was recorded');
  eq(db.rows('entries').map((r) => [r.key, r.note]), [['tf1', null]], 'and nothing on the shelf changed');
}

// ── Rate limiting ───────────────────────────────────────────────────────────
{
  const db = createFakeDb();
  const { max, windowMs } = LIMITS['shelf.write'];
  let refusedAt = -1;
  for (let i = 0; i < max; i++) {
    const result = await removeEntryCore(db, ALICE, { key: 'tf1' }, T0 + i);
    if (!result.ok) { refusedAt = i; break; }
  }
  eq(refusedAt, -1, `${max} writes in an hour are allowed`);
  const over = await updateEntryCore(db, ALICE, { key: 'tf1', note: 'x' }, T0 + max);
  eq(over.code, 'rate-limited', `write ${max + 1} in the hour is refused`);
  eq(over.retryAfterMs, windowMs - max, 'retryAfterMs is when the oldest write in the window ages out');
  eq(db.rows('rateEvents').every((r) => r.bucket === `${ALICE}|shelf.write`), true, 'the bucket is the subject and the limit name');
  eq(db.count('rateEvents'), max, 'a refused call records nothing');
  eq((await removeEntryCore(db, BOB, { key: 'tf1' }, T0 + max)).ok, true, "Bob's budget is his own");

  const later = T0 + windowMs + max + 1;
  eq((await removeEntryCore(db, ALICE, { key: 'tf1' }, later)).ok, true, 'once the window has passed, writes are allowed again');
  const left = db.rows('rateEvents').filter((r) => r.bucket === `${ALICE}|shelf.write`).length;
  eq(left, max - RATE_PRUNE_MAX + 1, `that call pruned at most ${RATE_PRUNE_MAX} stale rows and recorded its own`);
}

// ── What mine returns ───────────────────────────────────────────────────────
{
  const db = createFakeDb();
  eq(await mineCore(db, null, {}), null, 'no subject, no shelf');
  eq(await mineCore(db, ALICE, {}), { erasing: false, profile: null, entries: [], count: 0, max: MAX_ENTRIES, truncated: false, publishingOpen: false },
    'a new account has an empty shelf and publishing reads closed');
  eq((await mineCore(db, ALICE, { PUBLISHING: 'open' })).publishingOpen, true, 'PUBLISHING=open opens it');
  eq((await mineCore(db, ALICE, { PUBLISHING: 'yes' })).publishingOpen, false, 'nothing but the word open does');

  await upsert(db, ALICE, [book(7, { shelf: 'Nova', note: 'n', listedAs: 'l', added: '2026-09-01' }), own('b2', 'Mío')]);
  const mine = await mineCore(db, ALICE, {});
  eq(mine.entries[0], { key: 'tf7', id: 7, shelf: 'Nova', note: 'n', listedAs: 'l', added: '2026-09-01', record: null },
    'a private entry carries its owner fields under id, and no database fields');
  eq(mine.entries.map((e) => Object.keys(e)), [['key', 'id', 'shelf', 'note', 'listedAs', 'added', 'record'], ['key', 'id', 'shelf', 'note', 'listedAs', 'added', 'record']],
    'every private entry has exactly these keys');
  eq([mine.count, mine.truncated], [2, false], 'count comes from shelfMeta');

  await db.insert('profiles', { clerkSubject: ALICE, handle: 'alice', published: true, suspendedAt: null, createdAt: T0, updatedAt: T0 });
  eq((await mineCore(db, ALICE, {})).profile, { handle: 'alice', published: true, suspended: false }, 'the profile is handle, published and suspended');
  await db.insert('suspendedSubjects', { clerkSubject: ALICE, since: T0 });
  eq((await mineCore(db, ALICE, {})).profile.suspended, true, 'a suspension shows on the owner\'s own shelf');
  eq((await mineCore(db, BOB, {})).entries, [], "Bob's mine returns none of Alice's books");

  const big = createFakeDb();
  for (let i = 1; i <= MAX_ENTRIES + 1; i++) {
    await big.insert('entries', { clerkSubject: ALICE, key: 'tf' + i, catalogId: i, shelf: null, note: null, listedAs: null, added: null, record: null, updatedAt: T0 });
  }
  await big.insert('shelfMeta', { clerkSubject: ALICE, count: MAX_ENTRIES + 1 });
  const truncated = await mineCore(big, ALICE, {});
  eq([truncated.entries.length, truncated.truncated, truncated.count], [MAX_ENTRIES, true, MAX_ENTRIES + 1],
    'a shelf past the cap returns the cap and says it was truncated');

  await big.insert('erasures', { clerkSubject: ALICE, at: T0 });
  eq(await mineCore(big, ALICE, {}), { erasing: true, remaining: MAX_ENTRIES + 1 }, 'while erasing, mine says only how many books are left');
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
