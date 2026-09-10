// Plain node, no install. Run with: make validate
//
// /demo/ shows a real shelf that belongs to somebody else. What makes that safe
// to publish is one invariant: on the demo, no mutation reaches state and the
// visitor's saved shelf is never written. The page hides the edit controls with
// CSS too, but CSS is a suggestion a console can ignore. This is the layer that
// holds regardless, so it is the layer that is tested.
//
// It also pins the other half of the change: a first visit to /shelf/ starts
// empty, where it used to start as a copy of the maintainer's books.

const writes = [];
let refusals = 0;
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: () => null,
  setItem: (key) => { writes.push(key); },
  removeItem: () => {},
};
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
globalThis.document = {
  dispatchEvent: (ev) => { if (ev && ev.type === 'vitrina:read-only') refusals += 1; return true; },
  addEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
};

const S = await import('../js/state.js');
const SHELF = 'vitrina_shelf_v1';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

const library = [
  { id: 101, title: 'Demo one', dimensions: '11x18', pages: 210 },
  { id: 102, title: 'Demo two', dimensions: '12x19', pages: 320 },
];

// ── The demo ────────────────────────────────────────────────────────────────
S.hydrate(library, 'demo');
eq(S.state.readOnly, true, 'the demo is read-only');
eq(S.state.entries.length, 2, "the demo shows the maintainer's shelf");
const before = JSON.stringify(S.state.entries);
const firstKey = S.state.entries[0].key;

eq(S.addEntry({ id: 999, title: 'Sneaked in' }), null, 'addEntry refuses on the demo');
eq(S.removeEntry(firstKey), false, 'removeEntry refuses on the demo');
eq(S.updateEntry(firstKey, { note: 'scribbled' }), null, 'updateEntry refuses on the demo');
S.restoreSeed();
eq(S.save(), false, 'save refuses on the demo, whatever calls it');

eq(JSON.stringify(S.state.entries), before, 'no demo entry changed');
eq(writes.filter((k) => k === SHELF).length, 0, "the visitor's saved shelf was never written");
eq(refusals, 4, 'each of the four refused edits is announced');

// ── Your shelf ──────────────────────────────────────────────────────────────
writes.length = 0;
S.hydrate(library, 'shelf');
eq(S.state.readOnly, false, 'your own shelf is editable');
eq(S.state.entries.length, 0, "a first visit starts empty, not as the maintainer's shelf");

S.restoreSeed();
eq(S.state.entries.length, 2, 'starting from the demo copies it in');
eq(writes.includes(SHELF), true, 'and that copy is saved');
eq(S.addEntry({ id: 555, title: 'Mine' }) !== null, true, 'adding works on your own shelf');

// A page with no mode, or a mode nobody wrote, is your shelf. Read-only is
// something a page has to ask for by name.
S.hydrate(library);
eq(S.state.readOnly, false, 'no mode means your own shelf');
S.hydrate(library, 'banana');
eq(S.state.readOnly, false, 'an unknown mode is never read-only by accident');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
