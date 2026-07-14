#!/usr/bin/env node
/**
 * tests/m4c_highlight.test.js - unit proof of the M4c `highlight` verb
 * built into `extension/content/engine.js` (persistent visual match layer,
 * CSS Custom Highlight API - see
 * $VAULT/orchestrator/LFL-TERMINAL-HIGHLIGHT-DESIGN.md, an already-reviewed
 * and owner-accepted design doc), against the REAL, unmodified extension
 * source, loaded into one Node `vm` sandbox exactly the way
 * tests/m4_friction.test.js already does for the other `window.LFL`-scoped,
 * browser-only files - same load order (guards.js -> executor.js ->
 * registry.js -> engine.js) - plus tests/autoopen.test.js's plain-require
 * style for the parts of registry.js that need no DOM at all.
 *
 * `LFL.axtree` is the same faithful-but-simplified stand-in
 * tests/m4_friction.test.js uses (see its own header comment for why this
 * suite does not re-prove axtree's real DOM-walking/visibility heuristics).
 *
 * New sandbox pieces this suite adds on top of m4_friction's, all faithful
 * stand-ins for the real browser contract `highlight` depends on:
 *   - `document.createTreeWalker` scripted against a settable
 *     `document.__textNodes` array, applying the REAL acceptNode filter
 *     collectVisibleTextMatches() passes it - so visibility/query filtering
 *     is exercised through the real production code, not faked away.
 *   - `CSS.highlights` - a REAL Map (design doc §7).
 *   - `Highlight`/`Range` constructors that record their arguments instead
 *     of touching any real layout engine.
 *   - `document.adoptedStyleSheets` (a plain array) + `CSSStyleSheet` with
 *     `replaceSync`.
 *
 * Run: node tests/m4c_highlight.test.js
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GUARDS_PATH = path.join(ROOT, 'extension', 'content', 'guards.js');
const EXECUTOR_PATH = path.join(ROOT, 'extension', 'content', 'executor.js');
const REGISTRY_PATH = path.join(ROOT, 'extension', 'content', 'registry.js');
const ENGINE_PATH = path.join(ROOT, 'extension', 'content', 'engine.js');
const SW_PATH = path.join(ROOT, 'extension', 'background', 'service-worker.js');

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
// sandbox construction
// =====================================================================

// entries: array of { text, visible } - one per scripted text node.
// Builds document.__textNodes as [{ textContent, parentElement }, ...],
// which the fake createTreeWalker() below iterates, applying the REAL
// acceptNode filter collectVisibleTextMatches() constructs (query match +
// LFL.axtree.isElementVisible(parent)) - not a shortcut around it.
function setScriptedTextNodes(sandbox, entries) {
  sandbox.document.__textNodes = entries.map((e) => ({
    textContent: e.text,
    parentElement: { __visible: e.visible !== false },
  }));
}

function buildSandbox(opts) {
  const options = opts || {};
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.HTMLInputElement = function HTMLInputElement() {};
  sandbox.HTMLTextAreaElement = function HTMLTextAreaElement() {};
  sandbox.Event = function Event(type, o) { this.type = type; Object.assign(this, o || {}); };
  sandbox.KeyboardEvent = function KeyboardEvent(type, o) { this.type = type; Object.assign(this, o || {}); };
  sandbox.URL = URL;
  sandbox.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
  sandbox.setTimeout = () => 0;
  sandbox.location = { origin: 'https://example.com', href: 'https://example.com/page' };

  sandbox.document = {
    baseURI: 'https://example.com/page',
    title: 'Example',
    body: { textContent: '' },
    __qsa: [],
    __textNodes: [],
    adoptedStyleSheets: [],
    querySelectorAll() { return sandbox.document.__qsa; },
    querySelector() { return null; },
    // Faithful-but-simplified stand-in: iterates the scripted __textNodes
    // list, running the REAL acceptNode filter engine.js's
    // collectVisibleTextMatches() constructs (its own query-match +
    // visibility check), same contract document.createTreeWalker's real
    // FILTER_ACCEPT/FILTER_SKIP loop has.
    createTreeWalker(_root, _whatToShow, filterObj) {
      const nodes = sandbox.document.__textNodes;
      let i = -1;
      return {
        nextNode() {
          for (;;) {
            i += 1;
            if (i >= nodes.length) return null;
            const node = nodes[i];
            if (filterObj.acceptNode(node) === sandbox.NodeFilter.FILTER_ACCEPT) return node;
          }
        },
      };
    },
  };

  // Only installed unless the test explicitly asks for the unsupported-
  // browser environment (§7 check group 6) - highlightApiAvailable() must
  // see a genuinely missing API, not a stubbed-out one.
  if (!options.noHighlightApi) {
    sandbox.CSS = { highlights: new Map() };
    sandbox.Highlight = function Highlight(...ranges) { this.ranges = ranges; };
    sandbox.Range = function Range() { this._start = null; this._end = null; };
    sandbox.Range.prototype.setStart = function setStart(node, offset) { this._start = { node, offset }; };
    sandbox.Range.prototype.setEnd = function setEnd(node, offset) { this._end = { node, offset }; };
    sandbox.CSSStyleSheet = function CSSStyleSheet() { this._css = null; };
    sandbox.CSSStyleSheet.prototype.replaceSync = function replaceSync(css) { this._css = css; };
  }

  vm.createContext(sandbox);

  vm.runInContext(fs.readFileSync(GUARDS_PATH, 'utf8'), sandbox, { filename: 'guards.js' });

  // Same faithful-but-simplified LFL.axtree stand-in tests/m4_friction.test.js
  // uses - see its header comment.
  sandbox.window.LFL.axtree = {
    resolve(map, index) {
      const ref = map.get(index);
      if (!ref) return null;
      const el = typeof ref.deref === 'function' ? ref.deref() : ref;
      if (!el) return null;
      if (el.isConnected === false) return null;
      if (el.__visible === false) return null;
      return el;
    },
    isElementVisible(el) { return !!el && el.__visible !== false; },
    frameOptsFor() { return undefined; },
  };

  vm.runInContext(fs.readFileSync(EXECUTOR_PATH, 'utf8'), sandbox, { filename: 'executor.js' });
  assert.strictEqual(typeof sandbox.window.LFL.executor.execute, 'function');

  vm.runInContext(fs.readFileSync(REGISTRY_PATH, 'utf8'), sandbox, { filename: 'registry.js' });
  assert.strictEqual(typeof sandbox.window.LFL.registry.createRegistry, 'function');

  vm.runInContext(fs.readFileSync(ENGINE_PATH, 'utf8'), sandbox, { filename: 'engine.js' });
  assert.strictEqual(typeof sandbox.window.LFL.engine.tryDeterministic, 'function');

  return sandbox;
}

function freshState() {
  return {
    listingContext: null, findContext: null, highlightContext: null,
    pendingCrossOriginUrl: null, rlBudgetCache: null,
  };
}

function fakeStorageArea() {
  const data = {};
  return {
    _data: data,
    get(keys, cb) {
      const out = {};
      keys.forEach((k) => { if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k]; });
      cb(out);
    },
    set(obj) { Object.assign(data, obj); },
  };
}

// =====================================================================
// Part 1 - pure math: findOccurrenceOffsets / parseHighlightArg /
// formatHighlightSummary (design doc §2/§6/§7).
// =====================================================================

function testPureHelpers() {
  console.log('\n[1] pure helpers - findOccurrenceOffsets / parseHighlightArg / formatHighlightSummary');

  const sandbox = buildSandbox();
  const engine = sandbox.window.LFL.engine;

  check('findOccurrenceOffsets: single occurrence', () => {
    const r = engine.findOccurrenceOffsets('the quick fox', 'quick');
    assert.deepStrictEqual(Array.from(r).map((o) => [o.start, o.end]), [[4, 9]]);
  });

  check('findOccurrenceOffsets: multiple occurrences in one node', () => {
    const r = engine.findOccurrenceOffsets('foo bar foo baz foo', 'foo');
    assert.strictEqual(r.length, 3);
    assert.deepStrictEqual([r[0].start, r[1].start, r[2].start], [0, 8, 16]);
  });

  check('findOccurrenceOffsets: case-insensitive', () => {
    const r = engine.findOccurrenceOffsets('FOO Foo fOO', 'foo');
    assert.strictEqual(r.length, 3);
  });

  check('findOccurrenceOffsets: non-overlapping - "aa" against "aaa" is exactly one match', () => {
    const r = engine.findOccurrenceOffsets('aaa', 'aa');
    assert.strictEqual(r.length, 1);
    assert.deepStrictEqual([r[0].start, r[0].end], [0, 2]);
  });

  check('findOccurrenceOffsets: empty text or query -> [], no throw', () => {
    assert.strictEqual(engine.findOccurrenceOffsets('', 'x').length, 0);
    assert.strictEqual(engine.findOccurrenceOffsets('x', '').length, 0);
    assert.strictEqual(engine.findOccurrenceOffsets(null, 'x').length, 0);
    assert.strictEqual(engine.findOccurrenceOffsets('x', null).length, 0);
  });

  check('parseHighlightArg: empty/whitespace -> status', () => {
    // spread into a test-realm object: parseHighlightArg's result is built in
    // the vm sandbox realm, so its prototype differs from a bare literal's and
    // deepStrictEqual's prototype check would fail on structurally-equal values.
    assert.deepStrictEqual({ ...engine.parseHighlightArg('') }, { mode: 'status' });
    assert.deepStrictEqual({ ...engine.parseHighlightArg('   ') }, { mode: 'status' });
    assert.deepStrictEqual({ ...engine.parseHighlightArg(null) }, { mode: 'status' });
  });

  check('parseHighlightArg: "clear" (any case, trimmed) -> clear', () => {
    assert.deepStrictEqual({ ...engine.parseHighlightArg('clear') }, { mode: 'clear' });
    assert.deepStrictEqual({ ...engine.parseHighlightArg('  CLEAR  ') }, { mode: 'clear' });
  });

  check('parseHighlightArg: anything else -> set, with the trimmed query', () => {
    assert.deepStrictEqual({ ...engine.parseHighlightArg('  foo bar  ') }, { mode: 'set', query: 'foo bar' });
  });

  check('formatHighlightSummary: 0 matches', () => {
    assert.strictEqual(engine.formatHighlightSummary(0, false, 2000, 'zzz'), 'no matches for "zzz"');
  });

  check('formatHighlightSummary: N matches, not capped', () => {
    assert.strictEqual(engine.formatHighlightSummary(3, false, 2000, 'foo'), 'highlighted 3 matches');
  });

  check('formatHighlightSummary: capped', () => {
    assert.strictEqual(
      engine.formatHighlightSummary(2000, true, 2000, 'e'),
      'highlighted 2000 of 2000+ matches for "e" (capped)',
    );
  });
}

// =====================================================================
// Part 2 - dispatch totality: every `highlight`-prefixed input returns
// non-null (never falls through to the LLM); a non-space-separated
// lookalike returns null (goes to did-you-mean, not us).
// =====================================================================

function testDispatchTotality() {
  console.log('\n[2] dispatch totality - highlight/highlight clear/bare highlight always handled');

  const sandbox = buildSandbox();
  setScriptedTextNodes(sandbox, [{ text: 'foo appears here' }]);

  check('`highlight foo` returns non-null', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('highlight foo', freshState());
    assert.ok(det);
  });

  check('`highlight clear` returns non-null', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('highlight clear', freshState());
    assert.ok(det);
  });

  check('bare `highlight` returns non-null', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('highlight', freshState());
    assert.ok(det);
  });

  check('`highlightfoo` (no space) returns null - not our verb, falls through to did-you-mean', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('highlightfoo', freshState());
    assert.strictEqual(det, null);
  });
}

// =====================================================================
// Part 3 - paint + shared context: CSS.highlights gets the right Range
// count, state.highlightContext/findContext are populated per design doc
// §2/§5, and a following bare `find` steps to match 1/N.
// =====================================================================

function testPaintAndContext() {
  console.log('\n[3] paint + context - CSS.highlights, highlightContext, shared findContext (idx:-1)');

  const sandbox = buildSandbox();
  // Two visible nodes: one with 2 occurrences of "foo", one with 1 - and one
  // INVISIBLE node with "foo" that must be excluded (shared collector, §2).
  setScriptedTextNodes(sandbox, [
    { text: 'foo bar foo' },      // 2 occurrences
    { text: 'another foo here' }, // 1 occurrence
    { text: 'foo but hidden', visible: false },
  ]);

  const state = freshState();
  const det = sandbox.window.LFL.engine.tryDeterministic('highlight foo', state);

  check('output reports the correct total occurrence count (3, across 2 visible nodes) plus the matches hint', () => {
    assert.strictEqual(det.output, 'highlighted 3 matches - type "matches" to list them');
  });

  check('CSS.highlights has the "lfl-hl" entry with exactly 3 Ranges registered', () => {
    assert.ok(sandbox.CSS.highlights.has('lfl-hl'));
    const hl = sandbox.CSS.highlights.get('lfl-hl');
    assert.strictEqual(hl.ranges.length, 3);
  });

  check('state.highlightContext = {query, count, capped:false}', () => {
    assert.deepStrictEqual({ ...state.highlightContext }, { query: 'foo', count: 3, capped: false });
  });

  check('state.findContext shares the query, idx:-1 (not find\'s own idx:0), and the node-level match list', () => {
    assert.strictEqual(state.findContext.query, 'foo');
    assert.strictEqual(state.findContext.idx, -1);
    assert.strictEqual(state.findContext.matches.length, 2, 'node-level list - 2 visible nodes, not 3 occurrences');
  });

  check('a following bare `find` steps to match 1/N using the shared context', () => {
    const findDet = sandbox.window.LFL.engine.tryDeterministic('find', state);
    assert.strictEqual(findDet.output, 'match 1/2');
    assert.strictEqual(state.findContext.idx, 0);
  });

  check('the adopted stylesheet was installed exactly once, containing the ::highlight(lfl-hl) rule', () => {
    assert.strictEqual(sandbox.document.adoptedStyleSheets.length, 1);
    assert.match(sandbox.document.adoptedStyleSheets[0]._css, /::highlight\(lfl-hl\)/);
  });

  check('bare `highlight` (status) reports the active query and count', () => {
    const statusDet = sandbox.window.LFL.engine.tryDeterministic('highlight', state);
    assert.strictEqual(statusDet.output, 'highlight: "foo" - 3 matches marked');
  });
}

// =====================================================================
// Part 4 - replace / clear / miss semantics (design doc §2/§5/§6).
// =====================================================================

function testReplaceClearMiss() {
  console.log('\n[4] replace/clear/miss - second highlight replaces, clear tears down, a miss clears stale marks');

  check('a second `highlight <other>` REPLACES the registry entry (old Ranges gone)', () => {
    const sandbox = buildSandbox();
    setScriptedTextNodes(sandbox, [{ text: 'foo and bar both here' }]);
    const state = freshState();
    sandbox.window.LFL.engine.tryDeterministic('highlight foo', state);
    const firstRanges = sandbox.CSS.highlights.get('lfl-hl').ranges;
    sandbox.window.LFL.engine.tryDeterministic('highlight bar', state);
    const secondRanges = sandbox.CSS.highlights.get('lfl-hl').ranges;
    assert.notStrictEqual(firstRanges, secondRanges);
    assert.strictEqual(state.highlightContext.query, 'bar');
    assert.strictEqual(state.findContext.query, 'bar');
  });

  check('`highlight clear` empties the registry entry, nulls both contexts, and reports "highlight cleared"', () => {
    const sandbox = buildSandbox();
    setScriptedTextNodes(sandbox, [{ text: 'foo here' }]);
    const state = freshState();
    sandbox.window.LFL.engine.tryDeterministic('highlight foo', state);
    const det = sandbox.window.LFL.engine.tryDeterministic('highlight clear', state);
    assert.strictEqual(det.output, 'highlight cleared');
    assert.strictEqual(sandbox.CSS.highlights.has('lfl-hl'), false);
    assert.strictEqual(state.highlightContext, null);
    assert.strictEqual(state.findContext, null);
  });

  check('re-running `highlight clear` with nothing active reports "no active highlight"', () => {
    const sandbox = buildSandbox();
    const state = freshState();
    const det = sandbox.window.LFL.engine.tryDeterministic('highlight clear', state);
    assert.strictEqual(det.output, 'no active highlight');
  });

  check('`highlight clear` only nulls findContext if it still belongs to the highlight\'s own query (§5 item 1)', () => {
    const sandbox = buildSandbox();
    setScriptedTextNodes(sandbox, [{ text: 'foo here' }, { text: 'bar here' }]);
    const state = freshState();
    sandbox.window.LFL.engine.tryDeterministic('highlight foo', state);
    // find retargets findContext on its own, breaking the pairing.
    sandbox.window.LFL.engine.tryDeterministic('find bar', state);
    assert.strictEqual(state.findContext.query, 'bar');
    sandbox.window.LFL.engine.tryDeterministic('highlight clear', state);
    assert.strictEqual(state.highlightContext, null);
    assert.strictEqual(state.findContext.query, 'bar', 'find\'s own later context must survive - it no longer belongs to the cleared highlight');
  });

  check('a no-match retarget tears down the PREVIOUS paint too - no stale marks for the old query', () => {
    const sandbox = buildSandbox();
    setScriptedTextNodes(sandbox, [{ text: 'foo here' }]);
    const state = freshState();
    sandbox.window.LFL.engine.tryDeterministic('highlight foo', state);
    assert.ok(sandbox.CSS.highlights.has('lfl-hl'));
    const det = sandbox.window.LFL.engine.tryDeterministic('highlight nowhere-to-be-found', state);
    assert.strictEqual(det.output, 'no matches for "nowhere-to-be-found"');
    assert.strictEqual(sandbox.CSS.highlights.has('lfl-hl'), false, 'the old paint must be gone, not left stale');
    assert.strictEqual(state.highlightContext, null);
    assert.strictEqual(state.findContext, null);
  });

  check('global `clear` (via tryDeterministic) tears down an active highlight too', () => {
    const sandbox = buildSandbox();
    setScriptedTextNodes(sandbox, [{ text: 'foo here' }]);
    const state = freshState();
    sandbox.window.LFL.engine.tryDeterministic('highlight foo', state);
    const det = sandbox.window.LFL.engine.tryDeterministic('clear', state);
    assert.strictEqual(det.clear, true);
    assert.strictEqual(sandbox.CSS.highlights.has('lfl-hl'), false);
    assert.strictEqual(state.highlightContext, null);
  });

  check('bare `highlight` with no active highlight -> gentle status message, not an error', () => {
    const sandbox = buildSandbox();
    const det = sandbox.window.LFL.engine.tryDeterministic('highlight', freshState());
    assert.strictEqual(det.output, 'no active highlight - try: highlight <text>');
  });

  check('`find`\'s own behavior is untouched by any of this - a bare find with no context still says so', () => {
    const sandbox = buildSandbox();
    const det = sandbox.window.LFL.engine.tryDeterministic('find', freshState());
    assert.strictEqual(det.output, 'no active find - try: find <text>');
  });
}

// =====================================================================
// Part 5 - cap: HIGHLIGHT_MAX_RANGES stops scanning, not collect-then-slice.
// =====================================================================

function testCap() {
  console.log('\n[5] cap - HIGHLIGHT_MAX_RANGES=2000, capped:true, summary says so');

  const sandbox = buildSandbox();
  const CAP = 2000;
  // 2100 separate visible nodes, one occurrence of "e" each - comfortably
  // over the cap without needing pathological single-node occurrence counts.
  const nodes = [];
  for (let i = 0; i < CAP + 100; i += 1) nodes.push({ text: `e-${i}` });
  setScriptedTextNodes(sandbox, nodes);

  const state = freshState();
  const det = sandbox.window.LFL.engine.tryDeterministic('highlight e', state);

  check('exactly CAP Ranges registered, no more', () => {
    const hl = sandbox.CSS.highlights.get('lfl-hl');
    assert.strictEqual(hl.ranges.length, CAP);
  });

  check('state.highlightContext.capped is true, count is exactly CAP', () => {
    assert.strictEqual(state.highlightContext.capped, true);
    assert.strictEqual(state.highlightContext.count, CAP);
  });

  check('summary line reports the capped wording plus the matches hint', () => {
    assert.strictEqual(det.output, `highlighted ${CAP} of ${CAP}+ matches for "e" (capped) - type "matches" to list them`);
  });

  check('status line also discloses the cap, honestly', () => {
    const statusDet = sandbox.window.LFL.engine.tryDeterministic('highlight', state);
    assert.strictEqual(statusDet.output, `highlight: "e" - ${CAP} matches marked (capped)`);
  });
}

// =====================================================================
// Part 6 - fail-closed environment: no CSS Custom Highlight API support.
// =====================================================================

function testFailClosedEnvironment() {
  console.log('\n[6] fail-closed environment - no CSS.highlights/Highlight -> not-supported error, nothing thrown, no context set');

  const sandbox = buildSandbox({ noHighlightApi: true });
  setScriptedTextNodes(sandbox, [{ text: 'foo here' }]);
  const state = freshState();

  check('`highlight foo` does not throw and returns the not-supported message', () => {
    let det;
    assert.doesNotThrow(() => { det = sandbox.window.LFL.engine.tryDeterministic('highlight foo', state); });
    assert.strictEqual(det.output, 'highlight: not supported by this browser (CSS Custom Highlight API required)');
  });

  check('no context was set as a side effect of the failed attempt', () => {
    assert.strictEqual(state.highlightContext, null);
  });

  check('`highlight clear` and bare `highlight` still behave (gentle no-op, no throw) even with no API', () => {
    assert.doesNotThrow(() => sandbox.window.LFL.engine.tryDeterministic('highlight clear', state));
    assert.doesNotThrow(() => sandbox.window.LFL.engine.tryDeterministic('highlight', state));
  });
}

// =====================================================================
// Part 7 - registry/vocab locks: RESERVED_NAMES, commandRegistry entry,
// did-you-mean.
// =====================================================================

function testRegistryAndVocabLocks() {
  console.log('\n[7] registry/vocab locks - RESERVED_NAMES, commandRegistry entry, did-you-mean');

  check('an alias named "highlight" -> REJECTED (built-in cannot be shadowed)', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    const r = store.setAlias('highlight', 'find foo');
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.reason, /built-in command/);
  });

  check('a macro named "highlight" -> REJECTED (same reserved-word lock)', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    const r = store.setMacro('highlight', 'go example.com && find foo');
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.reason, /built-in command/);
  });

  check('`commandRegistry.get("highlight")` exists with the documented argSpec', () => {
    const sandbox = buildSandbox();
    const entry = sandbox.window.LFL.commandRegistry.get('highlight');
    assert.ok(entry, 'highlight must be a registered command');
    assert.strictEqual(entry.argSpec, 'highlight <text> | highlight clear | highlight');
  });

  check('`man highlight` works (reg.manText via tryDeterministic\'s `man <cmd>` branch)', () => {
    const sandbox = buildSandbox();
    const det = sandbox.window.LFL.engine.tryDeterministic('man highlight', freshState());
    assert.match(det.output, /^highlight\n/);
    assert.match(det.output, /highlight <text> \| highlight clear \| highlight/);
  });

  check('did-you-mean: "hihglight foo" (typo) suggests "highlight" against the REAL registered surface', () => {
    const sandbox = buildSandbox();
    const realNames = sandbox.window.LFL.commandRegistry.names();
    assert.ok(realNames.includes('highlight'), 'sanity: highlight must be a real registered name');
    const r = Array.from(sandbox.window.LFL.registry.didYouMean('hihglight foo', realNames));
    assert.ok(r.includes('highlight'), JSON.stringify(r));
  });

  check('an EXACT "highlight foo" -> did-you-mean suggests nothing (would already dispatch deterministically)', () => {
    const sandbox = buildSandbox();
    const realNames = sandbox.window.LFL.commandRegistry.names();
    const r = registry.didYouMean('highlight foo', realNames);
    assert.deepStrictEqual(r, []);
  });
}

// =====================================================================
// Part 8 - isolation: the pre-existing nav-lane isolation and
// vocabulary-enumeration suites still pass byte-identically, service-
// worker.js is untouched by this build, and the static grep gates pass.
// =====================================================================

function testIsolation() {
  console.log('\n[8] isolation - nav-lane payload/vocabulary suites still pass, service-worker.js untouched, gates green');

  check('extension/background/service-worker.js has no "highlight" string anywhere - no payload/protocol change', () => {
    const sw = fs.readFileSync(SW_PATH, 'utf8');
    assert.ok(!/highlight/i.test(sw), 'service-worker.js must be completely untouched by M4c');
  });

  check('tests/m3_nav_lane_isolation.test.js (nav-lane payload + page-lane schema enum proofs) still exits 0', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'm3_nav_lane_isolation.test.js')], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  });

  check('tests/m4_friction.test.js (find\'s own suite, byte-identical dependency) still exits 0', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'm4_friction.test.js')], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  });

  check('tests/check_no_egress.sh PASSES (highlight has no fetch/network anywhere near it)', () => {
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
}

// =====================================================================
// Part 9 - `matches` (2026-07-14): list the current find/highlight matches
// with context. matchSnippet is pure; doMatches reuses the shared
// findContext so its count and `find`'s stepping stay in lockstep.
// =====================================================================

function testMatches() {
  console.log('\n[9] matches - list current find/highlight matches with context');

  const engine = buildSandbox().window.LFL.engine;

  check('matchSnippet: centres on the query with "..." where trimmed, whitespace collapsed', () => {
    const s = engine.matchSnippet('alpha beta gamma FOOD delta epsilon zeta eta theta iota kappa', 'food', 6);
    assert.ok(s.includes('FOOD'), s);
    assert.ok(s.startsWith('...') && s.endsWith('...'), s);
    assert.ok(!/\s\s/.test(s), 'inner whitespace stays single-spaced');
  });

  check('matchSnippet: short text that fits the window has no ellipses', () => {
    assert.strictEqual(engine.matchSnippet('food is here', 'food', 32), 'food is here');
  });

  check('matchSnippet: empty query / not-found / null -> head truncation, never throws', () => {
    assert.strictEqual(engine.matchSnippet('short text', '', 32), 'short text');
    assert.strictEqual(engine.matchSnippet('short text', 'zzz', 32), 'short text');
    assert.doesNotThrow(() => engine.matchSnippet(null, null, 32));
  });

  check('matchSnippet: case-insensitive on the query', () => {
    const s = engine.matchSnippet('xxxxx Penguin yyyyy', 'PENGUIN', 3);
    assert.ok(s.toLowerCase().includes('penguin'), s);
  });

  const sandbox = buildSandbox();
  setScriptedTextNodes(sandbox, [
    { text: 'foo bar foo' },
    { text: 'another foo here' },
  ]);
  const state = freshState();
  sandbox.window.LFL.engine.tryDeterministic('highlight foo', state);

  check('`matches` lists one numbered line per find-navigable node under a header count', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('matches', state);
    const lines = det.output.split('\n');
    assert.strictEqual(lines[0], '2 matches for "foo"');
    assert.strictEqual(lines.length, 3, det.output);
    assert.match(lines[1], /^ 1\. /);
    assert.match(lines[2], /^ 2\. /);
    assert.ok(lines[1].includes('foo'));
  });

  check('the active `find` cursor is marked with ">" after stepping', () => {
    sandbox.window.LFL.engine.tryDeterministic('find', state); // advances idx to 0
    const det = sandbox.window.LFL.engine.tryDeterministic('matches', state);
    const lines = det.output.split('\n');
    assert.match(lines[1], /^>1\. /, lines[1]);
    assert.match(lines[2], /^ 2\. /, lines[2]);
  });

  check('`matches` with no active context -> gentle guidance, no throw', () => {
    const det = sandbox.window.LFL.engine.tryDeterministic('matches', freshState());
    assert.strictEqual(det.output, 'no matches - run "highlight <text>" or "find <text>" first');
  });

  check('`matches` dispatches deterministically; "matchesx" does not (would fall through)', () => {
    assert.notStrictEqual(sandbox.window.LFL.engine.tryDeterministic('matches', state), null);
    assert.strictEqual(sandbox.window.LFL.engine.tryDeterministic('matchesx', freshState()), null);
  });

  check('the natural "show matches" / "list matches" phrasings also resolve to `matches`', () => {
    const showDet = sandbox.window.LFL.engine.tryDeterministic('show matches', state);
    const listDet = sandbox.window.LFL.engine.tryDeterministic('list matches', state);
    assert.ok(showDet && showDet.output.startsWith('2 matches for "foo"'), JSON.stringify(showDet));
    assert.ok(listDet && listDet.output.startsWith('2 matches for "foo"'), JSON.stringify(listDet));
    // but an unrelated "show ..." is NOT swallowed - it still falls through
    assert.strictEqual(sandbox.window.LFL.engine.tryDeterministic('show me the money', freshState()), null);
  });

  check('"matches" is reserved (an alias cannot shadow it)', () => {
    const store = registry.createAliasStore(fakeStorageArea());
    assert.strictEqual(store.setAlias('matches', 'find foo').ok, false);
  });

  check('`highlight` output now carries the discoverability hint', () => {
    const s2 = buildSandbox();
    setScriptedTextNodes(s2, [{ text: 'foo here' }]);
    const det = s2.window.LFL.engine.tryDeterministic('highlight foo', freshState());
    assert.ok(det.output.includes('type "matches" to list them'), det.output);
  });
}

// ---- run everything ----

console.log('tests/m4c_highlight.test.js - M4c `highlight`: paint/count/clear, CSS Custom Highlight API');
testPureHelpers();
testDispatchTotality();
testPaintAndContext();
testReplaceClearMiss();
testCap();
testFailClosedEnvironment();
testRegistryAndVocabLocks();
testIsolation();
testMatches();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
