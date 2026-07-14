#!/usr/bin/env node
/**
 * tests/panel_resize.test.js - unit proof of the collapse+resize height math
 * (registry.clampPanelHeightVh / stepPanelPreset, added 2026-07-14) against the
 * REAL, unmodified extension/content/registry.js source (plain CommonJS require
 * - no DOM dependency, same posture as tests/autoopen.test.js).
 *
 * These two pure functions are the whole decision surface for panel height; the
 * DOM (drag grip, Ctrl+Up/Down keys, collapse class) and chrome.storage glue
 * live in terminal.js and are exercised by the manual live-browser smoke.
 *
 * Run: node tests/panel_resize.test.js
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

const PRESETS = registry.PANEL_PRESETS_VH; // [22, 34, 46]
const DEFAULT = registry.PANEL_DEFAULT_VH; // 34
const MIN = 12;
const MAX = 80;

console.log('\n[0] exported constants sane');

check('presets are ascending, default is one of them', () => {
  assert.deepStrictEqual([...PRESETS], [22, 34, 46]);
  assert.strictEqual(DEFAULT, 34);
  assert.ok(PRESETS.includes(DEFAULT));
});

console.log('\n[1] clampPanelHeightVh - range + garbage handling');

check('passes a valid in-range value through', () => {
  assert.strictEqual(registry.clampPanelHeightVh(34), 34);
  assert.strictEqual(registry.clampPanelHeightVh(50), 50);
});

check('clamps below the floor and above the ceiling', () => {
  assert.strictEqual(registry.clampPanelHeightVh(1), MIN);
  assert.strictEqual(registry.clampPanelHeightVh(-100), MIN);
  assert.strictEqual(registry.clampPanelHeightVh(999), MAX);
});

check('NaN / non-numeric / missing falls back to the default (never NaN)', () => {
  assert.strictEqual(registry.clampPanelHeightVh(NaN), DEFAULT);
  assert.strictEqual(registry.clampPanelHeightVh('abc'), DEFAULT);
  assert.strictEqual(registry.clampPanelHeightVh(undefined), DEFAULT);
  // note: Number(null) === 0 (a finite number), so null clamps to MIN, not the
  // default - a deliberate, documented quirk, verified here so it can't silently
  // change.
  assert.strictEqual(registry.clampPanelHeightVh(null), MIN);
});

check('numeric string is coerced then clamped', () => {
  assert.strictEqual(registry.clampPanelHeightVh('40'), 40);
  assert.strictEqual(registry.clampPanelHeightVh('5'), MIN);
});

console.log('\n[2] stepPanelPreset - ladder stepping, clamped at ends');

check('from a preset, +1 goes to the next taller preset', () => {
  assert.strictEqual(registry.stepPanelPreset(22, 1), 34);
  assert.strictEqual(registry.stepPanelPreset(34, 1), 46);
});

check('from a preset, -1 goes to the next shorter preset', () => {
  assert.strictEqual(registry.stepPanelPreset(46, -1), 34);
  assert.strictEqual(registry.stepPanelPreset(34, -1), 22);
});

check('stepping past the top/bottom clamps to that end', () => {
  assert.strictEqual(registry.stepPanelPreset(46, 1), 46);
  assert.strictEqual(registry.stepPanelPreset(22, -1), 22);
});

check('an off-preset height (from a free drag) snaps to the next preset in the pressed direction', () => {
  assert.strictEqual(registry.stepPanelPreset(40, 1), 46);  // between 34 and 46, taller -> 46
  assert.strictEqual(registry.stepPanelPreset(40, -1), 34); // between 34 and 46, shorter -> 34
  assert.strictEqual(registry.stepPanelPreset(28, 1), 34);
  assert.strictEqual(registry.stepPanelPreset(28, -1), 22);
});

check('dir 0 returns the clamped current height unchanged', () => {
  assert.strictEqual(registry.stepPanelPreset(34, 0), 34);
  assert.strictEqual(registry.stepPanelPreset(999, 0), MAX);
});

check('garbage current height is clamped before stepping (no NaN escapes)', () => {
  assert.strictEqual(registry.stepPanelPreset(NaN, 1), 46);   // NaN -> default 34 -> +1 -> 46
  assert.strictEqual(registry.stepPanelPreset('x', -1), 22);  // -> 34 -> -1 -> 22
});

console.log(`\npanel_resize: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
