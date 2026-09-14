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

// A title, an author and a collection number are text somebody wrote too, and
// they land in the spine's title and aria-label attributes and in its drawn
// label, on a lit spine and on a ghost one in the whole-collection view.
// Only the tags are searched: in the drawn label the same words are escaped text,
// which is where they belong.
const HOSTILE_TEXT = '" onfocus="x';
const tagsOf = (html) => (unquoted(html).match(/<[^>]*>/g) || []).join('\n');
const labelled = spineMarkup({ key: 'tf2', record: { id: 2, title: `A title${HOSTILE_TEXT}`, authors: [`An author${HOSTILE_TEXT}`], collection_number: `12${HOSTILE_TEXT}` } });
eq(labelled.includes('title="A title&quot; onfocus=&quot;x'), true, 'a hostile title is escaped inside the title attribute');
eq(/\son\w+\s*=/i.test(tagsOf(labelled)), false, 'and no title, author or collection number becomes an attribute of its own');
const ghost = spineMarkup({ key: 'cat3', record: { id: 3, title: `Ghost${HOSTILE_TEXT}` } }, { ghost: true, number: `4${HOSTILE_TEXT}` });
eq(/\son\w+\s*=/i.test(tagsOf(ghost)), false, 'nor on a ghost spine');

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
