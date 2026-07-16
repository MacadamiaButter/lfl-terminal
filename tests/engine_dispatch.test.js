#!/usr/bin/env node
/**
 * tests/engine_dispatch.test.js - DIRECT unit coverage for the verb dispatch
 * chain in `extension/content/engine.js`'s `tryDeterministic()` (starts
 * around line 1042), which had ZERO direct unit coverage until this file -
 * see registry.js's header comment ("that chain is battery-proven
 * [tests/run_battery.py], ... and has zero direct unit-test coverage of its
 * own") and engine.js's own header comment ("M3: tryDeterministic()'s
 * dispatch chain below is DELIBERATELY unchanged from M1/M2 ... it's the one
 * part of this build with no direct unit-test coverage of its own; only the
 * separately-run Playwright battery exercises it end to end"). Foundations
 * sprint F3 (2026-07-16): add coverage WITHOUT touching that dispatch code
 * at all - the "deliberately unchanged" note stays true (verify with
 * `git status --short extension/` - must be empty).
 *
 * SCOPE - dispatch + parse contract, NOT DOM effects (see
 * $VAULT/orchestrator/FOUNDATIONS-SPRINT-2026-07-16.md's F3 section). For
 * each raw input this file asserts (a) whether tryDeterministic() handled it
 * deterministically (non-null) or fell through to the model (null), and (b)
 * that the returned output/shape proves the RIGHT branch ran and parsed its
 * args correctly. On this suite's empty/minimal fake page, most verbs return
 * their graceful "nothing found" message - per the spec, that message IS the
 * proof of branch selection + arg parsing; this file is not re-proving DOM
 * manipulation, which stays tests/run_battery.py / tests/m3_battery.py's job
 * (and, for the pieces that already have their own dedicated DOM-shaped unit
 * suites, tests/m4_friction.test.js's and tests/m4c_highlight.test.js's job -
 * see the EXCLUSIONS section near the bottom of this file for exactly what
 * is deliberately not re-tested here and why).
 *
 * Sandbox construction (buildSandbox() below) is LIFTED AND ADAPTED from
 * tests/m4_friction.test.js's own buildSandbox() - same real, unmodified
 * source loaded in the same order (guards.js -> executor.js -> registry.js
 * -> engine.js) into one Node `vm` sandbox, same faithful-but-simplified
 * `LFL.axtree` stand-in (see that file's header comment for the contract
 * this stand-in honors: index/ref map shape, WeakRef-or-plain ref,
 * isConnected + visibility checks - NOT axtree.js's real DOM-walking
 * implementation, which has no dedicated Node unit-test harness anywhere in
 * this project either). This suite's dispatch chain reaches a few branches
 * m4_friction's suite never exercises (`back`, `scroll`, `read`'s fallback,
 * `log`), so a handful of small stand-ins are ADDED on top of m4_friction's
 * original sandbox - each one is called out in a comment at its addition
 * site below.
 *
 * Run: node tests/engine_dispatch.test.js
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
// sandbox construction - lifted and adapted from tests/m4_friction.test.js's
// buildSandbox() (see this file's header comment). Additions beyond the
// original are marked "ADDED for engine_dispatch" at their point of use.
// =====================================================================

function emptyAxtreeBuild() {
  return { entries: [], map: new Map(), notes: [] };
}

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
  // ADDED for engine_dispatch: `back` and `scroll` are dispatch branches
  // m4_friction's suite never reaches (its scope is the M4a friction trio,
  // not the whole chain) - `history.back()`/`window.scrollBy()` need a
  // callable stand-in or engine.js's doScroll()/`back` branch throws before
  // ever returning a result to assert on. Plain spies, no real
  // scrolling/history semantics implied.
  sandbox.__backCalls = 0;
  sandbox.history = { back() { sandbox.__backCalls += 1; } };
  sandbox.__lastScroll = null;
  sandbox.scrollBy = (opts) => { sandbox.__lastScroll = opts; };
  sandbox.document = {
    baseURI: 'https://example.com/page',
    title: 'Example',
    // ADDED for engine_dispatch: doRead()'s fallback path (`pickReadRoot()`
    // falling all the way through to `document.body`) calls
    // `root.querySelectorAll(...)` on whatever it picked
    // (`extractReadLines()`) - m4_friction never dispatches `read` at all, so
    // its plain `{ textContent: '' }` body stand-in would throw here. A
    // querySelectorAll that returns nothing keeps the fallback honest: an
    // empty page really does have no readable h1-h6/p/li nodes.
    body: { textContent: '', querySelectorAll() { return []; } },
    __qsa: [],
    querySelectorAll() { return sandbox.document.__qsa; },
    querySelector() { return null; },
    createTreeWalker() { return { nextNode: () => null }; },
  };
  vm.createContext(sandbox);

  vm.runInContext(fs.readFileSync(GUARDS_PATH, 'utf8'), sandbox, { filename: 'guards.js' });

  // Faithful-but-simplified LFL.axtree stand-in - see tests/m4_friction.test.js's
  // header comment for the full contract this honors.
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
    frameOptsFor() { return undefined; },
    // ADDED for engine_dispatch: default to an empty listing so `ls` and
    // fill-by-label's auto-build path (doFillLabel(), engine.js) can run
    // without every single test having to wire this up itself, the way
    // m4_friction's per-test `sandbox.window.LFL.axtree.build = () => ...`
    // does when it needs a NON-empty listing.
    build: emptyAxtreeBuild,
  };

  vm.runInContext(fs.readFileSync(EXECUTOR_PATH, 'utf8'), sandbox, { filename: 'executor.js' });
  assert.strictEqual(typeof sandbox.window.LFL.executor.execute, 'function');

  vm.runInContext(fs.readFileSync(REGISTRY_PATH, 'utf8'), sandbox, { filename: 'registry.js' });
  assert.strictEqual(typeof sandbox.window.LFL.registry.createRegistry, 'function');

  vm.runInContext(fs.readFileSync(ENGINE_PATH, 'utf8'), sandbox, { filename: 'engine.js' });
  assert.strictEqual(typeof sandbox.window.LFL.engine.tryDeterministic, 'function');

  return sandbox;
}

// ---- fake element factories (lifted from tests/m4_friction.test.js) ----

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
    form: null,
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    dispatchEvent() {},
  };
  return el;
}

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
// Part 1 - control-plane verbs: help/clear/log/man, back/scroll,
// extract-links/extract-table, open!, read, here.
// =====================================================================

function testControlPlane() {
  console.log('\n[1] control-plane verbs - help/clear/log/man, back/scroll, extract, open!, read, here');

  const sandbox = buildSandbox();
  const engine = sandbox.window.LFL.engine;

  check('empty string -> handled deterministically (non-null), empty output', () => {
    const det = engine.tryDeterministic('', freshState());
    assert.ok(det !== null, 'empty input must be handled, not fall through to the model');
    assert.strictEqual(det.output, '');
  });

  check('whitespace-only string -> same as empty (trimmed before the empty check)', () => {
    const det = engine.tryDeterministic('   \t  ', freshState());
    assert.ok(det !== null);
    assert.strictEqual(det.output, '');
  });

  check('leading/trailing whitespace around a valid command still parses (`  help  `)', () => {
    const det = engine.tryDeterministic('  help  ', freshState());
    assert.strictEqual(det.output, engine.HELP_TEXT);
  });

  check('help -> exact HELP_TEXT', () => {
    const det = engine.tryDeterministic('help', freshState());
    assert.strictEqual(det.output, engine.HELP_TEXT);
  });

  check('clear -> wipes output, tagged clear:true', () => {
    const det = engine.tryDeterministic('clear', freshState());
    assert.strictEqual(det.output, '');
    assert.strictEqual(det.clear, true);
  });

  check('log with no audit log installed -> graceful placeholder', () => {
    const det = engine.tryDeterministic('log', freshState());
    assert.strictEqual(det.output, '(no audit log)');
  });

  check('log with an audit log installed -> calls .render(), returns its text verbatim', () => {
    sandbox.window.LFL.auditLog = { render: () => 'AUDIT-STUB-CONTENTS' };
    const det = engine.tryDeterministic('log', freshState());
    assert.strictEqual(det.output, 'AUDIT-STUB-CONTENTS');
    delete sandbox.window.LFL.auditLog;
  });

  check('back -> calls history.back(), tagged navInitiated, output "back"', () => {
    const before = sandbox.__backCalls;
    const det = engine.tryDeterministic('back', freshState());
    assert.strictEqual(sandbox.__backCalls, before + 1);
    assert.strictEqual(det.output, 'back');
    assert.strictEqual(det.navInitiated, true);
  });

  check('scroll up -> scrolls with a negative delta, output "scrolled up"', () => {
    const det = engine.tryDeterministic('scroll up', freshState());
    assert.strictEqual(det.output, 'scrolled up');
    assert.strictEqual(sandbox.__lastScroll.top, -600);
  });

  check('scroll down -> scrolls with a positive delta, output "scrolled down"', () => {
    const det = engine.tryDeterministic('scroll down', freshState());
    assert.strictEqual(det.output, 'scrolled down');
    assert.strictEqual(sandbox.__lastScroll.top, 600);
  });

  check('scroll <garbage direction> -> NOT handled - falls through to the model (documents actual behavior: only up/down are recognized, an invalid direction is not a deterministic no-op, it is simply unmatched)', () => {
    const det = engine.tryDeterministic('scroll sideways', freshState());
    assert.strictEqual(det, null);
  });

  check('extract links on a page with no visible links -> graceful placeholder', () => {
    const det = engine.tryDeterministic('extract links', freshState());
    assert.strictEqual(det.output, '(no visible links)');
  });

  check('extract table on a page with no table -> graceful placeholder', () => {
    const det = engine.tryDeterministic('extract table', freshState());
    assert.strictEqual(det.output, '(no table found on page)');
  });

  check('open! with no pending cross-origin confirm -> graceful placeholder', () => {
    const det = engine.tryDeterministic('open!', freshState());
    assert.strictEqual(det.output, 'no pending cross-origin open to confirm');
  });

  check('open! with a pending cross-origin url -> navigates, tagged navInitiated, clears the pending slot', () => {
    const state = freshState();
    state.pendingCrossOriginUrl = 'https://other.example/y';
    sandbox.location.href = 'https://example.com/page';
    const det = engine.tryDeterministic('open!', state);
    assert.strictEqual(sandbox.location.href, 'https://other.example/y');
    assert.strictEqual(det.output, 'opening https://other.example/y');
    assert.strictEqual(det.navInitiated, true);
    assert.strictEqual(state.pendingCrossOriginUrl, null);
  });

  check('read on a page with no article/main and no fallback content -> graceful placeholder (empty-page floor; see EXCLUSIONS for what is not re-tested here)', () => {
    const det = engine.tryDeterministic('read', freshState());
    assert.strictEqual(det.output, '(no readable text found)');
  });

  check('here -> reports the empty page honestly and suggests ls+help (the <2-suggestions floor)', () => {
    const det = engine.tryDeterministic('here', freshState());
    assert.match(det.output, /origin: https:\/\/example\.com/);
    assert.match(det.output, /try: ls \| help/);
  });

  check('man <a real command> -> usage line built from that command\'s registered argSpec/help', () => {
    const det = engine.tryDeterministic('man search', freshState());
    assert.strictEqual(det.output, 'search\n  usage: search "query" | search query\n  fill+submit the page search box');
  });

  check('man <a second real command> -> proves this is general, not special-cased to "search"', () => {
    const det = engine.tryDeterministic('man ls', freshState());
    assert.match(det.output, /usage: ls \| ls links \[filter\] \| ls buttons \[filter\] \| ls fields \[filter\]/);
  });

  check('man <unknown command> -> "no such command", not a crash', () => {
    const det = engine.tryDeterministic('man totally-unknown-cmd', freshState());
    assert.strictEqual(det.output, 'no such command: totally-unknown-cmd');
  });
}

// =====================================================================
// Part 2 - `ls` and its three filtered variants, with and without a
// filter string; one case-insensitivity spot check (LS).
// =====================================================================

function testLs() {
  console.log('\n[2] `ls` + `ls links|buttons|fields [filter]` variants');

  const sandbox = buildSandbox();
  const engine = sandbox.window.LFL.engine;

  check('bare `ls` on an empty listing -> all three sections present, each "(none)"', () => {
    const det = engine.tryDeterministic('ls', freshState());
    assert.match(det.output, /links \(0\):\n {2}\(none\)/);
    assert.match(det.output, /buttons \(0\):\n {2}\(none\)/);
    assert.match(det.output, /fields \(0\):\n {2}\(none\)/);
  });

  check('`ls links` (no filter) with nothing to list -> "(no link)"', () => {
    const det = engine.tryDeterministic('ls links', freshState());
    assert.strictEqual(det.output, '(no link)');
  });

  check('`ls links <filter>` -> filter text echoed in the "nothing matched" message (proves the filter arg was parsed)', () => {
    const det = engine.tryDeterministic('ls links pricing', freshState());
    assert.strictEqual(det.output, '(no link matching "pricing")');
  });

  check('`ls buttons` (no filter) -> "(no button)"', () => {
    const det = engine.tryDeterministic('ls buttons', freshState());
    assert.strictEqual(det.output, '(no button)');
  });

  check('`ls fields <filter>` -> filter text echoed', () => {
    const det = engine.tryDeterministic('ls fields email', freshState());
    assert.strictEqual(det.output, '(no field matching "email")');
  });

  check('case-insensitivity spot check: `LS` (all caps) dispatches exactly like `ls`', () => {
    const det = engine.tryDeterministic('LS', freshState());
    assert.match(det.output, /links \(0\):/);
  });
}

// =====================================================================
// Part 3 - `open <N>` vs `open <link text>` vs `open!` precedence and
// quoting; the digit-only form MUST be checked before the generic
// link-text form (engine.js's own comment on this - a bare integer would
// otherwise also satisfy the generic `(.+)` capture).
// =====================================================================

function testOpenDispatch() {
  console.log('\n[3] `open <N>` vs `open <link text>` precedence + quoting');

  const sandbox = buildSandbox();
  const engine = sandbox.window.LFL.engine;

  check('`open <N>` (digit-only remainder) with no listing context -> index-form error, not a link-text search', () => {
    const det = engine.tryDeterministic('open 5', freshState());
    assert.match(det.output, /no listing - run `ls` first/);
  });

  check('case-insensitivity spot check: `Open 7` (mixed case) still dispatches to the index form', () => {
    const det = engine.tryDeterministic('Open 7', freshState());
    assert.match(det.output, /no listing - run `ls` first/);
  });

  check('`open <non-numeric text>` with no visible links -> generic link-text form, echoes the parsed text', () => {
    const det = engine.tryDeterministic('open pricing page', freshState());
    assert.strictEqual(det.output, 'no visible link matching "pricing page"');
  });

  check('`open "<quoted text>"` matches a visible link whose text has no quotes (a863a7a taught-script fix)', () => {
    sandbox.document.__qsa = [{ textContent: 'Contact Us', getAttribute: (n) => (n === 'href' ? '/contact' : null) }];
    sandbox.location.href = 'https://example.com/page';
    const det = engine.tryDeterministic('open "Contact Us"', freshState());
    assert.strictEqual(sandbox.location.href, 'https://example.com/contact');
    assert.strictEqual(det.navInitiated, true);
  });
}

// =====================================================================
// Part 4 - `click <N>` dispatch (guard/behavior depth is m4_friction's
// job - see EXCLUSIONS; this is just proving the regex routes to
// doClickIndex and the parsed index is used).
// =====================================================================

function testClickDispatch() {
  console.log('\n[4] `click <N>` dispatch');

  const sandbox = buildSandbox();
  const engine = sandbox.window.LFL.engine;

  check('click <N> with no listing context -> gentle error naming the reason', () => {
    const det = engine.tryDeterministic('click 3', freshState());
    assert.match(det.output, /no listing - run `ls` first/);
  });

  check('click <N> with a listing context -> resolves the SAME index, clicks the real element', () => {
    const el = fakeButton();
    const ctx = makeListingContext([{ index: 2, tag: 'button', role: 'button', name: 'Go', el }]);
    const det = engine.tryDeterministic('click 2', freshState(ctx));
    assert.strictEqual(det.output, 'clicked [2]');
    assert.strictEqual(el.__clicked.count, 1);
  });
}

// =====================================================================
// Part 5 - `fill <N> with <text>` (index form) vs `fill <label> with
// <text>` (label form) - digit-only first token must resolve to the
// index form (engine.js's own comment: "an all-digit first token is
// unambiguously an index, never a label"). Quoted vs unquoted forms for
// both the label and the value (a863a7a taught-script fixes).
// =====================================================================

function testFillDispatch() {
  console.log('\n[5] `fill <N> with ...` vs `fill <label> with ...` precedence + quoting');

  const sandbox = buildSandbox();
  const engine = sandbox.window.LFL.engine;

  check('fill <N> with no listing context -> index-form error (snapshot-bound by design)', () => {
    const det = engine.tryDeterministic('fill 4 with hello', freshState());
    assert.match(det.output, /no listing - run `ls` first/);
  });

  check('fill <N> with an out-of-range index -> names the parsed index, not a label lookup', () => {
    const ctx = makeListingContext([{ index: 1, tag: 'input', role: 'textbox', name: 'Query', extra: 'type=text', el: fakeInput({ type: 'text' }) }]);
    const det = engine.tryDeterministic('fill 99 with hello', freshState(ctx));
    assert.strictEqual(det.output, 'no such item: [99] - run `ls` again');
  });

  check('fill <N> with <unquoted text> -> writes the value verbatim', () => {
    const el = fakeInput({ type: 'text' });
    const ctx = makeListingContext([{ index: 1, tag: 'input', role: 'textbox', name: 'Query', extra: 'type=text', el }]);
    const det = engine.tryDeterministic('fill 1 with intel arc', freshState(ctx));
    assert.strictEqual(det.output, 'filled [1] with "intel arc"');
    assert.strictEqual(el.value, 'intel arc');
  });

  check('fill <N> with "<quoted text>" -> strips the outer quote pair from the value (index form)', () => {
    const el = fakeInput({ type: 'text' });
    const ctx = makeListingContext([{ index: 1, tag: 'input', role: 'textbox', name: 'Query', extra: 'type=text', el }]);
    const det = engine.tryDeterministic('fill 1 with "intel arc"', freshState(ctx));
    assert.strictEqual(el.value, 'intel arc');
  });

  check('fill <label> with no prior listing -> auto-builds an (empty) listing, reports no fillable match, still sets state.listingContext', () => {
    const state = freshState();
    const det = engine.tryDeterministic('fill nickname with hello', state);
    assert.strictEqual(det.output, 'no fillable field matching "nickname" - try `ls fields`');
    assert.ok(state.listingContext, 'auto-build must have populated the listing context');
  });

  check('fill <unquoted label> with <text>, listing already present -> resolves by name, not by treating the label as an index', () => {
    const el = fakeInput({ type: 'text' });
    const ctx = makeListingContext([{ index: 1, tag: 'input', role: 'textbox', name: 'Email', extra: 'type=text', el }]);
    const det = engine.tryDeterministic('fill Email with hello', freshState(ctx));
    assert.strictEqual(det.output, 'filled [1] with "hello"');
    assert.strictEqual(el.value, 'hello');
  });

  check('fill "<quoted label>" with <text> -> quotes stripped from the label before matching (a863a7a fix)', () => {
    const el = fakeInput({ type: 'text' });
    const ctx = makeListingContext([{ index: 1, tag: 'input', role: 'textbox', name: 'Email', extra: 'type=text', el }]);
    const det = engine.tryDeterministic('fill "Email" with hello', freshState(ctx));
    assert.strictEqual(det.output, 'filled [1] with "hello"');
    assert.strictEqual(el.value, 'hello');
  });

  check('fill <label> with "<quoted text>" -> quotes stripped from the value (label form)', () => {
    const el = fakeInput({ type: 'text' });
    const ctx = makeListingContext([{ index: 1, tag: 'input', role: 'textbox', name: 'Email', extra: 'type=text', el }]);
    const det = engine.tryDeterministic('fill Email with "hello there"', freshState(ctx));
    assert.strictEqual(el.value, 'hello there');
  });

  check('fill <label with no match>, listing present -> gentle error, distinct wording from the index form\'s "no such item"', () => {
    const ctx = makeListingContext([{ index: 1, tag: 'input', role: 'textbox', name: 'Query', extra: 'type=text', el: fakeInput({ type: 'text' }) }]);
    const det = engine.tryDeterministic('fill phonenumber with 555-1234', freshState(ctx));
    assert.strictEqual(det.output, 'no fillable field matching "phonenumber" - try `ls fields`');
  });
}

// =====================================================================
// Part 6 - bare `<N>` default action by listing-entry type.
// =====================================================================

function testBareNumberDispatch() {
  console.log('\n[6] bare `<N>` - default action by listing-entry type');

  const sandbox = buildSandbox();
  const engine = sandbox.window.LFL.engine;

  check('bare number with no listing context -> gentle error, no crash', () => {
    const det = engine.tryDeterministic('4', freshState());
    assert.match(det.output, /no listing - run `ls` first/);
  });

  check('bare number on a link entry -> behaves like `open <N>` (navigates, tagged navInitiated)', () => {
    const el = fakeAnchor('/dest');
    const ctx = makeListingContext([{ index: 1, tag: 'a', role: 'link', name: 'Dest', el }]);
    sandbox.location.href = 'https://example.com/page';
    const det = engine.tryDeterministic('1', freshState(ctx));
    assert.strictEqual(sandbox.location.href, 'https://example.com/dest');
    assert.strictEqual(det.navInitiated, true);
  });

  check('bare number on a field entry -> prints the fill-N hint, writes nothing', () => {
    const el = fakeInput({ type: 'text' });
    const ctx = makeListingContext([{ index: 3, tag: 'input', role: 'textbox', name: 'Query', extra: 'type=text', el }]);
    const det = engine.tryDeterministic('3', freshState(ctx));
    assert.match(det.output, /use `fill 3 with/);
    assert.strictEqual(el.value, '');
  });
}

// =====================================================================
// Part 7 - `find <text>` and bare `find`.
// =====================================================================

function testFindDispatch() {
  console.log('\n[7] `find <text>` + bare `find`');

  const sandbox = buildSandbox();
  const engine = sandbox.window.LFL.engine;

  check('find <text> with no matches on the page -> echoes the parsed query in the "no matches" message', () => {
    const det = engine.tryDeterministic('find astronomy', freshState());
    assert.strictEqual(det.output, 'no matches for "astronomy"');
  });

  check('bare `find` with no active find context -> distinct "no active find" message, not the query-echo form above', () => {
    const det = engine.tryDeterministic('find', freshState());
    assert.strictEqual(det.output, 'no active find - try: find <text>');
  });
}

// =====================================================================
// Part 8 - `highlight` three-way mode dispatch (status / clear / set) and
// `matches` (+ its "show matches"/"list matches" aliases). Full paint/
// match-count behavior is EXCLUDED here (see EXCLUSIONS) - already owned
// by tests/m4c_highlight.test.js's fuller CSS.highlights/Range stand-in.
// This file only proves tryDeterministic() routes each raw string to the
// right one of the three regex branches.
// =====================================================================

function testHighlightAndMatchesDispatch() {
  console.log('\n[8] `highlight` mode dispatch (status/clear/set) + `matches` + aliases');

  const sandbox = buildSandbox();
  const engine = sandbox.window.LFL.engine;

  check('bare `highlight` (status mode) with nothing active -> status message', () => {
    const det = engine.tryDeterministic('highlight', freshState());
    assert.strictEqual(det.output, 'no active highlight - try: highlight <text>');
  });

  check('`highlight clear` with nothing active -> distinct clear-mode message (checked as its own dedicated regex BEFORE the generic highlight pattern)', () => {
    const det = engine.tryDeterministic('highlight clear', freshState());
    assert.strictEqual(det.output, 'no active highlight');
  });

  check('`highlight <text>` (set mode) -> reaches the CSS Custom Highlight API gate, distinct from both messages above (proves the 3-way mode dispatch, not just 2-way)', () => {
    const det = engine.tryDeterministic('highlight astronomy', freshState());
    assert.strictEqual(det.output, 'highlight: not supported by this browser (CSS Custom Highlight API required)');
  });

  check('parseHighlightArg (pure helper) - the same 3-way split tryDeterministic\'s regex chain relies on, directly, including quote/whitespace trimming', () => {
    // Objects returned here are constructed inside the vm sandbox's own
    // realm - a different Object constructor than this test file's own
    // global Object, even for a plain object literal - so
    // assert.deepStrictEqual's prototype check fails for reasons that have
    // nothing to do with product correctness (same cross-realm caveat
    // tests/m4_friction.test.js documents for its Map/array checks).
    // Compare field-by-field instead.
    assert.strictEqual(engine.parseHighlightArg('').mode, 'status');
    assert.strictEqual(engine.parseHighlightArg('   ').mode, 'status');
    assert.strictEqual(engine.parseHighlightArg('clear').mode, 'clear');
    assert.strictEqual(engine.parseHighlightArg('CLEAR').mode, 'clear');
    const set = engine.parseHighlightArg('  astronomy facts  ');
    assert.strictEqual(set.mode, 'set');
    assert.strictEqual(set.query, 'astronomy facts');
  });

  check('`matches` with no findContext -> graceful placeholder', () => {
    const det = engine.tryDeterministic('matches', freshState());
    assert.strictEqual(det.output, 'no matches - run "highlight <text>" or "find <text>" first');
  });

  check('`show matches` / `list matches` natural phrasings dispatch identically to bare `matches`', () => {
    const detShow = engine.tryDeterministic('show matches', freshState());
    const detList = engine.tryDeterministic('list matches', freshState());
    assert.strictEqual(detShow.output, 'no matches - run "highlight <text>" or "find <text>" first');
    assert.strictEqual(detList.output, 'no matches - run "highlight <text>" or "find <text>" first');
  });
}

// =====================================================================
// Part 9 - `search "quoted"` vs `search bare`, no-search-box floor, one
// case-insensitivity spot check (SEARCH).
// =====================================================================

function testSearchDispatch() {
  console.log('\n[9] `search "quoted"` vs `search bare` + case-insensitivity spot check');

  const sandbox = buildSandbox();
  const engine = sandbox.window.LFL.engine;

  check('search with no search box on the page -> graceful placeholder (proves doSearch was selected even with nothing to fill)', () => {
    sandbox.document.__qsa = [];
    const det = engine.tryDeterministic('search wikipedia', freshState());
    assert.strictEqual(det.output, 'no search box found - try: ask <what you want>');
  });

  check('search "<quoted query>" -> fills the box with exactly the quoted text (no surrounding quote chars)', () => {
    const el = fakeInput({});
    sandbox.document.__qsa = [el];
    const det = engine.tryDeterministic('search "hello world"', freshState());
    assert.strictEqual(el.value, 'hello world');
    assert.strictEqual(det.output, 'filled search box with "hello world" and pressed Enter');
  });

  check('search <bare multi-word query> -> the ENTIRE remainder is the query, not just the first word', () => {
    const el = fakeInput({});
    sandbox.document.__qsa = [el];
    const det = engine.tryDeterministic('search wikipedia article history', freshState());
    assert.strictEqual(el.value, 'wikipedia article history');
    assert.strictEqual(det.output, 'filled search box with "wikipedia article history" and pressed Enter');
  });

  check('case-insensitivity spot check: `SEARCH` (all caps) still parses the bare-arg form correctly', () => {
    const el = fakeInput({});
    sandbox.document.__qsa = [el];
    const det = engine.tryDeterministic('SEARCH uppercase test', freshState());
    assert.strictEqual(el.value, 'uppercase test');
    assert.match(det.output, /filled search box with "uppercase test"/);
  });
}

// =====================================================================
// Part 10 - the explicit model path (`ask ...`) and genuinely unknown
// verbs both fall through (null); a mistyped/garbage command likewise.
// =====================================================================

function testFallsThroughToModel() {
  console.log('\n[10] `ask ...` + unknown verbs -> null (falls through to the model)');

  const sandbox = buildSandbox();
  const engine = sandbox.window.LFL.engine;

  check('`ask <anything>` -> null, the explicit force-to-model prefix is never intercepted deterministically', () => {
    const det = engine.tryDeterministic('ask what is this page about', freshState());
    assert.strictEqual(det, null);
  });

  check('bare `ask` (no argument) -> also null', () => {
    const det = engine.tryDeterministic('ask', freshState());
    assert.strictEqual(det, null);
  });

  check('a completely unknown verb -> null, no crash', () => {
    const det = engine.tryDeterministic('zzzznotarealcommand', freshState());
    assert.strictEqual(det, null);
  });

  check('a Terminal-level command that engine.js registers for help/man text ONLY (e.g. `go`) -> null here, because terminal.js dispatches it, not tryDeterministic() (see engine.js\'s own header comment + registry.js\'s `go` registration comment)', () => {
    const det = engine.tryDeterministic('go example.com', freshState());
    assert.strictEqual(det, null);
  });
}

// ---- run everything ----

console.log('tests/engine_dispatch.test.js - direct unit coverage of engine.js tryDeterministic()\'s dispatch chain');
testControlPlane();
testLs();
testOpenDispatch();
testClickDispatch();
testFillDispatch();
testBareNumberDispatch();
testFindDispatch();
testHighlightAndMatchesDispatch();
testSearchDispatch();
testFallsThroughToModel();

// =====================================================================
// EXCLUSIONS - deliberately NOT re-tested here, and why. Per this file's
// header comment, the scope is the dispatch/parse contract, not DOM
// effects; anything below either needs a fuller DOM than this suite's
// minimal stand-in provides, or is already owned end-to-end by another
// suite and re-testing it here would be pure duplication rather than new
// coverage.
//
//   - Real content extraction (`read`'s headings/paragraphs, `extract
//     table`'s rows/cells, `extract links`'s multi-link listing) beyond
//     the empty-page "nothing found" floor: needs actual DOM elements
//     with real tagName/querySelectorAll trees, which axtree.js itself has
//     no dedicated Node harness for either (battery-tested only, per
//     engine.js's and tests/m4_friction.test.js's own header comments).
//   - `click <N>` / `fill <N>|<label> with <text>`'s full guard/label-
//     matching depth (credential-field refusal, ambiguous-label listing,
//     cross-origin/javascript: href refusal, stale-index re-resolution):
//     exhaustively covered already in tests/m4_friction.test.js Parts 2-4
//     and 9. This file only proves the REGEX chain routes to the right
//     handler with the right parsed args - re-asserting guard depth here
//     would duplicate that suite, not add coverage.
//   - `highlight`'s real match-count/painting (Range construction, capping
//     at HIGHLIGHT_MAX_RANGES, CSS.highlights content): owned by
//     tests/m4c_highlight.test.js's purpose-built CSS.highlights/Range/
//     createTreeWalker(__textNodes) stand-in. This file proves only the
//     3-way status/clear/set MODE dispatch at the tryDeterministic() level.
//   - `find`'s bare-form "advance to next match" stepping and
//     highlight/find shared findContext interplay: covered in
//     tests/m4_friction.test.js Part 6 / tests/m4c_highlight.test.js. Here,
//     bare `find` is only exercised with NO active context (its own
//     distinct dispatch branch).
//   - `registry.didYouMean()`'s typo-suggestion behavior for a genuinely
//     unknown verb: that logic does not live inside tryDeterministic() at
//     all (terminal.js calls it separately after tryDeterministic()
//     returns null) and is already thoroughly unit-tested in
//     tests/m4_friction.test.js Part 8. This file only asserts that
//     tryDeterministic() itself returns null for such input.
//   - The ~20 Terminal-level commands engine.js registers purely for
//     help/man text and vocabulary enumeration (go, alias, unalias, macro,
//     unmacro, origins, dev, autoopen, config, pin, unpin, script, run,
//     pause, teach, fortune, stats, theme, cowsay, snake, 2048, games, sl):
//     every one of them is dispatched by terminal.js, NEVER by
//     tryDeterministic() (see engine.js's header comment and each
//     reg.register() call's own comment in engine.js). None of
//     tryDeterministic()'s regex branches recognizes any of these names,
//     so they all fall through to null exactly like any other unrecognized
//     verb - proven generically by the unknown-verb and `go` cases in Part
//     10 above. A dedicated case for all ~20 would repeat that same single
//     fact ~20 times for no new information, so it is excluded rather than
//     silently skipped.
// =====================================================================

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
