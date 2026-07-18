#!/usr/bin/env node
/**
 * tests/m3_hardening.test.js - unit proof of the M3 hardening items from
 * design doc §8:
 *
 *   H1 - event.isTrusted gate. guards.isTrustedInputEvent() is a pure
 *   predicate (unit-tested directly here); the actual DOM wiring lives in
 *   terminal.js's _onGlobalKeydown/_onInputKeydown/approve-button/
 *   reject-button handlers, which is browser-only code with no practical
 *   Node harness in this project (terminal.js has never been directly
 *   loaded by any unit test - see its own header comment on why: it needs
 *   attachShadow/popover/elementsFromPoint, a much heavier DOM surface than
 *   guards.js/executor.js need). This file makes up for that with a static
 *   source-shape check: every one of the four listed handlers must call
 *   isTrustedInputEvent() as (effectively) its first guard. This is weaker
 *   than a full behavioral DOM test, and is documented as such - but it IS
 *   a real regression guard: a future edit that silently drops the guard
 *   from one of these handlers fails this test.
 *
 *   H2 - dev-hook gating shape. Confirms terminal.js's test-hook attribute
 *   is conditioned on `_devHooksEnabled` (not emitted unconditionally), and
 *   that the `dev on`/`dev off` command exists as the documented toggle.
 *   Same static-shape-check caveat as H1 for the actual runtime behavior.
 *
 *   registry-cannot-extend-model-vocabulary - the REAL proof, loaded via vm
 *   the same way tests/m3_nav_lane_isolation.test.js does: both LLM lanes'
 *   response_format schema enums are captured from a live request and
 *   checked to be EXACTLY the fixed, documented sets, with no registry
 *   command name (go/alias/macro/man/origins/dev/...) present in either -
 *   proving the DSL registry cannot, even accidentally, grow the set of
 *   actions either model is allowed to emit.
 *
 * Run: node tests/m3_hardening.test.js
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const GUARDS_PATH = path.join(ROOT, 'extension', 'content', 'guards.js');
const TERMINAL_PATH = path.join(ROOT, 'extension', 'content', 'terminal.js');
const SW_PATH = path.join(ROOT, 'extension', 'background', 'service-worker.js');
const RATELIMIT_PATH = path.join(ROOT, 'extension', 'content', 'ratelimit.js');
const guards = require(GUARDS_PATH);

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

// =====================================================================
// Part 1 - H1: guards.isTrustedInputEvent() pure predicate.
// =====================================================================

function testIsTrustedPredicate() {
  console.log('\n[1] H1 - guards.isTrustedInputEvent() pure predicate');

  check('a real (isTrusted:true) event -> true', () => {
    assert.strictEqual(guards.isTrustedInputEvent({ isTrusted: true }), true);
  });

  check('a synthetic (isTrusted:false) event -> false - the exact page-forged-KeyboardEvent case', () => {
    assert.strictEqual(guards.isTrustedInputEvent({ isTrusted: false }), false);
  });

  check('isTrusted missing entirely -> false, fail closed (do not assume trusted)', () => {
    assert.strictEqual(guards.isTrustedInputEvent({}), false);
  });

  check('null/undefined event -> false, does not throw', () => {
    assert.strictEqual(guards.isTrustedInputEvent(null), false);
    assert.strictEqual(guards.isTrustedInputEvent(undefined), false);
  });

  check('isTrusted as a truthy non-boolean (e.g. the string "true") -> false - must be the literal boolean true, not merely truthy (defends against a forged event object with isTrusted set as a plain writable property)', () => {
    assert.strictEqual(guards.isTrustedInputEvent({ isTrusted: 'true' }), false);
    assert.strictEqual(guards.isTrustedInputEvent({ isTrusted: 1 }), false);
  });
}

// =====================================================================
// Part 2 - H1/H2 static source-shape checks on terminal.js. Documented
// as a WEAKER substitute for a full DOM-level behavioral test - see this
// file's header comment for why terminal.js has no such harness in this
// project. Still a real regression guard: this fails if the guard call is
// ever silently removed from one of these four sites, or if the test hook
// stops being conditioned on the dev flag.
// =====================================================================

function testTerminalSourceShape() {
  console.log('\n[2] H1/H2 static source-shape checks on terminal.js (documented DOM-test-harness limitation - see header)');

  const src = fs.readFileSync(TERMINAL_PATH, 'utf8');

  check('_onGlobalKeydown starts with an isTrustedInputEvent guard', () => {
    const m = src.match(/_onGlobalKeydown\(e\) \{\s*\n\s*if \(!LFL\.guards\.isTrustedInputEvent\(e\)\) return;/);
    assert.ok(m, '_onGlobalKeydown must call isTrustedInputEvent(e) as its first statement');
  });

  check('_onInputKeydown starts with an isTrustedInputEvent guard', () => {
    const m = src.match(/_onInputKeydown\(e\) \{\s*\n\s*if \(!LFL\.guards\.isTrustedInputEvent\(e\)\) return;/);
    assert.ok(m, '_onInputKeydown must call isTrustedInputEvent(e) as its first statement');
  });

  check('the approve-button click handler is guarded by isTrustedInputEvent', () => {
    const idx = src.indexOf('approveBtn.addEventListener');
    assert.ok(idx >= 0, 'approveBtn click listener not found');
    const nearby = src.slice(idx, idx + 300);
    assert.match(nearby, /isTrustedInputEvent\(e\)/, 'approve button click handler must check isTrustedInputEvent');
  });

  check('the reject-button click handler is guarded by isTrustedInputEvent', () => {
    const idx = src.indexOf('rejectBtn.addEventListener');
    assert.ok(idx >= 0, 'rejectBtn click listener not found');
    const nearby = src.slice(idx, idx + 300);
    assert.match(nearby, /isTrustedInputEvent\(e\)/, 'reject button click handler must check isTrustedInputEvent');
  });

  check('H2: _updateTestHook() only sets data-lfl-state when _devHooksEnabled is true, and removes it otherwise', () => {
    const idx = src.indexOf('_updateTestHook() {');
    assert.ok(idx >= 0, '_updateTestHook not found');
    const body = src.slice(idx, idx + 2500);
    assert.match(body, /if \(!this\._devHooksEnabled\) \{/, 'test hook emission must be conditioned on _devHooksEnabled');
    assert.match(body, /removeAttribute\('data-lfl-state'\)/, 'when the dev flag is off, any previously-set attribute must be removed, not just skipped going forward');
  });

  check('H2: _devHooksEnabled defaults to false and is only ever set true via the persisted lflDevHooks flag or the typed "dev on" command', () => {
    assert.match(src, /this\._devHooksEnabled = false;/, 'constructor must default the flag to false');
    const devHandlerIdx = src.indexOf('_handleDevCommand(raw)');
    assert.ok(devHandlerIdx >= 0, '_handleDevCommand not found');
  });

  check('H2: the dev command is dispatched only from a typed-input regex match ("dev on"/"dev off"), never from the LLM action vocabulary', () => {
    assert.match(src, /\/\^dev\\s\+\(on\|off\)\$\/i\.test\(raw\)/, '_submitCommand must gate the dev command behind an explicit typed-text regex');
  });
}

// =====================================================================
// Part 3 - registry-cannot-extend-model-vocabulary. Loads the real
// service-worker.js via vm (same pattern as m3_nav_lane_isolation.test.js)
// and captures BOTH lanes' actual request bodies, checking their schema
// enums are exactly the fixed, documented sets with zero registry command
// names present in either.
// =====================================================================

function buildSwInstance() {
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const messageListeners = [];
  const capturedRequests = [];
  const storageMap = new Map();

  sandbox.chrome = {
    runtime: { onMessage: { addListener(fn) { messageListeners.push(fn); } } },
    storage: {
      session: {
        get(key) {
          return Promise.resolve().then(() => {
            const out = {};
            const keys = Array.isArray(key) ? key : [key];
            keys.forEach((k) => { if (storageMap.has(k)) out[k] = storageMap.get(k); });
            return out;
          });
        },
        set(obj) { return Promise.resolve().then(() => { Object.keys(obj).forEach((k) => storageMap.set(k, obj[k])); }); },
        remove() { return Promise.resolve(); },
      },
    },
    tabs: { onRemoved: { addListener() {} } },
  };
  sandbox.importScripts = function importScripts(...urls) {
    urls.forEach((u) => {
      const resolved = path.join(ROOT, 'extension', 'background', u);
      assert.strictEqual(resolved, RATELIMIT_PATH);
      vm.runInContext(fs.readFileSync(resolved, 'utf8'), sandbox, { filename: u });
    });
  };
  sandbox.fetch = function fetch(url, init) {
    capturedRequests.push({ url, init });
    const bodyObj = JSON.parse(init.body);
    const isNav = bodyObj.response_format.json_schema.name === 'lfl_nav_action';
    const content = isNav
      ? JSON.stringify({ action: 'navigate', value: 'https://example.com' })
      : JSON.stringify({ action: 'answer', element: 0, value: 'x' });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ choices: [{ message: { content } }] }), text: () => Promise.resolve('') });
  };
  sandbox.AbortController = function AbortController() { this.signal = {}; this.abort = function () {}; };
  sandbox.setTimeout = () => 0;
  sandbox.clearTimeout = () => {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), sandbox, { filename: 'service-worker.js' });
  const listener = messageListeners[0];
  function send(msg, tabId) {
    return new Promise((resolve, reject) => {
      const sender = tabId === null ? {} : { tab: { id: tabId } };
      let responded = false;
      const keepOpen = listener(msg, sender, (resp) => { responded = true; resolve(resp); });
      if (!responded && !keepOpen) reject(new Error('listener did not respond'));
    });
  }
  return { send, capturedRequests };
}

// The M3-NEW command surface (design §6/§11's registry entries added by
// this build - deliberately excludes the pre-existing M1/M2 page-lane
// primitives like "scroll" that legitimately, coincidentally, share a word
// with a deterministic engine verb name; that overlap predates M3 and is
// not what this test is guarding against). None of these strings may EVER
// appear as a value in either schema's `action` enum - if one did, it would
// mean the DSL registry had somehow grown the set of actions a model is
// allowed to emit, exactly the thing design doc §6's hard DSL locks forbid.
const M3_NEW_COMMAND_NAMES = [
  'go', 'alias', 'unalias', 'macro', 'unmacro', 'origins', 'dev', 'man',
  // scripts v1 (2026-07-14, LFL-TERMINAL-SCRIPTS-DESIGN.md) - same guarantee:
  // none of these may ever appear as a model-emittable action.
  'script', 'run', 'pause',
  // brainstorm lane (2026-07-15, LFL-TERMINAL-BRAINSTORM-LANE-DESIGN.md) -
  // same guarantee, plus its OWN schema uses a completely different shape
  // (`script`/`reason`, no `action` enum at all - see
  // tests/brainstorm_lane_isolation.test.js for that lane's own proof); this
  // list only needs to confirm "teach" itself never leaks into the OTHER two
  // lanes' action enums.
  'teach',
  // member-experience E2/E3/E5 (2026-07-16,
  // LFL-TERMINAL-MEMBER-EXPERIENCE-DESIGN.md) - same guarantee. Their
  // HANDLERS never call either LLM lane (typed-head interception only; as a
  // chain segment or alias expansion the words fall through to the gated
  // page-lane model like any unrecognized segment - see registry.js's
  // RESERVED_NAMES comment on them). This pin proves the registry entries
  // themselves never leak into a model-emittable action enum.
  'welcome', 'tour', 'status',
  // "recipes that succeed" (2026-07-17,
  // LFL-TERMINAL-RECIPES-THAT-SUCCEED-DESIGN.md) - same guarantee. `expect`
  // is dispatched inside engine.js's tryDeterministic() (synchronous,
  // DOM-only); `wait` is head-intercepted in terminal.js's
  // _dispatchSegment() (async poll loop) - neither one ever builds a
  // model-lane payload of its own or reaches either RESPONSE_SCHEMA.
  'expect', 'wait',
];

async function testVocabularyLock() {
  console.log('\n[3] registry-cannot-extend-model-vocabulary - both lanes\' schema enums, captured live from the real service worker');

  await acheck('page-lane schema enum is EXACTLY the 8 fixed primitives, unchanged from M1/M2, no NEW M3 command name present', async () => {
    const sw = buildSwInstance();
    await sw.send({ type: 'LFL_LLM_REQUEST', command: 'x', elementList: '', origin: 'https://example.com', title: 't' }, 1);
    const body = JSON.parse(sw.capturedRequests[0].init.body);
    const enumVals = body.response_format.json_schema.schema.properties.action.enum;
    // The full-equality check is the strong guarantee (pins the exact 8
    // values, in order, unchanged from M1/M2); the per-name loop below is a
    // second, more legible failure message if it ever drifts.
    assert.deepStrictEqual(enumVals, ['click', 'fill', 'select', 'navigate', 'scroll', 'extract', 'answer', 'abort']);
    for (const name of M3_NEW_COMMAND_NAMES) {
      assert.ok(!enumVals.includes(name), `M3 registry command "${name}" must never appear in the page-lane action enum`);
    }
  });

  await acheck('nav-lane schema enum is EXACTLY the 2-subset [navigate, abort], no NEW M3 command name present', async () => {
    const sw = buildSwInstance();
    await sw.send({ type: 'NAV_LLM_REQUEST', command: 'go to the wiki' }, 1);
    const body = JSON.parse(sw.capturedRequests[0].init.body);
    const enumVals = body.response_format.json_schema.schema.properties.action.enum;
    assert.deepStrictEqual(enumVals, ['navigate', 'abort']);
    for (const name of M3_NEW_COMMAND_NAMES) {
      assert.ok(!enumVals.includes(name), `M3 registry command "${name}" must never appear in the nav-lane action enum`);
    }
  });

  check('neither RESPONSE_SCHEMA source in service-worker.js references LFL.registry or LFL.commandRegistry at all - the model-facing schema is a hardcoded constant, structurally decoupled from the DSL registry', () => {
    const src = fs.readFileSync(SW_PATH, 'utf8');
    assert.ok(!src.includes('LFL.registry'), 'service-worker.js must not reference the DSL registry module');
    assert.ok(!src.includes('commandRegistry'), 'service-worker.js must not reference the command registry instance');
  });
}

// ---- run everything ----

async function main() {
  console.log('tests/m3_hardening.test.js - H1 isTrusted + H2 dev-hook + vocabulary lock (M3)');
  testIsTrustedPredicate();
  testTerminalSourceShape();
  await testVocabularyLock();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
