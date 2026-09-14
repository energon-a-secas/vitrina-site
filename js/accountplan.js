// ── What the account, a shared shelf and the Share dialog decide ─────────────
//
// Pure: no DOM, no storage, no network, and nothing imported but syncplan.js,
// which is pure too. account.js, strips.js, profile.js and share.js do the
// talking and the painting; what they say, and which answer they believe, is
// decided here. Those are the parts that go wrong quietly: a failure toast that
// names no book, a banner telling a suspended owner their shelf is public, an
// anonymous answer painted over the owner's own. A quiet failure needs a test
// that runs without a browser, so tests/accountplan.test.mjs holds every rule,
// and tests/account-flow, share-flow and profile-flow run the modules on them.

import { CALL_MAX, MAX_ENTRIES, RECORD_KEYS, catalogueId, fillCandidates, fromServerEntry, keysMissingFromAccount } from './syncplan.js';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function count(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function books(n) {
  return n === 1 ? '1 book' : `${n} books`;
}

// ── Writes the account refused ───────────────────────────────────────────────

/**
 * The toast for a write the account refused or never received, naming the book
 * (plan section 3.1). A thrown request arrives as null: it failed before the
 * server could say why, which to the person is a change that did not arrive.
 */
export function failureCopy(result, bookTitle) {
  const name = typeof bookTitle === 'string' && bookTitle.trim() ? bookTitle.trim() : 'Untitled';
  const code = isObject(result) ? result.code : null;
  if (code === 'shelf-full') {
    // Two ways to be full, and only one of them is about how many books.
    return result.reason === 'space'
      ? `Your account shelf is out of room: its notes and books added by hand use all the space one shelf has. ${name} was not saved.`
      : `Your account shelf holds ${MAX_ENTRIES} books, the most it can. ${name} was not added.`;
  }
  if (code === 'rate-limited') return `Too many changes this hour. ${name} was not saved; try again later.`;
  if (code === 'invalid-entry') {
    const reason = typeof result.reason === 'string' ? result.reason.trim().replace(/\.+$/, '') : '';
    return `${name} could not be saved: ${reason || 'the account refused it'}.`;
  }
  if (code === 'erasing') return 'Your Vitrina data is being deleted.';
  return `That change did not reach your account: ${name}.`;
}

/**
 * Whether a failed add or note edit stays in memory as "not saved", with Try
 * again. An account being erased takes every book with it, so nothing is kept
 * for it; a note for a book the account no longer has has nowhere to go.
 */
export function keepsUnsaved(result, kind) {
  const code = isObject(result) ? result.code : null;
  if (code === 'erasing') return false;
  if (kind === 'update' && code === 'not-found') return false;
  return true;
}

/** What an edit refused before it reached the account says, by the source it met. */
export function notReadyCopy(source, erasing) {
  if (erasing) return 'Your Vitrina data is being deleted.';
  if (source === 'account-error') return 'Your account shelf could not be loaded, so nothing changed. Use Try again above the shelf.';
  return 'Your account shelf is still loading, so nothing changed. Try again in a moment.';
}

/** The toast for a batch of books, built from upsertEntries totals summed over its chunks. Single adds said so when made. */
export function batchToast(kind, totals) {
  const added = count(totals && totals.added);
  const skipped = count(totals && totals.skipped);
  if (kind === 'seed') {
    return added
      ? `Added ${books(added)} from the demo shelf to your account. Take off what you do not own.`
      : 'Your account already has every book on the demo shelf.';
  }
  if (kind === 'import') {
    if (!added) return 'Your account already has every book in that file.';
    return `Added ${books(added)} to your account.${skipped ? ` ${skipped} ${skipped === 1 ? 'was' : 'were'} already on it.` : ''}`;
  }
  if (kind === 'fill') {
    const filled = count(totals && totals.filled);
    return filled ? `Filled in notes or labels on ${books(filled)}.` : 'Your account already had those notes and labels.';
  }
  return null;
}

/** "A, B, C and 2 more": a list that stays one line however many books failed. */
export function listTitles(titles, max = 3) {
  const list = (Array.isArray(titles) ? titles : []).filter((t) => typeof t === 'string' && t);
  if (list.length <= max) {
    return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : (list[0] || '');
  }
  return `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
}

/**
 * A fingerprint of what the person sees on a shelf, so "Your shelf was
 * reloaded" is said only when a refetch changed something. Order is left out:
 * the server answers in the order rows were created, memory in the order books
 * were added here, and neither is a change.
 */
export function shelfSignature(entries) {
  const rows = (Array.isArray(entries) ? entries : [])
    .filter(isObject)
    .map((e) => [String(e.key), e.shelf || null, e.note || null, e.listed_as || null, e.added || null]);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(rows);
}

// ── Uploading in chunks ──────────────────────────────────────────────────────

export function chunked(list, size = CALL_MAX) {
  const step = Number.isSafeInteger(size) && size > 0 ? size : CALL_MAX;
  const items = Array.isArray(list) ? list : [];
  const out = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

/**
 * Server entries sent through shelf:upsertEntries, CALL_MAX at a time (plan
 * section 3.1, step 4). The generation is read before every chunk and again
 * when its answer arrives: a sign-out or another person's sign-in halfway
 * through must not keep sending one person's browser shelf to whichever
 * account is signed in now. An account being erased stops the upload too.
 *
 * send(chunk) resolves with the function's answer, or null or a throw when the
 * request failed; onChunk(chunk, answer) runs after each chunk the account
 * took, which is where a move records the keys that made it.
 *
 * Resolves { status: done | stale | erasing | failed, totals, sent, failure, chunk }.
 */
export async function uploadInChunks(entries, { size = CALL_MAX, send, generation, onChunk } = {}) {
  const totals = { added: 0, skipped: 0, filled: 0, total: null };
  const started = generation();
  let sent = 0;
  for (const chunk of chunked(entries, size)) {
    if (generation() !== started) return { status: 'stale', totals, sent, failure: null, chunk: null };
    let answer = null;
    try {
      answer = await send(chunk);
    } catch (err) {
      answer = null;
    }
    if (generation() !== started) return { status: 'stale', totals, sent, failure: null, chunk: null };
    if (!isObject(answer) || answer.ok !== true) {
      const status = isObject(answer) && answer.code === 'erasing' ? 'erasing' : 'failed';
      return { status, totals, sent, failure: isObject(answer) ? answer : null, chunk };
    }
    totals.added += count(answer.added);
    totals.skipped += count(answer.skipped);
    totals.filled += count(answer.filled);
    if (Number.isSafeInteger(answer.total)) totals.total = answer.total;
    sent += chunk.length;
    if (onChunk) onChunk(chunk, answer);
  }
  return { status: 'done', totals, sent, failure: null, chunk: null };
}

/** The book a failed chunk names: the one invalid-entry points at, else the chunk's first. */
export function failedIndex(outcome) {
  if (!outcome || !Array.isArray(outcome.chunk) || !outcome.chunk.length) return -1;
  const index = outcome.failure && Number.isSafeInteger(outcome.failure.index) ? outcome.failure.index : 0;
  return index >= 0 && index < outcome.chunk.length ? index : 0;
}

// ── The account strip ────────────────────────────────────────────────────────

/**
 * N and M for the strip above an account shelf (plan section 3.1, step 2).
 * missing: keys of browser books the account lacks that never moved from this
 * browser. fill: browser books the account has too, where the account copy
 * lacks a note or a label this browser has.
 */
export function stripCounts(browser, account, movedKeys) {
  const rows = (Array.isArray(account) ? account : []).filter(isObject);
  return {
    missing: keysMissingFromAccount(browser, rows.map((row) => row.key), movedKeys),
    fill: fillCandidates(browser, new Map(rows.map((row) => [row.key, row]))),
  };
}

/**
 * The books "Clear this browser's copy" has to leave here, from the stored
 * browser shelf and the rows shelf:mine has just returned. A book goes only
 * when the account holds it and has everything this browser has for it. It
 * stays when the account lacks it, and when a note, label or listed-as text
 * here is not in the account copy word for word: empty there (what Fill them
 * in is for), other words, or cut short, as toServerEntry cuts a note at 1000
 * characters. A book added by hand also stays for a record field the account
 * does not keep, such as a cover URL that is not https. The date is left out,
 * since each copy's own is as true. Clearing what is left loses nothing.
 */
export function booksToKeep(stored, accountRows) {
  const rows = new Map((Array.isArray(accountRows) ? accountRows : []).filter(isObject).map((row) => [row.key, row]));
  return (Array.isArray(stored) ? stored : []).filter((entry) => {
    if (!isObject(entry)) return false;
    const account = rows.get(entry.key);
    if (!isObject(account)) return true;
    if (lacks(entry.shelf, account.shelf) || lacks(entry.note, account.note) || lacks(entry.listed_as, account.listedAs)) return true;
    return catalogueId(entry.id) === null && recordLacks(entry.record, account.record);
  });
}

// Text this browser has that the account copy does not hold as it is.
function lacks(mine, theirs) {
  let text = '';
  if (typeof mine === 'string') text = mine.trim();
  else if (typeof mine === 'number' && Number.isFinite(mine)) text = String(mine);
  return text !== '' && text !== theirs;
}

function recordLacks(record, kept) {
  const mine = isObject(record) ? record : {};
  const theirs = isObject(kept) ? kept : {};
  const names = (Array.isArray(mine.authors) ? mine.authors : [mine.authors])
    .filter((name) => typeof name === 'string' && name.trim())
    .map((name) => name.trim());
  const held = Array.isArray(theirs.authors) ? theirs.authors : [];
  if (names.some((name, i) => held[i] !== name)) return true;
  if (Number.isSafeInteger(mine.pages) && mine.pages >= 0 && mine.pages !== theirs.pages) return true;
  return RECORD_KEYS.some((field) => field !== 'authors' && field !== 'pages' && lacks(mine[field], theirs[field]));
}

// ── Authenticated requests ───────────────────────────────────────────────────

/**
 * call(kind, name, args) through a signed-in Convex client (plan section 3.7).
 *
 * The kit keeps a bound client on the token as Clerk refreshes it, but a
 * template token lives 60 seconds and clerk-js 5 does not refresh it in the
 * background, so every request, queries included, asks the kit for a token
 * first. A request that throws gets one fresh mint past Clerk's cache and one
 * retry; a second failure is the caller's to report.
 *
 * Who a request is for (holderOf) is taken before anything is awaited and
 * checked again just before a token is set, which the client's dispatch follows
 * at once. A request whose holder changed on the way throws unsent, and its
 * retry is minted from the session it started with, never from whoever is
 * signed in by the time it failed.
 */
export function authedCall(getClient, kit) {
  return async function call(kind, name, args) {
    const session = sessionOf(kit);
    const holder = holderOf(kit);
    const still = () => holder !== null && holderOf(kit) === holder;
    const client = await getClient();
    const run = () => (kind === 'mutation' ? client.mutation(name, args) : client.query(name, args));
    try {
      const token = await kit.convexToken();
      if (!still()) throw new Error('the signed-in account changed before this request went out');
      if (token) client.setAuth(token);
      else if (typeof client.clearAuth === 'function') client.clearAuth();
      return await run();
    } catch (err) {
      if (!session || !still()) throw err;
      const fresh = await session.getToken({ template: 'convex', skipCache: true });
      if (!fresh || !still()) throw err;
      client.setAuth(fresh);
      return run();
    }
  };
}

function sessionOf(kit) {
  const snap = kit ? kit.state : null;
  return snap && snap.clerk && snap.clerk.session ? snap.clerk.session : null;
}

/**
 * Who the kit's session is for, as one string, or null while the kit is between
 * two people. The kit swaps the session, then the token on every bound client,
 * and only then its userId and its listeners, so for a moment the session is
 * the next person's while userId is still the last one's. The session id is in
 * the string too, so a sign-out and sign-in in between is a change as well.
 */
export function holderOf(kit) {
  const snap = kit ? kit.state : null;
  const session = sessionOf(kit);
  const userId = (snap && snap.userId) || null;
  const owner = session && session.user && typeof session.user.id === 'string' ? session.user.id : userId;
  if (owner !== userId) return null;
  return `${userId || ''}|${(session && session.id) || ''}`;
}

/**
 * The page's writes to the account, one at a time (plan section 3.1).
 *
 * The client's own queue keeps mutations in order only until one throws:
 * authedCall retries a thrown write after a fresh mint, and by then a later
 * write has gone out ahead of it, so a book put on and taken straight off
 * stayed on the account. That queue also reads its token as each mutation is
 * dispatched, so a write waiting behind a slow one could leave with the token
 * of whoever signed in meanwhile. Here a write starts only once the one before
 * it, retry included, has settled, and is dropped unsent when the shelf it was
 * made for is no longer the one in memory. One whose turn comes while the kit is
 * between two people is refused by authedCall, which runs it.
 *
 * call is authedCall's, generation() reads state.generation, and settled() runs
 * after each write. send(name, args) resolves the function's answer, or null
 * when the request failed or was dropped. pending() counts unsettled writes made
 * for the shelf now in memory, and seq() every write made, so a refetch can
 * tell whether one went out while it was on its way.
 */
export function writeQueue({ call, generation, settled = () => {} }) {
  const waiting = new Set();
  let made = 0;
  let tail = Promise.resolve();
  function send(name, args) {
    const ticket = { generation: generation() };
    made += 1;
    waiting.add(ticket);
    const turn = tail.then(async () => {
      if (ticket.generation !== generation()) return null;
      try {
        return await call('mutation', name, args);
      } catch (err) {
        return null;
      }
    });
    tail = turn;
    return turn.finally(() => {
      waiting.delete(ticket);
      settled();
    });
  }
  function pending() {
    const now = generation();
    let n = 0;
    for (const ticket of waiting) if (ticket.generation === now) n += 1;
    return n;
  }
  return { send, pending, seq: () => made };
}

// ── /u/ ──────────────────────────────────────────────────────────────────────

export const PROFILE_COPY = Object.freeze({
  loading: 'Loading this shelf',
  missing: 'This link is missing the shelf name, which goes after the question mark.',
  unavailable: 'No public shelf at this address. It may not exist, or its owner keeps it private.',
  error: 'This shelf could not be loaded. Check your connection and reload.',
  empty: 'This shelf has no catalogued books to show.',
});

function isShelfAnswer(value) {
  return isObject(value) && typeof value.handle === 'string' && Array.isArray(value.books);
}

/** A PublicShelf nobody signed in is needed to see, which /u/ may paint before the kit has settled. */
export function isPublicShelf(value) {
  return isShelfAnswer(value) && value.isOwner !== true;
}

/**
 * Browser entries for a shared shelf's books: catalogue ids and the owner's
 * shelf labels, and nothing else, whatever else an answer carried. Records are
 * rebuilt from the data files the way an account shelf's are.
 */
export function publicEntries(value, libraryById, catalogById) {
  if (!isShelfAnswer(value)) return [];
  const out = [];
  const seen = new Set();
  for (const book of value.books) {
    const id = isObject(book) ? catalogueId(book.id) : null;
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    const shelf = typeof book.shelf === 'string' ? book.shelf : null;
    const entry = fromServerEntry({ key: 'tf' + id, id, shelf, note: null, listedAs: null, added: null, record: null }, libraryById, catalogById);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Which /u/ state a page is in (plan section 3.6). A link naming no shelf is
 * Missing; one naming something that can never be a handle is Unavailable
 * without a request, exactly like a shelf that does not exist or is private,
 * so the page never says which.
 */
export function profileState(address, reply) {
  if (!isObject(address) || !address.found) return 'missing';
  if (!address.handle) return 'unavailable';
  if (!isObject(reply)) return 'loading';
  if (reply.error) return 'error';
  if (!isShelfAnswer(reply.value)) return 'unavailable';
  return reply.value.books.some((book) => isObject(book) && catalogueId(book.id) !== null) ? 'shelf' : 'empty';
}

/**
 * Whether a byHandle reply replaces the one on screen. Every request is
 * numbered, and replies below floor belong to a viewer who has since signed
 * out or changed. A reply sent with a token supersedes an anonymous one in
 * either arrival order, since only it can carry the owner's view; a failure
 * never replaces an answer already shown.
 */
export function replyWins(current, reply, floor = 0) {
  if (!isObject(reply) || !Number.isSafeInteger(reply.n) || reply.n < floor) return false;
  if (!isObject(current) || current.n < floor) return true;
  if (reply.error && !current.error) return false;
  if (!reply.error && current.error) return true;
  if (Boolean(reply.authed) !== Boolean(current.authed)) return Boolean(reply.authed);
  return reply.n > current.n;
}

export const OWNER_COPY = Object.freeze({
  suspended: 'A moderator has hidden this shelf. Nobody else can see it.',
  closed: 'Public shelves are not open yet. Nobody else can see this page.',
  private: 'Only you can see this shelf.',
  published: 'This is what others see.',
  note: 'Books added by hand, notes and dates are never shown here.',
});

/**
 * The one banner an owner sees on their own /u/ page, by precedence:
 * suspended, then closed, then private, then published. A suspended shelf is
 * hidden however it is set, and a closed site shows nobody a published one, so
 * each outranks the setting below it. Nobody but the owner gets a banner.
 */
export function ownerBanner(value) {
  if (!isShelfAnswer(value) || value.isOwner !== true) return null;
  let kind = 'published';
  if (value.suspended === true) kind = 'suspended';
  else if (value.publishingOpen !== true) kind = 'closed';
  else if (value.published !== true) kind = 'private';
  return { kind, text: OWNER_COPY[kind], note: OWNER_COPY.note };
}

// ── The Share dialog ─────────────────────────────────────────────────────────

export const SITE_URL = 'https://vitrina.neorgon.com';

/**
 * What the Share dialog can offer, from a shelf:mine answer, or null when the
 * answer is not a shelf (signed out, erasing, or a failed request).
 *
 * Going private is never gated (setPublished(false) always succeeds), so a
 * shelf published before publishing closed can still be taken down. Going
 * public needs publishing open, an address and no suspension, and the link is
 * worth copying only once all three hold and the shelf is published.
 */
export function shareFacts(mine) {
  if (!isObject(mine) || mine.erasing === true || !Array.isArray(mine.entries)) return null;
  const profile = isObject(mine.profile) ? mine.profile : null;
  const handle = profile && typeof profile.handle === 'string' && profile.handle ? profile.handle : null;
  const published = Boolean(profile && profile.published === true);
  const suspended = Boolean(profile && profile.suspended === true);
  const open = mine.publishingOpen === true;
  return {
    handle,
    published,
    suspended,
    open,
    books: mine.entries.length,
    catalogued: mine.entries.filter((row) => isObject(row) && catalogueId(row.id) !== null).length,
    canPublish: open && handle !== null && !suspended && !published,
    switchable: published || (open && handle !== null && !suspended),
    copyable: published && open && !suspended,
    link: handle ? `${SITE_URL}/u/?${handle}` : null,
  };
}

/** What publishing makes public, said before it is. */
export function sharePreview(handle, catalogued) {
  const who = handle ? `@${handle}` : 'your address';
  return `Visitors see ${who} and ${count(catalogued) === 1 ? '1 catalogue book' : `${count(catalogued)} catalogue books`} grouped by your shelf labels. Never shown: notes, dates, books added by hand.`;
}

/** The confirm before a handle change, naming both of its effects. */
export function changeHandleConfirm(oldHandle) {
  return `Links to /u/?${oldHandle} stop working, and nobody, you included, can take ${oldHandle} for 30 days.`;
}

/** Progress of a deletion, from the shelf:mine answers polled after it started. */
export function deletionCopy(mine) {
  if (isObject(mine) && mine.erasing === true) {
    const left = count(mine.remaining);
    return left
      ? `Deleting your books: ${left} left`
      : 'Your books are deleted. The last of your records clear within a few minutes.';
  }
  return 'Your Vitrina data is deleted.';
}
