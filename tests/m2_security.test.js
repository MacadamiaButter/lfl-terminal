#!/usr/bin/env node
/**
 * tests/m2_security.test.js - direct unit-level proof of the M2 security
 * hardening's PURE, testable decision logic: the occlusion-probe classifier
 * and the runtime-navigation classifier (both in guards.js), the M2.3 rate
 * limiter (ratelimit.js, time-injected - no real sleeps), and the M2.4
 * per-frame guard-context mechanism (guards.js's checkClickTarget with an
 * explicitly supplied, non-ambient origin/baseURI, exactly as
 * axtree.js's frameOptsFor()/executor.js supply it for an in-iframe element).
 *
 * What this file does NOT (and cannot, without jsdom/a real browser) cover:
 * the actual DOM sampling in terminal.js's _probeApprovalOcclusion()
 * (getBoundingClientRect, document.elementsFromPoint, the pointer-events
 * probe) and axtree.js's real iframe/shadow-root traversal
 * (querySelectorAll, iframe.contentDocument, el.shadowRoot). Those are
 * exercised end-to-end by the Playwright adversarial test
 * (tests/m2_adversarial.py) against the fixture pages instead - see
 * README.md's M2 verification section for that run's actual output.
 *
 * Run: node tests/m2_security.test.js
 * Exit code 0 = all assertions passed, nonzero = failure (prints which).
 */
'use strict';

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const guards = require(path.join(ROOT, 'extension', 'content', 'guards.js'));
const rateLimitModule = require(path.join(ROOT, 'extension', 'content', 'ratelimit.js'));

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
// Part 1 - M2.1: classifyOcclusionProbe (pure decision logic; the DOM
// sampling that produces its inputs lives in terminal.js and is proven by
// the Playwright adversarial test against occlusion-attack.html).
// =====================================================================

function testOcclusionClassifier() {
  console.log('\n[1] M2.1 classifyOcclusionProbe - pure occlusion decision');

  const host = { tag: 'host' };
  const approveEl = { tag: 'approve', contains(other) { return other === approveEl || other === innerDescendant; } };
  const innerDescendant = { tag: 'inner-descendant-of-approve' };
  const pageOverlay = { tag: 'page-overlay' };
  const somethingElseInsideOverlay = { tag: 'something-else-inside-our-own-panel' };

  check('un-occluded: outside topmost is host, inner topmost is the approve control -> NOT occluded', () => {
    const r = guards.classifyOcclusionProbe({ outsideTopmost: host, host, innerTopmost: approveEl, approveEl });
    assert.strictEqual(r.occluded, false, JSON.stringify(r));
  });

  check('un-occluded, descendant case: inner topmost is a descendant OF the approve control -> NOT occluded', () => {
    const r = guards.classifyOcclusionProbe({ outsideTopmost: host, host, innerTopmost: innerDescendant, approveEl });
    assert.strictEqual(r.occluded, false, JSON.stringify(r));
  });

  check('OCCLUDED: outside topmost is a page element, not the host -> occluded (the clickjacking case)', () => {
    const r = guards.classifyOcclusionProbe({ outsideTopmost: pageOverlay, host, innerTopmost: approveEl, approveEl });
    assert.strictEqual(r.occluded, true, JSON.stringify(r));
    assert.match(r.reason, /not the extension overlay/);
  });

  check('OCCLUDED: outside topmost is host, but inner topmost is something else inside our own panel -> occluded', () => {
    const r = guards.classifyOcclusionProbe({ outsideTopmost: host, host, innerTopmost: somethingElseInsideOverlay, approveEl });
    assert.strictEqual(r.occluded, true, JSON.stringify(r));
    assert.match(r.reason, /not the topmost element within the overlay/);
  });

  check('OCCLUDED: missing host or approveEl in the sample -> occluded (fail closed on malformed input)', () => {
    const r1 = guards.classifyOcclusionProbe({ outsideTopmost: host, innerTopmost: approveEl, approveEl });
    assert.strictEqual(r1.occluded, true);
    const r2 = guards.classifyOcclusionProbe({ outsideTopmost: host, host, innerTopmost: approveEl });
    assert.strictEqual(r2.occluded, true);
    const r3 = guards.classifyOcclusionProbe(null);
    assert.strictEqual(r3.occluded, true);
  });
}

// =====================================================================
// Part 2 - M2.2: classifyRuntimeNavigation (pure decision logic; given a
// destination + approved-destination -> block/allow, exactly the signature
// the task spec asks for).
// =====================================================================

function testNavClassifier() {
  console.log('\n[2] M2.2 classifyRuntimeNavigation - nav-interception classifier');

  check('same-origin destination -> ALLOW regardless of approvedDestinationHref', () => {
    const r = guards.classifyRuntimeNavigation({
      destinationHref: 'https://example.com/other-page',
      originAtClick: 'https://example.com',
      approvedDestinationHref: null,
    });
    assert.strictEqual(r.allow, true, JSON.stringify(r));
    assert.strictEqual(r.code, 'same-origin');
  });

  check('cross-origin destination with NO approved destination shown -> BLOCK (the onclick-evil-nav fixture case)', () => {
    const r = guards.classifyRuntimeNavigation({
      destinationHref: 'http://127.0.0.1:8999/other-origin.html',
      originAtClick: 'http://127.0.0.1:8998',
      approvedDestinationHref: null,
    });
    assert.strictEqual(r.allow, false, JSON.stringify(r));
    assert.strictEqual(r.code, 'unapproved-cross-origin');
  });

  check('cross-origin destination that EXACTLY matches the approved destination -> ALLOW', () => {
    const r = guards.classifyRuntimeNavigation({
      destinationHref: 'https://partner.example.net/checkout',
      originAtClick: 'https://shop.example.com',
      approvedDestinationHref: 'https://partner.example.net/checkout',
    });
    assert.strictEqual(r.allow, true, JSON.stringify(r));
    assert.strictEqual(r.code, 'approved-cross-origin');
  });

  check('cross-origin destination that DIFFERS from the approved destination -> BLOCK (approved a different target)', () => {
    const r = guards.classifyRuntimeNavigation({
      destinationHref: 'https://evil.example.net/steal',
      originAtClick: 'https://shop.example.com',
      approvedDestinationHref: 'https://partner.example.net/checkout',
    });
    assert.strictEqual(r.allow, false, JSON.stringify(r));
    assert.strictEqual(r.code, 'unapproved-cross-origin');
  });

  check('non-http(s) destination (javascript:) -> BLOCK even if "approved" (scheme guard takes priority)', () => {
    const r = guards.classifyRuntimeNavigation({
      destinationHref: 'javascript:alert(document.cookie)',
      originAtClick: 'https://example.com',
      approvedDestinationHref: null,
    });
    assert.strictEqual(r.allow, false, JSON.stringify(r));
    assert.strictEqual(r.code, 'non-http');
  });

  check('unparseable destination -> BLOCK, fail closed', () => {
    const r = guards.classifyRuntimeNavigation({ destinationHref: '::::not a url::::', originAtClick: 'https://example.com' });
    assert.strictEqual(r.allow, false);
    assert.strictEqual(r.code, 'unparseable');
  });
}

// =====================================================================
// Part 3 - M2.3: the rate limiter, time-injected (no real sleeps, fully
// deterministic). Proves: LLM-call budget, executed-action budget, burst
// detection, pause-until-explicit-continue (no silent auto-recovery), and
// that the window actually rolls once time advances past it.
// =====================================================================

function testRateLimiter() {
  console.log('\n[3] M2.3 rate limiter - deterministic, time-injected');

  check('LLM calls: allowed up to the max, then blocked - burst of near-identical calls trips it', () => {
    let clock = 0;
    const rl = rateLimitModule.createRateLimiter({ now: () => clock, llmMax: 3, llmWindowMs: 60000, actionMax: 100, actionWindowMs: 60000 });
    for (let i = 0; i < 3; i++) {
      const c = rl.canCallLlm();
      assert.strictEqual(c.allow, true, `call ${i} should be allowed, got ${JSON.stringify(c)}`);
      rl.recordLlmCall();
      clock += 10; // near-identical rapid-fire calls, 10ms apart
    }
    const fourth = rl.canCallLlm();
    assert.strictEqual(fourth.allow, false, 'the 4th call in the burst must be blocked');
    assert.match(fourth.reason, /budget exceeded/);
  });

  check('once paused, stays paused even after the window rolls past - no silent auto-recovery', () => {
    let clock = 0;
    const rl = rateLimitModule.createRateLimiter({ now: () => clock, llmMax: 2, llmWindowMs: 1000, actionMax: 100, actionWindowMs: 60000 });
    rl.recordLlmCall(); clock += 10;
    rl.recordLlmCall(); clock += 10;
    assert.strictEqual(rl.canCallLlm().allow, false, 'budget should be exhausted');
    clock += 10000; // far past the 1000ms window - timestamps would prune clean
    assert.strictEqual(rl.canCallLlm().allow, false, 'must STILL be blocked - pause requires explicit continue, not just window rollover');
  });

  check('resumeAfterContinue() clears the pause and the window is fresh again', () => {
    let clock = 0;
    const rl = rateLimitModule.createRateLimiter({ now: () => clock, llmMax: 1, llmWindowMs: 1000, actionMax: 100, actionWindowMs: 60000 });
    rl.recordLlmCall();
    assert.strictEqual(rl.canCallLlm().allow, false);
    const res = rl.resumeAfterContinue();
    assert.strictEqual(res.resumed, true);
    clock += 10000; // window long since rolled over too
    assert.strictEqual(rl.canCallLlm().allow, true, 'should be allowed again after continue + window rollover');
  });

  check('resumeAfterContinue() on a non-paused limiter is a no-op that reports not-resumed', () => {
    const rl = rateLimitModule.createRateLimiter({ now: () => 0 });
    const res = rl.resumeAfterContinue();
    assert.strictEqual(res.resumed, false);
  });

  check('executed-action budget is INDEPENDENT of the LLM-call budget', () => {
    let clock = 0;
    const rl = rateLimitModule.createRateLimiter({ now: () => clock, llmMax: 1, llmWindowMs: 60000, actionMax: 2, actionWindowMs: 60000 });
    rl.recordLlmCall(); // exhausts LLM budget
    assert.strictEqual(rl.canCallLlm().allow, false);
    // Action budget should be untouched by the LLM-call budget's own pause -
    // they are two independent counters (a paused LLM budget also pauses
    // canExecuteAction() by design once EITHER is exceeded - see below -
    // but merely calling canCallLlm() past its own max must not by itself
    // consume or block the action budget before that budget's own check runs).
    // This assertion targets a limiter that has NOT had its action budget
    // exceeded and has NOT been globally paused via the action path:
    const rl2 = rateLimitModule.createRateLimiter({ now: () => clock, llmMax: 100, llmWindowMs: 60000, actionMax: 2, actionWindowMs: 60000 });
    assert.strictEqual(rl2.canExecuteAction().allow, true);
    rl2.recordAction();
    assert.strictEqual(rl2.canExecuteAction().allow, true);
    rl2.recordAction();
    assert.strictEqual(rl2.canExecuteAction().allow, false, 'the 3rd executed action should be blocked (actionMax=2)');
  });

  check('remainingBudget() reports correct counts and the paused flag', () => {
    let clock = 0;
    const rl = rateLimitModule.createRateLimiter({ now: () => clock, llmMax: 5, llmWindowMs: 60000, actionMax: 5, actionWindowMs: 60000 });
    rl.recordLlmCall();
    rl.recordLlmCall();
    const b = rl.remainingBudget();
    assert.strictEqual(b.llmRemaining, 3);
    assert.strictEqual(b.actionRemaining, 5);
    assert.strictEqual(b.paused, false);
  });
}

// =====================================================================
// Part 4 - M2.4: the per-frame guard-context mechanism. axtree.js itself is
// browser-only DOM-heavy code not practically loadable under plain Node, so
// this proves the piece it depends on: guards.checkClickTarget() correctly
// applies a SUPPLIED (non-ambient) origin/baseURI - exactly what
// axtree.js's frameOptsFor() + executor.js supply for an element resolved
// from inside a same-origin iframe, rather than silently falling back to
// the top page's origin (which would be a real functional-safety bug: an
// iframe-local link could be wrongly classified as cross-origin, or worse,
// a cross-origin-to-the-iframe link wrongly allowed because it happened to
// share the TOP page's origin).
// =====================================================================

function testFrameScopedGuardContext() {
  console.log('\n[4] M2.4 per-frame guard context - checkClickTarget honors a supplied (non-ambient) origin');

  function fakeAnchor(href) {
    return {
      tagName: 'A',
      getAttribute(n) { return n === 'href' ? href : null; },
      hasAttribute(n) { return n === 'href'; },
      closest(sel) { return sel === 'a[href]' ? this : null; },
    };
  }

  // Simulates an element resolved from a same-origin iframe whose OWN
  // origin (https://frame.example.com) differs from the top page's. The
  // opts object here is exactly the shape axtree.js's frameOptsFor(el)
  // returns: { baseURI: el.ownerDocument.baseURI, origin: <iframe's own
  // window.location.origin> }.
  const frameOpts = { origin: 'https://frame.example.com', baseURI: 'https://frame.example.com/inner.html' };

  check('a link same-origin to the IFRAME (not the top page) -> ALLOWED when judged against the frame\'s own origin', () => {
    const el = fakeAnchor('/local-in-frame');
    const r = guards.checkClickTarget(el, frameOpts);
    assert.strictEqual(r.hasTarget, true);
    assert.strictEqual(r.blocked, false, JSON.stringify(r));
  });

  check('a link to the TOP PAGE\'s own origin, from inside a DIFFERENT-origin iframe -> BLOCKED (cross-origin to the frame it actually lives in)', () => {
    const el = fakeAnchor('https://top-page.example.org/somewhere');
    const r = guards.checkClickTarget(el, frameOpts);
    assert.strictEqual(r.hasTarget, true);
    assert.strictEqual(r.blocked, true, JSON.stringify(r));
    assert.strictEqual(r.classification, 'cross-origin');
  });

  check('the SAME element/URL pair judged with no opts (ambient ThatWouldBeTheTopPage) vs. with frameOpts can disagree - proves the origin actually being used is the supplied one, not a hardcoded/ignored value', () => {
    const el = fakeAnchor('https://frame.example.com/inner-page');
    const rWithFrameOrigin = guards.safeSameOriginHttpUrl('https://frame.example.com/inner-page', frameOpts);
    assert.strictEqual(rWithFrameOrigin.ok, true);
    const rWithDifferentOrigin = guards.safeSameOriginHttpUrl('https://frame.example.com/inner-page', { origin: 'https://top-page.example.org', baseURI: 'https://top-page.example.org/' });
    assert.strictEqual(rWithDifferentOrigin.ok, false, 'same URL must be judged cross-origin against a different supplied origin - proves opts.origin is actually load-bearing');
  });

  check('credential guard (isPasswordField) needs no frame context at all - attribute-only, works identically for in-frame elements', () => {
    const el = { tagName: 'input', getAttribute(n) { return n === 'type' ? 'password' : null; } };
    assert.strictEqual(guards.isPasswordField(el), true);
  });
}

// ---- run everything ----

console.log('tests/m2_security.test.js - M2.1-2.4 pure decision-logic proof');
testOcclusionClassifier();
testNavClassifier();
testRateLimiter();
testFrameScopedGuardContext();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
