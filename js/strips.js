// ── The strips above /shelf/, and moving a browser shelf into an account ─────
//
// /shelf/ carries one live region above the controls, which scripts/routes.py
// writes empty. account.js tells this module what it has to say there: that
// the person was signed out without a reload, that the account shelf could not
// be loaded, that its data is being deleted, or that some changes did not reach
// it. The strip offering a browser shelf's books to the account is this
// module's own, because moving them is never automatic (plan section 3.1): it
// counts, offers, uploads only when asked, and then offers to clear this
// browser's copy, which takes only the books the account holds in full.
//
// Nothing from an account is written to storage here. vitrina_moved_v1 holds
// keys of books that left this browser's shelf, and no name, note or account id,
// and only while those books are still on it. Neither it nor Not now says whose
// it was, so each is dropped along with its person: Not now once nobody or
// somebody else is signed in, the moved keys once the account's data is deleted.

import { state, rewriteBrowserShelf, clearBrowserShelf } from './state.js';
import { FN } from './backend.js';
import { normaliseBrowserShelf, indexById, toServerEntry } from './syncplan.js';
import { stripCounts, uploadInChunks, failedIndex, failureCopy, batchToast, listTitles, deletionCopy, booksToKeep } from './accountplan.js';
import { session } from './session.js';
import { title } from './data.js';
import { $, escHtml, toast, plural, mintUuid } from './utils.js';

const MOVED = 'vitrina_moved_v1';
const LATER = 'vitrina_move_later_v1';

let actions = { signIn() {}, retryLoad() {}, retryUnsaved() {} };
let facts = { signedOut: null, erasing: null, unsaved: [] };
let browser = null;          // the browser shelf as normalised when the account shelf arrived
let move = { phase: 'offer' };   // offer, moving, filling, moved, clearing or stopped
let hands = 0;               // moves in forgetMove, so a Done still reading the account paints nothing after it
let laterHere = false;
let painted = '';

export function bindStrips(callbacks) {
  actions = { ...actions, ...callbacks };
  const root = $('[data-account-strip]');
  if (!root) return;
  root.addEventListener('click', (ev) => {
    const button = ev.target.closest('[data-strip]');
    if (!button) return;
    const act = button.dataset.strip;
    if (act === 'sign-in') actions.signIn(button);
    else if (act === 'retry-load') actions.retryLoad();
    else if (act === 'retry-unsaved') void actions.retryUnsaved();
    else if (act === 'move') void startMove();
    else if (act === 'fill') void startFill();
    else if (act === 'later') later();
    else if (act === 'done') void done();
  });
  root.addEventListener('change', (ev) => {
    if (ev.target.id === 'stripClear') move.clear = ev.target.checked;
  });
}

export function paintStrips(next) {
  if (next) facts = { ...facts, ...next };
  // An account being deleted, from this page or any other, keeps none of the books moved into it.
  if (facts.erasing) forgetMoved();
  paint();
}

/** An account shelf arrived. The browser shelf is normalised the first time, and counted every time. */
export function offerMove() {
  if (browser === null) browser = normalisedBrowserShelf();
}

/**
 * Nobody signed in, or somebody else: the counts, any move in progress and a
 * Not now belonged to the last shelf. Not now lasts the tab and names nobody,
 * so kept past its person it hid the offer from the next one to sign in here.
 */
export function forgetMove() {
  browser = null;
  move = { phase: 'offer' };
  hands += 1;
  laterHere = false;
  try {
    sessionStorage.removeItem(LATER);
  } catch (err) { /* nothing was kept there */ }
}

/**
 * The stored browser shelf with every key in one of the two grammars, written
 * back so a key minted for a hand-added book is the same key on every later
 * count. It needs both data files: judged against library.json alone, a
 * catalogue book keyed the old way would be demoted to a hand-added book and
 * saved like that. A key minted and not saved would be minted afresh next
 * time, and a second move would add that book to the account twice, so a
 * write that fails offers nothing. A saved shelf is also what vitrina_moved_v1
 * is cut down to.
 */
function normalisedBrowserShelf() {
  if (!state.catalog.length || !state.seed.length) return [];
  let result = [];
  const saved = rewriteBrowserShelf((stored) => {
    result = normaliseBrowserShelf(stored, indexById(state.seed.map((e) => e.record)), indexById(state.catalog), mintUuid);
    return result;
  });
  if (!saved) return [];
  keepMoved(result.map((e) => e.key));
  return result;
}

function movedKeys() {
  try {
    const keys = JSON.parse(localStorage.getItem(MOVED) || '[]');
    return Array.isArray(keys) ? keys.filter((key) => typeof key === 'string') : [];
  } catch (err) {
    return [];
  }
}

function noteMoved(keys) {
  try {
    const all = new Set(movedKeys());
    keys.forEach((key) => all.add(key));
    localStorage.setItem(MOVED, JSON.stringify(Array.from(all)));
  } catch (err) { /* without it a moved book may be offered again, and the account skips what it has */ }
}

/**
 * vitrina_moved_v1 cut down to the keys of books still in this browser. A moved
 * key only keeps its book from being offered twice. Once the book has left, the
 * key is a record of an edition somebody moved to an account, kept on a browser
 * other people may use, and it kept that edition, put back here later by
 * anybody, from ever being offered again.
 */
function keepMoved(keys) {
  try {
    const here = new Set(keys);
    const kept = movedKeys().filter((key) => here.has(key));
    if (kept.length) localStorage.setItem(MOVED, JSON.stringify(kept));
    else localStorage.removeItem(MOVED);
  } catch (err) { /* a key left behind offers one book less, and names no one */ }
}

/** An account whose data is being deleted holds none of this browser's books, so none counts as moved. */
export function forgetMoved() {
  keepMoved([]);
}

function isLater() {
  if (laterHere) return true;
  try {
    return sessionStorage.getItem(LATER) === '1';
  } catch (err) {
    return false;
  }
}

function later() {
  laterHere = true;
  try {
    sessionStorage.setItem(LATER, '1');
  } catch (err) { /* this page still remembers */ }
  if (move.phase === 'stopped') move = { phase: 'offer' };
  paint();
}

function counts() {
  return stripCounts(browser || [], state.entries, movedKeys());
}

// ── Markup ───────────────────────────────────────────────────────────────────

function button(act, label, variant = 'btn--secondary') {
  return `<button type="button" class="btn ${variant} btn--sm" data-strip="${act}">${escHtml(label)}</button>`;
}

// text arrives escaped; everything a person or a server wrote is escaped by the caller.
function strip(text, controls = '', tone = '') {
  return `<div class="strip${tone ? ` strip--${tone}` : ''}">
      <p class="strip__text" tabindex="-1">${text}</p>
      ${controls ? `<div class="strip__actions">${controls}</div>` : ''}
    </div>`;
}

function signedOutStrip() {
  if (!facts.signedOut || state.source !== 'local') return '';
  const lost = facts.signedOut.unsaved.length
    ? `<span class="strip__more">Not saved: ${escHtml(listTitles(facts.signedOut.unsaved))}</span>`
    : '';
  return strip(`You were signed out, so this is the shelf kept in this browser. Sign in to see your account shelf.${lost}`,
    button('sign-in', 'Sign in', 'btn--primary'));
}

function loadStrip() {
  if (state.source === 'account-error') {
    return strip('Your account shelf could not be loaded.', button('retry-load', 'Try again', 'btn--primary'), 'warn');
  }
  if (state.source === 'account-loading' && facts.erasing) {
    return strip(escHtml(`Your Vitrina data is being deleted. ${deletionCopy({ erasing: true, remaining: facts.erasing.remaining })}`), '', 'warn');
  }
  return '';
}

function unsavedStrip() {
  if (state.source !== 'account' || !facts.unsaved.length) return '';
  return strip(`Not saved to your account: ${escHtml(listTitles(facts.unsaved))}.`, button('retry-unsaved', 'Try again', 'btn--primary'), 'warn');
}

function fillRow(fill, notNow) {
  if (!fill.length) return '';
  return strip(`${plural(fill.length, 'book', 'books')} here ${fill.length === 1 ? 'has' : 'have'} notes or labels your account lacks.`,
    button('fill', 'Fill them in') + (notNow ? button('later', 'Not now', 'btn--ghost') : ''));
}

function moveStrip() {
  if (state.source !== 'account') return '';
  if (move.phase === 'moving' || move.phase === 'filling') {
    const doing = move.phase === 'moving' ? 'Adding books to your account' : 'Filling in notes and labels';
    return strip(`${doing}: ${move.done} of ${move.total}`);
  }
  if (move.phase === 'clearing') return strip("Checking your account before clearing this browser's copy");
  if (move.phase === 'moved') {
    // Fill them in stays beside Done: a book the account already had keeps this
    // browser's note only here until it is filled in.
    return strip(escHtml(move.said),
      `<label class="check"><input type="checkbox" id="stripClear"${move.clear ? ' checked' : ''}> <span>Clear this browser's copy</span></label>
       ${button('done', 'Done', 'btn--primary')}`) + fillRow(counts().fill, false);
  }
  if (move.phase === 'stopped') {
    return strip(escHtml(move.message), button(move.retry, 'Try again', 'btn--primary') + button('later', 'Not now', 'btn--ghost'), 'warn');
  }
  if (isLater()) return '';
  const { missing, fill } = counts();
  const rows = [];
  if (missing.length) {
    rows.push(strip(`This browser has ${plural(missing.length, 'book', 'books')} that ${missing.length === 1 ? 'is' : 'are'} not in your account.`,
      button('move', 'Add them to your account', 'btn--primary') + button('later', 'Not now', 'btn--ghost')));
  }
  rows.push(fillRow(fill, !missing.length));
  return rows.join('');
}

function paint() {
  const root = $('[data-account-strip]');
  if (!root) return;
  const html = [signedOutStrip(), loadStrip(), unsavedStrip(), moveStrip()].join('');
  // A live region announces what changes, so an unchanged strip is not written again.
  if (html === painted) return;
  const hadFocus = root.contains(document.activeElement);
  painted = html;
  root.innerHTML = html;
  // The button that was pressed went with the old markup. Land on what replaced
  // it rather than on the top of the page.
  if (hadFocus) {
    const next = root.querySelector('button, input, .strip__text');
    if (next) next.focus({ preventScroll: true });
  }
}

// ── Moving and filling ───────────────────────────────────────────────────────

// A move, a fill, or a Done still reading the account: the strip takes nothing else meanwhile.
function busy() {
  return move.phase === 'moving' || move.phase === 'filling' || move.phase === 'clearing';
}

async function startMove() {
  if (state.source !== 'account' || !session.send || busy()) return;
  const wanted = new Set(counts().missing);
  const books = (browser || []).filter((e) => wanted.has(e.key));
  const outgoing = books.map(toServerEntry).filter(Boolean);
  if (!outgoing.length) return;
  move = { phase: 'moving', done: 0, total: outgoing.length };
  paint();
  const outcome = await uploadInChunks(outgoing, {
    send: (chunk) => session.send(FN.shelf.upsertEntries, { entries: chunk }),
    generation: () => state.generation,
    onChunk: (chunk) => {
      // After the account took the chunk, never before: a key recorded here is never offered again.
      noteMoved(chunk.map((row) => row.key));
      move.done += chunk.length;
      paint();
    },
  });
  finish(outcome, books, 'move');
}

async function startFill() {
  if (state.source !== 'account' || !session.send || busy()) return;
  const books = counts().fill;
  const outgoing = books.map(toServerEntry).filter(Boolean);
  if (!outgoing.length) return;
  // Filled in from beside Done, the strip goes back to Done afterwards.
  const back = move.phase === 'moved' ? move : null;
  move = { phase: 'filling', done: 0, total: outgoing.length };
  paint();
  const outcome = await uploadInChunks(outgoing, {
    // fillEmpty only ever fills a field the account copy has empty.
    send: (chunk) => session.send(FN.shelf.upsertEntries, { entries: chunk, fillEmpty: true }),
    generation: () => state.generation,
    onChunk: (chunk) => {
      move.done += chunk.length;
      paint();
    },
  });
  finish(outcome, books, 'fill', back);
}

function finish(outcome, books, kind, back = null) {
  if (outcome.status === 'stale') {
    move = { phase: 'offer' };
    paint();
    return;
  }
  if (outcome.status === 'done') {
    // From the totals, where a book a retried chunk skipped counts as added (accountplan.batchToast).
    move = kind === 'move' ? { phase: 'moved', said: batchToast('move', outcome.totals), clear: true } : (back || { phase: 'offer' });
    if (kind === 'fill') toast(batchToast('fill', outcome.totals));
    paint();
    // The books are in the account and not yet in memory. Said by the strip, so the refetch stays quiet.
    if (session.refresh) void session.refresh({ quiet: true });
    return;
  }
  const row = outcome.chunk[failedIndex(outcome)];
  const book = books.find((e) => e.key === row.key);
  const message = failureCopy(outcome.failure, book ? title(book) : null);
  if (outcome.status === 'erasing') {
    move = { phase: 'offer' };
    toast(message, 'bad');
    paint();
    if (session.refresh) void session.refresh();
    return;
  }
  const before = outcome.sent
    ? ` ${plural(outcome.sent, 'book', 'books')} ${kind === 'move' ? 'reached your account' : 'were filled in'} before that.`
    : '';
  move = { phase: 'stopped', message: message + before, retry: kind };
  paint();
  if (outcome.sent && session.refresh) void session.refresh({ quiet: true });
}

/**
 * Done, with "Clear this browser's copy" checked as the plan has it by default.
 * The account is read fresh, not from memory, which may still be waiting on the
 * refetch after the move, and a book leaves this browser only once the account
 * holds everything this browser has for it (accountplan.booksToKeep). Clearing
 * the whole shelf used to delete a note the account had empty, while Fill them
 * in was out of sight, and the tail of a note longer than the account keeps.
 */
async function done() {
  if (move.phase !== 'moved') return;
  if (move.clear === false) {
    move = { phase: 'offer' };
    paint();
    focusShelf();
    return;
  }
  const holder = hands;
  move = { phase: 'clearing' };
  paint();
  let mine = null;
  try {
    mine = await session.call('query', FN.shelf.mine, {});
  } catch (err) {
    mine = null;
  }
  if (holder !== hands) return;
  move = { phase: 'offer' };
  if (mine && mine.erasing !== true && Array.isArray(mine.entries)) clearHeld(mine.entries);
  else toast("This browser's copy is kept, because your account could not be checked.", 'bad');
  paint();
  focusShelf();
}

function clearHeld(rows) {
  let total = 0;
  let kept = [];
  const saved = rewriteBrowserShelf((stored) => {
    total = stored.length;
    kept = booksToKeep(stored, rows);
    return kept.length ? kept : stored;
  });
  if (!saved || (!kept.length && !clearBrowserShelf())) {
    toast('This browser would not let the page clear its copy', 'bad');
    return;
  }
  browser = kept;
  // A book that left this browser leaves the moved list too.
  keepMoved(kept.map((e) => e.key));
  if (!kept.length) toast("This browser's copy is cleared");
  else if (kept.length === total) toast(`Nothing was cleared: your account does not hold ${total === 1 ? 'this book' : `these ${total} books`} in full.`);
  else toast(`This browser's copy is cleared, except ${plural(kept.length, 'book', 'books')} your account does not hold in full.`);
}

function focusShelf() {
  // The strip that held focus is gone; the shelf's own controls come next.
  const next = document.querySelector('.viewswitch__btn.is-on');
  if (next) next.focus({ preventScroll: true });
}
