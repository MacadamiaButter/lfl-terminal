#!/usr/bin/env node
/**
 * tests/toolbar_action.test.js - structural proof of the toolbar-button toggle
 * (2026-07-14). The click path is browser-integration wiring (chrome.action ->
 * chrome.tabs.sendMessage -> content-script chrome.runtime.onMessage) that the
 * vm-sandbox unit tests do not fake, so this suite locks the three pieces
 * together statically (same posture as the isolation grep checks in
 * tests/m4c_highlight.test.js) and guards that the feature added NO new
 * permission - which matters for the Chrome Web Store review.
 *
 * The live toggle itself is covered by the manual live-browser smoke.
 *
 * Run: node tests/toolbar_action.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const sw = fs.readFileSync(path.join(EXT, 'background', 'service-worker.js'), 'utf8');
const term = fs.readFileSync(path.join(EXT, 'content', 'terminal.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   - ${name}`); }
  catch (e) { failed += 1; console.error(`  FAIL - ${name}\n         ${e && e.message ? e.message : e}`); }
}

console.log('tests/toolbar_action.test.js - toolbar toggle wiring + permission guard');

check('manifest declares an action with a default_title and default_icon set', () => {
  assert.ok(manifest.action, 'manifest.action must exist');
  assert.ok(manifest.action.default_title, 'default_title must be set (tooltip)');
  assert.ok(manifest.action.default_icon, 'default_icon must be set');
  for (const sz of ['16', '48', '128']) {
    const rel = manifest.action.default_icon[sz];
    assert.ok(rel, `default_icon must have a ${sz}px entry`);
    assert.ok(fs.existsSync(path.join(EXT, rel)), `icon file ${rel} must exist`);
  }
});

check('the top-level icons set also exists and resolves (store + chrome://extensions)', () => {
  assert.ok(manifest.icons, 'manifest.icons must exist');
  for (const sz of ['16', '48', '128']) {
    assert.ok(fs.existsSync(path.join(EXT, manifest.icons[sz])), `icons.${sz} file must exist`);
  }
});

check('service worker registers chrome.action.onClicked and sends TOGGLE_TERMINAL', () => {
  assert.match(sw, /chrome\.action\.onClicked\.addListener/, 'SW must add an action onClicked listener');
  assert.match(sw, /chrome\.tabs\.sendMessage\([^)]*TOGGLE_TERMINAL|TOGGLE_TERMINAL/, 'SW must send TOGGLE_TERMINAL');
  assert.match(sw, /\.catch\(/, 'the sendMessage must swallow the no-receiver rejection on restricted pages');
});

check('content script listens for TOGGLE_TERMINAL and toggles the overlay', () => {
  assert.match(term, /chrome\.runtime\.onMessage\.addListener/, 'terminal.js must add a runtime.onMessage listener');
  assert.match(term, /TOGGLE_TERMINAL['"]\)\s*this\.toggle\(\)/, 'the handler must match TOGGLE_TERMINAL and call this.toggle()');
});

check('the toolbar toggle added NO new permission (Web Store review surface unchanged)', () => {
  assert.deepStrictEqual(manifest.permissions, ['storage'], 'permissions must still be exactly ["storage"]');
  assert.deepStrictEqual(manifest.host_permissions, ['http://127.0.0.1:1238/*'], 'host_permissions must be unchanged (localhost model only)');
});

console.log(`\ntoolbar_action: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
