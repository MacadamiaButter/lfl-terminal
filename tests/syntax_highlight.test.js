#!/usr/bin/env node
/**
 * tests/syntax_highlight.test.js - unit proof of live syntax highlighting
 * (2026-07-16, LFL-TERMINAL-SYNTAX-HIGHLIGHT-DESIGN.md).
 *
 * Part 1 (pure): LFL.registry.synSpans(line, knownNames) against the REAL,
 * unmodified extension/content/registry.js source (plain CommonJS require -
 * no DOM dependency, same posture as tests/autoopen.test.js/
 * tests/panel_resize.test.js). This is the whole decision surface of the
 * feature - the mirror-overlay DOM, event wiring, and scrollback-echo glue
 * all live in terminal.js and only ever call this one pure function (see
 * terminal.js's _syncSynMirror()/_appendLineDom()/_renderSynSpansInto()).
 *
 * Part 2 (structural, source-inspection): the mirror element's DOM shape,
 * the CSS twins' presence of the transparent-input/caret-color/mirror rules,
 * the no-innerHTML invariant on the one new DOM-writing function, the
 * scrollback-echo wiring, and the scroll-sync wiring - all checked by
 * reading extension/content/terminal.js and terminal.css as text and
 * asserting against them directly (same style as tests/toolbar_action.test.js),
 * rather than instantiating a full `new Terminal()` in a vm sandbox: this
 * feature has no chrome.*-dependent branching of its own to exercise (the
 * mirror is a plain DOM append at construction time, same shape every run),
 * so a source-level structural proof is the proportionate check - the
 * pixel-level result is what the manual live-browser smoke (design doc §7)
 * is for.
 *
 * Part 3: isolation - guards.js/executor.js/background/service-worker.js/
 * manifest.json never mention this feature (display-layer only, per the
 * design doc's standing constraints §5), css_sync + the three hygiene gates
 * all still pass.
 *
 * Sandbox-prototype gotcha (same note as tests/m4c_highlight.test.js): none
 * of this file loads registry.js into a vm context, so there is no
 * cross-realm prototype mismatch to worry about for synSpans() - its return
 * values are plain objects/arrays created in THIS realm. assert.deepStrictEqual
 * is safe to use directly throughout Part 1 for that reason.
 *
 * Run: node tests/syntax_highlight.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TERMINAL_JS_PATH = path.join(ROOT, 'extension', 'content', 'terminal.js');
const TERMINAL_CSS_PATH = path.join(ROOT, 'extension', 'content', 'terminal.css');
const GUARDS_PATH = path.join(ROOT, 'extension', 'content', 'guards.js');
const EXECUTOR_PATH = path.join(ROOT, 'extension', 'content', 'executor.js');
const SW_PATH = path.join(ROOT, 'extension', 'background', 'service-worker.js');
const MANIFEST_PATH = path.join(ROOT, 'extension', 'manifest.json');

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

// concat of every span's .text must reproduce the input line exactly
// (design doc §4, normative) - asserted on every case below via this helper
// so the invariant is checked as many times as there are test lines, not
// just once.
function assertConcatInvariant(line, spans) {
  const concat = spans.map((s) => s.text).join('');
  assert.strictEqual(concat, line, `concat-equals-line invariant broken for ${JSON.stringify(line)}`);
}

function spansOf(line, known) {
  const spans = registry.synSpans(line, known);
  assertConcatInvariant(line, spans);
  return spans;
}

// =====================================================================
// Part 1 - pure synSpans()
// =====================================================================

console.log('tests/syntax_highlight.test.js - live syntax highlighting');
console.log('\n[1] synSpans() - pure, DOM-free');

const KNOWN = ['go', 'search', 'open', 'open!', 'run'];

check('known head token gets .lfl-syn-cmd, the rest gets no class', () => {
  const spans = spansOf('go amazon', KNOWN);
  assert.deepStrictEqual(spans, [
    { text: 'go', cls: 'lfl-syn-cmd' },
    { text: ' amazon', cls: null },
  ]);
});

check('an UNKNOWN head token (not red - just unlit) gets no class at all', () => {
  const spans = spansOf('goto amazon', KNOWN);
  assert.deepStrictEqual(spans, [{ text: 'goto amazon', cls: null }]);
});

check('a defined alias name in the knownNames list lights up exactly like a built-in', () => {
  const spans = spansOf('wiki en.wikipedia.org', ['wiki']);
  assert.deepStrictEqual(spans, [
    { text: 'wiki', cls: 'lfl-syn-cmd' },
    { text: ' en.wikipedia.org', cls: null },
  ]);
});

check('a defined macro name in the knownNames list lights up too', () => {
  const spans = spansOf('morning', ['morning']);
  assert.deepStrictEqual(spans, [{ text: 'morning', cls: 'lfl-syn-cmd' }]);
});

check('second segment head after && lights up independently of the first', () => {
  const spans = spansOf('go x && search y', KNOWN);
  assert.deepStrictEqual(spans, [
    { text: 'go', cls: 'lfl-syn-cmd' },
    { text: ' x ', cls: null },
    { text: '&&', cls: 'lfl-syn-op' },
    { text: ' ', cls: null },
    { text: 'search', cls: 'lfl-syn-cmd' },
    { text: ' y', cls: null },
  ]);
});

check('a THIRD segment head lights up too (chain of more than two)', () => {
  const spans = spansOf('go a && search b && open c', KNOWN);
  const cmds = spans.filter((s) => s.cls === 'lfl-syn-cmd').map((s) => s.text);
  assert.deepStrictEqual(cmds, ['go', 'search', 'open']);
});

check('first segment unknown, second known: only the second lights', () => {
  const spans = spansOf('zzz a && search b', KNOWN);
  const cmds = spans.filter((s) => s.cls === 'lfl-syn-cmd').map((s) => s.text);
  assert.deepStrictEqual(cmds, ['search']);
});

check('"&&" INSIDE a double-quoted span is not a separator - one segment, one head', () => {
  const spans = spansOf('search "a && b"', KNOWN);
  const ops = spans.filter((s) => s.cls === 'lfl-syn-op');
  assert.strictEqual(ops.length, 0, 'no operator span - the && stayed part of the quoted string');
  const cmds = spans.filter((s) => s.cls === 'lfl-syn-cmd').map((s) => s.text);
  assert.deepStrictEqual(cmds, ['search']);
  const strs = spans.filter((s) => s.cls === 'lfl-syn-str').map((s) => s.text);
  assert.deepStrictEqual(strs, ['"a && b"']);
});

check('a quoted && THEN a real && outside quotes: exactly one op, two segments, both heads found', () => {
  const spans = spansOf('search "a && b" && open x', KNOWN);
  const ops = spans.filter((s) => s.cls === 'lfl-syn-op');
  assert.strictEqual(ops.length, 1);
  assert.strictEqual(ops[0].text, '&&');
  const cmds = spans.filter((s) => s.cls === 'lfl-syn-cmd').map((s) => s.text);
  assert.deepStrictEqual(cmds, ['search', 'open']);
});

check('double-quoted span (open to close) gets .lfl-syn-str, quotes included', () => {
  const spans = spansOf('search "privacy tools"', KNOWN);
  assert.deepStrictEqual(spans, [
    { text: 'search', cls: 'lfl-syn-cmd' },
    { text: ' ', cls: null },
    { text: '"privacy tools"', cls: 'lfl-syn-str' },
  ]);
});

check('unmatched (unterminated) double quote runs open-quote-to-EOL - same shape splitChain\'s own unterminated state produces', () => {
  const spans = spansOf('search "never closed', KNOWN);
  const strs = spans.filter((s) => s.cls === 'lfl-syn-str');
  assert.strictEqual(strs.length, 1);
  assert.strictEqual(strs[0].text, '"never closed');
});

check('DIVERGENCE from the design doc (code wins, per design doc §4): single quotes are NOT string delimiters - splitChain()/tokenizeArgs() never treat \' specially, so synSpans() must not either', () => {
  const spans = spansOf("search 'privacy tools'", KNOWN);
  const strs = spans.filter((s) => s.cls === 'lfl-syn-str');
  assert.strictEqual(strs.length, 0, 'a single-quoted span must NOT be highlighted as a string');
  assert.deepStrictEqual(spans, [
    { text: 'search', cls: 'lfl-syn-cmd' },
    { text: " 'privacy tools'", cls: null },
  ]);
});

check('a head token that itself starts with a quote (`"go" x`) never matches a bare known name - quotes are not stripped for comparison', () => {
  const spans = spansOf('"go" x', KNOWN);
  const cmds = spans.filter((s) => s.cls === 'lfl-syn-cmd');
  assert.strictEqual(cmds.length, 0);
  const strs = spans.filter((s) => s.cls === 'lfl-syn-str').map((s) => s.text);
  assert.deepStrictEqual(strs, ['"go"']);
});

check('empty line -> spans whose concatenation is the empty string (no throw)', () => {
  const spans = spansOf('', KNOWN);
  assert.deepStrictEqual(spans, []);
});

check('whitespace-only line -> a single unclassed span, no throw', () => {
  const spans = spansOf('   ', KNOWN);
  assert.deepStrictEqual(spans, [{ text: '   ', cls: null }]);
});

check('leading spaces before the head token are preserved, unclassed, and do not block the match', () => {
  const spans = spansOf('  go x', KNOWN);
  assert.deepStrictEqual(spans, [
    { text: '  ', cls: null },
    { text: 'go', cls: 'lfl-syn-cmd' },
    { text: ' x', cls: null },
  ]);
});

check('trailing whitespace after the last segment is preserved, unclassed', () => {
  const spans = spansOf('go x  ', KNOWN);
  assert.deepStrictEqual(spans, [
    { text: 'go', cls: 'lfl-syn-cmd' },
    { text: ' x  ', cls: null },
  ]);
});

check('a dangling trailing "&&" with nothing after it does not throw and still marks the operator', () => {
  const spans = spansOf('go x &&', KNOWN);
  assert.deepStrictEqual(spans, [
    { text: 'go', cls: 'lfl-syn-cmd' },
    { text: ' x ', cls: null },
    { text: '&&', cls: 'lfl-syn-op' },
  ]);
});

check('a leading "&&" with nothing before it does not throw (empty first segment, no head to find)', () => {
  const spans = spansOf('&& go x', KNOWN);
  assert.deepStrictEqual(spans, [
    { text: '&&', cls: 'lfl-syn-op' },
    { text: ' ', cls: null },
    { text: 'go', cls: 'lfl-syn-cmd' },
    { text: ' x', cls: null },
  ]);
});

check('exact-match, case-sensitive: "Go" is NOT the same known word as "go"', () => {
  const spans = spansOf('Go amazon', KNOWN);
  const cmds = spans.filter((s) => s.cls === 'lfl-syn-cmd');
  assert.strictEqual(cmds.length, 0);
});

check('a known name that is a PREFIX of the typed word does not partially match ("goto" vs known "go")', () => {
  const spans = spansOf('goto amazon', ['go']);
  const cmds = spans.filter((s) => s.cls === 'lfl-syn-cmd');
  assert.strictEqual(cmds.length, 0);
});

check('"open!" (a real registered alias name with a trailing punctuation char) matches exactly as given', () => {
  const spans = spansOf('open!', KNOWN);
  assert.deepStrictEqual(spans, [{ text: 'open!', cls: 'lfl-syn-cmd' }]);
});

check('knownNames is taken as an ARGUMENT, not read from any global/baked list - a made-up fake name lights up', () => {
  const spans = spansOf('frobnicate x', ['frobnicate']);
  assert.deepStrictEqual(spans[0], { text: 'frobnicate', cls: 'lfl-syn-cmd' });
});

check('...and the SAME line with a DIFFERENT knownNames list does not light up - proves the list is truly live, not cached', () => {
  const spans = spansOf('frobnicate x', ['something-else']);
  const cmds = spans.filter((s) => s.cls === 'lfl-syn-cmd');
  assert.strictEqual(cmds.length, 0);
});

check('non-array/garbage knownNames is treated as empty, never throws', () => {
  assert.doesNotThrow(() => spansOf('go x', undefined));
  assert.doesNotThrow(() => spansOf('go x', null));
  assert.doesNotThrow(() => spansOf('go x', 'not-an-array'));
  const spans = spansOf('go x', null);
  assert.strictEqual(spans.filter((s) => s.cls === 'lfl-syn-cmd').length, 0);
});

check('non-string line is treated as empty, never throws', () => {
  assert.deepStrictEqual(registry.synSpans(null, KNOWN), []);
  assert.deepStrictEqual(registry.synSpans(undefined, KNOWN), []);
  assert.deepStrictEqual(registry.synSpans(42, KNOWN), []);
});

check('numbers/index args are NOT specially highlighted in v1 (owner-accepted minimal set) - a bare number after a known head stays unclassed', () => {
  const spans = spansOf('open 2', KNOWN);
  assert.deepStrictEqual(spans, [
    { text: 'open', cls: 'lfl-syn-cmd' },
    { text: ' 2', cls: null },
  ]);
});

check('a run of consecutive "&&&&" (two operators back to back, empty middle segment) does not throw', () => {
  const line = 'go x &&&& search y';
  const spans = spansOf(line, KNOWN);
  // Both "&&" pairs are adjacent 'op'-classified characters, so the run-
  // merge pass (by design - it merges any consecutive same-class run, and
  // makes no claim about operator token boundaries beyond "outside quotes")
  // yields ONE 4-char op span, not two 2-char ones. The empty segment
  // between them is still handled without throwing, and the real segments
  // on either side still find their heads.
  const ops = spans.filter((s) => s.cls === 'lfl-syn-op').map((s) => s.text);
  assert.deepStrictEqual(ops, ['&&&&']);
  const cmds = spans.filter((s) => s.cls === 'lfl-syn-cmd').map((s) => s.text);
  assert.deepStrictEqual(cmds, ['go', 'search']);
});

check('every case above already re-checked the concat-equals-line invariant via spansOf() - one more explicit spot-check on a long mixed line', () => {
  const line = '  go "a && b" && search c && open! "d"  ';
  const spans = spansOf(line, KNOWN);
  assertConcatInvariant(line, spans);
});

// =====================================================================
// Part 2 - structural (source-level) checks
// =====================================================================

console.log('\n[2] structural - mirror DOM shape, CSS twins, no-innerHTML, echo wiring, scroll-sync wiring');

const termSrc = fs.readFileSync(TERMINAL_JS_PATH, 'utf8');
const cssSrc = fs.readFileSync(TERMINAL_CSS_PATH, 'utf8');

// Brace-depth extraction of one method's source text, keyed off its
// signature - same "dumb, flat, on-purpose" posture as css_sync.test.js's
// own parser (this file's methods contain no braces inside string/template
// literals, so naive counting is exact here).
function extractMethod(src, signatureRe) {
  const m = signatureRe.exec(src);
  assert.ok(m, `signature not found: ${signatureRe}`);
  const braceStart = src.indexOf('{', m.index);
  assert.ok(braceStart !== -1, 'no opening brace found after signature');
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) { i += 1; break; }
    }
  }
  return src.slice(m.index, i);
}

check('this.synMirrorEl is created as a div with class lfl-synmirror', () => {
  assert.match(termSrc, /this\.synMirrorEl\s*=\s*document\.createElement\('div'\)/);
  assert.match(termSrc, /this\.synMirrorEl\.className\s*=\s*'lfl-synmirror'/);
});

check('the mirror carries aria-hidden="true"', () => {
  assert.match(termSrc, /this\.synMirrorEl\.setAttribute\('aria-hidden',\s*'true'\)/);
});

check('the mirror is appended inside a wrapper (.lfl-inputwrap) alongside the real input, inside .lfl-inputrow', () => {
  assert.match(termSrc, /inputwrap\.className\s*=\s*'lfl-inputwrap'/);
  assert.match(termSrc, /inputwrap\.appendChild\(this\.synMirrorEl\)/);
  assert.match(termSrc, /inputwrap\.appendChild\(this\.inputEl\)/);
  assert.match(termSrc, /inputrow\.appendChild\(inputwrap\)/);
});

check('.lfl-synmirror is pointer-events:none and overflow:hidden in BOTH CSS twins (css_sync covers exact parity - this is a presence check)', () => {
  for (const src of [cssSrc, termSrc]) {
    assert.match(src, /\.lfl-synmirror\s*\{[^}]*pointer-events:\s*none/);
    assert.match(src, /\.lfl-synmirror\s*\{[^}]*overflow:\s*hidden/);
    assert.match(src, /\.lfl-synmirror\s*\{[^}]*white-space:\s*pre/);
  }
});

check('.lfl-input is color:transparent with a caret-color set, in BOTH CSS twins', () => {
  for (const src of [cssSrc, termSrc]) {
    const m = /\.lfl-input\s*\{[^}]*\}/.exec(src);
    assert.ok(m, 'could not find the base .lfl-input rule');
    assert.match(m[0], /color:\s*transparent/, 'input value text must be transparent (mirror renders the visible glyphs)');
    assert.match(m[0], /caret-color:\s*var\(--lfl-fg/, 'caret-color must be set so the cursor stays visible');
  }
});

check('.lfl-input::selection exists in BOTH CSS twins with a semi-transparent background', () => {
  for (const src of [cssSrc, termSrc]) {
    assert.match(src, /\.lfl-input::selection\s*\{[^}]*background:\s*rgba\(/);
  }
});

check('.lfl-syn-cmd / .lfl-syn-str / .lfl-syn-op all exist in BOTH CSS twins', () => {
  for (const src of [cssSrc, termSrc]) {
    assert.match(src, /\.lfl-syn-cmd\s*\{/);
    assert.match(src, /\.lfl-syn-str\s*\{/);
    assert.match(src, /\.lfl-syn-op\s*\{/);
  }
});

check('.lfl-line.lfl-cmd no longer sets a whole-line `color` (replaced by per-token spans) in BOTH CSS twins', () => {
  for (const src of [cssSrc, termSrc]) {
    const m = /\.lfl-line\.lfl-cmd\s*\{[^}]*\}/.exec(src);
    assert.strictEqual(m, null, 'a bare .lfl-line.lfl-cmd{...} rule (whole-line color) must no longer exist');
    // the ::before prompt-prefix rule must still be there
    assert.match(src, /\.lfl-line\.lfl-cmd::before\s*\{[^}]*content:\s*'lfl> '/);
  }
});

check('_renderSynSpansInto() builds spans via createElement/textContent only - no innerHTML anywhere in its body', () => {
  const fnSrc = extractMethod(termSrc, /_renderSynSpansInto\(container, line, knownNames\)\s*\{/);
  assert.ok(!/innerHTML/.test(fnSrc), 'innerHTML must never appear in the new span-render function');
  assert.match(fnSrc, /document\.createElement\('span'\)/);
  assert.match(fnSrc, /\.textContent\s*=/);
  assert.match(fnSrc, /LFL\.registry\.synSpans\(/);
});

check('_syncSynMirror() resyncs the mirror through _renderSynSpansInto (not a direct textContent shortcut) and syncs scrollLeft', () => {
  const fnSrc = extractMethod(termSrc, /_syncSynMirror\(\)\s*\{/);
  assert.match(fnSrc, /this\._renderSynSpansInto\(this\.synMirrorEl,/);
  assert.match(fnSrc, /this\.synMirrorEl\.scrollLeft\s*=\s*this\.inputEl\.scrollLeft/);
});

check('_appendLineDom() routes a \'cmd\'-classed line through the span renderer instead of a flat textContent assignment', () => {
  const fnSrc = extractMethod(termSrc, /_appendLineDom\(text, cls\)\s*\{/);
  assert.match(fnSrc, /if\s*\(cls === 'cmd'\)/);
  assert.match(fnSrc, /this\._renderSynSpansInto\(div, text, this\._knownSynNames\(\)\)/);
});

check('scroll-sync wiring exists: the input\'s own \'scroll\' event copies scrollLeft into the mirror', () => {
  assert.match(
    termSrc,
    /this\.inputEl\.addEventListener\('scroll',[\s\S]{0,200}?this\.synMirrorEl\.scrollLeft = this\.inputEl\.scrollLeft/,
  );
});

check('input/compositionupdate both resync the mirror live while typing', () => {
  assert.match(termSrc, /this\.inputEl\.addEventListener\('input',\s*\(\)\s*=>\s*this\._syncSynMirror\(\)\)/);
  assert.match(termSrc, /this\.inputEl\.addEventListener\('compositionupdate',\s*\(\)\s*=>\s*this\._syncSynMirror\(\)\)/);
});

check('every programmatic `this.inputEl.value = ...` assignment site is followed by an explicit _syncSynMirror() call (input/compositionupdate do not fire for a scripted assignment)', () => {
  // Five known call sites (script-edit line capture, teach-name capture,
  // ordinary Enter-clear, history nav, and the no-name teach-save prompt) -
  // each asserted individually against its own unique surrounding text so a
  // failure names exactly which site regressed.
  assert.match(
    termSrc,
    /const line = this\.inputEl\.value;\s*\n\s*this\.inputEl\.value = '';\s*\n\s*this\._syncSynMirror\(\);[^\n]*\n\s*\/\/ Ctrl\+Enter/,
    'script-edit line-capture site (editing-script mode)',
  );
  assert.match(
    termSrc,
    /const line = this\.inputEl\.value\.trim\(\);\s*\n\s*this\.inputEl\.value = '';\s*\n\s*this\._syncSynMirror\(\);[^\n]*\n\s*this\._captureTeachName\(line\);/,
    'teach-name line-capture site (awaiting-teach-name mode)',
  );
  assert.match(
    termSrc,
    /const raw = this\.inputEl\.value;\s*\n\s*this\.inputEl\.value = '';\s*\n\s*this\._syncSynMirror\(\);[^\n]*\n\s*this\._submitCommand\(raw\);/,
    'ordinary Enter-submit clear site',
  );
  assert.match(
    termSrc,
    /this\.inputEl\.value = idx < this\.state\.history\.length[\s\S]*?;\s*\n\s*this\._syncSynMirror\(\);/,
    'history-nav site (_historyStep)',
  );
  assert.match(
    termSrc,
    /this\.inputEl\.readOnly = false;\s*\n\s*this\.inputEl\.value = '';\s*\n\s*this\._syncSynMirror\(\);[^\n]*\n\s*this\.inputEl\.focus\(\);\s*\n\s*this\.printInfo\('name for this script/,
    'no-name teach-save prompt site',
  );
});

check('_knownSynNames() reads the registry + the LIVE alias/macro store, not a script-name list (scripts are only invoked via `run <name>`)', () => {
  const fnSrc = extractMethod(termSrc, /_knownSynNames\(\)\s*\{/);
  assert.match(fnSrc, /LFL\.commandRegistry\.names\(\)/);
  assert.match(fnSrc, /this\._aliasStore\.listAliases\(\)/);
  assert.match(fnSrc, /this\._aliasStore\.listMacros\(\)/);
  assert.ok(!/listScripts/.test(fnSrc), 'script names must NOT be part of the known-head-word set');
});

// =====================================================================
// Part 3 - isolation + gates
// =====================================================================

console.log('\n[3] isolation - guards/executor/service-worker/manifest untouched by this display-layer feature; gates green');

check('guards.js has no mention of this feature (closed-shadow-root display layer only, never a security boundary)', () => {
  const src = fs.readFileSync(GUARDS_PATH, 'utf8');
  assert.ok(!/synSpans|synMirror|lfl-syn-/.test(src));
});

check('executor.js has no mention of this feature (the highlighter never consults or feeds the executor)', () => {
  const src = fs.readFileSync(EXECUTOR_PATH, 'utf8');
  assert.ok(!/synSpans|synMirror|lfl-syn-/.test(src));
});

check('background/service-worker.js is completely untouched - no payload/protocol change, nothing about highlighting ever leaves the content script', () => {
  const src = fs.readFileSync(SW_PATH, 'utf8');
  assert.ok(!/synSpans|synMirror|lfl-syn-|synmirror/i.test(src));
});

check('manifest.json is untouched - zero new permissions for a pure display-layer feature', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  assert.deepStrictEqual(manifest.permissions, ['storage']);
  assert.deepStrictEqual(manifest.host_permissions, ['http://127.0.0.1:1238/*']);
});

check('tests/css_sync.test.js (the CSS dual-sync gate) still exits 0', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'css_sync.test.js')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

check('tests/check_no_egress.sh PASSES', () => {
  const r = spawnSync('bash', [path.join(__dirname, 'check_no_egress.sh')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

check('tests/check_no_leaks.sh PASSES', () => {
  const r = spawnSync('bash', [path.join(__dirname, 'check_no_leaks.sh')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

check('tests/check_no_emdash.sh PASSES', () => {
  const r = spawnSync('bash', [path.join(__dirname, 'check_no_emdash.sh')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

console.log(`\nsyntax_highlight: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
