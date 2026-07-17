#!/usr/bin/env node
/**
 * tests/member_experience.test.js - unit proof of the member-experience
 * pass (LFL-TERMINAL-MEMBER-EXPERIENCE-DESIGN.md, all §7 sign-offs A-F
 * SIGNED): E1 humane error mapping, E2 first-open welcome, E3 in-extension
 * `tour`, E5 `status`. (E4's install-time welcome.html is a static page -
 * no logic to unit test; see this build's own report for its manual
 * verification.)
 *
 * Five parts:
 *
 * 1. classifyModelError(kind, status, bodyText) - table-driven, loaded via
 *    `vm` from the real, unmodified service-worker.js source (same
 *    technique tests/sw_ratelimit_persistence.test.js already uses to load
 *    that file) - no live fetch/server involved anywhere in this part.
 *
 * 2. registry.js's pure welcome/tour content + sequencing helpers -
 *    required directly (dual-mode module, same as every other registry.js
 *    test), no DOM/vm needed.
 *
 * 3. RESERVED_NAMES / engine registry coverage for welcome/tour/status -
 *    the same behavioral proof (via createAliasStore's real setAlias/
 *    setMacro, not a source-text regex) tests/memory_lane.test.js already
 *    uses for `memory`/`remember`/`forget`.
 *
 * 4. E5 `status` SW plumbing with a FAKE fetch - loaded via `vm` (same
 *    buildSwInstance() pattern tests/m3_hardening.test.js Part 3 uses),
 *    covering bridge-reachable+alias, bridge-reachable+models-403 (the
 *    EXPECTED cohort-gateway case), and bridge-unreachable. No live server
 *    anywhere in this part either.
 *
 * 5. Full terminal.js integration - a real, unmodified Terminal instance
 *    constructed in a `vm` sandbox with a fake DOM/chrome/service-worker
 *    (same buildTerminalSandbox() pattern tests/m4b_games.test.js Part 3
 *    introduced): welcome-once flag logic (shown on first open only, never
 *    again, `welcome` command re-prints on demand), tour step sequencing
 *    end to end (advance/jump/wrap), and the `status` command's rendered
 *    output for both a reachable and an unreachable bridge.
 *
 * Run: node tests/member_experience.test.js
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SW_PATH = path.join(ROOT, 'extension', 'background', 'service-worker.js');
const RATELIMIT_PATH = path.join(ROOT, 'extension', 'content', 'ratelimit.js');
const GUARDS_PATH = path.join(ROOT, 'extension', 'content', 'guards.js');
const REGISTRY_PATH = path.join(ROOT, 'extension', 'content', 'registry.js');
const NAV_PATH = path.join(ROOT, 'extension', 'content', 'nav.js');
const EXECUTOR_PATH = path.join(ROOT, 'extension', 'content', 'executor.js');
const ENGINE_PATH = path.join(ROOT, 'extension', 'content', 'engine.js');
const FUNPACK_PATH = path.join(ROOT, 'extension', 'content', 'funpack.js');
const GAMES_PATH = path.join(ROOT, 'extension', 'content', 'games.js');
const TERMINAL_PATH = path.join(ROOT, 'extension', 'content', 'terminal.js');

const registry = require(REGISTRY_PATH);

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
    console.error(`         ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n         ') : e}`);
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
    console.error(`         ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n         ') : e}`);
  }
}

// =====================================================================
// Part 1 - classifyModelError, loaded via vm from the real SW source.
// =====================================================================

function loadSwSandboxForClassify() {
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: { session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() } },
    tabs: { onRemoved: { addListener() {} } },
    action: undefined,
  };
  sandbox.importScripts = function importScripts(...urls) {
    urls.forEach((u) => {
      const resolved = path.join(ROOT, 'extension', 'background', u);
      assert.strictEqual(resolved, RATELIMIT_PATH, `importScripts() must resolve to the real ratelimit.js, got ${resolved}`);
      vm.runInContext(fs.readFileSync(resolved, 'utf8'), sandbox, { filename: u });
    });
  };
  sandbox.AbortController = function AbortController() { this.signal = {}; this.abort = function () {}; };
  sandbox.setTimeout = (fn) => { return 0; };
  sandbox.clearTimeout = () => {};
  sandbox.fetch = () => Promise.reject(new Error('classifyModelError tests never call fetch'));
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), sandbox, { filename: 'service-worker.js' });
  return sandbox;
}

function testClassifyModelError() {
  console.log('\n[1] classifyModelError(kind, status, bodyText) - table-driven, real SW source via vm');
  const sandbox = loadSwSandboxForClassify();

  check('classifyModelError is a function reachable off the loaded SW source', () => {
    assert.strictEqual(typeof sandbox.classifyModelError, 'function');
  });

  const cases = [
    {
      name: 'network (fetch rejected) - bridge-unreachable wording, detail = the raw error message',
      args: ['network', undefined, 'fetch failed: ECONNREFUSED'],
      expectUser: /can't reach your local bridge at 127\.0\.0\.1:1238/,
      expectUserHas: ['is it running?', 'deterministic commands still work'],
      expectDetail: 'fetch failed: ECONNREFUSED',
    },
    {
      name: 'network (AbortError timeout) - same bridge-unreachable wording, detail carries the timeout description',
      args: ['network', undefined, 'timeout after 30s'],
      expectUser: /can't reach your local bridge at 127\.0\.0\.1:1238/,
      expectDetail: 'timeout after 30s',
    },
    {
      name: '429 - daily cap wording, status+body preserved in detail',
      args: ['http', 429, '{"error":{"type":"rate_limit","message":"daily request cap reached (400/400 today); resets at UTC midnight"}}'],
      expectUser: /daily request cap reached on the shared beta model - resets at midnight UTC/,
      expectUserHas: ['deterministic commands still work'],
      expectDetail: 'server 429: {"error":{"type":"rate_limit"',
    },
    {
      name: '500 - server-error wording, never the raw body',
      args: ['http', 500, 'Internal Server Error garbage nobody should see'],
      expectUser: /the model endpoint had a server error - try again in a moment/,
      expectUserNotHas: ['Internal Server Error garbage'],
      expectDetail: 'server 500: Internal Server Error garbage nobody should see',
    },
    {
      name: '503 - also classified as a 5xx server error (>= 500, not just exactly 500)',
      args: ['http', 503, 'Service Unavailable'],
      expectUser: /the model endpoint had a server error/,
    },
    {
      name: '404 - "other non-2xx": current pre-E1 meaning, minus the raw body',
      args: ['http', 404, 'not found body that must not leak into the user line'],
      expectUser: /local model offline - deterministic commands still work \(server 404\)/,
      expectUserNotHas: ['not found body that must not leak'],
      expectDetail: 'server 404: not found body that must not leak into the user line',
    },
    {
      name: '403 (F5 endpoint-not-allowlisted) - same "other non-2xx" bucket as 404',
      args: ['http', 403, 'endpoint not allowed through this gateway'],
      expectUser: /local model offline - deterministic commands still work \(server 403\)/,
    },
    {
      name: 'empty-response - current meaning kept, detail always present even though there is no body to show',
      args: ['empty', 200, ''],
      expectUser: /^local model returned an empty response$/,
      expectDetail: 'server 200: (empty response)',
    },
  ];

  for (const c of cases) {
    check(c.name, () => {
      const result = sandbox.classifyModelError(...c.args);
      assert.ok(result && typeof result === 'object', 'must return an object');
      assert.ok(typeof result.user === 'string' && result.user.length > 0, 'user must be a non-empty string');
      assert.ok(typeof result.detail === 'string' && result.detail.length > 0, 'detail must ALWAYS be present (design §3 P2)');
      if (c.expectUser) assert.match(result.user, c.expectUser);
      if (c.expectUserHas) c.expectUserHas.forEach((s) => assert.ok(result.user.includes(s), `user should include "${s}", got: ${result.user}`));
      if (c.expectUserNotHas) c.expectUserNotHas.forEach((s) => assert.ok(!result.user.includes(s), `user must NOT include "${s}" (raw body leak), got: ${result.user}`));
      if (c.expectDetail) assert.ok(result.detail.startsWith(c.expectDetail) || result.detail === c.expectDetail, `detail mismatch: got "${result.detail}"`);
    });
  }

  check('detail is truncated to 200 chars of the body for an http-kind error, same cap as the pre-E1 code', () => {
    const longBody = 'x'.repeat(500);
    const result = sandbox.classifyModelError('http', 418, longBody);
    assert.ok(result.detail.length <= 'server 418: '.length + 200);
  });

  check('zero em dashes (U+2014) in any classifyModelError output across the whole table', () => {
    for (const c of cases) {
      const result = sandbox.classifyModelError(...c.args);
      assert.ok(!result.user.includes('\u2014'), `user contains an em dash: ${result.user}`);
      assert.ok(!result.detail.includes('\u2014'), `detail contains an em dash: ${result.detail}`);
    }
  });
}

// =====================================================================
// Part 2 - registry.js pure welcome/tour helpers.
// =====================================================================

function testWelcomeContent() {
  console.log('\n[2a] registry.js welcomeText()/welcomeRich() - E2 pure content');

  check('welcomeText() is 5-6 lines (design §4: "compact 5-6 line welcome block")', () => {
    const lines = registry.welcomeText().split('\n');
    assert.ok(lines.length >= 5 && lines.length <= 6, `expected 5-6 lines, got ${lines.length}`);
  });

  check('welcomeText() mentions all three ways to open, help, tour, and the privacy one-liner', () => {
    const text = registry.welcomeText();
    assert.match(text, /backtick/);
    assert.match(text, /Ctrl\+K/);
    assert.match(text, /toolbar/);
    assert.match(text, /`help`/);
    assert.match(text, /`tour`/);
    assert.match(text, /locally/i);
    assert.match(text, /approve/i);
  });

  check('welcomeRich() returns one {spans} line object per welcomeText() line, non-empty spans', () => {
    const rich = registry.welcomeRich();
    const plainLines = registry.welcomeText().split('\n');
    assert.strictEqual(rich.length, plainLines.length);
    rich.forEach((line) => {
      assert.ok(Array.isArray(line.spans) && line.spans.length > 0);
      line.spans.forEach((sp) => assert.ok(typeof sp.text === 'string'));
    });
  });

  check('welcomeRich() classes backtick-wrapped command names lfl-syn-cmd, the rest lfl-syn-info/null', () => {
    const rich = registry.welcomeRich();
    const helpLine = rich.find((l) => l.spans.some((sp) => sp.text === 'help'));
    assert.ok(helpLine, 'expected a span with exact text "help"');
    const helpSpan = helpLine.spans.find((sp) => sp.text === 'help');
    assert.strictEqual(helpSpan.cls, 'lfl-syn-cmd');
  });

  check('zero em dashes anywhere in the welcome block', () => {
    assert.ok(!registry.welcomeText().includes('\u2014'));
  });
}

function testTourSequencing() {
  console.log('\n[2b] registry.js tourStepCount/tourNextStep/tourJumpStep/tourStepRich/tourStepText - E3 pure sequencing');

  check('tourStepCount() is about 6 (design §5: "~6")', () => {
    const n = registry.tourStepCount();
    assert.ok(n >= 5 && n <= 7, `expected roughly 6 steps, got ${n}`);
  });

  check('tourNextStep: from "never started" (0), advances to step 1', () => {
    assert.strictEqual(registry.tourNextStep(0), 1);
  });

  check('tourNextStep: advances by exactly one from any mid-tour step', () => {
    const n = registry.tourStepCount();
    for (let i = 1; i < n; i++) {
      assert.strictEqual(registry.tourNextStep(i), i + 1);
    }
  });

  check('tourNextStep: wraps back to step 1 after the last step', () => {
    const n = registry.tourStepCount();
    assert.strictEqual(registry.tourNextStep(n), 1);
  });

  check('tourJumpStep: valid n in range returns {ok:true, step:n}', () => {
    const n = registry.tourStepCount();
    for (let i = 1; i <= n; i++) {
      assert.deepStrictEqual(registry.tourJumpStep(String(i)), { ok: true, step: i });
    }
  });

  check('tourJumpStep: 0, out-of-range, and non-integer input are all refused with a usage reason', () => {
    const n = registry.tourStepCount();
    ['0', String(n + 1), '-1', '3.5', '3abc', 'abc', '', ' '].forEach((bad) => {
      const r = registry.tourJumpStep(bad);
      assert.strictEqual(r.ok, false, `expected tourJumpStep(${JSON.stringify(bad)}) to be refused`);
      assert.match(r.reason, /usage: tour <n>/);
    });
  });

  check('tourStepRich(n) returns a header line + at least one body line for every valid step, null out of range', () => {
    const n = registry.tourStepCount();
    for (let i = 1; i <= n; i++) {
      const rich = registry.tourStepRich(i);
      assert.ok(Array.isArray(rich) && rich.length >= 2, `step ${i} should have a header + body`);
      const headerText = rich[0].spans.map((sp) => sp.text).join('');
      assert.ok(headerText.includes(`${i}/${n}`), `header should mention "${i}/${n}", got: ${headerText}`);
    }
    assert.strictEqual(registry.tourStepRich(0), null);
    assert.strictEqual(registry.tourStepRich(n + 1), null);
  });

  check('tourStepText(n) is the plain-text mirror of tourStepRich(n) - same line count', () => {
    const n = registry.tourStepCount();
    for (let i = 1; i <= n; i++) {
      const rich = registry.tourStepRich(i);
      const text = registry.tourStepText(i);
      assert.strictEqual(text.split('\n').length, rich.length);
    }
  });

  check('no tour step ever mentions running a game or a fun-pack command AS a tour action (design §5: no page interaction, no model calls)', () => {
    const n = registry.tourStepCount();
    for (let i = 1; i <= n; i++) {
      const text = registry.tourStepText(i);
      // The themes/games step is allowed to NAME snake/2048/games/theme -
      // this check only guards against a step instructing the reader to
      // literally invoke the model (e.g. a stray "ask ..." example).
      assert.ok(!/\bask\s+\S/.test(text), `tour step ${i} must never demonstrate an explicit model-lane command: ${text}`);
    }
  });

  check('zero em dashes anywhere across all tour step text', () => {
    const n = registry.tourStepCount();
    for (let i = 1; i <= n; i++) {
      assert.ok(!registry.tourStepText(i).includes('\u2014'), `step ${i} contains an em dash`);
    }
  });
}

// =====================================================================
// Part 3 - RESERVED_NAMES / engine registry coverage, behavioral (not a
// source-text regex) - mirrors tests/memory_lane.test.js's own pattern for
// memory/remember/forget.
// =====================================================================

function testReservedNamesAndRegistration() {
  console.log('\n[3] RESERVED_NAMES coverage (behavioral, via real setAlias/setMacro) + engine.js registration for welcome/tour/status');

  ['welcome', 'tour'].forEach((name) => {
    check(`RESERVED_NAMES: "${name}" cannot be shadowed by an alias`, () => {
      const store = registry.createAliasStore(null, []);
      const r = store.setAlias(name, 'help');
      assert.strictEqual(r.ok, false);
      assert.match(r.reason, /built-in command/);
    });

    check(`RESERVED_NAMES: "${name}" cannot be shadowed by a macro`, () => {
      const store = registry.createAliasStore(null, []);
      const r = store.setMacro(name, 'help && help');
      assert.strictEqual(r.ok, false);
      assert.match(r.reason, /built-in command/);
    });
  });

  // `status` is intentionally NOT in registry.js's RESERVED_NAMES set - see
  // that set's own comment: it governs the alias/macro NAMESPACE, and
  // "status" was never one of the pre-existing meta-command names design
  // doc §7E's sign-off asked to reserve there (welcome/tour are the two
  // named explicitly in §4/§5 as "standalone control commands" the way
  // memory/teach/script are). `status` IS still fully protected the way
  // every other command is: engine.js registers it into commandRegistry
  // (checked below) and terminal.js's _submitCommand intercepts the exact
  // literal `status` before chain-splitting - the same posture `budget`/
  // `continue` (also not in RESERVED_NAMES) already hold themselves to.

  const engineSrc = fs.readFileSync(ENGINE_PATH, 'utf8');
  ['welcome', 'tour', 'status'].forEach((name) => {
    check(`engine.js registers "${name}" in the declarative command registry (help/man + vocabulary enumeration)`, () => {
      const re = new RegExp(`reg\\.register\\(\\{\\s*name:\\s*'${name}'`);
      assert.match(engineSrc, re);
    });
  });

  const termSrc = fs.readFileSync(TERMINAL_PATH, 'utf8');
  check('terminal.js intercepts "welcome"/"tour"/"status" in _submitCommand before chain-splitting (same dispatch cluster as memory/dev/origins)', () => {
    assert.match(termSrc, /if \(\/\^welcome\$\/i\.test\(raw\)\)/);
    assert.match(termSrc, /if \(\/\^tour\(\?:\\s\+\\S\+\)\?\$\/i\.test\(raw\)\)/);
    assert.match(termSrc, /if \(\/\^status\$\/i\.test\(raw\)\)/);
  });
}

// =====================================================================
// Part 4 - E5 status SW plumbing, FAKE fetch, loaded via vm.
// =====================================================================

function buildStatusSwInstance(fetchImpl) {
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const messageListeners = [];
  const storageMap = new Map();
  sandbox.chrome = {
    runtime: { onMessage: { addListener(fn) { messageListeners.push(fn); } } },
    storage: {
      session: {
        get(key) {
          return Promise.resolve().then(() => {
            const out = {};
            const keys = Array.isArray(key) ? key : [key];
            keys.forEach((k) => { if (storageMap.has(k)) out[k] = storageMap.get(k); });
            return out;
          });
        },
        set(obj) { return Promise.resolve().then(() => { Object.keys(obj).forEach((k) => storageMap.set(k, obj[k])); }); },
        remove() { return Promise.resolve(); },
      },
    },
    tabs: { onRemoved: { addListener() {} } },
  };
  sandbox.importScripts = function importScripts(...urls) {
    urls.forEach((u) => {
      const resolved = path.join(ROOT, 'extension', 'background', u);
      assert.strictEqual(resolved, RATELIMIT_PATH);
      vm.runInContext(fs.readFileSync(resolved, 'utf8'), sandbox, { filename: u });
    });
  };
  sandbox.fetch = fetchImpl;
  sandbox.AbortController = function AbortController() { this.signal = {}; this.abort = function () {}; };
  sandbox.setTimeout = () => 0;
  sandbox.clearTimeout = () => {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), sandbox, { filename: 'service-worker.js' });
  const listener = messageListeners[0];
  function send(msg, tabId) {
    return new Promise((resolve, reject) => {
      const sender = tabId === null || tabId === undefined ? {} : { tab: { id: tabId } };
      let responded = false;
      const keepOpen = listener(msg, sender, (resp) => { responded = true; resolve(resp); });
      if (!responded && !keepOpen) reject(new Error('listener did not respond'));
    });
  }
  return { send };
}

async function testStatusPlumbing() {
  console.log('\n[4] E5 status SW plumbing (STATUS_CHECK) - FAKE fetch, real SW source via vm, no live server');

  await acheck('bridge reachable + a model alias present: bridgeReachable true, modelAlias returned', async () => {
    const calls = [];
    const sw = buildStatusSwInstance((url) => {
      calls.push(url);
      if (url === 'http://127.0.0.1:1238/health') {
        return Promise.resolve({ ok: true, status: 200 });
      }
      if (url === 'http://127.0.0.1:1238/v1/models') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [{ id: 'lfl-cohort-4b' }] }) });
      }
      return Promise.reject(new Error('unexpected fetch: ' + url));
    });
    const resp = await sw.send({ type: 'STATUS_CHECK' });
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(resp.bridgeReachable, true);
    assert.strictEqual(resp.modelAlias, 'lfl-cohort-4b');
    assert.deepStrictEqual(calls, ['http://127.0.0.1:1238/health', 'http://127.0.0.1:1238/v1/models']);
  });

  await acheck('bridge reachable but /v1/models returns 403 (the EXPECTED cohort-gateway case, design §6): degrades to modelAlias null, never an error', async () => {
    const sw = buildStatusSwInstance((url) => {
      if (url === 'http://127.0.0.1:1238/health') return Promise.resolve({ ok: true, status: 200 });
      if (url === 'http://127.0.0.1:1238/v1/models') return Promise.resolve({ ok: false, status: 403 });
      return Promise.reject(new Error('unexpected fetch: ' + url));
    });
    const resp = await sw.send({ type: 'STATUS_CHECK' });
    assert.strictEqual(resp.ok, true, 'STATUS_CHECK itself must never fail even when /v1/models is refused');
    assert.strictEqual(resp.bridgeReachable, true);
    assert.strictEqual(resp.modelAlias, null);
  });

  await acheck('bridge reachable but /v1/models fetch itself throws: degrades to modelAlias null, never an error', async () => {
    const sw = buildStatusSwInstance((url) => {
      if (url === 'http://127.0.0.1:1238/health') return Promise.resolve({ ok: true, status: 200 });
      if (url === 'http://127.0.0.1:1238/v1/models') return Promise.reject(new Error('ECONNRESET'));
      return Promise.reject(new Error('unexpected fetch: ' + url));
    });
    const resp = await sw.send({ type: 'STATUS_CHECK' });
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(resp.bridgeReachable, true);
    assert.strictEqual(resp.modelAlias, null);
  });

  await acheck('bridge unreachable (/health fetch throws): bridgeReachable false, modelAlias null, /v1/models never even attempted', async () => {
    const calls = [];
    const sw = buildStatusSwInstance((url) => {
      calls.push(url);
      return Promise.reject(new Error('ECONNREFUSED'));
    });
    const resp = await sw.send({ type: 'STATUS_CHECK' });
    assert.strictEqual(resp.ok, true, 'STATUS_CHECK itself must never fail even when the bridge is down');
    assert.strictEqual(resp.bridgeReachable, false);
    assert.strictEqual(resp.modelAlias, null);
    assert.deepStrictEqual(calls, ['http://127.0.0.1:1238/health'], 'must not attempt /v1/models when /health already failed');
  });

  await acheck('bridge reachable but /health itself returns non-ok: bridgeReachable false', async () => {
    const sw = buildStatusSwInstance((url) => {
      if (url === 'http://127.0.0.1:1238/health') return Promise.resolve({ ok: false, status: 500 });
      return Promise.reject(new Error('unexpected fetch: ' + url));
    });
    const resp = await sw.send({ type: 'STATUS_CHECK' });
    assert.strictEqual(resp.bridgeReachable, false);
    assert.strictEqual(resp.modelAlias, null);
  });

  await acheck('a malformed /v1/models body (no data array) degrades to modelAlias null, never throws', async () => {
    const sw = buildStatusSwInstance((url) => {
      if (url === 'http://127.0.0.1:1238/health') return Promise.resolve({ ok: true, status: 200 });
      if (url === 'http://127.0.0.1:1238/v1/models') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ nonsense: true }) });
      return Promise.reject(new Error('unexpected fetch: ' + url));
    });
    const resp = await sw.send({ type: 'STATUS_CHECK' });
    assert.strictEqual(resp.bridgeReachable, true);
    assert.strictEqual(resp.modelAlias, null);
  });
}

// =====================================================================
// Part 5 - full terminal.js integration (real, unmodified Terminal in a vm
// sandbox) - welcome-once, tour end-to-end, status command rendering.
// =====================================================================

function makeFakeElement(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    __classes: new Set(),
    __attrs: new Map(),
    __children: [],
    __listeners: new Map(),
    style: {},
    _text: '',
    scrollTop: 0,
    scrollHeight: 0,
    value: '',
    readOnly: false,
  };
  Object.defineProperties(el, {
    textContent: {
      get() { return el._text; },
      set(v) { el._text = String(v); el.__children = []; },
    },
    innerHTML: {
      get() { return el._text; },
      set(_v) { el._text = ''; el.__children = []; },
    },
    children: { get() { return el.__children; } },
    firstChild: { get() { return el.__children[0] || null; } },
    className: {
      get() { return Array.from(el.__classes).join(' '); },
      set(v) { el.__classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    },
  });
  el.classList = {
    add(c) { el.__classes.add(c); },
    remove(c) { el.__classes.delete(c); },
    contains(c) { return el.__classes.has(c); },
    toggle(c, force) {
      const has = el.__classes.has(c);
      const want = force === undefined ? !has : !!force;
      if (want) el.__classes.add(c); else el.__classes.delete(c);
    },
  };
  el.setAttribute = function setAttribute(name, v) { el.__attrs.set(name, String(v)); };
  el.getAttribute = function getAttribute(name) { return el.__attrs.has(name) ? el.__attrs.get(name) : null; };
  el.hasAttribute = function hasAttribute(name) { return el.__attrs.has(name); };
  el.removeAttribute = function removeAttribute(name) { el.__attrs.delete(name); };
  el.appendChild = function appendChild(child) { el.__children.push(child); return child; };
  el.removeChild = function removeChild(child) {
    const i = el.__children.indexOf(child);
    if (i >= 0) el.__children.splice(i, 1);
    return child;
  };
  el.addEventListener = function addEventListener(type, fn) {
    if (!el.__listeners.has(type)) el.__listeners.set(type, []);
    el.__listeners.get(type).push(fn);
  };
  el.removeEventListener = function removeEventListener(type, fn) {
    const arr = el.__listeners.get(type);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };
  el.focus = function focus() { el.__focused = true; };
  el.blur = function blur() { el.__focused = false; };
  el.getBoundingClientRect = function getBoundingClientRect() {
    return { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 };
  };
  el.attachShadow = function attachShadow(opts) {
    const shadow = makeFakeElement('shadow-root');
    shadow.mode = opts && opts.mode;
    shadow.host = el;
    shadow.activeElement = null;
    shadow.elementsFromPoint = function elementsFromPoint() { return []; };
    el.__shadowRoot = shadow;
    return shadow;
  };
  return el;
}

// A tiny fake background service worker - just enough TS_*/RL_*/STATUS_CHECK
// handling for terminal.js's constructor and the command-dispatch paths
// under test to settle cleanly. `statusImpl` is a per-test-overridable
// function so status-command tests can control bridgeReachable/modelAlias
// without a real fetch anywhere.
function makeFakeSw(rateLimiterDefaults, opts) {
  const statusImpl = (opts && opts.statusImpl) || (() => ({ ok: true, bridgeReachable: false, modelAlias: null }));
  const state = {
    scrollback: [],
    open: false,
    queue: [],
    expectedOrigin: null,
    visited: new Set(),
    tourStep: 0,
  };
  function fullBudget() {
    return {
      llmRemaining: rateLimiterDefaults.llmMax,
      llmMax: rateLimiterDefaults.llmMax,
      actionRemaining: rateLimiterDefaults.actionMax,
      actionMax: rateLimiterDefaults.actionMax,
      paused: false,
      pauseReason: null,
    };
  }
  function handle(type, extra) {
    switch (type) {
      case 'TS_SCROLLBACK_GET': return { ok: true, scrollback: state.scrollback.slice() };
      case 'TS_SCROLLBACK_APPEND': state.scrollback.push({ text: extra.text, cls: extra.cls }); return { ok: true };
      case 'TS_SCROLLBACK_CLEAR': state.scrollback = []; return { ok: true };
      case 'TS_OPEN_GET': return { ok: true, open: state.open };
      case 'TS_OPEN_SET': state.open = !!extra.open; return { ok: true };
      case 'TS_QUEUE_PEEK': return { ok: true, queue: state.queue.slice(), expectedOrigin: state.expectedOrigin };
      case 'TS_QUEUE_SET':
        state.queue = Array.isArray(extra.queue) ? extra.queue.slice() : [];
        state.expectedOrigin = extra.expectedOrigin || null;
        return { ok: true };
      case 'TS_QUEUE_CLEAR': state.queue = []; state.expectedOrigin = null; return { ok: true };
      case 'TS_QUEUE_POP': {
        if (state.queue.length === 0) return { ok: true, next: null };
        return { ok: true, next: state.queue.shift() };
      }
      case 'TS_VISITED_CHECK': return { ok: true, visited: state.visited.has(extra.origin) };
      case 'TS_VISITED_ADD': state.visited.add(extra.origin); return { ok: true };
      case 'TS_VISITED_LIST': return { ok: true, visitedOrigins: Array.from(state.visited) };
      case 'TS_TOUR_GET': return { ok: true, tourStep: state.tourStep };
      case 'TS_TOUR_SET': state.tourStep = (typeof extra.step === 'number' && extra.step >= 0) ? Math.floor(extra.step) : 0; return { ok: true, tourStep: state.tourStep };
      case 'RL_CHECK': return { ok: true, allowed: true, budget: fullBudget() };
      case 'RL_RECORD': return { ok: true, budget: fullBudget() };
      case 'RL_BUDGET': return { ok: true, budget: fullBudget() };
      case 'RL_RESUME': return { ok: true, resumed: false, budget: fullBudget() };
      case 'STATUS_CHECK': return statusImpl();
      default: return { ok: false };
    }
  }
  return { state, handle };
}

function flush(rounds) {
  const n = rounds || 6;
  return new Promise((resolve) => {
    let i = 0;
    function step() {
      i += 1;
      if (i >= n) { resolve(); return; }
      setImmediate(step);
    }
    setImmediate(step);
  });
}

function buildTerminalSandbox(opts) {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.HTMLInputElement = function HTMLInputElement() {};
  sandbox.HTMLTextAreaElement = function HTMLTextAreaElement() {};
  sandbox.Event = function Event(type, evtOpts) { this.type = type; Object.assign(this, evtOpts || {}); };
  sandbox.KeyboardEvent = function KeyboardEvent(type, evtOpts) { this.type = type; Object.assign(this, evtOpts || {}); };
  sandbox.URL = URL;
  sandbox.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
  sandbox.performance = { now: () => 0 };
  sandbox.setTimeout = () => 0;
  sandbox.clearTimeout = () => {};
  sandbox.location = { origin: 'https://example.com', href: 'https://example.com/page' };
  sandbox.console = console;

  const intervals = new Map();
  let intervalCounter = 1;
  sandbox.setInterval = function setInterval(fn, _ms) { const id = intervalCounter++; intervals.set(id, fn); return id; };
  sandbox.clearInterval = function clearInterval(id) { intervals.delete(id); };

  const windowListeners = {};
  sandbox.addEventListener = function addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn); };
  sandbox.removeEventListener = function removeEventListener() {};
  sandbox.navigation = {
    __listeners: {},
    addEventListener(type, fn) { (this.__listeners[type] = this.__listeners[type] || []).push(fn); },
    removeEventListener() {},
  };

  const documentElement = makeFakeElement('html');
  sandbox.document = {
    documentElement,
    title: 'Example',
    baseURI: 'https://example.com/page',
    hidden: false,
    body: { textContent: '' },
    __qsa: [],
    createElement(tag) { return makeFakeElement(tag); },
    querySelectorAll() { return sandbox.document.__qsa; },
    querySelector() { return null; },
    createTreeWalker() { return { nextNode: () => null }; },
    addEventListener() {},
    removeEventListener() {},
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(GUARDS_PATH, 'utf8'), sandbox, { filename: 'guards.js' });
  vm.runInContext(fs.readFileSync(RATELIMIT_PATH, 'utf8'), sandbox, { filename: 'ratelimit.js' });
  sandbox.window.LFL.axtree = {
    resolve() { return null; },
    isElementVisible(el) { return !!el && el.__visible !== false; },
    frameOptsFor() { return undefined; },
    build() { return { entries: [], map: new Map(), notes: [] }; },
    serialize() { return ''; },
  };
  vm.runInContext(fs.readFileSync(EXECUTOR_PATH, 'utf8'), sandbox, { filename: 'executor.js' });
  vm.runInContext(fs.readFileSync(REGISTRY_PATH, 'utf8'), sandbox, { filename: 'registry.js' });
  vm.runInContext(fs.readFileSync(NAV_PATH, 'utf8'), sandbox, { filename: 'nav.js' });
  vm.runInContext(fs.readFileSync(ENGINE_PATH, 'utf8'), sandbox, { filename: 'engine.js' });
  vm.runInContext(fs.readFileSync(FUNPACK_PATH, 'utf8'), sandbox, { filename: 'funpack.js' });
  vm.runInContext(fs.readFileSync(GAMES_PATH, 'utf8'), sandbox, { filename: 'games.js' });

  sandbox.__rngValue = { v: 0.5 };
  vm.runInContext('Math.random = function () { return __rngValue.v; };', sandbox, { filename: 'rng-shim.js' });

  const storageStore = (opts && opts.initialStorage) ? Object.assign({}, opts.initialStorage) : {};
  const fakeSw = makeFakeSw(sandbox.window.LFL.rateLimiter.DEFAULTS, opts);
  sandbox.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(payload) {
        return Promise.resolve().then(() => fakeSw.handle(payload.type, payload));
      },
    },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          const arr = Array.isArray(keys) ? keys : [keys];
          arr.forEach((k) => { if (Object.prototype.hasOwnProperty.call(storageStore, k)) out[k] = storageStore[k]; });
          cb(out);
        },
        set(obj, cb) {
          Object.assign(storageStore, obj);
          if (typeof cb === 'function') cb();
        },
      },
    },
  };

  vm.runInContext(fs.readFileSync(TERMINAL_PATH, 'utf8'), sandbox, { filename: 'terminal.js' });

  return { sandbox, terminal: sandbox.window.LFL.terminal, fakeSw, storageStore, intervals, windowListeners };
}

// The fake DOM's `textContent` getter (makeFakeElement above) only reflects
// text directly ASSIGNED to an element (`el.textContent = '...'`, as
// _appendLineDom() does for plain info/error/ok lines) - it does not,
// unlike a real DOM, recursively compute a parent's textContent from its
// appended children. _appendRichLine() (welcome/tour/status all use it)
// never assigns the outer line <div>'s own textContent - it only
// appendChild()s <span> children, each with ITS OWN textContent assigned -
// so this helper has to walk children by hand to see rich-rendered text.
function elText(el) {
  if (el.__children && el.__children.length > 0) {
    return el.__children.map(elText).join('');
  }
  return el.textContent || '';
}

function outputText(terminal) {
  return terminal.outputEl.children.map(elText).join('\n');
}

async function testWelcomeIntegration() {
  console.log('\n[5a] E2 welcome-once integration - real Terminal in a vm sandbox');

  await acheck('first-ever open (no lflWelcomeSeen in storage) prints the welcome block and sets the flag', async () => {
    const { terminal, storageStore } = buildTerminalSandbox();
    await flush();
    terminal.open();
    await flush();
    const printed = outputText(terminal);
    assert.match(printed, /lfl-terminal - a command terminal for this page/);
    assert.strictEqual(storageStore.lflWelcomeSeen, true);
  });

  await acheck('a second open in the same session does NOT print the welcome block again', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal.open();
    await flush();
    terminal.close();
    terminal.outputEl.innerHTML = ''; // clear rendered output, keep storage
    terminal.open();
    await flush();
    const printed = outputText(terminal);
    assert.ok(!printed.includes('lfl-terminal - a command terminal for this page'), 'welcome must not reprint on a later open');
  });

  await acheck('open() with lflWelcomeSeen already true (simulated pre-existing profile) never shows welcome', async () => {
    const { terminal } = buildTerminalSandbox({ initialStorage: { lflWelcomeSeen: true } });
    await flush();
    terminal.open();
    await flush();
    const printed = outputText(terminal);
    assert.ok(!printed.includes('lfl-terminal - a command terminal for this page'));
  });

  await acheck('the `welcome` command re-prints the block on demand, any time, regardless of the flag', async () => {
    const { terminal } = buildTerminalSandbox({ initialStorage: { lflWelcomeSeen: true } });
    await flush();
    terminal.open();
    await flush();
    terminal.outputEl.innerHTML = '';
    terminal._submitCommand('welcome');
    await flush();
    const printed = outputText(terminal);
    assert.match(printed, /lfl-terminal - a command terminal for this page/);
  });

  await acheck('`welcome` never participates in a chain (standalone, like `origins`/`dev`) - "welcome && help" is rejected/ignored as a whole, not silently split', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal.open();
    await flush();
    terminal.outputEl.innerHTML = '';
    terminal._submitCommand('welcome && help');
    await flush();
    // `welcome` only matches the bare-word regex - "welcome && help" falls
    // through to _runChain(), which treats "welcome" as an unrecognized
    // deterministic head and (since there is no LLM stub configured to
    // resolve it here) is expected to NOT reprint the exact welcome block a
    // second time via the standalone path.
    const printed = outputText(terminal);
    assert.ok(!printed.includes('This only shows once'), 'the standalone welcome handler must not have fired for a chained/multi-word input');
  });
}

async function testTourIntegration() {
  console.log('\n[5b] E3 tour integration - real Terminal in a vm sandbox, advance/jump/wrap end to end');

  await acheck('bare "tour" the first time shows step 1', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('tour');
    await flush();
    const printed = outputText(terminal);
    assert.match(printed, /TOUR 1\/\d+/);
  });

  await acheck('a second bare "tour" advances to step 2', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('tour');
    await flush();
    terminal.outputEl.innerHTML = '';
    terminal._submitCommand('tour');
    await flush();
    const printed = outputText(terminal);
    assert.match(printed, /TOUR 2\/\d+/);
  });

  await acheck('"tour 4" jumps directly to step 4', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('tour 4');
    await flush();
    const printed = outputText(terminal);
    assert.match(printed, /TOUR 4\/\d+/);
  });

  await acheck('"tour 99" (out of range) is refused with a usage error, progress unchanged', async () => {
    const { terminal, fakeSw } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('tour 3');
    await flush();
    terminal._submitCommand('tour 99');
    await flush();
    const printed = outputText(terminal);
    assert.match(printed, /usage: tour <n>/);
    assert.strictEqual(fakeSw.state.tourStep, 3, 'a refused jump must not overwrite the last valid progress');
  });

  await acheck('advancing through every step and one more wraps back to step 1', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    const n = registry.tourStepCount();
    let lastPrinted = '';
    // Call bare "tour" exactly N+1 times - the (N+1)th call must wrap back
    // to step 1 (tourNextStep()'s own modular-arithmetic guarantee, proven
    // again here end to end through the real Terminal/SW round trip).
    for (let i = 1; i <= n + 1; i++) {
      terminal.outputEl.innerHTML = '';
      terminal._submitCommand('tour');
      await flush();
      lastPrinted = outputText(terminal);
      const expected = i <= n ? i : 1;
      assert.match(lastPrinted, new RegExp(`TOUR ${expected}/${n}`), `call #${i} should show step ${expected}`);
    }
  });

  await acheck('`tour` never participates in a chain - "tour && help" does not print a TOUR header via the standalone path', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('tour && help');
    await flush();
    const printed = outputText(terminal);
    assert.ok(!printed.includes('TOUR 1/'), 'the standalone tour handler must not have fired for a chained input');
  });
}

async function testStatusIntegration() {
  console.log('\n[5c] E5 status integration - real Terminal in a vm sandbox, fake STATUS_CHECK response');

  await acheck('bridge reachable + model alias: renders "bridge: reachable" and the alias, no error line', async () => {
    const { terminal } = buildTerminalSandbox({
      statusImpl: () => ({ ok: true, bridgeReachable: true, modelAlias: 'lfl-cohort-4b' }),
    });
    await flush();
    terminal._submitCommand('status');
    await flush();
    const printed = outputText(terminal);
    assert.match(printed, /bridge:\s*reachable/);
    assert.match(printed, /lfl-cohort-4b/);
    assert.ok(!printed.includes("can't reach your local bridge"));
  });

  await acheck('bridge reachable but no alias available (cohort-gateway 403 case): renders the "(name unavailable through gateway)" fallback, never an error', async () => {
    const { terminal } = buildTerminalSandbox({
      statusImpl: () => ({ ok: true, bridgeReachable: true, modelAlias: null }),
    });
    await flush();
    terminal._submitCommand('status');
    await flush();
    const printed = outputText(terminal);
    assert.match(printed, /bridge:\s*reachable/);
    assert.match(printed, /name unavailable through gateway/);
  });

  await acheck('bridge unreachable: renders "bridge: unreachable" plus the same friendly hint the model-lane errors use', async () => {
    const { terminal } = buildTerminalSandbox({
      statusImpl: () => ({ ok: true, bridgeReachable: false, modelAlias: null }),
    });
    await flush();
    terminal._submitCommand('status');
    await flush();
    const printed = outputText(terminal);
    assert.match(printed, /bridge:\s*unreachable/);
    assert.match(printed, /can't reach your local bridge at 127\.0\.0\.1:1238/);
  });

  await acheck('a thrown chrome.runtime.sendMessage() (SW unreachable) also degrades to "bridge: unreachable", never throws', async () => {
    const { terminal, sandbox } = buildTerminalSandbox();
    sandbox.chrome.runtime.sendMessage = () => Promise.reject(new Error('Extension context invalidated.'));
    await flush();
    terminal._submitCommand('status');
    await flush();
    const printed = outputText(terminal);
    assert.match(printed, /bridge:\s*unreachable/);
  });
}

// ---- run everything ----

async function main() {
  testClassifyModelError();
  testWelcomeContent();
  testTourSequencing();
  testReservedNamesAndRegistration();
  await testStatusPlumbing();
  await testWelcomeIntegration();
  await testTourIntegration();
  await testStatusIntegration();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
