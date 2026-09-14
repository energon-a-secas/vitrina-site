// ── Account shelves on /shelf/, and the header account on /demo/ ─────────────
//
// Signed out, /shelf/ is the shelf kept in this browser, exactly as before.
// Signed in, it is the person's account shelf in Convex. Which of the two the
// page shows changes only when the Auth Kit reports a real change of who is
// signed in (plan section 3.1): never because a request failed, and never by
// falling back to the browser shelf while an account shelf loads or cannot be
// read, because on a shared browser that fallback is somebody else's shelf.
//
// Edits are optimistic. state.js changes memory and hands each edit to the
// adapter below, which sends it and deals with the answer. An answer that
// arrives after the shelf changed hands is ignored; a failed add or note edit
// stays on screen as "not saved", with Try again; a failed removal puts the
// book back; and a refetch never lands on top of a write still on its way.
//
// /demo/ only starts the kit, so its header shows the account. It never loads
// the Convex client and never asks for a shelf.

import {
  state, setPersistence, useAccountShelf, useLocalShelf, useAccountLoading, useAccountError, findEntry, reindex,
} from './state.js';
import { FN, convexUrlFrom, loadClient, loadAuthKit, readClientUat } from './backend.js';
import { toServerEntry, fromServerEntry, indexById, demoSeedForAccount, shouldApplyFetch } from './syncplan.js';
import {
  authedCall, failureCopy, keepsUnsaved, notReadyCopy, batchToast, uploadInChunks, failedIndex, shelfSignature,
} from './accountplan.js';
import { session } from './session.js';
import { render } from './render.js';
import { closeBook, closeIfGone } from './detail.js';
import { closeModal } from './modals.js';
import { title } from './data.js';
import { toast } from './utils.js';
import { bindStrips, paintStrips, offerMove, forgetMove } from './strips.js';

// While shelf:mine says the data is being deleted there is no shelf to show,
// so the page asks again at this pace until the deletion is over.
const ERASING_POLL_MS = 8000;

let booted = null;
let kit = null;
let convexUrl = null;
let clientLoad = null;

let authSeq = 0;             // moves with every change the kit reports; work for an older one is dropped
let userId = null;           // whose account shelf memory holds, or held before a sign-out
let signedInHere = false;    // this page has seen somebody signed in, so a sign-out now came without a reload
let signedOut = null;        // { unsaved: [titles] } for the strip after such a sign-out

const inflight = new Set();  // a ticket per write still waiting for its answer
let writeSeq = 0;
let rerun = null;            // { quiet } when a refetch was held back by writes and runs once they settle
// Changes the account has not taken: key -> { title, entry, patch }. entry is a
// book that never reached it, patch a note edit that did not. Memory only, so a
// reload discards them, and so does somebody else signing in.
const unsaved = new Map();
let erasingTimer = null;

export function startAccount(mode) {
  if (!booted) {
    booted = boot(mode).catch((err) => {
      // The shelf in this browser keeps working without the kit; only signing in does not.
      console.warn('Vitrina could not start sign-in:', err && err.message);
    });
  }
  return booted;
}

async function boot(mode) {
  kit = (await loadAuthKit()).NeoAuth;
  session.kit = kit;
  if (mode !== 'shelf') {
    await kit.start();
    return;
  }
  // Throws on a malformed meta, and the catch above says so: read as "no
  // backend", a typo there would quietly show a signed-in person the browser shelf.
  convexUrl = convexUrlFrom(document);
  if (!convexUrl) {
    console.warn('Vitrina: this page names no Convex deployment, so account shelves are off here.');
    await kit.start();
    return;
  }
  session.call = authedCall(client, kit);
  session.send = send;
  session.refresh = refetch;
  setPersistence(adapter);
  bindStrips({ signIn, retryLoad, retryUnsaved });
  document.addEventListener('vitrina:shelf-not-ready', (ev) => {
    toast(notReadyCopy(ev.detail && ev.detail.source, session.erasing), 'bad');
  });
  // Two tabs or two devices: whichever comes back into view reads the account again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refetch();
  });
  // A session somewhere on the fleet means clerk-js loads now and the client
  // will be wanted right after, so both downloads start together. Signed-out
  // visitors never fetch the client at all.
  if (readClientUat(document.cookie) > 0) client().catch(() => {});
  kit.onChange(onAuth);
  await kit.start();
}

/**
 * The Convex client, loaded once. bindConvex is start({ convex }) for a client
 * that arrives after start: the kit keeps it on the token and clears it when
 * the session ends. A load that failed is tried again by the next request.
 */
function client() {
  if (!clientLoad) {
    clientLoad = loadClient(convexUrl).then((convex) => {
      kit.bindConvex(convex);
      return convex;
    }, (err) => {
      clientLoad = null;
      throw err;
    });
  }
  return clientLoad;
}

// ── Whose shelf ──────────────────────────────────────────────────────────────

function onAuth(snap) {
  const seq = ++authSeq;
  if (snap.signedIn) {
    signedInHere = true;
    if (userId !== null && userId !== snap.userId) {
      // Somebody else: nothing of the last person's shelf, or their unsaved changes, stays.
      unsaved.clear();
      leaveAccount(false);
    } else if (userId === snap.userId && (state.source === 'account' || state.source === 'account-loading')) {
      return;   // the same person under a new label; the shelf in memory is still theirs
    }
    userId = snap.userId;
    signedOut = null;
    void loadAccount(seq);
    return;
  }
  // A page that opened signed out is already on the browser shelf.
  if (signedInHere) leaveAccount(true);
}

function leaveAccount(showStrip) {
  const titles = Array.from(unsaved.values()).map((item) => item.title);
  stopErasingPoll();
  session.lastCount = null;
  session.erasing = null;
  forgetMove();
  useLocalShelf();
  closeBook();
  closeModal();
  signedOut = showStrip ? { unsaved: titles } : null;
  paint();
  render();
}

function signIn(invoker) {
  if (kit) void kit.openSignIn({ reason: 'Sign in to see your account shelf.', invoker });
}

function retryLoad() {
  if (kit && kit.state.signedIn) void loadAccount(authSeq);
}

async function loadAccount(seq) {
  stopErasingPoll();
  useAccountLoading();
  const generation = state.generation;
  paint();
  render();
  let answer;
  try {
    answer = await session.call('query', FN.shelf.mine, {});
  } catch (err) {
    answer = undefined;
  }
  if (seq !== authSeq || generation !== state.generation) return;
  applyMine(answer, { first: true });
}

/**
 * A shelf:mine answer into memory. null while the kit says signed in is a
 * request that failed, never a sign-out, which only ever arrives through
 * onAuth: on a first load it is an error with Try again, on a refetch it changes
 * nothing.
 */
function applyMine(answer, { first = false, quiet = false } = {}) {
  if (answer && answer.erasing === true) {
    showErasing(answer.remaining);
    return;
  }
  if (!answer || !Array.isArray(answer.entries)) {
    if (first) failLoad();
    return;
  }
  stopErasingPoll();
  session.erasing = null;
  session.lastCount = answer.entries.length;
  const before = !first && state.source === 'account' ? shelfSignature(state.entries) : null;
  useAccountShelf(withUnsaved(entriesFromRows(answer.entries)));
  render();
  closeIfGone();
  offerMove();
  paint();
  if (first && answer.truncated) toast('Your account shelf holds more books than it can show at once. The first 2000 are here.', 'bad');
  if (before !== null && !quiet && before !== shelfSignature(state.entries)) toast('Your shelf was reloaded');
}

function failLoad() {
  useAccountError();
  paint();
  render();
}

function showErasing(remaining) {
  session.erasing = { remaining: Number.isSafeInteger(remaining) && remaining > 0 ? remaining : 0 };
  if (state.source !== 'account-loading') useAccountLoading();
  paint();
  render();
  stopErasingPoll();
  const seq = authSeq;
  erasingTimer = setTimeout(() => {
    erasingTimer = null;
    if (seq === authSeq) void pollErasing(seq);
  }, ERASING_POLL_MS);
}

async function pollErasing(seq) {
  const generation = state.generation;
  let answer;
  try {
    answer = await session.call('query', FN.shelf.mine, {});
  } catch (err) {
    answer = undefined;
  }
  if (seq !== authSeq || generation !== state.generation) return;
  if (answer && Array.isArray(answer.entries)) applyMine(answer, { first: true });
  else showErasing(answer && answer.erasing === true ? answer.remaining : (session.erasing || {}).remaining);
}

function stopErasingPoll() {
  clearTimeout(erasingTimer);
  erasingTimer = null;
}

function entriesFromRows(rows) {
  const library = indexById(state.seed.map((e) => e.record));
  const catalog = indexById(state.catalog);
  return rows.map((row) => fromServerEntry(row, library, catalog)).filter(Boolean);
}

/**
 * A fetched shelf with this page's unsaved changes laid back over it, so a
 * refetch never quietly undoes a book or a note the account has not taken.
 * A book that turns up in the answer did reach the account after all, its
 * answer lost on the way back; a note for a book the answer lacks has no book
 * left to go on.
 */
function withUnsaved(entries) {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  for (const [key, item] of Array.from(unsaved)) {
    const current = state.source === 'account' ? findEntry(key) : null;
    if (item.entry && !byKey.has(key)) {
      const book = { ...(current || item.entry) };
      entries.push(book);
      byKey.set(key, book);
      continue;
    }
    if (item.entry) item.entry = null;
    if (item.patch && byKey.has(key)) Object.assign(byKey.get(key), item.patch);
    else unsaved.delete(key);
  }
  return entries;
}

function paint() {
  paintStrips({
    signedOut,
    erasing: session.erasing,
    unsaved: state.source === 'account' ? Array.from(unsaved.values()).map((item) => item.title) : [],
  });
}

// ── Writes and refetches ─────────────────────────────────────────────────────

function pendingNow() {
  let n = 0;
  for (const ticket of inflight) if (ticket.generation === state.generation) n += 1;
  return n;
}

/**
 * One write, through the client's own mutation queue (never skipQueue, so
 * writes from one tab reach the account in the order they were made). Counted,
 * so a refetch that was on its way meanwhile is not applied over it. Resolves
 * the function's answer, or null when the request itself failed.
 */
async function send(name, args) {
  const ticket = { generation: state.generation };
  writeSeq += 1;
  inflight.add(ticket);
  try {
    return await session.call('mutation', name, args);
  } catch (err) {
    return null;
  } finally {
    inflight.delete(ticket);
    setTimeout(settle, 0);
  }
}

function settle() {
  if (!rerun || pendingNow() > 0) return;
  const { quiet } = rerun;
  rerun = null;
  void refetch({ quiet });
}

/**
 * shelf:mine again, after a failed write or when the tab comes back into view.
 * Applied only when no write is pending and none went out while it was on its
 * way (syncplan.shouldApplyFetch); otherwise it runs again once writes settle.
 */
async function refetch({ quiet = false } = {}) {
  if (state.source !== 'account' || !session.call) return;
  if (pendingNow() > 0) {
    rerun = { quiet: rerun ? rerun.quiet && quiet : quiet };
    return;
  }
  const seq = authSeq;
  const started = { generation: state.generation, writeSeq };
  let answer;
  try {
    answer = await session.call('query', FN.shelf.mine, {});
  } catch (err) {
    return;   // the shelf in memory stands; the next write or visit tries again
  }
  if (seq !== authSeq) return;
  const now = { generation: state.generation, writeSeq, pending: pendingNow() };
  if (!shouldApplyFetch(started, now)) {
    if (started.generation === now.generation) {
      rerun = { quiet: rerun ? rerun.quiet && quiet : quiet };
      settle();
    }
    return;
  }
  applyMine(answer, { quiet });
}

const adapter = {
  add(entry) { void saveBooks([entry], 'add'); },
  remove(key, entry) { void saveRemove(key, entry); },
  update(key, patch, entry) { void saveUpdate(key, patch, entry); },
  addMany(entries, { kind } = {}) { void saveBooks(entries, kind === 'seed' ? 'seed' : 'import'); },
};

function holdUnsaved(entry) {
  const held = unsaved.get(entry.key);
  unsaved.set(entry.key, { title: title(entry), entry: { ...entry }, patch: held ? held.patch : null });
}

/**
 * Books memory has just gained, sent in chunks. The demo seed goes as the
 * demo's catalogue ids and shelf labels, all of them, since the account skips
 * what it already has. Every book from a failed chunk on is held as unsaved.
 */
async function saveBooks(entries, kind) {
  const generation = state.generation;
  const outgoing = kind === 'seed' ? demoSeedForAccount(state.seed) : entries.map(toServerEntry).filter(Boolean);
  const gained = new Map(entries.map((e) => [e.key, e]));
  if (!outgoing.length) return;
  const outcome = await uploadInChunks(outgoing, {
    send: (chunk) => send(FN.shelf.upsertEntries, { entries: chunk }),
    generation: () => state.generation,
    onChunk: (chunk) => chunk.forEach((row) => {
      const held = unsaved.get(row.key);
      if (!held) return;
      held.entry = null;
      if (!held.patch) unsaved.delete(row.key);
    }),
  });
  if (outcome.status === 'stale' || generation !== state.generation) return;
  if (outcome.status === 'done') {
    const said = batchToast(kind, outcome.totals);
    if (said) toast(said);
    paint();
    return;
  }
  const row = outcome.chunk[failedIndex(outcome)];
  const named = findEntry(row.key) || gained.get(row.key);
  toast(failureCopy(outcome.failure, named ? title(named) : null), 'bad');
  if (keepsUnsaved(outcome.failure, 'add')) {
    for (const lost of outgoing.slice(outgoing.indexOf(outcome.chunk[0]))) {
      const book = gained.has(lost.key) ? findEntry(lost.key) : null;
      if (book) holdUnsaved(book);
    }
  }
  paint();
  void refetch();
}

async function saveRemove(key, entry) {
  const generation = state.generation;
  const held = unsaved.get(key);
  // A book the account never took may still have landed with its answer lost,
  // so the removal goes out anyway; but there is nothing to put back if it fails.
  const neverSaved = Boolean(held && held.entry);
  unsaved.delete(key);
  paint();
  const answer = await send(FN.shelf.removeEntry, { key });
  if (generation !== state.generation || (answer && answer.ok === true)) return;
  if (neverSaved || (answer && answer.code === 'erasing')) {
    if (!neverSaved) toast(failureCopy(answer, title(entry)), 'bad');
    void refetch();
    return;
  }
  // The account still has the book, so the shelf shows it again.
  if (!findEntry(key)) {
    state.entries.push(entry);
    reindex();
  }
  toast(failureCopy(answer, title(entry)), 'bad');
  render();
  closeIfGone();
  void refetch();
}

async function saveUpdate(key, patch, entry) {
  const generation = state.generation;
  const held = unsaved.get(key);
  if (held && held.entry) {
    // Not on the account yet: the note goes with the book when it is sent again.
    held.entry = { ...entry };
    return;
  }
  const outgoing = toServerEntry(entry);
  if (!outgoing) return;
  const args = { key };
  if ('note' in patch) args.note = outgoing.note;
  if ('shelf' in patch) args.shelf = outgoing.shelf;
  if (!('note' in args) && !('shelf' in args)) return;
  const answer = await send(FN.shelf.updateEntry, args);
  if (generation !== state.generation) return;
  if (answer && answer.ok === true) {
    const still = unsaved.get(key);
    if (still && !still.entry) {
      unsaved.delete(key);
      paint();
    }
    return;
  }
  toast(failureCopy(answer, title(entry)), 'bad');
  if (keepsUnsaved(answer, 'update')) {
    const still = unsaved.get(key);
    unsaved.set(key, { title: title(entry), entry: null, patch: { ...(still && still.patch), ...patch } });
  }
  paint();
  void refetch();
}

async function retryUnsaved() {
  if (state.source !== 'account') return;
  const books = [];
  const jobs = [];
  for (const [key, item] of Array.from(unsaved)) {
    const current = findEntry(key);
    if (!current) {
      unsaved.delete(key);
    } else if (item.entry) {
      books.push(current);
    } else if (item.patch) {
      unsaved.delete(key);
      jobs.push(saveUpdate(key, item.patch, current));
    }
  }
  if (books.length) jobs.push(saveBooks(books, 'retry'));
  paint();
  await Promise.all(jobs);
  if (!unsaved.size && state.source === 'account') toast('Saved to your account');
}
