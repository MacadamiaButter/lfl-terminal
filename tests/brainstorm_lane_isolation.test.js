#!/usr/bin/env node
/**
 * tests/brainstorm_lane_isolation.test.js - THE load-bearing brainstorm-lane
 * security proof (design doc LFL-TERMINAL-BRAINSTORM-LANE-DESIGN.md §7, gate
 * item 1): the brainstorm-lane payload sent to the local model contains ONLY
 * the user's typed goal text - no element list, no page title, no origin, no
 * scrollback, no page bytes of any kind - proven against the REAL,
 * UNMODIFIED `background/service-worker.js` source, not a reimplementation
 * of it.
 *
 * Method: a direct clone of tests/m3_nav_lane_isolation.test.js's own
 * method (which is itself the explicitly named template - design doc §7
 * item 1): loads service-worker.js via Node's `vm` module, with a fake
 * `fetch` that CAPTURES the exact request body sent to
 * http://127.0.0.1:1238, so the assertions below are against the real bytes
 * the extension would put on the wire. Sending a BRAINSTORM_LLM_REQUEST
 * message through the real onMessage listener, with a message object that
 * carries extra fields (elementList/title/origin/scrollback/pageText) a
 * hypothetical caller bug might attach, and asserting NONE of them appear in
 * the captured body - that's the isolation guarantee itself, exercised end
 * to end.
 *
 * Contrast cases prove the isolation is SPECIFIC to the brainstorm lane, not
 * an accidental global no-op: the SAME extra fields sent via the page-lane
 * (LFL_LLM_REQUEST) DO appear in its body and its 8-primitive enum is
 * unchanged; the nav-lane's enum is still exactly ['navigate', 'abort'].
 *
 * Also asserts response_format schema name === 'lfl_script_draft', the
 * endpoint is the single shared 127.0.0.1:1238 sink, and the max_tokens/
 * timeout wiring the design doc calls for (512 tokens, a 90s timeout - vs
 * the other two lanes' shared 30s default, captured via a mocked
 * setTimeout that records the delay it was called with).
 *
 * GOTCHA (from a previous session building the nav-lane test): comparing
 * objects/arrays returned OUT of a vm sandbox with deepStrictEqual can trip
 * on Object.prototype identity across realms - normalize with
 * JSON.parse(JSON.stringify(x)) (used throughout below) before comparing.
 *
 * Run: node tests/brainstorm_lane_isolation.test.js
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

// Cross-realm-safe normalize (see the GOTCHA in the header comment above).
function realm(x) {
  return JSON.parse(JSON.stringify(x));
}

// Builds one "service worker instance" - same method as
// tests/m3_nav_lane_isolation.test.js's buildSwInstance(), PLUS a
// setTimeout mock that records the delay it was called with (so the
// brainstorm lane's 90s timeout, vs the other two lanes' shared 30s
// default, is directly observable - the design doc's §7 item 1 "timeout
// wiring where observable" requirement).
function buildSwInstance() {
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const messageListeners = [];
  const capturedRequests = [];
  const capturedTimeoutDelays = [];
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

  // Fake fetch: captures {url, init} and returns a canned, well-formed
  // llama.cpp-shaped chat-completions response so the calling code's own
  // response-parsing path (unchanged, shared by all three lanes) runs for
  // real. Branches on the response_format schema name so each lane gets a
  // shape-correct canned reply.
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
  // Records the delay every call is made with (instead of the m3 template's
  // "ignore the delay, never actually fire" mock) - this is what makes the
  // brainstorm lane's 90s timeout vs the other lanes' 30s default directly
  // observable without waiting out a real timer.
  sandbox.setTimeout = (fn, delay) => { capturedTimeoutDelays.push(delay); return 0; };
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

  return { send, capturedRequests, capturedTimeoutDelays, sandbox };
}

const FORBIDDEN_SNIPPETS = [
  'SHOULD-NOT-APPEAR-ELEMENTLIST',
  'SHOULD-NOT-APPEAR-TITLE',
  'https://should-not-appear.example',
  'SHOULD-NOT-APPEAR-SCROLLBACK-LINE',
  'SHOULD-NOT-APPEAR-PAGETEXT',
];

const POISONED_MSG = {
  type: 'BRAINSTORM_LLM_REQUEST',
  goal: 'draft a script that checks my order status',
  // Everything below is what a hypothetical caller bug might accidentally
  // attach - the isolation guarantee is that buildBrainstormPayload() never
  // reads any of it, no matter what the caller's message object contains.
  elementList: '[1] link "SHOULD-NOT-APPEAR-ELEMENTLIST"',
  title: 'SHOULD-NOT-APPEAR-TITLE',
  origin: 'https://should-not-appear.example',
  scrollback: ['SHOULD-NOT-APPEAR-SCROLLBACK-LINE'],
  pageText: 'SHOULD-NOT-APPEAR-PAGETEXT',
};

async function main() {
  console.log('tests/brainstorm_lane_isolation.test.js - brainstorm-lane payload isolation');

  await acheck('BRAINSTORM_LLM_REQUEST payload contains NO forbidden page-data snippets anywhere in the serialized body', async () => {
    const sw = buildSwInstance();
    const resp = await sw.send(POISONED_MSG, 1);
    assert.strictEqual(resp.ok, true, JSON.stringify(resp));
    assert.strictEqual(sw.capturedRequests.length, 1, 'exactly one fetch should have fired');
    const bodyStr = sw.capturedRequests[0].init.body;
    for (const snippet of FORBIDDEN_SNIPPETS) {
      assert.ok(!bodyStr.includes(snippet), `forbidden snippet "${snippet}" leaked into the brainstorm-lane request body:\n${bodyStr}`);
    }
  });

  await acheck('the brainstorm-lane user message, parsed, has EXACTLY {goal} - no elementList/origin/title/scrollback/pageText keys at all', async () => {
    const sw = buildSwInstance();
    await sw.send(POISONED_MSG, 1);
    const body = JSON.parse(sw.capturedRequests[0].init.body);
    const userMsg = body.messages[body.messages.length - 1];
    assert.strictEqual(userMsg.role, 'user');
    const parsedContent = JSON.parse(userMsg.content);
    assert.deepStrictEqual(realm(Object.keys(parsedContent)), ['goal'], `brainstorm-lane user message must carry ONLY 'goal', got keys: ${Object.keys(parsedContent).join(', ')}`);
    assert.strictEqual(parsedContent.goal, POISONED_MSG.goal);
  });

  await acheck('brainstorm-lane response_format schema name is EXACTLY lfl_script_draft', async () => {
    const sw = buildSwInstance();
    await sw.send(POISONED_MSG, 1);
    const body = JSON.parse(sw.capturedRequests[0].init.body);
    assert.strictEqual(body.response_format.json_schema.name, 'lfl_script_draft');
    assert.deepStrictEqual(realm(body.response_format.json_schema.schema.required), ['script']);
    assert.ok(Object.prototype.hasOwnProperty.call(body.response_format.json_schema.schema.properties, 'script'));
    assert.ok(Object.prototype.hasOwnProperty.call(body.response_format.json_schema.schema.properties, 'reason'));
  });

  await acheck('brainstorm-lane call reaches the SAME endpoint (127.0.0.1:1238) as the other two lanes - single fetch sink, shared by construction', async () => {
    const sw = buildSwInstance();
    await sw.send(POISONED_MSG, 1);
    assert.strictEqual(sw.capturedRequests[0].url, 'http://127.0.0.1:1238/v1/chat/completions');
  });

  await acheck('brainstorm-lane request body: max_tokens is 512 and the AbortController timeout is 90000ms (vs the shared 30000ms default)', async () => {
    const sw = buildSwInstance();
    await sw.send(POISONED_MSG, 1);
    const body = JSON.parse(sw.capturedRequests[0].init.body);
    assert.strictEqual(body.max_tokens, 512);
    assert.deepStrictEqual(realm(sw.capturedTimeoutDelays), [90000]);
  });

  await acheck('CONTRAST: the same extra fields sent via page-lane (LFL_LLM_REQUEST) DO appear in its body, with its 8-primitive enum unchanged, and its timeout is the shared 30000ms default', async () => {
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
    // Page-lane is SUPPOSED to carry element list/title/origin - that's the
    // whole reason it has its own (existing, unchanged) hard blocks on
    // navigate/click. This assertion is the deliberate contrast case.
    assert.ok(bodyStr.includes('SHOULD-NOT-APPEAR-ELEMENTLIST'), 'page-lane SHOULD carry the element list (contrast case)');
    assert.ok(bodyStr.includes('SHOULD-NOT-APPEAR-TITLE'), 'page-lane SHOULD carry the title (contrast case)');
    assert.ok(bodyStr.includes('should-not-appear.example'), 'page-lane SHOULD carry the origin (contrast case)');
    const body = JSON.parse(bodyStr);
    const enumVals = body.response_format.json_schema.schema.properties.action.enum;
    assert.deepStrictEqual(realm(enumVals), ['click', 'fill', 'select', 'navigate', 'scroll', 'extract', 'answer', 'abort'], 'page-lane schema must be unchanged - 8-primitive vocabulary');
    assert.deepStrictEqual(realm(sw.capturedTimeoutDelays), [30000], 'page-lane must still use the shared 30s default - byte-equivalent to its pre-brainstorm-lane behavior');
  });

  await acheck('CONTRAST: nav-lane (NAV_LLM_REQUEST) enum is still exactly [navigate, abort], and its timeout is still the shared 30000ms default', async () => {
    const sw = buildSwInstance();
    const resp = await sw.send({ type: 'NAV_LLM_REQUEST', command: 'go to the arch linux wiki' }, 1);
    assert.strictEqual(resp.ok, true, JSON.stringify(resp));
    const body = JSON.parse(sw.capturedRequests[0].init.body);
    const enumVals = body.response_format.json_schema.schema.properties.action.enum;
    assert.deepStrictEqual(realm(enumVals), ['navigate', 'abort']);
    assert.deepStrictEqual(realm(sw.capturedTimeoutDelays), [30000], 'nav-lane must still use the shared 30s default - byte-equivalent to its pre-brainstorm-lane behavior');
  });

  await acheck('BRAINSTORM_LLM_REQUEST with a valid script-draft response round-trips through the real onMessage handler correctly', async () => {
    const sw = buildSwInstance();
    const resp = await sw.send({ type: 'BRAINSTORM_LLM_REQUEST', goal: 'check the weather' }, 1);
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(typeof resp.action.script, 'string');
    assert.ok(resp.action.script.length > 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
