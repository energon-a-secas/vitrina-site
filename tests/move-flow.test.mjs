// Plain node, no install. Run with: make validate
//
// js/strips.js offers a browser shelf's books to the account, moves them only
// when asked, and clears this browser's copy only of what the account holds in
// full. It also keeps two flags that name nobody: the keys of books that moved
// (vitrina_moved_v1, in localStorage) and Not now (vitrina_move_later_v1, in
// sessionStorage). None of it fails loudly: a note cleared from the only browser
// that had it, a list of what somebody moved left on a shared browser, or an
// offer hidden from the next person to sign in all look like a working page.
// This runs strips.js and account.js on the generated /shelf/ page, against the
// fakes in tests/support/shelfworld.mjs.

import { openShelf, row, stored, CATALOG, checker } from './support/shelfworld.mjs';

const t = checker();
const eq = t.eq;
const strip = (w) => w.text('[data-account-strip]');
const storedKeys = (w) => (w.stored() || []).map((e) => e.key);
const refused = (code) => ({ ok: false, code, message: `refused: ${code}` });
const movedKeys = (w) => JSON.parse(w.local.get('vitrina_moved_v1') || 'null');
const OFFER_ONE = 'This browser has 1 book that is not in your account.';

// ── Moving a browser shelf ──────────────────────────────────────────────────
{
  const w = await openShelf({ shelf: [stored(101, { note: 'from the flea market' }), stored(102)] });
  w.server.seed('u1', []);
  await w.kit.signIn('u1');
  await w.flush();
  eq((strip(w) || '').startsWith('This browser has 2 books that are not in your account.'), true, 'the browser books the account lacks are offered');
  eq(w.server.calls('shelf:upsertEntries').length, 0, 'and nothing is uploaded before the person says so');
  w.server.answer('shelf:upsertEntries', refused('rate-limited'), { user: 'u1' });
  w.$('[data-strip="move"]').click();
  await w.flush();
  eq(w.local.has('vitrina_moved_v1'), false, 'a chunk the account refused records no key as moved');
  const upload = w.server.hold('shelf:upsertEntries', { user: 'u1' });
  w.$('[data-strip="move"]').click();
  await w.flush();
  eq(w.local.has('vitrina_moved_v1'), false, 'nor does one the account has not answered yet');
  upload.release();
  await w.flush();
  eq(JSON.parse(w.local.get('vitrina_moved_v1') || '[]').sort(), ['tf101', 'tf102'], 'once it took the chunk, its keys are recorded, and keys only');
}
{
  const w = await openShelf({ shelf: CATALOG.slice(0, 201).map((r) => stored(r.id, { shelf: 'Catalogue' })) });
  w.server.seed('u1', []);
  await w.kit.signIn('u1');
  await w.flush();
  const first = w.server.hold('shelf:upsertEntries', { user: 'u1' });
  w.$('[data-strip="move"]').click();
  await w.flush();
  await w.kit.signOut();
  await w.flush();
  first.release();
  await w.flush();
  eq([w.server.calls('shelf:upsertEntries').length, w.local.has('vitrina_moved_v1')], [1, false],
    'a sign-out halfway through a move sends no further chunk and records nothing as moved');
}

// ── What Done clears ────────────────────────────────────────────────────────
{
  const NOTE = 'signed by the author, bought in Valparaiso';
  const LONG = 'A note longer than an account keeps. '.repeat(40);
  const w = await openShelf({ shelf: [stored(101, { shelf: 'Nova', note: NOTE }), stored(102, { shelf: 'VIB' }), stored(103, { shelf: 'B de Bolsillo', note: LONG })] });
  w.server.seed('u1', [row(101, { shelf: 'Nova' })]);
  await w.kit.signIn('u1');
  await w.flush();
  eq((strip(w) || '').includes('1 book here has notes or labels your account lacks.'), true, 'a book the account holds without its note is offered for filling in');
  w.$('[data-strip="move"]').click();
  await w.flush();
  const box = w.$('#stripClear');
  eq([(strip(w) || '').startsWith('Added 2 books.'), Boolean(box && box.checked)], [true, true], "after a move, Clear this browser's copy is offered and checked, as the plan has it");
  eq(Boolean(w.$('[data-strip="fill"]')), true, 'with the offer to fill in the missing note still beside it');
  w.$('[data-strip="done"]').click();
  await w.flush();
  const kept = w.stored() || [];
  eq(kept.map((e) => e.key), ['tf101', 'tf103'], 'Done keeps in this browser the books the account lacks a note for: one never filled in, one longer than the account keeps');
  eq([kept.length === 2 && kept[0].note === NOTE, kept.length === 2 && kept[1].note === LONG], [true, true], 'each with its whole note');
  eq(w.toasts().pop(), "This browser's copy is cleared, except 2 books your account does not hold in full.", 'and the toast says what stayed');
  eq(movedKeys(w), ['tf103'], 'the moved list keeps only the moved books still here, so tf102 left it with its copy');
  const fill = w.$('[data-strip="fill"]');
  if (fill) fill.click();
  await w.flush();
  eq((w.server.account('u1').rows.get('tf101') || {}).note, NOTE, 'from where the note can still be filled in');
}
{
  const w = await openShelf({ shelf: [stored(102, { shelf: 'VIB' })] });
  w.server.seed('u1', []);
  await w.kit.signIn('u1');
  await w.flush();
  w.$('[data-strip="move"]').click();
  await w.flush();
  w.$('[data-strip="done"]').click();
  await w.flush();
  eq([w.local.has('vitrina_shelf_v1'), w.toasts().pop()], [false, "This browser's copy is cleared"], 'a browser copy the account holds all of is cleared');
}
{
  const w = await openShelf({ shelf: [stored(102, { shelf: 'VIB' })] });
  w.server.seed('u1', []);
  await w.kit.signIn('u1');
  await w.flush();
  w.$('[data-strip="move"]').click();
  await w.flush();
  w.server.fail('shelf:mine', { user: 'u1', times: 2 });
  w.$('[data-strip="done"]').click();
  await w.flush();
  eq([storedKeys(w), w.toasts().pop()], [['tf102'], "This browser's copy is kept, because your account could not be checked."],
    'and when the account cannot be read at Done, nothing is cleared');
}

// ── Two flags that name nobody ──────────────────────────────────────────────
{
  const w = await openShelf({ shelf: [stored(102)] });
  w.local.set('vitrina_moved_v1', JSON.stringify(['tf102', 'tf555']));
  w.server.seed('u1', []);
  await w.kit.signIn('u1');
  await w.flush();
  eq(movedKeys(w), ['tf102'], 'when an account shelf arrives, the moved list is cut down to the books still in this browser');
}
{
  const OWN = { key: 'own-3f1c2a9e-1111-4a4a-8b8b-000000000001', id: null, slug: null, shelf: 'Mine', note: null, listed_as: null, added: null, record: { id: null, title: 'Diario de mi abuela' } };
  const a = await openShelf({ shelf: [stored(102, { shelf: 'VIB' }), OWN] });
  a.server.seed('u1', []);
  await a.kit.signIn('u1');
  await a.flush();
  a.$('[data-strip="move"]').click();
  await a.flush();
  eq(movedKeys(a), ['tf102', OWN.key], 'a move records the keys of a catalogue book and a hand-added one');
  a.$('[data-strip="done"]').click();
  await a.flush();
  eq([a.local.has('vitrina_shelf_v1'), a.local.has('vitrina_moved_v1')], [false, false],
    "Clear this browser's copy takes the moved keys with the books, leaving no list of what was moved");
  // The same browser after a reload: somebody puts one of those editions back on its shelf and signs in.
  const b = await openShelf({ reloadOf: a, shelf: [stored(102, { shelf: 'VIB' })] });
  b.server.seed('u2', []);
  await b.kit.signIn('u2');
  await b.flush();
  eq((strip(b) || '').startsWith(OFFER_ONE), true, 'so that edition is offered to whoever signs in there next');
}
{
  const w = await openShelf({ shelf: [stored(102, { shelf: 'VIB' })] });
  w.server.seed('u1', [row(101)]);
  w.server.seed('u2', []);
  await w.kit.signIn('u1');
  await w.flush();
  w.$('[data-strip="later"]').click();
  await w.flush();
  eq([strip(w), w.session.get('vitrina_move_later_v1')], ['', '1'], 'Not now puts the offer away for the tab');
  await w.kit.signIn('u2');
  await w.flush();
  eq((strip(w) || '').startsWith(OFFER_ONE), true, 'and somebody else signing in on that page is offered the book, whoever said Not now');
}
{
  const a = await openShelf({ shelf: [stored(102, { shelf: 'VIB' })] });
  a.server.seed('u1', [row(101)]);
  await a.kit.signIn('u1');
  await a.flush();
  a.$('[data-strip="later"]').click();
  await a.flush();
  // Sign out reloads the page, which opens in the same tab with nobody signed in.
  const b = await openShelf({ reloadOf: a });
  await b.kit.signOut();
  await b.flush();
  eq(b.session.has('vitrina_move_later_v1'), false, 'a page that settles with nobody signed in forgets the Not now said in its tab');
  b.server.seed('u2', []);
  await b.kit.signIn('u2');
  await b.flush();
  eq((strip(b) || '').startsWith(OFFER_ONE), true, 'so the next person to sign in there is offered the browser book');
}

async function movedAndKept(profile = null) {
  const w = await openShelf({ shelf: [stored(102, { shelf: 'VIB' })] });
  w.server.seed('u1', [], profile);
  await w.kit.signIn('u1');
  await w.flush();
  w.$('[data-strip="move"]').click();
  await w.flush();
  const box = w.$('#stripClear');
  box.checked = false;
  await w.fire(box, 'change');
  w.$('[data-strip="done"]').click();
  await w.flush();
  return w;
}
{
  const w = await movedAndKept({ handle: 'ana' });
  eq([storedKeys(w), movedKeys(w)], [['tf102'], ['tf102']], 'a move kept in this browser leaves its key in the moved list');
  const share = await w.import('share.js');
  await share.openShare(w.$('#shareBtn'));
  await w.flush();
  // The shelf behind the dialog cannot read the account just then, so only the dialog knows of the deletion.
  w.server.fail('shelf:mine', { user: 'u1', times: 2 });
  w.$('[data-share-act="delete"]').click();
  await w.flush();
  eq(w.local.has('vitrina_moved_v1'), false, 'Delete my Vitrina data forgets the moved list once the account has taken it');
  w.server.finishErasing('u1');
  await w.visible();
  eq((strip(w) || '').startsWith(OFFER_ONE), true, 'so the emptied account is offered the browser book again');
}
{
  const w = await movedAndKept();
  w.server.erase('u1');
  await w.visible();
  eq([(strip(w) || '').startsWith('Your Vitrina data is being deleted.'), w.local.has('vitrina_moved_v1')], [true, false],
    'an account deleted from another tab or device forgets the moved list as soon as this page sees the deletion');
  w.server.finishErasing('u1');
  await w.advance(8000);
  eq((strip(w) || '').startsWith(OFFER_ONE), true, 'and the emptied account is offered the browser book');
}

// ── A move whose answer was lost ────────────────────────────────────────────
{
  const w = await openShelf({ shelf: [stored(101, { shelf: 'Nova' }), stored(102, { shelf: 'VIB' })] });
  w.server.seed('u1', []);
  await w.kit.signIn('u1');
  await w.flush();
  w.server.lose('shelf:upsertEntries', { user: 'u1' });
  w.$('[data-strip="move"]').click();
  await w.flush();
  eq([w.server.calls('shelf:upsertEntries').length, w.server.keys('u1').sort()], [2, ['tf101', 'tf102']],
    'a move whose answer was lost after the account took it goes out again, and the retry finds both books there');
  eq((strip(w) || '').startsWith('Added 2 books.'), true, 'and the strip says it added them, not "Added 0 books."');
}

t.done();
