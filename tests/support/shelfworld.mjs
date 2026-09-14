// A page, a Convex deployment and the Auth Kit, for the flow tests.
//
// Each world is a fresh copy of js/ in a temporary directory, so every module
// starts with its own state, with two files swapped: render.js draws nothing
// (the tests read state and the strips), and backend.js hands out the fakes
// below instead of fetching the Convex client and the kit. The page is the
// generated shelf/index.html or u/index.html, parsed by minidom.mjs.
//
// The fakes follow what the real things do where it decides an outcome:
//   - FakeClient queues mutations one at a time and reads its token when each
//     one is dispatched, as ConvexHttpClient 1.45 does in mutationInner.
//   - fakeKit re-tokens the clients bound to it before it tells listeners, as
//     refresh() in js/neorgon-auth.js awaits syncClients() before commit().
//   - fakeServer answers from the token's user, as convex/lib does from the
//     identity, and a gate can hold, fail, lose the answer to or replace one request.
//   - time only moves when a test advances the fake clock.

import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CustomEvent, Document, Event } from './minidom.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const made = [];
process.on('exit', () => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

export const LIBRARY = [
  { id: 101, title: 'Demo one', dimensions: '11x18', pages: 210, shelf: 'Nova' },
  { id: 102, title: 'Demo two', dimensions: '12x19', pages: 320, shelf: 'VIB' },
  { id: 103, title: 'Demo three', pages: 280, shelf: 'B de Bolsillo' },
];
export const CATALOG = Array.from({ length: 260 }, (_, i) => ({ id: 1000 + i, title: `Catalogue book ${1000 + i}` }));

/** A browser shelf entry for a catalogue book, as vitrina_shelf_v1 stores one. */
export function stored(id, extra = {}) {
  const record = LIBRARY.find((r) => r.id === id) || CATALOG.find((r) => r.id === id) || { id, title: `Book ${id}` };
  return { key: 'tf' + id, id, slug: null, shelf: null, note: null, listed_as: null, added: null, record: { ...record }, ...extra };
}

/** A shelf:mine row for a catalogue book. */
export function row(id, extra = {}) {
  return { key: 'tf' + id, id, shelf: null, note: null, listedAs: null, added: null, record: null, ...extra };
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// ── Time ─────────────────────────────────────────────────────────────────────

export function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const next = (limit) => {
    let best = null;
    for (const t of timers.values()) if (t.at <= limit && (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq))) best = t;
    return best;
  };
  const drain = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const clock = {
    setTimeout: (fn, ms = 0, ...args) => {
      seq += 1;
      timers.set(seq, { seq, at: now + Math.max(0, Number(ms) || 0), fn: () => fn(...args) });
      return seq;
    },
    clearTimeout: (id) => { timers.delete(id); },
    /** Run every microtask, and every timer due now, until nothing is left to run. */
    async flush() {
      for (let round = 0; round < 200; round += 1) {
        await drain();
        const due = next(now);
        if (!due) return;
        timers.delete(due.seq);
        due.fn();
      }
      throw new Error('fakeClock.flush: a timer keeps rescheduling itself at zero delay');
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await clock.flush();
        const due = next(end);
        if (!due) break;
        now = due.at;
        timers.delete(due.seq);
        due.fn();
      }
      now = end;
      await clock.flush();
    },
    /** Delays of the timers still waiting, from now. */
    pending: () => Array.from(timers.values()).map((t) => t.at - now),
  };
  return clock;
}

// ── The deployment ───────────────────────────────────────────────────────────

const fail = (code, extra = {}) => ({ ok: false, code, message: `refused: ${code}`, ...extra });
const FILLABLE = ['shelf', 'note', 'listedAs', 'added'];

const HANDLERS = {
  'shelf:mine'(server, user) {
    if (!user) return null;
    const a = server.account(user);
    if (a.erasing) return { erasing: true, remaining: a.erasing.remaining };
    const entries = Array.from(a.rows.values());
    return {
      erasing: false,
      profile: a.profile ? { handle: a.profile.handle, published: a.profile.published, suspended: a.profile.suspended } : null,
      entries, count: entries.length, max: 2000, truncated: false, publishingOpen: server.publishingOpen,
    };
  },
  'shelf:upsertEntries'(server, user, args) {
    if (!user) return fail('not-signed-in');
    const a = server.account(user);
    if (a.erasing) return fail('erasing');
    let added = 0;
    let skipped = 0;
    let filled = 0;
    const seen = new Set();
    for (const e of args.entries) {
      const existing = a.rows.get(e.key);
      if (seen.has(e.key) || (existing && args.fillEmpty !== true)) { skipped += 1; seen.add(e.key); continue; }
      seen.add(e.key);
      if (!existing) {
        a.rows.set(e.key, { key: e.key, id: e.catalogId, shelf: e.shelf, note: e.note, listedAs: e.listedAs, added: e.added, record: e.record });
        added += 1;
        continue;
      }
      const gaps = FILLABLE.filter((field) => existing[field] === null && e[field] !== null);
      gaps.forEach((field) => { existing[field] = e[field]; });
      if (gaps.length) filled += 1;
      else skipped += 1;
    }
    return { ok: true, added, skipped, filled, total: a.rows.size };
  },
  'shelf:updateEntry'(server, user, args) {
    if (!user) return fail('not-signed-in');
    const a = server.account(user);
    if (a.erasing) return fail('erasing');
    const existing = a.rows.get(args.key);
    if (!existing) return fail('not-found');
    if (args.note !== undefined) existing.note = args.note;
    if (args.shelf !== undefined) existing.shelf = args.shelf;
    return { ok: true };
  },
  'shelf:removeEntry'(server, user, args) {
    if (!user) return fail('not-signed-in');
    const a = server.account(user);
    if (a.erasing) return fail('erasing');
    return { ok: true, removed: a.rows.delete(args.key) };
  },
  'profiles:byHandle'(server, user, args) {
    for (const [owner, a] of server.accounts) {
      if (!a.profile || a.profile.handle !== args.handle) continue;
      const isOwner = owner === user;
      if (!isOwner && (a.profile.suspended || !a.profile.published || !server.publishingOpen)) return null;
      const books = Array.from(a.rows.values()).filter((r) => r.id != null).map((r) => ({ id: r.id, shelf: r.shelf })).sort((x, y) => x.id - y.id);
      if (!isOwner) return { handle: a.profile.handle, books };
      return { handle: a.profile.handle, books, isOwner: true, published: a.profile.published, suspended: a.profile.suspended, publishingOpen: server.publishingOpen };
    }
    return null;
  },
  'profiles:claimHandle'(server, user, args) {
    if (!user) return fail('not-signed-in');
    const a = server.account(user);
    if (a.profile && a.profile.handle === args.handle) return fail('same-handle');   // as claimHandleCore
    a.profile = { published: false, suspended: false, ...(a.profile || {}), handle: args.handle };
    return { ok: true, handle: args.handle };
  },
  'profiles:setPublished'(server, user, args) {
    if (!user) return fail('not-signed-in');
    const a = server.account(user);
    if (args.published && args.confirmAge !== true) return fail('age-required');
    if (args.published && !server.publishingOpen) return fail('publishing-closed');
    if (a.profile) a.profile.published = Boolean(args.published);
    return { ok: true, published: Boolean(args.published) };
  },
  'profiles:deleteMyData'(server, user) {
    if (!user) return fail('not-signed-in');
    server.erase(user);
    return { ok: true, status: 'erasing' };
  },
};

export function fakeServer({ publishingOpen = false } = {}) {
  const gates = [];
  const server = {
    accounts: new Map(),
    log: [],
    publishingOpen,
    account(user) {
      if (!server.accounts.has(user)) server.accounts.set(user, { rows: new Map(), profile: null, erasing: null });
      return server.accounts.get(user);
    },
    seed(user, rows = [], profile = null) {
      const a = server.account(user);
      rows.forEach((r) => a.rows.set(r.key, clone(r)));
      if (profile) a.profile = { handle: null, published: false, suspended: false, ...profile };
      return a;
    },
    erase(user) {
      const a = server.account(user);
      a.erasing = { remaining: a.rows.size };
      a.rows.clear();
      a.profile = null;
    },
    finishErasing(user) { server.account(user).erasing = null; },
    keys: (user) => Array.from(server.account(user).rows.keys()),
    calls: (name, user) => server.log.filter((c) => c.name === name && (user === undefined || c.user === user)),
    /** Every mutation that reached the deployment, as "user:name(keys)". */
    mutations: () => server.log.filter((c) => c.kind === 'mutation')
      .map((c) => `${c.user}:${c.name}(${c.args.key || (Array.isArray(c.args.entries) ? c.args.entries.map((e) => e.key).join(',') : '')})`),
    // A gate takes the next matching request. hold() waits for release(); the
    // answer is worked out when the request arrives and delivered on release,
    // so a held shelf:mine carries the shelf as it was when it was asked.
    hold: (name, options = {}) => gate(name, { ...options, held: true }),
    fail: (name, options = {}) => gate(name, { ...options, mode: 'throw' }),
    answer: (name, value, options = {}) => gate(name, { ...options, mode: 'answer', value }),
    lose: (name, options = {}) => gate(name, { ...options, mode: 'lost' }),   // reaches the account, then throws on the way back
    async request(kind, name, args, auth) {
      const user = typeof auth === 'string' && auth.startsWith('tok:') ? auth.split(':')[1] : null;
      server.log.push({ kind, name, user, args: clone(args || {}) });
      const g = gates.find((x) => x.name === name && x.times > 0 && (x.user === undefined || x.user === user)) || null;
      if (g) { g.times -= 1; g.taken += 1; }
      if (g && g.mode === 'throw') { await g.opened; throw new Error('the request did not reach the deployment'); }
      if (g && g.mode === 'answer') { await g.opened; return clone(g.value); }
      const answer = clone(HANDLERS[name](server, user, args || {}));
      await (g ? g.opened : null);
      if (g && g.mode === 'lost') throw new Error('the connection dropped after the account took the request');
      return answer;
    },
  };
  function gate(name, { user, mode = 'deliver', value, times = 1, held = false }) {
    let release = null;
    const opened = new Promise((resolve) => { release = resolve; });
    if (!held) release();
    const g = { name, user, mode, value, times, taken: 0, opened, release: () => release() };
    gates.push(g);
    return g;
  }
  return server;
}

export class FakeClient {
  constructor(server, url) {
    this.server = server;
    this.url = url;
    this.auth = undefined;
    this.queue = [];
    this.busy = false;
  }
  setAuth(token) { this.auth = token; }
  clearAuth() { this.auth = undefined; }
  query(name, args) { return this.server.request('query', name, args, this.auth); }
  mutation(name, args) {
    return new Promise((resolve, reject) => {
      this.queue.push({ name, args, resolve, reject });
      void this.pump();
    });
  }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const job = this.queue.shift();
      try {
        job.resolve(await this.server.request('mutation', job.name, job.args, this.auth));
      } catch (err) {
        job.reject(err);
      }
    }
    this.busy = false;
  }
}

// ── The Auth Kit ─────────────────────────────────────────────────────────────

export function fakeKit({ clock, mintDelay = 0, syncDelay = 0 } = {}) {
  const SETTLED = new Set(['signed-in', 'signed-out', 'unavailable']);
  const listeners = new Set();
  const k = { status: 'loading', userId: null, label: '', session: null, loaded: false };
  let settle = null;
  const started = new Promise((resolve) => { settle = resolve; });
  let sessions = 0;
  const clerk = { get session() { return k.session; } };
  const snapshot = () => ({ status: k.status, signedIn: k.status === 'signed-in', userId: k.userId, label: k.label, clerk: k.loaded ? clerk : null });

  function makeSession(userId) {
    sessions += 1;
    const session = {
      id: `sess_${sessions}`,
      user: { id: userId },
      ended: false,
      async getToken(options = {}) {
        kit.mints.push({ uid: userId, skipCache: Boolean(options.skipCache) });
        if (options.skipCache && mintDelay) await new Promise((resolve) => clock.setTimeout(resolve, mintDelay));
        return session.ended ? null : `tok:${userId}:${session.id}`;
      },
    };
    return session;
  }
  async function syncClients() {
    // The real kit waits on a token mint here, with the session already swapped and the old token still on the clients.
    if (syncDelay) await new Promise((resolve) => clock.setTimeout(resolve, syncDelay));
    const token = k.session ? await k.session.getToken({ template: 'convex' }) : null;
    for (const client of kit.clients) {
      if (token) client.setAuth(token);
      else client.clearAuth();
    }
  }
  function commit(next) {
    const before = `${k.status}|${k.userId}|${k.label}`;
    Object.assign(k, next);
    if (before === `${k.status}|${k.userId}|${k.label}` || !SETTLED.has(k.status)) return;
    const snap = snapshot();
    for (const fn of Array.from(listeners)) fn(snap);
  }

  const kit = {
    clients: new Set(),
    mints: [],
    dialogs: [],          // every sign-in dialog opened, with what onShowModal saw at that moment
    onShowModal: null,
    startCalls: 0,
    get state() { return snapshot(); },
    start() { kit.startCalls += 1; return started; },
    onChange(fn) {
      listeners.add(fn);
      if (SETTLED.has(k.status)) queueMicrotask(() => { if (listeners.has(fn)) fn(snapshot()); });
      return () => listeners.delete(fn);
    },
    bindConvex(client) {
      if (!client || typeof client.setAuth !== 'function' || kit.clients.has(client)) return;
      kit.clients.add(client);
      if (k.loaded) void syncClients();
    },
    async convexToken() { return k.session ? k.session.getToken({ template: 'convex' }) : null; },
    // js/neorgon-auth.js: both await start(); openSignIn calls showModal only when not signed in.
    async openSignIn(options = {}) {
      await started;
      if (k.status === 'signed-in') return true;
      kit.dialogs.push({ reason: options.reason || '', page: kit.onShowModal ? kit.onShowModal() : null });
      return false;
    },
    async requireSignIn(options = {}) {
      await started;
      if (k.status === 'signed-in') return true;
      return kit.openSignIn(options);
    },

    // What a test does: the session changes first, bound clients are re-tokened, then listeners hear.
    async signIn(userId, label = userId) {
      k.loaded = true;
      if (k.session) k.session.ended = true;
      k.session = makeSession(userId);
      await syncClients();
      commit({ status: 'signed-in', userId, label });
      settle(snapshot());
    },
    async signOut({ loaded = true } = {}) {
      k.loaded = loaded;
      if (k.session) k.session.ended = true;
      k.session = null;
      await syncClients();
      commit({ status: 'signed-out', userId: null, label: '' });
      settle(snapshot());
    },
    relabel(label) { commit({ label }); },
  };
  return kit;
}

// ── A page ───────────────────────────────────────────────────────────────────

const RENDER_STUB = `// Flow tests draw nothing; they read state and the strips.
export function render() { globalThis.__world.renders += 1; }
export function markSelected() {}
`;
const BACKEND_STUB = `export * from './backend.real.js';
export async function loadClient(url) { return globalThis.__world.loadClient(url); }
export async function loadAuthKit() { return globalThis.__world.loadAuthKit(); }
`;

function caseDir() {
  const dir = mkdtempSync(join(tmpdir(), 'vitrina-flow-'));
  made.push(dir);
  const js = join(ROOT, 'js');
  for (const name of readdirSync(js)) {
    if (!name.endsWith('.js') || name.startsWith('neorgon-') || name === 'render.js') continue;
    copyFileSync(join(js, name), join(dir, name === 'backend.js' ? 'backend.real.js' : name));
  }
  writeFileSync(join(dir, 'render.js'), RENDER_STUB);
  writeFileSync(join(dir, 'backend.js'), BACKEND_STUB);
  return dir;
}

function storage(map) {
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

/**
 * A generated page with a fresh copy of the modules, hydrated as app.js does.
 * page is 'shelf' or 'u'. The test then starts account.js or profile.js.
 */
export async function openWorld({ page = 'shelf', search = '', cookie = '', shelf = null, publishingOpen = false, kitLoadFails = false, mintDelay = 0, syncDelay = 0, reloadOf = null } = {}) {
  const clock = fakeClock();
  const doc = new Document(readFileSync(join(ROOT, page, 'index.html'), 'utf8'));
  doc.cookie = cookie;
  const world = {
    dir: caseDir(), clock, doc, server: fakeServer({ publishingOpen }), kit: fakeKit({ clock, mintDelay, syncDelay }),
    local: new Map(), session: new Map(), renders: 0, clients: [], warnings: [], confirms: [], confirmAnswer: true, copied: [],
  };
  world.loadClient = async (url) => {
    const client = new FakeClient(world.server, url);
    world.clients.push(client);
    return client;
  };
  world.loadAuthKit = async () => {
    if (kitLoadFails) throw new Error('the kit did not load');
    return { NeoAuth: world.kit };
  };
  // reloadOf is an earlier page in the same tab, and this one opens on its localStorage and sessionStorage.
  if (reloadOf) ['local', 'session'].forEach((store) => reloadOf[store].forEach((value, key) => world[store].set(key, value)));
  if (shelf) world.local.set('vitrina_shelf_v1', JSON.stringify({ v: 1, entries: shelf }));

  const g = globalThis;
  g.__world = world;
  g.window = g;
  g.document = doc;
  g.localStorage = storage(world.local);
  g.sessionStorage = storage(world.session);
  g.Event = Event;
  g.CustomEvent = CustomEvent;
  g.setTimeout = clock.setTimeout;
  g.clearTimeout = clock.clearTimeout;
  g.requestAnimationFrame = (fn) => { queueMicrotask(() => fn(0)); return 0; };
  g.confirm = (text) => { world.confirms.push(text); return world.confirmAnswer; };
  g.console.warn = (...args) => { world.warnings.push(args.join(' ')); };
  Object.defineProperty(g, 'location', { value: { search, href: `https://vitrina.neorgon.com/${page}/${search}`, hostname: 'vitrina.neorgon.com' }, configurable: true, writable: true });
  Object.defineProperty(g, 'navigator', { value: { clipboard: { writeText: async (text) => { world.copied.push(text); } } }, configurable: true, writable: true });

  world.import = (name) => import(pathToFileURL(join(world.dir, name)).href);
  world.S = await world.import('state.js');
  world.S.hydrate(LIBRARY, doc.body.getAttribute('data-mode'));
  world.S.state.catalog = CATALOG;
  world.flush = () => clock.flush();
  world.advance = (ms) => clock.advance(ms);
  world.$ = (selector) => doc.querySelector(selector);
  world.text = (selector) => {
    const el = doc.querySelector(selector);
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  };
  world.keys = () => world.S.state.entries.map((e) => e.key);
  world.stored = () => {
    try { return JSON.parse(world.local.get('vitrina_shelf_v1')).entries; } catch (err) { return null; }
  };
  world.toasts = () => doc.texts('toast');
  world.visible = async () => {
    doc.dispatchEvent(new Event('visibilitychange'));
    await clock.flush();
  };
  world.fire = async (el, type) => {
    if (el) el.dispatchEvent(new Event(type, { bubbles: true }));
    await clock.flush();
  };
  return world;
}

/** /shelf/ with account.js started, as app.js starts it. */
export async function openShelf(options = {}) {
  const world = await openWorld({ ...options, page: 'shelf' });
  world.A = await world.import('account.js');
  world.A.startAccount('shelf');
  await world.flush();
  return world;
}

/** Plain node assertions in the style of the other tests. */
export function checker() {
  const t = { failed: 0 };
  t.eq = (actual, expected, what) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
      t.failed += 1;
      console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
    } else console.log(`ok   ${what}`);
  };
  t.done = () => {
    console.log(t.failed ? `\n${t.failed} failed` : '\nall passed');
    process.exit(t.failed ? 1 : 0);
  };
  return t;
}
