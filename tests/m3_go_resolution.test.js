#!/usr/bin/env node
/**
 * tests/m3_go_resolution.test.js — unit proof of the `go` resolution ladder
 * (design doc §2) against the REAL, unmodified `extension/content/nav.js`
 * source (plain CommonJS require — nav.js has no DOM dependency at all, so
 * unlike terminal.js it's directly requireable, same posture as guards.js/
 * ratelimit.js/registry.js).
 *
 * Covers: literal URL/domain resolution (default https scheme, explicit
 * scheme, non-http(s) rejection, "not a domain" rejection so bare-word `go`
 * commands correctly fall through to the nav-lane rather than "succeeding"
 * against garbage), alias-hit resolution (step 2), the needsNavLane signal
 * (step 3), and — the key distinction from guards.safeSameOriginHttpUrl() —
 * that `go` is explicitly NOT restricted to same-origin: it is a trusted,
 * user-typed, address-bar-equivalent command (design §1/§2), unlike the
 * LLM-proposed `navigate`/`click` actions guards.js hard-blocks to
 * same-origin only.
 *
 * Run: node tests/m3_go_resolution.test.js
 */
'use strict';

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const nav = require(path.join(ROOT, 'extension', 'content', 'nav.js'));

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

// ---- resolveLiteralDestination (ladder step 1 primitive) ----

function testResolveLiteralDestination() {
  console.log('\n[1] resolveLiteralDestination — step 1 of the go ladder');

  check('bare domain, no scheme -> defaults to https', () => {
    const r = nav.resolveLiteralDestination('en.wikipedia.org');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.url.href, 'https://en.wikipedia.org/');
  });

  check('explicit https URL with path -> used as-is', () => {
    const r = nav.resolveLiteralDestination('https://x.com/foo');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.url.href, 'https://x.com/foo');
  });

  check('explicit http (not https) -> allowed, scheme preserved', () => {
    const r = nav.resolveLiteralDestination('http://example.com');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.url.protocol, 'http:');
  });

  check('localhost with port -> treated as a usable domain, no dot required', () => {
    const r = nav.resolveLiteralDestination('localhost:8080');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.url.hostname, 'localhost');
    assert.strictEqual(r.url.port, '8080');
  });

  check('javascript: scheme -> REJECTED (non-http(s) floor holds even for a trusted, cross-origin-allowed command)', () => {
    const r = nav.resolveLiteralDestination('javascript:alert(1)');
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.reason, /non-http/);
  });

  check('data: scheme -> REJECTED', () => {
    const r = nav.resolveLiteralDestination('data:text/html,<h1>hi</h1>');
    assert.strictEqual(r.ok, false);
  });

  check('file: scheme -> REJECTED', () => {
    const r = nav.resolveLiteralDestination('file:///etc/passwd');
    assert.strictEqual(r.ok, false);
  });

  check('bare word with no dot ("the") -> REJECTED as "not a domain", so the ladder falls through instead of resolving to https://the/', () => {
    const r = nav.resolveLiteralDestination('the');
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.reason, /does not look like a domain/);
  });

  check('empty string -> REJECTED', () => {
    const r = nav.resolveLiteralDestination('   ');
    assert.strictEqual(r.ok, false);
  });

  check('cross-origin (relative to nothing — go has no "origin" of its own) resolution is simply whatever domain was typed — no same-origin restriction exists here at all, unlike guards.safeSameOriginHttpUrl()', () => {
    const r1 = nav.resolveLiteralDestination('saucedemo.com');
    const r2 = nav.resolveLiteralDestination('en.wikipedia.org');
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    assert.notStrictEqual(r1.url.origin, r2.url.origin, 'sanity: these really are two different origins, and go resolves both — no origin gate exists in this file at all');
  });
}

// ---- resolveGoLadder (the full ladder, steps 1-3) ----

function testResolveGoLadder() {
  console.log('\n[2] resolveGoLadder — the full ladder (design §2)');

  check('step 1 hit: literal domain resolves deterministically, step="literal"', () => {
    const r = nav.resolveGoLadder({ arg: 'en.wikipedia.org' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.step, 'literal');
    assert.strictEqual(r.url.origin, 'https://en.wikipedia.org');
  });

  check('step 2 hit: aliasLookup returning "go en.wikipedia.org" resolves via the alias, step="alias"', () => {
    const r = nav.resolveGoLadder({
      arg: 'wiki',
      aliasLookup: (name) => (name === 'wiki' ? 'go en.wikipedia.org' : null),
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.step, 'alias');
    assert.strictEqual(r.url.origin, 'https://en.wikipedia.org');
  });

  check('step 2 hit: aliasLookup returning a bare destination (no "go " prefix) also resolves', () => {
    const r = nav.resolveGoLadder({
      arg: 'wiki',
      aliasLookup: (name) => (name === 'wiki' ? 'en.wikipedia.org' : null),
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.step, 'alias');
  });

  check('step 2 miss (alias defined but its own expansion is unusable) falls through to needsNavLane, not a crash', () => {
    const r = nav.resolveGoLadder({
      arg: 'broken',
      aliasLookup: (name) => (name === 'broken' ? 'go javascript:evil()' : null),
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.needsNavLane, true);
  });

  check('no aliasLookup provided at all -> step 2 silently skipped, straight to needsNavLane', () => {
    const r = nav.resolveGoLadder({ arg: 'the arch linux wiki' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.needsNavLane, true);
  });

  check('steps 1+2 both miss ("take me to amazon") -> needsNavLane:true (step 3, nav-lane fallback)', () => {
    const r = nav.resolveGoLadder({
      arg: 'take me to amazon',
      aliasLookup: () => null,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.needsNavLane, true);
  });

  check('empty arg -> hard reject, NOT needsNavLane (nothing for even the model to work with)', () => {
    const r = nav.resolveGoLadder({ arg: '   ' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.needsNavLane, undefined);
    assert.match(r.reason, /usage: go/);
  });

  check('the model is NEVER consulted for a step-1/step-2 hit — resolveGoLadder is fully synchronous and pure, no network/async capability exists in this file', () => {
    // Structural proof: nav.js exports nothing that returns a Promise, and
    // the ladder function itself is synchronous (no `async` keyword, no
    // Promise involved) — the ONLY way the model gets consulted is the
    // needsNavLane:true signal, which the CALLER (terminal.js) must act on
    // separately via an explicit NAV_LLM_REQUEST round trip.
    const r = nav.resolveGoLadder({ arg: 'saucedemo.com' });
    assert.strictEqual(r instanceof Promise, false);
    assert.strictEqual(typeof nav.resolveGoLadder, 'function');
    assert.strictEqual(nav.resolveGoLadder.constructor.name, 'Function', 'must not be an async function');
  });
}

// ---- checkArrival (queue continuation's fail-closed guard) ----

function testCheckArrival() {
  console.log('\n[3] checkArrival — arrival-check fail-closed logic');

  check('matching origin -> ok', () => {
    const r = nav.checkArrival('https://example.com', 'https://example.com');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.message, null);
  });

  check('no expected origin recorded (nothing queued) -> ok (nothing to check)', () => {
    const r = nav.checkArrival('https://example.com', null);
    assert.strictEqual(r.ok, true);
  });

  check('mismatched origin -> FAIL CLOSED, message names both origins', () => {
    const r = nav.checkArrival('https://evil.example.net', 'https://saucedemo.com');
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.message, /evil\.example\.net/);
    assert.match(r.message, /saucedemo\.com/);
    assert.match(r.message, /queue halted/);
  });

  check('current origin unknown (null/undefined) with an expected origin recorded -> FAIL CLOSED, not silently ok', () => {
    const r = nav.checkArrival(null, 'https://saucedemo.com');
    assert.strictEqual(r.ok, false);
  });
}

// ---- run everything ----

console.log('tests/m3_go_resolution.test.js — go resolution ladder + arrival check (M3)');
testResolveLiteralDestination();
testResolveGoLadder();
testCheckArrival();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
