#!/usr/bin/env node
/**
 * tests/m5b_script_sharing.test.js - unit proof of scripts v1 P2 (portability):
 * registry.js's serializeScripts()/parseScriptFile() against the REAL,
 * unmodified extension/content/registry.js source, plus a structural
 * assertion that no new manifest permission was added for it.
 *
 * Design doc: LFL-TERMINAL-SCRIPTS-DESIGN.md, "P2 - portability" phase +
 * §9 sign-off #4 (.lflscript = plain step-per-line text with a
 * `#!lflscript v1` header the importer version-gates on).
 *
 * THE SECURITY INVARIANT under test (§ "import security matrix" below):
 * an imported .lflscript file is untrusted text. parseScriptFile() only
 * splits the file into {name, body} pairs - it validates nothing about a
 * body. The ONE thing that makes an imported script trustworthy is feeding
 * every parsed pair through createAliasStore().setScript(), the exact same
 * write path a hand-typed `script new` body goes through (re-running
 * parseScriptBody()'s step cap / index-verb rejection / games-funpack-
 * nested-run locks, and the one-flat-namespace collision checks). This file
 * proves that at the registry.js layer; terminal.js's _importScriptText()
 * (exercised only by the manual smoke - see this build's report) is the
 * thin glue that always calls setScript(), never writes the scripts map
 * directly.
 *
 * The actual DOM (Blob URL + <a download> click, <input type=file> picker)
 * cannot be unit-tested headlessly - no real file-save/file-pick dialog in
 * Node. That is thin, deliberately dumb glue in terminal.js
 * (_downloadTextFile/_handleScriptImport) around the pure functions proven
 * here; see this build's report for the manual live-browser smoke steps.
 *
 * Run: node tests/m5b_script_sharing.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
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

function fakeStorageArea() {
  let store = {};
  return {
    get(keys, cb) {
      const out = {};
      keys.forEach((k) => { if (store[k] !== undefined) out[k] = store[k]; });
      cb(out);
    },
    set(obj) { store = Object.assign({}, store, obj); },
  };
}

// =====================================================================
// [0] serializeScripts -> parseScriptFile round trip
// =====================================================================
console.log('\n[0] serializeScripts -> parseScriptFile round trip preserves names + bodies exactly');

check('a single script round-trips: header, name, body all preserved', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  store.setScript('checkout', 'go example.com\nsearch "$1"\nfill email with test@example.com\n');
  const text = registry.serializeScripts(store.listScripts());
  assert.match(text, /^#!lflscript v1\n/);
  assert.match(text, /#!script checkout\n/);
  const parsed = registry.parseScriptFile(text);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.version, 'v1');
  assert.strictEqual(parsed.scripts.length, 1);
  assert.strictEqual(parsed.scripts[0].name, 'checkout');
  assert.strictEqual(parsed.scripts[0].body, 'go example.com\nsearch "$1"\nfill email with test@example.com');
});

check('multiple scripts round-trip independently, sorted by name, no cross-contamination', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  store.setScript('zeta', 'go zeta.example.com\n');
  store.setScript('alpha', 'go alpha.example.com\nsearch "$1"\n');
  const text = registry.serializeScripts(store.listScripts());
  // deterministic: alpha's header appears before zeta's
  assert.ok(text.indexOf('#!script alpha') < text.indexOf('#!script zeta'));
  const parsed = registry.parseScriptFile(text);
  assert.strictEqual(parsed.ok, true);
  const byName = {};
  parsed.scripts.forEach((s) => { byName[s.name] = s.body; });
  assert.strictEqual(byName.alpha, 'go alpha.example.com\nsearch "$1"');
  assert.strictEqual(byName.zeta, 'go zeta.example.com');
});

check('a script whose body itself contains a "#" comment-shaped line round-trips through setScript unchanged (comments are stripped at write time, not by the file parser)', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  // setScript already strips comment/blank lines via parseScriptBody before
  // ever reaching serializeScripts - so the stored body has no comment
  // lines left for the file format to worry about colliding with.
  store.setScript('withcomment', 'go example.com\n# a real comment\nsearch "$1"\n');
  const text = registry.serializeScripts(store.listScripts());
  const parsed = registry.parseScriptFile(text);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.scripts[0].body, 'go example.com\nsearch "$1"');
});

check('empty scripts object serializes to just the header (no sections) and fails to re-parse (no scripts found) - callers must guard the empty case before offering export', () => {
  const text = registry.serializeScripts({});
  assert.strictEqual(text, '#!lflscript v1\n');
  const parsed = registry.parseScriptFile(text);
  assert.strictEqual(parsed.ok, false);
  assert.match(parsed.reason, /no scripts found/);
});

// =====================================================================
// [1] version-gating: missing/unknown header is rejected outright
// =====================================================================
console.log('\n[1] parseScriptFile rejects a missing or wrong #!lflscript header');

check('a file with no header at all is rejected', () => {
  const parsed = registry.parseScriptFile('#!script checkout\ngo example.com\n');
  assert.strictEqual(parsed.ok, false);
  assert.match(parsed.reason, /missing or unknown/);
});

check('a file with a wrong/future version header is rejected, not best-effort parsed', () => {
  const parsed = registry.parseScriptFile('#!lflscript v2\n#!script checkout\ngo example.com\n');
  assert.strictEqual(parsed.ok, false);
  assert.match(parsed.reason, /missing or unknown/);
});

check('a completely unrelated text file is rejected', () => {
  const parsed = registry.parseScriptFile('just some random notes\nnothing structured here\n');
  assert.strictEqual(parsed.ok, false);
});

check('leading blank lines before a valid header are tolerated', () => {
  const parsed = registry.parseScriptFile('\n\n#!lflscript v1\n#!script x\ngo example.com\n');
  assert.strictEqual(parsed.ok, true);
});

check('content before the first "#!script <name>" header (after a valid version line) is a structural error', () => {
  const parsed = registry.parseScriptFile('#!lflscript v1\ngo example.com\n#!script x\ngo example.com\n');
  assert.strictEqual(parsed.ok, false);
  assert.match(parsed.reason, /content found before any/);
});

check('a duplicate script name within one file is rejected', () => {
  const parsed = registry.parseScriptFile('#!lflscript v1\n#!script dup\ngo a.com\n#!script dup\ngo b.com\n');
  assert.strictEqual(parsed.ok, false);
  assert.match(parsed.reason, /duplicate script name/);
});

// =====================================================================
// [2] THE IMPORT SECURITY MATRIX (most important) - an imported file can
// never smuggle in an index-addressed step, and can never silently
// overwrite an existing alias/macro/script. This exercises the exact
// wiring terminal.js's _importScriptText() uses: parse the file structure,
// then feed each {name, body} pair through setScript() - never store a
// parsed pair directly.
// =====================================================================
console.log('\n[2] THE IMPORT SECURITY MATRIX - setScript() re-validation on import');

function importFile(store, text) {
  const parsed = registry.parseScriptFile(text);
  assert.strictEqual(parsed.ok, true, `test file itself should parse: ${parsed.reason}`);
  const imported = [];
  const skipped = [];
  for (const entry of parsed.scripts) {
    const res = store.setScript(entry.name.toLowerCase(), entry.body);
    if (res.ok) imported.push(entry.name); else skipped.push({ name: entry.name, reason: res.reason });
  }
  return { imported, skipped };
}

check('a body containing "click 4" is REJECTED on import, never stored (index-addressed click)', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  const text = '#!lflscript v1\n#!script evil\ngo example.com\nclick 4\n';
  const { imported, skipped } = importFile(store, text);
  assert.deepStrictEqual(imported, []);
  assert.strictEqual(skipped.length, 1);
  assert.match(skipped[0].reason, /ls-listing index/);
  assert.strictEqual(store.getScript('evil'), null);
});

check('a body containing "fill 3 with x" is REJECTED on import, never stored (index-addressed fill)', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  const text = '#!lflscript v1\n#!script evil2\ngo example.com\nfill 3 with x\n';
  const { imported, skipped } = importFile(store, text);
  assert.deepStrictEqual(imported, []);
  assert.match(skipped[0].reason, /fill <N>/);
  assert.strictEqual(store.getScript('evil2'), null);
});

check('a body containing a bare number step is REJECTED on import, never stored (M4a ls-index shortcut)', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  const text = '#!lflscript v1\n#!script evil3\ngo example.com\n4\n';
  const { imported, skipped } = importFile(store, text);
  assert.deepStrictEqual(imported, []);
  assert.match(skipped[0].reason, /bare number/);
  assert.strictEqual(store.getScript('evil3'), null);
});

check('a body containing "select 2" is REJECTED on import, never stored', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  const text = '#!lflscript v1\n#!script evil4\nselect 2\n';
  const { imported, skipped } = importFile(store, text);
  assert.deepStrictEqual(imported, []);
  assert.match(skipped[0].reason, /ls-listing index/);
  assert.strictEqual(store.getScript('evil4'), null);
});

check('an oversized body (>20 steps) is REJECTED on import, never stored', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  const body = Array.from({ length: 21 }, (_, i) => `go example${i}.com`).join('\n');
  const text = `#!lflscript v1\n#!script toolong\n${body}\n`;
  const { imported, skipped } = importFile(store, text);
  assert.deepStrictEqual(imported, []);
  assert.match(skipped[0].reason, /too many steps/);
  assert.strictEqual(store.getScript('toolong'), null);
});

check('a nested "run other-script" step is REJECTED on import (depth-1 lock still applies)', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  const text = '#!lflscript v1\n#!script nested\ngo example.com\nrun other\n';
  const { imported, skipped } = importFile(store, text);
  assert.deepStrictEqual(imported, []);
  assert.match(skipped[0].reason, /may not be nested/);
});

check('a game/funpack step is REJECTED on import (same write-time lock as a hand-typed script)', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  const text = '#!lflscript v1\n#!script gamey\ngo example.com\nsnake\n';
  const { imported, skipped } = importFile(store, text);
  assert.deepStrictEqual(imported, []);
  assert.match(skipped[0].reason, /games are never/);
});

check('a name colliding with an EXISTING alias is skipped-with-reason, never silently overwritten', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  store.setAlias('wiki', 'go en.wikipedia.org');
  const text = '#!lflscript v1\n#!script wiki\ngo evil.example.com\n';
  const { imported, skipped } = importFile(store, text);
  assert.deepStrictEqual(imported, []);
  assert.match(skipped[0].reason, /already an alias name/);
  // the alias itself is untouched
  assert.strictEqual(store.getAlias('wiki'), 'go en.wikipedia.org');
  assert.strictEqual(store.getScript('wiki'), null);
});

check('a name colliding with an EXISTING macro is skipped-with-reason, never silently overwritten', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  store.setMacro('morning', 'go example.com && search "news"');
  const text = '#!lflscript v1\n#!script morning\ngo evil.example.com\n';
  const { imported, skipped } = importFile(store, text);
  assert.deepStrictEqual(imported, []);
  assert.match(skipped[0].reason, /already a macro name/);
  assert.strictEqual(store.getMacro('morning'), 'go example.com && search "news"');
});

check('a name colliding with an EXISTING script is skipped-with-reason, the original body survives untouched', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  store.setScript('checkout', 'go original.example.com\n');
  const text = '#!lflscript v1\n#!script checkout\ngo evil.example.com\n';
  const { imported, skipped } = importFile(store, text);
  assert.deepStrictEqual(imported, []);
  assert.match(skipped[0].reason, /already a script name/);
  assert.strictEqual(store.getScript('checkout').body, 'go original.example.com');
});

check('a script name that is a script-system self-name ("run"/"script"/"pause") is skipped-with-reason', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  const text = '#!lflscript v1\n#!script run\ngo example.com\n';
  const { imported, skipped } = importFile(store, text);
  assert.deepStrictEqual(imported, []);
  assert.match(skipped[0].reason, /script-system command/);
});

// =====================================================================
// [3] a valid multi-script file imports all valid scripts and reports
// skips, mixed with invalid/colliding ones in the same file.
// =====================================================================
console.log('\n[3] a valid multi-script file imports all valid scripts and reports skips (mixed file)');

check('mixed file: two valid scripts import, one invalid body and one colliding name are both skipped with distinct reasons', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  store.setAlias('taken', 'go example.com');
  const text = [
    '#!lflscript v1',
    '#!script good-one',
    'go example.com',
    'search "$1"',
    '#!script bad-index',
    'go example.com',
    'click 4',
    '#!script taken',
    'go example.com',
    '#!script also-good',
    'fill email with test@example.com',
    'pause "confirm the order"',
    '',
  ].join('\n');
  const { imported, skipped } = importFile(store, text);
  assert.deepStrictEqual(imported.sort(), ['also-good', 'good-one']);
  assert.strictEqual(skipped.length, 2);
  const skippedNames = skipped.map((s) => s.name).sort();
  assert.deepStrictEqual(skippedNames, ['bad-index', 'taken']);
  assert.ok(store.getScript('good-one'));
  assert.ok(store.getScript('also-good'));
  assert.strictEqual(store.getScript('bad-index'), null);
  assert.strictEqual(store.getScript('taken'), null); // the alias wins, not the imported script
});

check('every script imported from a valid file is itself runnable (arity/stepCount computed correctly)', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  const text = '#!lflscript v1\n#!script greet\ngo example.com\nsearch "$1"\nfill name with "$2"\n';
  const { imported } = importFile(store, text);
  assert.deepStrictEqual(imported, ['greet']);
  const s = store.getScript('greet');
  assert.strictEqual(s.stepCount, 3);
  assert.strictEqual(s.arity, 2);
});

// =====================================================================
// [4] no-new-permission guarantee - export/import add zero manifest
// permissions (Blob URL + <a download>, <input type=file>; NOT
// chrome.downloads). Structural, byte-exact check against manifest.json.
// =====================================================================
console.log('\n[4] no-new-permission guarantee - manifest.json permissions unchanged for P2');

check('manifest.json permissions are still exactly ["storage"]; host_permissions unchanged', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert.deepStrictEqual(manifest.permissions, ['storage'], 'permissions must stay byte-identical - scripts P2 export/import uses Blob URL + <a download> + <input type=file>, never chrome.downloads');
  assert.deepStrictEqual(manifest.host_permissions, ['http://127.0.0.1:1238/*'], 'host_permissions must be unchanged');
});

check('terminal.js does not reference chrome.downloads anywhere (export uses Blob URL + <a download> only)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'terminal.js'), 'utf8');
  assert.ok(!/chrome\.downloads/.test(src), 'terminal.js must not use chrome.downloads - that would require a new manifest permission');
});

console.log(`\nm5b_script_sharing: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
