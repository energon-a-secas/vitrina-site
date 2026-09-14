// ── What a shared shelf at /u/ decides ───────────────────────────────────────
//
// Pure: no DOM, no storage, no network, and nothing imported but syncplan.js,
// which is pure too. profile.js does the talking and the painting; which of its
// six states the page is in, which reply stays on screen and which banner an
// owner sees are decided here (plan section 3.6). Those go wrong quietly: an
// anonymous answer painted over the owner's own, or a banner telling a
// suspended owner their shelf is public, still looks like a working page. So
// tests/accountplan.test.mjs pins every rule, and tests/profile-flow.test.mjs
// runs profile.js on them. accountplan.js holds the same for the account shelf
// and the Share dialog.

import { catalogueId, fromServerEntry } from './syncplan.js';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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
