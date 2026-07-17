#!/usr/bin/env node
/**
 * tests/theme_contrast.test.js - mechanical gate for the color grammar v2
 * theme fix (2026-07-16, LFL-TERMINAL-COLOR-GRAMMAR-DESIGN.md §1 item 3 /
 * §4). The bug this closes forever: a theme whose --lfl-cmd custom property
 * happened to be byte-identical (or visually indistinguishable) from its
 * --lfl-fg made the live command highlighter invisible - phosphor was an
 * EXACT match (#33ff33 == #33ff33), amber was close enough to read as one
 * (#ffcc66 vs #ffb000). This suite asserts, for every `.lfl-panel.lfl-theme-*`
 * block in extension/content/terminal.css, that --lfl-cmd != --lfl-fg and
 * that --lfl-num/--lfl-sub both exist - the two new tokens color grammar v2
 * added (design doc §3/§4).
 *
 * Deliberately parses terminal.css only, not CSS_TEXT in terminal.js -
 * tests/css_sync.test.js is the separate, already-passing gate that proves
 * the two stay in property-level sync; re-deriving that proof here would be
 * redundant. Same "dumb, flat, on purpose" parsing posture as
 * css_sync.test.js's own parser - a simple regex walk over exactly the
 * four known theme selectors, not a general CSS parser.
 *
 * Run: node tests/theme_contrast.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const TERMINAL_CSS_PATH = path.join(ROOT, 'extension', 'content', 'terminal.css');

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

const THEMES = ['default', 'phosphor', 'amber', 'paper'];

// Extracts one `.lfl-panel.lfl-theme-<name> { ...vars... }` block's custom
// properties as a {propName: value} map (propName without the leading
// "--"). Throws loudly (not a silent empty map) if the block is missing -
// same "fail loud, never mis-parse" posture as css_sync.test.js.
function extractThemeVars(cssText, themeName) {
  const re = new RegExp(`\\.lfl-panel\\.lfl-theme-${themeName}\\s*\\{([^}]*)\\}`);
  const m = re.exec(cssText);
  assert.ok(m, `no .lfl-panel.lfl-theme-${themeName} block found in terminal.css`);
  const body = m[1];
  const vars = {};
  const varRe = /--lfl-([a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let vm;
  while ((vm = varRe.exec(body))) {
    vars[vm[1].toLowerCase()] = vm[2].trim();
  }
  return vars;
}

console.log('tests/theme_contrast.test.js - color grammar v2 theme fix');
console.log('\n[1] every theme block exists and defines --lfl-cmd/--lfl-fg/--lfl-num/--lfl-sub');

const cssText = fs.readFileSync(TERMINAL_CSS_PATH, 'utf8');

for (const theme of THEMES) {
  check(`.lfl-panel.lfl-theme-${theme} defines --lfl-cmd, --lfl-fg, --lfl-num, --lfl-sub`, () => {
    const vars = extractThemeVars(cssText, theme);
    assert.ok(vars.cmd, `${theme}: --lfl-cmd missing`);
    assert.ok(vars.fg, `${theme}: --lfl-fg missing`);
    assert.ok(vars.num, `${theme}: --lfl-num missing (color grammar v2 §4)`);
    assert.ok(vars.sub, `${theme}: --lfl-sub missing (color grammar v2 §4)`);
  });
}

console.log('\n[2] --lfl-cmd != --lfl-fg in every theme (the invisibility bug, closed forever)');

for (const theme of THEMES) {
  check(`${theme}: --lfl-cmd value differs from --lfl-fg value`, () => {
    const vars = extractThemeVars(cssText, theme);
    assert.notStrictEqual(
      vars.cmd.toLowerCase(),
      vars.fg.toLowerCase(),
      `${theme}: --lfl-cmd (${vars.cmd}) must not equal --lfl-fg (${vars.fg})`,
    );
  });
}

console.log('\n[3] the two previously-broken themes carry the exact documented fix values');

check('phosphor: --lfl-cmd is #b3ffb3 (brighter than fg #33ff33), --lfl-sub #66ff66, --lfl-num #99ff99', () => {
  const vars = extractThemeVars(cssText, 'phosphor');
  assert.strictEqual(vars.cmd.toLowerCase(), '#b3ffb3');
  assert.strictEqual(vars.sub.toLowerCase(), '#66ff66');
  assert.strictEqual(vars.num.toLowerCase(), '#99ff99');
});

check('amber: --lfl-cmd is #ffe3a1, --lfl-sub #ffcc66, --lfl-num #ffd166', () => {
  const vars = extractThemeVars(cssText, 'amber');
  assert.strictEqual(vars.cmd.toLowerCase(), '#ffe3a1');
  assert.strictEqual(vars.sub.toLowerCase(), '#ffcc66');
  assert.strictEqual(vars.num.toLowerCase(), '#ffd166');
});

check('default: --lfl-cmd unchanged (#8fd0ff), --lfl-sub #6fa8d8, --lfl-num #e0a339', () => {
  const vars = extractThemeVars(cssText, 'default');
  assert.strictEqual(vars.cmd.toLowerCase(), '#8fd0ff');
  assert.strictEqual(vars.sub.toLowerCase(), '#6fa8d8');
  assert.strictEqual(vars.num.toLowerCase(), '#e0a339');
});

check('paper: --lfl-cmd unchanged (#0b5fa5), --lfl-sub #4a86c4, --lfl-num #a15c00', () => {
  const vars = extractThemeVars(cssText, 'paper');
  assert.strictEqual(vars.cmd.toLowerCase(), '#0b5fa5');
  assert.strictEqual(vars.sub.toLowerCase(), '#4a86c4');
  assert.strictEqual(vars.num.toLowerCase(), '#a15c00');
});

console.log(`\ntheme_contrast: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
