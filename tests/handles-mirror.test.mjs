// Plain node, no install. Run with: make validate
//
// convex/lib/handles.ts decides what may be claimed; js/handles.js tells the
// person first, in the Share dialog. Two copies of a rule list drift, so this
// imports both, compares every list they hold and runs one corpus through
// each. It also pins each list and what each case must answer against plan
// section 3.5, because two copies that agree on a wrong answer, or that both
// lost the same word, would pass a comparison on its own.

import * as server from '../convex/lib/handles.ts';
import * as browser from '../js/handles.js';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

// The lists as plan section 3.5 writes them.
const CONTRACT_RESERVED = ('u shelf demo privacy tos admin api www css js data assets docs scripts tests templates index sitemap robots ' +
  'llms favicon manifest static img theme header footer via src yaml login logout signin sign-in signup sign-up account accounts auth ' +
  'oauth session clerk convex vitrina neorgon energon tercerafundacion tercera-fundacion la-tercera-fundacion owner official staff team ' +
  'mod moderator security abuse report legal terms contact about me you anon anonymous null undefined test help support settings system ' +
  'user users profile root verify claim embed policy ayuda soporte privacidad terminos cuenta usuario usuarios perfil administrador ' +
  'estanteria biblioteca catalogo prueba').split(' ');
const CONTRACT_ROLE_WORDS = ('admin administrador administrator staff team equipo mod moderator moderador official oficial support ' +
  'soporte help ayuda').split(' ');
const CONTRACT_BRANDS = ['neorgon', 'energon', 'vitrina', 'tercerafundacion'];
const CONTRACT_KIT_KEYS = ['theme', 'header', 'footer', 'via', 'src', 'yaml'];

// ── The rules are the same rules ────────────────────────────────────────────
eq(browser.HANDLE_RE.source, server.HANDLE_RE.source, 'both modules use the same handle pattern');
eq(browser.HANDLE_RE.flags, server.HANDLE_RE.flags, 'with the same flags');
eq([...browser.RESERVED_HANDLES], [...server.RESERVED_HANDLES], 'and the same reserved words');
eq([...server.RESERVED_HANDLES], CONTRACT_RESERVED, 'the reserved words are the ones plan section 3.5 lists');
eq([...browser.ROLE_WORDS], [...server.ROLE_WORDS], 'both modules use the same role words');
eq([...server.ROLE_WORDS], CONTRACT_ROLE_WORDS, 'the role words are the ones plan section 3.5 lists');
eq([...browser.BRANDS], [...server.BRANDS], 'both modules use the same brands');
eq([...server.BRANDS], CONTRACT_BRANDS, 'the brands are the ones plan section 3.5 lists');
eq(Object.isFrozen(server.RESERVED_HANDLES) && Object.isFrozen(browser.RESERVED_HANDLES), true, 'both reserved lists are frozen');
eq(browser.HANDLE_MESSAGES, server.HANDLE_MESSAGES, 'and both say the same thing about a refused handle');

// One corpus, both modules, and the answer each case must give.
function check(raw, expected, what) {
  const fromServer = server.handleProblem(server.normalizeHandle(raw));
  const fromBrowser = browser.handleProblem(browser.normalizeHandle(raw));
  eq(browser.normalizeHandle(raw), server.normalizeHandle(raw), `both normalise ${what} alike`);
  eq(fromBrowser, fromServer, `both judge ${what} alike`);
  eq(fromServer, expected, `${what}: ${expected === null ? 'accepted' : expected}`);
}

const INVALID = 'handle-invalid';
const RESERVED = 'handle-reserved';

check('20260911', INVALID, 'all digits');
check('1984ana', null, 'digits with letters');
check('ab', INVALID, 'two characters');
check('abc', null, 'three characters');
check('a'.repeat(30), null, 'thirty characters');
check('a'.repeat(31), INVALID, 'thirty-one characters');
check('-ana', INVALID, 'a leading hyphen');
check('ana-', INVALID, 'a trailing hyphen');
check('an--a', INVALID, 'a double hyphen');
check('ana-lee', null, 'a single inner hyphen');
check('ANA', null, 'uppercase');
check('  ana  ', null, 'surrounding whitespace');
check('@ana', null, 'a leading @');
check('%40ana', null, 'an encoded leading @');
check('@@ana', INVALID, 'two leading @');
check('añá', INVALID, 'accents and ñ');
check('ana_lee', INVALID, 'an underscore');
check(42, INVALID, 'a number instead of text');
check(null, INVALID, 'null');
eq(server.normalizeHandle('  @Ana '), 'ana', 'the canonical form is trimmed, without @, lowercase');
eq(server.normalizeHandle('%40Ana'), 'ana', 'and %40 reads as @');

for (const word of server.RESERVED_HANDLES) {
  // The two-letter reserved words fail the pattern first; either way they are refused.
  check(word, word.length < 3 ? INVALID : RESERVED, `the reserved word ${word}`);
}

for (const lookalike of ['neorg0n', 'vitr1na', 'latercerafundacion', 'en3rg0n', 'ne-org-on', 't3rc3r4fund4c10n', 'my-vitrina']) {
  check(lookalike, RESERVED, `the brand lookalike ${lookalike}`);
}
for (const brand of CONTRACT_BRANDS) {
  check('mi' + brand, RESERVED, `a handle containing the brand ${brand}`);
}
for (const role of ['vitrina-team', 'tf-oficial', 'moderador', 'shop-admin', 'ayuda-libros']) {
  check(role, RESERVED, `the role handle ${role}`);
}
for (const word of CONTRACT_ROLE_WORDS) {
  // As one segment of a longer handle, which the reserved list alone never catches.
  check('libros-' + word, RESERVED, `the role segment ${word}`);
}
for (const fine of ['modesto', 'steam', 'badminton', 'tf-lector', 'l1bros']) {
  check(fine, null, `${fine}, which only contains a role word or a digit`);
}

// ── handleFromSearch, browser only ──────────────────────────────────────────
const at = browser.handleFromSearch;
const shelf = (handle) => ({ found: true, handle });
const none = { found: false, handle: null };

eq(at('?alice'), shelf('alice'), '?alice names alice');
eq(at('?alice='), shelf('alice'), '?alice= names alice, as a share sheet may rewrite it');
eq(at('?fbclid=x&alice'), shelf('alice'), 'a tracking parameter before the handle is skipped');
eq(at('?theme=matrix&alice'), shelf('alice'), 'a header kit parameter is skipped');
eq(at('?utm_source=&alice'), shelf('alice'), 'a bare segment wins over an empty key=');
eq(at('?ref=&ana'), shelf('ana'), '?ref=&ana names ana');
eq(at('?@ana'), shelf('ana'), '?@ana names ana');
eq(at('?%40ana'), shelf('ana'), '?%40ana names ana');
eq(at('?Alice'), shelf('alice'), '?Alice names the canonical alice');
eq(at('?al%20ice'), shelf(null), 'a name that can never be a handle is found but names nobody');
eq(at('?admin'), shelf(null), 'so is a reserved word');
eq(at('?%E0%A4%A'), shelf(null), 'a malformed escape is found and names nobody, without throwing');
eq(at('?theme=&ana='), shelf('ana'), 'the key= pass skips kit keys too');
eq(at('alice'), shelf('alice'), 'the leading ? is optional');
eq(at(''), none, 'an empty query names no shelf');
eq(at('?theme=matrix'), none, 'a kit parameter alone names no shelf');
eq(at('?theme'), none, 'nor does a bare kit key');
eq(at('?fbclid=x'), none, 'nor does a parameter with a value');
eq(at(undefined), none, 'nor does no search at all');

eq([...browser.KIT_KEYS], CONTRACT_KIT_KEYS, 'the header kit keys are the six plan section 3.5 lists');
for (const key of CONTRACT_KIT_KEYS) {
  // Every kit key is also a reserved handle, so a kit key read as the handle
  // would name nobody instead of Ana.
  eq(at(`?${key}&ana`), shelf('ana'), `the bare kit key ${key} is skipped`);
  eq(at(`?${key}=&ana=`), shelf('ana'), `and so is ${key}= in the key= pass`);
}
eq(at('?%61na'), shelf('ana'), 'a percent-encoded letter is decoded before it is judged');
eq(at('?%74heme&ana'), shelf('ana'), 'and a percent-encoded kit key is still a kit key');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
