// Plain node, no install. Run with: make validate
//
// js/accountplan.js decides what the account, a shared shelf and the Share
// dialog say, and which answer the page believes. None of it fails loudly: a
// toast that names no book still shows, a banner with the wrong precedence
// still renders, an anonymous answer painted over the owner's looks like a
// working page. So each rule is pinned here, with every combination the plan
// names (sections 3.1, 3.6 and 3.7), and a few static checks hold the modules
// that cannot run in node to the parts of the contract a source scan can see.

import { readFileSync } from 'node:fs';
import * as A from '../js/accountplan.js';
import { CALL_MAX, MAX_ENTRIES, MISSING_TITLE, indexById } from '../js/syncplan.js';
import { handleFromSearch } from '../js/handles.js';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}
const rejection = (promise) => promise.then(() => 'resolved', (err) => err.message);
// Every read below that a broken rule could leave missing goes through a guard,
// so the rule fails its own line instead of throwing and ending the run before
// the checks after it have looked at anything.
const settled = (promise) => promise.then((value) => value, (err) => `threw: ${err.message}`);
const keyAt = (outcome, i) => (outcome && Array.isArray(outcome.chunk) && outcome.chunk[i] ? outcome.chunk[i].key : null);

// ── Failure copy, every code ────────────────────────────────────────────────
const fail = (code, extra = {}) => ({ ok: false, code, message: 'from the server', ...extra });
eq(MAX_ENTRIES, 2000, 'the cap the copy names is the account cap');
eq(A.failureCopy(fail('shelf-full', { reason: 'books', max: 2000, count: 2000 }), 'Dune'),
  'Your account shelf holds 2000 books, the most it can. Dune was not added.', 'shelf-full by count names the cap and the book');
eq(A.failureCopy(fail('shelf-full', { reason: 'space' }), 'Dune'),
  'Your account shelf is out of room: its notes and books added by hand use all the space one shelf has. Dune was not saved.',
  'shelf-full for space says it is space, not a number of books');
eq(A.failureCopy(fail('shelf-full'), 'Dune'), 'Your account shelf holds 2000 books, the most it can. Dune was not added.', 'shelf-full with no reason reads as the book cap');
eq(A.failureCopy(fail('rate-limited', { retryAfterMs: 60000 }), 'Dune'), 'Too many changes this hour. Dune was not saved; try again later.', 'rate-limited');
eq(A.failureCopy(fail('invalid-entry', { index: 0, reason: 'note is limited to 1000 characters' }), 'Dune'),
  'Dune could not be saved: note is limited to 1000 characters.', 'invalid-entry carries the reason the server gave');
eq(A.failureCopy(fail('invalid-entry', { reason: 'record.title is required.' }), 'Dune'), 'Dune could not be saved: record.title is required.', 'a reason that already ends in a full stop gets no second one');
eq(A.failureCopy(fail('invalid-entry'), 'Dune'), 'Dune could not be saved: the account refused it.', 'invalid-entry with no reason still reads as a sentence');
eq(A.failureCopy(fail('erasing'), 'Dune'), 'Your Vitrina data is being deleted.', 'erasing');
eq(A.failureCopy(fail('not-signed-in'), 'Dune'), 'That change did not reach your account: Dune.', 'not-signed-in');
eq(A.failureCopy(null, 'Dune'), 'That change did not reach your account: Dune.', 'a thrown request arrives as null and reads the same');
eq([A.failureCopy(fail('not-found'), 'Dune'), A.failureCopy(fail('too-many-in-call'), 'Dune')],
  ['That change did not reach your account: Dune.', 'That change did not reach your account: Dune.'], 'and so does any other code');
eq(A.failureCopy(null, '  '), 'That change did not reach your account: Untitled.', 'a book with no title is Untitled, as the shelf calls it');
const CODES = ['shelf-full', 'rate-limited', 'invalid-entry', 'not-signed-in', 'not-found', 'too-many-in-call'];
eq(CODES.filter((code) => !A.failureCopy(fail(code, { reason: 'space' }), 'A named book').includes('A named book')), [],
  'every code but erasing names the book, shelf-full for space included');

eq([A.keepsUnsaved(fail('rate-limited'), 'add'), A.keepsUnsaved(null, 'add'), A.keepsUnsaved(fail('shelf-full', { reason: 'space' }), 'update')],
  [true, true, true], 'a failed add or note edit stays as not saved, with Try again');
eq([A.keepsUnsaved(fail('erasing'), 'add'), A.keepsUnsaved(fail('erasing'), 'update')], [false, false], 'but not while the account is being erased');
eq([A.keepsUnsaved(fail('not-found'), 'update'), A.keepsUnsaved(fail('not-found'), 'add')], [false, true], 'nor a note for a book the account no longer has');

eq(A.notReadyCopy('account-loading', null), 'Your account shelf is still loading, so nothing changed. Try again in a moment.', 'an edit refused while loading');
eq(A.notReadyCopy('account-error', null), 'Your account shelf could not be loaded, so nothing changed. Use Try again above the shelf.', 'and after a failed load');
eq(A.notReadyCopy('account-loading', { remaining: 3 }), 'Your Vitrina data is being deleted.', 'and while the data is being deleted');

eq(A.batchToast('import', { added: 12, skipped: 3 }), 'Added 12 books to your account. 3 were already on it.', 'an import toast is built from the totals');
eq(A.batchToast('import', { added: 1, skipped: 1 }), 'Added 1 book to your account. 1 was already on it.', 'in the singular too');
eq(A.batchToast('import', { added: 0, skipped: 5 }), 'Your account already has every book in that file.', 'and says so when nothing was new');
eq(A.batchToast('seed', { added: 39 }), 'Added 39 books from the demo shelf to your account. Take off what you do not own.', 'the demo seed');
eq(A.batchToast('seed', { added: 0 }), 'Your account already has every book on the demo shelf.', 'a seed with nothing new');
eq(A.batchToast('fill', { filled: 2 }), 'Filled in notes or labels on 2 books.', 'a fill');
eq([A.batchToast('add', { added: 1 }), A.batchToast('retry', { added: 1 })], [null, null], 'a single add said so when it was made, so it says nothing more');

eq([A.listTitles([]), A.listTitles(['A']), A.listTitles(['A', 'B']), A.listTitles(['A', 'B', 'C']), A.listTitles(['A', 'B', 'C', 'D', 'E'])],
  ['', 'A', 'A and B', 'A, B and C', 'A, B, C and 2 more'], 'a list of titles stays one line');

const shelfA = [{ key: 'tf1', shelf: 'Nova', note: null, record: { title: 'x' } }, { key: 'tf2', shelf: 'VIB', note: 'mine' }];
eq(A.shelfSignature(shelfA) === A.shelfSignature(shelfA.slice().reverse()), true, 'the same books in another order are the same shelf');
eq(A.shelfSignature(shelfA) === A.shelfSignature([shelfA[0], { ...shelfA[1], note: 'changed elsewhere' }]), false, 'a note changed on another device is a change');
eq(A.shelfSignature(shelfA) === A.shelfSignature([{ ...shelfA[0], record: { title: 'rebuilt' } }, shelfA[1]]), true, 'a record rebuilt from the catalogue is not');

// ── Uploading in chunks ─────────────────────────────────────────────────────
eq(CALL_MAX, 200, 'chunks are the 200 one call takes');
eq([A.chunked(Array(401).fill(0)).map((c) => c.length), A.chunked([]), A.chunked([1, 2, 3], 0).map((c) => c.length)],
  [[200, 200, 1], [], [3]], 'chunked cuts at CALL_MAX, and a size that is not a positive integer means CALL_MAX');

const rows = Array.from({ length: 401 }, (_, i) => ({ key: `tf${i + 1}` }));
const took = (chunk) => ({ ok: true, added: chunk.length - 1, skipped: 1, filled: 0, total: 1000 });
let generation = 1;
const sizes = [];
const recorded = [];
const complete = await A.uploadInChunks(rows, {
  generation: () => generation,
  send: async (chunk) => { sizes.push(chunk.length); return took(chunk); },
  onChunk: (chunk) => recorded.push(chunk[0].key),
});
eq([complete.status, sizes, complete.sent, recorded], ['done', [200, 200, 1], 401, ['tf1', 'tf201', 'tf401']],
  '401 books go as 200, 200 and 1, each recorded once the account took it');
eq(complete.totals, { added: 398, skipped: 3, filled: 0, total: 1000 }, 'and the totals are summed over the chunks');

const between = [];
const stopped = await A.uploadInChunks(rows, {
  generation: () => generation,
  send: async (chunk) => { between.push(chunk[0].key); return took(chunk); },
  onChunk: () => { generation = 2; },
});
eq([stopped.status, between, stopped.sent], ['stale', ['tf1'], 200], 'the generation is read before each chunk: a sign-out after the first stops the second going out');

generation = 1;
const late = [];
const midway = await A.uploadInChunks(rows, {
  generation: () => generation,
  send: async (chunk) => { generation = 3; return took(chunk); },
  onChunk: (chunk) => late.push(chunk[0].key),
});
eq([midway.status, midway.sent, late], ['stale', 0, []], 'an answer that lands after the shelf changed hands is neither counted nor recorded');

generation = 1;
let calls = 0;
const erasing = await A.uploadInChunks(rows, {
  generation: () => generation,
  send: async (chunk) => (++calls === 2 ? fail('erasing') : took(chunk)),
});
eq([erasing.status, calls, erasing.sent, erasing.totals.added, keyAt(erasing, 0)], ['erasing', 2, 200, 199, 'tf201'],
  'erasing stops the upload, and the third chunk never goes out');

const invalid = await A.uploadInChunks(rows.slice(0, 10), { generation: () => 1, send: async () => fail('invalid-entry', { index: 5, reason: 'x' }) });
eq([invalid.status, A.failedIndex(invalid), keyAt(invalid, A.failedIndex(invalid))], ['failed', 5, 'tf6'], 'invalid-entry names the book it points at');
const thrown = await A.uploadInChunks(rows.slice(0, 3), { generation: () => 1, send: async () => { throw new Error('offline'); } });
eq([thrown.status, thrown.failure, A.failedIndex(thrown)], ['failed', null, 0], 'a thrown chunk fails, naming its first book');
eq(A.failedIndex({ chunk: [{}, {}], failure: fail('invalid-entry', { index: 99 }) }), 0, 'an index outside the chunk names its first book too');
let none = 0;
const nothing = await A.uploadInChunks([], { generation: () => 1, send: async () => { none += 1; } });
eq([nothing.status, none], ['done', 0], 'nothing to send sends nothing');

// ── Strip counts ────────────────────────────────────────────────────────────
const browser = [
  { key: 'tf1', note: 'from the flea market', shelf: 'Nova' },
  { key: 'tf2', note: 'signed copy', shelf: 'Nova' },
  { key: 'tf3', note: null, shelf: 'VIB' },
  { key: 'own-hand-1', note: null, shelf: 'Hand' },
  { key: 'tf4', note: null, shelf: null },
];
const account = [
  { key: 'tf2', note: null, shelf: 'Nova' },
  { key: 'tf3', note: 'kept', shelf: null },
  { key: 'tf9', note: null, shelf: null },
];
const counted = A.stripCounts(browser, account, []) || {};
eq(counted.missing, ['tf1', 'own-hand-1', 'tf4'], 'N counts the browser books the account lacks');
eq((counted.fill || []).map((e) => e.key), ['tf2', 'tf3'], 'M counts shared books whose account copy lacks a note or a label this browser has');
eq(A.stripCounts(browser, account, ['tf1', 'own-hand-1']).missing, ['tf4'], 'a moved key is not offered again, although the account no longer has it');
eq(A.stripCounts(browser, [...account, { key: 'tf1', note: 'x', shelf: 'y' }, { key: 'own-hand-1', shelf: 'Hand' }, { key: 'tf4' }], []).missing, [],
  'once the account has every book, N is 0');
eq(A.stripCounts([], account, ['tf2']), { missing: [], fill: [] }, 'an empty browser shelf offers nothing');

// ── Authenticated requests ──────────────────────────────────────────────────
function fakeKit({ cached = 'cached-token', fresh = 'fresh-token', session = true } = {}) {
  const log = [];
  return {
    log,
    convexToken: async () => { log.push(['convexToken']); if (cached instanceof Error) throw cached; return cached; },
    state: { clerk: session ? { session: { getToken: async (options) => { log.push(['getToken', options]); return fresh; } } } : null },
  };
}
function fakeClient(answers) {
  const log = [];
  let i = 0;
  const next = async (kind, name) => {
    log.push([kind, name]);
    const answer = answers[i++];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return {
    log,
    setAuth: (token) => log.push(['setAuth', token]),
    clearAuth: () => log.push(['clearAuth']),
    query: (name) => next('query', name),
    mutation: (name) => next('mutation', name),
  };
}

let kit = fakeKit();
let client = fakeClient([{ ok: true }]);
eq(await settled(A.authedCall(async () => client, kit)('query', 'shelf:mine', {})), { ok: true }, 'a request resolves its answer');
eq([client.log, kit.log], [[['setAuth', 'cached-token'], ['query', 'shelf:mine']], [['convexToken']]], 'with the kit token set before it, queries included');

kit = fakeKit();
client = fakeClient([new Error('401'), { ok: true, removed: true }]);
eq(await settled(A.authedCall(async () => client, kit)('mutation', 'shelf:removeEntry', { key: 'tf1' })), { ok: true, removed: true }, 'a request that throws is retried once');
eq(client.log, [['setAuth', 'cached-token'], ['mutation', 'shelf:removeEntry'], ['setAuth', 'fresh-token'], ['mutation', 'shelf:removeEntry']],
  'with a fresh token set before the retry');
eq(kit.log.filter((entry) => entry[0] === 'getToken'), [['getToken', { template: 'convex', skipCache: true }]], 'minted once, from the convex template, past the cache');

kit = fakeKit();
client = fakeClient([new Error('first'), new Error('second')]);
eq(await rejection(A.authedCall(async () => client, kit)('query', 'shelf:mine', {})), 'second', 'a second failure throws to the caller');
eq([client.log.filter((entry) => entry[0] === 'query').length, kit.log.filter((entry) => entry[0] === 'getToken').length], [2, 1], 'after two requests and one mint');

kit = fakeKit({ cached: null });
client = fakeClient([null]);
await settled(A.authedCall(async () => client, kit)('query', 'shelf:mine', {}));
eq(client.log, [['clearAuth'], ['query', 'shelf:mine']], 'with no session the client drops any token it held rather than sending a stale one');

kit = fakeKit({ session: false });
client = fakeClient([new Error('offline')]);
eq([await rejection(A.authedCall(async () => client, kit)('query', 'shelf:mine', {})), client.log.length], ['offline', 2], 'with no session to mint from, the first failure throws, unretried');

kit = fakeKit({ cached: new Error('mint failed') });
client = fakeClient([{ ok: true }]);
await settled(A.authedCall(async () => client, kit)('query', 'shelf:mine', {}));
eq(client.log, [['setAuth', 'fresh-token'], ['query', 'shelf:mine']], 'a token that fails to mint counts as a thrown request');

kit = fakeKit({ fresh: null });
client = fakeClient([new Error('expired')]);
eq([await rejection(A.authedCall(async () => client, kit)('query', 'shelf:mine', {})), client.log.length], ['expired', 2], 'a fresh mint that comes back empty throws the first error');

// ── /u/ ─────────────────────────────────────────────────────────────────────
eq(A.PROFILE_COPY, {
  loading: 'Loading this shelf',
  missing: 'This link is missing the shelf name, which goes after the question mark.',
  unavailable: 'No public shelf at this address. It may not exist, or its owner keeps it private.',
  error: 'This shelf could not be loaded. Check your connection and reload.',
  empty: 'This shelf has no catalogued books to show.',
}, "the /u/ states say what the plan's table says, and none of it names a handle");

const at = handleFromSearch;
const shelfReply = (books, extra = {}) => ({ n: 1, authed: false, value: { handle: 'ana', books, ...extra } });
eq([A.profileState(at(''), null), A.profileState(at('?theme=matrix'), null)], ['missing', 'missing'], 'a link naming no shelf is Missing, a kit key alone included');
eq(A.profileState(at('?al%20ice'), null), 'unavailable', 'a name that can never be a handle is Unavailable, before any request');
eq(A.profileState(at('?al%20ice'), shelfReply([{ id: 1 }])), 'unavailable', 'whatever a reply says');
eq(A.profileState(at('?ana'), null), 'loading', 'a valid handle with no reply yet is Loading');
eq(A.profileState(at('?ana'), { n: 1, authed: false, error: true }), 'error', 'a request that threw is Error');
eq([A.profileState(at('?ana'), { n: 1, value: null }), A.profileState(at('?ana'), { n: 1, value: 'nonsense' })], ['unavailable', 'unavailable'],
  'null is Unavailable, identical for every cause, and so is anything that is not a shelf');
eq(A.profileState(at('?ana'), shelfReply([])), 'empty', 'a shelf with no books is Empty');
eq(A.profileState(at('?ana'), shelfReply([{ id: 'x' }, { id: -4 }, null])), 'empty', 'and so is one whose books carry no usable catalogue id');
eq(A.profileState(at('?ana'), shelfReply([{ id: 622, shelf: 'Nova' }])), 'shelf', 'a shelf with books is Shelf');
eq(A.profileState(at('?ana'), shelfReply([], { isOwner: true, published: false, suspended: false, publishingOpen: false })), 'empty', "an owner's empty shelf is Empty too");

const anon = (n) => ({ n, authed: false, value: { handle: 'ana', books: [] } });
const owner = (n) => ({ n, authed: true, value: { handle: 'ana', books: [], isOwner: true } });
const broke = (n, authed) => ({ n, authed, error: true });
eq(A.replyWins(null, anon(1)), true, 'the first reply is shown');
eq(A.replyWins(anon(1), owner(2)), true, 'a token reply replaces an anonymous one that landed first');
eq(A.replyWins(owner(2), anon(1)), false, 'an anonymous reply landing after a token reply does not replace it');
eq(A.replyWins(owner(1), anon(2)), false, 'whatever its number: the anonymous request may simply have gone out later');
eq([A.replyWins(owner(1), owner(3)), A.replyWins(owner(3), owner(1))], [true, false], 'between token replies the newer wins');
eq([A.replyWins(anon(1), anon(2)), A.replyWins(anon(2), anon(1))], [true, false], 'and between anonymous ones');
eq([A.replyWins(anon(1), broke(2, true)), A.replyWins(owner(1), broke(2, false))], [false, false], 'a failure never replaces an answer on screen');
eq([A.replyWins(broke(1, false), anon(2)), A.replyWins(broke(1, false), broke(2, true))], [true, true], 'an answer replaces a failure, and a token failure an anonymous one');
eq(A.replyWins(null, owner(4), 5), false, 'a reply for a viewer who has since signed out or changed is dropped');
eq(A.replyWins(owner(4), anon(5), 5), true, 'and what that viewer left on screen gives way');

eq([A.isPublicShelf({ handle: 'ana', books: [] }), A.isPublicShelf({ handle: 'ana', books: [], isOwner: true }), A.isPublicShelf(null), A.isPublicShelf(undefined)],
  [true, false, false, false], 'only a shelf that is not the owner view is public');

const LIBRARY = indexById([{ id: 622, title: 'Premio UPC 1991', shelf: 'Nova', listed_as: 'Nova ciencia ficción', note_mine: "the maintainer's copy" }]);
const CATALOG = indexById([{ id: 900, title: 'Only in the catalogue' }]);
const shared = A.publicEntries({ handle: 'ana', books: [
  { id: 622, shelf: 'Leídos', note: 'a note that must not arrive', listedAs: 'x', added: '2026-09-01' },
  { id: 622, shelf: 'again' },
  { id: '900' }, { id: -1 }, null,
  { id: 900, shelf: 7 },
  { id: 31337, shelf: 'Gone' },
] }, LIBRARY, CATALOG);
eq(shared.map((e) => [e.key, e.shelf]), [['tf622', 'Leídos'], ['tf900', null], ['tf31337', 'Gone']], 'a shared shelf shows catalogue ids once each, with the owner shelf labels');
eq(shared.every((e) => e.note === null && e.listed_as === null && e.added === null), true, 'and no note, listed_as or date, whatever the answer carried');
eq(['listed_as', 'note', 'note_mine', 'shelf'].filter((field) => field in (shared[0] || { record: {} }).record), [], "nor the maintainer's own fields from library.json");
eq((shared[2] || { record: {} }).record.title, MISSING_TITLE, 'an id in neither data file is drawn as a book no longer in the catalogue');
eq(A.publicEntries(null, LIBRARY, CATALOG), [], 'no shelf, no entries');

const kinds = [];
for (const suspended of [false, true]) {
  for (const publishingOpen of [false, true]) {
    for (const published of [false, true]) {
      const banner = A.ownerBanner({ handle: 'ana', books: [], isOwner: true, suspended, publishingOpen, published });
      kinds.push(`${suspended ? 'suspended' : '-'}/${publishingOpen ? 'open' : 'closed'}/${published ? 'published' : 'private'}: ${banner ? banner.kind : null}`);
    }
  }
}
eq(kinds, [
  '-/closed/private: closed', '-/closed/published: closed', '-/open/private: private', '-/open/published: published',
  'suspended/closed/private: suspended', 'suspended/closed/published: suspended', 'suspended/open/private: suspended', 'suspended/open/published: suspended',
], 'the owner banner, for every combination: suspended, then closed, then private, then published');
eq(['suspended', 'closed', 'private', 'published'].map((kind) => A.OWNER_COPY[kind]), [
  'A moderator has hidden this shelf. Nobody else can see it.',
  'Public shelves are not open yet. Nobody else can see this page.',
  'Only you can see this shelf.',
  'This is what others see.',
], 'each says what the plan says');
eq((A.ownerBanner({ handle: 'ana', books: [], isOwner: true, suspended: false, publishingOpen: true, published: true }) || {}).note,
  'Books added by hand, notes and dates are never shown here.', 'and every owner banner adds what is never shown');
eq([A.ownerBanner({ handle: 'ana', books: [] }), A.ownerBanner({ handle: 'ana', books: [], isOwner: 'true' }), A.ownerBanner(null)], [null, null, null],
  'nobody but the owner gets a banner');
eq((A.ownerBanner({ handle: 'ana', books: [], isOwner: true }) || {}).kind, 'closed', 'an owner view missing its flags reads as nobody else seeing it');

// ── The Share dialog ────────────────────────────────────────────────────────
const mine = (extra) => ({ erasing: false, profile: null, entries: [], count: 0, max: 2000, truncated: false, publishingOpen: false, ...extra });
const pick = (f) => (f ? [f.canPublish, f.switchable, f.copyable] : null);
const noAddress = A.shareFacts(mine()) || {};
eq([noAddress.handle, noAddress.published, noAddress.open, ...pick(noAddress), noAddress.link], [null, false, false, false, false, false, null],
  'closed, with no address: nothing to publish or copy');
const open = A.shareFacts(mine({ publishingOpen: true, profile: { handle: 'ana', published: false, suspended: false }, entries: [{ key: 'tf1', id: 1 }, { key: 'own-x', id: null }] })) || {};
eq([...pick(open), open.catalogued, open.books, open.link], [true, true, false, 1, 2, 'https://vitrina.neorgon.com/u/?ana'],
  'open with an address: it can be published, the preview counts catalogue books only, and there is no link to copy yet');
eq(pick(A.shareFacts(mine({ publishingOpen: true, profile: { handle: 'ana', published: true, suspended: false } }))), [false, true, true],
  'published and open: Copy link, and the switch takes it down');
eq(pick(A.shareFacts(mine({ publishingOpen: true, profile: { handle: 'ana', published: true, suspended: true } }))), [false, true, false],
  'suspended: no link, and going private still works');
eq(pick(A.shareFacts(mine({ publishingOpen: false, profile: { handle: 'ana', published: true, suspended: false } }))), [false, true, false],
  'published before publishing closed: no link, and it can still be taken down');
eq(pick(A.shareFacts(mine({ publishingOpen: false, profile: { handle: 'ana', published: false, suspended: false } }))), [false, false, false],
  'closed and private: the switch is disabled');
eq(pick(A.shareFacts(mine({ publishingOpen: true, profile: { handle: null, published: false, suspended: false } }))), [false, false, false],
  'open with no address yet: nothing to switch on');
eq(pick(A.shareFacts(mine({ publishingOpen: true, profile: { handle: 'ana', published: false, suspended: true } }))), [false, false, false],
  'suspended and private: nothing to switch on');
eq([A.shareFacts(null), A.shareFacts({ erasing: true, remaining: 4 }), A.shareFacts({ erasing: false })], [null, null, null], 'no shelf, no dialog facts');

eq(A.sharePreview('ana', 12), 'Visitors see @ana and 12 catalogue books grouped by your shelf labels. Never shown: notes, dates, books added by hand.', 'the preview of what becomes public');
eq(A.sharePreview('ana', 1), 'Visitors see @ana and 1 catalogue book grouped by your shelf labels. Never shown: notes, dates, books added by hand.', 'in the singular');
eq(A.changeHandleConfirm('ana'), 'Links to /u/?ana stop working, and nobody, you included, can take ana for 30 days.', 'a handle change names both of its effects');
eq([A.deletionCopy({ erasing: true, remaining: 1200 }), A.deletionCopy({ erasing: true, remaining: 0 }), A.deletionCopy(mine())],
  ['Deleting your books: 1200 left', 'Your books are deleted. The last of your records clear within a few minutes.', 'Your Vitrina data is deleted.'],
  'deletion progress, from the answers polled after it started');

// ── What source can hold the modules to ─────────────────────────────────────
const JS = new URL('../js/', import.meta.url);
const read = (name) => readFileSync(new URL(name, JS), 'utf8');
const writes = [];
for (const name of ['account.js', 'strips.js', 'profile.js', 'share.js', 'session.js', 'accountplan.js', 'keyguard.js']) {
  const code = read(name);
  for (const match of code.matchAll(/localStorage\.(setItem|removeItem)\(\s*([^,)]+)/g)) writes.push(`${name} ${match[1]} ${match[2].trim()}`);
  if (code.includes('vitrina_shelf_v1')) writes.push(`${name} names vitrina_shelf_v1`);
}
eq(writes, ['strips.js setItem MOVED'], 'the account modules write one localStorage key, and never the shelf');
eq(read('strips.js').includes("const MOVED = 'vitrina_moved_v1';"), true, 'and that key is vitrina_moved_v1');

const profile = read('profile.js');
eq(/document\.title\s*=/.test(profile), false, '/u/ never sets document.title, so no tab or history entry carries the handle');
const anonymousFn = (profile.match(/function anonymousClient\(\) \{[\s\S]*?\n\}/) || [''])[0];
eq([anonymousFn !== '', anonymousFn.includes('bindConvex')], [true, false], 'the anonymous client is never handed to the kit');
eq(profile.includes('authedCall(ownerClient, kit)'), true, 'and a request with a token goes through the owner client');

const accountJs = read('account.js');
const boot = accountJs.slice(accountJs.indexOf('async function boot('), accountJs.indexOf('function client()'));
const demoExit = boot.indexOf("if (mode !== 'shelf') {");
eq(demoExit > 0 && boot.indexOf('return;', demoExit) < boot.indexOf('client()') && !boot.slice(0, demoExit).includes('client('), true,
  '/demo/ starts the kit and returns before any Convex client or shelf:mine');
eq([accountJs.split('.onChange(').length - 1, profile.split('.onChange(').length - 1], [1, 1], 'each page module adds one onChange listener');
eq(/skipQueue\s*:/.test(accountJs + read('strips.js') + read('share.js')), false, 'no write passes skipQueue');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
