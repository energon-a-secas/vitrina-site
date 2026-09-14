// Plain node, no install. Run with: make validate
//
// js/account.js and js/strips.js decide whose shelf /shelf/ shows, where each
// edit goes and what a move leaves behind. None of it fails loudly: a stale
// answer painted over a newer shelf, a book sent to the next person's account,
// or a note cleared from the only browser that had it all look like a working
// page. tests/accountplan.test.mjs holds the pure rules; this runs the modules
// themselves on the generated /shelf/ page, against a fake deployment and a
// fake Auth Kit that behave like the real ones where it decides an outcome
// (tests/support/shelfworld.mjs).

import { openShelf, row, stored, LIBRARY, checker } from './support/shelfworld.mjs';

const t = checker();
const eq = t.eq;
const strip = (w) => w.text('[data-account-strip]');
const storedKeys = (w) => (w.stored() || []).map((e) => e.key);
const refused = (code) => ({ ok: false, code, message: `refused: ${code}` });
const SESSION = '__client_uat=1757000000';

// ── Whose shelf ─────────────────────────────────────────────────────────────
{
  const w = await openShelf({ shelf: [stored(102)] });
  eq([w.S.state.source, w.keys(), w.clients.length], ['local', ['tf102'], 0],
    'with no session cookie, /shelf/ opens on the browser shelf and fetches no Convex client');
  w.server.seed('u1', [row(101)]);
  w.server.answer('shelf:mine', null, { user: 'u1' });
  await w.kit.signIn('u1');
  await w.flush();
  eq([w.S.state.source, w.keys()], ['account-error', []], 'a null shelf:mine while the kit says signed in is a failed load, never the browser shelf');
  eq((strip(w) || '').startsWith('Your account shelf could not be loaded.'), true, 'and the strip says so');
  w.$('[data-strip="retry-load"]').click();
  await w.flush();
  eq([w.S.state.source, w.keys()], ['account', ['tf101']], 'Try again loads the account shelf');
  await w.kit.signOut();
  await w.flush();
  eq([w.S.state.source, w.keys()], ['local', ['tf102']], 'signed out without a reload, the page shows the browser shelf and nothing of the account');
  eq((strip(w) || '').startsWith('You were signed out, so this is the shelf kept in this browser.'), true, 'under the signed-out strip');
}
{
  const w = await openShelf();
  w.server.seed('u1', [row(101)]);
  w.server.seed('u2', [row(103)]);
  const late = w.server.hold('shelf:mine', { user: 'u1' });
  await w.kit.signIn('u1');
  await w.flush();
  await w.kit.signIn('u2');
  await w.flush();
  late.release();
  await w.flush();
  eq([w.S.state.source, w.keys()], ['account', ['tf103']], "one person's shelf:mine that lands after somebody else signed in is dropped");
}

// ── Refetches and writes ────────────────────────────────────────────────────
{
  const w = await openShelf();
  w.server.seed('u1', [row(101), row(102)]);
  await w.kit.signIn('u1');
  await w.flush();
  const early = w.server.hold('shelf:mine', { user: 'u1' });
  await w.visible();
  w.S.removeEntry('tf101');
  await w.flush();
  early.release();
  await w.flush();
  eq(w.keys(), ['tf102'], 'a refetch that went out before a write is not applied over it');
  eq(w.server.calls('shelf:mine').length, 3, 'and it is asked again once the write has settled');

  const slow = w.server.hold('shelf:removeEntry', { user: 'u1' });
  w.S.removeEntry('tf102');
  await w.flush();
  const asked = w.server.calls('shelf:mine').length;
  await w.visible();
  eq(w.server.calls('shelf:mine').length - asked, 0, 'a refetch wanted while a write is pending waits for it');
  slow.release();
  await w.flush();
  eq([w.server.calls('shelf:mine').length - asked, w.keys()], [1, []], 'and goes out once the write has settled');
}
{
  const w = await openShelf({ shelf: [stored(102)] });
  w.server.seed('u1', [row(101)]);
  await w.kit.signIn('u1');
  await w.flush();
  const answer = w.server.hold('shelf:removeEntry', { user: 'u1', mode: 'answer', value: refused('rate-limited') });
  w.S.removeEntry('tf101');
  await w.flush();
  await w.kit.signOut();
  await w.flush();
  answer.release();
  await w.flush();
  eq([w.S.state.source, w.keys()], ['local', ['tf102']], 'a removal the account refused after a sign-out puts nothing back, and least of all into the browser shelf');
}
{
  const w = await openShelf();
  w.server.seed('u1', []);
  w.server.seed('u2', [row(103)]);
  await w.kit.signIn('u1');
  await w.flush();
  w.server.answer('shelf:upsertEntries', refused('rate-limited'), { user: 'u1' });
  w.S.addEntry(LIBRARY[1]);
  await w.flush();
  eq([w.keys(), strip(w)], [['tf102'], 'Not saved to your account: Demo two. Try again'], 'an add the account refused stays on the shelf as not saved');
  await w.kit.signIn('u2');
  await w.flush();
  eq([w.keys(), (strip(w) || '').includes('Not saved')], [['tf103'], false], "somebody else signing in keeps nothing of the last person's unsaved books");
}

// ── The order writes reach the account, and whose account ───────────────────
{
  const w = await openShelf({ mintDelay: 30 });
  w.server.seed('u1', []);
  await w.kit.signIn('u1');
  await w.flush();
  w.server.fail('shelf:upsertEntries', { user: 'u1' });
  w.S.addEntry(LIBRARY[0]);
  w.S.removeEntry('tf101');
  await w.advance(30);
  eq(w.server.mutations(), ['u1:shelf:upsertEntries(tf101)', 'u1:shelf:upsertEntries(tf101)', 'u1:shelf:removeEntry(tf101)'],
    'a write retried after a throw reaches the account before the write made after it');
  eq([w.server.keys('u1'), w.keys()], [[], []], 'so a book put on and taken straight off is off the account too');
}
{
  const w = await openShelf();
  w.server.seed('u1', []);
  w.server.seed('u2', []);
  await w.kit.signIn('u1');
  await w.flush();
  const lost = w.server.hold('shelf:upsertEntries', { user: 'u1', mode: 'throw' });
  w.S.addEntry(LIBRARY[0]);
  await w.flush();
  await w.kit.signIn('u2');
  await w.flush();
  lost.release();
  await w.flush();
  eq(w.server.mutations(), ['u1:shelf:upsertEntries(tf101)'], 'a write that failed after somebody else signed in is not retried as them');
  eq([w.kit.mints.filter((m) => m.skipCache).length, w.server.keys('u2')], [0, []], 'no token is minted past the cache for it, and their account gains nothing');
}
{
  const w = await openShelf();
  w.server.seed('u1', [row(101)]);
  w.server.seed('u2', []);
  await w.kit.signIn('u1');
  await w.flush();
  const slow = w.server.hold('shelf:updateEntry', { user: 'u1' });
  w.S.updateEntry('tf101', { note: 'mine' });
  await w.flush();
  w.S.addEntry(LIBRARY[1]);
  await w.flush();
  await w.kit.signIn('u2');
  await w.flush();
  slow.release();
  await w.flush();
  eq(w.server.mutations(), ['u1:shelf:updateEntry(tf101)'], 'a write queued before somebody else signed in never goes out once they have');
  eq(w.server.keys('u2'), [], "so one person's book never lands on the next person's account");
}
{
  // The kit swaps the session first and tells listeners only once the new token is minted.
  const w = await openShelf({ syncDelay: 50 });
  w.server.seed('u1', [row(101)]);
  w.server.seed('u2', []);
  const first = w.kit.signIn('u1');
  await w.advance(50);
  await first;
  await w.flush();
  const slow = w.server.hold('shelf:updateEntry', { user: 'u1' });
  w.S.updateEntry('tf101', { note: 'mine' });
  await w.flush();
  w.S.addEntry(LIBRARY[1]);
  await w.flush();
  const switching = w.kit.signIn('u2');
  await w.flush();
  slow.release();
  await w.flush();
  w.S.addEntry(LIBRARY[2]);
  await w.flush();
  await w.advance(50);
  await switching;
  await w.flush();
  eq(w.server.mutations(), ['u1:shelf:updateEntry(tf101)'], 'while the kit is between two people, a queued write is not sent, and neither is one made then');
  eq([w.S.state.source, w.server.keys('u2')], ['account', []], 'and the next person gets their own shelf with nothing of the last one on it');
}

// ── The same person under a new label, and a deletion ───────────────────────
{
  const w = await openShelf();
  w.server.seed('u1', [row(101)]);
  const load = w.server.hold('shelf:mine', { user: 'u1' });
  await w.kit.signIn('u1', 'ana');
  await w.flush();
  w.kit.relabel('Ana B');
  await w.flush();
  load.release();
  await w.flush();
  eq([w.S.state.source, w.keys()], ['account', ['tf101']], 'a new label for the person whose shelf is loading lets that load land');
}
{
  const w = await openShelf();
  w.server.seed('u1', [row(101), row(102), row(103)]);
  w.server.erase('u1');
  await w.kit.signIn('u1');
  await w.flush();
  eq(strip(w), 'Your Vitrina data is being deleted. Deleting your books: 3 left', 'an account being deleted shows how far it has got');
  w.kit.relabel('Ana B');
  await w.flush();
  w.server.finishErasing('u1');
  await w.advance(8000);
  eq([w.S.state.source, w.keys()], ['account', []], 'and its poll outlives a new label, reaching the empty shelf once the deletion is over');
}
{
  const w = await openShelf();
  w.server.seed('u1', []);
  await w.kit.signIn('u1');
  await w.flush();
  w.server.answer('shelf:upsertEntries', refused('rate-limited'), { user: 'u1' });
  w.S.addEntry(LIBRARY[0]);
  await w.flush();
  eq(strip(w), 'Not saved to your account: Demo one. Try again', 'an add the account refused is held as not saved');
  w.server.erase('u1');
  await w.visible();
  eq((strip(w) || '').startsWith('Your Vitrina data is being deleted.'), true, 'then the account data is deleted from somewhere else');
  w.server.finishErasing('u1');
  // That deletion had no books left to take, so the page asks at the sweep's pace.
  await w.advance(30000);
  eq([w.S.state.source, w.keys(), strip(w)], ['account', [], ''],
    'once the deletion is over, nothing made before it is laid back over the empty shelf or offered to send again');
}
{
  const w = await openShelf();
  w.server.seed('u1', []);
  await w.kit.signIn('u1');
  await w.flush();
  w.server.answer('shelf:upsertEntries', refused('rate-limited'), { user: 'u1' });
  w.S.addEntry(LIBRARY[0]);
  await w.flush();
  w.server.erase('u1');
  w.server.fail('shelf:mine', { user: 'u1', times: 2 });
  w.S.addEntry(LIBRARY[1]);
  await w.flush();
  eq(w.toasts().pop(), 'Your Vitrina data is being deleted.', 'a write refused because the account data is being deleted says so');
  w.server.finishErasing('u1');
  await w.visible();
  eq([w.S.state.source, w.keys(), strip(w)], ['account', [], ''], 'and drops what was held as not saved, even when the refetch after it failed');
}

// ── Waiting out a deletion ──────────────────────────────────────────────────
{
  const w = await openShelf();
  w.server.seed('u1', []);
  w.server.erase('u1');
  await w.kit.signIn('u1');
  await w.flush();
  const asked = w.server.calls('shelf:mine').length;
  await w.advance(5 * 60 * 1000);
  eq(w.server.calls('shelf:mine').length - asked, 10, 'with no books left to delete only the sweep is left, and the page asks every 30 s, not every 8 s');
}
{
  const w = await openShelf();
  w.server.seed('u1', [row(101), row(102)]);
  w.server.erase('u1');
  await w.kit.signIn('u1');
  await w.flush();
  w.doc.visibilityState = 'hidden';
  const asked = w.server.calls('shelf:mine').length;
  await w.advance(10 * 60 * 1000);
  eq(w.server.calls('shelf:mine').length - asked, 0, 'a hidden tab asks nothing while its data is being deleted');
  w.doc.visibilityState = 'visible';
  await w.visible();
  eq(w.server.calls('shelf:mine').length - asked, 1, 'and asks once as soon as it is shown again');
}
{
  const w = await openShelf();
  w.server.seed('u1', [row(101)]);
  w.server.erase('u1');
  await w.kit.signIn('u1');
  await w.flush();
  w.server.answer('shelf:mine', null, { user: 'u1', times: 5 });
  await w.advance(60 * 1000);
  eq([w.S.state.source, (strip(w) || '').startsWith('Your account shelf could not be loaded.')], ['account-error', true],
    'five answers in a row that say nothing about the deletion, as a refused token gives, end the asking in Try again');
  const asked = w.server.calls('shelf:mine').length;
  await w.advance(10 * 60 * 1000);
  eq(w.server.calls('shelf:mine').length - asked, 0, 'and nothing more is asked meanwhile');
  w.server.finishErasing('u1');
  w.$('[data-strip="retry-load"]').click();
  await w.flush();
  eq([w.S.state.source, w.keys()], ['account', []], 'Try again reads the account once more');
}

// ── Before the kit knows who is signed in ───────────────────────────────────
{
  const w = await openShelf({ cookie: SESSION, shelf: [stored(102)] });
  eq([w.S.state.source, w.keys()], ['account-loading', []], 'with a session somewhere on the fleet, /shelf/ shows no shelf until the kit says whose it is');
  eq(w.S.addEntry(LIBRARY[0]), null, 'and takes no edit meanwhile');
  eq(storedKeys(w), ['tf102'], 'so nothing lands in the browser shelf that the account shelf would then hide');
  await w.kit.signOut();
  await w.flush();
  eq([w.S.state.source, w.keys(), strip(w)], ['local', ['tf102'], ''], 'a session that settles signed out shows the browser shelf, with no signed-out strip');
  eq(w.S.addEntry(LIBRARY[0]) !== null, true, 'and takes edits again');
}
{
  const w = await openShelf({ cookie: SESSION, shelf: [stored(102)] });
  w.server.seed('u1', [row(103)]);
  await w.kit.signIn('u1');
  await w.flush();
  eq([w.S.state.source, w.keys()], ['account', ['tf103']], 'one that settles signed in goes straight on to the account shelf');
}
{
  const w = await openShelf({ cookie: SESSION, shelf: [stored(102)], kitLoadFails: true });
  eq([w.S.state.source, w.keys()], ['local', ['tf102']], 'and a kit that cannot load leaves the browser shelf working');
}

// ── A write whose answer was lost ───────────────────────────────────────────
{
  const w = await openShelf();
  w.server.seed('u1', []);
  await w.kit.signIn('u1');
  await w.flush();
  const M = await w.import('modals.js');
  w.server.lose('shelf:upsertEntries', { user: 'u1' });
  M.applyImport(JSON.stringify({ v: 1, entries: [stored(1001), stored(1002)] }));
  await w.flush();
  eq([w.server.calls('shelf:upsertEntries').length, w.server.keys('u1').sort()], [2, ['tf1001', 'tf1002']],
    'an import whose answer was lost after the account took it goes out again, and the retry finds both books there');
  eq(w.toasts().pop(), 'Added 2 books to your account.', 'so it says it added them, never that the account already had every book in the file');
}

// ── A note longer than an account keeps ─────────────────────────────────────
const LONG_NOTE = `${'a long note about where this copy came from. '.repeat(30)}and how it ends`;
function answering(...answers) {
  const asked = [];
  // Out of answers, the prompt is dismissed, so a page that keeps asking fails its count instead of hanging.
  globalThis.prompt = (question, value) => { asked.push({ question, value }); return answers.length ? answers.shift() : null; };
  return asked;
}
async function accountNote() {
  const w = await openShelf();
  w.server.seed('u1', [row(101)]);
  await w.kit.signIn('u1');
  await w.flush();
  w.D = await w.import('detail.js');
  return w;
}
{
  const w = await accountNote();
  const SHORT = LONG_NOTE.slice(0, 900).trim();
  const asked = answering(LONG_NOTE, SHORT);
  w.D.editNote('tf101');
  await w.flush();
  eq(asked.map((a) => a.value.length), [0, LONG_NOTE.length], 'on an account shelf a note longer than the account keeps comes back, whole, to be shortened');
  eq((asked[1] || {}).question, `A note on your account shelf holds at most 1000 characters; this one has ${LONG_NOTE.length}. Shorten it to save it:`,
    'with the reason in the prompt, where the person is looking');
  eq(w.server.calls('shelf:updateEntry').map((c) => c.args.note), [SHORT], 'only the shortened note goes out, never the long one cut to fit');
  eq(w.toasts().pop(), 'Note saved', 'and Note saved is said of the note that was saved');
}
{
  const w = await accountNote();
  answering(LONG_NOTE, null);
  w.D.editNote('tf101');
  await w.flush();
  eq([w.server.calls('shelf:updateEntry').length, w.toasts().includes('Note saved'), w.S.state.entries[0].note], [0, false, null],
    'cancelled instead, nothing is saved, in memory or the account, and nothing says it was');
}
{
  const w = await accountNote();
  const asked = answering(LONG_NOTE, LONG_NOTE, LONG_NOTE);
  w.D.editNote('tf101');
  await w.flush();
  eq([asked.length, w.server.calls('shelf:updateEntry').length, w.toasts().pop()],
    [2, 0, `A note on your account shelf holds at most 1000 characters; this one has ${LONG_NOTE.length}. It was not saved.`],
    'handed back unchanged, the note is refused and not asked for again, so a prompt answered with what it offered cannot keep the page asking');
}
{
  const w = await openShelf({ shelf: [stored(101)] });
  const D = await w.import('detail.js');
  answering(LONG_NOTE);
  D.editNote('tf101');
  await w.flush();
  eq(((w.stored() || [])[0] || {}).note, LONG_NOTE, 'the browser shelf keeps a note of any length');
}

t.done();
