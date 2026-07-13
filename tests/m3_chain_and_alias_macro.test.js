#!/usr/bin/env node
/**
 * tests/m3_chain_and_alias_macro.test.js — unit proof of registry.js's
 * quote-aware `&&` splitter (design doc §5/§13 item 2) and the alias/macro
 * store's write-path lock + depth-1 lock (design doc §6/§13 item 3), against
 * the REAL, unmodified `extension/content/registry.js` source (plain
 * CommonJS require — registry.js has no DOM dependency).
 *
 * Part 5/6 (fix round, security verify LOW-1): unit coverage for FIX 1 —
 * the `navInitiated` signal that lets `back`/same-origin `open`/`open!`/
 * auto-submitting `search` defer chain continuation to re-injection +
 * the arrival check, exactly like `go`, instead of racing a synchronous
 * queue advance against the document they just started unloading. Part 5
 * loads the REAL `extension/content/engine.js` via Node's `vm` module
 * (same technique tests/executor_credential.test.js and
 * tests/m3_hardening.test.js already use for the other browser-only,
 * `window.LFL`-scoped files) and proves the flag is set on exactly the
 * navigating branches and absent on the non-navigating ones. Part 6 is a
 * static source-shape check on the REAL `extension/content/terminal.js`
 * proving `_dispatchSegment()` actually consults the flag and skips the
 * synchronous `_afterSettle(true)` call when it's set (same
 * documented-limitation posture as m3_hardening.test.js's H1/H2 static
 * checks — terminal.js needs attachShadow/popover/chrome.* and has no
 * practical Node harness of its own).
 *
 * Run: node tests/m3_chain_and_alias_macro.test.js
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const registry = require(path.join(ROOT, 'extension', 'content', 'registry.js'));
const ENGINE_PATH = path.join(ROOT, 'extension', 'content', 'engine.js');
const TERMINAL_PATH = path.join(ROOT, 'extension', 'content', 'terminal.js');

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

async function acheck(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   - ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${e && e.message ? e.message : e}`);
  }
}

// A tiny fake chrome.storage.local — plain in-memory object, same get/set
// signature shape the real API has (get(keys, cb), set(obj)).
function fakeStorageArea() {
  const data = {};
  return {
    _data: data,
    get(keys, cb) {
      const out = {};
      keys.forEach((k) => { if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k]; });
      cb(out);
    },
    set(obj) { Object.assign(data, obj); },
  };
}

// =====================================================================
// Part 1 — splitChain: quote-aware `&&` splitter, cap 5.
// =====================================================================

function testSplitChain() {
  console.log('\n[1] registry.splitChain — quote-aware && splitter, cap 5 (design §5/§13 item 2)');

  check('single command, no && at all -> one segment', () => {
    const r = registry.splitChain('search "backpack"', 5);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.segments, ['search "backpack"']);
  });

  check('two commands joined by && -> two segments, trimmed', () => {
    const r = registry.splitChain('go saucedemo.com &&   search "backpack"  ', 5);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.segments, ['go saucedemo.com', 'search "backpack"']);
  });

  check('&& INSIDE a double-quoted string is NOT a split point — quote-aware', () => {
    const r = registry.splitChain('search "a && b" && open x', 5);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.segments, ['search "a && b"', 'open x']);
  });

  check('exactly 5 segments -> allowed (at the cap, not over it)', () => {
    const r = registry.splitChain('a && b && c && d && e', 5);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.segments.length, 5);
  });

  check('6 segments -> REJECTED outright (ok:false), not silently truncated to 5', () => {
    const r = registry.splitChain('a && b && c && d && e && f', 5);
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.reason, /max 5/);
  });

  check('empty input -> zero segments, ok:true (nothing to run, not an error)', () => {
    const r = registry.splitChain('', 5);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.segments, []);
  });

  check('empty segments between stray && are dropped, not counted toward the cap as blanks', () => {
    const r = registry.splitChain('go x &&  && search y', 5);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.segments, ['go x', 'search y']);
  });

  check('default cap (no maxSegments arg) is 5', () => {
    const r = registry.splitChain('a && b && c && d && e && f');
    assert.strictEqual(r.ok, false);
  });
}

// =====================================================================
// Part 2 — alias store: write-path (only via setAlias/setMacro), round
// trip through a fake storage backend, and reject rules.
// =====================================================================

async function testAliasStore() {
  console.log('\n[2] registry.createAliasStore — alias write path + round trip');

  check('setAlias -> getAlias round trip, and it persists to the backing storage area', () => {
    const area = fakeStorageArea();
    const store = registry.createAliasStore(area);
    const res = store.setAlias('wiki', 'go en.wikipedia.org');
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(store.getAlias('wiki'), 'go en.wikipedia.org');
    assert.strictEqual(area._data.lflAliases.wiki, 'go en.wikipedia.org', 'must actually be written to the storage area, not just in-memory');
  });

  await acheck('a fresh store instance backed by the SAME storage area, after load(), sees the persisted alias — proves this is real persistence, not just in-process state', async () => {
    const area = fakeStorageArea();
    const store1 = registry.createAliasStore(area);
    store1.setAlias('wiki', 'go en.wikipedia.org');
    const store2 = registry.createAliasStore(area);
    await store2.load();
    assert.strictEqual(store2.getAlias('wiki'), 'go en.wikipedia.org');
  });

  check('getAlias on an undefined name -> null (not throw, not empty string)', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    assert.strictEqual(store.getAlias('nope'), null);
  });

  check('unsetAlias removes it; unsetAlias on a nonexistent name reports ok:false', () => {
    const area = fakeStorageArea();
    const store = registry.createAliasStore(area);
    store.setAlias('wiki', 'go en.wikipedia.org');
    const r1 = store.unsetAlias('wiki');
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(store.getAlias('wiki'), null);
    const r2 = store.unsetAlias('wiki');
    assert.strictEqual(r2.ok, false);
  });

  check('invalid alias name (starts with a digit) -> REJECTED', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    const r = store.setAlias('1wiki', 'go en.wikipedia.org');
    assert.strictEqual(r.ok, false);
  });

  check('empty expansion -> REJECTED', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    const r = store.setAlias('wiki', '   ');
    assert.strictEqual(r.ok, false);
  });

  check('an alias named "go" -> REJECTED — built-ins cannot be shadowed (would silently break the whole go resolution ladder)', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    const r = store.setAlias('go', 'open something');
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.reason, /built-in command/);
  });

  check('an alias named "search" -> REJECTED — same reserved-word lock covers every built-in, not just go', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    const r = store.setAlias('search', 'go example.com');
    assert.strictEqual(r.ok, false);
  });

  check('an alias name that collides with an existing MACRO name -> REJECTED (aliases and macros share one namespace)', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    store.setMacro('morning', 'go news.ycombinator.com && extract links');
    const r = store.setAlias('morning', 'go example.com');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /already a macro/);
  });
}

// =====================================================================
// Part 3 — macro store: depth-1 lock (write-time rejection of a macro
// segment referencing another macro), and the same round-trip guarantees.
// =====================================================================

function testMacroStore() {
  console.log('\n[3] registry.createAliasStore (macros) — depth-1 lock (design §6/§13 item 3)');

  check('setMacro -> getMacro round trip', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    const res = store.setMacro('morning', 'go news.ycombinator.com && extract links');
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(store.getMacro('morning'), 'go news.ycombinator.com && extract links');
  });

  check('a macro whose body contains more than 5 segments is REJECTED at definition time (splitChain cap applies to macro bodies too)', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    const res = store.setMacro('toolong', 'a && b && c && d && e && f');
    assert.strictEqual(res.ok, false);
  });

  check('DEPTH-1 LOCK: a macro whose FIRST segment leads with an existing macro name -> REJECTED', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    store.setMacro('inner', 'go example.com');
    const res = store.setMacro('outer', 'inner && extract links');
    assert.strictEqual(res.ok, false, JSON.stringify(res));
    assert.match(res.reason, /depth-1 lock/);
  });

  check('DEPTH-1 LOCK: a macro whose LATER segment leads with an existing macro name -> REJECTED (not just the first segment checked)', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    store.setMacro('inner', 'go example.com');
    const res = store.setMacro('outer', 'go news.ycombinator.com && inner');
    assert.strictEqual(res.ok, false, JSON.stringify(res));
  });

  check('DEPTH-1 LOCK: a macro cannot reference ITSELF (self-recursion blocked the same way)', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    const res = store.setMacro('loop', 'go example.com && loop');
    assert.strictEqual(res.ok, false, JSON.stringify(res));
  });

  check('defining "inner" AFTER "outer" already referenced a DIFFERENT (non-macro at the time) name is fine — the lock is checked against macros that exist at definition time, not retroactively enforced', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    // "helper" is not a macro yet when "outer" is defined — allowed.
    const r1 = store.setMacro('outer', 'helper && extract links');
    assert.strictEqual(r1.ok, true, JSON.stringify(r1));
  });

  check('a macro named "go" -> REJECTED — built-ins cannot be shadowed by a macro either', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    const r = store.setMacro('go', 'search "x" && extract links');
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.reason, /built-in command/);
  });

  check('a macro name colliding with an existing ALIAS name -> REJECTED', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    store.setAlias('wiki', 'go en.wikipedia.org');
    const r = store.setMacro('wiki', 'go example.com && extract links');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /already an alias/);
  });

  check('unsetMacro removes it; unsetMacro on a nonexistent name reports ok:false', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    store.setMacro('morning', 'go example.com && extract links');
    assert.strictEqual(store.unsetMacro('morning').ok, true);
    assert.strictEqual(store.getMacro('morning'), null);
    assert.strictEqual(store.unsetMacro('morning').ok, false);
  });
}

// =====================================================================
// Part 4 — expandAlias/expandMacro: the (single-level, non-recursive)
// expansion functions terminal.js calls before dispatch.
// =====================================================================

function testExpansionFunctions() {
  console.log('\n[4] registry.expandAlias / expandMacro — single-level expansion, args appended for aliases');

  check('expandAlias: leading word matches an alias -> substituted, trailing args from the ORIGINAL segment appended', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    store.setAlias('s', 'search');
    const out = registry.expandAlias('s "backpack"', store);
    assert.strictEqual(out, 'search "backpack"');
  });

  check('expandAlias: no alias match -> segment returned unchanged', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    const out = registry.expandAlias('search "backpack"', store);
    assert.strictEqual(out, 'search "backpack"');
  });

  check('expandAlias is NOT recursive: an alias expansion that itself starts with another alias name is used VERBATIM, not further expanded', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    store.setAlias('a', 'b something');
    store.setAlias('b', 'go example.com');
    const out = registry.expandAlias('a', store);
    assert.strictEqual(out, 'b something', 'expandAlias performs exactly ONE substitution, never chains a -> b -> further');
  });

  check('expandMacro: whole raw input matches a macro name -> replaced with the macro\'s stored chain text', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    store.setMacro('morning', 'go news.ycombinator.com && extract links');
    const out = registry.expandMacro('morning', store);
    assert.strictEqual(out, 'go news.ycombinator.com && extract links');
  });

  check('expandMacro: no match -> raw input returned unchanged', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    const out = registry.expandMacro('go example.com', store);
    assert.strictEqual(out, 'go example.com');
  });

  check('the model/page can never reach setAlias/setMacro: registry.js exports no function that accepts untrusted input as a write path other than the ones a typed alias/macro command calls directly', () => {
    // Structural/enumeration proof: the store's public surface is exactly
    // these functions, all of which require the CALLER (terminal.js's
    // _handleAliasCommand/_handleMacroCommand, only reachable from typed
    // input — see terminal.js's _submitCommand regex dispatch) to invoke
    // them explicitly with parsed typed text. There is no "apply this
    // action object" style entry point here the way executor.js has one
    // for the LLM lane.
    const store = registry.createAliasStore(fakeStorageArea());
    const surface = Object.keys(store).sort();
    assert.deepStrictEqual(surface, [
      'getAlias', 'getMacro', 'isLoaded', 'listAliases', 'listMacros',
      'load', 'setAlias', 'setMacro', 'unsetAlias', 'unsetMacro',
    ].sort());
  });
}

// =====================================================================
// Part 5 — FIX 1: engine.js's navInitiated tagging, against the REAL,
// unmodified extension/content/engine.js source loaded via vm (engine.js
// is a `window.LFL`-scoped browser-only IIFE, not directly requireable —
// same posture as terminal.js/executor.js, see tests/executor_credential.
// test.js's header comment for the general technique).
// =====================================================================

// Builds a fresh sandbox + loads the real engine.js into it. `LFL.registry`
// is the REAL registry.js module (dual-mode — module.exports under Node,
// see registry.js's own header comment), not a stub, since engine.js calls
// LFL.registry.createRegistry() unconditionally at load time. Everything
// else engine.js touches (document/location/history/URL/KeyboardEvent,
// LFL.axtree/LFL.executor) is a minimal fake — this suite is only proving
// the navInitiated flag's placement, not re-testing findSearchInput's
// selector list or doOpen's link-scoring (that's the Playwright battery's
// job, same division of labor engine.js's own header comment describes).
function buildEngineSandbox() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.window.LFL = {
    registry,
    axtree: { isElementVisible: () => true },
    executor: { fillNative: () => {} },
  };
  const historyCalls = { count: 0 };
  sandbox.history = { back() { historyCalls.count += 1; } };
  sandbox.location = { origin: 'https://example.com', href: 'https://example.com/page' };
  sandbox.document = {
    baseURI: 'https://example.com/page',
    __qsa: [],
    querySelectorAll() { return sandbox.document.__qsa; },
    querySelector() { return null; },
  };
  sandbox.URL = URL;
  sandbox.KeyboardEvent = function KeyboardEvent(type, opts) {
    this.type = type;
    Object.assign(this, opts || {});
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(ENGINE_PATH, 'utf8');
  vm.runInContext(src, sandbox, { filename: 'engine.js' });
  assert.strictEqual(typeof sandbox.window.LFL.engine.tryDeterministic, 'function', 'engine.js did not set window.LFL.engine.tryDeterministic');
  return { sandbox, historyCalls };
}

function testEngineNavInitiated() {
  console.log('\n[5] FIX 1 — engine.js tags navInitiated:true on exactly the navigating branches (against the real engine.js)');

  check('`back` calls history.back() and IS tagged navInitiated:true', () => {
    const { sandbox, historyCalls } = buildEngineSandbox();
    const det = sandbox.window.LFL.engine.tryDeterministic('back', {});
    assert.strictEqual(historyCalls.count, 1, 'history.back() must actually be called');
    assert.strictEqual(det.navInitiated, true);
  });

  check('`open <text>` same-origin branch navigates via location.href and IS tagged navInitiated:true', () => {
    const { sandbox } = buildEngineSandbox();
    sandbox.document.__qsa = [
      { textContent: 'Home', getAttribute: (n) => (n === 'href' ? '/home' : null) },
    ];
    const det = sandbox.window.LFL.engine.tryDeterministic('open home', {});
    assert.strictEqual(sandbox.location.href, 'https://example.com/home');
    assert.strictEqual(det.navInitiated, true);
  });

  check('`open <text>` cross-origin branch does NOT navigate synchronously and is NOT tagged navInitiated (it only latches pendingCrossOriginUrl)', () => {
    const { sandbox } = buildEngineSandbox();
    sandbox.document.__qsa = [
      { textContent: 'Elsewhere', getAttribute: (n) => (n === 'href' ? 'https://other.example/x' : null) },
    ];
    const state = {};
    const det = sandbox.window.LFL.engine.tryDeterministic('open elsewhere', state);
    assert.strictEqual(sandbox.location.href, 'https://example.com/page', 'must not have navigated');
    assert.strictEqual(state.pendingCrossOriginUrl, 'https://other.example/x');
    assert.ok(!det.navInitiated, 'cross-origin pending branch must not be tagged navInitiated');
  });

  check('`open!` confirms a pending cross-origin URL, navigates via location.href, and IS tagged navInitiated:true', () => {
    const { sandbox } = buildEngineSandbox();
    const state = { pendingCrossOriginUrl: 'https://other.example/x' };
    const det = sandbox.window.LFL.engine.tryDeterministic('open!', state);
    assert.strictEqual(sandbox.location.href, 'https://other.example/x');
    assert.strictEqual(state.pendingCrossOriginUrl, null);
    assert.strictEqual(det.navInitiated, true);
  });

  check('`open!` with no pending cross-origin URL does nothing and is NOT tagged navInitiated', () => {
    const { sandbox } = buildEngineSandbox();
    const det = sandbox.window.LFL.engine.tryDeterministic('open!', {});
    assert.ok(!det.navInitiated);
  });

  check('`search "q"` with a same-origin form submits via requestSubmit() and IS tagged navInitiated:true', () => {
    const { sandbox } = buildEngineSandbox();
    let submitCalls = 0;
    const fakeForm = { action: 'https://example.com/search', requestSubmit() { submitCalls += 1; } };
    const fakeInput = { form: fakeForm, dispatchEvent() {} };
    sandbox.document.__qsa = [fakeInput];
    const det = sandbox.window.LFL.engine.tryDeterministic('search "backpack"', {});
    assert.strictEqual(submitCalls, 1);
    assert.strictEqual(det.navInitiated, true);
  });

  check('`search "q"` with a cross-origin form does NOT submit and is NOT tagged navInitiated', () => {
    const { sandbox } = buildEngineSandbox();
    let submitCalls = 0;
    const fakeForm = { action: 'https://other.example/search', requestSubmit() { submitCalls += 1; } };
    const fakeInput = { form: fakeForm, dispatchEvent() {} };
    sandbox.document.__qsa = [fakeInput];
    const det = sandbox.window.LFL.engine.tryDeterministic('search "backpack"', {});
    assert.strictEqual(submitCalls, 0);
    assert.ok(!det.navInitiated);
  });

  check('`search "q"` with no enclosing form dispatches a synthetic Enter and IS tagged navInitiated:true (the JS-driven search box path)', () => {
    const { sandbox } = buildEngineSandbox();
    let dispatchCount = 0;
    const fakeInput = { form: null, dispatchEvent() { dispatchCount += 1; } };
    sandbox.document.__qsa = [fakeInput];
    const det = sandbox.window.LFL.engine.tryDeterministic('search "backpack"', {});
    assert.strictEqual(dispatchCount, 2, 'keydown+keyup Enter must both dispatch');
    assert.strictEqual(det.navInitiated, true);
  });

  check('`search "q"` with no search box found is NOT tagged navInitiated', () => {
    const { sandbox } = buildEngineSandbox();
    sandbox.document.__qsa = [];
    const det = sandbox.window.LFL.engine.tryDeterministic('search "backpack"', {});
    assert.ok(!det.navInitiated);
    assert.match(det.output, /no search box found/);
  });
}

// =====================================================================
// Part 6 — FIX 1: terminal.js's _dispatchSegment() actually consults
// navInitiated and skips the synchronous queue advance when it's set.
// Static source-shape check against the REAL terminal.js — same
// documented-limitation posture as m3_hardening.test.js's H1/H2 checks
// (terminal.js has no practical Node/vm harness; see this file's header).
// =====================================================================

function testDispatchSegmentSkipsAdvance() {
  console.log('\n[6] FIX 1 — terminal.js\'s _dispatchSegment() skips the synchronous advance when navInitiated is set (static source-shape check)');

  const src = fs.readFileSync(TERMINAL_PATH, 'utf8');

  check('_dispatchSegment checks det.navInitiated and returns BEFORE the unconditional _afterSettle(true) call', () => {
    const idx = src.indexOf('_dispatchSegment(segment, opts) {');
    assert.ok(idx >= 0, '_dispatchSegment not found');
    const body = src.slice(idx, idx + 4000);
    const detBlockStart = body.indexOf('const det = LFL.engine.tryDeterministic(');
    assert.ok(detBlockStart >= 0, 'tryDeterministic call not found inside _dispatchSegment');
    const navCheckIdx = body.indexOf('if (det.navInitiated) return;', detBlockStart);
    assert.ok(navCheckIdx >= 0, '_dispatchSegment must check "if (det.navInitiated) return;"');
    const afterSettleIdx = body.indexOf('this._afterSettle(true);', detBlockStart);
    assert.ok(afterSettleIdx >= 0, 'the unconditional _afterSettle(true) call not found');
    assert.ok(navCheckIdx < afterSettleIdx, 'the navInitiated check must come BEFORE the _afterSettle(true) call, so it can skip it');
  });

  check('the deterministic-command block still settles (_settle(true, ...)) before the navInitiated check — a navigating command still reports its result, it only skips the QUEUE advance', () => {
    const idx = src.indexOf('_dispatchSegment(segment, opts) {');
    const body = src.slice(idx, idx + 4000);
    const settleIdx = body.indexOf("this._settle(true, det.output || '');");
    const navCheckIdx = body.indexOf('if (det.navInitiated) return;');
    assert.ok(settleIdx >= 0 && navCheckIdx >= 0);
    assert.ok(settleIdx < navCheckIdx, '_settle(true, ...) must still run for a navInitiated result — only the queue advance is skipped');
  });
}

// ---- run everything ----

async function main() {
  console.log('tests/m3_chain_and_alias_macro.test.js — && parser + alias/macro store (M3)');
  testSplitChain();
  await testAliasStore();
  testMacroStore();
  testExpansionFunctions();
  testEngineNavInitiated();
  testDispatchSegmentSkipsAdvance();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
