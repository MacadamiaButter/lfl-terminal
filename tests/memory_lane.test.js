#!/usr/bin/env node
/**
 * tests/memory_lane.test.js - the terminal-memory M1/M2/M3 build
 * (LFL-TERMINAL-MEMORY-LANE-DESIGN.md, all three phases: a deterministic,
 * opt-in, local-only command-usage store + its controls + a print-only
 * repeat-detector (M1/M2, no model interaction anywhere), PLUS M3's
 * buildMemoryContext() + its wiring into the trusted brainstorm/`teach`
 * lane ONLY - the one model-touching step of this whole feature).
 *
 * Four parts:
 *
 * 1. Pure-logic tests against the REAL, unmodified extension/content/
 *    registry.js (plain `require()` - registry.js is dual-mode CommonJS/
 *    browser, same posture as tests/panel_placement.test.js) - the
 *    recordVerb() choke point's arity/whitelist/origin-stripping, the cap/
 *    LRU eviction, the schema-version guard, forgetOrigin/clearMemory/
 *    setMemoryQuiet/formatMemoryDump, and the repeat-detector.
 *
 * 2. Structural proofs against the real, unmodified extension/content/
 *    terminal.js source (regex/string assertions, same technique
 *    tests/toolbar_action.test.js and tests/m5b_script_sharing.test.js use
 *    for glue code that isn't worth a full DOM/vm simulation) - default OFF,
 *    the two (and only two) recording choke points, the `forget` origin-
 *    shape guard, RESERVED_NAMES coverage, and (M3) the `teach save that`
 *    gating/wiring shape.
 *
 * 3. M3: buildMemoryContext() purity - whitelisted-fields-only output
 *    (verbs/counts/script-names, never an argument/URL/raw serialization),
 *    fed adversarial memory with argument-shaped garbage hand-inserted in
 *    every reachable position, arity, caps, and determinism.
 *
 * 4. THE CRITICAL isolation proof, a direct clone of
 *    tests/brainstorm_lane_isolation.test.js's own method: loads the REAL
 *    background/service-worker.js via Node's `vm` module with a fake `fetch`
 *    that captures the exact request body sent to the local model, and
 *    proves (a) the execution-lane (`LFL_LLM_REQUEST`) and brainstorm-lane
 *    (`BRAINSTORM_LLM_REQUEST`) payload builders produce BYTE-IDENTICAL
 *    request bodies whether chrome.storage.local holds populated memory
 *    data or nothing at all when no `memoryContext` is attached to the
 *    outgoing message; (b) the brainstorm-lane payload WITH a `memoryContext`
 *    field attached gains exactly one clearly-labeled extra `system`
 *    message, never touching the existing system prompt or the user's own
 *    goal-turn JSON; and (c) the execution lane ignores a `memoryContext`
 *    field entirely, even when a caller's message object carries one -
 *    service-worker.js still never reads chrome.storage.local anywhere,
 *    memory only ever reaches a payload as a plain string the CONTENT
 *    script (terminal.js) already built and attached to the outgoing
 *    message itself.
 *
 * GOTCHA (from a previous session, see brainstorm_lane_isolation.test.js's
 * own header): comparing objects/arrays returned OUT of a vm sandbox with
 * deepStrictEqual can trip on Object.prototype identity across realms -
 * normalize with JSON.parse(JSON.stringify(x)) (used throughout parts 3-4
 * below) before comparing.
 *
 * Run: node tests/memory_lane.test.js
 * Exit code 0 = all assertions passed, nonzero = failure (prints which).
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const registry = require(path.join(ROOT, 'extension', 'content', 'registry.js'));
const SW_PATH = path.join(ROOT, 'extension', 'background', 'service-worker.js');
const RATELIMIT_PATH = path.join(ROOT, 'extension', 'content', 'ratelimit.js');
const TERMINAL_PATH = path.join(ROOT, 'extension', 'content', 'terminal.js');

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

async function acheck(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   - ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${e && e.message ? e.message : e}`);
  }
}

// Cross-realm-safe normalize (see the GOTCHA in the header comment above).
function realm(x) {
  return JSON.parse(JSON.stringify(x));
}

// Deterministic Date.now() stand-in for eviction/ordering tests - restores
// the real Date.now afterward no matter how the callback exits.
function withFixedClock(startMs, fn) {
  const orig = Date.now;
  let t = startMs;
  Date.now = () => t++;
  try { return fn(); } finally { Date.now = orig; }
}

console.log('tests/memory_lane.test.js - terminal memory (M1/M2 deterministic core)');

// =====================================================================
// PART 1 - recordVerb() choke point: arity, whitelist, origin-stripping
// =====================================================================

check('recordVerb has arity 3: (memoryObject, origin, verb) - no fourth parameter for an argument to ride in on', () => {
  assert.strictEqual(registry.recordVerb.length, 3);
});

check('recordVerb: a well-formed call records exactly one verb, count 1, on the stripped origin', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'search');
  assert.deepStrictEqual(realm(Object.keys(mem.origins)), ['https://example.com']);
  assert.strictEqual(mem.origins['https://example.com'].search.n, 1);
  assert.strictEqual(typeof mem.origins['https://example.com'].search.lastUsed, 'number');
});

check('recordVerb: fed a FULL URL (path/query/fragment) as origin, stores only scheme+host', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com/some/path?q=1#frag', 'go');
  assert.deepStrictEqual(realm(Object.keys(mem.origins)), ['https://example.com']);
});

check('recordVerb: NEVER stores an argument, even when a caller passes one as the verb - "search \\"my query\\"" is rejected (contains spaces/quotes)', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'search "my query"');
  assert.deepStrictEqual(realm(mem.origins), {});
});

check('recordVerb: an argument-shaped multi-word string ("book the flight") is rejected outright', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'book the flight');
  assert.deepStrictEqual(realm(mem.origins), {});
});

check('recordVerb: unknown-verb-shaped junk is ignored - empty string', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', '');
  assert.deepStrictEqual(realm(mem.origins), {});
});

check('recordVerb: unknown-verb-shaped junk is ignored - starts with a digit/hyphen', () => {
  let mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', '123abc');
  assert.deepStrictEqual(realm(mem.origins), {});
  mem = registry.recordVerb(mem, 'https://example.com', '-bad');
  assert.deepStrictEqual(realm(mem.origins), {});
});

check('recordVerb: unknown-verb-shaped junk is ignored - too long (>24 chars)', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'a'.repeat(30));
  assert.deepStrictEqual(realm(mem.origins), {});
});

check('recordVerb: an invalid origin (no host, e.g. "javascript:alert(1)") is a no-op', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'javascript:alert(1)', 'click');
  assert.deepStrictEqual(realm(mem.origins), {});
});

check('recordVerb: a non-http(s) scheme (e.g. "ftp://x.com") is rejected', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'ftp://x.com', 'click');
  assert.deepStrictEqual(realm(mem.origins), {});
});

check('recordVerb: repeated calls for the same verb+origin increment n and bump lastUsed', () => {
  withFixedClock(1000, () => {
    let mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'read');
    mem = registry.recordVerb(mem, 'https://example.com', 'read');
    mem = registry.recordVerb(mem, 'https://example.com', 'read');
    assert.strictEqual(mem.origins['https://example.com'].read.n, 3);
  });
});

check('recordVerb: verb is case-normalized (Search === search)', () => {
  let mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'Search');
  mem = registry.recordVerb(mem, 'https://example.com', 'search');
  assert.deepStrictEqual(realm(Object.keys(mem.origins['https://example.com'])), ['search']);
  assert.strictEqual(mem.origins['https://example.com'].search.n, 2);
});

check('recordVerb: a bare host with no scheme (hand-typed) is accepted via the https:// fallback', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'example.com', 'go');
  assert.deepStrictEqual(realm(Object.keys(mem.origins)), ['https://example.com']);
});

check('recordVerb: distinct origins are tracked separately', () => {
  let mem = registry.recordVerb(registry.createEmptyMemory(), 'https://a.com', 'go');
  mem = registry.recordVerb(mem, 'https://b.com', 'go');
  assert.deepStrictEqual(realm(Object.keys(mem.origins).sort()), ['https://a.com', 'https://b.com']);
});

// =====================================================================
// PART 2 - cap + LRU eviction
// =====================================================================

check('recordVerb: verbs/origin cap (64) evicts the stalest verb first (LRU by lastUsed)', () => {
  withFixedClock(1, () => {
    let mem = registry.createEmptyMemory();
    for (let i = 0; i < registry.MEMORY_MAX_VERBS_PER_ORIGIN + 1; i++) {
      mem = registry.recordVerb(mem, 'https://example.com', `v${i}`);
    }
    const verbs = Object.keys(mem.origins['https://example.com']);
    assert.strictEqual(verbs.length, registry.MEMORY_MAX_VERBS_PER_ORIGIN);
    assert.ok(!verbs.includes('v0'), 'the oldest verb (v0) should have been evicted');
    assert.ok(verbs.includes(`v${registry.MEMORY_MAX_VERBS_PER_ORIGIN}`), 'the newest verb should still be present');
  });
});

check('recordVerb: origins cap (200) evicts the stalest origin first (LRU by its own latest verb)', () => {
  withFixedClock(1, () => {
    let mem = registry.createEmptyMemory();
    for (let i = 0; i < registry.MEMORY_MAX_ORIGINS + 1; i++) {
      mem = registry.recordVerb(mem, `https://o${i}.com`, 'go');
    }
    const origins = Object.keys(mem.origins);
    assert.strictEqual(origins.length, registry.MEMORY_MAX_ORIGINS);
    assert.ok(!origins.includes('https://o0.com'), 'the oldest origin (o0) should have been evicted');
    assert.ok(origins.includes(`https://o${registry.MEMORY_MAX_ORIGINS}.com`), 'the newest origin should still be present');
  });
});

check('recordVerb: an evicted origin\'s "recent" ring is evicted too - the two maps never drift apart', () => {
  withFixedClock(1, () => {
    let mem = registry.createEmptyMemory();
    for (let i = 0; i < registry.MEMORY_MAX_ORIGINS + 1; i++) {
      mem = registry.recordVerb(mem, `https://o${i}.com`, 'go');
    }
    assert.ok(!Object.prototype.hasOwnProperty.call(mem.recent, 'https://o0.com'));
  });
});

check('recordVerb: the per-origin "recent" ring is capped (MEMORY_MAX_RECENT_PER_ORIGIN) and keeps only the newest, in order', () => {
  let mem = registry.createEmptyMemory();
  const cap = registry.MEMORY_MAX_RECENT_PER_ORIGIN;
  for (let i = 0; i < cap + 1; i++) {
    mem = registry.recordVerb(mem, 'https://example.com', `v${i}`);
  }
  const ring = mem.recent['https://example.com'];
  assert.strictEqual(ring.length, cap);
  assert.strictEqual(ring[0], 'v1', 'oldest entry (v0) should have fallen off the front');
  assert.strictEqual(ring[ring.length - 1], `v${cap}`, 'newest entry should be last');
});

// =====================================================================
// PART 3 - schema-version guard
// =====================================================================

check('normalizeMemory: null/undefined/non-object input resets to an empty v1 store', () => {
  assert.deepStrictEqual(realm(registry.normalizeMemory(null)), realm(registry.createEmptyMemory()));
  assert.deepStrictEqual(realm(registry.normalizeMemory(undefined)), realm(registry.createEmptyMemory()));
  assert.deepStrictEqual(realm(registry.normalizeMemory('garbage')), realm(registry.createEmptyMemory()));
  assert.deepStrictEqual(realm(registry.normalizeMemory([1, 2, 3])), realm(registry.createEmptyMemory()));
});

check('normalizeMemory: a wrong/future schema version (v:2) resets to an empty v1 store', () => {
  const mem = registry.normalizeMemory({ v: 2, origins: { 'https://x.com': { go: { n: 5, lastUsed: 1 } } }, prefs: {} });
  assert.deepStrictEqual(realm(mem), realm(registry.createEmptyMemory()));
});

check('normalizeMemory: a missing "v" field resets to an empty v1 store', () => {
  const mem = registry.normalizeMemory({ origins: {}, prefs: {} });
  assert.deepStrictEqual(realm(mem), realm(registry.createEmptyMemory()));
});

check('normalizeMemory: malformed verb entries (bad n/lastUsed) are sanitized, not thrown', () => {
  const mem = registry.normalizeMemory({
    v: 1,
    origins: { 'https://x.com': { go: { n: -5, lastUsed: 'not-a-number' }, 'bad verb with spaces': { n: 1, lastUsed: 1 } } },
    prefs: {},
  });
  assert.strictEqual(mem.origins['https://x.com'].go.n, 0);
  assert.strictEqual(mem.origins['https://x.com'].go.lastUsed, 0);
  assert.ok(!Object.prototype.hasOwnProperty.call(mem.origins['https://x.com'], 'bad verb with spaces'), 'an argument/space-shaped key must never survive normalization');
});

check('normalizeMemory: unrecognized pref keys are dropped, nudgeQuiet is kept when boolean', () => {
  const mem = registry.normalizeMemory({ v: 1, origins: {}, prefs: { nudgeQuiet: true, evilInjectedPref: 'SHOULD-NOT-SURVIVE' } });
  assert.deepStrictEqual(realm(mem.prefs), { nudgeQuiet: true });
});

// =====================================================================
// PART 4 - forgetOrigin / clearMemory / setMemoryQuiet / formatMemoryDump
// =====================================================================

check('forgetOrigin: removes exactly one origin\'s record (and its recent ring), leaves others intact', () => {
  let mem = registry.recordVerb(registry.createEmptyMemory(), 'https://a.com', 'go');
  mem = registry.recordVerb(mem, 'https://b.com', 'go');
  const res = registry.forgetOrigin(mem, 'https://a.com');
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(realm(Object.keys(res.mem.origins)), ['https://b.com']);
  assert.ok(!Object.prototype.hasOwnProperty.call(res.mem.recent, 'https://a.com'));
});

check('forgetOrigin: an origin with no record fails with a clear reason, mem unchanged', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'https://a.com', 'go');
  const res = registry.forgetOrigin(mem, 'https://never-recorded.com');
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /no record/);
  assert.deepStrictEqual(realm(res.mem.origins), realm(mem.origins));
});

check('forgetOrigin: an unparseable origin argument fails cleanly, never throws', () => {
  const res = registry.forgetOrigin(registry.createEmptyMemory(), 'javascript:alert(1)');
  assert.strictEqual(res.ok, false);
});

check('clearMemory: wipes origins, prefs, and recent back to empty', () => {
  let mem = registry.recordVerb(registry.createEmptyMemory(), 'https://a.com', 'go');
  mem = registry.setMemoryQuiet(mem, true);
  const cleared = registry.clearMemory();
  assert.deepStrictEqual(realm(cleared), realm(registry.createEmptyMemory()));
});

check('setMemoryQuiet: toggles the ONE enumerated pref this phase defines, leaves origins untouched', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'https://a.com', 'go');
  const quieted = registry.setMemoryQuiet(mem, true);
  assert.strictEqual(quieted.prefs.nudgeQuiet, true);
  assert.deepStrictEqual(realm(quieted.origins), realm(mem.origins));
  const loud = registry.setMemoryQuiet(quieted, false);
  assert.strictEqual(loud.prefs.nudgeQuiet, false);
});

check('formatMemoryDump: empty store, memory off - honest "nothing recorded / off" message, no throw', () => {
  const text = registry.formatMemoryDump(registry.createEmptyMemory(), { enabled: false });
  assert.match(text, /OFF/);
  assert.match(text, /nothing recorded/i);
});

check('formatMemoryDump: empty store, memory on - "nothing recorded yet" (not "off")', () => {
  const text = registry.formatMemoryDump(registry.createEmptyMemory(), { enabled: true });
  assert.match(text, /ON/);
  assert.match(text, /nothing recorded yet/i);
});

check('formatMemoryDump: populated store lists each origin with verb(count) pairs, most-used verb first', () => {
  let mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'go');
  mem = registry.recordVerb(mem, 'https://example.com', 'search');
  mem = registry.recordVerb(mem, 'https://example.com', 'search');
  const text = registry.formatMemoryDump(mem, { enabled: true });
  assert.match(text, /https:\/\/example\.com/);
  assert.match(text, /search\(2\)/);
  assert.match(text, /go\(1\)/);
  // search(2) has the higher count, so it must be listed before go(1).
  assert.ok(text.indexOf('search(2)') < text.indexOf('go(1)'));
});

check('formatMemoryDump: NEVER emits an argument-shaped token, even fed adversarial (hand-crafted) memory content', () => {
  const poisoned = {
    v: 1,
    origins: { 'https://example.com': { search: { n: 1, lastUsed: 1 } } },
    prefs: {},
    recent: {},
  };
  const text = registry.formatMemoryDump(poisoned, { enabled: true });
  assert.ok(!text.includes('"'), 'no quote characters (arguments are always quoted in this codebase\'s conventions) should ever appear');
});

check('formatMemoryDump is deterministic - same input, same output, called twice', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'go');
  const a = registry.formatMemoryDump(mem, { enabled: true });
  const b = registry.formatMemoryDump(mem, { enabled: true });
  assert.strictEqual(a, b);
});

// =====================================================================
// PART 5 - repeat-detector (pure, no model) + nudge formatting
// =====================================================================

check('detectRepeat: does not fire below the threshold (2 repeats of a 3-length pattern, threshold 3)', () => {
  const ring = ['go', 'search', 'read', 'go', 'search', 'read'];
  const res = registry.detectRepeat(ring, 3);
  assert.strictEqual(res.fire, false);
});

check('detectRepeat: fires exactly at threshold N=3 for a 3-verb workflow, verbs-only, well-formed', () => {
  const ring = ['go', 'search', 'read', 'go', 'search', 'read', 'go', 'search', 'read'];
  const res = registry.detectRepeat(ring, 3);
  assert.strictEqual(res.fire, true);
  assert.deepStrictEqual(realm(res.verbs), ['go', 'search', 'read']);
  assert.strictEqual(res.count, 3);
});

check('detectRepeat: fires for a single verb repeated N times consecutively (unit length 1)', () => {
  const ring = ['click', 'click', 'click'];
  const res = registry.detectRepeat(ring, 3);
  assert.strictEqual(res.fire, true);
  assert.deepStrictEqual(realm(res.verbs), ['click']);
});

check('detectRepeat: an interrupted pattern (not back-to-back at the tail) does not fire', () => {
  const ring = ['go', 'search', 'read', 'click', 'go', 'search', 'read'];
  const res = registry.detectRepeat(ring, 3);
  assert.strictEqual(res.fire, false);
});

check('detectRepeat: empty or non-array input never throws, just does not fire', () => {
  assert.strictEqual(registry.detectRepeat([], 3).fire, false);
  assert.strictEqual(registry.detectRepeat(null, 3).fire, false);
  assert.strictEqual(registry.detectRepeat(undefined, 3).fire, false);
});

check('detectRepeat: default threshold is MEMORY_REPEAT_THRESHOLD (3) when none is supplied', () => {
  assert.strictEqual(registry.MEMORY_REPEAT_THRESHOLD, 3);
  const ring = ['ls', 'ls', 'ls'];
  const res = registry.detectRepeat(ring);
  assert.strictEqual(res.fire, true);
  assert.strictEqual(res.count, 3);
});

check('detectRepeat: prefers the LONGEST matching unit (a 2-verb cycle repeated 3x, not just the trailing single verb)', () => {
  const ring = ['open', 'read', 'open', 'read', 'open', 'read'];
  const res = registry.detectRepeat(ring, 3);
  assert.strictEqual(res.fire, true);
  assert.deepStrictEqual(realm(res.verbs), ['open', 'read']);
});

check('formatNudge: matches the design doc\'s exact worked example shape and mentions "teach save that" as a hint, never invoking it', () => {
  const line = registry.formatNudge(['go', 'search', 'read'], 3);
  assert.strictEqual(line, 'you\'ve run "go, search, read" here 3 times - type "teach save that" to make it a script');
});

check('detectRepeat + formatNudge round trip: no model call anywhere - detectRepeat/formatNudge never reference fetch/chrome/model', () => {
  assert.strictEqual(registry.detectRepeat.toString().match(/fetch|chrome\.|model/i), null);
  assert.strictEqual(registry.formatNudge.toString().match(/fetch|chrome\.|model/i), null);
});

// =====================================================================
// PART 6 - `memory`/`remember`/`forget` registered + reserved
// =====================================================================

check('RESERVED_NAMES: "memory"/"remember"/"forget" cannot be shadowed by an alias', () => {
  const store = registry.createAliasStore(null, []);
  for (const name of ['memory', 'remember', 'forget']) {
    const res = store.setAlias(name, 'go example.com');
    assert.strictEqual(res.ok, false, `alias named "${name}" should be rejected as a reserved built-in name`);
  }
});

check('RESERVED_NAMES: "memory"/"remember"/"forget" cannot be shadowed by a macro', () => {
  const store = registry.createAliasStore(null, []);
  for (const name of ['memory', 'remember', 'forget']) {
    const res = store.setMacro(name, 'go example.com && ls');
    assert.strictEqual(res.ok, false, `macro named "${name}" should be rejected as a reserved built-in name`);
  }
});

check('engine.js registers "memory" in the declarative command registry (help/man + vocabulary enumeration)', () => {
  const engineSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'engine.js'), 'utf8');
  assert.match(engineSrc, /reg\.register\(\{\s*\n\s*name:\s*'memory'/);
  assert.match(engineSrc, /aliases:\s*\['remember',\s*'forget'\]/);
});

// =====================================================================
// PART 7 - terminal.js structural wiring proof (default OFF, the two
// recording choke points, the `forget` origin-shape guard) - same
// regex-on-real-source technique as tests/toolbar_action.test.js.
// =====================================================================

const termSrc = fs.readFileSync(TERMINAL_PATH, 'utf8');

check('terminal.js: memory master switch defaults to false (opt-in, off by default - design doc §9 sign-off B)', () => {
  assert.match(termSrc, /this\._memoryEnabled\s*=\s*false;/);
});

check('terminal.js: the master switch is persisted under LFL.registry.MEMORY_ENABLED_KEY ("lflMemoryEnabled")', () => {
  assert.strictEqual(registry.MEMORY_ENABLED_KEY, 'lflMemoryEnabled');
  assert.match(termSrc, /MEMORY_ENABLED_KEY/);
});

check('terminal.js: _recordMemoryVerb() no-ops immediately when memory is off (checked BEFORE any storage access)', () => {
  const m = termSrc.match(/_recordMemoryVerb\(verb\)\s*\{\s*\n\s*if \(!this\._memoryEnabled\) return;/);
  assert.ok(m, '_recordMemoryVerb must check this._memoryEnabled first and return before touching storage');
});

check('terminal.js: exactly two call sites record a verb - the deterministic-dispatch branch (firstTok) and the ask/LLM branch (literal "ask")', () => {
  const detCalls = (termSrc.match(/this\._recordMemoryVerb\(firstTok\);/g) || []).length;
  const askCalls = (termSrc.match(/this\._recordMemoryVerb\('ask'\);/g) || []).length;
  assert.strictEqual(detCalls, 1, 'exactly one call recording the resolved deterministic verb');
  assert.strictEqual(askCalls, 1, 'exactly one call recording the fixed "ask" verb for the model lane');
  // No other call sites anywhere (e.g. accidentally added to go/pause/run/
  // script/teach/games/funpack branches) - total occurrences of the method
  // name is call sites (2) + its own definition (1) + comments mentioning it
  // are excluded by matching the exact call syntax above, not the bare name.
});

check('terminal.js: the ask-lane recordVerb call records the FIXED STRING "ask", never the typed command text', () => {
  assert.doesNotMatch(termSrc, /this\._recordMemoryVerb\(command\)/);
  assert.doesNotMatch(termSrc, /this\._recordMemoryVerb\(resolved\)/);
  assert.doesNotMatch(termSrc, /this\._recordMemoryVerb\(raw\)/);
});

check('terminal.js: recordVerb() is called with EXACTLY (memory-from-storage, origin, verb) - never a raw/resolved/command variable substituted for verb', () => {
  assert.match(termSrc, /LFL\.registry\.recordVerb\(res && res\[LFL\.registry\.MEMORY_KEY\], origin, verb\)/);
});

check('terminal.js: `remember` (bare word only) aliases to memory-on; `forget <origin>` requires an origin-shaped argument before it intercepts anything', () => {
  assert.match(termSrc, /if \(\/\^remember\$\/i\.test\(raw\)\) \{ this\._setMemoryEnabled\(true\); return; \}/);
  assert.match(termSrc, /forget\\s\+\\S\+\$\/i\.test\(raw\) && \/\[\.\]\|:\\\/\\\/\//, 'forget must be gated on an origin-shaped argument (contains a dot or ://), not any bare word after it');
});

check('terminal.js: `memory`/`remember`/`forget` are dispatched entirely inside _submitCommand/its handlers - never inside _runLlm or a payload-building path', () => {
  // The three dispatch regexes must appear BEFORE _runChain(raw) is called
  // in _submitCommand (i.e. they are intercepted as standalone control
  // commands, same posture as alias/macro/dev/origins - see terminal.js's
  // own comment on this), not routed through the LLM dispatch machinery.
  const submitStart = termSrc.indexOf('_submitCommand(rawInput)');
  const runChainCallIdx = termSrc.indexOf('this._runChain(raw);', submitStart);
  const memoryDispatchIdx = termSrc.indexOf("if (/^memory(\\s|$)/i.test(raw))", submitStart);
  assert.ok(submitStart > -1 && runChainCallIdx > -1 && memoryDispatchIdx > -1, 'could not locate the expected dispatch markers');
  assert.ok(memoryDispatchIdx < runChainCallIdx, 'the `memory` dispatch regex must be checked before _runChain() is reached');
});

// =====================================================================
// PART 7b - M3: `teach save that` + memory-context wiring, structural
// proofs against the real terminal.js source (same technique as PART 7 -
// this project has no DOM harness for terminal.js, see M6's own doc note
// in docs/threat-model.md for the same documented limitation).
// =====================================================================

const teachBodyStart = termSrc.indexOf('async _handleTeachCommand(raw) {');
const teachBodyEnd = termSrc.indexOf('\n    async _approveTeachSave()', teachBodyStart);
const teachBody = termSrc.slice(teachBodyStart, teachBodyEnd);

check('terminal.js: _handleTeachCommand recognizes the fixed magic phrase "save that" (case-insensitively) as goal text, not an arbitrary user description', () => {
  assert.ok(teachBodyStart > -1 && teachBodyEnd > teachBodyStart, '_handleTeachCommand body not found');
  assert.match(teachBody, /\/\^save\\s\+that\$\/i\.test\(goal\)/);
});

check('terminal.js: `teach save that` while memory is OFF is refused BEFORE any repeat-detection or rate-limit/network work - checked first inside the wantsSaveThat branch', () => {
  const wantsIdx = teachBody.indexOf('if (wantsSaveThat) {');
  const memGateIdx = teachBody.indexOf('if (!this._memoryEnabled) {', wantsIdx);
  const rlCheckIdx = teachBody.indexOf("await this._rlCheck('llm')", wantsIdx);
  assert.ok(wantsIdx > -1 && memGateIdx > -1 && rlCheckIdx > -1, 'could not locate the expected markers');
  assert.ok(wantsIdx < memGateIdx && memGateIdx < rlCheckIdx, 'the memory-enabled gate must run before the rate-limit check');
});

check('terminal.js: `teach save that` requires detectRepeat() to actually fire on the CURRENT origin before any LLM call - a non-firing repeat returns before _rlCheck', () => {
  const repIdx = teachBody.indexOf('LFL.registry.detectRepeat(ring, LFL.registry.MEMORY_REPEAT_THRESHOLD)');
  const rlCheckIdx = teachBody.indexOf("await this._rlCheck('llm')");
  assert.ok(repIdx > -1 && rlCheckIdx > -1 && repIdx < rlCheckIdx, 'detectRepeat() must be checked before the rate-limit/network call');
  assert.match(teachBody, /if \(!origin \|\| !rep\.fire\) \{/, 'a non-firing (or origin-less) repeat must be refused');
});

check('terminal.js: the `teach save that` synthesized goal is built ONLY from rep.verbs/rep.count - never references the raw "save that" text or any other input', () => {
  const m = teachBody.match(/effectiveGoal = `[^`]*\$\{rep\.verbs\.join\([^)]*\)\}[^`]*\$\{rep\.count\}[^`]*`;/);
  assert.ok(m, 'effectiveGoal in the wantsSaveThat branch must be built from rep.verbs/rep.count only');
});

check('terminal.js: buildMemoryContext() is called with (memory-snapshot, origin, script-names) - never with page content, command text, or the raw goal', () => {
  const calls = teachBody.match(/LFL\.registry\.buildMemoryContext\(mem, origin, this\._teachScriptNames\(\)\)/g) || [];
  assert.strictEqual(calls.length, 2, 'expected exactly two call sites - the wantsSaveThat branch and the plain-teach-with-memory-on branch');
});

check('terminal.js: the plain `teach <goal>` + memory-on branch does NOT override the user\'s own typed goal - effectiveGoal stays the literal `goal` there', () => {
  const elseIdx = teachBody.indexOf('} else if (this._memoryEnabled) {');
  assert.ok(elseIdx > -1, 'the plain-teach-with-memory-on branch must exist');
  const branchBody = teachBody.slice(elseIdx, teachBody.indexOf('\n      }', teachBody.indexOf('memoryContext = LFL.registry.buildMemoryContext', elseIdx)));
  assert.doesNotMatch(branchBody, /effectiveGoal\s*=/, 'the plain-teach branch must never reassign effectiveGoal - the user\'s own goal text is untouched');
});

check('terminal.js: the outgoing BRAINSTORM_LLM_REQUEST message attaches `memoryContext` ONLY inside the `memoryContext ? ... : ...` ternary - the memory-off/nothing-recorded branch sends the bare {type, goal} shape, byte-identical to pre-M3', () => {
  assert.match(
    teachBody,
    /resp = memoryContext\s*\n\s*\? await chrome\.runtime\.sendMessage\(\{ type: 'BRAINSTORM_LLM_REQUEST', goal: effectiveGoal, memoryContext \}\)\s*\n\s*: await chrome\.runtime\.sendMessage\(\{ type: 'BRAINSTORM_LLM_REQUEST', goal: effectiveGoal \}\);/,
  );
});

check('terminal.js: _loadMemorySnapshot() reads ONLY LFL.registry.MEMORY_KEY from storage and never rejects (resolves to an empty memory object on any error)', () => {
  const idx = termSrc.indexOf('_loadMemorySnapshot() {');
  const end = termSrc.indexOf('\n    }', termSrc.indexOf('\n    }', idx) + 1);
  const body = termSrc.slice(idx, end);
  assert.match(body, /chrome\.storage\.local\.get\(\[LFL\.registry\.MEMORY_KEY\]/);
  assert.doesNotMatch(body, /reject/);
});

check('terminal.js: _teachScriptNames() reads script names via this._aliasStore.listScripts() only, never touches chrome.storage or page content', () => {
  const idx = termSrc.indexOf('_teachScriptNames() {');
  const end = termSrc.indexOf('\n    }', idx);
  const body = termSrc.slice(idx, end);
  assert.match(body, /this\._aliasStore\.listScripts\(\)/);
  assert.doesNotMatch(body, /chrome\.storage/);
});

// =====================================================================
// PART 8 - M3: buildMemoryContext() purity - whitelisted-fields-only,
// adversarial-seed-proof, deterministic. The read-side counterpart to
// PART 1-4's recordVerb()/normalizeMemory() write-side proofs.
// =====================================================================

check('buildMemoryContext: arity is 2 - (mem, origin) is the whole required contract, scriptNames is an optional caller-side enrichment (defaulted)', () => {
  assert.strictEqual(registry.buildMemoryContext.length, 2);
});

check('buildMemoryContext: well-formed memory yields verbs(count) sorted by count descending', () => {
  let mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'go');
  mem = registry.recordVerb(mem, 'https://example.com', 'search');
  mem = registry.recordVerb(mem, 'https://example.com', 'search');
  const ctx = registry.buildMemoryContext(mem, 'https://example.com');
  assert.match(ctx, /commands the user has run on this site: search\(2\), go\(1\)/);
});

check('buildMemoryContext: includes the detected repeat pattern line when detectRepeat fires on the recent ring', () => {
  let mem = registry.createEmptyMemory();
  for (let i = 0; i < 3; i++) {
    mem = registry.recordVerb(mem, 'https://example.com', 'go');
    mem = registry.recordVerb(mem, 'https://example.com', 'search');
    mem = registry.recordVerb(mem, 'https://example.com', 'read');
  }
  const ctx = registry.buildMemoryContext(mem, 'https://example.com');
  assert.match(ctx, /repeated pattern on this site: "go, search, read" \(3 times\)/);
});

check('buildMemoryContext: omits the repeat-pattern line when no repeat is detected', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'go');
  const ctx = registry.buildMemoryContext(mem, 'https://example.com');
  assert.doesNotMatch(ctx, /repeated pattern/);
});

check('buildMemoryContext: includes script names (3rd arg) only when given, filtered to NAME_RE-shaped names, capped', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'go');
  const withNames = registry.buildMemoryContext(mem, 'https://example.com', ['my-flow', 'another_one']);
  assert.match(withNames, /scripts the user already has: my-flow, another_one/);
  const withoutNames = registry.buildMemoryContext(mem, 'https://example.com');
  assert.doesNotMatch(withoutNames, /scripts the user already has/);
});

check('buildMemoryContext: an origin with nothing recorded yields an empty string (no throw, no stray labels)', () => {
  const mem = registry.createEmptyMemory();
  assert.strictEqual(registry.buildMemoryContext(mem, 'https://never-visited.example'), '');
});

check('buildMemoryContext: an unparseable origin (e.g. "javascript:alert(1)") is treated as "nothing recorded" - no throw', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'go');
  assert.strictEqual(registry.buildMemoryContext(mem, 'javascript:alert(1)'), '');
});

check('buildMemoryContext: deterministic - identical input, called twice, produces byte-identical output', () => {
  let mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'go');
  mem = registry.recordVerb(mem, 'https://example.com', 'search');
  const names = ['b-script', 'a-script'];
  const a = registry.buildMemoryContext(mem, 'https://example.com', names);
  const b = registry.buildMemoryContext(mem, 'https://example.com', names);
  assert.strictEqual(a, b);
});

check('buildMemoryContext: verbs are capped at MEMORY_CONTEXT_MAX_VERBS, keeping the highest-count ones', () => {
  let mem = registry.createEmptyMemory();
  const cap = registry.MEMORY_CONTEXT_MAX_VERBS;
  for (let i = 0; i < cap + 5; i++) {
    for (let n = 0; n <= i; n++) mem = registry.recordVerb(mem, 'https://example.com', `v${i}`);
  }
  const ctx = registry.buildMemoryContext(mem, 'https://example.com');
  const line = ctx.split('\n')[0];
  const shown = line.replace('commands the user has run on this site: ', '').split(', ');
  assert.strictEqual(shown.length, cap, `expected exactly ${cap} verbs in the context line, got ${shown.length}`);
  assert.ok(line.includes(`v${cap + 4}(`), 'the highest-count verb must survive the cap');
  assert.ok(!line.includes('v0('), 'the lowest-count verb must be dropped by the cap');
});

check('buildMemoryContext: script names are capped at MEMORY_CONTEXT_MAX_SCRIPT_NAMES', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'go');
  const cap = registry.MEMORY_CONTEXT_MAX_SCRIPT_NAMES;
  const names = [];
  for (let i = 0; i < cap + 5; i++) names.push(`script${i}`);
  const ctx = registry.buildMemoryContext(mem, 'https://example.com', names);
  const line = ctx.split('\n').find((l) => l.startsWith('scripts the user already has: '));
  const shown = line.replace('scripts the user already has: ', '').split(', ');
  assert.strictEqual(shown.length, cap);
});

check('buildMemoryContext ADVERSARIAL: extra properties hand-inserted onto a verb entry (argument-shaped) never leak - only verbKey and n are ever read', () => {
  const poisoned = {
    v: 1,
    origins: {
      'https://example.com': {
        search: { n: 3, lastUsed: 1, arg: 'SHOULD-NOT-APPEAR divorce lawyer', query: 'SHOULD-NOT-APPEAR-EITHER' },
      },
    },
    prefs: {},
    recent: {},
  };
  const ctx = registry.buildMemoryContext(poisoned, 'https://example.com');
  assert.ok(!ctx.includes('SHOULD-NOT-APPEAR'), `poisoned verb-entry property leaked:\n${ctx}`);
  assert.strictEqual(ctx, 'commands the user has run on this site: search(3)');
});

check('buildMemoryContext ADVERSARIAL: extra TOP-LEVEL keys on the memory object itself never leak (this function is not a generic serializer)', () => {
  const poisoned = {
    v: 1,
    origins: { 'https://example.com': { go: { n: 1, lastUsed: 1 } } },
    prefs: {},
    recent: {},
    SHOULD_NOT_APPEAR_TOPLEVEL: 'evil payload',
    argumentsLeakedHere: ['SHOULD-NOT-APPEAR-ARRAY'],
  };
  const ctx = registry.buildMemoryContext(poisoned, 'https://example.com');
  assert.ok(!ctx.includes('SHOULD-NOT-APPEAR'), `poisoned top-level key leaked:\n${ctx}`);
});

check('buildMemoryContext ADVERSARIAL: extra/unrecognized pref keys never leak (prefs are not part of this function\'s output at all)', () => {
  const poisoned = {
    v: 1,
    origins: { 'https://example.com': { go: { n: 1, lastUsed: 1 } } },
    prefs: { evilPref: 'SHOULD-NOT-APPEAR-PREF' },
    recent: {},
  };
  const ctx = registry.buildMemoryContext(poisoned, 'https://example.com');
  assert.ok(!ctx.includes('SHOULD-NOT-APPEAR'), `poisoned pref leaked:\n${ctx}`);
});

check('buildMemoryContext ADVERSARIAL: an argument-shaped verb KEY (spaces/quotes) never survives normalizeMemory to reach output - the same wall recordVerb() itself holds', () => {
  const poisoned = {
    v: 1,
    origins: { 'https://example.com': { 'search "divorce lawyer"': { n: 1, lastUsed: 1 } } },
    prefs: {},
    recent: {},
  };
  const ctx = registry.buildMemoryContext(poisoned, 'https://example.com');
  assert.strictEqual(ctx, '', 'an argument-shaped verb key must never survive into the context string');
});

check('buildMemoryContext ADVERSARIAL: argument-shaped/oversized/quoted script names (3rd arg) are dropped individually, never partially echoed', () => {
  const mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'go');
  const poisonedNames = ['ok-name', 'has spaces SHOULD-NOT-APPEAR', '"quoted-SHOULD-NOT-APPEAR"', 'a'.repeat(60)];
  const ctx = registry.buildMemoryContext(mem, 'https://example.com', poisonedNames);
  assert.ok(!ctx.includes('SHOULD-NOT-APPEAR'), `poisoned script name leaked:\n${ctx}`);
  assert.match(ctx, /scripts the user already has: ok-name$/m);
});

check('buildMemoryContext ADVERSARIAL: a poisoned recent-ring entry (non-verb-shaped, hand-inserted bypassing recordVerb) never reaches the repeat-pattern line', () => {
  const poisoned = {
    v: 1,
    origins: {},
    prefs: {},
    recent: { 'https://example.com': ['search "SHOULD-NOT-APPEAR"', 'search "SHOULD-NOT-APPEAR"', 'search "SHOULD-NOT-APPEAR"'] },
  };
  const ctx = registry.buildMemoryContext(poisoned, 'https://example.com');
  assert.ok(!ctx.includes('SHOULD-NOT-APPEAR'), `poisoned recent-ring entry leaked:\n${ctx}`);
});

check('buildMemoryContext: never emits a quote character or the literal substring "http" - no argument, no URL, ever (same convention as formatMemoryDump\'s own adversarial test)', () => {
  let mem = registry.recordVerb(registry.createEmptyMemory(), 'https://example.com', 'search');
  mem = registry.recordVerb(mem, 'https://example.com', 'go');
  const ctx = registry.buildMemoryContext(mem, 'https://example.com', ['my-flow']);
  assert.ok(!ctx.includes('"'), 'no quote characters should ever appear');
  assert.ok(!ctx.toLowerCase().includes('http'), 'no URL/origin text should ever appear - the origin itself is never echoed');
});

check('buildMemoryContext source: never calls JSON.stringify/Object.values/Object.entries on `mem` or an entry - built by naming specific fields, not generic serialization', () => {
  const registrySrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'registry.js'), 'utf8');
  const idx = registrySrc.indexOf('function buildMemoryContext(mem, origin, scriptNames = []) {');
  const end = registrySrc.indexOf('\n  return {', idx); // the module's final export return, right after this function
  assert.ok(idx > -1 && end > idx, 'buildMemoryContext source not found');
  const body = registrySrc.slice(idx, end);
  assert.doesNotMatch(body, /JSON\.stringify/);
  assert.doesNotMatch(body, /Object\.values/);
  assert.doesNotMatch(body, /Object\.entries/);
});

// =====================================================================
// PART 9 - CRITICAL: execution-lane / brainstorm-lane payload isolation.
// Direct clone of tests/brainstorm_lane_isolation.test.js's buildSwInstance()
// method, PLUS a chrome.storage.local mock (service-worker.js never uses
// storage.local today - only storage.session for the rate limiter/TS_*
// state - so this also doubles as a structural regression guard: if a
// future change ever wired memory into either payload builder, it could
// only do so by reading storage.local, and this test would catch it).
// =====================================================================

function buildSwInstance(storageLocalSeed) {
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const messageListeners = [];
  const capturedRequests = [];
  const storageSessionMap = new Map();
  const storageLocalMap = new Map(Object.entries(storageLocalSeed || {}));
  let storageLocalCallCount = 0;

  sandbox.chrome = {
    runtime: { onMessage: { addListener(fn) { messageListeners.push(fn); } } },
    storage: {
      session: {
        get(key) {
          return Promise.resolve().then(() => {
            const out = {};
            const keys = Array.isArray(key) ? key : [key];
            keys.forEach((k) => { if (storageSessionMap.has(k)) out[k] = storageSessionMap.get(k); });
            return out;
          });
        },
        set(obj) {
          return Promise.resolve().then(() => { Object.keys(obj).forEach((k) => storageSessionMap.set(k, obj[k])); });
        },
        remove() { return Promise.resolve(); },
      },
      // NOT part of the real service-worker.js's own posture today (it only
      // ever uses storage.session - see this file's header comment) - mocked
      // here anyway, seeded with poisoned content, so this test would catch
      // it immediately if that ever changed without an explicit isolation
      // update.
      local: {
        get(key, cb) {
          storageLocalCallCount += 1;
          const out = {};
          const keys = Array.isArray(key) ? key : [key];
          keys.forEach((k) => { if (storageLocalMap.has(k)) out[k] = storageLocalMap.get(k); });
          if (typeof cb === 'function') { cb(out); return; }
          return Promise.resolve(out);
        },
        set(obj, cb) {
          storageLocalCallCount += 1;
          Object.keys(obj).forEach((k) => storageLocalMap.set(k, obj[k]));
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        },
      },
    },
    tabs: { onRemoved: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
  };

  sandbox.importScripts = function importScripts(...urls) {
    urls.forEach((u) => {
      const resolved = path.join(ROOT, 'extension', 'background', u);
      assert.strictEqual(resolved, RATELIMIT_PATH, `importScripts() must resolve to the real ratelimit.js, got ${resolved}`);
      const src = fs.readFileSync(resolved, 'utf8');
      vm.runInContext(src, sandbox, { filename: u });
    });
  };

  sandbox.fetch = function fetch(url, init) {
    capturedRequests.push({ url, init });
    const bodyObj = JSON.parse(init.body);
    const schemaName = bodyObj.response_format && bodyObj.response_format.json_schema && bodyObj.response_format.json_schema.name;
    let content;
    if (schemaName === 'lfl_nav_action') {
      content = JSON.stringify({ action: 'navigate', value: 'https://example.com', reason: 'test' });
    } else if (schemaName === 'lfl_script_draft') {
      content = JSON.stringify({ script: 'go example.com\nsearch "test"', reason: 'test' });
    } else {
      content = JSON.stringify({ action: 'answer', element: 0, value: 'test', reason: 'test' });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ choices: [{ message: { content } }] }),
      text: () => Promise.resolve(''),
    });
  };
  sandbox.AbortController = function AbortController() {
    this.signal = {};
    this.abort = function () {};
  };
  sandbox.setTimeout = (fn, delay) => 0;
  sandbox.clearTimeout = () => {};

  vm.createContext(sandbox);

  const swSrc = fs.readFileSync(SW_PATH, 'utf8');
  vm.runInContext(swSrc, sandbox, { filename: 'service-worker.js' });

  assert.strictEqual(messageListeners.length, 1, 'service-worker.js should register exactly one onMessage listener');
  const listener = messageListeners[0];

  function send(msg, tabId) {
    return new Promise((resolve, reject) => {
      const sender = tabId === null ? {} : { tab: { id: tabId } };
      let responded = false;
      const keepOpen = listener(msg, sender, (resp) => { responded = true; resolve(resp); });
      if (!responded && !keepOpen) {
        reject(new Error(`listener neither responded synchronously nor kept the channel open for ${JSON.stringify(msg)}`));
      }
    });
  }

  return { send, capturedRequests, get storageLocalCallCount() { return storageLocalCallCount; } };
}

// Poisoned chrome.storage.local seed: memory ON, with recorded verbs/origins
// whose names are deliberately shaped like forbidden leak markers - if
// EITHER payload builder ever read storage.local, these would show up
// verbatim in the captured request body.
const POISONED_MEMORY_SEED = {
  lflMemoryEnabled: true,
  lflMemory: {
    v: 1,
    origins: {
      'https://should-not-appear-memory-origin.example': {
        shouldnotappearverb: { n: 999, lastUsed: 1 },
      },
    },
    prefs: { nudgeQuiet: false },
    recent: { 'https://should-not-appear-memory-origin.example': ['shouldnotappearverb', 'shouldnotappearverb', 'shouldnotappearverb'] },
  },
};

const PAGE_LANE_MSG = { type: 'LFL_LLM_REQUEST', command: 'find the astronomy article', elementList: '[1] link "x"', origin: 'https://example.com', title: 'Example' };
const TEACH_LANE_MSG = { type: 'BRAINSTORM_LLM_REQUEST', goal: 'check the weather' };

async function main() {
  await acheck('ISOLATION: execution-lane (LFL_LLM_REQUEST) payload is BYTE-IDENTICAL with memory ON+populated vs completely absent from storage', async () => {
    const swWithMemory = buildSwInstance(POISONED_MEMORY_SEED);
    const respWith = await swWithMemory.send(PAGE_LANE_MSG, 1);
    assert.strictEqual(respWith.ok, true, JSON.stringify(respWith));
    const bodyWith = swWithMemory.capturedRequests[0].init.body;

    const swWithoutMemory = buildSwInstance({});
    const respWithout = await swWithoutMemory.send(PAGE_LANE_MSG, 1);
    assert.strictEqual(respWithout.ok, true, JSON.stringify(respWithout));
    const bodyWithout = swWithoutMemory.capturedRequests[0].init.body;

    assert.strictEqual(bodyWith, bodyWithout, 'execution-lane request body must be byte-identical regardless of memory state');
  });

  await acheck('ISOLATION: brainstorm/teach-lane (BRAINSTORM_LLM_REQUEST) payload is BYTE-IDENTICAL with memory ON+populated vs completely absent from storage', async () => {
    const swWithMemory = buildSwInstance(POISONED_MEMORY_SEED);
    const respWith = await swWithMemory.send(TEACH_LANE_MSG, 1);
    assert.strictEqual(respWith.ok, true, JSON.stringify(respWith));
    const bodyWith = swWithMemory.capturedRequests[0].init.body;

    const swWithoutMemory = buildSwInstance({});
    const respWithout = await swWithoutMemory.send(TEACH_LANE_MSG, 1);
    assert.strictEqual(respWithout.ok, true, JSON.stringify(respWithout));
    const bodyWithout = swWithoutMemory.capturedRequests[0].init.body;

    assert.strictEqual(bodyWith, bodyWithout, 'brainstorm-lane request body must be byte-identical regardless of memory state');
  });

  await acheck('ISOLATION: neither payload body contains any of the poisoned memory-content markers', async () => {
    const sw = buildSwInstance(POISONED_MEMORY_SEED);
    await sw.send(PAGE_LANE_MSG, 1);
    await sw.send(TEACH_LANE_MSG, 2);
    const bodies = sw.capturedRequests.map((r) => r.init.body).join('\n');
    assert.ok(!bodies.includes('should-not-appear-memory-origin'), 'poisoned memory origin leaked into a request body');
    assert.ok(!bodies.toLowerCase().includes('shouldnotappearverb'), 'poisoned memory verb leaked into a request body');
  });

  await acheck('ISOLATION (structural): service-worker.js never calls chrome.storage.local at all, whether or not it is seeded with memory data', async () => {
    const sw = buildSwInstance(POISONED_MEMORY_SEED);
    await sw.send(PAGE_LANE_MSG, 1);
    await sw.send(TEACH_LANE_MSG, 2);
    await sw.send({ type: 'NAV_LLM_REQUEST', command: 'go to the arch linux wiki' }, 3);
    assert.strictEqual(sw.storageLocalCallCount, 0, 'service-worker.js must never touch chrome.storage.local - memory lives entirely in the content script, never the background context that builds LLM payloads');
  });

  check('ISOLATION (static): background/service-worker.js source contains no reference to memory/lflMemory anywhere', () => {
    const swSrc = fs.readFileSync(SW_PATH, 'utf8');
    assert.doesNotMatch(swSrc, /lflMemory/i);
    assert.doesNotMatch(swSrc, /storage\.local/i);
  });

  // =====================================================================
  // PART 10 - M3: the brainstorm-lane `memoryContext` wiring itself, against
  // the REAL service-worker.js via the same buildSwInstance() harness above.
  // This is the direct regression proof for "teach with memory off is
  // byte-identical to before M3 shipped" AND the proof that a memoryContext
  // field, when present, is delimited/labeled the way the design doc
  // requires and never reaches the execution lane.
  // =====================================================================

  await acheck('M3: BRAINSTORM_LLM_REQUEST WITHOUT memoryContext produces the exact pre-M3 2-message shape [system, user] - no new message, no new field', async () => {
    const sw = buildSwInstance({});
    await sw.send({ type: 'BRAINSTORM_LLM_REQUEST', goal: 'check the weather' }, 1);
    const body = JSON.parse(sw.capturedRequests[0].init.body);
    assert.strictEqual(body.messages.length, 2, 'messages must stay exactly [system, user] when memoryContext is absent');
    assert.strictEqual(body.messages[0].role, 'system');
    assert.strictEqual(body.messages[1].role, 'user');
    assert.deepStrictEqual(realm(JSON.parse(body.messages[1].content)), { goal: 'check the weather' });
  });

  await acheck('M3: BRAINSTORM_LLM_REQUEST WITH memoryContext inserts exactly ONE extra system-role message, clearly labeled TRUSTED CONTEXT / not page content, BETWEEN the fixed system prompt and the user goal turn', async () => {
    const sw = buildSwInstance({});
    const ctx = 'commands the user has run on this site: search(3), go(1)\nscripts the user already has: my-flow';
    await sw.send({ type: 'BRAINSTORM_LLM_REQUEST', goal: 'check the weather', memoryContext: ctx }, 1);
    const body = JSON.parse(sw.capturedRequests[0].init.body);
    assert.strictEqual(body.messages.length, 3);
    assert.strictEqual(body.messages[0].role, 'system');
    assert.strictEqual(body.messages[1].role, 'system');
    assert.strictEqual(body.messages[2].role, 'user');
    assert.match(body.messages[1].content, /TRUSTED CONTEXT/);
    assert.match(body.messages[1].content, /not page content/i);
    assert.match(body.messages[1].content, /user'?s own/i, 'the label must attribute this to the user\'s own workflow history, not page content');
    assert.ok(body.messages[1].content.includes(ctx), 'the memoryContext text itself must appear verbatim inside the labeled message');
    assert.deepStrictEqual(realm(JSON.parse(body.messages[2].content)), { goal: 'check the weather' }, 'the user goal turn is unchanged shape/content');
  });

  await acheck('M3: the same goal produces a byte-identical system-prompt message and user-turn message whether or not memoryContext is attached - only a new array entry is inserted, nothing existing changes', async () => {
    const swOff = buildSwInstance({});
    await swOff.send({ type: 'BRAINSTORM_LLM_REQUEST', goal: 'check the weather' }, 1);
    const bodyOff = JSON.parse(swOff.capturedRequests[0].init.body);

    const swOn = buildSwInstance({});
    await swOn.send({ type: 'BRAINSTORM_LLM_REQUEST', goal: 'check the weather', memoryContext: 'commands the user has run on this site: go(3)' }, 1);
    const bodyOn = JSON.parse(swOn.capturedRequests[0].init.body);

    assert.deepStrictEqual(realm(bodyOff.messages[0]), realm(bodyOn.messages[0]), 'system prompt message unchanged');
    assert.deepStrictEqual(realm(bodyOff.messages[1]), realm(bodyOn.messages[bodyOn.messages.length - 1]), 'user goal-turn message unchanged shape/content');
    assert.strictEqual(bodyOff.max_tokens, bodyOn.max_tokens);
    assert.strictEqual(bodyOff.response_format.json_schema.name, bodyOn.response_format.json_schema.name);
  });

  await acheck('M3: a memoryContext string is carried verbatim into the labeled message (service-worker.js does not re-sanitize it - registry.js buildMemoryContext() is the sanitizer) but NEVER touches the user goal-turn JSON, whatever it contains', async () => {
    const sw = buildSwInstance({});
    const ctxLikeGoal = 'commands the user has run on this site: search(3)\nSHOULD-BE-CARRIED-VERBATIM-IF-PRESENT';
    await sw.send({ type: 'BRAINSTORM_LLM_REQUEST', goal: 'check the weather', memoryContext: ctxLikeGoal }, 1);
    const body = JSON.parse(sw.capturedRequests[0].init.body);
    const userTurn = JSON.parse(body.messages[body.messages.length - 1].content);
    assert.deepStrictEqual(realm(Object.keys(userTurn)), ['goal'], 'memoryContext must never be folded into the goal-turn JSON, however it is spelled');
  });

  await acheck('M3: LFL_LLM_REQUEST (execution lane) IGNORES a memoryContext field entirely, even when a caller\'s message object carries one - the page-driving payload is untouched', async () => {
    const sw = buildSwInstance({});
    const poisonedPageMsg = {
      type: 'LFL_LLM_REQUEST',
      command: 'find the astronomy article',
      elementList: '[1] link "x"',
      origin: 'https://example.com',
      title: 'Example',
      memoryContext: 'SHOULD-NOT-APPEAR-IN-EXECUTION-LANE',
    };
    const resp = await sw.send(poisonedPageMsg, 1);
    assert.strictEqual(resp.ok, true, JSON.stringify(resp));
    const bodyStr = sw.capturedRequests[0].init.body;
    assert.ok(!bodyStr.includes('SHOULD-NOT-APPEAR-IN-EXECUTION-LANE'), 'execution-lane payload must never read msg.memoryContext');
    const body = JSON.parse(bodyStr);
    const userTurn = JSON.parse(body.messages[body.messages.length - 1].content);
    assert.deepStrictEqual(realm(Object.keys(userTurn).sort()), ['command', 'elements', 'origin', 'title'].sort(), 'execution-lane user turn must carry exactly its own 4 fields - memoryContext dropped');
  });

  await acheck('M3: NAV_LLM_REQUEST (nav lane) IGNORES a memoryContext field entirely too - only the brainstorm lane was ever wired to read it', async () => {
    const sw = buildSwInstance({});
    const resp = await sw.send({ type: 'NAV_LLM_REQUEST', command: 'go to the arch linux wiki', memoryContext: 'SHOULD-NOT-APPEAR-IN-NAV-LANE' }, 1);
    assert.strictEqual(resp.ok, true, JSON.stringify(resp));
    const bodyStr = sw.capturedRequests[0].init.body;
    assert.ok(!bodyStr.includes('SHOULD-NOT-APPEAR-IN-NAV-LANE'), 'nav-lane payload must never read msg.memoryContext');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
