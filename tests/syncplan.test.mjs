// Plain node, no install. Run with: make validate
//
// js/syncplan.js decides what a browser shelf becomes on its way to an account
// and what an account row becomes on its way to the page. Its failures are
// silent by nature: a book that never uploads, a note in the wrong place, the
// maintainer's labels on a stranger's shelf, a removed book offered back. So
// each rule is pinned here with the shapes real browsers hold: keys minted by
// every version of Vitrina, ids that no longer resolve, and ids nobody should
// have written.

import * as P from '../js/syncplan.js';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

let minted = 0;
const mint = () => `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`;
const OWN_UUID = /^own-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const shape = (key) => (OWN_UUID.test(key) ? 'own-<uuid>' : key);

const LIBRARY = P.indexById([{
  id: 622, title: 'Premio UPC 1991', slug: 'premio-upc-1991', authors: ['Varios'], has_spine: true, collection: 'Nova',
  shelf: 'Nova', listed_as: 'Nova ciencia ficción', note: 'a note in the record', note_mine: "the maintainer's copy",
  url: 'https://example.invalid/622', scraped_at: '2026-09-06',
}]);
const CATALOG = P.indexById([{ id: 900, title: 'Only in the catalogue', authors: ['Autora'], collection: 'VIB' }]);

// ── Normalising a browser shelf ─────────────────────────────────────────────
const legacy = P.normaliseBrowserShelf([
  { key: 'imp0', id: 622, shelf: 'Nova', note: 'mine', record: { id: 622, title: 'Premio UPC 1991' } },
  { key: 'imp1', id: null, note: 'from a flea market', record: { title: 'Un libro sin catálogo' } },
  { key: 'imp2', id: 555555, record: { id: 555555, title: 'An id nobody has' } },
  { key: 'ownmf3k2x1', id: null, record: { title: 'Added by hand under an old key' } },
  { key: 'tf777777', id: 777777, record: { id: 777777, title: 'Keyed tf, gone from the catalogue' } },
  { key: 'imp5', id: '622', record: { id: '622', title: 'An id written as text' } },
], LIBRARY, CATALOG, mint);
eq(legacy.map((e) => shape(e.key)), ['tf622', 'own-<uuid>', 'own-<uuid>', 'ownmf3k2x1', 'tf777777', 'own-<uuid>'],
  'legacy imp keys: with a resolving id they become tf<id>, without one own-<uuid>');
eq(legacy.every((e) => P.OWN_KEY_RE.test(e.key) || e.key === `tf${e.id}`), true, 'every key ends up in one of the two grammars');
eq(legacy.map((e) => e.id), [622, null, null, null, 777777, null], 'and the id follows the key');
eq(legacy.map((e) => e.record.id), [622, null, null, null, 777777, null], 'record.id included');
eq(legacy.map((e) => e.note), ['mine', 'from a flea market', null, null, null, null], 'notes stay as the person wrote them');
eq(new Set(legacy.map((e) => e.key)).size, legacy.length, 'every minted key is its own');

const mintedBefore = minted;
eq(P.normaliseBrowserShelf(legacy, LIBRARY, CATALOG, mint), legacy, 'normalising a normalised shelf changes nothing');
eq(minted, mintedBefore, 'and mints nothing: a key is minted once');

eq(P.normaliseBrowserShelf([{ key: 'imp0', id: 555555, record: { id: 555555, title: 'x' } }], new Map(), null, mint)[0].key, 'tf555555',
  'with no catalogue loaded an id is kept, not demoted to a hand-added book and written back that way');

const shared = P.normaliseBrowserShelf([
  { key: 'tf622', id: 622, shelf: 'Nova', note: null, record: { id: 622, title: 'Premio UPC 1991' } },
  { key: 'imp4', id: 622, shelf: 'Leídos', note: 'the second copy had the note', added: '2026-09-02', record: { id: 622 } },
], LIBRARY, CATALOG, mint);
eq(shared.length, 1, 'two entries sharing one id collapse to one book');
eq([shared[0].key, shared[0].shelf, shared[0].note, shared[0].added], ['tf622', 'Nova', 'the second copy had the note', '2026-09-02'],
  'keeping the first label, and a note or date only the other copy had');

const HOSTILE = '1" onerror="x';
const hostile = P.normaliseBrowserShelf([{ key: `tf${HOSTILE}`, id: HOSTILE, record: { id: HOSTILE, title: 'Hostile' } }], LIBRARY, CATALOG, mint);
eq(OWN_UUID.test(hostile[0].key), true, 'a hostile id makes a book added by hand, under a fresh key');
eq([hostile[0].id, hostile[0].record.id], [null, null], 'and the id goes nowhere, record.id included');
const hostileSent = P.toServerEntry(hostile[0]);
eq([hostileSent.catalogId, 'id' in hostileSent.record], [null, false], 'the server copy has no id at all');
eq(JSON.stringify(hostileSent).includes('onerror'), false, 'nothing of the id reaches the account');

// ── toServerEntry and the record whitelist ──────────────────────────────────
const long = P.toServerEntry({
  key: 'tf622', id: 622, shelf: `  ${'s'.repeat(90)}  `, note: 'n'.repeat(1001), listed_as: 'l'.repeat(201), added: 'yesterday',
  record: { id: 622, title: 'not sent' },
});
eq(Object.keys(long), [...P.ENTRY_KEYS], 'a server entry has exactly the entry keys, in order');
eq([long.shelf.length, long.note.length, long.listedAs.length], [80, 1000, 200], 'an over-length note, label or listed_as is cut to its cap');
eq(long.added, null, 'a non-date added is dropped');
eq(long.record, null, 'a catalogue book sends no record');
eq(P.toServerEntry({ key: 'tf622', id: 622, added: '2026-09-14' }).added, '2026-09-14', 'a real date is kept');
eq(P.toServerEntry({ key: 'tf622', id: 622, added: '2026-13-01' }).added, null, 'a thirteenth month is not');
eq(P.toServerEntry({ key: 'tf1', id: 622 }), null, 'a key that disagrees with its id is not sent');
eq(P.toServerEntry({ key: 'imp9', id: null, record: { title: 'x' } }), null, 'nor a key in neither grammar');
const astride = P.toServerEntry({ key: 'tf622', id: 622, shelf: `${'a'.repeat(79)}😀` }).shelf;
eq([astride.length, /[\uD800-\uDBFF]$/.test(astride)], [79, false], 'a cut never splits a surrogate pair');

const record = P.whitelistRecord({
  id: 5, title: '  Dune  ', authors: ['Frank Herbert', '', 7, 'x'.repeat(250), ...Array(20).fill('Otro')], year: 1965, pages: 12.5,
  publisher: 'Acervo', collection: null, dimensions: '11×18', cover_custom: 'javascript:alert(1)', spine_custom: 'https://example.invalid/s.jpg',
  isbn: '84-000', listed_as: 'x', note_mine: 'y', onerror: 'z',
});
eq(Object.keys(record), [...P.RECORD_KEYS], 'unknown record keys are dropped, id included');
eq([record.title, record.authors.length, record.authors[1].length, record.year, record.pages], ['Dune', 10, 200, '1965', null],
  'title trimmed, ten authors at most and each cut to 200, a year made text, a fractional page count dropped');
eq([record.cover_custom, record.spine_custom], [null, 'https://example.invalid/s.jpg'], 'a javascript: image is dropped, an https: one kept');
eq(P.whitelistRecord({ cover_custom: 'http://example.invalid/c.jpg' }).cover_custom, null, 'plain http is dropped too');
eq(P.whitelistRecord({ spine_custom: `https://example.invalid/${'a'.repeat(500)}` }).spine_custom, null, 'a URL past 500 characters is dropped, not cut');
eq(P.whitelistRecord({}).title, 'Untitled', 'a record with no title is Untitled, as the shelf already calls it');
eq(P.whitelistRecord(null).title, 'Untitled', 'and so is no record at all');

// ── fromServerEntry and the library allowlist ───────────────────────────────
const bare = P.fromServerEntry({ key: 'tf622', id: 622, shelf: null, note: null, listedAs: null, added: null, record: null }, LIBRARY, CATALOG);
eq(['listed_as', 'note', 'note_mine', 'shelf', 'scraped_at'].filter((k) => k in bare.record), [],
  "library.json's listed_as, note, note_mine and shelf never reach an account book's record");
eq([bare.shelf, bare.note, bare.listed_as, bare.added], [null, null, null, null], "and the row's empty fields stay empty instead of filling from library.json");
eq(Object.keys(bare.record).every((k) => P.BIBLIOGRAPHIC_KEYS.includes(k)), true, 'every record key is a bibliographic one');
eq([bare.record.title, bare.record.id, bare.slug], ['Premio UPC 1991', 622, 'premio-upc-1991'], 'the bibliographic record is all there');
bare.record.authors.push('changed in memory');
eq(LIBRARY.get(622).authors, ['Varios'], 'and copied, so memory never edits the data file');
const owned = P.fromServerEntry({ key: 'tf622', id: 622, shelf: 'Leídos', note: 'mine', listedAs: 'as I list it', added: '2026-09-14', record: null }, LIBRARY, CATALOG);
eq([owned.shelf, owned.note, owned.listed_as, owned.added], ['Leídos', 'mine', 'as I list it', '2026-09-14'], "the owner's fields come from the row");
eq(P.fromServerEntry({ key: 'tf900', id: 900 }, LIBRARY, CATALOG).record.title, 'Only in the catalogue', 'an id only catalog.json has is read from there');
eq(P.fromServerEntry({ key: 'tf31337', id: 31337 }, LIBRARY, CATALOG).record, { title: P.MISSING_TITLE, has_spine: false, id: 31337 },
  'an id in neither file is drawn as a book no longer in the catalogue');
const hand = P.fromServerEntry({ key: 'own-abc', id: null, record: { title: 'Mine', id: 99, onerror: 'x' } }, LIBRARY, CATALOG);
eq([Object.keys(hand.record), hand.record.id], [[...P.RECORD_KEYS, 'id'], null], 'a hand-added row keeps only whitelisted keys, and record.id is null');
eq([
  P.fromServerEntry({ key: 'tf1', id: 622 }, LIBRARY, CATALOG),
  P.fromServerEntry({ key: 'imp0', id: null, record: { title: 'x' } }, LIBRARY, CATALOG),
  P.fromServerEntry('not a row', LIBRARY, CATALOG),
], [null, null, null], 'a row in neither grammar is not shown');

// ── The demo seed on an account ─────────────────────────────────────────────
eq(P.demoSeedForAccount([
  { key: 'tf622', id: 622, shelf: 'Nova', note: "the maintainer's", listed_as: 'Nova ciencia ficción', added: '2026-09-06', record: {} },
  { key: 'tf622', id: 622, shelf: 'Nova' },
  { key: 'ownx', id: null, shelf: 'Added by hand', record: { title: 'Hand' } },
  { key: 'tf900', id: 900, shelf: null },
]), [
  { key: 'tf622', catalogId: 622, shelf: 'Nova', note: null, listedAs: null, added: null, record: null },
  { key: 'tf900', catalogId: 900, shelf: null, note: null, listedAs: null, added: null, record: null },
], 'the demo seed is catalogue ids and shelf labels, once each, and nothing else of the maintainer');

// ── Import keys ─────────────────────────────────────────────────────────────
const keys = P.importKeys([
  { key: 'imp0', id: 622 },
  { key: 'imp1', id: null, record: { title: 'No id' } },
  { id: 900, title: 'A raw catalogue record' },
  { key: 'own-kept-1', record: { title: 'Kept' } },
  { key: 'imp4', id: 555555 },
  'not a book',
], LIBRARY, CATALOG, mint);
eq(keys.map(shape), ['tf622', 'own-<uuid>', 'tf900', 'own-kept-1', 'own-<uuid>', 'own-<uuid>'], 'import keys a file by the catalogue, not by position');
eq(keys.some((k) => k.startsWith('imp')), false, 'and never mints imp<index> again');
eq(new Set(keys).size, keys.length, 'every key it mints is its own');
eq(keys.map(P.idFromKey), [622, null, 900, null, null, null], 'the id follows the key');

// ── Entries for an imported file ────────────────────────────────────────────
// modals.js used to build these inline, where no test could reach the rule that
// record.id follows the key: an id the file wrote went straight into
// data-book-id and the image URLs.
const file = [
  { key: 'own-x', id: HOSTILE, shelf: 'Leídos', note: 'from a file', record: { id: HOSTILE, title: 'From a file' } },
  { id: 622, title: 'Premio UPC 1991' },
];
const fromFile = P.importedEntries(file, P.importKeys(file, LIBRARY, CATALOG, mint));
eq(fromFile.map((e) => [e.key, e.id, e.record.id]), [['own-x', null, null], ['tf622', 622, 622]],
  'record.id follows the key, never the file: none for a book added by hand, the catalogue id for a catalogue book');
eq([fromFile[0].shelf, fromFile[0].note, fromFile[1].record.title], ['Leídos', 'from a file', 'Premio UPC 1991'],
  "the file's labels and notes come with it, and a raw catalogue record is its own record");
eq(JSON.stringify(fromFile).includes('onerror'), false, 'nothing of a hostile id survives');

// ── What the account strip counts ───────────────────────────────────────────
const browser = [{ key: 'tf622' }, { key: 'tf900' }, { key: 'own-hand-1' }, { key: 'tf622' }];
eq(P.keysMissingFromAccount(browser, ['tf900'], []), ['tf622', 'own-hand-1'], 'N counts the browser books the account lacks, once each');
const moved = ['tf622', 'own-hand-1'];
const account = new Set(['tf900', 'tf622', 'own-hand-1']);
eq(P.keysMissingFromAccount(browser, account, moved), [], 'after a move, nothing is missing');
account.delete('tf622');
eq(P.keysMissingFromAccount(browser, account, moved).length, 0, 'a moved book then taken off the account is not offered back: the recount gives N = 0');
eq(P.keysMissingFromAccount(browser, account, []), ['tf622'], 'which is the moved list at work, not an accident');

const local = [
  { key: 'tf622', shelf: 'Nova', note: 'bought in Valparaíso' },
  { key: 'tf900', shelf: 'VIB', note: null },
  { key: 'own-hand-1', shelf: 'Hand', note: 'not in the account' },
  { key: 'tf31337', shelf: null, note: '   ' },
];
const rows = new Map([
  ['tf622', { key: 'tf622', shelf: 'Nova', note: null }],
  ['tf900', { key: 'tf900', shelf: 'VIB', note: null }],
  ['tf31337', { key: 'tf31337', shelf: null, note: null }],
]);
eq(P.fillCandidates(local, rows).map((e) => e.key), ['tf622'], 'M counts shared books whose account row lacks a note or label this browser has');
eq(P.fillCandidates([{ key: 'tf900', shelf: 'Leídos', note: null }], { tf900: { shelf: null, note: 'kept' } }).length, 1,
  'a missing label counts as well, from a plain object of rows');

// ── When a refetch may replace memory ───────────────────────────────────────
const started = { generation: 4, writeSeq: 10 };
eq(P.shouldApplyFetch(started, { generation: 4, writeSeq: 10, pending: 0 }), true, 'fetch out and back with no write between: applied');
eq(P.shouldApplyFetch(started, { generation: 4, writeSeq: 10, pending: 1 }), false, 'a write that went out before the fetch and is still pending: not applied');
eq(P.shouldApplyFetch(started, { generation: 4, writeSeq: 11, pending: 0 }), false, 'a write that went out after the fetch began, even one already settled: not applied');
eq(P.shouldApplyFetch(started, { generation: 5, writeSeq: 10, pending: 0 }), false, 'an answer about a shelf no longer shown: never applied');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
