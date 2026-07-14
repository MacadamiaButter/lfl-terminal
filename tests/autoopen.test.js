#!/usr/bin/env node
/**
 * tests/autoopen.test.js - unit proof of the auto-open-on-home pure helpers
 * (registry.autoOpenMatch / registry.toggleAutoOpen, added 2026-07-14) against
 * the REAL, unmodified extension/content/registry.js source (plain CommonJS
 * require - registry.js has no DOM dependency, same posture as the other
 * registry tests).
 *
 * These two pure functions are the whole decision surface of the feature; the
 * chrome.storage read/write and the open() call they gate live in terminal.js
 * (DOM/chrome-bound, exercised by the manual live-browser smoke, not here).
 *
 * Covers: exact-origin match only (no prefix/substring bleed between sites),
 * add/remove round-trip, no-mutation of the input list, defensive handling of
 * corrupted stored values (non-array, non-string entries), and the empty-origin
 * no-op.
 *
 * Run: node tests/autoopen.test.js
 */
'use strict';

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const registry = require(path.join(ROOT, 'extension', 'content', 'registry.js'));

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

console.log('\n[1] registry.autoOpenMatch - exact origin membership');

check('matches an origin present in the list', () => {
  assert.strictEqual(registry.autoOpenMatch('https://www.google.com', ['https://www.google.com']), true);
});

check('does not match an origin absent from the list', () => {
  assert.strictEqual(registry.autoOpenMatch('https://example.com', ['https://www.google.com']), false);
});

check('is exact, not prefix/substring (no cross-site bleed)', () => {
  // a stored google entry must never arm google.com.evil.com or a subpath host
  assert.strictEqual(registry.autoOpenMatch('https://www.google.com.evil.com', ['https://www.google.com']), false);
  assert.strictEqual(registry.autoOpenMatch('https://www.google.com', ['https://google.com']), false);
});

check('empty / non-array / null inputs never match', () => {
  assert.strictEqual(registry.autoOpenMatch('https://a.com', []), false);
  assert.strictEqual(registry.autoOpenMatch('', ['https://a.com']), false);
  assert.strictEqual(registry.autoOpenMatch(null, ['https://a.com']), false);
  assert.strictEqual(registry.autoOpenMatch('https://a.com', null), false);
  assert.strictEqual(registry.autoOpenMatch('https://a.com', undefined), false);
});

console.log('\n[2] registry.toggleAutoOpen - immutable add/remove round trip');

check('adds an absent origin and reports enabled=true', () => {
  const r = registry.toggleAutoOpen([], 'https://a.com');
  assert.deepStrictEqual(r.list, ['https://a.com']);
  assert.strictEqual(r.enabled, true);
});

check('removes a present origin and reports enabled=false', () => {
  const r = registry.toggleAutoOpen(['https://a.com', 'https://b.com'], 'https://a.com');
  assert.deepStrictEqual(r.list, ['https://b.com']);
  assert.strictEqual(r.enabled, false);
});

check('does not mutate the input list', () => {
  const input = ['https://a.com'];
  const r = registry.toggleAutoOpen(input, 'https://b.com');
  assert.deepStrictEqual(input, ['https://a.com'], 'input array must be untouched');
  assert.deepStrictEqual(r.list, ['https://a.com', 'https://b.com']);
});

check('round trip (add then remove) returns to the original set', () => {
  const added = registry.toggleAutoOpen(['https://a.com'], 'https://b.com');
  const removed = registry.toggleAutoOpen(added.list, 'https://b.com');
  assert.deepStrictEqual(removed.list, ['https://a.com']);
  assert.strictEqual(removed.enabled, false);
});

check('corrupted stored value (non-array) is treated as empty', () => {
  const r = registry.toggleAutoOpen('not-an-array', 'https://a.com');
  assert.deepStrictEqual(r.list, ['https://a.com']);
  assert.strictEqual(r.enabled, true);
});

check('non-string / empty entries in a corrupted list are dropped', () => {
  const r = registry.toggleAutoOpen(['https://a.com', 42, null, '', {}], 'https://b.com');
  assert.deepStrictEqual(r.list, ['https://a.com', 'https://b.com']);
});

check('empty origin is a no-op that still returns a clean list', () => {
  const r = registry.toggleAutoOpen(['https://a.com'], '');
  assert.deepStrictEqual(r.list, ['https://a.com']);
  assert.strictEqual(r.enabled, false);
});

console.log(`\nautoopen: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
