// ── /u/: a shelf somebody chose to share ─────────────────────────────────────
//
// Read-only, and named in the query (/u/?ana). Anybody gets the public view
// through an anonymous Convex client that is never bound to the Auth Kit, so an
// anonymous visitor's request carries no token, and with no Clerk cookie on the
// fleet clerk-js is never loaded for them. An owner looking at their own
// address gets the owner view, which only a request carrying their token can
// return, through a second client the kit keeps on the token.
//
// Both requests can be out at once and the network decides which lands first,
// so every request is numbered and profileplan.replyWins decides what stays on
// screen: the token reply supersedes the anonymous one whatever the order
// (plan section 3.6). The page title stays generic, and nothing but a shelf the
// server returned ever puts the handle on the page.

import { state, hydrate } from './state.js';
import { render } from './render.js';
import { closeIfGone } from './detail.js';
import { $, escHtml } from './utils.js';
import { hideEmptyOverflow } from './overflow.js';
import { FN, convexUrlFrom, loadClient, loadAuthKit, readClientUat } from './backend.js';
import { handleFromSearch } from './handles.js';
import { indexById } from './syncplan.js';
import { authedCall } from './accountplan.js';
import { PROFILE_COPY, isPublicShelf, ownerBanner, profileState, publicEntries, replyWins } from './profileplan.js';

// hydrate() reads the saved preferences again every time it runs, which would
// put the shelf and its controls out of step each time an answer is repainted.
// What a visitor arranges on a shared shelf lasts the visit.
const ARRANGEMENT = ['view', 'groupBy', 'sortBy', 'trueScale', 'hideOwned', 'showRuns', 'shortcuts'];

let booted = null;
let library = [];
let address = { found: false, handle: null };
let url = null;
let kit = null;
let call = null;
let anonymousLoad = null;
let ownerLoad = null;

let seq = 0;           // every byHandle request takes the next number
let floor = 0;         // replies numbered below this belong to a viewer who has gone
let shown = null;      // the reply on screen: { n, authed, value } or { n, authed, error: true }
let held = null;       // an anonymous reply kept back until the kit has settled
let holding = false;   // somebody may be signed in, so an anonymous null or failure waits for the kit
let viewer = null;     // the userId the page last asked as, null while anonymous
let bannerHtml = null;

export function startProfile(records) {
  if (!booted) {
    booted = boot(records).catch((err) => {
      console.warn('Vitrina could not load this shared shelf:', err && err.message);
      holding = false;
      receive({ n: ++seq, authed: false, error: true });
    });
  }
  return booted;
}

async function boot(records) {
  library = Array.isArray(records) ? records : [];
  address = handleFromSearch(location.search);
  paint();
  const kitLoad = loadAuthKit().then((module) => module.NeoAuth, (err) => {
    console.warn('Vitrina could not load sign-in:', err && err.message);
    return null;
  });
  if (!address.found || !address.handle) {
    // Nothing to ask for. The header still shows the account.
    kit = await kitLoad;
    if (kit) void kit.start();
    return;
  }
  url = convexUrlFrom(document);
  if (!url) throw new Error('this page names no Convex deployment');
  // Read before the first request. With no session anywhere on the fleet the
  // anonymous answer is the only one there will be, and it is shown as it lands.
  holding = readClientUat(document.cookie) > 0;
  void askAnonymously();
  kit = await kitLoad;
  if (!kit) {
    release();
    return;
  }
  call = authedCall(ownerClient, kit);
  // One listener, added once: the kit calls it with the settled state, then on every real change.
  kit.onChange(onAuth);
  void kit.start();
}

function anonymousClient() {
  if (!anonymousLoad) anonymousLoad = loadClient(url).catch((err) => { anonymousLoad = null; throw err; });
  return anonymousLoad;
}

function ownerClient() {
  if (!ownerLoad) {
    ownerLoad = loadClient(url).then((client) => {
      kit.bindConvex(client);
      return client;
    }, (err) => {
      ownerLoad = null;
      throw err;
    });
  }
  return ownerLoad;
}

async function askAnonymously() {
  const n = ++seq;
  try {
    const client = await anonymousClient();
    receive({ n, authed: false, value: await client.query(FN.profiles.byHandle, { handle: address.handle }) });
  } catch (err) {
    receive({ n, authed: false, error: true });
  }
}

async function askAsOwner() {
  const n = ++seq;
  try {
    receive({ n, authed: true, value: await call('query', FN.profiles.byHandle, { handle: address.handle }) });
  } catch (err) {
    receive({ n, authed: true, error: true });
  }
}

function onAuth(snap) {
  if (snap.signedIn) {
    // Somebody else: nothing of the last viewer's page stays while theirs loads.
    if (viewer !== null && viewer !== snap.userId) forget();
    viewer = snap.userId;
    // Still holding: an anonymous null may be this person's own private shelf,
    // which only the reply carrying their token can show.
    void askAsOwner();
    return;
  }
  if (viewer !== null) {
    viewer = null;
    forget();
    void askAnonymously();
  }
  release();
}

/** Clear what is on screen, and every reply still on its way for the viewer who left. */
function forget() {
  floor = seq + 1;
  shown = null;
  held = null;
  paint();
}

/** The kit settled with nobody signed in, so the anonymous answer is the answer. */
function release() {
  holding = false;
  const reply = held;
  held = null;
  if (reply && replyWins(shown, reply, floor)) {
    shown = reply;
    paint();
  }
}

function receive(reply) {
  if (reply.n < floor) return;
  if (!reply.authed && holding && !isPublicShelf(reply.value)) {
    if (replyWins(held, reply, floor)) held = reply;
    return;
  }
  if (!replyWins(shown, reply, floor)) return;
  shown = reply;
  paint();
}

function paint() {
  const name = profileState(address, shown);
  const value = shown && !shown.error ? shown.value : null;
  // The controls, the views, the count and the report control are hidden by CSS in every state but shelf.
  document.body.dataset.profileState = name;
  // So is every control the header kit folds into its ⋯ menu, which then has nothing to open.
  hideEmptyOverflow(document, window);
  showEntries(name === 'shelf' ? publicEntries(value, indexById(library), indexById(state.catalog)) : []);
  paintBanner(name, value);
}

function showEntries(entries) {
  const kept = {};
  ARRANGEMENT.forEach((field) => { kept[field] = state[field]; });
  hydrate(library, 'profile', entries);
  Object.assign(state, kept);
  render();
  closeIfGone();
}

function paintBanner(name, value) {
  const region = $('[data-profile-banner]');
  if (!region) return;
  const parts = [];
  const shelf = name === 'shelf' || name === 'empty';
  if (shelf) parts.push(`<h2 class="profile-banner__title">@${escHtml(value.handle)}</h2>`);
  if (PROFILE_COPY[name]) parts.push(`<p class="profile-banner__text">${escHtml(PROFILE_COPY[name])}</p>`);
  // Said the same way for every cause, and never with the handle in it.
  if (name === 'unavailable') {
    parts.push(`<p class="profile-banner__links">
        <a class="btn btn--secondary btn--sm" href="/demo/">See the demo shelf</a>
        <a class="btn btn--ghost btn--sm" href="/shelf/">Start your own shelf</a>
      </p>`);
  }
  const banner = shelf ? ownerBanner(value) : null;
  if (banner) parts.push(ownerMarkup(banner));
  const html = parts.join('');
  // A live region: writing the same words again would read them out again.
  if (html === bannerHtml) return;
  bannerHtml = html;
  region.innerHTML = html;
}

function ownerMarkup(banner) {
  let more = '';
  // The report beacon on this page reaches the moderators, who are the only ones who can say why.
  if (banner.kind === 'suspended') more = ' To ask about it, use Report a correction on this page.';
  if (banner.kind === 'private') more = ' To make it public, use Share on <a href="/shelf/">your shelf</a>.';
  return `<div class="owner-banner owner-banner--${banner.kind}" role="note">
      <p>${escHtml(banner.text)}${more}</p>
      <p class="owner-banner__note">${escHtml(banner.note)}</p>
    </div>`;
}
