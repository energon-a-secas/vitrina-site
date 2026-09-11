// Plain node, no install. Run with: make validate
//
// Handles, publishing, the public projection and erasure, through
// convex/lib/profilesCore.ts and adminCore.ts over tests/support/fakedb.mjs.
//
// The projection is the privacy boundary of the whole feature, so it is tested
// two ways: every returned object is scanned recursively for keys that must
// never leave the database, and the fake database's query log proves a refusal
// never read the entries table at all.

import { createFakeDb } from './support/fakedb.mjs';
import {
  byHandleCore, claimHandleCore, deleteMyDataCore, projectShelf, removeProfileCore, setPublishedCore,
} from '../convex/lib/profilesCore.ts';
import { upsertEntriesCore } from '../convex/lib/shelfCore.ts';
import { purgeByHandleCore, releaseHandleCore, setSuspendedCore } from '../convex/lib/adminCore.ts';
import { clerkWebhookCore } from '../convex/lib/clerkWebhookCore.ts';
import { verifySvixSignature } from '../convex/lib/webhookVerify.ts';
import { HANDLE_MESSAGES } from '../convex/lib/handles.ts';
import { HOLD_MS, LIMITS } from '../convex/lib/limits.ts';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 11, 12, 0, 0);
const OPEN = { PUBLISHING: 'open' };
const [ALICE, BOB, CAROL, DAVE, EVE, FRAN, GRACE, HAL, JUNE, KIM] =
  ['alice', 'bob', 'carol', 'dave', 'eve', 'fran', 'grace', 'hal', 'june', 'kim'].map((n) => 'user_' + n);

const claim = (db, subject, handle, now = T0) => claimHandleCore(db, subject, { handle }, now);
const publish = (db, subject, published, confirmAge, now = T0, env = OPEN) =>
  setPublishedCore(db, subject, confirmAge === undefined ? { published } : { published, confirmAge }, now, env);
const book = (id, over = {}) => ({ key: 'tf' + id, catalogId: id, shelf: null, note: null, listedAs: null, added: null, ...over });
const own = (slug, title) => ({ key: 'own-' + slug, catalogId: null, record: { title, authors: ['Alguien'] } });
const profileOf = (db, subject) => db.rows('profiles').find((p) => p.clerkSubject === subject) || null;
const bucketRows = (db, bucket) => db.rows('rateEvents').filter((r) => r.bucket === bucket).length;
const heldRow = (db, handle) => db.rows('heldHandles').find((h) => h.handle === handle) || null;

const FORBIDDEN = ['clerkSubject', 'subject', '_id', '_creationTime', 'note', 'listedAs', 'added', 'record', 'updatedAt', 'createdAt', 'email'];
function forbiddenKeys(value, path = '$', found = []) {
  if (Array.isArray(value)) value.forEach((item, i) => forbiddenKeys(item, `${path}[${i}]`, found));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN.includes(key)) found.push(`${path}.${key}`);
      forbiddenKeys(item, `${path}.${key}`, found);
    }
  }
  return found;
}
const returned = [];   // every non-null byHandle answer, scanned at the end

// ── Claiming ────────────────────────────────────────────────────────────────
{
  const db = createFakeDb();
  eq(await claim(db, ALICE, '  @Alice '), { ok: true, handle: 'alice' }, 'a first claim creates the profile under the canonical handle');
  const p = profileOf(db, ALICE);
  eq([p.handle, p.published, p.suspendedAt], ['alice', false, null], 'a new profile starts private and unsuspended');
  eq((await claim(db, ALICE, 'ALICE')).code, 'same-handle', 'claiming your own handle again is same-handle');
  const taken = await claim(db, BOB, 'Alice');
  eq(taken.code, 'handle-taken', "somebody else's handle is taken, whatever its case");
  const invalid = await claim(db, BOB, 'ab');
  eq([invalid.code, invalid.message], ['handle-invalid', HANDLE_MESSAGES['handle-invalid']], 'an invalid handle says what a handle may be');
  eq((await claim(db, BOB, 'vitrina-team')).code, 'handle-reserved', 'a reserved handle is refused');
  eq(await claim(db, BOB, 'bob'), { ok: true, handle: 'bob' }, 'Bob claims his own');

  // Changes: three per 30 days, counted only when they happen.
  await db.patch('profiles', profileOf(db, ALICE)._id, { published: true });
  eq(await claim(db, ALICE, 'alice-2', T0 + 1), { ok: true, handle: 'alice-2' }, 'a first change succeeds');
  eq(heldRow(db, 'alice').until, T0 + 1 + HOLD_MS, 'and holds the old handle for 30 days');
  eq(profileOf(db, ALICE).published, true, 'a change keeps the shelf published');
  const takenByBob = await claim(db, ALICE, 'bob', T0 + 2);
  eq(takenByBob.code, 'handle-taken', "changing to Bob's handle is taken");
  const held = await claim(db, ALICE, 'alice', T0 + 3);
  eq(held.code, 'handle-taken', 'changing back to your own held handle is taken too');
  eq(held.message, takenByBob.message, 'taken and held give one message, so a hold cannot be told from a live shelf');
  eq(await claim(db, ALICE, 'alice-3', T0 + 4), { ok: true, handle: 'alice-3' }, 'a second change succeeds: the two refused attempts cost nothing');
  eq(await claim(db, ALICE, 'alice-4', T0 + 5), { ok: true, handle: 'alice-4' }, 'so does a third');
  eq(bucketRows(db, `${ALICE}|handle.change`), 3, 'exactly three changes were recorded');
  const fourth = await claim(db, ALICE, 'alice-5', T0 + 6);
  eq(fourth.code, 'rate-limited', 'a fourth change within 30 days is refused');
  eq(profileOf(db, ALICE).handle, 'alice-4', 'and the handle did not move');
  eq(heldRow(db, 'alice-4'), null, 'nor was the current handle held');
  eq(db.rows('heldHandles').map((h) => h.handle).sort(), ['alice', 'alice-2', 'alice-3'], 'each changed-away handle is held once');

  const monthLater = T0 + LIMITS['handle.change'].windowMs + 10;
  eq(await claim(db, ALICE, 'alice-5', monthLater), { ok: true, handle: 'alice-5' }, 'after 30 days a change is allowed again');

  // An expired hold is cleared by the claim that finds it.
  const afterHold = T0 + 1 + HOLD_MS + 1;
  eq(await claim(db, HAL, 'alice', afterHold), { ok: true, handle: 'alice' }, 'a handle is free once its hold has expired');
  eq(heldRow(db, 'alice'), null, 'and the expired hold row was deleted in that claim');

  // A suspended subject.
  await db.insert('suspendedSubjects', { clerkSubject: CAROL, since: T0 });
  eq((await claim(db, CAROL, 'carol')).code, 'suspended', 'a suspended subject cannot claim');
  eq(bucketRows(db, `${CAROL}|handle.claim`), 0, 'and is refused before the claim limit records anything');

  // Erasing comes first.
  await db.insert('erasures', { clerkSubject: KIM, at: T0 });
  await db.insert('suspendedSubjects', { clerkSubject: KIM, since: T0 });
  eq((await claim(db, KIM, 'kim')).code, 'erasing', 'erasing is answered before suspended');

  // The claim limit.
  const fresh = createFakeDb();
  const { max } = LIMITS['handle.claim'];
  for (let i = 0; i < max; i++) await claim(fresh, DAVE, 'ab', T0 + i);
  eq((await claim(fresh, DAVE, 'dave', T0 + max)).code, 'rate-limited', `claim attempt ${max + 1} in an hour is refused, even for a valid handle`);
}

// ── setPublished: the order of its checks ───────────────────────────────────
{
  const db = createFakeDb();
  const publishBucket = (subject) => `${subject}|profile.publish`;

  eq((await publish(db, EVE, true, true)).code, 'no-handle', 'no profile means nothing to publish');
  for (let i = 1; i < LIMITS['profile.publish'].max; i++) await publish(db, EVE, true, true, T0 + i);
  eq((await publish(db, EVE, true, true, T0 + 100)).code, 'rate-limited', 'the publish limit is checked before no-handle');
  await db.insert('suspendedSubjects', { clerkSubject: EVE, since: T0 });
  eq((await publish(db, EVE, true, true, T0 + 101)).code, 'suspended', 'suspended is checked before the limit');
  await db.insert('erasures', { clerkSubject: EVE, at: T0 });
  eq((await publish(db, EVE, true, true, T0 + 102)).code, 'erasing', 'erasing is checked before suspended');
  const before = bucketRows(db, publishBucket(EVE));
  await publish(db, EVE, true, true, T0 + 103);
  eq(bucketRows(db, publishBucket(EVE)), before, 'and records no rate event');

  eq((await publish(db, FRAN, true, true, T0, {})).code, 'no-handle', 'no-handle is checked before publishing-closed');
  await claim(db, DAVE, 'dave');
  eq((await publish(db, DAVE, true, false, T0, {})).code, 'publishing-closed', 'publishing-closed is checked before the age statement');
  eq((await publish(db, DAVE, true, undefined, T0, { PUBLISHING: 'opened' })).code, 'publishing-closed', 'only PUBLISHING=open opens it');
  eq((await publish(db, DAVE, true, undefined)).code, 'age-confirmation-required', 'with publishing open, the age statement is required');
  eq((await publish(db, DAVE, true, 'yes')).code, 'age-confirmation-required', 'and it must be exactly true');
  eq(await publish(db, DAVE, true, true), { ok: true, published: true }, 'with all of it, the shelf is published');
  eq(profileOf(db, DAVE).published, true, 'and stored as published');

  await db.patch('profiles', profileOf(db, DAVE)._id, { suspendedAt: T0 });
  eq((await publish(db, DAVE, true, true)).code, 'suspended', 'a profile suspendedAt also refuses publishing');
  eq(await publish(db, DAVE, false, undefined, T0, {}), { ok: true, published: false }, 'but going private always succeeds: suspended and closed');
  eq(profileOf(db, DAVE).published, false, 'and is stored');
  for (let i = 0; i < LIMITS['profile.publish'].max + 1; i++) await publish(db, DAVE, true, true, T0 + 200 + i);
  eq(await publish(db, DAVE, false, undefined, T0 + 300), { ok: true, published: false }, 'rate limited too');
  eq((await publish(db, GRACE, false)).code, 'no-handle', 'going private without a profile is no-handle');
}

// ── byHandle: the public projection ─────────────────────────────────────────
{
  const db = createFakeDb();
  await claim(db, ALICE, 'alice');
  await upsertEntriesCore(db, ALICE, {
    entries: [book(1, { shelf: 'Nova', note: 'firmado por el autor', listedAs: 'Dune I', added: '2026-09-01' }), own('x1', 'Hecho a mano'), book(2)],
  }, T0);
  await publish(db, ALICE, true, true);

  const assertNoEntriesRead = async (viewer, handle, env, what) => {
    db.clearLog();
    eq(await byHandleCore(db, viewer, handle, env), null, what);
    eq(db.queried('entries'), false, `${what}, without reading entries`);
  };

  const visible = { handle: 'alice', books: [{ id: 1, shelf: 'Nova' }, { id: 2, shelf: null }] };
  db.clearLog();
  const stranger = await byHandleCore(db, BOB, 'alice', OPEN);
  eq(stranger, visible, 'a stranger sees the handle and catalogue books with their shelf labels, nothing else');
  eq(db.log.filter((q) => q.table === 'entries').map((q) => q.index), ['by_owner'], 'entries are read once, by_owner');
  returned.push(stranger);
  const anonymous = await byHandleCore(db, null, 'alice', OPEN);
  eq(anonymous, visible, 'so does a signed-out visitor');
  returned.push(anonymous);
  const owner = await byHandleCore(db, ALICE, 'alice', OPEN);
  eq(owner, { ...visible, isOwner: true, published: true, suspended: false, publishingOpen: true }, 'the owner sees the same books plus the owner view');
  returned.push(owner);

  await assertNoEntriesRead(BOB, 'nobody', OPEN, 'a handle nobody holds is null');
  for (const [handle, what] of [['Alice', 'uppercase'], [' alice', 'a leading space'], ['@alice', 'a leading @'], ['alice ', 'a trailing space'],
    ['ab', 'an invalid handle'], ['admin', 'a reserved handle'], [42, 'a number'], [null, 'null'], [{ handle: 'alice' }, 'an object']]) {
    db.clearLog();
    eq(await byHandleCore(db, BOB, handle, OPEN), null, `a non-canonical request (${what}) is null`);
    eq(db.log.length, 0, `and ${what} reads nothing at all`);
  }

  await db.patch('profiles', profileOf(db, ALICE)._id, { published: false });
  await assertNoEntriesRead(BOB, 'alice', OPEN, 'a private shelf is null for a stranger');
  const privateOwner = await byHandleCore(db, ALICE, 'alice', OPEN);
  eq([privateOwner.isOwner, privateOwner.published], [true, false], 'while its owner still sees it, marked private');
  returned.push(privateOwner);
  await db.patch('profiles', profileOf(db, ALICE)._id, { published: true });

  await assertNoEntriesRead(BOB, 'alice', {}, 'a published shelf is null for a stranger while publishing is closed');
  const closedOwner = await byHandleCore(db, ALICE, 'alice', {});
  eq([closedOwner.isOwner, closedOwner.publishingOpen], [true, false], 'and its owner sees that publishing is closed');
  returned.push(closedOwner);

  await db.patch('profiles', profileOf(db, ALICE)._id, { suspendedAt: T0 });
  await assertNoEntriesRead(BOB, 'alice', OPEN, 'a suspended shelf is null for a stranger');
  const suspendedOwner = await byHandleCore(db, ALICE, 'alice', OPEN);
  eq(suspendedOwner.suspended, true, 'and its owner sees the suspension');
  returned.push(suspendedOwner);
  await db.patch('profiles', profileOf(db, ALICE)._id, { suspendedAt: null });
  await db.insert('suspendedSubjects', { clerkSubject: ALICE, since: T0 });
  await assertNoEntriesRead(BOB, 'alice', OPEN, 'a suspended subject is null for a stranger even without suspendedAt');

  const handMade = createFakeDb();
  await claim(handMade, GRACE, 'grace');
  await upsertEntriesCore(handMade, GRACE, { entries: [own('g1', 'Mi libro'), own('g2', 'Otro')] }, T0);
  await publish(handMade, GRACE, true, true);
  const onlyHandMade = await byHandleCore(handMade, BOB, 'grace', OPEN);
  eq(onlyHandMade, { handle: 'grace', books: [] }, 'a published shelf of only hand-added books shows no books');
  returned.push(onlyHandMade);

  // projectShelf builds field by field, whatever the rows carry.
  const leaky = projectShelf(
    { handle: 'h', published: true, suspendedAt: null, clerkSubject: 'user_x', email: 'x@example.org', createdAt: 1 },
    [{ _id: 'entries:1', _creationTime: 1, clerkSubject: 'user_x', key: 'tf1', catalogId: 1, shelf: 's', note: 'n', listedAs: 'l', added: 'a', record: { title: 't' }, updatedAt: 1 }],
    { isOwner: true, publishingOpen: true },
  );
  eq(leaky, { handle: 'h', books: [{ id: 1, shelf: 's' }], isOwner: true, published: true, suspended: false, publishingOpen: true },
    'projectShelf copies no field it does not name');
  returned.push(leaky);

  eq(returned.map((r) => forbiddenKeys(r)), returned.map(() => []), `none of the ${returned.length} returned shelves holds a forbidden key at any depth`);
}

// ── deleteMyData, and the handle held after each erasure path ───────────────
{
  const db = createFakeDb();
  await claim(db, ALICE, 'alice');
  await upsertEntriesCore(db, ALICE, { entries: [book(1, { shelf: 'Nova' }), book(2)] }, T0);
  await publish(db, ALICE, true, true);

  const T = T0 + HOUR;
  eq(await deleteMyDataCore(db, ALICE, T), { ok: true, status: 'erasing', started: true }, 'deleteMyData starts an erasure and asks for the purge');
  eq(await byHandleCore(db, BOB, 'alice', OPEN), null, 'the shelf is gone for a stranger at once');
  eq(db.rows('entries').filter((e) => e.clerkSubject === ALICE).length, 2, 'while its entries still wait for the purge');
  eq(profileOf(db, ALICE), null, 'the profile is deleted in the same call');
  eq(heldRow(db, 'alice').until, T + HOLD_MS, 'the handle is held for 30 days');
  eq(db.rows('erasures').map((e) => [e.clerkSubject, e.at]), [[ALICE, T]], 'and one erasures row records it');
  eq(await deleteMyDataCore(db, ALICE, T + 1), { ok: true, status: 'erasing', started: false }, 'a second press is ok and starts nothing');
  eq(db.count('erasures'), 1, 'and adds no second row');
  eq((await claim(db, HAL, 'alice', T + 2)).code, 'handle-taken', 'nobody can take the handle while it is held');
  eq((await claim(db, HAL, 'alice', T + HOLD_MS + 1)).ok, true, 'and anybody can after 30 days');

  // The webhook path: a verified user.deleted, then the same removeProfileCore.
  const hook = createFakeDb();
  await claim(hook, JUNE, 'june');
  await publish(hook, JUNE, true, true);
  const secret = 'whsec_' + Buffer.from('vitrina-webhook-test-key-000001').toString('base64');
  const body = JSON.stringify({ type: 'user.deleted', object: 'event', data: { id: JUNE, deleted: true, object: 'user' } });
  const nowSeconds = Math.floor(T / 1000);
  const key = await crypto.subtle.importKey('raw', Buffer.from(secret.slice(6), 'base64'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`msg_1.${nowSeconds}.${body}`));
  const headers = new Headers({ 'svix-id': 'msg_1', 'svix-timestamp': String(nowSeconds), 'svix-signature': 'v1,' + Buffer.from(mac).toString('base64') });
  const verdict = await clerkWebhookCore(body, headers, secret, nowSeconds, verifySvixSignature);
  eq(verdict, { status: 200, purgeSubject: JUNE }, 'the webhook names the deleted Clerk user');
  eq(await removeProfileCore(hook, verdict.purgeSubject, T), { started: true }, 'and eraseSubject starts the same erasure');
  eq(await byHandleCore(hook, BOB, 'june', OPEN), null, 'the shelf is gone');
  eq(heldRow(hook, 'june').until, T + HOLD_MS, 'the handle is held after the webhook path too');
  eq((await claim(hook, KIM, 'june', T + HOLD_MS - 1)).code, 'handle-taken', 'up to the last millisecond of the hold');
  eq((await claim(hook, KIM, 'june', T + HOLD_MS + 1)).ok, true, 'and free after it');
}

// ── Admin ───────────────────────────────────────────────────────────────────
{
  const db = createFakeDb();
  const ADMINS = { ADMIN_SUBJECTS: ' user_admin , user_other ' };
  await claim(db, ALICE, 'alice');
  await upsertEntriesCore(db, ALICE, { entries: [book(1)] }, T0);
  await publish(db, ALICE, true, true);

  for (const [caller, env, what] of [
    [null, ADMINS, 'a signed-out caller'],
    [BOB, ADMINS, 'a signed-in non-admin'],
    ['user_admin', {}, 'anyone while ADMIN_SUBJECTS is unset'],
    ['user_adm', ADMINS, 'a prefix of an admin subject'],
    ['user_admin,user_other', ADMINS, 'a subject containing the separator'],
  ]) {
    db.clearLog();
    eq((await setSuspendedCore(db, caller, { handle: 'alice', suspended: true }, T0, env)).code, 'not-admin', `setSuspended refuses ${what}`);
    eq((await purgeByHandleCore(db, caller, { handle: 'alice' }, T0, env)).code, 'not-admin', `purgeByHandle refuses ${what}`);
    eq((await releaseHandleCore(db, caller, { handle: 'alice' }, T0, env)).code, 'not-admin', `releaseHandle refuses ${what}`);
    eq(db.log.length, 0, `and reads nothing for ${what}`);
  }
  eq([profileOf(db, ALICE).suspendedAt, db.count('suspendedSubjects'), db.count('erasures')], [null, 0, 0], 'none of those refusals changed anything');

  eq(await setSuspendedCore(db, 'user_other', { handle: 'Alice', suspended: true }, T0, ADMINS), { ok: true }, 'an admin suspends by handle');
  eq([profileOf(db, ALICE).suspendedAt, db.rows('suspendedSubjects').map((s) => s.clerkSubject)], [T0, [ALICE]], 'setting suspendedAt and the subject row');
  eq(await byHandleCore(db, BOB, 'alice', OPEN), null, 'the suspended shelf is hidden');
  eq(await setSuspendedCore(db, 'user_admin', { handle: 'alice', suspended: false }, T0, ADMINS), { ok: true }, 'and lifts it');
  eq([profileOf(db, ALICE).suspendedAt, db.count('suspendedSubjects')], [null, 0], 'clearing both');
  eq((await setSuspendedCore(db, 'user_admin', { handle: 'nobody', suspended: true }, T0, ADMINS)).code, 'not-found', 'an unknown handle is not-found');
  eq((await purgeByHandleCore(db, 'user_admin', { handle: 'nobody' }, T0, ADMINS)).code, 'not-found', 'for a purge too');

  eq(await purgeByHandleCore(db, 'user_admin', { handle: 'alice' }, T0, ADMINS), { ok: true, status: 'erasing', started: true, subject: ALICE },
    "a purge erases the handle's owner, not the admin");
  eq([profileOf(db, ALICE), heldRow(db, 'alice') !== null, db.rows('erasures').map((e) => e.clerkSubject)], [null, true, [ALICE]],
    'through the same removeProfileCore: profile gone, handle held, erasure started');

  eq(await releaseHandleCore(db, 'user_admin', { handle: 'alice' }, T0, ADMINS), { ok: true, released: true }, 'releaseHandle lifts a hold');
  eq((await claim(db, BOB, 'alice', T0 + 1)).ok, true, 'so the handle can be claimed today');
  eq(await releaseHandleCore(db, 'user_admin', { handle: 'alice' }, T0, ADMINS), { ok: true, released: false }, 'a handle with no hold releases nothing');
  eq(profileOf(db, BOB).handle, 'alice', 'and a live profile keeps its handle');
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
