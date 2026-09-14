// ── The strips above /shelf/, and moving a browser shelf into an account ─────
//
// /shelf/ carries one live region above the controls, which scripts/routes.py
// writes empty. account.js tells this module what it has to say there: that
// the person was signed out without a reload, that the account shelf could not
// be loaded, that its data is being deleted, or that some changes did not reach
// it. The strip offering a browser shelf's books to the account is this
// module's own, because moving them is never automatic (plan section 3.1): it
// counts, offers, uploads only when asked, and then offers to clear this
// browser's copy.
//
// Nothing from an account is written to storage here. vitrina_moved_v1 holds
// keys of books that left this browser's shelf, and no name, note or account id.

import { state, rewriteBrowserShelf, clearBrowserShelf } from './state.js';
import { FN } from './backend.js';
import { normaliseBrowserShelf, indexById, toServerEntry } from './syncplan.js';
import { stripCounts, uploadInChunks, failedIndex, failureCopy, batchToast, listTitles, deletionCopy } from './accountplan.js';
import { session } from './session.js';
import { title } from './data.js';
import { $, escHtml, toast, plural, mintUuid } from './utils.js';

const MOVED = 'vitrina_moved_v1';
const LATER = 'vitrina_move_later_v1';

let actions = { signIn() {}, retryLoad() {}, retryUnsaved() {} };
let facts = { signedOut: null, erasing: null, unsaved: [] };
let browser = null;          // the browser shelf as normalised when the account shelf arrived
let move = { phase: 'offer' };   // offer, moving, filling, moved or stopped
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
    else if (act === 'done') done();
  });
  root.addEventListener('change', (ev) => {
    if (ev.target.id === 'stripClear') move.clear = ev.target.checked;
  });
}

export function paintStrips(next) {
  if (next) facts = { ...facts, ...next };
  paint();
}

/** An account shelf arrived. The browser shelf is normalised the first time, and counted every time. */
export function offerMove() {
  if (browser === null) browser = normalisedBrowserShelf();
}

/** Signed out, or somebody else signed in: the counts and any move in progress belonged to that shelf. */
export function forgetMove() {
  browser = null;
  move = { phase: 'offer' };
}

/**
 * The stored browser shelf with every key in one of the two grammars, written
 * back so a key minted for a hand-added book is the same key on every later
 * count. It needs both data files: judged against library.json alone, a
 * catalogue book keyed the old way would be demoted to a hand-added book and
 * saved like that. A key minted and not saved would be minted afresh next
 * time, and a second move would add that book to the account twice, so a
 * write that fails offers nothing.
 */
function normalisedBrowserShelf() {
  if (!state.catalog.length || !state.seed.length) return [];
  let result = [];
  const saved = rewriteBrowserShelf((stored) => {
    result = normaliseBrowserShelf(stored, indexById(state.seed.map((e) => e.record)), indexById(state.catalog), mintUuid);
    return result;
  });
  return saved ? result : [];
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

function moveStrip() {
  if (state.source !== 'account') return '';
  if (move.phase === 'moving' || move.phase === 'filling') {
    const doing = move.phase === 'moving' ? 'Adding books to your account' : 'Filling in notes and labels';
    return strip(`${doing}: ${move.done} of ${move.total}`);
  }
  if (move.phase === 'moved') {
    return strip(`Added ${plural(move.added, 'book', 'books')}.`,
      `<label class="check"><input type="checkbox" id="stripClear"${move.clear ? ' checked' : ''}> <span>Clear this browser's copy</span></label>
       ${button('done', 'Done', 'btn--primary')}`);
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
  if (fill.length) {
    rows.push(strip(`${plural(fill.length, 'book', 'books')} here ${fill.length === 1 ? 'has' : 'have'} notes or labels your account lacks.`,
      button('fill', 'Fill them in') + (missing.length ? '' : button('later', 'Not now', 'btn--ghost'))));
  }
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

async function startMove() {
  if (state.source !== 'account' || !session.send || move.phase === 'moving' || move.phase === 'filling') return;
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
  if (state.source !== 'account' || !session.send || move.phase === 'moving' || move.phase === 'filling') return;
  const books = counts().fill;
  const outgoing = books.map(toServerEntry).filter(Boolean);
  if (!outgoing.length) return;
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
  finish(outcome, books, 'fill');
}

function finish(outcome, books, kind) {
  if (outcome.status === 'stale') {
    move = { phase: 'offer' };
    paint();
    return;
  }
  if (outcome.status === 'done') {
    move = kind === 'move' ? { phase: 'moved', added: outcome.totals.added, clear: true } : { phase: 'offer' };
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

function done() {
  const clear = move.clear !== false;
  move = { phase: 'offer' };
  if (clear) {
    if (clearBrowserShelf()) {
      browser = [];
      toast("This browser's copy is cleared");
    } else {
      toast('This browser would not let the page clear its copy', 'bad');
    }
  }
  paint();
  // The strip that held focus is gone; the shelf's own controls come next.
  const next = document.querySelector('.viewswitch__btn.is-on');
  if (next) next.focus({ preventScroll: true });
}
