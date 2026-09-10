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
const store = new Map();
let refusals = 0;
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { writes.push(key); store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
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
const PREFS = 'vitrina_prefs_v1';

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
eq(S.restoreSeed(), false, 'restoreSeed reports that nothing was copied');
eq(S.save(), false, 'save refuses on the demo, whatever calls it');
eq(S.whose('yours', 'on this shelf'), 'on this shelf', "the demo never calls the maintainer's books yours");

eq(JSON.stringify(S.state.entries), before, 'no demo entry changed');
eq(writes.filter((k) => k === SHELF).length, 0, "the visitor's saved shelf was never written");
eq(refusals, 4, 'each of the four refused edits is announced');

// Arranging the demo leaves your own shelf's preferences where they were. It
// used to save them, so browsing the demo in Browse opened /shelf/ in Browse,
// past the empty state that shows a new visitor how to start. The shortcuts
// switch is the exception: it is about the person, not the shelf.
store.set(PREFS, JSON.stringify({ view: 'covers', showRuns: false, shortcuts: true }));
S.state.view = 'browse';
S.state.showRuns = true;
S.state.shortcuts = false;
S.savePrefs();
const prefs = JSON.parse(store.get(PREFS));
eq(prefs.view, 'covers', "browsing the demo does not move your shelf's view");
eq(prefs.showRuns, false, 'nor its whole-collection switch');
eq(prefs.shortcuts, false, 'the shortcuts switch does follow the person');

// ── Your shelf ──────────────────────────────────────────────────────────────
writes.length = 0;
S.hydrate(library, 'shelf');
eq(S.state.readOnly, false, 'your own shelf is editable');
eq(S.state.entries.length, 0, "a first visit starts empty, not as the maintainer's shelf");

eq(S.whose('yours', 'on this shelf'), 'yours', 'on your own shelf the books are yours');
eq(S.storedShelfSize(), 0, 'nothing is stored before the first copy');
// Another tab fills the shelf while this one still shows the empty state. The
// copy button must see storage, not this tab's memory, or it overwrites that.
store.set(SHELF, JSON.stringify({ v: 1, entries: [{ key: 'tf7', id: 7, record: { id: 7, title: 'From another tab' } }] }));
eq(S.state.entries.length, 0, 'this tab still believes the shelf is empty');
eq(S.storedShelfSize(), 1, 'storage knows another tab filled it');
store.delete(SHELF);
eq(S.restoreSeed(), true, 'starting from the demo reports that the copy was saved');
eq(S.state.entries.length, 2, 'starting from the demo copies it in');
eq(S.storedShelfSize(), 2, 'another tab reads the copied shelf from storage');
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
