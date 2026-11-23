// A very small DOM for the tests of the modules that draw on pages (disksize.js, share.js, watch.js): elements,
// text, attributes, classes, events, a few selectors (tag, #id, .class, [attr], [attr="v"], descendants, lists)
// and a MutationObserver that is told of every child list change. Layout is made up (fixed boxes).
// It is NOT a browser: it proves the modules' logic, not how Steam's pages look.
'use strict';

let observers = [];

class FakeNode {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; this._on = {}; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; const i = p.childNodes.indexOf(this); return p.childNodes[i + 1] || null; }
  get isConnected() { let n = this; while (n) { if (n === this.ownerDocument) return true; n = n.parentNode; } return false; }
  get children() { return this.childNodes.filter(n => n instanceof FakeElement); }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v))); }
  _changed() { if (this.isConnected) this.ownerDocument._mutated(this); }
  appendChild(c) { return this.insertBefore(c, null); }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? this.ownerDocument.createTextNode(c) : c); }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    c.parentNode = this;
    this._changed();
    return c;
  }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) { this.childNodes.splice(i, 1); c.parentNode = null; this._changed(); } return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  addEventListener(t, f) { (this._on[t] = this._on[t] || []).push(f); }
  removeEventListener(t, f) { if (this._on[t]) this._on[t] = this._on[t].filter(x => x !== f); }
  // Bubbling, with a capture pass through the document first (the way the modules listen to it)
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    let stop = false;
    ev.stopPropagation = () => { stop = true; };
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    const path = []; let n = this; while (n) { path.push(n); n = n.parentNode; }
    for (const node of path.slice().reverse()) for (const f of (node._capture && node._capture[ev.type]) || []) { f(ev); if (stop) return ev; }
    for (const node of path) { for (const f of (node._on[ev.type] || []).slice()) f(ev); if (stop) break; }
    return ev;
  }
  querySelectorAll(sel) { const out = []; const walk = n => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

class FakeText extends FakeNode {
  constructor(doc, text) { super(doc); this.data = text; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

function compound(el, part) {
  const m = /^([a-zA-Z][\w-]*)?((?:[#.][\w-]+|\[[^\]]+\])*)$/.exec(part);
  if (!m) throw new Error('fake-dom: selector not supported: ' + part);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const bit of m[2].match(/[#.][\w-]+|\[[^\]]+\]/g) || []) {
    if (bit[0] === '#' && el.id !== bit.slice(1)) return false;
    if (bit[0] === '.' && !el.classList.contains(bit.slice(1))) return false;
    if (bit[0] === '[') {
      const a = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(bit);
      if (!el.hasAttribute(a[1])) return false;
      if (a[2] !== undefined && el.getAttribute(a[1]) !== a[2]) return false;
    }
  }
  return true;
}

class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc);
    this.tagName = String(tag).toUpperCase();
    this.attributes = new Map();
    this.style = {};
    const el = this;
    this.classList = {
      contains: c => el.className.split(/\s+/).includes(c),
      add: (...cs) => { const s = new Set(el.className.split(/\s+/).filter(Boolean)); cs.forEach(c => s.add(c)); el.className = Array.from(s).join(' '); },
      remove: (...cs) => { el.className = el.className.split(/\s+/).filter(c => c && !cs.includes(c)).join(' '); },
    };
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  matches(sel) {
    return sel.split(',').map(s => s.trim()).some(s => {
      const parts = s.split(/\s+/);
      if (!compound(this, parts[parts.length - 1])) return false;
      let n = this.parentNode;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (n && !(n instanceof FakeElement && compound(n, parts[i]))) n = n.parentNode;
        if (!n) return false;
        n = n.parentNode;
      }
      return true;
    });
  }
  closest(sel) { let n = this; while (n instanceof FakeElement) { if (n.matches(sel)) return n; n = n.parentNode; } return null; }
  getBoundingClientRect() { return { left: 100, top: 200, right: 220, bottom: 240, width: 120, height: 40 }; }
  get offsetWidth() { return 120; }
  get offsetHeight() { return 40; }
  focus() { this.ownerDocument.activeElement = this; }
  select() { }
  click() { this.dispatchEvent({ type: 'click' }); }
}

class FakeDocument extends FakeNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.documentElement = this.createElement('html');
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.title = '';
    this.activeElement = null;
    this._capture = {};
    this.copied = [];
  }
  get children() { return [this.documentElement]; }
  createElement(tag) { return new FakeElement(this, tag); }
  createElementNS(ns, tag) { return new FakeElement(this, tag); }
  createTextNode(t) { return new FakeText(this, t); }
  getElementById(id) { return this.querySelector('#' + id); }
  addEventListener(t, f, capture) { if (capture === true || (capture && capture.capture)) (this._capture[t] = this._capture[t] || []).push(f); else super.addEventListener(t, f); }
  removeEventListener(t, f, capture) { if (capture === true || (capture && capture.capture)) { if (this._capture[t]) this._capture[t] = this._capture[t].filter(x => x !== f); } else super.removeEventListener(t, f); }
  execCommand(c) { if (c === 'copy') { this.copied.push('execCommand'); return true; } return false; }
  _mutated(target) { for (const o of observers) if (o.target && o.target.ownerDocument === this && o.target.contains(target)) o._queue(); }
}

class FakeMutationObserver {
  constructor(cb) { this.cb = cb; this.target = null; this.queued = false; this.calls = 0; }
  observe(target) { this.target = target; if (!observers.includes(this)) observers.push(this); }
  disconnect() { this.target = null; observers = observers.filter(o => o !== this); }
  _queue() { if (this.queued) return; this.queued = true; queueMicrotask(() => { this.queued = false; if (this.target) { this.calls++; this.cb([], this); } }); }
}

// A window with that document. `computed` is what getComputedStyle answers for <html> (the theme's variables)
function makeDomWindow(href) {
  const document = new FakeDocument();
  const u = new URL(href || 'https://store.steampowered.com/');
  const listeners = {};
  const win = {
    document,
    location: { href: u.href, hostname: u.hostname, pathname: u.pathname, search: u.search },
    computed: {},
    clipboard: [],
    innerWidth: 1280, innerHeight: 800,
    MutationObserver: FakeMutationObserver,
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, URL,
    requestAnimationFrame: f => setTimeout(() => f(Date.now()), 0),
    cancelAnimationFrame: id => clearTimeout(id),
    getComputedStyle: el => ({ getPropertyValue: k => (el === document.documentElement ? win.computed[k] : '') || '' }),
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener(t, f) { if (listeners[t]) listeners[t] = listeners[t].filter(x => x !== f); },
    fire(t, ev) { for (const f of (listeners[t] || []).slice()) f(ev || { type: t }); },
    listeners,
  };
  win.navigator = { clipboard: { writeText: t => { win.clipboard.push(t); return Promise.resolve(); } } };
  win.window = win;
  return win;
}

const observing = () => observers.length;

module.exports = { makeDomWindow, FakeMutationObserver, observing };
