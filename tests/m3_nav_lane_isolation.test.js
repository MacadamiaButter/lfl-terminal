#!/usr/bin/env node
/**
 * tests/m3_nav_lane_isolation.test.js — THE load-bearing M3 security proof
 * (design doc §12 gate item 2): the nav-lane payload sent to the local model
 * contains ONLY the user's typed command string — no element list, no page
 * title, no origin, no scrollback — proven against the REAL, UNMODIFIED
 * `background/service-worker.js` source, not a reimplementation of it.
 *
 * Method: loads service-worker.js via Node's `vm` module, exactly the way
 * tests/sw_ratelimit_persistence.test.js already does (same importScripts
 * resolution for content/ratelimit.js, same fake chrome.storage.session).
 * NEW here: a fake `fetch` that CAPTURES the exact request body sent to
 * http://127.0.0.1:1238, so the assertions below are against the real bytes
 * the extension would put on the wire — not against an exported internal
 * function nobody else calls the same way. Sending a NAV_LLM_REQUEST message
 * through the real onMessage listener, with a message object that carries
 * extra fields (elementList/title/origin/scrollback) a hypothetical caller
 * bug might attach, and asserting NONE of them appear in the captured body —
 * that's the isolation guarantee itself, exercised end to end.
 *
 * A second, contrasting case proves the isolation is SPECIFIC to the
 * nav-lane, not an accidental global no-op: the SAME extra fields sent via
 * the EXISTING page-lane message type (LFL_LLM_REQUEST) DO appear in ITS
 * request body — the isolation is a property of buildNavLanePayload(), not
 * of the transport.
 *
 * Also proves the nav-lane response schema enum is EXACTLY ['navigate',
 * 'abort'] — the 2-subset design §3/§7 requires, not the full 8-primitive
 * page-lane vocabulary.
 *
 * Run: node tests/m3_nav_lane_isolation.test.js
 * Exit code 0 = all assertions passed, nonzero = failure (prints which).
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SW_PATH = path.join(ROOT, 'extension', 'background', 'service-worker.js');
const RATELIMIT_PATH = path.join(ROOT, 'extension', 'content', 'ratelimit.js');

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

// Builds one "service worker instance" the same way
// tests/sw_ratelimit_persistence.test.js's buildSwInstance() does, plus a
// fake `fetch`/`AbortController`/timers so callLocalModelWithPayload() can
// actually run — capturing every request body it sends rather than hitting
// a real network.
function buildSwInstance() {
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const messageListeners = [];
  const capturedRequests = [];
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
        set(obj) {
          return Promise.resolve().then(() => { Object.keys(obj).forEach((k) => storageMap.set(k, obj[k])); });
        },
        remove() { return Promise.resolve(); },
      },
    },
    tabs: { onRemoved: { addListener() {} } },
  };

  sandbox.importScripts = function importScripts(...urls) {
    urls.forEach((u) => {
      const resolved = path.join(ROOT, 'extension', 'background', u);
      assert.strictEqual(resolved, RATELIMIT_PATH, `importScripts() must resolve to the real ratelimit.js, got ${resolved}`);
      const src = fs.readFileSync(resolved, 'utf8');
      vm.runInContext(src, sandbox, { filename: u });
    });
  };

  // Fake fetch: captures {url, init} and returns a canned, well-formed
  // llama.cpp-shaped chat-completions response so the calling code's own
  // response-parsing path (unchanged, shared by both lanes) runs for real.
  sandbox.fetch = function fetch(url, init) {
    capturedRequests.push({ url, init });
    const bodyObj = JSON.parse(init.body);
    const isNav = bodyObj.response_format && bodyObj.response_format.json_schema && bodyObj.response_format.json_schema.name === 'lfl_nav_action';
    const content = isNav
      ? JSON.stringify({ action: 'navigate', value: 'https://example.com', reason: 'test' })
      : JSON.stringify({ action: 'answer', element: 0, value: 'test', reason: 'test' });
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
  sandbox.setTimeout = (fn) => 0; // never actually fire the 30s abort timer in a test
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

  return { send, capturedRequests, sandbox };
}

const FORBIDDEN_SNIPPETS = [
  'SHOULD-NOT-APPEAR-ELEMENTLIST',
  'SHOULD-NOT-APPEAR-TITLE',
  'https://should-not-appear.example',
  'SHOULD-NOT-APPEAR-SCROLLBACK-LINE',
];

const POISONED_MSG = {
  type: 'NAV_LLM_REQUEST',
  command: 'take me to the arch linux wiki',
  // Everything below is what a hypothetical caller bug might accidentally
  // attach — the isolation guarantee is that buildNavLanePayload() never
  // reads any of it, no matter what the caller's message object contains.
  elementList: '[1] link "SHOULD-NOT-APPEAR-ELEMENTLIST"',
  title: 'SHOULD-NOT-APPEAR-TITLE',
  origin: 'https://should-not-appear.example',
  scrollback: ['SHOULD-NOT-APPEAR-SCROLLBACK-LINE'],
};

async function main() {
  console.log('tests/m3_nav_lane_isolation.test.js — nav-lane payload isolation (M3 gate item 2)');

  await acheck('NAV_LLM_REQUEST payload contains NO forbidden page-data snippets anywhere in the serialized body', async () => {
    const sw = buildSwInstance();
    const resp = await sw.send(POISONED_MSG, 1);
    assert.strictEqual(resp.ok, true, JSON.stringify(resp));
    assert.strictEqual(sw.capturedRequests.length, 1, 'exactly one fetch should have fired');
    const bodyStr = sw.capturedRequests[0].init.body;
    for (const snippet of FORBIDDEN_SNIPPETS) {
      assert.ok(!bodyStr.includes(snippet), `forbidden snippet "${snippet}" leaked into the nav-lane request body:\n${bodyStr}`);
    }
  });

  await acheck('the nav-lane user message, parsed, has EXACTLY {command} — no elementList/origin/title/scrollback keys at all', async () => {
    const sw = buildSwInstance();
    await sw.send(POISONED_MSG, 1);
    const body = JSON.parse(sw.capturedRequests[0].init.body);
    const userMsg = body.messages[body.messages.length - 1];
    assert.strictEqual(userMsg.role, 'user');
    const parsedContent = JSON.parse(userMsg.content);
    assert.deepStrictEqual(Object.keys(parsedContent), ['command'], `nav-lane user message must carry ONLY 'command', got keys: ${Object.keys(parsedContent).join(', ')}`);
    assert.strictEqual(parsedContent.command, POISONED_MSG.command);
  });

  await acheck('nav-lane response_format schema enum is EXACTLY [navigate, abort] — the design §3/§7 2-subset, not the 8-primitive page-lane vocabulary', async () => {
    const sw = buildSwInstance();
    await sw.send(POISONED_MSG, 1);
    const body = JSON.parse(sw.capturedRequests[0].init.body);
    const enumVals = body.response_format.json_schema.schema.properties.action.enum;
    assert.deepStrictEqual(enumVals, ['navigate', 'abort']);
  });

  await acheck('nav-lane call reaches the SAME endpoint (127.0.0.1:1238) as page-lane — single fetch sink, shared by construction', async () => {
    const sw = buildSwInstance();
    await sw.send(POISONED_MSG, 1);
    assert.strictEqual(sw.capturedRequests[0].url, 'http://127.0.0.1:1238/v1/chat/completions');
  });

  await acheck('CONTRAST: the SAME extra fields sent via page-lane (LFL_LLM_REQUEST) DO appear in ITS body — proves nav-lane isolation is specific, not a global no-op', async () => {
    const sw = buildSwInstance();
    const pageLaneMsg = {
      type: 'LFL_LLM_REQUEST',
      command: 'find the astronomy article',
      elementList: '[1] link "SHOULD-NOT-APPEAR-ELEMENTLIST"',
      title: 'SHOULD-NOT-APPEAR-TITLE',
      origin: 'https://should-not-appear.example',
    };
    const resp = await sw.send(pageLaneMsg, 1);
    assert.strictEqual(resp.ok, true, JSON.stringify(resp));
    const bodyStr = sw.capturedRequests[0].init.body;
    // Page-lane is SUPPOSED to carry element list/title/origin — that's the
    // whole reason it has its own (existing, unchanged) hard blocks on
    // navigate/click. This assertion is the deliberate contrast case.
    assert.ok(bodyStr.includes('SHOULD-NOT-APPEAR-ELEMENTLIST'), 'page-lane SHOULD carry the element list (contrast case)');
    assert.ok(bodyStr.includes('SHOULD-NOT-APPEAR-TITLE'), 'page-lane SHOULD carry the title (contrast case)');
    assert.ok(bodyStr.includes('should-not-appear.example'), 'page-lane SHOULD carry the origin (contrast case)');
    const body = JSON.parse(bodyStr);
    const enumVals = body.response_format.json_schema.schema.properties.action.enum;
    assert.deepStrictEqual(enumVals, ['click', 'fill', 'select', 'navigate', 'scroll', 'extract', 'answer', 'abort'], 'page-lane schema must be unchanged from M1/M2 — 8-primitive vocabulary');
  });

  await acheck('NAV_LLM_REQUEST with a valid navigate response round-trips through the real onMessage handler correctly', async () => {
    const sw = buildSwInstance();
    const resp = await sw.send({ type: 'NAV_LLM_REQUEST', command: 'go to the arch linux wiki' }, 1);
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(resp.action.action, 'navigate');
    assert.strictEqual(resp.action.value, 'https://example.com');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
