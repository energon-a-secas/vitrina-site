// Plain node, no install. Run with: make validate
//
// A record id is catalogue data on the demo, but on an account shelf or in an
// imported file it is whatever somebody wrote. js/shelf.js used to put
// record.id into data-book-id raw, and an id of 1" onerror="x became an onerror
// attribute that fired, because the image it sat on 404s (plan section 1). This
// renders that id and fails on a quote that gets out of its attribute. The
// data-add templates live inside functions that need a DOM to call, so every
// data-add and data-book-id in the site's modules is read from source instead
// and must go through escHtml.

import { readFileSync, readdirSync } from 'node:fs';
import { spineMarkup } from '../js/shelf.js';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

// Attribute values blanked, so whatever is left is markup, not data.
const unquoted = (html) => html.replace(/"[^"]*"/g, '""');

const HOSTILE = '1" onerror="x';
const markup = spineMarkup({ key: 'tf1', record: { id: HOSTILE, title: 'A hostile record' } });
const img = (markup.match(/<img\b[^>]*>/) || [''])[0];
eq(img !== '', true, 'the spine renders an image for a record with an id');
eq(/onerror/i.test(unquoted(img)), false, 'a hostile record id stays inside its attribute');
eq(img.includes('data-book-id="1&quot; onerror=&quot;x"'), true, 'escaped, not dropped');
eq(/\sonerror\s*=/i.test(unquoted(markup)), false, 'and no onerror attribute appears anywhere in the spine');

const JS = new URL('../js/', import.meta.url);
const raw = [];
let seen = 0;
for (const name of readdirSync(JS).filter((file) => file.endsWith('.js') && !file.startsWith('neorgon-')).sort()) {
  const code = readFileSync(new URL(name, JS), 'utf8');
  for (const match of code.matchAll(/data-(add|book-id)="\$\{([^}]*)\}"/g)) {
    seen += 1;
    if (!/^escHtml\(/.test(match[2].trim())) raw.push(`js/${name}: data-${match[1]}="\${${match[2]}}"`);
  }
}
eq(seen >= 5, true, 'the scan finds the data-add and data-book-id templates in shelf, detail, browse and modals');
eq(raw, [], 'every one of them goes through escHtml');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
