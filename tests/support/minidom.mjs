// A small DOM for the flow tests, in plain node with no install.
//
// It parses a generated page (shelf/index.html, u/index.html) and implements
// what js/account.js, strips.js, share.js and profile.js touch, with the real
// modals.js and detail.js on top: HTML in and out, the selectors those modules
// use, bubbling events, focus, and focus falling to <body> when the focused
// element is removed, as a browser does. A selector it does not understand
// throws, so a module that starts using one fails loudly instead of matching
// nothing and passing.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·' };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
    return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : whole;
  });
}
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export class Event {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.detail = init.detail === undefined ? null : init.detail;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.stopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}
export class CustomEvent extends Event {}

class Node {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
  }
  get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument;
  }
}

class Text extends Node {
  constructor(doc, data) {
    super(doc);
    this.data = data;
  }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
}

function listen(target, type, fn, options) {
  target.listeners.push({ type, fn, capture: options === true || Boolean(options && options.capture) });
}

function dispatch(target, ev) {
  ev.target = target;
  const path = [];
  for (let n = target; n; n = n.parentNode) path.push(n);
  const run = (node, capture) => {
    ev.currentTarget = node;
    for (const l of node.listeners.filter((x) => x.type === ev.type && x.capture === capture)) l.fn.call(node, ev);
  };
  for (const node of path.slice().reverse()) {
    if (ev.stopped) break;
    run(node, true);
  }
  for (const node of path) {
    if (ev.stopped) break;
    run(node, false);
    if (!ev.bubbles) break;
  }
  return !ev.defaultPrevented;
}

export class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.childNodes = [];
    this.listeners = [];
    this.checkedNow = null;
    this.valueNow = null;
  }
  get children() { return this.childNodes.filter((n) => n instanceof Element); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  hasAttribute(name) { return this.attrs.has(name); }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const write = (list) => this.setAttribute('class', Array.from(new Set(list)).join(' '));
    return {
      contains: (name) => names().includes(name),
      add: (...more) => write([...names(), ...more]),
      remove: (...less) => write(names().filter((name) => !less.includes(name))),
      toggle: (name, force) => {
        const on = force === undefined ? !names().includes(name) : Boolean(force);
        write(on ? [...names(), name] : names().filter((n) => n !== name));
        return on;
      },
    };
  }
  get dataset() {
    const attr = (prop) => 'data-' + String(prop).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    return new Proxy({}, {
      get: (t, prop) => (typeof prop === 'string' && this.hasAttribute(attr(prop)) ? this.getAttribute(attr(prop)) : undefined),
      set: (t, prop, value) => { this.setAttribute(attr(prop), value); return true; },
      has: (t, prop) => this.hasAttribute(attr(prop)),
      deleteProperty: (t, prop) => { this.removeAttribute(attr(prop)); return true; },
    });
  }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(on) { if (on) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(on) { if (on) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get checked() { return this.checkedNow === null ? this.hasAttribute('checked') : this.checkedNow; }
  set checked(on) { this.checkedNow = Boolean(on); }
  get value() {
    if (this.valueNow !== null) return this.valueNow;
    return this.localName === 'textarea' ? this.textContent : (this.getAttribute('value') || '');
  }
  set value(text) { this.valueNow = String(text); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(value) {
    const text = String(value);
    this.ownerDocument.written.push({ id: this.id, text });
    this.replaceChildren(...(text ? [new Text(this.ownerDocument, text)] : []));
  }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) { this.replaceChildren(...parse(this.ownerDocument, String(html))); }
  get outerHTML() { return serialize(this); }
  insertAdjacentHTML(where, html) {
    const nodes = parse(this.ownerDocument, String(html));
    if (where === 'beforeend') nodes.forEach((n) => this.appendChild(n));
    else if (where === 'afterend') {
      const next = this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null;
      nodes.forEach((n) => this.parentNode.insertBefore(n, next));
    } else throw new Error(`minidom does not implement insertAdjacentHTML(${where})`);
  }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.detach(child);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, child);
    child.parentNode = this;
    return child;
  }
  detach(child) {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
  }
  removeChild(child) {
    this.detach(child);
    this.ownerDocument.dropLostFocus();
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...nodes) {
    this.childNodes.forEach((n) => { n.parentNode = null; });
    this.childNodes = [];
    nodes.forEach((n) => this.appendChild(n));
    this.ownerDocument.dropLostFocus();
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  matches(selector) { return parseSelector(selector).some((parts) => matchComplex(this, parts)); }
  closest(selector) {
    const groups = parseSelector(selector);
    for (let n = this; n instanceof Element; n = n.parentNode) if (groups.some((parts) => matchComplex(n, parts))) return n;
    return null;
  }
  querySelectorAll(selector) {
    const groups = parseSelector(selector);
    const out = [];
    walk(this, (el) => { if (groups.some((parts) => matchComplex(el, parts))) out.push(el); });
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, fn, options) { listen(this, type, fn, options); }
  removeEventListener(type, fn) { this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn)); }
  dispatchEvent(ev) { return dispatch(this, ev); }
  focus() { this.ownerDocument.activeElement = this; }
  click() { this.dispatchEvent(new Event('click', { bubbles: true })); }
  get offsetParent() {
    for (let n = this; n instanceof Element; n = n.parentNode) if (n.hidden) return null;
    return this.parentElement;
  }
}

function walk(root, visit) {
  for (const child of root.children) {
    visit(child);
    walk(child, visit);
  }
}

// ── Selectors: lists, descendant combinators, tag, #id, .class, [attr], [attr="v"] ──

function splitTop(text, separator) {
  const out = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const ch of text) {
    if (quote) { if (ch === quote) quote = null; current += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '[' || ch === '(') depth += 1;
    if (ch === ']' || ch === ')') depth -= 1;
    if (depth === 0 && (separator === ' ' ? /\s/.test(ch) : ch === separator)) { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

const selectorCache = new Map();
function parseSelector(text) {
  if (!selectorCache.has(text)) {
    selectorCache.set(text, splitTop(text, ',').map((group) => splitTop(group, ' ').map((part) => {
      if (part === '>' || part === '+' || part === '~') throw new Error(`minidom does not understand the selector ${JSON.stringify(text)}`);
      return parseCompound(part, text);
    })));
  }
  return selectorCache.get(text);
}

function parseCompound(part, whole) {
  const compound = { tag: null, ids: [], classes: [], attrs: [] };
  let rest = part;
  let m = rest.match(/^[a-zA-Z][\w-]*/);
  if (m) { compound.tag = m[0].toLowerCase(); rest = rest.slice(m[0].length); }
  while (rest) {
    if ((m = rest.match(/^#([\w-]+)/))) compound.ids.push(m[1]);
    else if ((m = rest.match(/^\.([\w-]+)/))) compound.classes.push(m[1]);
    else if ((m = rest.match(/^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([\w-]+)))?\s*\]/))) {
      compound.attrs.push({ name: m[1], value: m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : null)) });
    } else throw new Error(`minidom does not understand the selector ${JSON.stringify(whole)}`);
    rest = rest.slice(m[0].length);
  }
  return compound;
}

function matchCompound(el, c) {
  if (c.tag && el.localName !== c.tag) return false;
  if (c.ids.some((id) => el.id !== id)) return false;
  const classes = el.className.split(/\s+/);
  if (c.classes.some((name) => !classes.includes(name))) return false;
  return c.attrs.every((a) => el.hasAttribute(a.name) && (a.value === null || el.getAttribute(a.name) === a.value));
}

function matchComplex(el, parts) {
  if (!matchCompound(el, parts[parts.length - 1])) return false;
  let n = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    while (n instanceof Element && !matchCompound(n, parts[i])) n = n.parentNode;
    if (!(n instanceof Element)) return false;
    n = n.parentNode;
  }
  return true;
}

// ── HTML in and out ──────────────────────────────────────────────────────────

const TOKEN = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</g;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

export function parse(doc, html) {
  const root = new Element(doc, 'template');
  const stack = [root];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(html))) {
    const top = stack[stack.length - 1];
    const [whole, closing, opening, attrText, selfClose] = m;
    if (whole.startsWith('<!')) continue;
    if (closing) {
      const at = stack.map((el) => el.localName).lastIndexOf(closing.toLowerCase());
      if (at > 0) stack.length = at;
      continue;
    }
    if (opening) {
      const el = new Element(doc, opening);
      for (const a of (attrText || '').matchAll(ATTR)) {
        el.setAttribute(a[1], decode(a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : ''))));
      }
      top.appendChild(el);
      if (RAW.has(el.localName) && !selfClose) {
        const end = html.toLowerCase().indexOf(`</${el.localName}`, TOKEN.lastIndex);
        const stop = end < 0 ? html.length : end;
        const text = html.slice(TOKEN.lastIndex, stop);
        if (text) el.appendChild(new Text(doc, el.localName === 'textarea' || el.localName === 'title' ? decode(text) : text));
        TOKEN.lastIndex = end < 0 ? html.length : html.indexOf('>', end) + 1;
        continue;
      }
      if (!VOID.has(el.localName) && !selfClose) stack.push(el);
      continue;
    }
    top.appendChild(new Text(doc, decode(whole)));
  }
  const nodes = root.childNodes.slice();
  nodes.forEach((n) => { n.parentNode = null; });
  return nodes;
}

function serialize(node) {
  if (node instanceof Text) return escText(node.data);
  const attrs = Array.from(node.attrs).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escAttr(v)}"`)).join('');
  if (VOID.has(node.localName)) return `<${node.localName}${attrs}>`;
  return `<${node.localName}${attrs}>${node.childNodes.map(serialize).join('')}</${node.localName}>`;
}

export class Document extends Node {
  constructor(html) {
    super(null);
    this.ownerDocument = this;
    this.listeners = [];
    this.written = [];   // every textContent write, with the id of the element written
    this.cookie = '';
    this.visibilityState = 'visible';
    const nodes = parse(this, html);
    this.documentElement = nodes.find((n) => n instanceof Element && n.localName === 'html') || new Element(this, 'html');
    this.documentElement.parentNode = this;
    this.head = this.documentElement.querySelector('head');
    this.body = this.documentElement.querySelector('body');
    this.activeElement = this.body;
  }
  get children() { return [this.documentElement]; }
  createElement(tag) { return new Element(this, tag); }
  querySelectorAll(selector) {
    const out = this.documentElement.matches(selector) ? [this.documentElement] : [];
    return out.concat(this.documentElement.querySelectorAll(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getElementById(id) { return this.querySelector('#' + id); }
  contains(node) { return node === this || this.documentElement.contains(node); }
  addEventListener(type, fn, options) { listen(this, type, fn, options); }
  removeEventListener(type, fn) { this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn)); }
  dispatchEvent(ev) { return dispatch(this, ev); }
  dropLostFocus() {
    if (this.activeElement && this.activeElement !== this.body && !this.activeElement.isConnected) this.activeElement = this.body;
  }
  // Every text written into this element since the page opened, oldest first.
  texts(id) { return this.written.filter((w) => w.id === id).map((w) => w.text).filter(Boolean); }
}
