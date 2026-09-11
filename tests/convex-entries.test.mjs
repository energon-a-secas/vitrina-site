// Plain node, no install. Run with: make validate
//
// The entry rules of convex/lib/entries.ts, at every boundary. What reaches
// upsertEntries is whatever a browser sent, so each rule is tested from the
// side of a client that did not clamp: one character over, the wrong type, and
// the hostile record id that turned into an onerror handler in js/shelf.js.

import { CAPS, ENTRY_KEYS, RECORD_KEYS, checkEntry, checkNote, checkRecord, checkShelf } from '../convex/lib/entries.ts';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

const x = (n) => 'x'.repeat(n);
const accepted = (raw) => checkEntry(raw).ok;
const value = (raw) => { const r = checkEntry(raw); return r.ok ? r.value : null; };
const reason = (raw) => { const r = checkEntry(raw); return r.ok ? null : r.reason; };
const catalogue = (over = {}) => ({ key: 'tf42', catalogId: 42, shelf: 'Nova', note: null, listedAs: null, added: null, ...over });
const byHand = (record = {}, over = {}) => ({ key: 'own-3f2a', catalogId: null, record: { title: 'Un libro', ...record }, ...over });
const recordOk = (record) => checkRecord({ title: 'Un libro', ...record }).ok;

// ── A catalogue book ────────────────────────────────────────────────────────
eq(value(catalogue()), { key: 'tf42', catalogId: 42, shelf: 'Nova', note: null, listedAs: null, added: null, record: null },
  'a catalogue book is accepted as exactly its owner fields');
eq(value({ key: 'tf7', catalogId: 7 }), { key: 'tf7', catalogId: 7, shelf: null, note: null, listedAs: null, added: null, record: null },
  'absent owner fields read as null');
eq(accepted(catalogue({ key: 'tf9007199254740991', catalogId: Number.MAX_SAFE_INTEGER })), true, 'the largest safe integer is a valid id');
for (const [id, what] of [[0, 'zero'], [-3, 'a negative id'], [1.5, 'a fraction'], [Number.MAX_SAFE_INTEGER + 1, 'an unsafe integer'],
  ['42', 'a numeric string'], [Number.NaN, 'NaN'], [Infinity, 'Infinity'], [true, 'a boolean']]) {
  eq(accepted(catalogue({ catalogId: id, key: 'tf' + id })), false, `catalogId refuses ${what}`);
}
for (const key of ['tf43', 'tf042', 'TF42', ' tf42', 'own-42']) {
  eq(accepted(catalogue({ key })), false, `a catalogue book refuses the key ${JSON.stringify(key)}`);
}
eq(accepted(catalogue({ record: { title: 'Dune' } })), false, 'a catalogue book refuses a record: the browser reads it from the catalogue');
eq(accepted(catalogue({ record: null })), true, 'a null record on a catalogue book is fine');

// ── A book added by hand ────────────────────────────────────────────────────
eq(accepted(byHand()), true, 'a book added by hand with a title is accepted');
eq(accepted(byHand({}, { key: 'own' + x(60) })), true, 'an own key with 60 characters after own is accepted');
for (const key of ['own', 'own' + x(61), 'OWN-abc', 'own_abc', 'own-ábc', 'imp3', 'tf42', '']) {
  eq(accepted(byHand({}, { key })), false, `a book added by hand refuses the key ${JSON.stringify(key.slice(0, 20))}`);
}
eq(accepted(byHand({}, { key: 42 })), false, 'a key must be text');
eq(accepted({ key: 'own-3f2a', catalogId: null, record: null }), false, 'a book added by hand needs a record');
eq(accepted({ key: 'own-3f2a' }), false, 'even when catalogId is absent');

// ── Owner fields ────────────────────────────────────────────────────────────
eq(accepted(catalogue({ shelf: x(CAPS.shelf) })), true, 'a shelf label of 80 characters fits');
eq(accepted(catalogue({ shelf: x(CAPS.shelf + 1) })), false, 'one more is refused, not cut');
eq(value(catalogue({ shelf: '  B de Bolsillo  ' })).shelf, 'B de Bolsillo', 'a shelf label is trimmed');
eq(accepted(catalogue({ shelf: `  ${x(CAPS.shelf)}  ` })), true, 'and measured after trimming');
eq(value(catalogue({ shelf: '   ' })).shelf, null, 'an empty shelf label becomes null');
eq(accepted(catalogue({ shelf: 7 })), false, 'a shelf label must be text');
eq(accepted(catalogue({ note: x(CAPS.note) })), true, 'a note of 1000 characters fits');
eq(accepted(catalogue({ note: x(CAPS.note + 1) })), false, 'a note of 1001 does not');
eq(value(catalogue({ note: '' })).note, null, 'an empty note becomes null');
eq(accepted(catalogue({ listedAs: x(CAPS.listedAs) })), true, 'listedAs of 200 characters fits');
eq(accepted(catalogue({ listedAs: x(CAPS.listedAs + 1) })), false, 'listedAs of 201 does not');
eq(value(catalogue({ added: '2026-09-11' })).added, '2026-09-11', 'added takes a YYYY-MM-DD date');
for (const added of ['2026-9-11', '2026-13-01', '2026-00-10', '2026-09-32', '11/09/2026', '', '2026-09-11T00:00', 20260911]) {
  eq(accepted(catalogue({ added })), false, `added refuses ${JSON.stringify(added)}`);
}

// ── The entry object itself ─────────────────────────────────────────────────
eq(accepted(catalogue({ clerkSubject: 'user_someone_else' })), false, 'an entry cannot name its owner');
eq(reason(catalogue({ clerkSubject: 'user_x' })).includes('clerkSubject'), true, 'and the reason names the field');
eq(accepted(catalogue({ id: 42 })), false, 'an entry carries catalogId, not id');
for (const [raw, what] of [[null, 'null'], [[], 'a list'], ['tf42', 'a string'], [42, 'a number'], [Object.create({ key: 'tf42', catalogId: 42 }), 'an object with an inherited shape']]) {
  eq(accepted(raw), false, `an entry refuses ${what}`);
}
eq(Object.keys(value(catalogue())), ENTRY_KEYS, 'an accepted entry has exactly the entry keys');

// ── The record whitelist ────────────────────────────────────────────────────
eq(checkRecord({}).ok, false, 'a record needs a title');
for (const [title, what] of [['', 'an empty title'], ['   ', 'a blank title'], [x(CAPS.title + 1), 'a 201-character title'], [42, 'a numeric title']]) {
  eq(checkRecord({ title }).ok, false, `a record refuses ${what}`);
}
eq(checkRecord({ title: x(CAPS.title) }).ok, true, 'a 200-character title fits');
eq(checkRecord({ title: '  Dune  ' }).value.title, 'Dune', 'a title is trimmed');

eq(recordOk({ authors: Array.from({ length: CAPS.authors }, (_, i) => 'Autor ' + i) }), true, 'ten authors fit');
eq(recordOk({ authors: Array.from({ length: CAPS.authors + 1 }, (_, i) => 'Autor ' + i) }), false, 'eleven do not');
eq(recordOk({ authors: [x(CAPS.author)] }), true, 'an author name of 200 characters fits');
eq(recordOk({ authors: [x(CAPS.author + 1)] }), false, 'one of 201 does not');
eq(recordOk({ authors: 'Frank Herbert' }), false, 'authors must be a list');
eq(recordOk({ authors: [42] }), false, 'of text');
eq(checkRecord({ title: 'Dune', authors: ['', ' Frank Herbert '] }).value.authors, ['Frank Herbert'], 'author names are trimmed and blanks dropped');
eq(checkRecord({ title: 'Dune' }).value.authors, [], 'no authors reads as an empty list');

eq(recordOk({ year: '1987' }), true, 'a year as text');
eq(recordOk({ year: x(CAPS.year) }), true, 'a year of 20 characters fits');
eq(recordOk({ year: x(CAPS.year + 1) }), false, 'one of 21 does not');
eq(recordOk({ year: 1987 }), false, 'a year must be text, as the catalogue stores it');
eq(recordOk({ pages: 320 }), true, 'pages as a whole number');
eq(recordOk({ pages: null }), true, 'or null');
eq(recordOk({ pages: 0 }), true, 'zero pages is a number, if an odd one');
for (const pages of [1.5, '320', -1]) eq(recordOk({ pages }), false, `pages refuses ${JSON.stringify(pages)}`);
for (const [field, cap] of [['publisher', CAPS.publisher], ['collection', CAPS.collection], ['dimensions', CAPS.dimensions]]) {
  eq(recordOk({ [field]: x(cap) }), true, `${field} of ${cap} characters fits`);
  eq(recordOk({ [field]: x(cap + 1) }), false, `${field} of ${cap + 1} does not`);
}

const longUrl = (n) => 'https://a.org/' + x(n - 'https://a.org/'.length);
for (const field of ['cover_custom', 'spine_custom']) {
  eq(recordOk({ [field]: 'https://example.org/lomo.jpg' }), true, `${field} takes an https: address`);
  eq(recordOk({ [field]: null }), true, `${field} may be null`);
  eq(recordOk({ [field]: longUrl(CAPS.url) }), true, `${field} of 500 characters fits`);
  eq(recordOk({ [field]: longUrl(CAPS.url + 1) }), false, `${field} of 501 does not`);
  for (const bad of ['http://example.org/lomo.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//example.org/lomo.jpg', 'not a url']) {
    eq(recordOk({ [field]: bad }), false, `${field} refuses ${bad}`);
  }
}

// The hostile id. js/shelf.js wrote record.id raw into data-book-id, so this
// string became an onerror handler that fired. There is no id in a record at
// all, so it is refused whatever its value.
const hostile = '1" onerror="alert(document.cookie)" x="';
eq(checkRecord({ title: 'Dune', id: hostile }).ok, false, 'a record with a hostile id is refused');
eq(checkRecord({ title: 'Dune', id: hostile }).reason.includes('"id"'), true, 'and the reason names the id field');
eq(checkRecord({ title: 'Dune', id: null }).ok, false, 'a record has no id at all, not even a null one');
eq(accepted(byHand({ id: hostile })), false, 'the same record is refused inside an entry');

for (const key of ['note_mine', 'listed_as', 'shelf', 'slug', 'url', 'cover', 'spine', 'has_spine', 'constructor']) {
  eq(checkRecord({ title: 'Dune', [key]: 'x' }).ok, false, `a record refuses the unknown key ${key}`);
}
eq(checkRecord(JSON.parse('{"title":"Dune","__proto__":{"polluted":true}}')).ok, false, 'a record refuses a __proto__ key');
eq(checkRecord(Object.create({ title: 'inherited' })).ok, false, 'a record must be a plain object');

const full = checkRecord({
  title: 'Dune', authors: ['Frank Herbert'], year: '1987', pages: 700, publisher: 'Ediciones B',
  collection: 'Nova', dimensions: '12×19', cover_custom: 'https://example.org/c.jpg', spine_custom: null,
}).value;
eq(Object.keys(full), RECORD_KEYS, 'an accepted record has exactly the whitelisted keys');
eq('id' in full, false, 'and no id');

// ── updateEntry's two fields ────────────────────────────────────────────────
eq(checkShelf(null), { ok: true, value: null }, 'updateEntry may clear a shelf label');
eq(checkShelf(x(CAPS.shelf + 1)).ok, false, 'and not overfill it');
eq(checkNote(x(CAPS.note)).ok, true, 'a full-length note fits');
eq(checkNote({ text: 'x' }).ok, false, 'a note must be text');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
