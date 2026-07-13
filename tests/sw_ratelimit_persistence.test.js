#!/usr/bin/env node
/**
 * tests/sw_ratelimit_persistence.test.js — direct unit-level proof that the
 * M2.3 rate-limit counters AND the paused latch PERSIST across a simulated
 * content-script re-injection, closing the M2-independent-verify finding:
 * the old design kept this state only inside the per-page `Terminal`
 * instance, which is destroyed and rebuilt on every top-frame navigation /
 * `location.reload()` — silently resetting the budget to full and clearing
 * an active pause with no `continue` ever typed.
 *
 * The fix (see background/service-worker.js's header comment and
 * docs/threat-model.md item #7) moves the authoritative state into the
 * background service worker, keyed per tab id, backed by
 * `chrome.storage.session`. This test proves that specifically:
 *
 *   Part 0 — extension/content/ratelimit.js's exportState()/opts.initialState
 *   round-trip (the mechanism the SW uses to rehydrate/persist a limiter),
 *   tested directly and in isolation from the SW.
 *
 *   Part 1 — the SW's actual RL_CHECK/RL_RECORD/RL_RESUME message handling,
 *   loaded via Node's `vm` module exactly the way
 *   tests/executor_credential.test.js loads guards.js/executor.js: the REAL,
 *   UNMODIFIED source of background/service-worker.js (which itself
 *   `importScripts()`s the REAL, UNMODIFIED content/ratelimit.js — no
 *   reimplementation of either), run inside a sandbox that fakes only the
 *   browser-only surface it touches: `chrome.storage.session` (backed by a
 *   plain in-memory Map the test controls directly — this Map is what
 *   stands in for the real chrome.storage.session's own persistence, which
 *   is exactly what's supposed to survive a re-injection), `chrome.tabs`,
 *   `chrome.runtime.onMessage`, and an injectable clock (patches this vm
 *   context's OWN separate `Date` built-in — proven not to leak to the
 *   outer Node process below — so the test never needs a real sleep).
 *
 *   The "simulated content-script re-injection" is built literally: a
 *   SECOND, completely independent sandbox/vm context/service-worker
 *   instance is constructed (simulating the browser tearing down and
 *   restarting the extension's JS around a navigation/reload — a fresh
 *   `Terminal`, and in principle even a fresh/evicted-and-restarted SW),
 *   sharing only the SAME backing storage Map — exactly the one thing that
 *   is actually guaranteed to survive that in the real extension
 *   (chrome.storage.session, not any in-process JS state). If the budget
 *   and the paused latch are still correct when read from that second,
 *   otherwise-unrelated instance, the persistence claim is proven for real,
 *   not merely asserted.
 *
 * Run: node tests/sw_ratelimit_persistence.test.js
 * Exit code 0 = all assertions passed, nonzero = failure (prints which).
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SW_PATH = path.join(ROOT, 'extension', 'background', 'service-worker.js');
const RATELIMIT_PATH = path.join(ROOT, 'extension', 'content', 'ratelimit.js');
const rateLimitModule = require(RATELIMIT_PATH);

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
// Part 0 — ratelimit.js exportState()/opts.initialState round-trip. Pure,
// no vm/sandbox needed — loaded directly the same way m2_security.test.js
// already does.
// =====================================================================

function testRatelimitStateRoundTrip() {
  console.log('\n[0] ratelimit.js exportState()/opts.initialState — the persistence primitive itself');

  check('exportState() on a fresh limiter is the documented empty shape', () => {
    const rl = rateLimitModule.createRateLimiter({ now: () => 0 });
    const s = rl.exportState();
    assert.deepStrictEqual(s.llmTimestamps, []);
    assert.deepStrictEqual(s.actionTimestamps, []);
    assert.strictEqual(s.paused, false);
    assert.strictEqual(s.pauseReason, null);
  });

  check('a limiter seeded with opts.initialState from a PAUSED exportState() is immediately paused, no calls needed', () => {
    let clock = 0;
    const rl1 = rateLimitModule.createRateLimiter({ now: () => clock, llmMax: 1, llmWindowMs: 60000, actionMax: 100, actionWindowMs: 60000 });
    rl1.recordLlmCall();
    assert.strictEqual(rl1.canCallLlm().allow, false, 'sanity: rl1 should already be paused');
    const exported = rl1.exportState();
    assert.strictEqual(exported.paused, true);
    assert.match(exported.pauseReason, /budget exceeded/);

    // A brand new limiter instance — no calls made on IT at all — seeded
    // from that exported state. This is exactly what the SW does on every
    // message: build a fresh createRateLimiter() and hand it yesterday's
    // (or one-message-ago's) exported state.
    const rl2 = rateLimitModule.createRateLimiter({ now: () => clock, llmMax: 1, llmWindowMs: 60000, actionMax: 100, actionWindowMs: 60000, initialState: exported });
    assert.strictEqual(rl2.canCallLlm().allow, false, 'rehydrated limiter must still be paused with zero calls of its own');
    assert.strictEqual(rl2.remainingBudget().paused, true);
  });

  check('a limiter seeded from a NOT-paused, partially-consumed exportState() keeps the count (not a silent reset)', () => {
    let clock = 0;
    const rl1 = rateLimitModule.createRateLimiter({ now: () => clock, llmMax: 5, llmWindowMs: 60000, actionMax: 5, actionWindowMs: 60000 });
    rl1.recordLlmCall();
    rl1.recordLlmCall();
    rl1.recordAction();
    const exported = rl1.exportState();
    assert.strictEqual(exported.paused, false);
    assert.strictEqual(exported.llmTimestamps.length, 2);
    assert.strictEqual(exported.actionTimestamps.length, 1);

    const rl2 = rateLimitModule.createRateLimiter({ now: () => clock, llmMax: 5, llmWindowMs: 60000, actionMax: 5, actionWindowMs: 60000, initialState: exported });
    const b = rl2.remainingBudget();
    assert.strictEqual(b.llmRemaining, 3, 'a fresh limiter view seeded from the same backing state must NOT report a full budget');
    assert.strictEqual(b.actionRemaining, 4);
  });

  check('opts.initialState is absent/undefined -> unchanged, pre-existing empty-start behavior (backward compatible)', () => {
    const rl = rateLimitModule.createRateLimiter({ now: () => 0, llmMax: 3 });
    assert.strictEqual(rl.remainingBudget().llmRemaining, 3);
  });
}

// =====================================================================
// Part 1 — the SW's real RL_CHECK/RL_RECORD/RL_RESUME message handling,
// loaded via vm from the actual, unmodified source files.
// =====================================================================

// Confirms the Date-patching technique used below does not leak into the
// real Node process's global Date — load-bearing for trusting the rest of
// this file's "no real sleeps" claim.
function testVmClockIsolation() {
  console.log('\n[1] sandbox setup sanity — injected vm clock does not leak to the outer process');
  check('patching Date.now() inside a vm context leaves the outer Date.now() untouched', () => {
    const sandbox = {};
    vm.createContext(sandbox);
    sandbox.__nowRef = { value: 42 };
    vm.runInContext('Date.now = function () { return __nowRef.value; };', sandbox);
    assert.strictEqual(vm.runInContext('Date.now()', sandbox), 42);
    assert.notStrictEqual(Date.now(), 42, 'the vm patch must not have touched the real process Date.now()');
  });
}

// Builds one independent "service worker instance": its own vm context, its
// own fresh load of the real service-worker.js (which importScripts()s the
// real ratelimit.js), its own injectable clock — but sharing the SAME
// `storageMap` object the caller passes in, which is what stands in for the
// one thing that's actually persistent in the real browser
// (chrome.storage.session). Two calls to this function with the same
// storageMap is the literal simulation of "the old JS instance is gone,
// a completely new one exists, only the storage survived."
function buildSwInstance(storageMap, nowRef) {
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const messageListeners = [];
  const tabRemovedListeners = [];

  sandbox.chrome = {
    runtime: {
      onMessage: {
        addListener(fn) { messageListeners.push(fn); },
      },
    },
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
        set(obj) {
          return Promise.resolve().then(() => {
            Object.keys(obj).forEach((k) => storageMap.set(k, obj[k]));
          });
        },
        remove(key) {
          return Promise.resolve().then(() => {
            const keys = Array.isArray(key) ? key : [key];
            keys.forEach((k) => storageMap.delete(k));
          });
        },
      },
    },
    tabs: {
      onRemoved: {
        addListener(fn) { tabRemovedListeners.push(fn); },
      },
    },
  };

  // importScripts: mirrors the REAL relative-path resolution a classic
  // service worker does — '../content/ratelimit.js', resolved relative to
  // this file's own location (extension/background/) — loading the actual
  // unmodified ratelimit.js source, not a reimplementation of its algorithm.
  sandbox.importScripts = function importScripts(...urls) {
    urls.forEach((u) => {
      const resolved = path.join(ROOT, 'extension', 'background', u);
      assert.strictEqual(resolved, RATELIMIT_PATH, `importScripts() must resolve to the real ratelimit.js, got ${resolved}`);
      const src = fs.readFileSync(resolved, 'utf8');
      vm.runInContext(src, sandbox, { filename: u });
    });
  };

  vm.createContext(sandbox);

  // Injectable clock (see testVmClockIsolation above for the isolation
  // proof) — this is what lets Part 1's checks below use a fake, hand-
  // advanced clock instead of real setTimeout/sleep.
  sandbox.__nowRef = nowRef;
  vm.runInContext('Date.now = function () { return __nowRef.value; };', sandbox);

  const swSrc = fs.readFileSync(SW_PATH, 'utf8');
  vm.runInContext(swSrc, sandbox, { filename: 'service-worker.js' });

  assert.strictEqual(messageListeners.length, 1, 'service-worker.js should register exactly one onMessage listener');
  assert.strictEqual(tabRemovedListeners.length, 1, 'service-worker.js should register exactly one chrome.tabs.onRemoved listener');

  const listener = messageListeners[0];
  const tabRemovedListener = tabRemovedListeners[0];

  // Promisifies a call through the real onMessage listener, exactly as
  // Chrome would invoke it (msg, sender, sendResponse), including the
  // `return true` keep-channel-open contract service-worker.js relies on.
  function send(msg, tabId) {
    return new Promise((resolve, reject) => {
      const sender = tabId === null ? {} : { tab: { id: tabId } };
      let responded = false;
      const keepOpen = listener(msg, sender, (resp) => {
        responded = true;
        resolve(resp);
      });
      if (!responded && !keepOpen) {
        reject(new Error(`listener neither responded synchronously nor returned true to keep the channel open for msg ${JSON.stringify(msg)}`));
      }
    });
  }

  return { send, tabRemovedListener, storageMap };
}

async function testSwPersistence() {
  console.log('\n[2] background/service-worker.js RL_* handling — real source, vm-sandboxed browser APIs, injected clock/storage');

  // ---- persistence-across-reinjection + paused-latch-survives ----
  await acheck('LLM budget: burst of RL_CHECK+RL_RECORD trips the pause on the FIRST sw instance', async () => {
    const storageMap = new Map();
    const nowRef = { value: 0 };
    const swA = buildSwInstance(storageMap, nowRef);
    const TAB = 42;

    // Drain the default budget (llmMax=20 per ratelimit.js DEFAULTS) exactly
    // like terminal.js's real _runLlm() flow: RL_CHECK then RL_RECORD, one
    // pair per "LLM call", near-identical rapid-fire.
    for (let i = 0; i < 20; i++) {
      const c = await swA.send({ type: 'RL_CHECK', kind: 'llm' }, TAB);
      assert.strictEqual(c.ok, true, JSON.stringify(c));
      assert.strictEqual(c.allowed, true, `call ${i} should still be allowed, got ${JSON.stringify(c)}`);
      await swA.send({ type: 'RL_RECORD', kind: 'llm' }, TAB);
      nowRef.value += 10;
    }
    const overBudget = await swA.send({ type: 'RL_CHECK', kind: 'llm' }, TAB);
    assert.strictEqual(overBudget.allowed, false, '21st LLM check must be blocked');
    assert.strictEqual(overBudget.paused, true, 'exceeding the budget must latch the pause');
    assert.match(overBudget.reason, /budget exceeded/);
  });

  await acheck('SIMULATED RE-INJECTION: a brand-new sw instance (fresh vm context/module state), SAME storage — the pause is STILL latched, budget is NOT reset to full', async () => {
    const storageMap = new Map();
    const nowRef = { value: 0 };
    const TAB = 42;

    // First instance: drain the budget to trip the pause (same as the check
    // above, condensed).
    const swA = buildSwInstance(storageMap, nowRef);
    for (let i = 0; i < 20; i++) {
      await swA.send({ type: 'RL_CHECK', kind: 'llm' }, TAB);
      await swA.send({ type: 'RL_RECORD', kind: 'llm' }, TAB);
      nowRef.value += 10;
    }
    const trippedOnA = await swA.send({ type: 'RL_CHECK', kind: 'llm' }, TAB);
    assert.strictEqual(trippedOnA.allowed, false, 'sanity: swA should be paused before simulating re-injection');

    // "Re-injection": this is NOT swA again. It is a completely independent
    // vm context, with its own fresh copy of ratelimit.js loaded via its
    // own importScripts() call, its own onMessage listener closure — the
    // only thing it shares with swA is `storageMap`, which stands in for
    // chrome.storage.session (the one thing that's real-browser-persistent
    // across a content-script re-injection / SW eviction+restart).
    const swB = buildSwInstance(storageMap, nowRef);
    assert.notStrictEqual(swB.send, swA.send, 'sanity: swB must be a genuinely separate instance, not swA reused');

    // Advance time far past the 60s window — proves this isn't merely "the
    // pruned-array length happens to still be nonzero", it specifically
    // proves the PAUSED LATCH survived (a pure window-based reset would
    // have cleared by now, per the existing "no silent auto-recovery" M2.3
    // guarantee this file must not regress).
    nowRef.value += 120000;

    const checkOnB = await swB.send({ type: 'RL_CHECK', kind: 'llm' }, TAB);
    assert.strictEqual(checkOnB.ok, true, JSON.stringify(checkOnB));
    assert.strictEqual(checkOnB.allowed, false, 'a freshly (re-)injected instance reading the SAME persisted tab state must still see the pause — this is the headline fix');
    assert.strictEqual(checkOnB.paused, true);
    assert.match(checkOnB.reason, /budget exceeded/, 'the paused reason itself must also survive, not just a bare boolean');

    // And the fix must NOT be a one-way ratchet: `continue` (RL_RESUME) sent
    // to the NEW instance must still be able to clear the SAME persisted
    // latch it just proved it can read.
    const resumeOnB = await swB.send({ type: 'RL_RESUME' }, TAB);
    assert.strictEqual(resumeOnB.resumed, true);
    const checkAfterResume = await swB.send({ type: 'RL_CHECK', kind: 'llm' }, TAB);
    assert.strictEqual(checkAfterResume.allowed, true, 'after RL_RESUME + the window rolling over, a fresh check must be allowed again');
  });

  await acheck('action budget COUNT is tracked independently of the LLM budget COUNT (shared pause latch, independent counters), and survives re-injection', async () => {
    const storageMap = new Map();
    const nowRef = { value: 0 };
    const TAB = 7;

    const swA = buildSwInstance(storageMap, nowRef);
    // Default actionMax is 10 (ratelimit.js DEFAULTS) — drain it.
    for (let i = 0; i < 10; i++) {
      const c = await swA.send({ type: 'RL_CHECK', kind: 'action' }, TAB);
      assert.strictEqual(c.allowed, true, `action ${i} should be allowed`);
      await swA.send({ type: 'RL_RECORD', kind: 'action' }, TAB);
      nowRef.value += 10;
    }
    const trippedOnA = await swA.send({ type: 'RL_CHECK', kind: 'action' }, TAB);
    assert.strictEqual(trippedOnA.allowed, false);

    const swB = buildSwInstance(storageMap, nowRef);
    const checkOnB = await swB.send({ type: 'RL_CHECK', kind: 'action' }, TAB);
    assert.strictEqual(checkOnB.allowed, false, 'action-budget pause must also survive re-injection, not just the LLM one');

    // By design (see ratelimit.js's header comment and
    // tests/m2_security.test.js's "executed-action budget is INDEPENDENT of
    // the LLM-call budget" case), the single `paused` latch is SHARED —
    // exceeding EITHER budget blocks BOTH kinds of check, on purpose ("stop
    // everything until the human types continue", not "stop only the thing
    // that tripped"). So canCallLlm() on this same tab is also correctly
    // blocked here. What's actually independent is the underlying COUNT:
    // the LLM timestamp array on this tab was never touched, which the
    // persisted budget snapshot proves directly — it reports the full LLM
    // allowance untouched, even though the shared latch blocks the check.
    const llmCheck = await swB.send({ type: 'RL_CHECK', kind: 'llm' }, TAB);
    assert.strictEqual(llmCheck.allowed, false, 'the shared pause latch (tripped via the action budget) correctly blocks the LLM check too — same tab, same latch, by design');
    assert.strictEqual(llmCheck.budget.llmRemaining, rateLimitModule.DEFAULTS.llmMax, 'the LLM budget COUNT itself must be untouched — proves the two counters are independently tracked even though the pause latch they can both trip is shared');
  });

  await acheck('per-tab isolation: tab A being paused does not affect tab B\'s budget, even reading through a re-injected instance', async () => {
    const storageMap = new Map();
    const nowRef = { value: 0 };
    const TAB_A = 1;
    const TAB_B = 2;

    const swA = buildSwInstance(storageMap, nowRef);
    for (let i = 0; i < 20; i++) {
      await swA.send({ type: 'RL_CHECK', kind: 'llm' }, TAB_A);
      await swA.send({ type: 'RL_RECORD', kind: 'llm' }, TAB_A);
    }
    const pausedA = await swA.send({ type: 'RL_CHECK', kind: 'llm' }, TAB_A);
    assert.strictEqual(pausedA.allowed, false);

    const swB = buildSwInstance(storageMap, nowRef);
    const freshB = await swB.send({ type: 'RL_CHECK', kind: 'llm' }, TAB_B);
    assert.strictEqual(freshB.allowed, true, 'a different tab id must have its own, untouched budget');
    assert.strictEqual(freshB.budget.llmRemaining, 20);
  });

  await acheck('chrome.tabs.onRemoved clears that tab\'s persisted state (no permission needed — callback receives only tabId/removeInfo)', async () => {
    const storageMap = new Map();
    const nowRef = { value: 0 };
    const TAB = 55;

    const swA = buildSwInstance(storageMap, nowRef);
    for (let i = 0; i < 20; i++) {
      await swA.send({ type: 'RL_CHECK', kind: 'llm' }, TAB);
      await swA.send({ type: 'RL_RECORD', kind: 'llm' }, TAB);
    }
    assert.strictEqual(storageMap.has(`ratelimit:${TAB}`), true, 'sanity: something was actually persisted for this tab');

    // Simulate the tab closing — call the real registered listener directly,
    // exactly as Chrome would invoke it: (tabId, removeInfo).
    await swA.tabRemovedListener(TAB, { windowId: 1, isWindowClosing: false });

    assert.strictEqual(storageMap.has(`ratelimit:${TAB}`), false, 'onRemoved must clear the persisted key for that tab');

    // A subsequent check for the SAME tab id (e.g. a new tab later reusing
    // an id, or just re-querying) now starts fresh, not paused.
    const afterClose = await swA.send({ type: 'RL_CHECK', kind: 'llm' }, TAB);
    assert.strictEqual(afterClose.allowed, true);
    assert.strictEqual(afterClose.budget.llmRemaining, 20);
  });

  await acheck('a message with no sender.tab.id fails CLOSED (blocked), never open', async () => {
    const storageMap = new Map();
    const nowRef = { value: 0 };
    const swA = buildSwInstance(storageMap, nowRef);
    const resp = await swA.send({ type: 'RL_CHECK', kind: 'llm' }, null);
    assert.strictEqual(resp.ok, false);
    assert.strictEqual(resp.allowed, false);
    assert.strictEqual(resp.paused, true);
  });

  await acheck('every RL_* response carries a full budget snapshot (what the titlebar/async fetch reads)', async () => {
    const storageMap = new Map();
    const nowRef = { value: 0 };
    const TAB = 3;
    const swA = buildSwInstance(storageMap, nowRef);
    const resp = await swA.send({ type: 'RL_BUDGET' }, TAB);
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(typeof resp.budget, 'object');
    assert.strictEqual(resp.budget.llmMax, rateLimitModule.DEFAULTS.llmMax);
    assert.strictEqual(resp.budget.actionMax, rateLimitModule.DEFAULTS.actionMax);
    assert.strictEqual(resp.budget.paused, false);
  });
}

// ---- run everything ----

async function main() {
  console.log('tests/sw_ratelimit_persistence.test.js — M2.3 SW-authoritative persistence proof');
  testRatelimitStateRoundTrip();
  testVmClockIsolation();
  await testSwPersistence();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
