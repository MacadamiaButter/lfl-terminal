#!/usr/bin/env node
/**
 * tests/panel_placement.test.js - unit proof of the cursor-anchored popover
 * placement math (registry.placePanel/defaultAnchor, added 2026-07-15,
 * LFL-TERMINAL-POPOVER-REDESIGN.md §4) against the REAL, unmodified
 * extension/content/registry.js source (plain CommonJS require - no DOM
 * dependency, same posture as tests/panel_resize.test.js).
 *
 * Run: node tests/panel_placement.test.js
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

const MARGIN = registry.PANEL_PLACEMENT_MARGIN; // 8
const OFFSET = registry.PANEL_PLACEMENT_OFFSET; // 14
const VP_W = 1200;
const VP_H = 800;
const PANEL_W = 520;
const PANEL_H = 300;

check('center anchor: below-and-right of the anchor, offset applied', () => {
  const { left, top } = registry.placePanel({
    anchorX: 500, anchorY: 400, panelW: PANEL_W, panelH: PANEL_H, vpW: VP_W, vpH: VP_H,
  });
  assert.strictEqual(left, 500);
  assert.strictEqual(top, 400 + OFFSET);
});

check('top-left corner: left clamps to the margin, top just uses the ordinary offset', () => {
  const { left, top } = registry.placePanel({
    anchorX: 0, anchorY: 0, panelW: PANEL_W, panelH: PANEL_H, vpW: VP_W, vpH: VP_H,
  });
  assert.strictEqual(left, MARGIN);
  assert.strictEqual(top, OFFSET);
});

check('top-right corner: shifts left so the panel stays on-screen, top unaffected', () => {
  const { left, top } = registry.placePanel({
    anchorX: VP_W, anchorY: 0, panelW: PANEL_W, panelH: PANEL_H, vpW: VP_W, vpH: VP_H,
  });
  assert.strictEqual(left, VP_W - MARGIN - PANEL_W);
  assert.strictEqual(top, OFFSET);
});

check('bottom-left corner: flips ABOVE the anchor instead of clamping to the bottom edge', () => {
  const { left, top } = registry.placePanel({
    anchorX: 0, anchorY: VP_H, panelW: PANEL_W, panelH: PANEL_H, vpW: VP_W, vpH: VP_H,
  });
  assert.strictEqual(left, MARGIN);
  assert.strictEqual(top, VP_H - PANEL_H - OFFSET);
});

check('bottom-right corner: flip-above AND shift-left both apply simultaneously', () => {
  const { left, top } = registry.placePanel({
    anchorX: VP_W, anchorY: VP_H, panelW: PANEL_W, panelH: PANEL_H, vpW: VP_W, vpH: VP_H,
  });
  assert.strictEqual(left, VP_W - MARGIN - PANEL_W);
  assert.strictEqual(top, VP_H - PANEL_H - OFFSET);
});

check('panel wider than the viewport: clamps to the left margin, never negative', () => {
  const { left } = registry.placePanel({
    anchorX: 600, anchorY: 100, panelW: VP_W + 400, panelH: PANEL_H, vpW: VP_W, vpH: VP_H,
  });
  assert.strictEqual(left, MARGIN);
});

check('panel taller than the viewport (flip would still overflow): clamps to the top margin', () => {
  const { top } = registry.placePanel({
    anchorX: 100, anchorY: 400, panelW: PANEL_W, panelH: VP_H + 400, vpW: VP_W, vpH: VP_H,
  });
  assert.strictEqual(top, MARGIN);
});

check('result is always within [margin, vp-margin] on both axes for an ordinary panel', () => {
  const cases = [
    { anchorX: 300, anchorY: 300 },
    { anchorX: 50, anchorY: 750 },
    { anchorX: 1150, anchorY: 50 },
  ];
  for (const c of cases) {
    const { left, top } = registry.placePanel({
      anchorX: c.anchorX, anchorY: c.anchorY, panelW: PANEL_W, panelH: PANEL_H, vpW: VP_W, vpH: VP_H,
    });
    assert.ok(left >= MARGIN && left + PANEL_W <= VP_W - MARGIN + 0.001, `left=${left} out of bounds`);
    assert.ok(top >= MARGIN && top + PANEL_H <= VP_H - MARGIN + 0.001, `top=${top} out of bounds`);
  }
});

check('defaultAnchor: keyboard-summon fallback is horizontally centered, near the top', () => {
  const a = registry.defaultAnchor(VP_W, VP_H, PANEL_W);
  assert.strictEqual(a.x, (VP_W - PANEL_W) / 2);
  assert.strictEqual(a.y, VP_H * 0.12);
});

check('defaultAnchor -> placePanel round trip stays fully on-screen', () => {
  const anchor = registry.defaultAnchor(VP_W, VP_H, PANEL_W);
  const { left, top } = registry.placePanel({
    anchorX: anchor.x, anchorY: anchor.y, panelW: PANEL_W, panelH: PANEL_H, vpW: VP_W, vpH: VP_H,
  });
  assert.ok(left >= MARGIN && left + PANEL_W <= VP_W - MARGIN + 0.001);
  assert.ok(top >= MARGIN && top + PANEL_H <= VP_H - MARGIN + 0.001);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
