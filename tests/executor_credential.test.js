#!/usr/bin/env node
/**
 * tests/executor_credential.test.js — direct unit-level proof of the
 * credential hard block and the click-target guard in executor.js,
 * bypassing the model AND the UI entirely.
 *
 * Written to close MUST-FIX #3 in the 2026-07 security review: the README
 * and docs/threat-model.md both claimed this test existed. It did not. This
 * file is that test.
 *
 * How it works: executor.js and guards.js are plain browser-global scripts
 * (`window.LFL = window.LFL || {}` at module scope) — not requireable as-is
 * under plain Node. Rather than add jsdom (out of scope per the task's own
 * environment notes — no npm install), this test uses Node's built-in `vm`
 * module to run the REAL, UNMODIFIED source of guards.js and executor.js
 * inside a minimal sandbox object that plays the role of `window`:
 *   - `window` self-references the sandbox (so the bare `window` identifier
 *     the extension code uses resolves correctly).
 *   - `window.HTMLInputElement` / `HTMLTextAreaElement` are empty
 *     constructors with no `value` property descriptor, so executor.js's
 *     fillNative() takes its documented plain `el.value = value` fallback
 *     path instead of the real-DOM property-descriptor trick.
 *   - `window.LFL.axtree.resolve` is stubbed to `(map, idx) => map.get(idx)`
 *     — a direct Map lookup instead of axtree.js's real WeakRef+visibility
 *     re-check (axtree.js's own resolve() logic is exercised by the
 *     Playwright battery against a real DOM, not by this unit test).
 * Everything else — isPasswordField, safeSameOriginHttpUrl,
 * resolveClickNavTarget, checkClickTarget, and execute() itself — is the
 * exact code shipped in extension/content/guards.js and
 * extension/content/executor.js. No reimplementation.
 *
 * Run: node tests/executor_credential.test.js
 * Exit code 0 = all assertions passed, nonzero = failure (prints which).
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const GUARDS_PATH = path.join(ROOT, 'extension', 'content', 'guards.js');
const EXECUTOR_PATH = path.join(ROOT, 'extension', 'content', 'executor.js');

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

// ---- build the sandbox and load the real extension source into it ----

function buildSandbox() {
  const sandbox = {};
  sandbox.window = sandbox; // bare `window` identifier resolves to the sandbox itself
  sandbox.HTMLInputElement = function HTMLInputElement() {};
  sandbox.HTMLTextAreaElement = function HTMLTextAreaElement() {};
  // Minimal Event stub: executor.js's select branch (and fillNative, when a
  // fake element provides dispatchEvent) constructs `new Event(type, opts)`
  // unconditionally — Node's vm contexts don't inherit the outer realm's
  // WHATWG globals, so this has to be supplied explicitly.
  sandbox.Event = function Event(type, opts) {
    this.type = type;
    Object.assign(this, opts || {});
  };
  // IMPORTANT: vm-created contexts get a fresh set of pure-ECMAScript
  // built-ins (Object, Array, Map, JSON, ...) but do NOT inherit Node's own
  // WHATWG globals — `URL` is one of those. Without this, `new URL(...)`
  // inside guards.js would throw ReferenceError, which its own try/catch
  // would silently swallow as a generic "unparseable URL" — masking real
  // parsing/origin-comparison bugs behind a result that happens to still be
  // `blocked` (fail-safe direction) but for the wrong, misleading reason.
  // Reusing Node's own URL class across the vm/outer-realm boundary is safe
  // here: guards.js only ever calls plain property getters (.protocol,
  // .origin, .href) on the instances it creates, never `instanceof URL`.
  sandbox.URL = URL;
  vm.createContext(sandbox);

  const guardsSrc = fs.readFileSync(GUARDS_PATH, 'utf8');
  vm.runInContext(guardsSrc, sandbox, { filename: 'guards.js' });
  assert.strictEqual(typeof sandbox.window.LFL, 'object', 'guards.js did not set window.LFL');
  assert.strictEqual(typeof sandbox.window.LFL.guards, 'object', 'guards.js did not set window.LFL.guards');

  // Stub axtree.resolve: direct Map lookup. execute() only calls
  // LFL.axtree.resolve(elementMap, index); the real implementation's
  // WeakRef/visibility logic lives in axtree.js and is out of scope here.
  sandbox.window.LFL.axtree = { resolve: (map, idx) => map.get(idx) };

  const executorSrc = fs.readFileSync(EXECUTOR_PATH, 'utf8');
  vm.runInContext(executorSrc, sandbox, { filename: 'executor.js' });
  assert.strictEqual(typeof sandbox.window.LFL.executor.execute, 'function', 'executor.js did not set window.LFL.executor.execute');

  return sandbox;
}

// ---- fake element factory ----
// Minimal element shape: tagName, getAttribute/hasAttribute reading a plain
// attrs object, isContentEditable, a plain settable .value, and (for anchors)
// closest()/click() so the click-target guard tests can exercise real
// ancestor-walking and detect whether el.click() actually fired.

function fakeInput(attrs) {
  const el = {
    tagName: 'INPUT',
    isContentEditable: false,
    value: '',
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    dispatchEvent() { /* no-op stub — event delivery isn't under test here */ },
  };
  return el;
}

function fakeAnchor(href, { ancestorOf } = {}) {
  const clicked = { count: 0 };
  const el = {
    tagName: 'A',
    _href: href, // mutable — read live by getAttribute below, for the TOCTOU probe
    getAttribute(name) { return name === 'href' ? this._href : null; },
    hasAttribute(name) { return name === 'href'; },
    closest(sel) {
      // Only the 'a[href]' selector is used by guards.js — good enough here.
      if (sel === 'a[href]') return this;
      return null;
    },
    click() { clicked.count += 1; },
    dispatchEvent() {},
  };
  el.__clicked = clicked;
  if (ancestorOf) {
    ancestorOf.closest = (sel) => (sel === 'a[href]' ? el : null);
    ancestorOf.__anchorClicked = clicked;
  }
  return el;
}

function fakePlainButton() {
  const clicked = { count: 0 };
  return {
    tagName: 'BUTTON',
    getAttribute() { return null; },
    hasAttribute() { return false; },
    closest() { return null; },
    click() { clicked.count += 1; },
    __clicked: clicked,
  };
}

// ---- fake element factories for the 2026-07-12 verifier follow-up:
// form-submit / <area> / SVG-<a> click-target resolution (guards.js
// resolveClickNavTarget()'s form-action, area, and svg-a branches). ----

function fakeForm(action) {
  return {
    tagName: 'FORM',
    action, // mirrors the real .action IDL property (absolute-resolved string)
    getAttribute(name) { return name === 'action' ? action : null; },
  };
}

// `type` undefined => no `type` attribute at all, i.e. a real <button>'s
// spec default-submit case — the exact gap the verifier found.
function fakeSubmitButton({ type, form, formaction } = {}) {
  const clicked = { count: 0 };
  const attrs = {};
  if (type !== undefined) attrs.type = type;
  if (formaction !== undefined) attrs.formaction = formaction;
  const el = {
    tagName: 'BUTTON',
    form: form || null,
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    closest(sel) { return sel === 'form' ? (form || null) : null; },
    click() { clicked.count += 1; },
    dispatchEvent() {},
  };
  el.__clicked = clicked;
  return el;
}

function fakeSubmitInput({ type, form }) {
  const clicked = { count: 0 };
  const el = {
    tagName: 'INPUT',
    form: form || null,
    getAttribute(name) { return name === 'type' ? type : null; },
    hasAttribute(name) { return name === 'type'; },
    closest(sel) { return sel === 'form' ? (form || null) : null; },
    click() { clicked.count += 1; },
    dispatchEvent() {},
  };
  el.__clicked = clicked;
  return el;
}

// <button type=button>, no form association at all — must stay ALLOWED
// (this is the "don't over-block every button" control case).
function fakeUnassociatedButton(type) {
  const clicked = { count: 0 };
  const el = {
    tagName: 'BUTTON',
    getAttribute(name) { return name === 'type' ? type : null; },
    hasAttribute(name) { return name === 'type'; },
    closest() { return null; },
    click() { clicked.count += 1; },
    dispatchEvent() {},
  };
  el.__clicked = clicked;
  return el;
}

function fakeArea(href) {
  const clicked = { count: 0 };
  const el = {
    tagName: 'AREA',
    getAttribute(name) { return name === 'href' ? href : null; },
    hasAttribute(name) { return name === 'href'; },
    closest() { return null; },
    click() { clicked.count += 1; },
    dispatchEvent() {},
  };
  el.__clicked = clicked;
  return el;
}

// SVGAElement shape: lowercase 'a' tagName, no plain `href` attribute (only
// `hasAttribute('href')` => false), target lives in `xlink:href` — read via
// getAttribute('xlink:href') since this fake (like a pre-SVG2 real SVGAElement)
// has no getAttributeNS implementation, exercising guards.js's fallback path.
function fakeSvgAnchor(xlinkHref) {
  const clicked = { count: 0 };
  const el = {
    tagName: 'a',
    getAttribute(name) { return name === 'xlink:href' ? xlinkHref : null; },
    hasAttribute() { return false; },
    closest(sel) { return sel === 'a' ? el : null; },
    click() { clicked.count += 1; },
    dispatchEvent() {},
  };
  el.__clicked = clicked;
  return el;
}

// =====================================================================
// Part 1 — MUST-FIX #3 / #4: the credential hard block, exercised via the
// REAL execute() function with a synthetic {action:'fill', value:'hunter2'}
// against four backing elements: (a) type=password, (b) autocomplete=
// current-password, (c) autocomplete=one-time-code, (d) a normal text field.
// =====================================================================

function testCredentialBlockViaExecute() {
  console.log('\n[1] credential hard block via execute() — MUST-FIX #3 / #4');
  const sandbox = buildSandbox();
  const execute = sandbox.window.LFL.executor.execute;

  const elements = {
    a_password_type: fakeInput({ type: 'password' }),
    b_current_password_autocomplete: fakeInput({ type: 'text', autocomplete: 'current-password' }),
    c_one_time_code_autocomplete: fakeInput({ type: 'text', autocomplete: 'one-time-code' }),
    d_normal_text_field: fakeInput({ type: 'text', name: 'q' }),
  };
  const map = new Map([
    [1, elements.a_password_type],
    [2, elements.b_current_password_autocomplete],
    [3, elements.c_one_time_code_autocomplete],
    [4, elements.d_normal_text_field],
  ]);

  const action = (idx) => ({ action: 'fill', element: idx, value: 'hunter2' });

  const rA = execute(action(1), map);
  check('(a) type=password -> fill REFUSED', () => {
    assert.strictEqual(rA.ok, false, `expected ok:false, got ${JSON.stringify(rA)}`);
    assert.match(rA.message, /credentials never go through the model/);
    assert.strictEqual(elements.a_password_type.value, '', 'password field value must remain empty');
  });

  const rB = execute(action(2), map);
  check('(b) autocomplete=current-password -> fill REFUSED', () => {
    assert.strictEqual(rB.ok, false, `expected ok:false, got ${JSON.stringify(rB)}`);
    assert.match(rB.message, /credentials never go through the model/);
    assert.strictEqual(elements.b_current_password_autocomplete.value, '');
  });

  const rC = execute(action(3), map);
  check('(c) autocomplete=one-time-code -> fill REFUSED (MUST-FIX #4, OTP scope)', () => {
    assert.strictEqual(rC.ok, false, `expected ok:false, got ${JSON.stringify(rC)}`);
    assert.match(rC.message, /credentials never go through the model/);
    assert.strictEqual(elements.c_one_time_code_autocomplete.value, '');
  });

  const rD = execute(action(4), map);
  check('(d) normal text field -> fill ALLOWED', () => {
    assert.strictEqual(rD.ok, true, `expected ok:true, got ${JSON.stringify(rD)}`);
    assert.strictEqual(elements.d_normal_text_field.value, 'hunter2', 'normal field should actually receive the value');
  });

  // select uses the same guard — prove it's not fill-only. type=password is
  // meaningless on a <select> (browsers ignore it), so this uses the
  // autocomplete token instead — the realistic case for a select-based
  // credential widget (e.g. a select-based OTP/country-code-for-2FA picker).
  const selectEl = fakeInput({ autocomplete: 'one-time-code' });
  selectEl.tagName = 'SELECT';
  selectEl.options = [{ value: 'x', textContent: 'x' }];
  const selectMap = new Map([[1, selectEl]]);
  const rSel = execute({ action: 'select', element: 1, value: 'x' }, selectMap);
  check('select on autocomplete=one-time-code element -> REFUSED (guard applies to select too)', () => {
    assert.strictEqual(rSel.ok, false, `expected ok:false, got ${JSON.stringify(rSel)}`);
    assert.match(rSel.message, /credentials never go through the model/);
  });
}

// =====================================================================
// Part 2 — MUST-FIX #1: the click-target guard, exercised via the REAL
// execute() with a synthetic {action:'click'} against javascript:,
// cross-origin, same-origin, ancestor-bubbling, and no-target elements.
// =====================================================================

function testClickTargetGuardViaExecute() {
  console.log('\n[2] click-target guard via execute() — MUST-FIX #1');
  const sandbox = buildSandbox();
  const execute = sandbox.window.LFL.executor.execute;
  const opts = { origin: 'https://example.com', baseURI: 'https://example.com/page' };
  // execute()'s click branch calls LFL.guards.checkClickTarget(el) with NO
  // opts, which falls back to `document.baseURI`/`location.origin` — neither
  // exists in this sandbox. So for this execute()-level test we patch
  // checkClickTarget to supply the fixed origin/baseURI above (equivalent to
  // what a real page at https://example.com/page would provide) — the guard
  // LOGIC under test (guards.checkClickTarget / resolveClickNavTarget /
  // safeSameOriginHttpUrl) is untouched; only the ambient origin lookup is
  // supplied explicitly, exactly as guards.js's own `opts` parameter is
  // designed to allow.
  const realCheckClickTarget = sandbox.window.LFL.guards.checkClickTarget;
  sandbox.window.LFL.guards.checkClickTarget = (el) => realCheckClickTarget(el, opts);

  const jsAnchor = fakeAnchor('javascript:document.title="PWNED"');
  const crossOriginAnchor = fakeAnchor('https://evil.example.net/steal');
  const sameOriginAnchor = fakeAnchor('/same-origin-path');
  const plainButton = fakePlainButton();

  const map = new Map([[1, jsAnchor], [2, crossOriginAnchor], [3, sameOriginAnchor], [4, plainButton]]);

  const r1 = execute({ action: 'click', element: 1 }, map);
  check('click on javascript: anchor -> BLOCKED, el.click() never called, destination shown', () => {
    assert.strictEqual(r1.ok, false, `expected ok:false, got ${JSON.stringify(r1)}`);
    assert.strictEqual(jsAnchor.__clicked.count, 0, 'el.click() must never fire for a javascript: target');
    assert.match(r1.message, /blocked/i);
    assert.match(r1.message, /javascript:document\.title/, 'blocked message must show the actual destination');
  });

  const r2 = execute({ action: 'click', element: 2 }, map);
  check('click on cross-origin anchor -> BLOCKED, el.click() never called, destination shown', () => {
    assert.strictEqual(r2.ok, false, `expected ok:false, got ${JSON.stringify(r2)}`);
    assert.strictEqual(crossOriginAnchor.__clicked.count, 0, 'el.click() must never fire for a cross-origin target');
    assert.match(r2.message, /blocked/i);
    assert.match(r2.message, /evil\.example\.net/, 'blocked message must show the actual destination');
  });

  const r3 = execute({ action: 'click', element: 3 }, map);
  check('click on same-origin anchor -> ALLOWED, el.click() fires', () => {
    assert.strictEqual(r3.ok, true, `expected ok:true, got ${JSON.stringify(r3)}`);
    assert.strictEqual(sameOriginAnchor.__clicked.count, 1, 'el.click() must fire for an allowed same-origin target');
  });

  const r4 = execute({ action: 'click', element: 4 }, map);
  check('click on a plain button (no nav target) -> ALLOWED, el.click() fires', () => {
    assert.strictEqual(r4.ok, true, `expected ok:true, got ${JSON.stringify(r4)}`);
    assert.strictEqual(plainButton.__clicked.count, 1);
  });

  // TOCTOU close: the SAME element object's href is swapped between two
  // execute() calls (simulating a page rewriting an anchor's href between
  // proposal and approval). The guard must re-read live, not cache.
  const toctouAnchor = fakeAnchor('/looks-safe-at-proposal-time');
  const toctouMap = new Map([[1, toctouAnchor]]);
  const rBefore = execute({ action: 'click', element: 1 }, toctouMap);
  check('TOCTOU probe, phase 1 (same-origin at "proposal" time) -> ALLOWED', () => {
    assert.strictEqual(rBefore.ok, true, `expected ok:true, got ${JSON.stringify(rBefore)}`);
  });
  toctouAnchor.__clicked.count = 0; // reset for phase 2
  toctouAnchor._href = 'javascript:alert(document.cookie)';
  const rAfter = execute({ action: 'click', element: 1 }, toctouMap);
  check('TOCTOU probe, phase 2 (page swapped href to javascript: before "approval") -> BLOCKED', () => {
    assert.strictEqual(rAfter.ok, false, `expected ok:false, got ${JSON.stringify(rAfter)}`);
    assert.strictEqual(toctouAnchor.__clicked.count, 0, 'the swapped-in javascript: href must be caught — re-resolved live, not cached');
  });

  // Ancestor-bubbling case: the model targets a <span> inside an <a>.
  const outerAnchor = fakeAnchor('https://evil.example.net/via-bubbling');
  const innerSpan = { tagName: 'SPAN', getAttribute() { return null; }, hasAttribute() { return false; }, click() { outerAnchor.click(); } };
  outerAnchor.closest = (sel) => (sel === 'a[href]' ? outerAnchor : null);
  innerSpan.closest = (sel) => (sel === 'a[href]' ? outerAnchor : null);
  const bubbleMap = new Map([[1, innerSpan]]);
  const rBubble = execute({ action: 'click', element: 1 }, bubbleMap);
  check('click on a child <span> of a cross-origin <a> (event-bubbling case) -> BLOCKED', () => {
    assert.strictEqual(rBubble.ok, false, `expected ok:false, got ${JSON.stringify(rBubble)}`);
    assert.strictEqual(outerAnchor.__clicked.count, 0, 'the ancestor anchor must never be clicked either');
  });

  sandbox.window.LFL.guards.checkClickTarget = realCheckClickTarget; // restore (not strictly needed, sandbox is disposable)
}

// =====================================================================
// Part 2b — 2026-07-12 verifier follow-up: the click guard's target
// resolution was missing an enclosing <form>'s `action`, <area href>, and
// SVG <a xlink:href> — so a click on a submit control inside
// <form action="https://evil.com"> (or an <area>/svg-<a> pointing off-site)
// reached el.click() with zero scheme/origin check. Same execute()-level
// harness as Part 2, same origin/baseURI patch.
// =====================================================================

function testFormAreaSvgClickGuardViaExecute() {
  console.log('\n[2b] form-action / <area> / svg-<a> click-target guard via execute() — verifier follow-up');
  const sandbox = buildSandbox();
  const execute = sandbox.window.LFL.executor.execute;
  const opts = { origin: 'https://example.com', baseURI: 'https://example.com/page' };
  const realCheckClickTarget = sandbox.window.LFL.guards.checkClickTarget;
  sandbox.window.LFL.guards.checkClickTarget = (el) => realCheckClickTarget(el, opts);

  const evilForm = fakeForm('https://evil.com/x');
  const localForm = fakeForm('/local');
  const jsForm = fakeForm('javascript:alert(document.cookie)');

  const noTypeButtonEvilForm = fakeSubmitButton({ form: evilForm });
  const submitInputEvilForm = fakeSubmitInput({ type: 'submit', form: evilForm });
  const submitButtonLocalForm = fakeSubmitButton({ form: localForm });
  const plainButtonNoForm = fakeUnassociatedButton('button');
  const areaEvil = fakeArea('https://evil.com');
  const areaLocal = fakeArea('/local');
  const svgAnchorEvil = fakeSvgAnchor('https://evil.com');
  const submitButtonJsForm = fakeSubmitButton({ form: jsForm });

  const map = new Map([
    [1, noTypeButtonEvilForm],
    [2, submitInputEvilForm],
    [3, submitButtonLocalForm],
    [4, plainButtonNoForm],
    [5, areaEvil],
    [6, areaLocal],
    [7, svgAnchorEvil],
    [8, submitButtonJsForm],
  ]);

  const r1 = execute({ action: 'click', element: 1 }, map);
  check('submit <button> (no type attr) inside <form action="https://evil.com/x"> -> BLOCKED, el.click() never called', () => {
    assert.strictEqual(r1.ok, false, `expected ok:false, got ${JSON.stringify(r1)}`);
    assert.strictEqual(noTypeButtonEvilForm.__clicked.count, 0);
    assert.match(r1.message, /blocked/i);
    assert.match(r1.message, /evil\.com/, 'blocked message must show the actual form-action destination');
  });

  const r2 = execute({ action: 'click', element: 2 }, map);
  check('input[type=submit] inside cross-origin-action form -> BLOCKED, el.click() never called', () => {
    assert.strictEqual(r2.ok, false, `expected ok:false, got ${JSON.stringify(r2)}`);
    assert.strictEqual(submitInputEvilForm.__clicked.count, 0);
    assert.match(r2.message, /blocked/i);
  });

  const r3 = execute({ action: 'click', element: 3 }, map);
  check('submit button inside <form action="/local"> (same-origin) -> ALLOWED, el.click() fires (no over-block)', () => {
    assert.strictEqual(r3.ok, true, `expected ok:true, got ${JSON.stringify(r3)}`);
    assert.strictEqual(submitButtonLocalForm.__clicked.count, 1);
  });

  const r4 = execute({ action: 'click', element: 4 }, map);
  check('plain <button type=button> with no form -> ALLOWED, el.click() fires (no over-block)', () => {
    assert.strictEqual(r4.ok, true, `expected ok:true, got ${JSON.stringify(r4)}`);
    assert.strictEqual(plainButtonNoForm.__clicked.count, 1);
  });

  const r5 = execute({ action: 'click', element: 5 }, map);
  check('<area href="https://evil.com"> -> BLOCKED, el.click() never called', () => {
    assert.strictEqual(r5.ok, false, `expected ok:false, got ${JSON.stringify(r5)}`);
    assert.strictEqual(areaEvil.__clicked.count, 0);
    assert.match(r5.message, /blocked/i);
  });

  const r6 = execute({ action: 'click', element: 6 }, map);
  check('<area href="/local"> -> ALLOWED, el.click() fires (no over-block)', () => {
    assert.strictEqual(r6.ok, true, `expected ok:true, got ${JSON.stringify(r6)}`);
    assert.strictEqual(areaLocal.__clicked.count, 1);
  });

  const r7 = execute({ action: 'click', element: 7 }, map);
  check('SVG <a xlink:href="https://evil.com"> -> BLOCKED, el.click() never called', () => {
    assert.strictEqual(r7.ok, false, `expected ok:false, got ${JSON.stringify(r7)}`);
    assert.strictEqual(svgAnchorEvil.__clicked.count, 0);
    assert.match(r7.message, /blocked/i);
  });

  const r8 = execute({ action: 'click', element: 8 }, map);
  check('submit button inside <form action="javascript:..."> -> BLOCKED, el.click() never called', () => {
    assert.strictEqual(r8.ok, false, `expected ok:false, got ${JSON.stringify(r8)}`);
    assert.strictEqual(submitButtonJsForm.__clicked.count, 0);
    assert.match(r8.message, /blocked/i);
  });

  sandbox.window.LFL.guards.checkClickTarget = realCheckClickTarget;
}

// =====================================================================
// Part 3 — guards.js in isolation (no vm/execute() involved), the plain
// Node-requireable path, covering the same (a)-(d) cases directly against
// isPasswordField() and the click guard functions.
// =====================================================================

function testGuardsDirectly() {
  console.log('\n[3] guards.js loaded directly via require() (no vm/execute involved)');
  // guards.js has zero top-level DOM dependencies (all document/location
  // reads are inside function bodies, behind `typeof` checks) — it is
  // directly requireable as plain CommonJS, unlike executor.js.
  const guards = require(GUARDS_PATH);

  check('guards.isPasswordField: type=password -> true', () => {
    assert.strictEqual(guards.isPasswordField(fakeInput({ type: 'password' })), true);
  });
  check('guards.isPasswordField: autocomplete=current-password -> true', () => {
    assert.strictEqual(guards.isPasswordField(fakeInput({ type: 'text', autocomplete: 'current-password' })), true);
  });
  check('guards.isPasswordField: autocomplete=new-password -> true', () => {
    assert.strictEqual(guards.isPasswordField(fakeInput({ type: 'text', autocomplete: 'new-password' })), true);
  });
  check('guards.isPasswordField: autocomplete=one-time-code -> true', () => {
    assert.strictEqual(guards.isPasswordField(fakeInput({ type: 'text', autocomplete: 'one-time-code' })), true);
  });
  check('guards.isPasswordField: plain text field -> false', () => {
    assert.strictEqual(guards.isPasswordField(fakeInput({ type: 'text', name: 'q' })), false);
  });
  check('guards.isPasswordField: documented scope gap — generic PIN with no autocomplete hint is NOT detected', () => {
    // Honest scope statement (MUST-FIX #4): a type=text PIN field with no
    // autocomplete attribute at all cannot be distinguished from any other
    // text field by this check. This assertion documents that as expected
    // behavior, not a bug — see README.md / docs/threat-model.md.
    assert.strictEqual(guards.isPasswordField(fakeInput({ type: 'text', name: 'pin' })), false);
  });

  check('guards.safeSameOriginHttpUrl: javascript: scheme -> blocked, code=non-http', () => {
    const r = guards.safeSameOriginHttpUrl('javascript:alert(1)', { origin: 'https://example.com', baseURI: 'https://example.com/' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'non-http');
  });
  check('guards.safeSameOriginHttpUrl: cross-origin https -> blocked, code=cross-origin', () => {
    const r = guards.safeSameOriginHttpUrl('https://evil.example.net/', { origin: 'https://example.com', baseURI: 'https://example.com/' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'cross-origin');
  });
  check('guards.safeSameOriginHttpUrl: same-origin relative path -> ok', () => {
    const r = guards.safeSameOriginHttpUrl('/pricing', { origin: 'https://example.com', baseURI: 'https://example.com/' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.url.href, 'https://example.com/pricing');
  });

  check('guards.checkClickTarget: plain button (no href/formaction) -> hasTarget=false', () => {
    const r = guards.checkClickTarget(fakePlainButton(), { origin: 'https://example.com', baseURI: 'https://example.com/' });
    assert.strictEqual(r.hasTarget, false);
  });
  check('guards.checkClickTarget: button with formaction cross-origin -> blocked', () => {
    const btn = {
      tagName: 'BUTTON',
      getAttribute(n) { return n === 'formaction' ? 'https://evil.example.net/submit' : null; },
      hasAttribute(n) { return n === 'formaction'; },
      closest() { return null; },
    };
    const r = guards.checkClickTarget(btn, { origin: 'https://example.com', baseURI: 'https://example.com/' });
    assert.strictEqual(r.hasTarget, true);
    assert.strictEqual(r.blocked, true);
    assert.strictEqual(r.classification, 'cross-origin');
  });
}

// ---- run everything ----

console.log('tests/executor_credential.test.js — MUST-FIX #1, #3, #4 proof');
testCredentialBlockViaExecute();
testClickTargetGuardViaExecute();
testFormAreaSvgClickGuardViaExecute();
testGuardsDirectly();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
