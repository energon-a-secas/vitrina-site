// ── Where the page finds its backend ─────────────────────────────────────────
//
// Two halves. The pure half reads what the page itself declares (the Convex
// deployment in <meta name="neo-convex-url">, the Clerk key, the sign-in
// cookie) and names every Convex function the browser calls, in one place, so
// a renamed function is one edit and one failing test instead of a string
// scattered through three modules. Node tests import it.
//
// The impure half loads the Convex client and the Auth Kit, both by dynamic
// import, so a page that never needs an account never downloads either, and
// importing this file anywhere fetches nothing.

/** A Convex cloud deployment URL, and nothing else. */
export const CONVEX_URL_RE = /^https:\/\/[a-z-]+-\d+\.convex\.cloud$/;

/**
 * Every function a browser may call, named exactly as convex/*.ts exports it.
 * The internal purge:* functions are absent because no browser can call them.
 * tests/backend.test.mjs reads convex/*.ts and fails when the two disagree.
 */
export const FN = Object.freeze({
  shelf: Object.freeze({
    mine: 'shelf:mine',
    upsertEntries: 'shelf:upsertEntries',
    updateEntry: 'shelf:updateEntry',
    removeEntry: 'shelf:removeEntry',
  }),
  profiles: Object.freeze({
    claimHandle: 'profiles:claimHandle',
    setPublished: 'profiles:setPublished',
    byHandle: 'profiles:byHandle',
    deleteMyData: 'profiles:deleteMyData',
  }),
  admin: Object.freeze({
    setSuspended: 'admin:setSuspended',
    purgeByHandle: 'admin:purgeByHandle',
    releaseHandle: 'admin:releaseHandle',
    setSubjectSuspended: 'admin:setSubjectSuspended',
    purgeBySubject: 'admin:purgeBySubject',
  }),
});

function meta(doc, name) {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  return doc.querySelector(`meta[name="${name}"]`);
}

/**
 * The deployment this page talks to, or null when the page names none, which
 * /demo/ does on purpose. A meta that is present but malformed throws: read as
 * "no backend", a typo there would quietly run the page as a browser-only shelf
 * for somebody who is signed in.
 */
export function convexUrlFrom(doc) {
  const tag = meta(doc, 'neo-convex-url');
  if (!tag) return null;
  const url = tag.getAttribute('content') || '';
  if (!CONVEX_URL_RE.test(url)) {
    throw new Error(`neo-convex-url must be a Convex cloud deployment URL, not ${JSON.stringify(url.slice(0, 80))}`);
  }
  return url;
}

/** The Clerk publishable key the page declares for the Auth Kit, or null. */
export function clerkKeyFrom(doc) {
  const tag = meta(doc, 'clerk-publishable-key');
  const key = tag ? (tag.getAttribute('content') || '').trim() : '';
  return /^pk_(test|live)_\S+$/.test(key) ? key : null;
}

/**
 * Clerk's __client_uat, read the way the Auth Kit reads it: null when Clerk has
 * never run on this domain, 0 when signed out, otherwise the newest timestamp
 * across __client_uat and its suffixed copies. /u/ reads it before its first
 * request: with no session there is no token to ask for, so the anonymous query
 * runs alone and clerk-js is never loaded for that visitor.
 */
export function readClientUat(cookie) {
  let found = false;
  let newest = 0;
  for (const part of String(cookie == null ? '' : cookie).split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (name !== '__client_uat' && !name.startsWith('__client_uat_')) continue;
    found = true;
    const value = Number(part.slice(at + 1).trim());
    if (Number.isFinite(value) && value > newest) newest = value;
  }
  return found ? newest : null;
}

/**
 * A ConvexHttpClient for url, from the pinned jsDelivr build (one self-contained
 * file). The URL is checked again here because it decides where a sign-in token
 * is sent.
 */
export async function loadClient(url) {
  if (!CONVEX_URL_RE.test(String(url))) throw new Error('loadClient needs a Convex cloud deployment URL');
  const { ConvexHttpClient } = await import('https://cdn.jsdelivr.net/npm/convex@1.45.0/browser/+esm');
  return new ConvexHttpClient(url);
}

/** The Auth Kit, vendored next to this file by packages/neorgon-ui/sync-auth.sh. */
export async function loadAuthKit() {
  return import('./neorgon-auth.js');
}
