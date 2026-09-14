// Plain node, no install. Run with: make validate
//
// Shelf tools is a menu Vitrina writes, not one the header kit builds, so the
// kit neither opens it nor knows it is open. Two things follow that only show
// in a browser, and this holds both on a stand-in header that implements only
// what bindShelfMenu and the kit's overflow sync touch.
//
// The app-mode bar hides as the page scrolls down. The kit keeps it on screen
// while one of its own menus is open, or while focus is inside it, so Shelf
// tools must not stay open once focus has left the bar, or it rides the bar off
// the screen and comes back still open.
//
// At 700px and below the kit folds every control without data-keep-mobile into
// its ⋯ menu, and wider it puts them back in front of its toggle, after Add by
// ISBN. Add a book used to come back second.

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

class Stub {
  constructor(tag, { id = '', cls = '', attrs = {} } = {}) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classes = new Set(cls.split(' ').filter(Boolean));
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    this.listeners = [];
  }
  get classList() {
    return { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c) };
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  hasAttribute(name) { return name in this.attrs; }
  insertBefore(child, ref) {
    if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1);
    const at = ref ? this.children.indexOf(ref) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, child);
    child.parentElement = this;
    return child;
  }
  appendChild(child) { return this.insertBefore(child, null); }
  contains(other) { for (let n = other; n; n = n.parentElement) if (n === this) return true; return false; }
  matches(selector) {
    return selector.split(',').map((s) => s.trim()).some((s) => {
      if (s.startsWith('#')) return this.id === s.slice(1);
      if (s.startsWith('.')) return this.classes.has(s.slice(1));
      return this.tagName === s.toUpperCase();
    });
  }
  closest(selector) { for (let n = this; n; n = n.parentElement) if (n.matches(selector)) return n; return null; }
  find(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const deeper = child.find(selector);
      if (deeper) return deeper;
    }
    return null;
  }
  // Drawn unless it or something around it is hidden, or it sits in a shut menu.
  get offsetParent() {
    for (let n = this; n; n = n.parentElement) {
      if (n.hidden || (n.classes.has('header-menu') && !n.classes.has('open'))) return null;
    }
    return this.parentElement;
  }
  addEventListener(type, fn, options) {
    this.listeners.push({ type, fn, capture: options === true || Boolean(options && options.capture) });
  }
  focus() { doc.activeElement = this; }
}

// The header as _templates/app.html writes it, with the kit's ⋯ appended to
// .header-actions the way buildOverflow in js/neorgon-header.js appends it.
const bar = new Stub('header', { cls: 'header-bar' });
const actions = bar.appendChild(new Stub('div', { cls: 'header-actions' }));
actions.appendChild(new Stub('button', { id: 'addBtn' }));
actions.appendChild(new Stub('button', { id: 'isbnBtn', attrs: { 'data-keep-mobile': '' } }));
actions.appendChild(new Stub('button', { id: 'shareBtn' }));
const group = actions.appendChild(new Stub('div', { cls: 'header-btn-group' }));
const trigger = group.appendChild(new Stub('button', { id: 'shelfMenuBtn' }));
const menu = group.appendChild(new Stub('div', { id: 'shelfMenu', cls: 'header-menu' }));
['statsBtn', 'exportBtn', 'importBtn'].forEach((id) => menu.appendChild(new Stub('button', { id })));
const overflow = actions.appendChild(new Stub('div', { cls: 'header-overflow' }));
const kitMenu = overflow.appendChild(new Stub('div', { cls: 'header-menu header-overflow-menu' }));
const page = new Stub('main');

const doc = {
  activeElement: page,
  listeners: [],
  addEventListener(type, fn) { this.listeners.push({ type, fn }); },
  querySelector: (selector) => bar.find(selector) || page.find(selector),
  querySelectorAll: () => [],
  dispatchEvent: () => true,
};
const phone = { matches: false, listeners: [], addEventListener(type, fn) { if (type === 'change') this.listeners.push(fn); } };
// syncOverflow from js/neorgon-header.js, on the stand-in.
const kit = {
  syncOverflow() {
    if (phone.matches) {
      actions.children
        .filter((el) => el !== overflow && !el.hasAttribute('data-keep-mobile') && el.matches('button, a, div, nav'))
        .forEach((el) => kitMenu.appendChild(el));
    } else {
      kitMenu.children.slice().forEach((el) => actions.insertBefore(el, overflow));
    }
    overflow.hidden = kitMenu.children.length === 0;
  },
};
const win = {
  listeners: [],
  addEventListener(type, fn) { this.listeners.push({ type, fn }); },
  matchMedia: () => phone,
  NeoHeader: kit,
};
globalThis.window = win;
globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };

function click(target) {
  const path = [];
  for (let n = target; n; n = n.parentElement) path.push(n);
  const ev = { type: 'click', target, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } };
  path.slice().reverse().forEach((n) => n.listeners.filter((l) => l.type === 'click' && l.capture).forEach((l) => l.fn(ev)));
  for (const n of path) {
    if (ev.stopped) return;
    n.listeners.filter((l) => l.type === 'click' && !l.capture).forEach((l) => l.fn(ev));
  }
  doc.listeners.filter((l) => l.type === 'click').forEach((l) => l.fn(ev));
}
const scroll = () => win.listeners.filter((l) => l.type === 'scroll').forEach((l) => l.fn({ type: 'scroll' }));
// The kit's media query list is created before the page's, so its change
// listener runs first, as a browser runs them.
const cross = (narrow) => { phone.matches = narrow; kit.syncOverflow(); phone.listeners.forEach((fn) => fn()); };
const names = (el) => el.children.map((child) => child.id || [...child.classes][0]);

const { bindShelfMenu } = await import('../js/events.js');
bindShelfMenu();
const TEMPLATE_ORDER = ['addBtn', 'isbnBtn', 'shareBtn', 'header-btn-group', 'header-overflow'];
eq(names(actions), TEMPLATE_ORDER, 'at desktop width the header starts in template order');

// ── Scrolling with the menu open ────────────────────────────────────────────
click(trigger);
eq([menu.classList.contains('open'), trigger.getAttribute('aria-expanded'), doc.activeElement.id], [true, 'true', 'statsBtn'],
  'Shelf tools opens with focus on its first row, inside the bar');
scroll();
eq(menu.classList.contains('open'), true, 'a scroll leaves it open while focus holds the bar on screen');
doc.activeElement = page;   // what a click on the menu's own padding does
scroll();
eq([menu.classList.contains('open'), trigger.getAttribute('aria-expanded')], [false, 'false'],
  'once focus has left the bar, a scroll closes it before the bar can hide with it');
scroll();
eq(trigger.getAttribute('aria-expanded'), 'false', 'and a scroll with the menu shut changes nothing');

// ── Phone width and back ────────────────────────────────────────────────────
cross(true);
eq([group.hidden, names(kitMenu)], [true, ['addBtn', 'shareBtn', 'header-btn-group', 'statsBtn', 'exportBtn', 'importBtn']],
  'at phone width Add a book, Share and the three rows are in the kit menu, Shelf tools itself hidden');
cross(false);
eq(names(actions), TEMPLATE_ORDER, 'back at desktop width Add a book is first again, not after Add by ISBN');
eq([group.hidden, names(menu), names(kitMenu)], [false, ['statsBtn', 'exportBtn', 'importBtn'], []],
  'and the three rows are back in Shelf tools, with nothing left in the kit menu');
cross(true);
cross(false);
eq(names(actions), TEMPLATE_ORDER, 'however many times the width crosses');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
