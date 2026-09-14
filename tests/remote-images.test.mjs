// Plain node, no install. Run with: make validate
//
// Every Claude session that checks Vitrina in a browser does it with remote
// images switched off: the catalogue's robots.txt refuses ClaudeBot, so a page a
// Claude session checks must ask the catalogue for nothing (plan sections 3.7
// and 3.9). The switch lives inside the URL builders themselves, so no caller
// can forget it. This holds both ways of turning it on, the per-browser flag and
// the constant, and holds that no image is handed a builder's answer unchecked.

import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

const store = new Map();
const storage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
};
globalThis.localStorage = storage;

const data = await import('../js/data.js');
const FLAG = 'vitrina:no-remote-images';
const CUSTOM_COVER = { record: { id: null, title: 'Hand', cover_custom: 'https://example.invalid/c.jpg' } };
const CUSTOM_SPINE = { record: { id: null, title: 'Hand', spine_custom: 'https://example.invalid/s.jpg' } };

// ── The flag ────────────────────────────────────────────────────────────────
eq(data.REMOTE_IMAGES, true, 'the shipped constant leaves remote images on');
eq(data.spineUrl(622).endsWith('/imagenes/lomo/L-00000622.jpg'), true, 'with the switch off the spine builder names the catalogue scan');
eq(data.coverUrl(622).endsWith('/imagenes/portada/P-00000622.jpg'), true, 'and so does the cover builder');
eq(data.coverFor(CUSTOM_COVER), 'https://example.invalid/c.jpg', "and a hand-added book's own cover URL is used");

store.set(FLAG, '1');
eq(data.spineUrl(622), '', 'under the flag the spine builder returns an empty string');
eq(data.coverUrl(622), '', 'and so does the cover builder');
eq([data.spineFor({ record: { id: 622 } }), data.coverFor({ record: { id: 622 } })], [null, null], 'spineFor and coverFor find nothing to show');
eq([data.coverFor(CUSTOM_COVER), data.spineFor(CUSTOM_SPINE)], [null, null], "a hand-added book's own image URLs are withheld too");
eq(data.scansWithheld({ record: { id: 622 } }), true, 'the page can tell a withheld scan from a missing one');
eq(data.scansWithheld({ record: { id: null, title: 'No images at all' } }), false, 'and does not call a book with no scans withheld');

store.set(FLAG, '0');
eq(data.spineUrl(622) !== '', true, 'any other value leaves remote images on');
store.delete(FLAG);
eq(data.scansWithheld({ record: { id: 622 } }), false, 'and with the switch off nothing is withheld');
globalThis.localStorage = { getItem: () => { throw new Error('blocked'); } };
eq(data.coverUrl(622) !== '', true, 'storage that throws does not break the builders');
globalThis.localStorage = storage;

// ── The constant ────────────────────────────────────────────────────────────
// data.js as shipped, with REMOTE_IMAGES false and its imports pointed at the
// real modules, loaded from a scratch file.
const source = readFileSync(new URL('../js/data.js', import.meta.url), 'utf8');
const SHIPPED = 'export const REMOTE_IMAGES = true;';
eq(source.split(SHIPPED).length - 1, 1, 'data.js declares the constant once, as the test expects to find it');
const patched = source
  .replace(SHIPPED, 'export const REMOTE_IMAGES = false;')
  .replace(/from '\.\/([\w-]+\.js)'/g, (match, file) => `from '${new URL(`../js/${file}`, import.meta.url).href}'`);
const dir = mkdtempSync(join(tmpdir(), 'vitrina-remote-images-'));
try {
  const copy = join(dir, 'data-off.mjs');
  writeFileSync(copy, patched);
  const off = await import(pathToFileURL(copy).href);
  eq([off.REMOTE_IMAGES, off.spineUrl(622), off.coverUrl(622)], [false, '', ''], 'with the constant false both builders return an empty string, flag or no flag');
  eq([off.coverFor(CUSTOM_COVER), off.spineFor(CUSTOM_SPINE)], [null, null], 'and custom image URLs are withheld');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── No image is handed an unchecked answer ──────────────────────────────────
const JS = new URL('../js/', import.meta.url);
const unchecked = [];
for (const name of readdirSync(JS).filter((file) => file.endsWith('.js') && !file.startsWith('neorgon-')).sort()) {
  readFileSync(new URL(name, JS), 'utf8').split('\n').forEach((line, i) => {
    if (/\.src\s*=\s*(spineUrl|coverUrl)\(/.test(line) || /src="\$\{escHtml\((spineUrl|coverUrl)\(/.test(line)) {
      unchecked.push(`js/${name}:${i + 1}`);
    }
  });
}
eq(unchecked, [], 'no img.src is set straight from spineUrl or coverUrl, where an empty string would slip through');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
