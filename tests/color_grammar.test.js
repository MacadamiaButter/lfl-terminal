#!/usr/bin/env node
/**
 * tests/color_grammar.test.js - unit proof of the color grammar v2 build
 * (2026-07-16, LFL-TERMINAL-COLOR-GRAMMAR-DESIGN.md). Extends
 * tests/syntax_highlight.test.js (unchanged, still green) and
 * tests/theme_contrast.test.js (the theme-fix mechanical gate, separate
 * file per the build plan).
 *
 * Part 1 (pure): synSpans(line, knownNames, subTable) v2 - numbers,
 * subcommands, unknown-head unlit, chain-aware multi-segment, head-vs-num
 * precedence, backward compatibility - against the REAL, unmodified
 * extension/content/registry.js source (plain CommonJS require, no DOM -
 * same posture as tests/syntax_highlight.test.js Part 1).
 *
 * Part 2: helpRich()/manRich() structure + the "every non-hidden entry has
 * a group" coverage test, run against the REAL registered command surface
 * (engine.js's actual reg.register() calls), loaded into one Node `vm`
 * sandbox - same load pattern tests/m4c_highlight.test.js already uses for
 * this file pair, trimmed to what this suite actually needs (no DOM/axtree
 * faking - every function this suite calls is pure).
 *
 * Part 3: the ls/matches rich builders (formatListingEntryRich,
 * sectionRichLines) - including the load-bearing P4 security proof: a
 * page-derived entry name containing backtick/angle-bracket "markup-shaped"
 * text must survive as ONE untouched plain span, never parsed.
 *
 * Part 4: structural (source-level) checks on terminal.js/terminal.css -
 * _appendRichLine()/_printDetResult() shape, no-innerHTML, the dispatch
 * call site, and CSS twin presence of the new span classes - same style as
 * tests/syntax_highlight.test.js Part 2.
 *
 * Part 5: isolation (guards/executor/service-worker/manifest untouched) +
 * gates green (css_sync, theme_contrast, the three hygiene shell gates).
 *
 * Run: node tests/color_grammar.test.js
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'extension', 'content', 'registry.js');
const ENGINE_PATH = path.join(ROOT, 'extension', 'content', 'engine.js');
const TERMINAL_JS_PATH = path.join(ROOT, 'extension', 'content', 'terminal.js');
const TERMINAL_CSS_PATH = path.join(ROOT, 'extension', 'content', 'terminal.css');
const GUARDS_PATH = path.join(ROOT, 'extension', 'content', 'guards.js');
const EXECUTOR_PATH = path.join(ROOT, 'extension', 'content', 'executor.js');
const NAV_PATH = path.join(ROOT, 'extension', 'content', 'nav.js');
const NAV_WATCH_PATH = path.join(ROOT, 'extension', 'content', 'nav-watch.js');
const AXTREE_PATH = path.join(ROOT, 'extension', 'content', 'axtree.js');
const SW_PATH = path.join(ROOT, 'extension', 'background', 'service-worker.js');
const MANIFEST_PATH = path.join(ROOT, 'extension', 'manifest.json');

const registry = require(REGISTRY_PATH); // plain CommonJS - no DOM dependency

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
// Part 1 - pure synSpans() v2
// =====================================================================

console.log('tests/color_grammar.test.js - color grammar v2');
console.log('\n[1] synSpans() v2 - numbers, subcommands, chains, precedence, backward compat');

const KNOWN = ['open', 'memory', 'go', 'search', '2048'];
const SUBS = { memory: ['show', 'on', 'off', 'quiet', 'loud', 'clear', 'forget'] };

function clsOf(spans, text) {
  const found = spans.find((s) => s.text === text);
  return found ? found.cls : undefined;
}

check('a numeric index arg after a known head gets lfl-syn-num (v2 only)', () => {
  const spans = registry.synSpans('open 3', KNOWN, SUBS);
  assert.strictEqual(clsOf(spans, 'open'), 'lfl-syn-cmd');
  assert.strictEqual(clsOf(spans, '3'), 'lfl-syn-num');
});

check('a bare-number "command" (unmatched head) gets lfl-syn-num, not lfl-syn-cmd', () => {
  const spans = registry.synSpans('3', KNOWN, SUBS);
  assert.deepStrictEqual(spans, [{ text: '3', cls: 'lfl-syn-num' }]);
});

check('the second token of a table-driven subcommand gets lfl-syn-sub', () => {
  const spans = registry.synSpans('memory show', KNOWN, SUBS);
  assert.strictEqual(clsOf(spans, 'memory'), 'lfl-syn-cmd');
  assert.strictEqual(clsOf(spans, 'show'), 'lfl-syn-sub');
});

check('a second token NOT in the subcommand list gets no sub class (falls through, stays unlit)', () => {
  const spans = registry.synSpans('memory bogus', KNOWN, SUBS);
  assert.strictEqual(spans.some((s) => s.cls === 'lfl-syn-sub'), false);
  assert.ok(spans.some((s) => s.text.includes('bogus') && s.cls === null));
});

check('unknown head stays unlit (P3) even in v2 - and its second token gets no sub class either', () => {
  const spans = registry.synSpans('zzz show', KNOWN, SUBS);
  assert.strictEqual(spans.some((s) => s.cls === 'lfl-syn-cmd'), false);
  assert.strictEqual(spans.some((s) => s.cls === 'lfl-syn-sub'), false);
  assert.deepStrictEqual(spans, [{ text: 'zzz show', cls: null }]);
});

check('chain-aware: "open 3 && memory show" classifies each segment independently', () => {
  const spans = registry.synSpans('open 3 && memory show', KNOWN, SUBS);
  const cmds = spans.filter((s) => s.cls === 'lfl-syn-cmd').map((s) => s.text);
  assert.deepStrictEqual(cmds, ['open', 'memory']);
  assert.strictEqual(clsOf(spans, '3'), 'lfl-syn-num');
  assert.strictEqual(clsOf(spans, 'show'), 'lfl-syn-sub');
});

check('head-vs-num precedence: "2048" as the HEAD token (a registered name) is cmd, not num', () => {
  const spans = registry.synSpans('2048', KNOWN, SUBS);
  assert.deepStrictEqual(spans, [{ text: '2048', cls: 'lfl-syn-cmd' }]);
});

check('...but "2048" as a NON-head numeric token (unrecognized as a name there) is num', () => {
  const spans = registry.synSpans('open 2048', KNOWN, SUBS);
  assert.strictEqual(clsOf(spans, 'open'), 'lfl-syn-cmd');
  assert.strictEqual(clsOf(spans, '2048'), 'lfl-syn-num');
});

check('a quoted numeric-looking token is never reclassified num (quote chars stay quote-kind)', () => {
  const spans = registry.synSpans('search "3"', KNOWN, SUBS);
  const strs = spans.filter((s) => s.cls === 'lfl-syn-str').map((s) => s.text);
  assert.deepStrictEqual(strs, ['"3"']);
  assert.strictEqual(spans.some((s) => s.cls === 'lfl-syn-num'), false);
});

check('backward compat: calling with NO third argument reproduces the v1 (pre-color-grammar) output exactly - no num/sub classes at all', () => {
  const v1 = registry.synSpans('open 3', KNOWN);
  assert.deepStrictEqual(v1, [
    { text: 'open', cls: 'lfl-syn-cmd' },
    { text: ' 3', cls: null },
  ]);
});

check('backward compat: an explicit `undefined` third argument behaves identically to omitting it', () => {
  const a = registry.synSpans('memory show', KNOWN, undefined);
  const b = registry.synSpans('memory show', KNOWN);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.some((s) => s.cls === 'lfl-syn-sub'), false);
});

check('backward compat: an explicit `null` third argument ALSO falls back to v1 behavior (fail-safe-to-plain)', () => {
  const spans = registry.synSpans('memory show', KNOWN, null);
  assert.strictEqual(spans.some((s) => s.cls === 'lfl-syn-sub'), false);
});

check('v2 with an empty subTable object still activates numeric classification (num does not depend on subTable content)', () => {
  const spans = registry.synSpans('open 3', KNOWN, {});
  assert.strictEqual(clsOf(spans, '3'), 'lfl-syn-num');
});

check('concat-equals-line invariant still holds for every v2 case above (spot check on the chain line)', () => {
  const line = 'open 3 && memory show';
  const spans = registry.synSpans(line, KNOWN, SUBS);
  assert.strictEqual(spans.map((s) => s.text).join(''), line);
});

check('SUBCOMMAND_TABLE is exported, frozen, and data-driven (memory/script/teach/theme/config)', () => {
  const t = registry.SUBCOMMAND_TABLE;
  assert.ok(Object.isFrozen(t));
  assert.deepStrictEqual(t.memory, ['show', 'on', 'off', 'quiet', 'loud', 'clear', 'forget']);
  assert.deepStrictEqual(t.script, ['new', 'ls', 'show', 'rm', 'export', 'import']);
  assert.deepStrictEqual(t.teach, ['on', 'off', 'save']);
  assert.deepStrictEqual(t.theme, ['default', 'phosphor', 'amber', 'paper']);
  assert.deepStrictEqual(t.config, ['anchor', 'middleclick']);
});

// =====================================================================
// Part 2 - helpRich()/manRich() structure + group coverage, against the
// REAL registered command surface (engine.js)
// =====================================================================

console.log('\n[2] helpRich()/manRich() structure + every-non-hidden-entry-has-a-group coverage');

function buildEngineSandbox() {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(REGISTRY_PATH, 'utf8'), sandbox, { filename: 'registry.js' });
  assert.strictEqual(typeof sandbox.window.LFL.registry.createRegistry, 'function');
  vm.runInContext(fs.readFileSync(ENGINE_PATH, 'utf8'), sandbox, { filename: 'engine.js' });
  assert.strictEqual(typeof sandbox.window.LFL.engine.tryDeterministic, 'function');
  return sandbox;
}

const engineSandbox = buildEngineSandbox();
const reg = engineSandbox.window.LFL.commandRegistry;

// Sandbox gotcha (vm-crossed values): objects/arrays built inside the vm
// context carry that context's own Object/Array prototypes, which are NOT
// identical to this file's own - assert.deepStrictEqual (prototype-
// sensitive) can spuriously fail on structurally-identical values for that
// reason alone. Round-tripping through JSON strips the foreign prototype,
// leaving a plain-object/array comparison - safe here because every value
// this suite compares is plain data (strings/null), never functions/
// Dates/Maps/etc.
function normalize(x) {
  return JSON.parse(JSON.stringify(x));
}

check('every non-hidden registered entry has a non-empty group; hidden entries need none', () => {
  const missingNames = [];
  for (const e of reg.entries) {
    if (!e.hidden && !e.group) missingNames.push(e.name);
  }
  assert.strictEqual(missingNames.length, 0, `entries missing a group: ${missingNames.join(', ')}`);
});

check('the `sl` easter egg is hidden and therefore has no group requirement', () => {
  const sl = reg.entries.find((e) => e.name === 'sl');
  assert.ok(sl && sl.hidden === true);
});

check('helpRich() includes exactly one command line per non-hidden entry, none for hidden ones', () => {
  const rich = normalize(reg.helpRich());
  const nonHeaderLines = rich.filter((line) => !line.spans.some((s) => s.cls === 'lfl-syn-header'));
  assert.strictEqual(nonHeaderLines.length, reg.entries.filter((e) => !e.hidden).length);
  // Each command line's FIRST cls lfl-syn-cmd span is the literal head word
  // of that entry's own argSpec (usually == e.name, but not always - e.g.
  // the two `extract` entries are registered under disambiguating keys
  // "extract-links"/"extract-table" while their argSpec's real typed head
  // word is "extract" - see registry.js's argSpecSpans() comment on this).
  const expectedHeads = [];
  for (const e of reg.entries) {
    if (e.hidden) continue;
    const m = /^\s*(\S+)/.exec(e.argSpec);
    expectedHeads.push(m ? m[1] : e.name);
  }
  const cmdHeadsSeen = nonHeaderLines.map((line) => {
    const cmdSpan = line.spans.find((s) => s.cls === 'lfl-syn-cmd');
    assert.ok(cmdSpan, `command line missing a cls lfl-syn-cmd span: ${JSON.stringify(line)}`);
    return cmdSpan.text;
  });
  assert.deepStrictEqual(cmdHeadsSeen.sort(), expectedHeads.sort());
  assert.ok(!cmdHeadsSeen.includes('sl'), 'hidden entry "sl" must never appear in helpRich()');
});

check('helpRich() groups entries under section-header lines (accent "$ " prefix + dim uppercase group name)', () => {
  const rich = reg.helpRich();
  const headers = rich.filter((line) => line.spans.some((s) => s.cls === 'lfl-syn-header'));
  assert.ok(headers.length >= 2, 'expected multiple distinct group headers');
  for (const h of headers) {
    assert.strictEqual(h.spans[0].cls, 'lfl-syn-accent');
    assert.strictEqual(h.spans[0].text, '$ ');
    assert.strictEqual(h.spans[1].cls, 'lfl-syn-header');
    assert.strictEqual(h.spans[1].text, h.spans[1].text.toUpperCase());
  }
});

check('a placeholder <...> in an argSpec gets cls lfl-syn-arg, and the command name gets lfl-syn-cmd (design doc §5)', () => {
  const lines = reg.manRich('open');
  const usageLine = lines[1];
  const placeholder = usageLine.spans.find((s) => s.text === '<link text>');
  assert.strictEqual(placeholder.cls, 'lfl-syn-arg');
  const nameSpans = usageLine.spans.filter((s) => s.cls === 'lfl-syn-cmd');
  assert.ok(nameSpans.length >= 1 && nameSpans.every((s) => s.text === 'open'));
});

check('a TIGHT on|off-style alternation (no surrounding whitespace) in an argSpec gets cls lfl-syn-arg', () => {
  const lines = reg.manRich('script');
  const usageLine = lines[1];
  const alt = usageLine.spans.find((s) => s.text === 'new|ls|show|rm');
  assert.ok(alt, 'expected the tight "new|ls|show|rm" alternation to be its own span');
  assert.strictEqual(alt.cls, 'lfl-syn-arg');
});

check('manRich() of an unknown command returns a single informative line, never throws', () => {
  const lines = reg.manRich('no-such-command-xyz');
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0].spans[0].text, /no such command/);
});

check('the backtick convention already present in help strings renders as cls lfl-syn-cmd, backticks stripped (design doc §5)', () => {
  const lines = reg.manRich('open'); // help text mentions `ls`
  const descLine = lines[2];
  const codeSpan = descLine.spans.find((s) => s.text === 'ls' && s.cls === 'lfl-syn-cmd');
  assert.ok(codeSpan, 'expected a backtick-wrapped `ls` reference to render as cls lfl-syn-cmd with backticks stripped');
  assert.ok(!descLine.spans.some((s) => s.text.includes('`')), 'no literal backtick characters should survive into the rendered spans');
});

check('HELP_RICH (engine.js) is a non-empty array that embeds reg.helpRich() (the grouped command listing) plus the rich-rendered leading label and trailing prose', () => {
  const helpRich = normalize(engineSandbox.window.LFL.engine.HELP_RICH);
  assert.ok(Array.isArray(helpRich) && helpRich.length > 0);
  // Leading label line, rendered rich (design doc §5).
  assert.strictEqual(helpRich[0].spans[0].text, 'deterministic commands (never call the local model):');
  assert.strictEqual(helpRich[0].spans[0].cls, 'lfl-syn-info');
  // The grouped command listing appears as a contiguous run right after the
  // label line, byte-identical in content to reg.helpRich() on its own
  // (already proven correct above) - proves HELP_RICH does not re-derive or
  // duplicate that logic.
  const groupedBlock = normalize(reg.helpRich());
  const embedded = helpRich.slice(1, 1 + groupedBlock.length);
  assert.deepStrictEqual(embedded, groupedBlock);
  // Trailing prose: the SAME text HELP_PROSE_LINES/HELP_TEXT carries,
  // rendered rich via the backtick convention - e.g. the chain-syntax line
  // renders "cmd1 && cmd2 && ..." as a cls lfl-syn-cmd span (backticks
  // stripped) inside an otherwise cls lfl-syn-info line.
  const proseLine = helpRich.find((line) => line.spans.some((s) => s.text === 'cmd1 && cmd2 && ...'));
  assert.ok(proseLine, 'expected the chain-syntax prose line to survive into HELP_RICH');
  const codeSpan = proseLine.spans.find((s) => s.text === 'cmd1 && cmd2 && ...');
  assert.strictEqual(codeSpan.cls, 'lfl-syn-cmd');
  assert.ok(proseLine.spans.some((s) => s.cls === 'lfl-syn-info'), 'the rest of the prose line should be cls lfl-syn-info');
});

check('HELP_TEXT (plain, pre-existing) is completely unchanged in shape - still starts with the same header line and reg.helpText() block', () => {
  const helpText = engineSandbox.window.LFL.engine.HELP_TEXT;
  assert.ok(helpText.startsWith('deterministic commands (never call the local model):\n'));
  assert.ok(helpText.includes(reg.helpText()));
});

// =====================================================================
// Part 3 - ls/matches rich builders (P4 security proof included)
// =====================================================================

console.log('\n[3] ls/matches rich builders - structure + P4 (page-derived text is never parsed)');

const engine = engineSandbox.window.LFL.engine;

check('formatListingEntryRich: index gets lfl-syn-num, the engine-computed type bucket gets lfl-syn-op, page text is ONE plain lfl-syn-fg span', () => {
  const entry = { index: 7, tag: 'a', role: 'link', name: 'Example Site', extra: '' };
  const spans = engine.formatListingEntryRich(entry);
  assert.strictEqual(spans.find((s) => s.text === '7').cls, 'lfl-syn-num');
  assert.strictEqual(spans.find((s) => s.text === engine.classifyEntry(entry)).cls, 'lfl-syn-op');
  const pageSpan = spans.find((s) => s.cls === 'lfl-syn-fg');
  assert.strictEqual(pageSpan.text, 'link "Example Site"');
});

check('P4 SECURITY: a page-derived entry name containing backtick/angle-bracket "markup-shaped" text survives as ONE untouched plain span - never parsed for markup', () => {
  const hostileName = '`ls` <b>evil</b> && rm -rf';
  const entry = { index: 1, tag: 'a', role: 'link', name: hostileName, extra: '' };
  const spans = engine.formatListingEntryRich(entry);
  // Exactly one fg-classed span, and its text is the RAW page-derived
  // string, byte-for-byte, with none of it upgraded to lfl-syn-cmd or any
  // other class - i.e. richTextSpans()/argSpecSpans()-style backtick/
  // placeholder parsing was never applied to this text.
  const fgSpans = spans.filter((s) => s.cls === 'lfl-syn-fg');
  assert.strictEqual(fgSpans.length, 1);
  assert.strictEqual(fgSpans[0].text, `link "${hostileName}"`);
  assert.ok(!spans.some((s) => s.cls === 'lfl-syn-cmd'), 'no span in a page-derived listing line may ever be classed as a command');
});

check('sectionRichLines: caps at LS_SECTION_CAP and appends a plain "(N more)" truncation line, mirroring sectionLines()', () => {
  const entries = [];
  for (let i = 1; i <= 45; i++) entries.push({ index: i, tag: 'a', role: 'link', name: `link ${i}`, extra: '' });
  const rich = engine.sectionRichLines(entries, 'link', null);
  // 40 entry lines + 1 truncation line (LS_SECTION_CAP = 40)
  assert.strictEqual(rich.length, 41);
  const last = normalize(rich[rich.length - 1]);
  assert.deepStrictEqual(last.spans, [{ text: '(5 more)', cls: null }]);
});

check('sectionRichLines: empty result for a kind with no matching entries', () => {
  const rich = engine.sectionRichLines([], 'button', null);
  assert.strictEqual(rich.length, 0);
});

check('doMatches() outputRich: index gets lfl-syn-num, the active cursor gets lfl-syn-accent, snippet is ONE plain lfl-syn-fg span (P4)', () => {
  const state = {
    findContext: {
      query: 'q',
      idx: 1,
      matches: [
        { textContent: 'first `code` <b>markup</b>' },
        { textContent: 'second one' },
      ],
    },
  };
  const det = engine.doMatches(state);
  assert.ok(Array.isArray(det.outputRich) && det.outputRich.length === 3); // header + 2 matches
  const line1 = det.outputRich[1];
  assert.strictEqual(line1.spans[0].cls, null); // not the active cursor
  const line2 = det.outputRich[2];
  assert.strictEqual(line2.spans[0].cls, 'lfl-syn-accent');
  assert.strictEqual(line2.spans[0].text, '>');
  const fgSpan1 = line1.spans.find((s) => s.cls === 'lfl-syn-fg');
  assert.ok(fgSpan1.text.includes('`code`'), 'page-derived snippet text must survive with its backticks untouched');
  assert.ok(!line1.spans.some((s) => s.cls === 'lfl-syn-cmd'), 'a match snippet must never be upgraded to a command span');
});

check('doLs()-shaped output: plain `output` string is unaffected by the outputRich addition (byte-identical to what sectionLines()/formatListingEntry() alone would produce)', () => {
  // formatListingEntry (plain) and formatListingEntryRich (rich) must agree
  // on the underlying page text for the same entry - proving outputRich is
  // purely additive, never a substitute computation that could drift from
  // the plain path scrollback actually persists.
  const entry = { index: 2, tag: 'button', role: 'button', name: 'Submit', extra: 'type=submit' };
  const plain = engine.formatListingEntry(entry);
  const rich = engine.formatListingEntryRich(entry);
  const pageSpan = rich.find((s) => s.cls === 'lfl-syn-fg');
  assert.ok(plain.endsWith(pageSpan.text), `plain line "${plain}" should end with the rich page-text span "${pageSpan.text}"`);
});

// =====================================================================
// Part 4 - structural (source-level) checks on terminal.js/terminal.css
// =====================================================================

console.log('\n[4] structural - _appendRichLine/_printDetResult shape, no-innerHTML, dispatch call site, CSS twins');

const termSrc = fs.readFileSync(TERMINAL_JS_PATH, 'utf8');
const cssSrc = fs.readFileSync(TERMINAL_CSS_PATH, 'utf8');

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

check('_appendRichLine(spans, cls) builds spans via createElement/textContent only - no innerHTML anywhere in its body', () => {
  const fnSrc = extractMethod(termSrc, /_appendRichLine\(spans, cls\)\s*\{/);
  assert.ok(!/innerHTML/.test(fnSrc), 'innerHTML must never appear in the rich-line renderer');
  assert.match(fnSrc, /document\.createElement\('div'\)/);
  assert.match(fnSrc, /document\.createElement\('span'\)/);
  assert.match(fnSrc, /\.textContent\s*=/);
});

check('_printRichLines() and _printDetResult() exist and route through _appendRichLine/printInfo respectively', () => {
  const printRichSrc = extractMethod(termSrc, /_printRichLines\(lines\)\s*\{/);
  assert.match(printRichSrc, /this\._appendRichLine\(/);
  const detSrc = extractMethod(termSrc, /_printDetResult\(det\)\s*\{/);
  assert.match(detSrc, /det\.outputRich/);
  assert.match(detSrc, /this\._printRichLines\(/);
  assert.match(detSrc, /this\.printInfo\(/);
});

check('the dispatch call site prints a deterministic result via _printDetResult(), not a bare printInfo(det.output)', () => {
  assert.match(termSrc, /this\._printDetResult\(det\);/);
  assert.ok(!/this\.printInfo\(det\.output\);/.test(termSrc), 'the old bare printInfo(det.output) call site must be gone');
});

check('_renderSynSpansInto() always calls the v2 (three-arg) synSpans() form using the static SUBCOMMAND_TABLE, but keeps its own external signature unchanged (container, line, knownNames)', () => {
  const fnSrc = extractMethod(termSrc, /_renderSynSpansInto\(container, line, knownNames\)\s*\{/);
  assert.match(fnSrc, /LFL\.registry\.synSpans\(line, knownNames, LFL\.registry\.SUBCOMMAND_TABLE\)/);
});

check('.lfl-syn-num / .lfl-syn-sub / .lfl-syn-arg / .lfl-syn-info / .lfl-syn-fg / .lfl-syn-accent / .lfl-syn-header all exist in BOTH CSS twins', () => {
  for (const src of [cssSrc, termSrc]) {
    for (const cls of ['.lfl-syn-num', '.lfl-syn-sub', '.lfl-syn-arg', '.lfl-syn-info', '.lfl-syn-fg', '.lfl-syn-accent', '.lfl-syn-header']) {
      assert.match(src, new RegExp(cls.replace('.', '\\.') + '\\s*\\{'), `${cls} missing`);
    }
  }
});

check('.lfl-syn-cmd carries font-weight:600 in BOTH CSS twins (design doc §3/§8 sign-off E)', () => {
  for (const src of [cssSrc, termSrc]) {
    const m = /\.lfl-syn-cmd\s*\{[^}]*\}/.exec(src);
    assert.ok(m, 'could not find the .lfl-syn-cmd rule');
    assert.match(m[0], /font-weight:\s*600/);
  }
});

check('.lfl-syn-arg is italic and uses --lfl-dim in BOTH CSS twins', () => {
  for (const src of [cssSrc, termSrc]) {
    const m = /\.lfl-syn-arg\s*\{[^}]*\}/.exec(src);
    assert.ok(m);
    assert.match(m[0], /font-style:\s*italic/);
    assert.match(m[0], /var\(--lfl-dim/);
  }
});

// =====================================================================
// Part 5 - isolation + gates
// =====================================================================

console.log('\n[5] isolation - guards/executor/nav/nav-watch/axtree/manifest byte-identical to be72a74; service-worker.js checked for color-grammar mentions only; gates green');

// service-worker.js was DROPPED from the byte-identical-to-be72a74 pin below
// (2026-07-16, LFL-TERMINAL-MEMBER-EXPERIENCE-DESIGN.md §7 sign-off E/§8):
// that pin was this color-grammar build's OWN "nothing unrelated moved"
// snapshot at the commit right before color grammar landed - not a
// permanent, all-future-builds invariant. The member-experience build
// explicitly and deliberately touches service-worker.js (E1 error mapping,
// E3 tour-progress storage, E4 install listener, E5 status check - see that
// file's own header "SIXTH ROLE" comment), with its own Fable security
// review of that diff. guards/executor/nav/nav-watch/axtree/manifest remain
// pinned exactly as before - this build's own HARD CONSTRAINTS list holds
// itself to that same untouched set. service-worker.js still gets the
// second check just below (no color-grammar-specific tokens/API mentions),
// which remains true and meaningful independent of the byte-identity pin.
const git = spawnSync('git', ['diff', '--stat', 'be72a74', '--', 'extension/content/guards.js', 'extension/content/executor.js', 'extension/content/nav.js', 'extension/content/nav-watch.js', 'extension/content/axtree.js', 'extension/manifest.json'], { cwd: ROOT, encoding: 'utf8' });

check('git diff against be72a74 for guards/executor/nav/nav-watch/axtree/manifest is EMPTY (byte-identical)', () => {
  assert.strictEqual(git.status, 0, git.stderr);
  assert.strictEqual(git.stdout.trim(), '', `unexpected diff:\n${git.stdout}`);
});

check('guards.js/executor.js/nav.js/nav-watch.js/axtree.js/service-worker.js/manifest.json have no mention of this display-layer feature', () => {
  for (const p of [GUARDS_PATH, EXECUTOR_PATH, NAV_PATH, NAV_WATCH_PATH, AXTREE_PATH, SW_PATH]) {
    const src = fs.readFileSync(p, 'utf8');
    assert.ok(!/lfl-syn-num|lfl-syn-sub|lfl-syn-arg|lfl-syn-header|SUBCOMMAND_TABLE|helpRich|manRich|outputRich/.test(src), `${p} unexpectedly mentions the color grammar feature`);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  assert.deepStrictEqual(manifest.permissions, ['storage']);
  assert.deepStrictEqual(manifest.host_permissions, ['http://127.0.0.1:1238/*']);
});

check('tests/css_sync.test.js (the CSS dual-sync gate) still exits 0', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'css_sync.test.js')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

check('tests/theme_contrast.test.js exits 0', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'theme_contrast.test.js')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

check('tests/syntax_highlight.test.js (still proves v1/backward compat) exits 0', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'syntax_highlight.test.js')], { encoding: 'utf8' });
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

console.log(`\ncolor_grammar: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
