// Plain node, no install. Run with: make validate
//
// Every page carries a <meta> Content-Security-Policy, and a meta policy sends
// no reports: a source it forgets fails in a visitor's console and nowhere else.
// Most of what these pages load is loaded late (the Convex client once a page
// needs an account, the barcode ponyfill only when a browser lacks the native
// detector and somebody opens the camera, catalogue scans as a row scrolls), so
// a page that has merely been opened under-reports its own sources. This reads
// what the code loads from the code, and holds each page's policy to it offline.
//
// What it does not own: the Auth Kit's sources (clerk.neorgon.com, Turnstile,
// img.clerk.com, blob: workers, inline styles) are the kit's table in
// packages/neorgon-ui/auth/README.md, enforced by sync-auth.sh --check, and the
// fleet-wide inline-script pass is smoke check 29. This file adds what neither
// can know: Vitrina's own modules, images and deployment.
//
// Each guard below is tripped once at the end, on a changed copy of a real page.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

const ROOT = new URL('..', import.meta.url).pathname;
const ORIGIN = 'https://vitrina.neorgon.com';
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ── What the code loads, read from the code ─────────────────────────────────
const backend = read('js/backend.js');
const camera = read('js/camera.js');
const header = read('js/neorgon-header.js');   // vendored kit: read here, never edited
const routesPy = read('scripts/routes.py');

const CONVEX_CLIENT = (backend.match(/import\('(https:\/\/[^']+)'\)/) || [])[1];
const PONYFILL = (camera.match(/^const PONYFILL = '([^']+)'/m) || [])[1];
const CONVEX_URL = (routesPy.match(/^CONVEX_URL = "([^"]+)"/m) || [])[1];
const GOATCOUNTER = (header.match(/var GOATCOUNTER = '([^']+)'/) || [])[1];
const CF_BEACON = (header.match(/cf\.src = '([^']+)'/) || [])[1];
const GC_SCRIPT = (header.match(/gc\.src = '([^']+)'/) || [])[1];
eq({ CONVEX_CLIENT, PONYFILL, CONVEX_URL, GOATCOUNTER, CF_BEACON, GC_SCRIPT }, {
  CONVEX_CLIENT: 'https://cdn.jsdelivr.net/npm/convex@1.45.0/browser/+esm',
  PONYFILL: 'https://esm.sh/barcode-detector@3.2.2/pure',
  CONVEX_URL: 'https://fantastic-chickadee-557.convex.cloud',
  GOATCOUNTER: 'https://neorgon.goatcounter.com/count',
  CF_BEACON: 'https://static.cloudflareinsights.com/beacon.min.js',
  GC_SCRIPT: 'https://gc.zgo.at/count.v5.js',
}, 'every URL the policies are held to was found where the code keeps it (a bump lands here first: check the policy, then this line)');

// Every module a site file imports from another origin by a literal URL. A new
// one fails the app pages below until their policy admits it.
const REMOTE_MODULES = new Set([PONYFILL]);
for (const name of readdirSync(join(ROOT, 'js')).filter((f) => f.endsWith('.js'))) {
  const source = read(`js/${name}`);
  for (const m of source.matchAll(/import\(\s*(?:\/\*.*?\*\/\s*)?'(https:\/\/[^']+)'\s*\)|\bfrom\s+'(https:\/\/[^']+)'/g)) {
    REMOTE_MODULES.add(m[1] || m[2]);
  }
}
eq([...REMOTE_MODULES].sort(), [CONVEX_CLIENT, PONYFILL].sort(), 'the site imports two modules from other origins: the Convex client and the barcode ponyfill');

// Catalogue scans, from the builders themselves, with remote images on.
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const data = await import('../js/data.js');
const CATALOGUE_IMAGES = [data.spineUrl(622), data.coverUrl(622)];
eq(CATALOGUE_IMAGES.every((url) => url.startsWith('https://')), true, 'js/data.js builds https URLs for a spine and a cover scan');

// ── What the code loads, read from outside the repo ─────────────────────────
// The ponyfill's own module graph and its wasm, as esm.sh served PONYFILL on
// 2026-11-03: the same paths for Chrome, Safari 15, Safari 17 and Firefox user
// agents. The wasm URL is pinned inside barcode-detector@3.2.2's own build. A
// ponyfill bump fails the PONYFILL line above, which is the cue to read the new
// graph (curl the entry, then each import in turn) and update both lists.
const PONYFILL_GRAPH = [
  'https://esm.sh/barcode-detector@3.2.2/es2022/pure.mjs',
  'https://esm.sh/barcode-detector@3.2.2/es2022/dist/es/zxing-exported.mjs',
  'https://esm.sh/node/process.mjs',
  'https://esm.sh/node/events.mjs',
  'https://esm.sh/node/tty.mjs',
  'https://esm.sh/node/async_hooks.mjs',
];
const PONYFILL_WASM = 'https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.3/dist/reader/zxing_reader.wasm';
// Where Cloudflare's beacon posts its measurements for a site it does not proxy.
const CF_REPORTS = 'https://cloudflareinsights.com/cdn-cgi/rum';
// Neither of these is ours to name, and both show the boundary of a scope.
const OTHER_JSDELIVR = ['https://cdn.jsdelivr.net/npm/left-pad@1.3.0/index.js', 'https://cdn.jsdelivr.net/gh/someone/repo/x.js'];
const OTHER_ESM = ['https://esm.sh/left-pad@1.3.0', 'https://esm.sh/barcode-detector@3.2.1/pure'];

// ── Reading a policy ────────────────────────────────────────────────────────
// The exact shape smoke check 29 and authkit.py both parse. A meta written any
// other way would still be enforced by the browser while both of them skip it.
const META = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g;
const ANY_META = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy/gi;
// Directives a browser ignores in a meta policy (CSP Level 3, section 3.3).
const IGNORED_IN_META = ['frame-ancestors', 'report-uri', 'sandbox'];

function parse(text) {
  const policy = new Map();
  for (const part of text.split(';')) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (bits.length && !policy.has(bits[0].toLowerCase())) policy.set(bits[0].toLowerCase(), bits.slice(1));
  }
  return policy;
}

const FALLBACK = {
  'frame-src': ['frame-src', 'child-src', 'default-src'],
  'worker-src': ['worker-src', 'child-src', 'script-src', 'default-src'],
};
function sourcesFor(policy, directive) {
  for (const name of FALLBACK[directive] || [directive, 'default-src']) {
    if (policy.has(name)) return policy.get(name);
  }
  return null;   // nothing governs it
}

const HASH = /^'sha(256|384|512)-/i;
const NONCE = /^'nonce-/i;

/** Whether one source expression matches url, as a browser on ORIGIN would decide it. */
function matches(token, url) {
  const u = new URL(url, ORIGIN);
  const t = token.toLowerCase();
  if (t === '*') return ['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol);
  if (t === "'self'") return u.origin === ORIGIN;
  if (t.startsWith("'")) return false;   // 'none', hashes, nonces and keywords name no URL
  if (/^[a-z][a-z0-9+.-]*:$/.test(t)) return u.protocol === t;
  const m = token.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:*]+)(?::(\d+|\*))?(\/.*)?$/i);
  if (!m) return false;
  const [, scheme, wild, host, port, path] = m;
  if (u.protocol !== (scheme ? scheme.toLowerCase() + ':' : 'https:')) return false;
  const h = u.hostname.toLowerCase();
  if (wild ? !h.endsWith('.' + host.toLowerCase()) : h !== host.toLowerCase()) return false;
  if (port !== '*' && u.port !== (port || '')) return false;
  if (!path) return true;
  const p = decodeURIComponent(u.pathname);
  return path.endsWith('/') ? p.startsWith(path) : p === path;
}

function admits(policy, directive, url) {
  const list = sourcesFor(policy, directive);
  if (list === null) return true;
  return list.some((token) => matches(token, url));
}

function hasKeyword(policy, directive, keyword) {
  return (sourcesFor(policy, directive) || []).some((token) => token.toLowerCase() === keyword);
}

const digest = (body) => 'sha256-' + createHash('sha256').update(body, 'utf8').digest('base64');

/** Whether an inline element with this body runs, under the directive that governs it. */
function inlineRuns(policy, directive, body) {
  const list = sourcesFor(policy, directive);
  if (list === null) return true;
  const pinned = list.some((t) => HASH.test(t) || NONCE.test(t));
  if (!pinned && list.some((t) => t.toLowerCase() === "'unsafe-inline'")) return true;
  return list.includes(`'${digest(body)}'`);
}

// ── Reading a page ──────────────────────────────────────────────────────────
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1].toLowerCase(), m[2]]));
const JS_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript']);

function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => { const a = attrs(m[1]); return !('src' in a) && JS_TYPES.has((a.type || '').trim().toLowerCase()); })
    .map((m) => m[2])
    .filter((body) => body.trim());
}
const inlineStyles = (html) => [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);

/** Every request the markup itself makes, with the directive that governs it. */
function requests(html) {
  const out = [];
  for (const [tag] of html.matchAll(/<(?:script|link|img)\b[^>]*>/gi)) {
    const a = attrs(tag);
    if (/^<script/i.test(tag) && a.src) out.push(['script-src', a.src]);
    if (/^<img/i.test(tag) && a.src) out.push(['img-src', a.src]);
    if (/^<link/i.test(tag) && a.href) {
      const rel = (a.rel || '').toLowerCase().split(/\s+/);
      if (rel.includes('stylesheet')) out.push(['style-src', a.href]);
      if (rel.includes('icon') || rel.includes('apple-touch-icon')) out.push(['img-src', a.href]);
      if (rel.includes('manifest')) out.push(['manifest-src', a.href]);
    }
  }
  return out;
}

// The home page carries data-mode="home" too, so it is named first.
const isAppPage = (rel, html) => rel !== 'index.html' && rel !== '404.html' && /<body data-mode="/.test(html);

/** Everything wrong with one page's policy, as sentences. An empty list is a pass. */
function audit(rel, html) {
  const problems = [];
  const found = [...html.matchAll(META)];
  const written = (html.match(ANY_META) || []).length;
  if (found.length !== 1 || written !== 1) {
    problems.push(`${rel}: needs exactly one CSP meta written as <meta http-equiv="Content-Security-Policy" content="...">, has ${found.length} of ${written}`);
    if (!found.length) return problems;
  }
  const policy = parse(found[0][1]);
  const at = found[0].index;
  const firstRequest = html.search(/<(?:link|script|style|img|iframe|base)\b/i);
  if (firstRequest >= 0 && firstRequest < at) problems.push(`${rel}: the CSP meta comes after something the page requests, which it then does not govern`);

  for (const name of IGNORED_IN_META) {
    if (policy.has(name)) problems.push(`${rel}: ${name} in a meta policy is ignored, so it reads as protection that is not there`);
  }
  if (/tercerafundacion/i.test(found[0][1])) problems.push(`${rel}: the policy names the catalogue; img-src https: already admits its scans`);
  for (const [name, list] of policy) {
    if (list.some((t) => t.toLowerCase() === "'unsafe-inline'") && list.some((t) => HASH.test(t) || NONCE.test(t))) {
      problems.push(`${rel}: ${name} pairs 'unsafe-inline' with a hash or nonce, and a browser then ignores 'unsafe-inline'`);
    }
  }
  const scripts = sourcesFor(policy, 'script-src') || [];
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", 'https:', 'http:', '*']) {
    if (scripts.some((t) => t.toLowerCase() === bad)) problems.push(`${rel}: script-src carries ${bad}`);
  }
  if ((policy.get('object-src') || []).join(' ') !== "'none'") problems.push(`${rel}: object-src is not 'none'`);
  if (!policy.has('base-uri')) problems.push(`${rel}: no base-uri, which default-src does not cover`);

  // Inline code, both directions: what runs must be admitted, and a pin that
  // matches nothing on the page is stale.
  for (const [directive, bodies, what] of [['script-src', inlineScripts(html), 'inline script'], ['style-src', inlineStyles(html), 'style block']]) {
    for (const body of bodies) {
      if (!inlineRuns(policy, directive, body)) problems.push(`${rel}: ${what} blocked by its own policy, needs '${digest(body)}' [${body.trim().slice(0, 40)}]`);
    }
    const seen = new Set(bodies.map((b) => `'${digest(b)}'`));
    for (const pin of (sourcesFor(policy, directive) || []).filter((t) => HASH.test(t))) {
      if (!seen.has(pin)) problems.push(`${rel}: ${directive} pins ${pin}, which matches no ${what} on the page (stale pin)`);
    }
  }

  for (const [directive, url] of requests(html)) {
    if (!admits(policy, directive, url)) problems.push(`${rel}: ${directive} blocks ${url}, which the page's own markup requests`);
  }

  const need = (directive, url, why) => { if (!admits(policy, directive, url)) problems.push(`${rel}: ${directive} blocks ${url} (${why})`); };
  const refuse = (directive, url, why) => { if (admits(policy, directive, url)) problems.push(`${rel}: ${directive} admits ${url} (${why})`); };
  const analytics = () => {
    need('script-src', GC_SCRIPT, 'GoatCounter, loaded by the header kit');
    need('script-src', CF_BEACON, 'Cloudflare Web Analytics, loaded by the header kit');
    need('connect-src', GOATCOUNTER, 'where GoatCounter counts a visit');
    need('connect-src', CF_REPORTS, "where Cloudflare's beacon reports");
  };

  if (isAppPage(rel, html)) {
    // An app page: /shelf/, /demo/, /u/ and their template.
    for (const url of REMOTE_MODULES) need('script-src', url, 'a module the site imports');
    for (const url of PONYFILL_GRAPH) need('script-src', url, "a module the ponyfill imports, on esm.sh's own paths");
    if (!hasKeyword(policy, 'script-src', "'wasm-unsafe-eval'")) problems.push(`${rel}: script-src has no 'wasm-unsafe-eval', so the ponyfill's decoder cannot compile`);
    need('connect-src', PONYFILL_WASM, "the ponyfill's wasm, fetched by the ponyfill itself");
    need('connect-src', `${CONVEX_URL}/api/query`, 'the production deployment, as ConvexHttpClient calls it');
    need('connect-src', `${CONVEX_URL}/api/mutation`, 'the production deployment, as ConvexHttpClient calls it');
    for (const url of CATALOGUE_IMAGES) need('img-src', url, 'a catalogue scan, from js/data.js');
    need('img-src', 'https://example.org/covers/mine.jpg', "a hand-added book's own image URL, which can be any https address");
    need('img-src', 'data:image/png;base64,AAAA', "the header kit's tinted favicon and the theme stylesheet's icons");
    need('img-src', `${ORIGIN}/assets/thumbs/L-00000622.jpg`, "the demo shelf's own thumbnails");
    analytics();
    for (const url of OTHER_JSDELIVR) refuse('script-src', url, 'jsDelivr is admitted only for the pinned Convex client');
    for (const url of OTHER_ESM) refuse('script-src', url, 'esm.sh is admitted only for the pinned ponyfill and its polyfills');
  } else if (rel === 'index.html') {
    // The home page loads no app code and no sign-in code.
    analytics();
    // The Auth Kit's two Clerk Core 3 scripts (packages/neorgon-ui/auth/neorgon-auth.js): the
    // refusal is of the whole host, so it holds whatever release the kit names.
    for (const url of [CONVEX_CLIENT, PONYFILL, 'https://clerk.neorgon.com/npm/@clerk/clerk-js@6/dist/clerk.browser.js', 'https://clerk.neorgon.com/npm/@clerk/ui@1.42.0/dist/ui.browser.js']) {
      refuse('script-src', url, 'the home page loads none of the app, so admitting it would only widen what an injection could run');
    }
    refuse('connect-src', `${CONVEX_URL}/api/query`, 'the home page never reaches the backend');
  } else if (rel === '404.html') {
    refuse('script-src', `${ORIGIN}/js/app.js`, '404.html runs no script, and a page that can run none cannot be made to');
    if (inlineScripts(html).length) problems.push(`${rel}: has an inline script, which its policy is written to refuse`);
  }
  return problems;
}

// ── The pages ───────────────────────────────────────────────────────────────
const SKIP = new Set(['node_modules', 'data', 'test-results', 'playwright-report', 'blob-report']);
function pagesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pagesUnder(path));
    else if (entry.name.endsWith('.html')) out.push(relative(ROOT, path));
  }
  return out;
}
const PAGES = pagesUnder(ROOT).sort();
eq(['404.html', '_templates/app.html', 'demo/index.html', 'index.html', 'shelf/index.html', 'u/index.html'].every((p) => PAGES.includes(p)), true,
  'the walk found the home page, the 404 page, the template and the three app pages');

const text = Object.fromEntries(PAGES.map((rel) => [rel, read(rel)]));
eq(PAGES.filter((rel) => isAppPage(rel, text[rel])), ['_templates/app.html', 'demo/index.html', 'shelf/index.html', 'u/index.html'],
  'the template and the three generated pages are the ones held to the app checks');
for (const rel of PAGES) eq(audit(rel, text[rel]), [], `${rel} carries a policy that admits what the page loads, and nothing it was written to refuse`);

const policyOf = (rel) => [...text[rel].matchAll(META)][0][1];
eq(new Set(['_templates/app.html', 'shelf/index.html', 'demo/index.html', 'u/index.html'].map(policyOf)).size, 1,
  'the three app pages carry the template policy unchanged');

// ── Inline handlers ─────────────────────────────────────────────────────────
// script-src carries neither 'unsafe-inline' nor 'unsafe-hashes', so a handler
// attribute or a javascript: URL never runs, whether it is in a page or in markup
// a module writes. The Add by ISBN form kept Enter from reloading the page with
// onsubmit="return false" until the policy landed.
const HANDLER = /<[a-z][^>]*\son[a-z]+\s*=|javascript:/gi;
const handlersIn = (source) => (source.match(HANDLER) || []).map((m) => m.slice(0, 60));
const moduleText = Object.fromEntries(readdirSync(join(ROOT, 'js')).filter((f) => f.endsWith('.js')).map((f) => [`js/${f}`, read(`js/${f}`)]));
eq(Object.entries({ ...text, ...moduleText }).filter(([, source]) => handlersIn(source).length).map(([rel, source]) => [rel, handlersIn(source)]), [],
  'no page and no module writes an inline event handler or a javascript: URL');
eq(handlersIn('<form class="form" id="isbnForm" onsubmit="return false">').length, 1, 'tripped: the handler the ISBN form used to carry is found');

// ── The guards, tripped ─────────────────────────────────────────────────────
// Each changes one real page in memory, and the change must have landed, or the
// trip would pass for the wrong reason.
function trips(rel, change, needle, what) {
  const changed = change(text[rel]);
  if (changed === text[rel]) { eq('unchanged', 'changed', `${what}: the change did not apply`); return; }
  const said = audit(rel, changed);
  eq(said.some((line) => line.includes(needle)), true, `tripped: ${what}`);
}
const swapPolicy = (fn) => (html) => html.replace(META, (all, policy) => all.replace(policy, () => fn(policy)));

trips('shelf/index.html', (h) => h.replace("m[1]!=='default'", "m[1]!=='plain'"), 'inline script blocked', 'an edited theme script no longer matches its pin');
trips('index.html', (h) => h.replace(/<script>\s*\/\/ A returning visitor[\s\S]*?<\/script>/, ''), 'stale pin', 'a pin left behind by a removed script is stale');
trips('404.html', (h) => h.replace('#0a0a12', '#0a0a13'), 'style block blocked', "an edited 404 style block no longer matches its pin");
trips('_templates/app.html', swapPolicy((p) => p.replace('convex@1.45.0/', 'convex@1.44.0/')), CONVEX_CLIENT, 'a jsDelivr scope that misses the pinned Convex client');
trips('_templates/app.html', swapPolicy((p) => p.replace('https://esm.sh/barcode-detector@3.2.2/ https://esm.sh/node/', 'https://esm.sh')), 'admits https://esm.sh/left-pad', 'a host-wide esm.sh');
trips('shelf/index.html', swapPolicy((p) => p.replace(" 'wasm-unsafe-eval'", '')), 'wasm-unsafe-eval', 'a policy without wasm compilation');
trips('shelf/index.html', swapPolicy((p) => p.replace('https://*.convex.cloud ', '')), `${CONVEX_URL}/api/query`, 'a connect-src without the deployment');
trips('u/index.html', swapPolicy((p) => p.replace("img-src 'self' data: https:", "img-src 'self' data:")), 'a catalogue scan', 'an img-src without https:');
trips('shelf/index.html', swapPolicy((p) => p.replace("style-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' 'sha256-AAAA'")), "pairs 'unsafe-inline'", 'a style hash that would switch unsafe-inline off');
trips('demo/index.html', swapPolicy((p) => p + "; frame-ancestors 'none'"), 'frame-ancestors', 'frame-ancestors in a meta policy');
trips('u/index.html', (h) => {
  const meta = h.match(META)[0];
  return h.replace(meta, () => '').replace(/<link rel="icon"[^>]*>/, (link) => `${link}\n  ${meta}`);
}, 'comes after', 'a meta moved below the first request');
trips('index.html', (h) => h.replace(META, (m) => m + '\n  ' + m), 'exactly one CSP meta', 'a second policy');
trips('index.html', swapPolicy((p) => p.replace("script-src 'self'", "script-src 'self' https://cdn.jsdelivr.net/npm/convex@1.45.0/")), `admits ${CONVEX_CLIENT}`, 'the home page admitting the app client');
trips('404.html', swapPolicy((p) => p.replace("script-src 'none'", "script-src 'self'")), '404.html runs no script', 'a 404 policy that would run script');
trips('index.html', (h) => h.replace("<meta http-equiv=\"Content-Security-Policy\"", "<meta  http-equiv=\"Content-Security-Policy\""), 'exactly one CSP meta', 'a meta written in a shape the fleet checks do not read');

// The matcher itself, on the cases the policies lean on.
eq([
  matches('https://cdn.jsdelivr.net/npm/convex@1.45.0/', CONVEX_CLIENT),
  matches('https://cdn.jsdelivr.net/npm/convex@1.45.0/', 'https://cdn.jsdelivr.net/npm/convex@1.45.01/x'),
  matches('https://*.convex.cloud', `${CONVEX_URL}/api/query`),
  matches('https://*.convex.cloud', 'https://convex.cloud/api/query'),
  matches('https:', 'http://example.org/x.jpg'),
  matches("'self'", '/js/app.js'),
  matches('https://esm.sh/node/', 'https://esm.sh/node/process.mjs'),
  matches('https://gc.zgo.at', 'https://gc.zgo.at.evil.example/count.js'),
], [true, false, true, false, false, true, true, false], 'the source matcher follows the CSP rules the policies depend on');

if (failed) {
  console.error(`\n${failed} CSP check(s) failed`);
  process.exit(1);
}
console.log('\nall CSP checks passed');
