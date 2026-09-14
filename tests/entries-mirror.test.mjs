// Plain node, no install. Run with: make validate
//
// convex/lib/entries.ts refuses a book that breaks the entry rules; js/syncplan.js
// clamps a browser book until it keeps them. Two copies of one rule list drift,
// and when these two drift the failure is the quiet kind: the server refuses a
// whole chunk of an upload over a cap the browser thought was larger. So this
// imports both and compares the rules, then hands the server everything the
// browser makes of inputs chosen to break each rule, and requires the server to
// accept it unchanged.

import * as server from '../convex/lib/entries.ts';
import * as limits from '../convex/lib/limits.ts';
import * as browser from '../js/syncplan.js';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

// ── The rules are the same rules ────────────────────────────────────────────
eq(browser.CAPS, server.CAPS, 'the caps are the same caps, in the same order');
eq(Object.isFrozen(browser.CAPS), true, 'and the browser copy is frozen');
eq([browser.OWN_KEY_RE.source, browser.OWN_KEY_RE.flags], [server.OWN_KEY_RE.source, server.OWN_KEY_RE.flags], 'the hand-added key grammar is the same');
eq([browser.ADDED_RE.source, browser.ADDED_RE.flags], [server.ADDED_RE.source, server.ADDED_RE.flags], 'so is the date grammar');
eq([...browser.RECORD_KEYS], [...server.RECORD_KEYS], 'the record keys are the same, in order');
eq([...browser.ENTRY_KEYS], [...server.ENTRY_KEYS], 'and so are the entry keys');
eq([browser.MAX_ENTRIES, browser.CALL_MAX], [limits.MAX_ENTRIES, limits.CALL_MAX], 'the shelf cap and the chunk size match convex/lib/limits.ts');

// ── The server accepts what the browser sends ───────────────────────────────
const x = (n) => 'x'.repeat(n);
const corpus = [
  ['a catalogue book one past every cap', { key: 'tf42', id: 42, shelf: x(81), note: x(1001), listed_as: x(201), added: '2026-09-14' }],
  ['a catalogue book with padded or blank text', { key: 'tf42', id: 42, shelf: `  ${x(80)}  `, note: '   ', listed_as: '' }],
  ['a date that is not one', { key: 'tf42', id: 42, added: '14/09/2026' }],
  ['a surrogate pair astride the shelf cap', { key: 'tf42', id: 42, shelf: `${x(79)}😀` }],
  ['the largest safe id', { key: `tf${Number.MAX_SAFE_INTEGER}`, id: Number.MAX_SAFE_INTEGER }],
  ['a hand-added book past every record cap', { key: `own-${'a'.repeat(56)}`, id: null, record: {
    title: x(201), authors: Array(12).fill(x(201)), year: x(21), pages: -3, publisher: x(121), collection: x(121),
    dimensions: x(21), cover_custom: `https://example.invalid/${x(480)}`, spine_custom: 'ftp://example.invalid/s.jpg',
  } }],
  ['a hand-added book with unknown record keys and a hostile id', { key: 'own-1', id: null, record: { id: '1" onerror="x', title: 'T', isbn: '1', listed_as: 'x', onerror: 'x' } }],
  ['a hand-added book with no record at all', { key: 'own-2', id: null }],
  ['a hand-added book whose title is only spaces', { key: 'own-3', id: null, record: { title: '    ' } }],
  ['numbers and a lone author where text and lists belong', { key: 'own-4', id: null, record: { title: 1984, year: 1984, authors: 'Orwell', pages: 328 } }],
];
for (const [what, entry] of corpus) {
  const sent = browser.toServerEntry(entry);
  const checked = server.checkEntry(sent);
  eq(checked.ok ? true : checked.reason, true, `the server accepts ${what}`);
  if (checked.ok) eq(checked.value, sent, `and keeps exactly what the browser sent for ${what}`);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
