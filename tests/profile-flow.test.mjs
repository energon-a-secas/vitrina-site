// Plain node, no install. Run with: make validate
//
// /u/ shows a shelf somebody published, and on your own address the owner view
// only your token can fetch. js/profile.js runs two clients and a kit that
// settles late, and accountplan.replyWins decides which reply stays; this holds
// the module to that on the generated u/index.html, against the fakes in
// tests/support/shelfworld.mjs.

import { openWorld, row, LIBRARY, checker } from './support/shelfworld.mjs';

const t = checker();
const eq = t.eq;
const stateOf = (w) => w.doc.body.getAttribute('data-profile-state');

async function profilePage({ search, cookie = '', publishingOpen = false, seed = () => {}, before = () => {} } = {}) {
  const w = await openWorld({ page: 'u', search, cookie, publishingOpen });
  seed(w.server);
  before(w);
  w.P = await w.import('profile.js');
  w.P.startProfile(LIBRARY);
  await w.flush();
  return w;
}

// ── What the page says, and never repeats ───────────────────────────────────
for (const search of ['?zz%20qq', '?zzqq-nobody', '?%3Cb%3Ezzqq%3C%2Fb%3E']) {
  const w = await profilePage({ search });
  await w.kit.signOut({ loaded: false });
  await w.flush();
  const banner = w.$('[data-profile-banner]').innerHTML;
  eq([stateOf(w), banner.includes('zz'), banner.includes('qq')], ['unavailable', false, false], `/u/${search} is Unavailable, and the page never repeats what the link named`);
}

// ── Anonymous and owner requests ────────────────────────────────────────────
{
  const w = await profilePage({ search: '?ana', publishingOpen: true, seed: (s) => s.seed('u2', [row(101, { shelf: 'Nova' })], { handle: 'ana', published: true }) });
  eq([stateOf(w), w.keys()], ['shelf', ['tf101']], 'with no session cookie, a published shelf shows as its anonymous answer lands');
  eq(w.server.calls('profiles:byHandle').map((c) => c.user), [null], 'asked once, carrying no token');
  await w.kit.signIn('u1');
  await w.flush();
  const anonymous = w.clients[0];
  eq([Boolean(anonymous), anonymous && w.kit.clients.has(anonymous), anonymous && anonymous.auth], [true, false, undefined],
    'through a client the kit never holds a token on, even once somebody signs in');
}
{
  const w = await profilePage({ search: '?ana', cookie: '__client_uat=1757000000', publishingOpen: true, seed: (s) => s.seed('u1', [row(101)], { handle: 'ana', published: false }) });
  eq(stateOf(w), 'loading', "with a session on the fleet, an anonymous null waits for the kit, since it may be this person's own private shelf");
  await w.kit.signIn('u1');
  await w.flush();
  eq([stateOf(w), w.text('.owner-banner p')], ['shelf', 'Only you can see this shelf. To make it public, use Share on your shelf.'], 'the owner sees their private shelf with its banner');
}
{
  const w = await profilePage({ search: '?ana', cookie: '__client_uat=1757000000', seed: (s) => s.seed('u1', [row(101)], { handle: 'ana', published: false }) });
  const owner = w.server.hold('profiles:byHandle', { user: 'u1' });
  await w.kit.signIn('u1');
  await w.flush();
  await w.kit.signOut();
  await w.flush();
  owner.release();
  await w.flush();
  eq([stateOf(w), Boolean(w.$('.owner-banner'))], ['unavailable', false], "an owner's reply that lands after they signed out is dropped, owner banner and all");
}

// ── The header on a phone ───────────────────────────────────────────────────
// The kit's ⋯ as js/neorgon-header.js builds it at 700 px and below, holding the
// controls it folded, with display worked out the way css/style.css hides them
// on /u/: always for the edit controls, and outside Shelf for the Shelf report.
function phoneHeader(w) {
  w.$('.header-actions').insertAdjacentHTML('beforeend',
    '<div class="header-overflow"><button type="button" class="header-overflow-toggle">More</button><div class="header-menu header-overflow-menu"></div></div>');
  const menu = w.$('.header-overflow-menu');
  ['addBtn', 'shareBtn', 'statsBtn', 'exportBtn', 'importBtn'].forEach((id) => menu.appendChild(w.$('#' + id)));
  const always = new Set(['addBtn', 'isbnBtn', 'shareBtn', 'exportBtn', 'importBtn']);
  globalThis.getComputedStyle = (el) => ({
    display: always.has(el.id) || (el.id === 'statsBtn' && w.doc.body.getAttribute('data-profile-state') !== 'shelf') ? 'none' : 'inline-flex',
  });
}
{
  const w = await profilePage({ search: '?zzqq-nobody', before: phoneHeader });
  await w.kit.signOut({ loaded: false });
  await w.flush();
  eq([stateOf(w), w.$('.header-overflow').hidden], ['unavailable', true], 'outside Shelf, with nothing in it drawn, the ⋯ toggle is hidden rather than opening an empty panel');
}
{
  const w = await profilePage({ search: '?ana', publishingOpen: true, before: phoneHeader, seed: (s) => s.seed('u2', [row(101)], { handle: 'ana', published: true }) });
  eq([stateOf(w), w.$('.header-overflow').hidden], ['shelf', false], 'and on a shelf, where the Shelf report is drawn, it shows again');
}
globalThis.getComputedStyle = undefined;

t.done();
