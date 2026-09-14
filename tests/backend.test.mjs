// Plain node, no install. Run with: make validate
//
// The pure half of js/backend.js: what the page declares about its backend, and
// the one list of Convex function names the browser calls. A function renamed
// in convex/ and not here would fail at runtime with an opaque error from the
// deployment, so the list is compared with what convex/*.ts actually exports.

import { readFileSync, readdirSync } from 'node:fs';
import * as B from '../js/backend.js';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

// A document holding only the metas named, which is all these functions read.
const doc = (metas) => ({
  querySelector: (selector) => {
    const name = (/meta\[name="([^"]+)"\]/.exec(selector) || [])[1];
    return Object.prototype.hasOwnProperty.call(metas, name)
      ? { getAttribute: (attr) => (attr === 'content' ? metas[name] : null) }
      : null;
  },
});
const throws = (fn) => { try { fn(); return false; } catch (err) { return true; } };

// ── convexUrlFrom ───────────────────────────────────────────────────────────
const PROD = 'https://fantastic-chickadee-557.convex.cloud';
eq(B.convexUrlFrom(doc({})), null, 'no meta means no backend, which is /demo/');
eq(B.convexUrlFrom(doc({ 'neo-convex-url': PROD })), PROD, 'a cloud deployment URL is read as written');
for (const bad of ['', 'http://fantastic-chickadee-557.convex.cloud', `${PROD}/`, 'https://fantastic-chickadee-557.convex.site',
  'https://example.invalid/?x=fantastic-chickadee-557.convex.cloud', ` ${PROD}`, 'https://Fantastic-chickadee-557.convex.cloud']) {
  eq(throws(() => B.convexUrlFrom(doc({ 'neo-convex-url': bad }))), true, `a malformed meta throws instead of reading as no backend: ${JSON.stringify(bad)}`);
}
eq(throws(() => B.convexUrlFrom(null)), false, 'no document at all is no backend, not an error');

// ── clerkKeyFrom ────────────────────────────────────────────────────────────
eq(B.clerkKeyFrom(doc({})), null, 'no key meta, no key');
eq(B.clerkKeyFrom(doc({ 'clerk-publishable-key': ' pk_live_Y2xlcmsubmVvcmdvbi5jb20k ' })), 'pk_live_Y2xlcmsubmVvcmdvbi5jb20k', 'a publishable key is read, trimmed');
eq(B.clerkKeyFrom(doc({ 'clerk-publishable-key': 'sk_live_secret' })), null, 'anything that is not a publishable key is not');

// ── readClientUat ───────────────────────────────────────────────────────────
eq(B.readClientUat(''), null, 'no cookie: Clerk has never run here');
eq(B.readClientUat('theme=matrix; neo_theme=rain'), null, 'other cookies are not a session');
eq(B.readClientUat('__client_uat=0'), 0, 'signed out reads 0');
eq(B.readClientUat('a=1; __client_uat=1726300000; b=2'), 1726300000, 'a session reads its timestamp');
eq(B.readClientUat('__client_uat=0; __client_uat_Y2xlcmsu=1726300001'), 1726300001, 'the newest of the suffixed copies wins');
eq(B.readClientUat('__client_uat=soon'), 0, 'an unreadable value is no session');
eq(B.readClientUat(undefined), null, 'and no cookie string at all is none');

// ── FN against what convex/ exports ─────────────────────────────────────────
const CONVEX = new URL('../convex/', import.meta.url);
const exported = { public: [], internal: [] };
for (const name of readdirSync(CONVEX).filter((file) => file.endsWith('.ts')).sort()) {
  const module = name.slice(0, -3);
  const code = readFileSync(new URL(name, CONVEX), 'utf8');
  for (const match of code.matchAll(/export const (\w+) = (query|mutation|action|internalQuery|internalMutation|internalAction)\(/g)) {
    (match[2].startsWith('internal') ? exported.internal : exported.public).push(`${module}:${match[1]}`);
  }
}
const named = Object.values(B.FN).flatMap((group) => Object.values(group));
eq(exported.public.length >= 11 && exported.internal.length >= 4, true, 'the scan of convex/*.ts found its public and internal functions');
eq(named.slice().sort(), exported.public.slice().sort(), 'FN names every public function, exactly as convex/*.ts exports it');
eq(named.filter((fn) => exported.internal.includes(fn)), [], 'and no internal one, which no browser can call');
eq(B.FN.shelf.mine, 'shelf:mine', 'shelf:mine, for example');
eq(Object.isFrozen(B.FN) && Object.values(B.FN).every(Object.isFrozen), true, 'the names cannot be reassigned at runtime');

// ── The impure half stays out of the way ────────────────────────────────────
const source = readFileSync(new URL('../js/backend.js', import.meta.url), 'utf8');
eq(/^\s*import\s[^(]/m.test(source), false, 'backend.js has no static import, so loading it fetches nothing');
eq(source.includes("import('https://cdn.jsdelivr.net/npm/convex@1.45.0/browser/+esm')"), true, 'the Convex client is the pinned jsDelivr build, by dynamic import');
eq(source.includes("import('./neorgon-auth.js')"), true, 'and the Auth Kit is the vendored copy, by dynamic import');
eq([typeof B.loadClient, typeof B.loadAuthKit], ['function', 'function'], 'both loaders are exported');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
