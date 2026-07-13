#!/usr/bin/env node
/**
 * tests/m4_friction.test.js - unit proof of the M4a "friction trio" built
 * into `extension/content/engine.js` (ls-listing + numbered actions,
 * read/find, here + did-you-mean) and `extension/content/registry.js`'s
 * `didYouMean()`, against the REAL, unmodified extension source, loaded
 * into one Node `vm` sandbox the same way tests/executor_credential.test.js
 * and tests/m3_chain_and_alias_macro.test.js already do for the other
 * `window.LFL`-scoped, browser-only files.
 *
 * Load order (mirrors manifest.json's content_scripts order): guards.js,
 * executor.js, registry.js, engine.js - all REAL, unmodified source.
 *
 * `LFL.axtree` is a deliberately simplified but FAITHFUL stand-in for
 * axtree.js's real build()/resolve()/isElementVisible() contract (index/ref
 * map shape, WeakRef-or-plain ref, isConnected + visibility checks), not
 * axtree.js's real DOM-walking/CSS-computing implementation - axtree.js
 * itself has no dedicated Node unit-test harness anywhere in this project
 * (battery-tested only; see engine.js's own header comment on the division
 * of labor). This suite's job is the M4a INTEGRATION CONTRACT - does a
 * listing context built the way `ls` builds it actually work when handed to
 * the real executor.js/guards.js - not re-proving axtree's own visibility
 * heuristics, which is out of scope here exactly like it is everywhere else
 * in this project's unit-test suite.
 *
 * Run: node tests/m4_friction.test.js
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const GUARDS_PATH = path.join(ROOT, 'extension', 'content', 'guards.js');
const EXECUTOR_PATH = path.join(ROOT, 'extension', 'content', 'executor.js');
const REGISTRY_PATH = path.join(ROOT, 'extension', 'content', 'registry.js');
const ENGINE_PATH = path.join(ROOT, 'extension', 'content', 'engine.js');

const registry = require(REGISTRY_PATH); // plain CommonJS - no DOM dependency (didYouMean tests)

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   - ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${e && e.message ? e.message : e}`);
  }
}

// =====================================================================
// sandbox construction - real guards.js/executor.js/registry.js/engine.js,
// a faithful-but-simplified LFL.axtree stand-in (see header comment).
// =====================================================================

function buildSandbox() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.HTMLInputElement = function HTMLInputElement() {};
  sandbox.HTMLTextAreaElement = function HTMLTextAreaElement() {};
  sandbox.Event = function Event(type, opts) { this.type = type; Object.assign(this, opts || {}); };
  sandbox.KeyboardEvent = function KeyboardEvent(type, opts) { this.type = type; Object.assign(this, opts || {}); };
  sandbox.URL = URL;
  sandbox.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
  sandbox.setTimeout = () => 0;
  sandbox.location = { origin: 'https://example.com', href: 'https://example.com/page' };
  sandbox.document = {
    baseURI: 'https://example.com/page',
    title: 'Example',
    body: { textContent: '' },
    __qsa: [],
    querySelectorAll() { return sandbox.document.__qsa; },
    querySelector() { return null; },
    createTreeWalker() { return { nextNode: () => null }; },
  };
  vm.createContext(sandbox);

  vm.runInContext(fs.readFileSync(GUARDS_PATH, 'utf8'), sandbox, { filename: 'guards.js' });

  // Faithful-but-simplified LFL.axtree stand-in - see file header comment.
  // resolve() mirrors the real contract exactly: ref may be WeakRef-shaped
  // (has .deref()) or a plain element (real axtree.resolve() supports both
  // via `ref.deref ? ref.deref() : ref`); null/disconnected/invisible all
  // resolve to null, same fail-closed shape as the real implementation.
  sandbox.window.LFL.axtree = {
    resolve(map, index) {
      const ref = map.get(index);
      if (!ref) return null;
      const el = typeof ref.deref === 'function' ? ref.deref() : ref;
      if (!el) return null;
      if (el.isConnected === false) return null;
      if (el.__visible === false) return null;
      return el;
    },
    isElementVisible(el) { return !!el && el.__visible !== false; },
    frameOptsFor() { return undefined; }, // top-document only in this suite - ambient document/location used instead
  };

  vm.runInContext(fs.readFileSync(EXECUTOR_PATH, 'utf8'), sandbox, { filename: 'executor.js' });
  assert.strictEqual(typeof sandbox.window.LFL.executor.execute, 'function');

  vm.runInContext(fs.readFileSync(REGISTRY_PATH, 'utf8'), sandbox, { filename: 'registry.js' });
  assert.strictEqual(typeof sandbox.window.LFL.registry.createRegistry, 'function');

  vm.runInContext(fs.readFileSync(ENGINE_PATH, 'utf8'), sandbox, { filename: 'engine.js' });
  assert.strictEqual(typeof sandbox.window.LFL.engine.tryDeterministic, 'function');

  return sandbox;
}

// ---- fake element factories ----

function fakeAnchor(href) {
  const clicked = { count: 0 };
  const el = {
    tagName: 'A',
    isConnected: true,
    __visible: true,
    _href: href,
    getAttribute(name) { return name === 'href' ? this._href : null; },
    hasAttribute(name) { return name === 'href'; },
    closest(sel) { return sel === 'a[href]' ? this : null; },
    click() { clicked.count += 1; },
    dispatchEvent() {},
  };
  el.__clicked = clicked;
  return el;
}

function fakeButton() {
  const clicked = { count: 0 };
  const el = {
    tagName: 'BUTTON',
    isConnected: true,
    __visible: true,
    getAttribute() { return null; },
    hasAttribute() { return false; },
    closest() { return null; },
    click() { clicked.count += 1; },
    dispatchEvent() {},
  };
  el.__clicked = clicked;
  return el;
}

function fakeInput(attrs) {
  const el = {
    tagName: 'INPUT',
    isConnected: true,
    __visible: true,
    isContentEditable: false,
    value: '',
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    dispatchEvent() {},
  };
  return el;
}

// entries: array of {index, tag, role, name, extra, el}
function makeListingContext(entries) {
  const map = new Map();
  entries.forEach((e) => map.set(e.index, e.el));
  return {
    entries: entries.map((e) => ({ index: e.index, ref: e.el, role: e.role, name: e.name, tag: e.tag, extra: e.extra || '' })),
    map,
    notes: [],
  };
}

function freshState(listingContext) {
  return { listingContext: listingContext || null, findContext: null, pendingCrossOriginUrl: null, rlBudgetCache: null };
}

// =====================================================================
// Part 1 - listing map shape is exactly executor-consumable, and `ls`
// itself builds a context in that shape (not a parallel structure).
// =====================================================================

function testListingMapShape() {
  console.log('\n[1] listing map shape = executor-consumable (ls builds it, executor.execute() consumes it unmodified)');

  const sandbox = buildSandbox();
  const linkEl = fakeAnchor('/local');
  const buttonEl = fakeButton();
  const fieldEl = fakeInput({ type: 'text' });
  const entries = [
    { index: 1, tag: 'a', role: 'link', name: 'Home', el: linkEl },
    { index: 2, tag: 'button', role: 'button', name: 'Submit', el: buttonEl },
    { index: 3, tag: 'input', role: 'textbox', name: 'Query', extra: 'type=text', el: fieldEl },
  ];
  sandbox.window.LFL.axtree.build = () => {
    const map = new Map();
    entries.forEach((e) => map.set(e.index, e.el));
    return { entries: entries.map((e) => ({ index: e.index, ref: e.el, role: e.role, name: e.name, tag: e.tag, extra: e.extra || '' })), map, notes: [] };
  };

  const state = freshState();
  const det = sandbox.window.LFL.engine.tryDeterministic('ls', state);

  check('ls sets state.listingContext with a real Map instance', () => {
    assert.ok(state.listingContext, 'listingContext must be set');
    // The map is a Map constructed INSIDE the vm sandbox's own realm (a
    // different Map constructor object than this test file's own global
    // Map, even though it's the same built-in), so `instanceof Map` against
    // the host realm's Map would fail for reasons that have nothing to do
    // with product correctness - check the functional Map interface instead.
    const map = state.listingContext.map;
    assert.strictEqual(typeof map.get, 'function');
    assert.strictEqual(typeof map.set, 'function');
    assert.strictEqual(map.constructor.name, 'Map');
  });

  check('ls output lists all three sections with correct counts', () => {
    assert.match(det.output, /links \(1\):/);
    assert.match(det.output, /buttons \(1\):/);
    assert.match(det.output, /fields \(1\):/);
    assert.match(det.output, /\[1\] link "Home"/);
    assert.match(det.output, /\[2\] button "Submit"/);
    assert.match(det.output, /\[3\] textbox "Query"/);
  });

  check('the SAME map, handed unmodified to LFL.executor.execute(), resolves and clicks the real element (no parallel structure)', () => {
    buttonEl.__clicked.count = 0;
    const result = sandbox.window.LFL.executor.execute({ action: 'click', element: 2 }, state.listingContext.map);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(buttonEl.__clicked.count, 1, 'the real button element must have been clicked via the listing map');
  });

  check('ls again REPLACES the listing context (fresh map each time)', () => {
    const oldMap = state.listingContext.map;
    sandbox.window.LFL.engine.tryDeterministic('ls', state);
    assert.notStrictEqual(state.listingContext.map, oldMap);
  });

  check('`clear` wipes the listing context and find context', () => {
    state.findContext = { query: 'x', matches: [], idx: 0 };
    const d = sandbox.window.LFL.engine.tryDeterministic('clear', state);
    assert.strictEqual(d.clear, true);
    assert.strictEqual(state.listingContext, null);
    assert.strictEqual(state.findContext, null);
  });
}

// =====================================================================
// Part 2 - `open <N>`: same-origin navigates + navInitiated:true;
// cross-origin -> pendingCrossOriginUrl, NOT navigation, NOT navInitiated;
// non-link -> refused; no context -> gentle error.
// =====================================================================

function testOpenIndex() {
  console.log('\n[2] `open <N>` - same-origin navigate, cross-origin pending-confirm, guard cases');

  const sandbox = buildSandbox();

  check('open <N> with no listing context -> gentle error, no crash', () => {
    const state = freshState();
    const det = sandbox.window.LFL.engine.tryDeterministic('open 1', state);
    assert.match(det.output, /no listing/);
    assert.ok(!det.navInitiated);
  });

  check('open <N> same-origin link -> navigates via location.href AND is tagged navInitiated:true', () => {
    const el = fakeAnchor('/pricing');
    const ctx = makeListingContext([{ index: 1, tag: 'a', role: 'link', name: 'Pricing', el }]);
    const state = freshState(ctx);
    sandbox.location.href = 'https://example.com/page';
    const det = sandbox.window.LFL.engine.tryDeterministic('open 1', state);
    assert.strictEqual(sandbox.location.href, 'https://example.com/pricing');
    assert.strictEqual(det.navInitiated, true, JSON.stringify(det));
  });

  check('open <N> cross-origin link -> latches pendingCrossOriginUrl, does NOT navigate, NOT tagged navInitiated', () => {
    const el = fakeAnchor('https://other.example/x');
    const ctx = makeListingContext([{ index: 1, tag: 'a', role: 'link', name: 'Elsewhere', el }]);
    const state = freshState(ctx);
    sandbox.location.href = 'https://example.com/page';
    const det = sandbox.window.LFL.engine.tryDeterministic('open 1', state);
    assert.strictEqual(sandbox.location.href, 'https://example.com/page', 'must not have navigated');
    assert.strictEqual(state.pendingCrossOriginUrl, 'https://other.example/x');
    assert.match(det.output, /type "open!" to confirm/);
    assert.ok(!det.navInitiated, 'cross-origin pending branch must not be tagged navInitiated');
  });

  check('open <N> on a non-link entry -> refused, suggests click', () => {
    const el = fakeButton();
    const ctx = makeListingContext([{ index: 1, tag: 'button', role: 'button', name: 'Go', el }]);
    const state = freshState(ctx);
    const det = sandbox.window.LFL.engine.tryDeterministic('open 1', state);
    assert.match(det.output, /is not a link/);
    assert.match(det.output, /click 1/);
  });

  check('open <N> on a javascript: href -> refused (non-http(s) floor, reused from guards)', () => {
    const el = fakeAnchor('javascript:alert(1)');
    const ctx = makeListingContext([{ index: 1, tag: 'a', role: 'link', name: 'Bad', el }]);
    const state = freshState(ctx);
    const det = sandbox.window.LFL.engine.tryDeterministic('open 1', state);
    assert.match(det.output, /refusing to open non-http\(s\) link/);
    assert.ok(!det.navInitiated);
  });

  check('open <N> with an out-of-range index -> gentle error naming the index', () => {
    const ctx = makeListingContext([{ index: 1, tag: 'a', role: 'link', name: 'Home', el: fakeAnchor('/x') }]);
    const state = freshState(ctx);
    const det = sandbox.window.LFL.engine.tryDeterministic('open 99', state);
    assert.match(det.output, /no such item: \[99\]/);
  });

  check('`open <link text>` (non-numeric) is unaffected - still the pre-existing text-search path', () => {
    sandbox.document.__qsa = [{ textContent: 'Home', getAttribute: (n) => (n === 'href' ? '/home' : null) }];
    const state = freshState();
    const det = sandbox.window.LFL.engine.tryDeterministic('open home', state);
    assert.match(det.output, /opening "Home"/);
  });
}

// =====================================================================
// Part 3 - `click <N>` inherits executor.js's guards verbatim: blocked
// javascript:/cross-origin targets refuse (el.click() never fires),
// normal targets are allowed (el.click() fires), no approval card
// concept applies at this layer (engine.js never renders one).
// =====================================================================

function testClickIndex() {
  console.log('\n[3] `click <N>` - inherits executor.js guards verbatim');

  const sandbox = buildSandbox();

  check('click <N> on a javascript: anchor -> BLOCKED, el.click() never fires', () => {
    const el = fakeAnchor('javascript:document.title="pwned"');
    const ctx = makeListingContext([{ index: 1, tag: 'a', role: 'link', name: 'Bad', el }]);
    const state = freshState(ctx);
    const det = sandbox.window.LFL.engine.tryDeterministic('click 1', state);
    assert.match(det.output, /blocked/i);
    assert.strictEqual(el.__clicked.count, 0);
  });

  check('click <N> on a cross-origin anchor -> BLOCKED, el.click() never fires', () => {
    const el = fakeAnchor('https://evil.example/steal');
    const ctx = makeListingContext([{ index: 1, tag: 'a', role: 'link', name: 'Evil', el }]);
    const state = freshState(ctx);
    const det = sandbox.window.LFL.engine.tryDeterministic('click 1', state);
    assert.match(det.output, /blocked/i);
    assert.strictEqual(el.__clicked.count, 0);
  });

  check('click <N> on a same-origin/no-target element -> ALLOWED, el.click() fires', () => {
    const el = fakeButton();
    const ctx = makeListingContext([{ index: 1, tag: 'button', role: 'button', name: 'Submit', el }]);
    const state = freshState(ctx);
    const det = sandbox.window.LFL.engine.tryDeterministic('click 1', state);
    assert.match(det.output, /clicked \[1\]/);
    assert.strictEqual(el.__clicked.count, 1);
  });

  check('click <N> with no listing context -> gentle error', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('click 1', freshState());
    assert.match(det.output, /no listing/);
  });

  check('click <N> is NOT tagged navInitiated even for an allowed click (executor cannot know in advance if it will navigate)', () => {
    const el = fakeButton();
    const ctx = makeListingContext([{ index: 1, tag: 'button', role: 'button', name: 'Submit', el }]);
    const det = sandbox.window.LFL.engine.tryDeterministic('click 1', freshState(ctx));
    assert.ok(!det.navInitiated);
  });
}

// =====================================================================
// Part 4 - `fill <N> with <text>` and `fill <label> with <text>` inherit
// isPasswordField() verbatim; label matching is exact-wins/substring/
// ambiguous.
// =====================================================================

function testFillIndexAndLabel() {
  console.log('\n[4] `fill <N> with ...` / `fill <label> with ...` - credential guard + label matching');

  const sandbox = buildSandbox();

  check('fill <N> on a password field -> REFUSED, value never written', () => {
    const el = fakeInput({ type: 'password' });
    const ctx = makeListingContext([{ index: 1, tag: 'input', role: 'textbox', name: 'Password', extra: 'type=password', el }]);
    const det = sandbox.window.LFL.engine.tryDeterministic('fill 1 with hunter2', freshState(ctx));
    assert.match(det.output, /credentials never go through the model/);
    assert.strictEqual(el.value, '');
  });

  check('fill <N> on a normal field -> ALLOWED, value written', () => {
    const el = fakeInput({ type: 'text' });
    const ctx = makeListingContext([{ index: 1, tag: 'input', role: 'textbox', name: 'Query', extra: 'type=text', el }]);
    const det = sandbox.window.LFL.engine.tryDeterministic('fill 1 with intel arc', freshState(ctx));
    assert.match(det.output, /filled \[1\]/);
    assert.strictEqual(el.value, 'intel arc');
  });

  check('fill <label> exact match (case-insensitive) -> fills the right field', () => {
    const el = fakeInput({ type: 'text' });
    const ctx = makeListingContext([{ index: 1, tag: 'input', role: 'textbox', name: 'Search Wikipedia', extra: 'type=text', el }]);
    const det = sandbox.window.LFL.engine.tryDeterministic('fill search wikipedia with intel arc', freshState(ctx));
    assert.match(det.output, /filled \[1\]/);
    assert.strictEqual(el.value, 'intel arc');
  });

  check('fill <label> on a password-labeled field -> REFUSED (guard inherited through label resolution too)', () => {
    const el = fakeInput({ type: 'password' });
    const ctx = makeListingContext([{ index: 1, tag: 'input', role: 'textbox', name: 'Password', extra: 'type=password', el }]);
    const det = sandbox.window.LFL.engine.tryDeterministic('fill password with hunter2', freshState(ctx));
    assert.match(det.output, /credentials never go through the model/);
    assert.strictEqual(el.value, '');
  });

  check('fill <label> ambiguous (two fields share a substring) -> lists candidates, fills NOTHING', () => {
    const elA = fakeInput({ type: 'text' });
    const elB = fakeInput({ type: 'text' });
    const ctx = makeListingContext([
      { index: 1, tag: 'input', role: 'textbox', name: 'First Name', extra: 'type=text', el: elA },
      { index: 2, tag: 'input', role: 'textbox', name: 'Last Name', extra: 'type=text', el: elB },
    ]);
    const det = sandbox.window.LFL.engine.tryDeterministic('fill name with Alice', freshState(ctx));
    assert.match(det.output, /ambiguous field "name"/);
    assert.match(det.output, /\[1\]/);
    assert.match(det.output, /\[2\]/);
    assert.strictEqual(elA.value, '', 'nothing should have been filled');
    assert.strictEqual(elB.value, '', 'nothing should have been filled');
  });

  check('fill <label> no match -> says so, fills nothing', () => {
    const el = fakeInput({ type: 'text' });
    const ctx = makeListingContext([{ index: 1, tag: 'input', role: 'textbox', name: 'Email', extra: 'type=text', el }]);
    const det = sandbox.window.LFL.engine.tryDeterministic('fill phone number with 555-1234', freshState(ctx));
    assert.match(det.output, /no fillable field matching/);
    assert.strictEqual(el.value, '');
  });

  check('fill <N> with no listing context -> gentle error', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('fill 1 with x', freshState());
    assert.match(det.output, /no listing/);
  });
}

// =====================================================================
// Part 5 - bare `<N>` default action by type; requires an active listing
// context.
// =====================================================================

function testBareNumber() {
  console.log('\n[5] bare `<N>` - default action by listing-entry type, requires context');

  const sandbox = buildSandbox();

  check('bare number with NO listing context -> gentle error, does nothing', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('3', freshState());
    assert.match(det.output, /no listing/);
  });

  check('bare number on a link entry -> behaves exactly like `open <N>` (navigates + navInitiated)', () => {
    const el = fakeAnchor('/x');
    const ctx = makeListingContext([{ index: 1, tag: 'a', role: 'link', name: 'X', el }]);
    sandbox.location.href = 'https://example.com/page';
    const det = sandbox.window.LFL.engine.tryDeterministic('1', freshState(ctx));
    assert.strictEqual(sandbox.location.href, 'https://example.com/x');
    assert.strictEqual(det.navInitiated, true);
  });

  check('bare number on a button entry -> behaves exactly like `click <N>`', () => {
    const el = fakeButton();
    const ctx = makeListingContext([{ index: 2, tag: 'button', role: 'button', name: 'Go', el }]);
    const det = sandbox.window.LFL.engine.tryDeterministic('2', freshState(ctx));
    assert.strictEqual(el.__clicked.count, 1);
    assert.match(det.output, /clicked \[2\]/);
  });

  check('bare number on a field entry -> prints the fill-N hint, does not fill anything', () => {
    const el = fakeInput({ type: 'text' });
    const ctx = makeListingContext([{ index: 3, tag: 'input', role: 'textbox', name: 'Query', extra: 'type=text', el }]);
    const det = sandbox.window.LFL.engine.tryDeterministic('3', freshState(ctx));
    assert.match(det.output, /use `fill 3 with/);
    assert.strictEqual(el.value, '');
  });

  check('bare number for an index not present in the context -> gentle error, not a crash', () => {
    const ctx = makeListingContext([{ index: 1, tag: 'a', role: 'link', name: 'X', el: fakeAnchor('/x') }]);
    const det = sandbox.window.LFL.engine.tryDeterministic('7', freshState(ctx));
    assert.match(det.output, /no such item: \[7\]/);
  });
}

// =====================================================================
// Part 6 - read/find pure helpers (matching + truncation caps).
// =====================================================================

function testReadFindPureHelpers() {
  console.log('\n[6] read/find pure helpers - capLines (truncation) + textIncludesQuery (matching)');

  const sandbox = buildSandbox();
  const engine = sandbox.window.LFL.engine;

  check('capLines: under the cap -> unchanged, truncated:0', () => {
    const r = engine.capLines(['a', 'b'], 5);
    assert.deepStrictEqual(r.lines, ['a', 'b']);
    assert.strictEqual(r.truncated, 0);
  });

  check('capLines: exactly at the cap -> unchanged, truncated:0', () => {
    const r = engine.capLines(['a', 'b', 'c'], 3);
    assert.strictEqual(r.lines.length, 3);
    assert.strictEqual(r.truncated, 0);
  });

  check('capLines: over the cap -> sliced, truncated count correct', () => {
    const r = engine.capLines(['a', 'b', 'c', 'd', 'e'], 2);
    assert.deepStrictEqual(r.lines, ['a', 'b']);
    assert.strictEqual(r.truncated, 3);
  });

  check('capLines: non-array input -> empty, no throw', () => {
    // Returned array is constructed inside the vm sandbox's own realm - see
    // the Map comment in Part 1; compare by length, not deepStrictEqual
    // against a host-realm array literal.
    const r = engine.capLines(null, 5);
    assert.strictEqual(r.lines.length, 0);
    assert.strictEqual(r.truncated, 0);
  });

  check('textIncludesQuery: case-insensitive substring match', () => {
    assert.strictEqual(engine.textIncludesQuery('The Quick Brown Fox', 'quick'), true);
    assert.strictEqual(engine.textIncludesQuery('The Quick Brown Fox', 'QUICK'), true);
  });

  check('textIncludesQuery: no match -> false', () => {
    assert.strictEqual(engine.textIncludesQuery('The Quick Brown Fox', 'astronomy'), false);
  });

  check('textIncludesQuery: empty text or query -> false, no throw', () => {
    assert.strictEqual(engine.textIncludesQuery('', 'x'), false);
    assert.strictEqual(engine.textIncludesQuery('x', ''), false);
    assert.strictEqual(engine.textIncludesQuery(null, 'x'), false);
  });

  check('classifyEntry: link/button/field classification, including input[type=submit] as a button', () => {
    assert.strictEqual(engine.classifyEntry({ tag: 'a', role: 'link' }), 'link');
    assert.strictEqual(engine.classifyEntry({ tag: 'button', role: 'button' }), 'button');
    assert.strictEqual(engine.classifyEntry({ tag: 'input', role: 'button', extra: 'type=submit' }), 'button');
    assert.strictEqual(engine.classifyEntry({ tag: 'input', role: 'textbox', extra: 'type=text' }), 'field');
    assert.strictEqual(engine.classifyEntry({ tag: 'select', role: 'combobox' }), 'field');
  });

  check('filterEntriesByText: case-insensitive substring on accessible name', () => {
    const entries = [{ name: 'Search Wikipedia' }, { name: 'Random article' }, { name: 'Contact us' }];
    const r = engine.filterEntriesByText(entries, 'search');
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].name, 'Search Wikipedia');
  });

  check('filterEntriesByText: empty filter -> returns everything', () => {
    const entries = [{ name: 'a' }, { name: 'b' }];
    assert.strictEqual(engine.filterEntriesByText(entries, '').length, 2);
    assert.strictEqual(engine.filterEntriesByText(entries, null).length, 2);
  });

  check('pickLabelMatch: exact match wins over a substring match elsewhere', () => {
    const entries = [{ index: 1, name: 'Name' }, { index: 2, name: 'First Name' }];
    const r = engine.pickLabelMatch(entries, 'Name');
    assert.ok(r.match);
    assert.strictEqual(r.match.index, 1);
  });

  check('pickLabelMatch: unique substring hit -> match', () => {
    const entries = [{ index: 1, name: 'Search Wikipedia' }];
    const r = engine.pickLabelMatch(entries, 'wiki');
    assert.ok(r.match);
    assert.strictEqual(r.match.index, 1);
  });

  check('pickLabelMatch: multiple substring hits -> ambiguous', () => {
    const entries = [{ index: 1, name: 'First Name' }, { index: 2, name: 'Last Name' }];
    const r = engine.pickLabelMatch(entries, 'name');
    assert.ok(r.ambiguous);
    assert.strictEqual(r.ambiguous.length, 2);
  });

  check('pickLabelMatch: no hits -> none', () => {
    const entries = [{ index: 1, name: 'Email' }];
    const r = engine.pickLabelMatch(entries, 'phone');
    assert.strictEqual(r.none, true);
  });

  check('fillableFieldEntries: excludes links/buttons, keeps fields', () => {
    const entries = [
      { tag: 'a', role: 'link', name: 'Home' },
      { tag: 'button', role: 'button', name: 'Go' },
      { tag: 'input', role: 'textbox', name: 'Query', extra: 'type=text' },
    ];
    const r = engine.fillableFieldEntries(entries);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].name, 'Query');
  });
}

// =====================================================================
// Part 7 - `here`'s pure pieces: suggestCommands rules + report formatting.
// =====================================================================

function testHerePureHelpers() {
  console.log('\n[7] `here` pure helpers - suggestCommands rules + formatHereReport');

  const sandbox = buildSandbox();
  const engine = sandbox.window.LFL.engine;

  check('suggestCommands: search box present -> suggests search', () => {
    const s = engine.suggestCommands({ searchBoxPresent: true, linkCount: 1, tableCount: 0, articlePresent: false });
    assert.ok(s.includes('search "..."'));
  });

  check('suggestCommands: many links -> suggests ls links', () => {
    const s = engine.suggestCommands({ searchBoxPresent: false, linkCount: 20, tableCount: 0, articlePresent: false });
    assert.ok(s.includes('ls links'));
  });

  check('suggestCommands: table present -> suggests extract table', () => {
    const s = engine.suggestCommands({ searchBoxPresent: false, linkCount: 1, tableCount: 2, articlePresent: false });
    assert.ok(s.includes('extract table'));
  });

  check('suggestCommands: article present -> suggests read', () => {
    const s = engine.suggestCommands({ searchBoxPresent: false, linkCount: 1, tableCount: 0, articlePresent: true });
    assert.ok(s.includes('read'));
  });

  check('suggestCommands: always returns between 2 and 4 suggestions', () => {
    const empty = engine.suggestCommands({});
    assert.ok(empty.length >= 2 && empty.length <= 4, JSON.stringify(empty));
    const everything = engine.suggestCommands({ searchBoxPresent: true, linkCount: 50, tableCount: 3, articlePresent: true });
    assert.ok(everything.length >= 2 && everything.length <= 4, JSON.stringify(everything));
  });

  check('formatHereReport: includes origin/title/counts/budget/suggestions, ~8 lines', () => {
    const stats = { origin: 'https://example.com', title: 'Example', linkCount: 3, buttonCount: 1, fieldCount: 2, formCount: 1, tableCount: 0, searchBoxPresent: true, paginationHint: false, listingActive: false };
    const budget = { llmRemaining: 20, llmMax: 20, actionRemaining: 10, actionMax: 10, paused: false };
    const out = engine.formatHereReport(stats, ['search "..."', 'ls'], budget);
    const lines = out.split('\n');
    assert.ok(lines.length >= 6 && lines.length <= 12, `expected ~8-12 lines, got ${lines.length}`);
    assert.match(out, /origin: https:\/\/example\.com/);
    assert.match(out, /llm 20\/20/);
    assert.match(out, /try: search "\.\.\."/);
  });
}

// =====================================================================
// Part 8 - did-you-mean (registry.js, plain CommonJS, no vm needed).
// =====================================================================

function testDidYouMean() {
  console.log('\n[8] did-you-mean - registry.didYouMean() pure function');

  const NAMES = ['search', 'open', 'open!', 'go', 'back', 'scroll', 'extract', 'log', 'budget', 'continue', 'help', 'man', 'clear', 'alias', 'unalias', 'macro', 'unmacro', 'origins', 'dev', 'ls', 'click', 'fill', 'read', 'find', 'here'];

  check('a 1-distance typo ("serach") suggests "search"', () => {
    const r = registry.didYouMean('serach wikipedia', NAMES);
    assert.deepStrictEqual(r, ['search']);
  });

  check('a 2-distance typo ("saerh") still suggests "search"', () => {
    const r = registry.didYouMean('saerh something', NAMES);
    assert.ok(r.includes('search'), JSON.stringify(r));
  });

  check('an EXACT verb match -> no suggestions (this input would already have matched deterministically)', () => {
    const r = registry.didYouMean('search wikipedia', NAMES);
    assert.deepStrictEqual(r, []);
  });

  check('a bare number -> no suggestions', () => {
    assert.deepStrictEqual(registry.didYouMean('42', NAMES), []);
    assert.deepStrictEqual(registry.didYouMean('7', NAMES), []);
  });

  check('an "ask ..." command -> no suggestions, always the explicit model path', () => {
    assert.deepStrictEqual(registry.didYouMean('ask what is this page about', NAMES), []);
    assert.deepStrictEqual(registry.didYouMean('ask', NAMES), []);
  });

  check('a distant/unrelated token -> no suggestions (falls through to the LLM as today)', () => {
    const r = registry.didYouMean('xyzzy plugh totally unrelated command', NAMES);
    assert.deepStrictEqual(r, []);
  });

  check('a token shorter than the minimum length (< 3 chars) -> no suggestions even if close to a short verb', () => {
    const r = registry.didYouMean('gp wikipedia.org', NAMES); // 2 chars, would be 1 away from "go"
    assert.deepStrictEqual(r, []);
  });

  check('multiple equally-close candidates -> up to 3 returned, closest-first, deterministic order', () => {
    const r = registry.didYouMean('foo', ['fob', 'fon', 'for', 'far']);
    assert.ok(r.length <= 3);
    assert.ok(r.length >= 1);
  });

  check('empty input -> no suggestions, no throw', () => {
    assert.deepStrictEqual(registry.didYouMean('', NAMES), []);
    assert.deepStrictEqual(registry.didYouMean('   ', NAMES), []);
    assert.deepStrictEqual(registry.didYouMean(null, NAMES), []);
  });

  check('damerauLevenshtein: adjacent transposition costs 1 (not 2, as plain Levenshtein would score it)', () => {
    assert.strictEqual(registry.damerauLevenshtein('serach', 'search'), 1);
  });

  check('integration: against the REAL registered command surface (LFL.commandRegistry.names()), "serach" still resolves to "search"', () => {
    const sandbox = buildSandbox();
    const realNames = sandbox.window.LFL.commandRegistry.names();
    assert.ok(realNames.includes('search'), 'sanity: search must be a real registered name');
    assert.ok(realNames.includes('ls'), 'sanity: the M4a verbs must be registered too');
    // r is an array constructed inside the vm sandbox's own realm - see the
    // Map/capLines comments above; convert before deepStrictEqual so the
    // comparison isn't tripped up by a harmless cross-realm artifact.
    const r = Array.from(sandbox.window.LFL.registry.didYouMean('serach', realNames));
    assert.deepStrictEqual(r, ['search']);
  });
}

// ---- run everything ----

console.log('tests/m4_friction.test.js - M4a friction trio: ls+actions, read/find, here+did-you-mean');
testListingMapShape();
testOpenIndex();
testClickIndex();
testFillIndexAndLabel();
testBareNumber();
testReadFindPureHelpers();
testHerePureHelpers();
testDidYouMean();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
