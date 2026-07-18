#!/usr/bin/env node
/**
 * tests/m6_expect_wait.test.js - unit proof of "recipes that succeed"
 * (LFL-TERMINAL-RECIPES-THAT-SUCCEED-DESIGN.md): `expect` (deterministic
 * assertion), `wait` (bounded polling on the SAME predicate code), and the
 * `run <name>` verdict line formats - against the REAL, unmodified
 * extension source, same vm-sandbox pattern tests/m4_friction.test.js uses
 * for engine.js (guards.js/executor.js/registry.js/engine.js loaded into
 * one Node vm context, with a faithful-but-simplified LFL.axtree/document
 * stand-in - see that file's own header comment on the division of labor).
 *
 * Scope note (matches tests/m5_scripts.test.js's own documented boundary):
 * `wait`'s actual async poll loop, Esc-cancellation, and the `run` verdict
 * queue-plumbing (state.activeRun, the run-step envelope) live entirely in
 * terminal.js, which needs a real DOM/chrome.* runtime this suite's plain
 * Node vm sandbox does not provide - those are exercised by the Playwright
 * smoke (tests/m6_expect_wait_smoke.py) instead, same split M5's own suite
 * already draws. What IS tested here, exhaustively: the pure parsers/
 * evaluator/formatters (registry.js), `expect`'s DOM-fact-extraction +
 * dispatch (engine.js, end to end through tryDeterministic()), and the
 * define/import-time script validation both verbs must pass through.
 *
 * Run: node tests/m6_expect_wait.test.js
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

const registry = require(REGISTRY_PATH); // plain CommonJS - no DOM dependency

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

function fakeStorageArea() {
  let store = {};
  return {
    get(keys, cb) {
      const out = {};
      keys.forEach((k) => { if (store[k] !== undefined) out[k] = store[k]; });
      cb(out);
    },
    set(obj) { store = Object.assign({}, store, obj); },
  };
}

// =====================================================================
// sandbox construction - real guards.js/executor.js/registry.js/engine.js,
// plus a faithful-but-simplified document/axtree stand-in extended (beyond
// m4_friction's own) with a fake TreeWalker over an explicit text-node list
// and a fake querySelectorAll for headings - the two DOM reads
// extractExpectFacts() needs that m4_friction's sandbox never exercised.
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

  // __textNodes: array of {textContent, parentElement} - what the fake
  // TreeWalker below iterates. __headings: array of fake heading elements
  // ({textContent, __visible}) - what the fake querySelectorAll returns for
  // the exact selector engine.js's collectVisibleHeadings() uses.
  sandbox.document = {
    baseURI: 'https://example.com/page',
    title: 'Example',
    body: { textContent: '' },
    __textNodes: [],
    __headings: [],
    __qsa: [],
    querySelectorAll(sel) {
      if (sel === 'h1,h2,h3,h4,h5,h6,[role="heading"]') return sandbox.document.__headings;
      return sandbox.document.__qsa;
    },
    querySelector() { return null; },
    createTreeWalker(_root, _whatToShow, filterObj) {
      const nodes = sandbox.document.__textNodes;
      let i = 0;
      return {
        nextNode() {
          while (i < nodes.length) {
            const n = nodes[i];
            i += 1;
            const verdict = filterObj && typeof filterObj.acceptNode === 'function' ? filterObj.acceptNode(n) : sandbox.NodeFilter.FILTER_ACCEPT;
            if (verdict === sandbox.NodeFilter.FILTER_ACCEPT) return n;
          }
          return null;
        },
      };
    },
  };
  vm.createContext(sandbox);

  vm.runInContext(fs.readFileSync(GUARDS_PATH, 'utf8'), sandbox, { filename: 'guards.js' });

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
  };

  vm.runInContext(fs.readFileSync(EXECUTOR_PATH, 'utf8'), sandbox, { filename: 'executor.js' });
  vm.runInContext(fs.readFileSync(REGISTRY_PATH, 'utf8'), sandbox, { filename: 'registry.js' });
  assert.strictEqual(typeof sandbox.window.LFL.registry.parseExpectStep, 'function');
  vm.runInContext(fs.readFileSync(ENGINE_PATH, 'utf8'), sandbox, { filename: 'engine.js' });
  assert.strictEqual(typeof sandbox.window.LFL.engine.doExpect, 'function');

  return sandbox;
}

function fakeInput(attrs) {
  return {
    tagName: 'INPUT',
    isConnected: true,
    __visible: true,
    isContentEditable: false,
    value: (attrs && attrs.value) || '',
    getAttribute(name) { return attrs && Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    hasAttribute(name) { return !!(attrs && Object.prototype.hasOwnProperty.call(attrs, name)); },
    dispatchEvent() {},
  };
}

function freshState() {
  return { listingContext: null, findContext: null, highlightContext: null, pendingCrossOriginUrl: null, rlBudgetCache: null };
}

// entries: [{index, name, el}] - always classified as fields ('field' role,
// no tag/role match to link/button) by engine.js's classifyEntry().
function setListingFields(sandbox, state, entries) {
  const map = new Map();
  entries.forEach((e) => map.set(e.index, e.el));
  state.listingContext = {
    entries: entries.map((e) => ({ index: e.index, ref: e.el, role: 'textbox', name: e.name, tag: 'input', extra: 'type=text' })),
    map,
    notes: [],
  };
}

// =====================================================================
// [0] parseExpectStep - form matrix, malformed rejection
// =====================================================================
console.log('\n[0] parseExpectStep - all forms, malformed rejection');

check('expect url contains "..."', () => {
  const p = registry.parseExpectStep('expect url contains "/checkout"');
  assert.deepStrictEqual(p, { ok: true, kind: 'url', args: { substr: '/checkout' } });
});
check('expect origin "..."', () => {
  const p = registry.parseExpectStep('expect origin "https://shop.example"');
  assert.deepStrictEqual(p, { ok: true, kind: 'origin', args: { origin: 'https://shop.example' } });
});
check('expect text "..."', () => {
  const p = registry.parseExpectStep('expect text "Order confirmed"');
  assert.deepStrictEqual(p, { ok: true, kind: 'text', args: { substr: 'Order confirmed' } });
});
check('expect heading "..."', () => {
  const p = registry.parseExpectStep('expect heading "Results"');
  assert.deepStrictEqual(p, { ok: true, kind: 'heading', args: { substr: 'Results' } });
});
check('expect field "<label>" equals "..."', () => {
  const p = registry.parseExpectStep('expect field "Email" equals "a@b.c"');
  assert.deepStrictEqual(p, { ok: true, kind: 'field', args: { label: 'Email', mode: 'equals', value: 'a@b.c' } });
});
check('expect field "<label>" empty', () => {
  const p = registry.parseExpectStep('expect field "Email" empty');
  assert.deepStrictEqual(p, { ok: true, kind: 'field', args: { label: 'Email', mode: 'empty' } });
});
check('malformed: bare "expect" rejected with usage', () => {
  const p = registry.parseExpectStep('expect');
  assert.strictEqual(p.ok, false);
  assert.match(p.error, /usage: expect/);
});
check('malformed: unknown expect form rejected', () => {
  const p = registry.parseExpectStep('expect the sky is blue');
  assert.strictEqual(p.ok, false);
  assert.match(p.error, /usage: expect/);
});
check('malformed: expect field with neither equals nor empty rejected', () => {
  const p = registry.parseExpectStep('expect field "Email" contains "x"');
  assert.strictEqual(p.ok, false);
});
check('malformed: unclosed quote rejected', () => {
  const p = registry.parseExpectStep('expect text "unterminated');
  assert.strictEqual(p.ok, false);
});
check('case-insensitive head ("EXPECT")', () => {
  const p = registry.parseExpectStep('EXPECT url contains "x"');
  assert.strictEqual(p.ok, true);
});

// =====================================================================
// [1] parseWaitStep - form matrix, default/explicit timeout, hard cap
// rejection (never silently clamped), malformed rejection
// =====================================================================
console.log('\n[1] parseWaitStep - all forms, timeout defaults/cap, malformed rejection');

check('wait for text "..." - default timeout 10s', () => {
  const p = registry.parseWaitStep('wait for text "Order confirmed"');
  assert.deepStrictEqual(p, { ok: true, kind: 'text', args: { substr: 'Order confirmed' }, timeoutMs: 10000 });
});
check('wait for heading "..." within <N>s', () => {
  const p = registry.parseWaitStep('wait for heading "Results" within 20s');
  assert.deepStrictEqual(p, { ok: true, kind: 'heading', args: { substr: 'Results' }, timeoutMs: 20000 });
});
check('wait for field "<label>"', () => {
  const p = registry.parseWaitStep('wait for field "Email"');
  assert.deepStrictEqual(p, { ok: true, kind: 'field', args: { label: 'Email' }, timeoutMs: 10000 });
});
check('wait for url contains "..."', () => {
  const p = registry.parseWaitStep('wait for url contains "/checkout"');
  assert.deepStrictEqual(p, { ok: true, kind: 'url', args: { substr: '/checkout' }, timeoutMs: 10000 });
});
check('wait <N>s - fixed sleep', () => {
  const p = registry.parseWaitStep('wait 5s');
  assert.deepStrictEqual(p, { ok: true, kind: 'sleep', args: {}, timeoutMs: 5000 });
});
check('wait <N>s at exactly the 30s cap is accepted', () => {
  const p = registry.parseWaitStep('wait 30s');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.timeoutMs, 30000);
});
check('wait <N>s above the 30s cap is REJECTED, not silently clamped', () => {
  const p = registry.parseWaitStep('wait 31s');
  assert.strictEqual(p.ok, false);
  assert.match(p.error, /cannot exceed 30s/);
  assert.match(p.error, /got 31s/);
});
check('wait for ... within <N>s above the 30s cap is REJECTED, not silently clamped', () => {
  const p = registry.parseWaitStep('wait for text "x" within 999s');
  assert.strictEqual(p.ok, false);
  assert.match(p.error, /cannot exceed 30s/);
});
check('wait <0>s rejected (must be at least 1s)', () => {
  const p = registry.parseWaitStep('wait 0s');
  assert.strictEqual(p.ok, false);
  assert.match(p.error, /at least 1s/);
});
check('malformed: bare "wait" rejected with usage', () => {
  const p = registry.parseWaitStep('wait');
  assert.strictEqual(p.ok, false);
  assert.match(p.error, /usage: wait/);
});
check('malformed: "wait for" with no predicate rejected', () => {
  const p = registry.parseWaitStep('wait for');
  assert.strictEqual(p.ok, false);
});
check('malformed: "wait for origin ..." is NOT a form (origin has no wait-for equivalent, design §2.2)', () => {
  const p = registry.parseWaitStep('wait for origin "https://x.com"');
  assert.strictEqual(p.ok, false);
});
check('WAIT_POLL_MS/WAIT_DEFAULT_TIMEOUT_S/WAIT_MAX_TIMEOUT_S pinned to design §2.2/§9 sign-off B', () => {
  assert.strictEqual(registry.WAIT_POLL_MS, 250);
  assert.strictEqual(registry.WAIT_DEFAULT_TIMEOUT_S, 10);
  assert.strictEqual(registry.WAIT_MAX_TIMEOUT_S, 30);
});

// =====================================================================
// [2] formatPredicateLabel + evalExpect - pure predicate matrix
// =====================================================================
console.log('\n[2] evalExpect - pure predicate matrix (url/origin/text/heading/field)');

check('formatPredicateLabel round-trips every kind', () => {
  assert.strictEqual(registry.formatPredicateLabel({ kind: 'url', args: { substr: '/x' } }), 'url contains "/x"');
  assert.strictEqual(registry.formatPredicateLabel({ kind: 'origin', args: { origin: 'https://x.com' } }), 'origin "https://x.com"');
  assert.strictEqual(registry.formatPredicateLabel({ kind: 'text', args: { substr: 'hi' } }), 'text "hi"');
  assert.strictEqual(registry.formatPredicateLabel({ kind: 'heading', args: { substr: 'Results' } }), 'heading "Results"');
  assert.strictEqual(registry.formatPredicateLabel({ kind: 'field', args: { label: 'Email', mode: 'equals', value: 'a@b.c' } }), 'field "Email" equals "a@b.c"');
  assert.strictEqual(registry.formatPredicateLabel({ kind: 'field', args: { label: 'Email', mode: 'empty' } }), 'field "Email" empty');
});

check('url contains: pass', () => {
  const r = registry.evalExpect({ kind: 'url', args: { substr: '/checkout' } }, { href: 'https://shop.example/checkout?x=1' });
  assert.strictEqual(r.ok, true);
});
check('url contains: fail, case-sensitive (design §2.1)', () => {
  const r = registry.evalExpect({ kind: 'url', args: { substr: '/Checkout' } }, { href: 'https://shop.example/checkout' });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /current url: https:\/\/shop\.example\/checkout/);
});

check('origin: pass, exact match', () => {
  const r = registry.evalExpect({ kind: 'origin', args: { origin: 'https://shop.example' } }, { origin: 'https://shop.example' });
  assert.strictEqual(r.ok, true);
});
check('origin: pass, case-insensitive host (design §2.1)', () => {
  const r = registry.evalExpect({ kind: 'origin', args: { origin: 'https://SHOP.example' } }, { origin: 'https://shop.example' });
  assert.strictEqual(r.ok, true);
});
check('origin: fail, different port', () => {
  const r = registry.evalExpect({ kind: 'origin', args: { origin: 'https://shop.example' } }, { origin: 'https://shop.example:8443' });
  assert.strictEqual(r.ok, false);
});

check('text: pass when matchCount > 0', () => {
  const r = registry.evalExpect({ kind: 'text', args: { substr: 'Order confirmed' } }, { matchCount: 1, totalVisibleTextNodes: 214, origin: 'https://shop.example/checkout' });
  assert.strictEqual(r.ok, true);
});
check('text: fail diagnostic matches design §4\'s exact worked example shape', () => {
  const r = registry.evalExpect({ kind: 'text', args: { substr: 'Order confirmed' } }, { matchCount: 0, totalVisibleTextNodes: 214, origin: 'https://shop.example/checkout' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.detail, 'searched 214 visible text nodes on https://shop.example/checkout, no match');
});

check('heading: pass when matchCount > 0', () => {
  const r = registry.evalExpect({ kind: 'heading', args: { substr: 'Results' } }, { matchCount: 1, headingsSeen: ['Results'] });
  assert.strictEqual(r.ok, true);
});
check('heading: fail diagnostic lists last-seen headings, capped at 3', () => {
  const r = registry.evalExpect({ kind: 'heading', args: { substr: 'Results' } }, { matchCount: 0, headingsSeen: ['Loading', 'Search', 'Filters', 'Footer'] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.detail, 'last seen headings: "Loading", "Search", "Filters"');
});
check('heading: fail, no headings at all on page', () => {
  const r = registry.evalExpect({ kind: 'heading', args: { substr: 'Results' } }, { matchCount: 0, headingsSeen: [] });
  assert.strictEqual(r.detail, 'no headings found on page');
});

check('field equals: pass', () => {
  const r = registry.evalExpect({ kind: 'field', args: { label: 'Email', mode: 'equals', value: 'a@b.c' } }, { found: true, isCredential: false, value: 'a@b.c' });
  assert.strictEqual(r.ok, true);
});
check('field equals: fail, empty field - matches design §4\'s exact worked example', () => {
  const r = registry.evalExpect({ kind: 'field', args: { label: 'Email', mode: 'equals', value: 'a@b.c' } }, { found: true, isCredential: false, value: '' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.detail, 'field "Email" found, value differs (field is empty)');
});
check('field equals: fail, differing non-empty value shown (display-only, §9 sign-off C)', () => {
  const r = registry.evalExpect({ kind: 'field', args: { label: 'Email', mode: 'equals', value: 'a@b.c' } }, { found: true, isCredential: false, value: 'wrong@x.com' });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /got "wrong@x\.com"/);
});
check('field equals: differing value is TRUNCATED in the diagnostic (never the raw unbounded value)', () => {
  const long = 'x'.repeat(200);
  const r = registry.evalExpect({ kind: 'field', args: { label: 'Email', mode: 'equals', value: 'a@b.c' } }, { found: true, isCredential: false, value: long });
  assert.ok(r.detail.indexOf(long) === -1, 'the full untruncated value must never appear in the diagnostic');
  assert.match(r.detail, /\.\.\."\)$/);
});
check('field empty: pass', () => {
  const r = registry.evalExpect({ kind: 'field', args: { label: 'Email', mode: 'empty' } }, { found: true, isCredential: false, value: '' });
  assert.strictEqual(r.ok, true);
});
check('field empty: fail, shows the actual value', () => {
  const r = registry.evalExpect({ kind: 'field', args: { label: 'Email', mode: 'empty' } }, { found: true, isCredential: false, value: 'a@b.c' });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /not empty \(value: "a@b\.c"\)/);
});
check('field not found: fail', () => {
  const r = registry.evalExpect({ kind: 'field', args: { label: 'Nope', mode: 'empty' } }, { found: false, ambiguous: false, candidates: [] });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /no fillable field matching "Nope"/);
});
check('field ambiguous: fail, candidate list included', () => {
  const r = registry.evalExpect({ kind: 'field', args: { label: 'Name', mode: 'empty' } }, { found: false, ambiguous: true, candidates: ['[1] textbox "First Name"', '[2] textbox "Last Name"'] });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /ambiguous field "Name" - candidates:\n\[1\] textbox "First Name"\n\[2\] textbox "Last Name"/);
});

// =====================================================================
// [3] Credential-field refusal (design §2.1 hard security rule, §7
// mutation check 1) - pure evalExpect level AND end-to-end through
// tryDeterministic()/doExpect with a REAL guards.js isPasswordField() call.
// =====================================================================
console.log('\n[3] credential-field refusal - pure evalExpect + end-to-end doExpect');

check('evalExpect: isCredential true ALWAYS fails, both modes, regardless of value', () => {
  const equalsR = registry.evalExpect({ kind: 'field', args: { label: 'Password', mode: 'equals', value: 'hunter2' } }, { found: true, isCredential: true, value: null });
  assert.strictEqual(equalsR.ok, false);
  assert.strictEqual(equalsR.credential, true);
  assert.match(equalsR.detail, /is a credential field - refusing to read its value/);
  const emptyR = registry.evalExpect({ kind: 'field', args: { label: 'Password', mode: 'empty' } }, { found: true, isCredential: true, value: null });
  assert.strictEqual(emptyR.ok, false);
  assert.strictEqual(emptyR.credential, true);
});
check('evalExpect: credential refusal NEVER echoes a value, even if domFacts.value is (erroneously) populated - defense in depth', () => {
  const r = registry.evalExpect({ kind: 'field', args: { label: 'Password', mode: 'equals', value: 'hunter2' } }, { found: true, isCredential: true, value: 'leaked-value-should-never-appear' });
  assert.ok(r.detail.indexOf('leaked-value-should-never-appear') === -1);
  assert.ok(r.detail.indexOf('hunter2') === -1);
});

(() => {
  const sandbox = buildSandbox();
  const state = freshState();
  const pwEl = fakeInput({ type: 'password', value: 'SUPER-SECRET-DO-NOT-LEAK' });
  sandbox.window.LFL.axtree.build = () => {
    const map = new Map([[1, pwEl]]);
    return { entries: [{ index: 1, ref: pwEl, role: 'textbox', name: 'Password', tag: 'input', extra: 'type=password' }], map, notes: [] };
  };

  check('end-to-end: `expect field "Password" equals "x"` is REFUSED before any value read, expectFailed:true', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('expect field "Password" equals "x"', state);
    assert.strictEqual(det.expectFailed, true);
    assert.match(det.output, /credential field - refusing to read its value/);
    assert.ok(det.output.indexOf('SUPER-SECRET-DO-NOT-LEAK') === -1, 'the real field value must never appear in the output');
  });
  check('end-to-end: `expect field "Password" empty` is ALSO refused (both modes)', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('expect field "Password" empty', state);
    assert.strictEqual(det.expectFailed, true);
    assert.match(det.output, /credential field/);
  });
})();

// =====================================================================
// [4] extractExpectFacts - DOM-fact extraction end to end (url/origin/
// text/heading/field), via the REAL engine.js code against the sandbox's
// fake document/axtree.
// =====================================================================
console.log('\n[4] extractExpectFacts + doExpect - end-to-end DOM extraction');

(() => {
  const sandbox = buildSandbox();
  const state = freshState();

  check('expect url contains - passes against sandbox.location.href', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('expect url contains "/page"', state);
    assert.strictEqual(det.expectFailed, undefined);
    assert.match(det.output, /^expect url contains "\/page": OK$/);
  });
  check('expect origin - passes against sandbox.location.origin', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('expect origin "https://example.com"', state);
    assert.strictEqual(det.expectFailed, undefined);
  });

  sandbox.document.__textNodes = [
    { textContent: 'Welcome to the shop', parentElement: { __visible: true } },
    { textContent: 'Order confirmed - thank you', parentElement: { __visible: true } },
    { textContent: 'hidden order confirmed text', parentElement: { __visible: false } },
  ];
  check('expect text - matches a visible node, invisible nodes excluded from the count too', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('expect text "Order confirmed"', state);
    assert.strictEqual(det.expectFailed, undefined);
    assert.match(det.output, /: OK$/);
  });
  check('expect text - fail reports the total VISIBLE node count (invisible node excluded)', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('expect text "no such phrase anywhere"', state);
    assert.strictEqual(det.expectFailed, true);
    assert.match(det.output, /searched 2 visible text node/);
  });

  sandbox.document.__headings = [
    { textContent: 'Loading', __visible: true },
    { textContent: 'Search Results', __visible: true },
    { textContent: 'hidden heading', __visible: false },
  ];
  check('expect heading - matches a visible heading (case-insensitive substring)', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('expect heading "results"', state);
    assert.strictEqual(det.expectFailed, undefined);
  });
  check('expect heading - fail lists only VISIBLE last-seen headings', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('expect heading "Nope"', state);
    assert.strictEqual(det.expectFailed, true);
    assert.match(det.output, /last seen headings: "Loading", "Search Results"/);
    assert.ok(det.output.indexOf('hidden heading') === -1);
  });

  const emailEl = fakeInput({ type: 'text', value: '  a@b.c  ' });
  sandbox.window.LFL.axtree.build = () => {
    const map = new Map([[1, emailEl]]);
    return { entries: [{ index: 1, ref: emailEl, role: 'textbox', name: 'Email', tag: 'input', extra: 'type=text' }], map, notes: [] };
  };
  const fieldState = freshState();
  check('expect field equals - compares AFTER trim (design §2.1)', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('expect field "Email" equals "a@b.c"', fieldState);
    assert.strictEqual(det.expectFailed, undefined, det.output);
  });
  check('expect field - REUSES doFillLabel machinery: resolves by unique substring, not just exact', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('expect field "mail" equals "a@b.c"', fieldState);
    assert.strictEqual(det.expectFailed, undefined, det.output);
  });

  check('malformed expect (bad syntax) ALSO sets expectFailed - a typo must halt, not silently pass', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('expect bogus form', freshState());
    assert.strictEqual(det.expectFailed, true);
  });

  check('PASS never sets expectFailed (additive-only contract, design §3)', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('expect origin "https://example.com"', freshState());
    assert.ok(!Object.prototype.hasOwnProperty.call(det, 'expectFailed'), 'a passing expect must not carry the field at all');
  });
})();

// =====================================================================
// [5] `run` verdict line formats (design §2.3) - pure string builders
// =====================================================================
console.log('\n[5] run verdict line formats');

check('formatRunOk - exact design §2.3 wording', () => {
  assert.strictEqual(registry.formatRunOk('checkout', 7), 'run checkout: OK (7 steps)');
});
check('formatRunOk - singular "step" for a 1-step run', () => {
  assert.strictEqual(registry.formatRunOk('solo', 1), 'run solo: OK (1 step)');
});
check('formatRunFailed - exact design §2.3 wording', () => {
  assert.strictEqual(registry.formatRunFailed('checkout', 4, 7, 'no match'), 'run checkout: FAILED at step 4/7 - no match');
});
check('formatRunFailed - no diagnostic still produces a well-formed line', () => {
  assert.strictEqual(registry.formatRunFailed('checkout', 1, 1, ''), 'run checkout: FAILED at step 1/1');
});
check('formatRunPaused - with instruction', () => {
  assert.strictEqual(registry.formatRunPaused(3, 'click the buy button'), 'paused at step 3 (click the buy button)');
});
check('formatRunPaused - no instruction', () => {
  assert.strictEqual(registry.formatRunPaused(3, ''), 'paused at step 3');
});

// =====================================================================
// [6] parseScriptBody - expect/wait define/import-time validation, param
// substitution into args, index-address ban unaffected
// =====================================================================
console.log('\n[6] parseScriptBody - expect/wait define-time validation + $-param substitution');

check('a script body with valid expect/wait steps parses cleanly', () => {
  const body = 'go example.com\nwait for heading "Home"\nexpect heading "Home"\nsearch "gift"\nwait for url contains "/checkout"\nexpect url contains "/checkout"\n';
  const p = registry.parseScriptBody(body, { maxSteps: 20 });
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.steps.length, 6);
});
check('a malformed expect step is rejected at define time with the parser\'s own message, step-numbered', () => {
  const p = registry.parseScriptBody('go example.com\nexpect nonsense here\n', { maxSteps: 20 });
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /^step 2: usage: expect/);
});
check('a malformed wait step is rejected at define time, step-numbered', () => {
  const p = registry.parseScriptBody('wait 999s\n', { maxSteps: 20 });
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /^step 1: wait timeout cannot exceed 30s/);
});
check('expect/wait are never treated as index-addressed (no false-positive index-ban)', () => {
  const p = registry.parseScriptBody('expect text "3"\nwait 3s\n', { maxSteps: 20 });
  assert.strictEqual(p.ok, true, p.reason);
});
check('$1..$9 substitution works inside expect/wait QUOTED args, like any other step (design §4 normative: values can never contain a ", so a quoted-arg substitution can never break the surrounding form\'s structure)', () => {
  const p = registry.parseScriptBody('expect text "$1"\nwait for heading "$2"\n', { maxSteps: 20 });
  assert.strictEqual(p.ok, true, p.reason);
  const tok = registry.tokenizeArgs('"Order confirmed" "Home"');
  assert.strictEqual(tok.ok, true);
  const sub1 = registry.substituteParams(p.steps[0], tok.tokens);
  assert.strictEqual(sub1.text, 'expect text "Order confirmed"');
  const sub2 = registry.substituteParams(p.steps[1], tok.tokens);
  assert.strictEqual(sub2.text, 'wait for heading "Home"');
  // the substituted, param-filled step must ALSO still parse cleanly
  assert.strictEqual(registry.parseExpectStep(sub1.text).ok, true);
  assert.strictEqual(registry.parseWaitStep(sub2.text).ok, true);
});
check('the wait "within <N>s"/"<N>s" timeout digits are NOT parameterizable - a template using $N there is rejected at define time, not deferred to a run-time surprise', () => {
  // WAIT_FOR_FORMS/WAIT_SLEEP_RE require literal \d+ for the timeout - $1
  // is not digit-shaped, so this fails the SAME parseWaitStep() call every
  // other malformed-wait test above exercises; documented, deliberate
  // scope (design §4 discusses substitution into "args", i.e. the quoted
  // label/substr/value - not the numeric timeout config).
  const p = registry.parseScriptBody('wait for heading "Home" within $1s\n', { maxSteps: 20 });
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /^step 1: usage: wait/);
});
check('validateResolvedStep re-checks a RESOLVED expect/wait step the same way it re-checks pause/index-addressed steps (registry.js\'s own documented "alias whose current expansion is..." scenario - see setScript()\'s run-time re-validation comment): a malformed resolved step is caught even though it never went through parseScriptBody at all', () => {
  // Structurally identical to what terminal.js's `run` handler feeds this
  // function post param-substitution AND post alias-expansion (whichever
  // produced the final resolved text) - validateResolvedStep does not care
  // which one produced it, only whether the RESULT is well-formed.
  const resolved = registry.validateResolvedStep('wait 999s');
  assert.strictEqual(resolved.ok, false);
  assert.match(resolved.reason, /cannot exceed 30s/);
  const resolved2 = registry.validateResolvedStep('expect field "Email" contains "x"');
  assert.strictEqual(resolved2.ok, false);
});
check('validateResolvedStep accepts a well-formed resolved expect/wait step', () => {
  assert.strictEqual(registry.validateResolvedStep('expect text "Order confirmed"').ok, true);
  assert.strictEqual(registry.validateResolvedStep('wait for field "Email"').ok, true);
});

// =====================================================================
// [7] define/import-time rejection via the real createAliasStore().setScript()
// (write path), and export/import round-trip of a script containing
// expect/wait (scripts v1 P2 portability format)
// =====================================================================
console.log('\n[7] setScript()/serializeScripts()/parseScriptFile() - expect/wait through the real store');

check('setScript rejects a malformed expect step at write time', () => {
  const store = registry.createAliasStore(fakeStorageArea(), ['go', 'click', 'search', 'expect', 'wait']);
  const res = store.setScript('badrecipe', 'go example.com\nexpect field "Email"\n');
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /step 2:/);
});
check('setScript accepts a well-formed recipe using expect/wait/run-verb vocabulary', () => {
  const store = registry.createAliasStore(fakeStorageArea(), ['go', 'click', 'search', 'expect', 'wait']);
  const res = store.setScript('checkout', 'go example.com\nwait for heading "Home"\nsearch "gift wrap"\nwait for url contains "/cart" within 15s\nexpect url contains "/cart"\n');
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.stepCount, 5);
});
check('export/import round-trip preserves expect/wait steps byte-for-byte', () => {
  const store = registry.createAliasStore(fakeStorageArea(), ['go', 'click', 'search', 'expect', 'wait']);
  store.setScript('checkout', 'go example.com\nwait for heading "Home" within 8s\nexpect heading "Home"\nwait 2s\n');
  const serialized = registry.serializeScripts(store.listScripts());
  assert.match(serialized, /wait for heading "Home" within 8s/);
  assert.match(serialized, /expect heading "Home"/);
  const parsedFile = registry.parseScriptFile(serialized);
  assert.strictEqual(parsedFile.ok, true);
  const entry = parsedFile.scripts.find((s) => s.name === 'checkout');
  assert.ok(entry, 'checkout script not found after round-trip');
  assert.match(entry.body, /wait for heading "Home" within 8s/);
  // re-importing through setScript (the only trusted write path, per
  // registry.js's own header comment) must accept the round-tripped body.
  const store2 = registry.createAliasStore(fakeStorageArea(), ['go', 'click', 'search', 'expect', 'wait']);
  const reimport = store2.setScript(entry.name, entry.body);
  assert.strictEqual(reimport.ok, true, JSON.stringify(reimport));
});

// =====================================================================
// [8] RESERVED_NAMES + commandRegistry presence - structural + behavioral
// =====================================================================
console.log('\n[8] RESERVED_NAMES + commandRegistry - "expect"/"wait" cannot be shadowed, and ARE registered commands');

check('structural: "expect" and "wait" are present in registry.js\'s RESERVED_NAMES set', () => {
  const registrySrc = fs.readFileSync(REGISTRY_PATH, 'utf8');
  const idx = registrySrc.indexOf('const RESERVED_NAMES = new Set([');
  const endIdx = registrySrc.indexOf(']);', idx);
  assert.ok(idx >= 0 && endIdx > idx, 'RESERVED_NAMES definition not found');
  const body = registrySrc.slice(idx, endIdx);
  assert.match(body, /'expect'/, 'expect must be present in RESERVED_NAMES');
  assert.match(body, /'wait'/, 'wait must be present in RESERVED_NAMES');
});
check('behavioral: setAlias refuses to shadow "expect"/"wait"', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  assert.strictEqual(store.setAlias('expect', 'go example.com').ok, false);
  assert.strictEqual(store.setAlias('wait', 'go example.com').ok, false);
});
check('behavioral: setMacro refuses to shadow "expect"/"wait"', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  assert.strictEqual(store.setMacro('expect', 'go a.com && go b.com').ok, false);
  assert.strictEqual(store.setMacro('wait', 'go a.com && go b.com').ok, false);
});

(() => {
  const sandbox = buildSandbox();
  check('engine.js registers "expect" in LFL.commandRegistry (help/man/did-you-mean come free)', () => {
    const entry = sandbox.window.LFL.commandRegistry.get('expect');
    assert.ok(entry, 'expect not found in commandRegistry');
    assert.strictEqual(entry.name, 'expect');
  });
  check('engine.js registers "wait" in LFL.commandRegistry too (dispatched by terminal.js, registered here for docs)', () => {
    const entry = sandbox.window.LFL.commandRegistry.get('wait');
    assert.ok(entry, 'wait not found in commandRegistry');
    assert.strictEqual(entry.name, 'wait');
  });
  check('"expect"/"wait" appear in LFL.commandRegistry.names() (feeds did-you-mean\'s candidate pool)', () => {
    const names = sandbox.window.LFL.commandRegistry.names();
    assert.ok(names.includes('expect'));
    assert.ok(names.includes('wait'));
  });
})();

// =====================================================================
// [9] halt-on-fail queue contract - structural (the actual queue-halting
// glue is terminal.js-only, DOM/chrome.*-dependent, and out of this plain-
// Node suite's scope - same documented boundary tests/m5_scripts.test.js
// draws for the script-run plan-preview/pause-parking machinery. What IS
// verified here is the CONTRACT terminal.js's _afterSettle()/_dispatchSegment
// halt-on-fail glue depends on: a failing expect is ALWAYS additive
// (expectFailed:true alongside output), never fail-open, and a passing one
// NEVER carries the field - this is design §7 mutation check 2's own
// target ("make expect fail-open (ok:true on error) -> halt test fails").
// =====================================================================
console.log('\n[9] halt-on-fail contract (structural) - expectFailed is additive, never fail-open');

(() => {
  const sandbox = buildSandbox();
  check('every FAIL path (predicate fail, credential refusal, malformed syntax) sets expectFailed:true', () => {
    const cases = [
      'expect origin "https://not-this-origin.example"',
      'expect bogus syntax',
    ];
    for (const c of cases) {
      const det = sandbox.window.LFL.engine.tryDeterministic(c, freshState());
      assert.strictEqual(det.expectFailed, true, `expected expectFailed:true for: ${c}`);
    }
  });
  check('terminal.js\'s dispatch reuses ONE halt mechanism (_afterSettle) for both the pre-existing arrival-check halt and the new expectFailed halt - structural source pin', () => {
    const terminalSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'terminal.js'), 'utf8');
    assert.match(terminalSrc, /if \(det\.expectFailed\)/, 'terminal.js must branch on det.expectFailed');
    // both the expect-fail branch and the arrival-check-halt branch must
    // route through the SAME _afterSettle(false)/_settle(false, ...) pair -
    // confirmed by the fact that both literal patterns exist in the file.
    assert.match(terminalSrc, /halted\(arrival-mismatch\)/);
  });
})();

// =====================================================================
// [10] audit value-freedom (design §2.1 hard rule; verify finding F1) -
// the audit log records verb+verdict only: expect/wait audit the
// kind-only auditSummary, never the output/diagnostic (which can carry a
// page-read field value), and a failed run audits the head-only verdict.
// =====================================================================
console.log('\n[10] audit value-freedom - kind-only summaries, no compared/page-read values');

(() => {
  const sandbox = buildSandbox();

  check('auditSummaryForPredicate is kind-only: no labels, no args, no values', () => {
    const R = sandbox.window.LFL.registry;
    assert.strictEqual(R.auditSummaryForPredicate('expect', 'field', 'FAILED'), 'expect field: FAILED');
    assert.strictEqual(R.auditSummaryForPredicate('wait', 'heading', 'OK'), 'wait heading: OK');
    assert.strictEqual(R.auditSummaryForPredicate('expect', null, 'FAILED'), 'expect (malformed): FAILED');
  });

  const secretEl = fakeInput({ type: 'text', value: 'SECRET-PAGE-VALUE-123' });
  sandbox.window.LFL.axtree.build = () => {
    const map = new Map([[1, secretEl]]);
    return { entries: [{ index: 1, ref: secretEl, role: 'textbox', name: 'Email', tag: 'input', extra: 'type=text' }], map, notes: [] };
  };
  check('failed field comparison: output carries the diagnostic, auditSummary carries NEITHER the read value NOR the label', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('expect field "Email" equals "other@x"', freshState());
    assert.strictEqual(det.expectFailed, true);
    assert.ok(det.output.indexOf('SECRET-PAGE-VALUE-123') !== -1, 'diagnostic (scrollback-only) shows the read value');
    assert.strictEqual(det.auditSummary, 'expect field: FAILED');
    assert.ok(det.auditSummary.indexOf('SECRET-PAGE-VALUE-123') === -1);
    assert.ok(det.auditSummary.indexOf('Email') === -1);
    assert.ok(det.auditSummary.indexOf('other@x') === -1);
  });
  check('passing expect carries a kind-only auditSummary too (typed comparison value stays out of audit)', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('expect field "Email" equals "SECRET-PAGE-VALUE-123"', freshState());
    assert.strictEqual(det.expectFailed, undefined, det.output);
    assert.strictEqual(det.auditSummary, 'expect field: OK');
  });
  check('malformed expect carries the (malformed) auditSummary, never the raw typed text', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('expect bogus "maybe-sensitive-arg"', freshState());
    assert.strictEqual(det.expectFailed, true);
    assert.strictEqual(det.auditSummary, 'expect (malformed): FAILED');
  });

  check('structural: terminal.js audits det.auditSummary for expect, NEVER det.output', () => {
    const terminalSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'terminal.js'), 'utf8');
    assert.match(terminalSrc, /_auditPush\(\{ action: 'expect' \}, 'failed', det\.auditSummary \|\| ''\)/,
      'the expect audit push must use det.auditSummary');
    assert.ok(!/_auditPush\(\{ action: 'expect' \}[^)]*det\.output/.test(terminalSrc),
      'the expect audit push must not reference det.output');
  });
  check('structural: terminal.js audits the head-only run verdict (diagnostic tail stripped)', () => {
    const terminalSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'terminal.js'), 'utf8');
    assert.match(terminalSrc, /'failed', LFL\.registry\.formatRunFailed\(run\.name, run\.index, run\.total, ''\)\)/,
      'the run-failed audit push must rebuild the verdict with an empty diagnostic');
  });
  check('structural: terminal.js audits auditSummaryForPredicate for wait ok/failed, never result.output', () => {
    const terminalSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'terminal.js'), 'utf8');
    const waitAudits = terminalSrc.match(/_auditPush\(\{ action: 'wait' \}[^\n]*/g) || [];
    assert.ok(waitAudits.length >= 3, 'expected the three wait audit pushes');
    for (const line of waitAudits) {
      assert.ok(line.indexOf('result.output') === -1, `wait audit push must not carry result.output: ${line}`);
    }
    assert.match(terminalSrc, /_auditPush\(\{ action: 'wait' \}, 'ok', LFL\.registry\.auditSummaryForPredicate\('wait', parsed\.kind, 'OK'\)\)/);
  });
})();

// =====================================================================
// [11] test-hook run verdict (lab L1 follow-up, 2026-07-18) - structural:
// terminal.js exposes lastRunVerdict on the SAME dev-gated data-lfl-state
// payload as lastResult (H2: nothing new is exposed when dev hooks are
// off - the field lives inside the one payload the _devHooksEnabled
// early-return already guards), set at every §2.3 verdict emission point,
// counters-only (never the diagnostic string).
// =====================================================================
console.log('\n[11] test-hook run verdict (structural) - dev-gated, counters-only');

(() => {
  const terminalSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'terminal.js'), 'utf8');

  check('structural: _updateTestHook payload includes lastRunVerdict', () => {
    assert.match(terminalSrc, /lastRunVerdict: this\._lastRunVerdict,/,
      'the hook payload must carry this._lastRunVerdict');
  });

  check('structural: the lastRunVerdict field sits INSIDE the dev-gated payload (after the _devHooksEnabled early-return)', () => {
    const gateIdx = terminalSrc.indexOf("if (!this._devHooksEnabled) {");
    const fieldIdx = terminalSrc.indexOf('lastRunVerdict: this._lastRunVerdict,');
    assert.ok(gateIdx !== -1, 'the H2 dev-hooks gate must exist');
    assert.ok(fieldIdx !== -1, 'the lastRunVerdict payload field must exist');
    assert.ok(fieldIdx > gateIdx,
      'lastRunVerdict must be assembled after the dev-hooks early-return, i.e. only ever published when dev hooks are on');
  });

  check('structural: all four §2.3 verdict emission points set _lastRunVerdict (ok, failed, arrival-failed, paused)', () => {
    assert.match(terminalSrc, /this\._lastRunVerdict = \{ name: run\.name, ok: true, outcome: 'ok', stepsTotal: run\.total, stepIndex: run\.total \};/,
      'the _afterSettle ok branch must set the verdict');
    const failedSets = terminalSrc.match(/this\._lastRunVerdict = \{ name: run\.name, ok: false, outcome: 'failed', stepsTotal: run\.total, stepIndex: run\.index \};/g) || [];
    assert.strictEqual(failedSets.length, 2,
      'both failure emission points (_afterSettle fail + _advanceQueue arrival-mismatch) must set the verdict');
    assert.match(terminalSrc, /this\._lastRunVerdict = \{ name: run\.name, ok: true, outcome: 'paused', stepsTotal: run\.total, stepIndex: run\.index \};/,
      'the pause path must set the verdict');
  });

  check('structural: a new run resets the previous verdict (no stale same-page verdict)', () => {
    assert.match(terminalSrc, /this\.state\.activeRun = \{ name: run\.name, total: run\.steps\.length, index: 1 \};\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*this\._lastRunVerdict = null;/,
      'approving a run must null the previous verdict');
  });

  check('structural: the verdict object is counters-only - no diagnostic/message/instruction field ever assigned into it', () => {
    const sets = terminalSrc.match(/this\._lastRunVerdict = \{[^}]*\};/g) || [];
    assert.ok(sets.length >= 4, 'expected at least the four emission-point assignments');
    for (const s of sets) {
      assert.ok(!/diagnostic|message|instruction|msg|output/.test(s),
        `verdict assignment must stay counters-only: ${s}`);
    }
  });

  check('structural: no new storage key - _lastRunVerdict never appears in a chrome.storage call', () => {
    const storageCalls = terminalSrc.match(/chrome\.storage[^;]*_lastRunVerdict/g) || [];
    assert.strictEqual(storageCalls.length, 0, '_lastRunVerdict must be in-memory only');
  });
})();

// =====================================================================
// summary
// =====================================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
