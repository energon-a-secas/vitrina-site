// Plain node, no install. Run with: make validate
//
// The page's keydown handler closes #modal and #drawer on Escape, keeps Tab
// inside them and turns single keys into shortcuts. With the Shelf report open
// under a native <dialog>, trapFocus swallowed Shift+Tab and `a` typed inside
// the dialog opened Add a book behind it (plan section 1). js/keyguard.js
// decides when those keys belong to something else, and this holds that
// decision on a stand-in page: a native dialog open anywhere, a dialog that is
// not one of vitrina's own, and an open header menu.

import { readFileSync } from 'node:fs';
import { keysBelongElsewhere } from '../js/keyguard.js';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

// An element that answers closest() for the selectors keyguard.js asks about.
class Node {
  constructor(tag, { id = '', role = null, parent = null } = {}) {
    Object.assign(this, { tag, id, role, parent });
  }
  matches(selector) {
    return selector.split(',').map((s) => s.trim()).some((s) => {
      if (s.startsWith('#')) return this.id === s.slice(1);
      if (s === '[role="dialog"]') return this.role === 'dialog';
      return this.tag === s;
    });
  }
  closest(selector) {
    for (let node = this; node; node = node.parent) if (node.matches(selector)) return node;
    return null;
  }
}

// What document.querySelector finds for the two selectors keyguard.js asks.
const page = ({ nativeDialog = false, headerMenu = false } = {}) => ({
  querySelector: (selector) => {
    if (selector === 'dialog[open]') return nativeDialog ? new Node('dialog') : null;
    if (selector === '.header-menu.open') return headerMenu ? new Node('div') : null;
    return null;
  },
});

// The template's own overlays, whose dialogs sit inside #modal and #drawer, and
// a dialog of somebody else's, the way Clerk mounts its account menu.
const body = new Node('body');
const modalInput = new Node('input', { parent: new Node('div', { role: 'dialog', parent: new Node('div', { id: 'modal', parent: body }) }) });
const drawerButton = new Node('button', { parent: new Node('div', { role: 'dialog', parent: new Node('aside', { id: 'drawer', parent: body }) }) });
const clerkItem = new Node('button', { parent: new Node('div', { role: 'dialog', parent: body }) });
const spine = new Node('button', { parent: body });

eq(keysBelongElsewhere(page(), spine), false, 'on the page, with nothing else open, the keys are the page\'s');
eq(keysBelongElsewhere(page(), modalInput), false, "inside #modal's dialog they are too: Escape closes it and Tab stays in it");
eq(keysBelongElsewhere(page(), drawerButton), false, 'and inside the drawer');
eq(keysBelongElsewhere(page(), clerkItem), true, "inside a dialog that is not one of vitrina's own, such as Clerk's account menu, they are not");
eq(keysBelongElsewhere(page({ nativeDialog: true }), spine), true, 'nor while a native dialog is open, wherever focus is');
eq(keysBelongElsewhere(page({ nativeDialog: true }), modalInput), true, 'even with focus left inside #modal under it, where trapFocus swallowed Shift+Tab');
eq(keysBelongElsewhere(page({ headerMenu: true }), spine), true, 'nor while a header menu is open');
eq([keysBelongElsewhere(null, null), keysBelongElsewhere(page(), { tagName: 'svg' })], [false, false],
  'no document, or a target that cannot say where it sits, is no reason to drop a key');

// The guard only works if the page asks it first.
const events = readFileSync(new URL('../js/events.js', import.meta.url), 'utf8');
const handler = events.slice(events.indexOf("document.addEventListener('keydown'"));
const asked = handler.indexOf('keysBelongElsewhere(document, ev.target)');
eq(asked >= 0 && asked < handler.indexOf("ev.key === 'Escape'") && asked < handler.indexOf('trapFocus(') && asked < handler.indexOf("ev.key === 'a'"), true,
  "events.js asks before its Escape, its focus trap and its shortcuts");

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
