// Plain node, no install. Run with: make validate
//
// Four shelves share one page and one localStorage key, and each is only safe
// to show because of an invariant this file holds.
//
// /demo/ and /u/ show shelves that belong to somebody else: no mutation reaches
// state there, and the visitor's saved shelf is never read or written. The page
// hides the edit controls with CSS too, but CSS is a suggestion a console can
// ignore. This is the layer that holds regardless, so it is the layer tested.
//
// A signed-in person's account shelf never reaches vitrina_shelf_v1 (plan
// section 3.1). The account row below carries a note nothing else could have
// written, and no write to that key in this whole run may contain it, nor any
// field only an account row has. While the account shelf is shown, the edits
// write nothing to that key at all.
//
// It also pins the older half: a first visit to /shelf/ starts empty, where it
// used to start as a copy of the maintainer's books.

const writes = [];   // { key, value } for every setItem, and value null for every removeItem
const reads = [];
const store = new Map();
const events = [];
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (key) => { reads.push(key); return store.has(key) ? store.get(key) : null; },
  setItem: (key, value) => { writes.push({ key, value: String(value) }); store.set(key, String(value)); },
  removeItem: (key) => { writes.push({ key, value: null }); store.delete(key); },
};
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
globalThis.document = {
  dispatchEvent: (ev) => { if (ev && ev.type) events.push(ev.type); return true; },
  addEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
};

const S = await import('../js/state.js');
const P = await import('../js/syncplan.js');
const SHELF = 'vitrina_shelf_v1';
const PREFS = 'vitrina_prefs_v1';
const OWN_UUID = /^own-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

const announced = (type) => events.filter((t) => t === type).length;
const shelfWrites = () => writes.filter((w) => w.key === SHELF);
const shelfReads = () => reads.filter((key) => key === SHELF).length;
// Every read below that could meet a missing value goes through these, so a
// broken rule fails its own lines instead of throwing and ending the run
// before the storage checks further down have looked at anything.
const storedKeys = () => { try { return JSON.parse(store.get(SHELF)).entries.map((e) => e.key); } catch (err) { return null; } };
const noteOf = (key) => (S.findEntry(key) || {}).note;

const library = [
  { id: 101, title: 'Demo one', dimensions: '11x18', pages: 210, shelf: 'Nova' },
  { id: 102, title: 'Demo two', dimensions: '12x19', pages: 320, shelf: 'VIB' },
  { id: 103, title: 'Demo three', pages: 280, shelf: 'B de Bolsillo', listed_as: 'Bolsillo, the maintainer calls it', note_mine: "the maintainer's own copy", note: 'a note in the catalogue record' },
];

// ── The demo ────────────────────────────────────────────────────────────────
S.hydrate(library, 'demo');
eq(S.state.readOnly, true, 'the demo is read-only');
eq(S.state.source, 'demo', "its shelf is the demo's own");
eq(S.state.entries.length, library.length, "the demo shows the maintainer's shelf");
eq(S.state.entries[2].listed_as, 'Bolsillo, the maintainer calls it', "a demo entry carries its owner's listed_as, which is where detail.js reads it");
const before = JSON.stringify(S.state.entries);
const firstKey = S.state.entries[0].key;

eq(S.addEntry({ id: 999, title: 'Sneaked in' }), null, 'addEntry refuses on the demo');
eq(S.removeEntry(firstKey), false, 'removeEntry refuses on the demo');
eq(S.updateEntry(firstKey, { note: 'scribbled' }), null, 'updateEntry refuses on the demo');
eq(S.restoreSeed(), false, 'restoreSeed reports that nothing was copied');
eq(S.importEntries([{ key: 'own-sneaked-in', id: null, record: { title: 'Imported' } }]), null, 'importEntries refuses on the demo');
eq(typeof S.save, 'undefined', 'save is private, so nothing outside state.js can write the shelf');
eq(S.whose('yours', 'on this shelf'), 'on this shelf', "the demo never calls the maintainer's books yours");

eq(JSON.stringify(S.state.entries), before, 'no demo entry changed');
eq(shelfWrites().length, 0, "the visitor's saved shelf was never written");
eq(shelfReads(), 0, 'nor read');
eq(announced('vitrina:read-only'), 5, 'each of the five refused edits is announced');

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
S.hydrate(library, 'shelf');
eq(S.state.readOnly, false, 'your own shelf is editable');
eq(S.state.source, 'local', 'and it is the shelf kept in this browser');
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
eq(S.state.entries.length, library.length, 'starting from the demo copies it in');
eq(S.storedShelfSize(), library.length, 'another tab reads the copied shelf from storage');
eq(shelfWrites().length > 0, true, 'and that copy is saved');
// It brings the demo's shelf labels and nothing else of the maintainer's. It used
// to keep his note and listed_as, and a browser shelf can move to an account
// later, where they would have arrived on a visitor's account shelf as theirs.
const MAINTAINERS = ['Bolsillo, the maintainer calls it', "the maintainer's own copy", 'a note in the catalogue record'];
const copied = S.findEntry('tf103') || {};
eq([copied.shelf, copied.note, copied.listed_as], ['B de Bolsillo', null, null], "a book copied from the demo keeps its shelf label and none of the maintainer's note or listed_as");
eq(MAINTAINERS.filter((text) => (store.get(SHELF) || '').includes(text)), [], 'and storage holds none of them, on an entry or inside its record');
const seededShelf = (() => { try { return JSON.parse(store.get(SHELF)).entries; } catch (err) { return []; } })();
const sentLater = P.normaliseBrowserShelf(seededShelf, P.indexById(library), null, () => '00000000-0000-4000-8000-000000000000').map(P.toServerEntry);
eq([sentLater.length, sentLater.filter((e) => !e || e.note !== null || e.listedAs !== null).length], [library.length, 0],
  'so moving that shelf to an account later sends no note or listed_as with any of its books');
eq(S.addEntry({ id: 555, title: 'Mine' }) !== null, true, 'adding works on your own shelf');
const byHand = S.addEntry({ id: null, title: 'Added by hand' }) || {};
eq(OWN_UUID.test(byHand.key), true, 'a book added by hand is keyed own- and a random UUID');
eq((storedKeys() || []).includes(byHand.key), true, 'and saved under that key');
eq(S.importEntries([
  { key: 'own-file-1', id: null, record: { title: 'From a file' } },
  { key: 'own-file-1', id: null, note: 'the second copy had a note', record: { title: 'From a file' } },
]), { added: 1, skipped: 1 }, 'importing into the browser shelf replaces it, copies sharing a key collapsed first');
eq([S.state.entries.map((e) => e.key), storedKeys(), noteOf('own-file-1')], [['own-file-1'], ['own-file-1'], 'the second copy had a note'],
  'so memory and storage hold that book once, with the note either copy had');

// A page with no mode, or a mode nobody wrote, is your shelf. Read-only is
// something a page has to ask for by name.
S.hydrate(library);
eq(S.state.readOnly, false, 'no mode means your own shelf');
S.hydrate(library, 'banana');
eq(S.state.readOnly, false, 'an unknown mode is never read-only by accident');

// ── An account shelf never reaches this browser's storage ───────────────────
const MARKER = `account-only-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const ACCOUNT_ONLY = ['listedAs', 'catalogId', 'clerkSubject', 'updatedAt'];
const leaks = (value) => value !== null && (value.includes(MARKER) || ACCOUNT_ONLY.some((field) => value.includes(`"${field}"`)));

store.set(SHELF, JSON.stringify({ v: 1, entries: [{ key: 'tf7', id: 7, note: 'kept in this browser', record: { id: 7, title: 'Browser book' } }] }));
S.hydrate(library, 'shelf');
eq(S.state.entries.map((e) => e.key), ['tf7'], 'signed out, /shelf/ shows the browser shelf');

const calls = [];
const adapter = {
  add: (entry) => { calls.push(['add', entry.key]); return Promise.resolve({ ok: true }); },
  remove: (key) => { calls.push(['remove', key]); return Promise.resolve({ ok: true }); },
  update: (key, patch) => { calls.push(['update', key, Object.keys(patch)]); return Promise.resolve({ ok: true }); },
  addMany: (entries, opts) => { calls.push(['addMany', opts && opts.kind, entries.map((e) => e.key)]); return Promise.resolve({ ok: true }); },
};
S.setPersistence(adapter);
const generation = S.state.generation;
const baseline = shelfWrites().length;

eq(S.useAccountShelf([{ key: 'tf101', id: 101, slug: null, shelf: 'Leídos', note: MARKER, listed_as: 'as the account lists it', added: '2026-09-01', record: { id: 101, title: 'Demo one' } }]), true,
  'signed in, the account shelf takes the place of the browser shelf in memory');
eq(S.state.source, 'account', 'the source is the account');
eq(S.state.generation > generation, true, 'and the generation moved with it');
eq(S.state.entries[0].note, MARKER, 'memory holds the account row, marker and all');

eq(S.addEntry({ id: 102, title: 'Demo two' }) !== null, true, 'a catalogue book can be added to the account shelf');
const accountHand = S.addEntry({ id: null, title: 'Added by hand to the account' }) || {};
eq(OWN_UUID.test(accountHand.key), true, 'and a book added by hand, keyed own- and a UUID');
eq(S.updateEntry('tf101', { note: `${MARKER} edited` }) !== null, true, 'a note on the account shelf can be edited');
eq(S.removeEntry('tf102'), true, 'a book can be taken off');
eq(S.restoreSeed(), true, 'starting from the demo reports success on the account');
const seeded = S.findEntry('tf103') || { record: { listed_as: 'missing', note: 'missing', note_mine: 'missing', shelf: 'missing' } };
eq([seeded.note, seeded.listed_as, seeded.added, seeded.shelf], [null, null, null, 'B de Bolsillo'],
  'a book from the demo brings its shelf label and no note, listed_as or date');
eq(['listed_as', 'note', 'note_mine', 'shelf'].filter((field) => field in seeded.record), [],
  "nor any of the maintainer's own fields inside its record");
eq(noteOf('tf101'), `${MARKER} edited`, 'the demo replaces nothing the account shelf already holds');
eq(S.importEntries([
  { key: 'own-import-1', id: null, record: { title: 'From a file' } },
  { key: 'own-import-1', id: null, note: 'the second copy had a note', record: { title: 'From a file' } },
  { key: 'tf101', id: 101, note: 'from the file', record: { id: 101, title: 'Demo one' } },
]), { added: 1, skipped: 2 }, 'importing into an account only adds what it lacks');
eq(noteOf('tf101'), `${MARKER} edited`, 'and overwrites nothing');
eq(noteOf('own-import-1'), 'the second copy had a note', 'copies sharing a key collapse, keeping a note either had');

eq(calls.map((c) => c[0]), ['add', 'add', 'update', 'remove', 'addMany', 'addMany'], 'every edit went to the account adapter');
const batches = calls.filter((c) => c[0] === 'addMany');
eq(batches.map((c) => c[1]), ['seed', 'import'], 'which is told what kind of batch it is');
eq((batches[0] ? batches[0][2] : []).slice().sort(), ['tf102', 'tf103'], 'and a seed sends only the demo books the account lacked');
eq(batches[1] ? batches[1][2] : null, ['own-import-1'], 'and an import only the books the account lacked, not tf101 with the note from the file');
eq(shelfWrites().length - baseline, 0, 'while the account shelf is shown, not one edit wrote vitrina_shelf_v1');

eq(S.rewriteBrowserShelf((stored) => stored.concat([{ key: 'own-browser-2', id: null, record: { title: 'Also in this browser' } }])), true,
  'the stored browser shelf can be rewritten while the account shelf is shown');
eq(shelfWrites().length - baseline, 1, 'with exactly one write');
eq(storedKeys(), ['tf7', 'own-browser-2'], 'holding what storage held plus the change, and nothing from memory');
eq(S.state.source === 'account' && noteOf('tf101') === `${MARKER} edited`, true, 'memory still holds the account shelf');
eq(S.rewriteBrowserShelf((stored) => stored), true, 'a rewrite that changes nothing succeeds');
eq(shelfWrites().length - baseline, 1, 'and writes nothing');
eq(S.clearBrowserShelf(), true, "clearing this browser's copy succeeds");
eq([shelfWrites().length - baseline, store.has(SHELF)], [2, false], 'and removes the key');
eq(S.findEntry('tf101') !== null, true, 'without touching the account shelf in memory');

// Loading, failed, or nowhere to send an edit: every edit is refused.
eq(S.useAccountLoading(), true, 'an account shelf can be on its way');
eq([S.state.source, S.state.entries.length], ['account-loading', 0], 'and while it loads memory holds no shelf, the browser one least of all');
const notReady = announced('vitrina:shelf-not-ready');
eq(S.addEntry({ id: 104, title: 'Too early' }), null, 'addEntry refuses while the account shelf loads');
eq(S.removeEntry('tf101'), false, 'so does removeEntry');
eq(S.updateEntry('tf101', { note: 'too early' }), null, 'and updateEntry');
eq(S.restoreSeed(), false, 'and restoreSeed');
eq(S.importEntries([{ key: 'own-early-1', id: null, record: { title: 'Early' } }]), null, 'and importEntries');
eq(announced('vitrina:shelf-not-ready') - notReady, 5, 'each refusal is announced');
eq(S.useAccountError(), true, 'an account shelf can fail to load');
eq([S.state.source, S.state.entries.length, S.addEntry({ id: 104, title: 'After a failure' })], ['account-error', 0, null],
  'and then the page shows no shelf in its place and refuses edits');
S.setPersistence(null);
S.useAccountShelf([{ key: 'tf101', id: 101, note: MARKER, record: { id: 101, title: 'Demo one' } }]);
eq(S.addEntry({ id: 104, title: 'Nowhere to go' }), null, 'an account shelf with no adapter refuses edits');
S.setPersistence({ add() {} });
eq(S.addEntry({ id: 104, title: 'Half an adapter' }), null, 'and so does one whose adapter is missing a method');
eq(calls.length, 6, 'no refused edit reached the adapter');
eq(shelfWrites().length - baseline, 2, 'nor storage');

// While an account shelf is on its way or failed, memory holds no shelf, and
// rewriting or clearing the stored browser shelf does not put that one there.
for (const [enter, waiting] of [[S.useAccountLoading, 'account-loading'], [S.useAccountError, 'account-error']]) {
  const generationBefore = S.state.generation;
  enter();
  S.rewriteBrowserShelf(() => [{ key: 'tf7', id: 7, note: 'kept in this browser', record: { id: 7, title: 'Browser book' } }]);
  const afterRewrite = S.state.entries.length;
  S.clearBrowserShelf();
  eq([S.state.source, S.state.generation > generationBefore, afterRewrite, S.state.entries.length], [waiting, true, 0, 0],
    `${waiting}: a new generation, and no shelf in memory when the stored one is rewritten or cleared`);
}

// Signed out again: the browser shelf, straight from storage.
S.setPersistence(adapter);
store.set(SHELF, JSON.stringify({ v: 1, entries: [{ key: 'tf7', id: 7, record: { id: 7, title: 'Browser book' } }] }));
const generationAtSignOut = S.state.generation;
eq(S.useLocalShelf(), true, 'signing out returns to the browser shelf');
eq([S.state.source, S.state.entries.map((e) => e.key), S.state.generation > generationAtSignOut], ['local', ['tf7'], true],
  'read fresh from storage, under a new generation');
S.addEntry({ id: 104, title: 'Back in the browser' });
eq(calls.length, 6, 'an edit to the browser shelf never reaches the account adapter, even while one is installed');
eq(storedKeys(), ['tf7', 'tf104'], 'it is saved in this browser instead');

// A browser only ever used signed in has no shelf stored. Signing out there
// leaves memory empty, not holding the account shelf under the local source,
// where the next edit would save all of it.
S.useAccountShelf([{ key: 'tf101', id: 101, note: MARKER, record: { id: 101, title: 'Demo one' } }]);
store.delete(SHELF);
S.useLocalShelf();
eq([S.state.source, S.state.entries.map((e) => e.key)], ['local', []], 'with nothing stored, signing out shows an empty browser shelf');
S.addEntry({ id: 105, title: 'First book kept in this browser' });
eq(storedKeys(), ['tf105'], 'and the first edit saves that book alone');

// A shelf with a null in it is built before the source moves. A null in the
// stored shelf, or a row fromServerEntry could not read, used to throw after the
// source had changed, leaving the other shelf in memory under it.
const attempt = (fn) => { try { return fn(); } catch (err) { return `threw: ${err.message}`; } };
const BROWSER_BOOK = { key: 'tf7', id: 7, note: 'kept only in this browser', record: { id: 7, title: 'Browser book' } };
S.useAccountShelf([{ key: 'tf101', id: 101, note: MARKER, record: { id: 101, title: 'Demo one' } }]);
store.set(SHELF, JSON.stringify({ v: 1, entries: [null, BROWSER_BOOK] }));
eq(attempt(() => S.useLocalShelf()), true, 'a null in the stored shelf does not stop a sign-out');
eq([S.state.source, S.state.entries.map((e) => e.key)], ['local', ['tf7']], 'which shows the stored books around it and nothing of the account');
S.addEntry({ id: 106, title: 'After a null' });
eq(storedKeys(), ['tf7', 'tf106'], 'and the next edit saves only those');
store.set(SHELF, JSON.stringify({ v: 1, entries: [null, BROWSER_BOOK] }));
eq(attempt(() => { S.hydrate(library, 'shelf'); return S.state.entries.map((e) => e.key); }), ['tf7'], 'nor does it stop /shelf/ from opening');

store.set(SHELF, JSON.stringify({ v: 1, entries: [BROWSER_BOOK] }));
S.useLocalShelf();
const callsBefore = calls.length;
const unreadable = [
  { key: 'tf101', id: 101, shelf: 'Leídos', note: MARKER, listedAs: null, added: null, record: null },
  { key: 'imp0', id: null, record: { title: 'In neither grammar' } },
];
eq(attempt(() => S.useAccountShelf(unreadable.map((row) => P.fromServerEntry(row, P.indexById(library), null)))), true,
  'a row fromServerEntry cannot read does not stop the account shelf from showing');
eq([S.state.source, S.state.entries.map((e) => e.key)], ['account', ['tf101']], 'which holds the rows it could read and nothing of the browser shelf');
S.updateEntry('tf101', { note: `${MARKER} again` });
S.removeEntry('tf7');
eq(calls.slice(callsBefore), [['update', 'tf101', ['note']]], 'so an edit reaches the account adapter only for an account book');

eq(shelfWrites().filter((w) => leaks(w.value)).length, 0, 'no write to vitrina_shelf_v1 in this whole run held the account note or an account-only field');
eq(shelfWrites().length > 0, true, 'and there were writes to look at');

// ── A shared shelf (/u/) ────────────────────────────────────────────────────
store.set(PREFS, JSON.stringify({ view: 'covers', showRuns: true, shortcuts: true }));
const readsBefore = shelfReads();
const writesBefore = shelfWrites().length;
const refusalsBefore = announced('vitrina:read-only');
// /u/ shows the books it was given and nothing else. Given none, or an empty
// list, it is an empty shelf, never a reason to read the browser shelf, which
// is stored right now.
S.hydrate(library, 'profile');
const givenNothing = S.state.entries.length;
S.hydrate(library, 'profile', []);
eq([givenNothing, S.state.entries.length, shelfReads() - readsBefore], [0, 0, 0],
  'a shared shelf given no books, or an empty list, shows none and reads no stored shelf');
const generationAtProfile = S.state.generation;
S.hydrate(library, 'profile', [{ key: 'tf101', id: 101, shelf: 'Nova', record: { id: 101, title: 'Demo one' } }, null]);
eq(S.state.generation > generationAtProfile, true, 'opening a page moves the generation too');
eq([S.state.mode, S.state.readOnly, S.state.source], ['profile', true, 'profile'], 'a shared shelf is read-only');
eq(S.state.entries.map((e) => e.key), ['tf101'], 'and shows the books it was given, not the browser shelf');
eq([S.state.view, S.state.showRuns], ['shelf', false], 'it opens on the shelf view, without the whole collection');
eq(JSON.parse(store.get(PREFS)), { view: 'covers', showRuns: true, shortcuts: true }, 'for this visit only: the saved preferences are untouched');

eq(S.addEntry({ id: 999, title: 'Sneaked in' }), null, 'addEntry refuses on a shared shelf');
eq(S.removeEntry('tf101'), false, 'so does removeEntry');
eq(S.updateEntry('tf101', { note: 'scribbled' }), null, 'and updateEntry');
eq(S.restoreSeed(), false, 'and restoreSeed');
eq(S.importEntries([{ key: 'own-sneaked-in', id: null, record: { title: 'Imported' } }]), null, 'and importEntries');
eq(announced('vitrina:read-only') - refusalsBefore, 5, 'each refusal is announced');
eq(S.rewriteBrowserShelf(() => []), false, 'the stored browser shelf cannot be rewritten from a shared shelf');
eq(S.clearBrowserShelf(), false, 'nor cleared');
eq([S.useAccountShelf([]), S.useLocalShelf(), S.useAccountLoading(), S.useAccountError()], [false, false, false, false],
  'nor can a shared shelf be swapped for an account or browser shelf');
eq(S.storedShelfSize(), 0, 'and it reports no stored shelf');
S.state.view = 'browse';
S.state.showRuns = true;
S.savePrefs();
eq(JSON.parse(store.get(PREFS)).view, 'covers', "arranging a shared shelf does not move your own shelf's view");
eq(shelfReads() - readsBefore, 0, 'the shared shelf never read vitrina_shelf_v1');
eq(shelfWrites().length - writesBefore, 0, 'nor wrote it');
eq(S.state.entries.map((e) => e.key), ['tf101'], 'its books are unchanged');
eq(S.whose('yours', 'on this shelf'), 'on this shelf', "a shared shelf is not the visitor's either");

eq([...S.MODES], ['shelf', 'demo', 'profile'], 'the modes a page may declare');
eq([...S.READ_ONLY_MODES], ['demo', 'profile'], 'and the two of them that are read-only');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
