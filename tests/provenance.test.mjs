// Plain node, no install. Run with: make validate
//
// The data files carry bibliographic facts only. Back cover copy is publisher
// marketing text, this repo is public and GitHub Pages serves data/, so it is
// never stored: tf.parse_book says so, and so do README.md, PRODUCT.md and
// CLAUDE.md. Two candidate records carried it anyway from the first commit
// until 2026-11-03, under a "blurb" key that rank.py copied into ranked.json
// and two briefs, and nothing read them, so nothing noticed. This walks every
// JSON file under data/ and data/briefs/ and fails on a key that names back
// cover copy, or a string carrying the catalogue's own label for it or the
// page chrome that comes with a whole-page capture.

import { readFileSync, readdirSync } from 'node:fs';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

const DATA = new URL('../data/', import.meta.url);
const BRIEFS = new URL('briefs/', DATA);

// A key that would hold the copy, under any of the names a scraper reaches for.
const KEY = /blurb|back_?cover|contraportada|solapa|sinopsis|synopsis/i;
// The catalogue heads the section "Texto de contraportada/solapas", and its
// search menu offers "Texto de contraportada" too, so either one in a value
// means the section or the page around it was captured. "Registrarse Entrar"
// is the page's own sign-in chrome, which only a whole-page capture brings.
const TEXT = [
  [/texto de contraportada/i, 'the catalogue\'s back cover label'],
  [/registrarse\s+entrar/i, 'the catalogue\'s page chrome'],
];

const jsonIn = (dir) => readdirSync(dir).filter((name) => name.endsWith('.json')).sort().map((name) => new URL(name, dir));
const files = [...jsonIn(DATA), ...jsonIn(BRIEFS)];
const rel = (url) => url.pathname.slice(new URL('..', DATA).pathname.length);

const found = [];
let strings = 0;
function walk(value, path, file) {
  if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`, file));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (KEY.test(key)) found.push(`${file} ${path}.${key}: a key that names back cover copy`);
      walk(item, `${path}.${key}`, file);
    }
  } else if (typeof value === 'string') {
    strings += 1;
    for (const [pattern, what] of TEXT) {
      if (pattern.test(value)) found.push(`${file} ${path}: ${what}`);
    }
  }
}
for (const url of files) walk(JSON.parse(readFileSync(url, 'utf8')), '$', rel(url));

// Not vacuous: the files the blurbs lived in are among the ones walked.
const walked = files.map(rel);
eq(['data/candidates.json', 'data/ranked.json', 'data/catalog.json', 'data/library.json', 'data/briefs/proteo.json', 'data/briefs/ninos-perdidos.json'].filter((name) => !walked.includes(name)), [],
  'the walk reaches candidates.json, ranked.json, catalog.json, library.json and the briefs');
eq(walked.filter((name) => name.startsWith('data/briefs/')).length >= 39, true, `every brief is walked (${walked.length} files, ${strings} strings)`);
eq(found, [], 'no data file stores back cover copy, its label or the page chrome around it');

// The detectors themselves, so a loosened pattern cannot pass the walk above
// by matching nothing.
const probe = (value) => { const before = found.length; walk(value, '$', 'probe'); return found.splice(before).length; };
eq([probe({ blurb: 'x' }), probe({ back_cover: 'x' }), probe({ Contraportada: 'x' })], [1, 1, 1], 'a back cover key is caught under each name');
eq([probe({ note: 'Texto de contraportada/solapas: ...' }), probe({ note: 'Registrarse Entrar Toda la 3F' })], [1, 1], 'the label and the page chrome are caught inside a value');
eq([probe({ note: 'Primera edición en rústica.', contents: [{ pages: '11-414', entry: 'novela' }] })], [0], 'an ordinary librarian note and a table of contents pass');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
