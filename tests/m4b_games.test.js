#!/usr/bin/env node
/**
 * tests/m4b_games.test.js - unit proof of the M4b "fun pack v2" games
 * (LFL-TERMINAL-FUN-PACK-DESIGN.md §2-§6): `snake`/`2048`/`games`.
 *
 * Three parts:
 *
 * 1. Pure-logic proof of extension/content/games.js (step/turn/merge/spawn/
 *    render), exact via an injected rng - no DOM/vm sandbox needed, same
 *    posture as tests/funpack.test.js.
 *
 * 2. The purity gate (design §6): a static grep of games.js's source for
 *    the forbidden token list (document/chrome./fetch/XMLHttpRequest/
 *    WebSocket/setInterval/setTimeout/addEventListener/innerHTML/location),
 *    plus a `Math.random` check of this project's own (games.js must take
 *    rng injected, never call it directly).
 *
 * 3. Runner lifecycle proof of terminal.js's program-mode primitive
 *    (_enterProgram/_exitProgram/_routeProgramKey) and the dispatch-context
 *    locks (_runChain/_dispatchSegment/_handleGameCommand), loaded via a
 *    `vm` sandbox with simulated DOM/chrome/service-worker handles - same
 *    pattern tests/m4_friction.test.js and tests/m3_hardening.test.js use
 *    for the other window.LFL-scoped, browser-only files, extended here
 *    with enough of a fake DOM (createElement/attachShadow/classList/
 *    chrome.storage.local/chrome.runtime.sendMessage) to actually
 *    CONSTRUCT a real, unmodified `Terminal` instance - something no
 *    existing suite in this project has done before (see m3_hardening's
 *    own header comment on why it previously settled for static source-
 *    shape checks instead). setInterval/clearInterval are captured rather
 *    than real, so ticks are driven by hand, deterministically, instead of
 *    waiting on wall-clock time.
 *
 * Run: node tests/m4b_games.test.js
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const GAMES_PATH = path.join(ROOT, 'extension', 'content', 'games.js');
const GUARDS_PATH = path.join(ROOT, 'extension', 'content', 'guards.js');
const RATELIMIT_PATH = path.join(ROOT, 'extension', 'content', 'ratelimit.js');
const REGISTRY_PATH = path.join(ROOT, 'extension', 'content', 'registry.js');
const NAV_PATH = path.join(ROOT, 'extension', 'content', 'nav.js');
const EXECUTOR_PATH = path.join(ROOT, 'extension', 'content', 'executor.js');
const ENGINE_PATH = path.join(ROOT, 'extension', 'content', 'engine.js');
const FUNPACK_PATH = path.join(ROOT, 'extension', 'content', 'funpack.js');
const TERMINAL_PATH = path.join(ROOT, 'extension', 'content', 'terminal.js');
const TERMINAL_CSS_PATH = path.join(ROOT, 'extension', 'content', 'terminal.css');
const MANIFEST_PATH = path.join(ROOT, 'extension', 'manifest.json');

const games = require(GAMES_PATH);
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

// A rng() that returns a fixed queued sequence of [0,1) floats, repeating
// the last value once the queue is exhausted (never throws / runs dry).
function seqRng(values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : values[values.length - 1]);
}

// =====================================================================
// Part 1 - pure logic: snake
// =====================================================================

function testSnakeLogic() {
  console.log('\n[1] snake - createSnakeGame/turnSnake/stepSnake/snakeFps/renderSnake (pure, injected rng)');

  check('createSnakeGame: length-3 snake, moving right, food not on the snake', () => {
    const s = games.createSnakeGame(seqRng([0]));
    assert.strictEqual(s.snake.length, 3);
    assert.deepStrictEqual(s.dir, { x: 1, y: 0 });
    assert.strictEqual(s.alive, true);
    assert.strictEqual(s.score, 0);
    const onSnake = s.snake.some((seg) => seg.x === s.food.x && seg.y === s.food.y);
    assert.strictEqual(onSnake, false);
  });

  check('createSnakeGame is deterministic for a fixed rng', () => {
    const a = games.createSnakeGame(seqRng([0.3]));
    const b = games.createSnakeGame(seqRng([0.3]));
    assert.deepStrictEqual(a, b);
  });

  check('turnSnake: a valid perpendicular turn changes dir', () => {
    const s = games.createSnakeGame(seqRng([0]));
    const s2 = games.turnSnake(s, 'up');
    assert.deepStrictEqual(s2.dir, { x: 0, y: -1 });
  });

  check('turnSnake: reverse-into-self is ignored (moving right, pressing left -> unchanged)', () => {
    const s = games.createSnakeGame(seqRng([0]));
    const s2 = games.turnSnake(s, 'left');
    assert.strictEqual(s2, s, 'must return the SAME state reference, completely unchanged');
  });

  check('turnSnake: unrecognized dirKey is a no-op', () => {
    const s = games.createSnakeGame(seqRng([0]));
    const s2 = games.turnSnake(s, 'sideways');
    assert.strictEqual(s2, s);
  });

  check('turnSnake: a dead snake never changes direction', () => {
    const s = Object.assign({}, games.createSnakeGame(seqRng([0])), { alive: false });
    const s2 = games.turnSnake(s, 'up');
    assert.strictEqual(s2, s);
  });

  check('stepSnake: moves the head forward one cell, keeps length constant when no food eaten', () => {
    let s = games.createSnakeGame(seqRng([0])); // food placed far from the snake's path
    const lenBefore = s.snake.length;
    s = games.stepSnake(s, seqRng([0]));
    assert.strictEqual(s.snake.length, lenBefore);
    assert.strictEqual(s.alive, true);
  });

  check('stepSnake: wall collision kills the snake without moving it', () => {
    let s = games.createSnakeGame(seqRng([0]));
    const stepsToWall = s.width - s.snake[0].x; // moving right, hits x >= width
    for (let i = 0; i < stepsToWall - 1; i++) s = games.stepSnake(s, seqRng([0]));
    assert.strictEqual(s.alive, true, 'must still be alive just before the fatal step');
    const headBefore = s.snake[0];
    s = games.stepSnake(s, seqRng([0]));
    assert.strictEqual(s.alive, false);
    assert.deepStrictEqual(s.snake[0], headBefore, 'the snake must not have moved on the fatal step');
  });

  check('stepSnake: self collision kills the snake (a tight loop back into its own body)', () => {
    // Hand-built 4-segment snake in a U-turn about to bite its own neck.
    const s = {
      width: 24, height: 14, alive: true, score: 0, foodsEaten: 0,
      snake: [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }],
      dir: { x: -1, y: 0 }, // moving left: next head = {4,5} -- NOT a collision yet
    };
    // Force a collision instead: point it back at its own neck segment.
    const collidingState = Object.assign({}, s, { dir: { x: 0, y: 1 } }); // head {5,5} -> {5,6}, occupied by body[1]
    const next = games.stepSnake(collidingState, seqRng([0]));
    assert.strictEqual(next.alive, false);
  });

  check('stepSnake: eating food grows the snake, increments score/foodsEaten, and spawns a new food cell', () => {
    // Place food directly in the snake's path (one cell ahead of the head).
    let s = games.createSnakeGame(seqRng([0]));
    const head = s.snake[0];
    s = Object.assign({}, s, { food: { x: head.x + 1, y: head.y } });
    const lenBefore = s.snake.length;
    const next = games.stepSnake(s, seqRng([0.999])); // pick the LAST empty cell for the new food
    assert.strictEqual(next.alive, true);
    assert.strictEqual(next.snake.length, lenBefore + 1, 'snake must grow by one segment');
    assert.strictEqual(next.score, 1);
    assert.strictEqual(next.foodsEaten, 1);
    assert.ok(next.food, 'a new food cell must be spawned');
    const foodOnSnake = next.snake.some((seg) => seg.x === next.food.x && seg.y === next.food.y);
    assert.strictEqual(foodOnSnake, false, 'new food must not spawn on top of the (now longer) snake');
  });

  check('stepSnake: a dead snake is a complete no-op', () => {
    const s = Object.assign({}, games.createSnakeGame(seqRng([0])), { alive: false });
    const next = games.stepSnake(s, seqRng([0]));
    assert.strictEqual(next, s);
  });

  check('snakeFps: starts at 5, +0.5 per 3 foods, capped at 10', () => {
    assert.strictEqual(games.snakeFps(0), 5);
    assert.strictEqual(games.snakeFps(2), 5);
    assert.strictEqual(games.snakeFps(3), 5.5);
    assert.strictEqual(games.snakeFps(5), 5.5);
    assert.strictEqual(games.snakeFps(6), 6);
    assert.strictEqual(games.snakeFps(29), 9.5);
    assert.strictEqual(games.snakeFps(30), 10);
    assert.strictEqual(games.snakeFps(300), 10, 'must clamp, never exceed 10');
  });

  check('renderSnake: box-drawing border, snake body, food marker, and a score/fps status line while alive', () => {
    const s = games.createSnakeGame(seqRng([0]));
    const frame = games.renderSnake(s);
    assert.ok(frame.includes('┌') && frame.includes('┐') && frame.includes('└') && frame.includes('┘'));
    assert.ok(frame.includes('█'), 'snake body character must appear');
    assert.ok(frame.includes('●'), 'food character must appear');
    assert.match(frame, /score: 0\s+fps: 5/);
  });

  check('renderSnake: a dead snake shows a GAME OVER status line instead of the fps line', () => {
    const s = Object.assign({}, games.createSnakeGame(seqRng([0])), { alive: false, score: 3 });
    const frame = games.renderSnake(s);
    assert.match(frame, /GAME OVER.*score: 3/);
    assert.ok(!frame.includes('\u2014'), 'no em dash in this user-visible frame text');
  });
}

// =====================================================================
// Part 1b - pure logic: 2048
// =====================================================================

function testGame2048Logic() {
  console.log('\n[2] 2048 - slideRowLeft/slideBoard/move2048/isGameOver2048/render2048 (pure, injected rng)');

  check('slideRowLeft: [2,2,4,4] -> [4,8,0,0], scoreDelta = 12 (design §6 example)', () => {
    const { row, scoreDelta } = games.slideRowLeft([2, 2, 4, 4]);
    assert.deepStrictEqual(row, [4, 8, 0, 0]);
    assert.strictEqual(scoreDelta, 12);
  });

  check('slideRowLeft: [4,4,8,0] -> [8,8,0,0], NEVER [16,0,0,0] (no double-merge in one slide)', () => {
    const { row, scoreDelta } = games.slideRowLeft([4, 4, 8, 0]);
    assert.deepStrictEqual(row, [8, 8, 0, 0]);
    assert.strictEqual(scoreDelta, 8);
  });

  check('slideRowLeft: gaps compress before merging, [0,0,2,2] -> [4,0,0,0]', () => {
    const { row, scoreDelta } = games.slideRowLeft([0, 0, 2, 2]);
    assert.deepStrictEqual(row, [4, 0, 0, 0]);
    assert.strictEqual(scoreDelta, 4);
  });

  check('slideRowLeft: no mergeable/movable pairs -> unchanged, scoreDelta 0', () => {
    const { row, scoreDelta } = games.slideRowLeft([2, 4, 8, 16]);
    assert.deepStrictEqual(row, [2, 4, 8, 16]);
    assert.strictEqual(scoreDelta, 0);
  });

  check('slideBoard: an attempted move that changes nothing reports moved:false', () => {
    const board = [
      [2, 4, 8, 16],
      [2, 4, 8, 16],
      [2, 4, 8, 16],
      [2, 4, 8, 16],
    ];
    const res = games.slideBoard(board, 'left');
    assert.strictEqual(res.moved, false);
  });

  check('slideBoard: "right" mirrors correctly ([2,2,0,0] -> [0,0,0,4])', () => {
    const board = [[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const res = games.slideBoard(board, 'right');
    assert.deepStrictEqual(res.board[0], [0, 0, 0, 4]);
    assert.strictEqual(res.moved, true);
  });

  check('slideBoard: "up"/"down" merge along columns, not rows', () => {
    const board = [[2, 0, 0, 0], [2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const up = games.slideBoard(board, 'up');
    assert.strictEqual(up.board[0][0], 4);
    assert.strictEqual(up.board[1][0], 0);
  });

  check('createGame2048: starts with exactly two nonzero tiles, each 2 or 4', () => {
    const s = games.createGame2048(seqRng([0, 0.5, 0.99, 0.01]));
    const flat = s.board.flat();
    const nonZero = flat.filter((v) => v !== 0);
    assert.strictEqual(nonZero.length, 2);
    nonZero.forEach((v) => assert.ok(v === 2 || v === 4));
    assert.strictEqual(s.score, 0);
    assert.strictEqual(s.over, false);
    assert.strictEqual(s.won, false);
  });

  check('move2048: an illegal move (no change possible) does not spawn a tile or change score', () => {
    const board = [[2, 4, 8, 16], [2, 4, 8, 16], [2, 4, 8, 16], [2, 4, 8, 16]];
    const state = { board, score: 0, over: false, won: false };
    const res = games.move2048(state, 'left', seqRng([0]));
    assert.strictEqual(res.moved, false);
    assert.strictEqual(res.state, state, 'must return the exact same state reference on a no-op move');
  });

  check('move2048: a legal move spawns exactly one new tile and adds the merge sum to score', () => {
    const board = [[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const state = { board, score: 0, over: false, won: false };
    const res = games.move2048(state, 'left', seqRng([0, 0.5])); // spawn at first empty cell, value 2
    assert.strictEqual(res.moved, true);
    assert.strictEqual(res.state.score, 4);
    const flatBefore = [4, 0, 0, 0]; // after merge, before spawn
    const nonZeroAfter = res.state.board.flat().filter((v) => v !== 0).length;
    assert.strictEqual(nonZeroAfter, flatBefore.filter((v) => v !== 0).length + 1, 'exactly one tile spawned');
  });

  check('move2048: reaching 2048 sets justWon true exactly once, "won" persists afterward', () => {
    const board = [[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    let state = { board, score: 0, over: false, won: false };
    let res = games.move2048(state, 'left', seqRng([0.99, 0.01])); // spawn away from the merge, value 2
    assert.strictEqual(res.justWon, true);
    assert.strictEqual(res.state.won, true);
    state = res.state;
    // A subsequent, unrelated legal move must NOT re-announce justWon.
    res = games.move2048(state, 'down', seqRng([0.99, 0.01]));
    assert.strictEqual(res.justWon, false);
    assert.strictEqual(res.state.won, true, '"won" stays true once achieved');
  });

  check('isGameOver2048: a full board with no adjacent equal tiles anywhere -> true', () => {
    const board = [
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ];
    assert.strictEqual(games.isGameOver2048(board), true);
  });

  check('isGameOver2048: any empty cell -> false, regardless of the rest of the board', () => {
    const board = [
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 0],
    ];
    assert.strictEqual(games.isGameOver2048(board), false);
  });

  check('isGameOver2048: a full board WITH an adjacent equal pair -> false (a move is still possible)', () => {
    const board = [
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 2, 4], // last row has an adjacent equal pair (2,2)
    ];
    assert.strictEqual(games.isGameOver2048(board), false);
  });

  check('render2048: shows a score line, "2048!" once won, and a GAME OVER line once over', () => {
    const s = { board: games.createGame2048(seqRng([0])).board, score: 100, over: false, won: false };
    const frameNormal = games.render2048(s);
    assert.match(frameNormal, /score: 100/);
    assert.ok(!frameNormal.includes('2048!'));
    const frameWon = games.render2048(Object.assign({}, s, { won: true }));
    assert.ok(frameWon.includes('2048!'));
    const frameOver = games.render2048(Object.assign({}, s, { over: true }));
    assert.ok(frameOver.includes('GAME OVER'));
    assert.ok(!frameOver.includes('\u2014'), 'no em dash in this user-visible frame text');
  });
}

// =====================================================================
// Part 2 - purity gate (design §6)
// =====================================================================

const FORBIDDEN_TOKENS = [
  'document', 'chrome.', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'setInterval', 'setTimeout', 'addEventListener', 'innerHTML', 'location',
];

// Strips comments before the token scan below - this file's own header
// comment documents the purity rule using the exact forbidden token names
// (backtick-quoted, for maintainers), which would otherwise trip a naive
// grep over the raw source. Only the CODE is required to be free of these
// tokens; block comments are stripped first (line comments too, as a
// defense-in-depth second pass), then the remaining source is scanned.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function testPurityGate() {
  console.log('\n[3] purity gate - games.js contains none of the forbidden tokens (design §6)');
  const raw = fs.readFileSync(GAMES_PATH, 'utf8');
  const src = stripComments(raw);

  check('sanity: comment-stripping actually removed the header comment\'s token mentions', () => {
    assert.ok(raw.includes('`document`'), 'expected the header comment to document the rule (sanity check on the fixture itself)');
    assert.ok(!src.includes('`document`'), 'stripComments() must have removed the header block comment');
  });

  FORBIDDEN_TOKENS.forEach((token) => {
    check(`games.js's CODE (comments stripped) does not contain the forbidden token "${token}"`, () => {
      assert.ok(!src.includes(token), `found forbidden token "${token}" in games.js's code`);
    });
  });

  check('games.js never calls Math.random directly in CODE (randomness only ever arrives via an injected rng param)', () => {
    assert.ok(!src.includes('Math.random'), 'games.js must take rng injected, never call Math.random itself');
  });

  check('games.js is dual-mode (module.exports under Node, window.LFL.games in the browser) like funpack.js/registry.js', () => {
    assert.match(src, /module\.exports = factory\(\)/);
    assert.match(src, /root\.LFL\.games = factory\(\)/);
  });
}

// =====================================================================
// Part 4 - registry.js: RESERVED_NAMES + macro write-time game-name block
// (no DOM/vm needed - registry.js is plain, dual-mode, pure)
// =====================================================================

function testRegistryLocks() {
  console.log('\n[4] registry.js - RESERVED_NAMES + macro write-time block for game names (design §3/§5)');

  check('setAlias: "snake" is reserved, cannot be shadowed by an alias', () => {
    const store = registry.createAliasStore(null);
    const res = store.setAlias('snake', 'go example.com');
    assert.strictEqual(res.ok, false);
  });

  check('setAlias: "2048" is reserved', () => {
    const store = registry.createAliasStore(null);
    const res = store.setAlias('2048', 'go example.com');
    assert.strictEqual(res.ok, false);
  });

  check('setAlias: "games" is reserved', () => {
    const store = registry.createAliasStore(null);
    const res = store.setAlias('games', 'go example.com');
    assert.strictEqual(res.ok, false);
  });

  check('setMacro: a macro NAMED "snake"/"2048"/"games" is rejected (reserved names)', () => {
    const store = registry.createAliasStore(null);
    assert.strictEqual(store.setMacro('snake', 'go example.com').ok, false);
    assert.strictEqual(store.setMacro('2048', 'go example.com').ok, false);
    assert.strictEqual(store.setMacro('games', 'go example.com').ok, false);
  });

  check('setMacro: a macro body that directly references "snake" is rejected at WRITE time', () => {
    const store = registry.createAliasStore(null);
    const res = store.setMacro('x', 'snake');
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /games cannot run inside a macro/);
  });

  check('setMacro: a macro body containing "2048" or "games" anywhere in a chain is rejected', () => {
    const store = registry.createAliasStore(null);
    assert.strictEqual(store.setMacro('y', 'go example.com && 2048').ok, false);
    assert.strictEqual(store.setMacro('z', 'games && go example.com').ok, false);
  });

  check('setMacro: an ordinary macro using OTHER reserved built-ins (go/ls) still succeeds (games-only block, not a blanket RESERVED_NAMES reuse)', () => {
    const store = registry.createAliasStore(null);
    const res = store.setMacro('w', 'go example.com && ls');
    assert.strictEqual(res.ok, true);
  });

  // ---- verify fix MED-2: funpack quartet blocked in macro bodies at write time ----

  check('verify MED-2: a macro body containing "fortune" is rejected at WRITE time', () => {
    const store = registry.createAliasStore(null);
    const res = store.setMacro('morning', 'go example.com && fortune');
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /does not run in chains or macros/);
  });

  check('verify MED-2: macro bodies containing stats/theme/cowsay are rejected at WRITE time too', () => {
    const store = registry.createAliasStore(null);
    assert.strictEqual(store.setMacro('a1', 'stats && go example.com').ok, false);
    assert.strictEqual(store.setMacro('a2', 'go example.com && theme phosphor').ok, false);
    assert.strictEqual(store.setMacro('a3', 'go example.com && cowsay hi').ok, false);
  });

  check('verify MED-2 scope: pre-existing meta-commands (budget/continue) in macro bodies keep their ORIGINAL posture (still accepted at write time)', () => {
    const store = registry.createAliasStore(null);
    assert.strictEqual(store.setMacro('b1', 'go example.com && budget').ok, true);
    assert.strictEqual(store.setMacro('b2', 'go example.com && continue').ok, true);
  });
}

// =====================================================================
// Part 5 - did-you-mean / help-text vocabulary pickup (engine.js + registry.js,
// light vm sandbox, no terminal.js needed)
// =====================================================================

function buildEngineSandbox() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.HTMLInputElement = function HTMLInputElement() {};
  sandbox.HTMLTextAreaElement = function HTMLTextAreaElement() {};
  sandbox.Event = function Event(type, opts) { this.type = type; Object.assign(this, opts || {}); };
  sandbox.KeyboardEvent = function KeyboardEvent(type, opts) { this.type = type; Object.assign(this, opts || {}); };
  sandbox.URL = URL;
  sandbox.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
  sandbox.setTimeout = () => 0;
  sandbox.location = { origin: 'https://example.com', href: 'https://example.com/page' };
  sandbox.document = {
    baseURI: 'https://example.com/page',
    title: 'Example',
    body: { textContent: '' },
    __qsa: [],
    querySelectorAll() { return sandbox.document.__qsa; },
    querySelector() { return null; },
    createTreeWalker() { return { nextNode: () => null }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(GUARDS_PATH, 'utf8'), sandbox, { filename: 'guards.js' });
  sandbox.window.LFL.axtree = {
    resolve() { return null; },
    isElementVisible(el) { return !!el && el.__visible !== false; },
    frameOptsFor() { return undefined; },
  };
  vm.runInContext(fs.readFileSync(EXECUTOR_PATH, 'utf8'), sandbox, { filename: 'executor.js' });
  vm.runInContext(fs.readFileSync(REGISTRY_PATH, 'utf8'), sandbox, { filename: 'registry.js' });
  vm.runInContext(fs.readFileSync(ENGINE_PATH, 'utf8'), sandbox, { filename: 'engine.js' });
  return sandbox;
}

function testDidYouMeanPickup() {
  console.log('\n[5] engine.js registers snake/2048/games into LFL.commandRegistry (help/man + did-you-mean vocabulary)');

  check('LFL.commandRegistry.names() includes "snake", "2048", and "games"', () => {
    const sandbox = buildEngineSandbox();
    const names = sandbox.window.LFL.commandRegistry.names();
    assert.ok(names.includes('snake'), 'snake missing from commandRegistry.names()');
    assert.ok(names.includes('2048'), '2048 missing from commandRegistry.names()');
    assert.ok(names.includes('games'), 'games missing from commandRegistry.names()');
  });

  check('a near-miss typo of "snake" gets a did-you-mean suggestion naming it', () => {
    const sandbox = buildEngineSandbox();
    const names = sandbox.window.LFL.commandRegistry.names();
    const suggestions = sandbox.window.LFL.registry.didYouMean('snaek', names);
    assert.ok(suggestions.includes('snake'), `expected "snake" among ${JSON.stringify(suggestions)}`);
  });

  check('man/help text for each game name mentions "arrows" and "quit" guidance, no em dash', () => {
    const sandbox = buildEngineSandbox();
    const reg = sandbox.window.LFL.commandRegistry;
    ['snake', '2048'].forEach((name) => {
      const man = reg.manText(name);
      assert.match(man, /arrows/i);
      assert.match(man, /quit/i);
      assert.ok(!man.includes('\u2014'), `man text for ${name} must not contain an em dash`);
    });
    const gamesMan = reg.manText('games');
    assert.ok(!gamesMan.includes('no such command'));
  });
}

// =====================================================================
// Part 6 - manifest + CSS sync (file-based, no sandbox needed)
// =====================================================================

function testManifestAndCss() {
  console.log('\n[6] manifest.json content_scripts order + terminal.css/.lfl-frame sync');

  check('manifest.json: content/games.js is listed BEFORE content/terminal.js, permissions byte-identical', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const js = manifest.content_scripts[0].js;
    const gamesIdx = js.indexOf('content/games.js');
    const terminalIdx = js.indexOf('content/terminal.js');
    assert.ok(gamesIdx >= 0, 'content/games.js missing from manifest content_scripts');
    assert.ok(terminalIdx >= 0, 'content/terminal.js missing from manifest content_scripts');
    assert.ok(gamesIdx < terminalIdx, 'content/games.js must load before content/terminal.js');
    assert.deepStrictEqual(manifest.permissions, ['storage'], 'permissions must stay byte-identical');
    assert.deepStrictEqual(manifest.host_permissions, ['http://127.0.0.1:1238/*']);
  });

  check('terminal.css and terminal.js\'s CSS_TEXT constant both define .lfl-frame', () => {
    const css = fs.readFileSync(TERMINAL_CSS_PATH, 'utf8');
    const termSrc = fs.readFileSync(TERMINAL_PATH, 'utf8');
    assert.match(css, /\.lfl-frame\s*\{/);
    assert.match(termSrc, /\.lfl-frame\{/);
  });
}

// =====================================================================
// Part 7 - runner lifecycle: real terminal.js constructed in a vm sandbox
// with simulated DOM/chrome/service-worker handles.
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

// A tiny fake background service worker: just enough TS_*/RL_* message
// handling for terminal.js's constructor and command-dispatch paths to
// settle cleanly. `state.queue` is directly readable/writable by tests
// (e.g. to simulate "a chain is already pending" before calling
// _submitCommand - see the "hadPendingQueue" lock tests below).
function makeFakeSw(rateLimiterDefaults) {
  const state = {
    scrollback: [],
    open: false,
    queue: [],
    expectedOrigin: null,
    visited: new Set(),
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
      case 'RL_CHECK': return { ok: true, allowed: true, budget: fullBudget() };
      case 'RL_RECORD': return { ok: true, budget: fullBudget() };
      case 'RL_BUDGET': return { ok: true, budget: fullBudget() };
      case 'RL_RESUME': return { ok: true, resumed: false, budget: fullBudget() };
      default: return { ok: false };
    }
  }
  return { state, handle };
}

// Flushes the real microtask/macrotask queues a few times - enough for the
// vm-sandboxed async chains (chrome.runtime.sendMessage's Promise.resolve()
// chains, _restoreTerminalState()'s awaits) to fully settle before a test
// makes assertions.
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

function buildTerminalSandbox() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.HTMLInputElement = function HTMLInputElement() {};
  sandbox.HTMLTextAreaElement = function HTMLTextAreaElement() {};
  sandbox.Event = function Event(type, opts) { this.type = type; Object.assign(this, opts || {}); };
  sandbox.KeyboardEvent = function KeyboardEvent(type, opts) { this.type = type; Object.assign(this, opts || {}); };
  sandbox.URL = URL;
  sandbox.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
  sandbox.performance = { now: () => 0 };
  sandbox.setTimeout = () => 0;
  sandbox.clearTimeout = () => {};
  sandbox.location = { origin: 'https://example.com', href: 'https://example.com/page' };
  sandbox.console = console;

  // ---- captured setInterval/clearInterval (see intervals map below) ----
  let intervalCounter = 1;
  const intervals = new Map(); // id -> fn
  sandbox.setInterval = function setInterval(fn, _ms) {
    const id = intervalCounter++;
    intervals.set(id, fn);
    return id;
  };
  sandbox.clearInterval = function clearInterval(id) { intervals.delete(id); };

  // ---- window-level event bus (pagehide / navigation) ----
  const windowListeners = {};
  sandbox.addEventListener = function addEventListener(type, fn) {
    (windowListeners[type] = windowListeners[type] || []).push(fn);
  };
  sandbox.removeEventListener = function removeEventListener() {};
  sandbox.navigation = {
    __listeners: {},
    addEventListener(type, fn) { (this.__listeners[type] = this.__listeners[type] || []).push(fn); },
    removeEventListener() {},
  };

  // ---- document + DOM ----
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

  // ---- controllable Math.random (for the full-game-flow tests below) ----
  //
  // `vm.createContext()` gives the sandboxed scripts their OWN realm's
  // Math/Object/Array etc - `sandbox.Math` is NOT reachable as an ordinary
  // property from OUTSIDE the context (confirmed empirically: it reads as
  // undefined even though bare `Math` resolves fine to code running INSIDE
  // the context). So control is threaded through instead: `__rngValue` is a
  // plain object (by reference, not deep-compared, so which realm it came
  // from does not matter) whose `.v` field the override reads on every
  // call - tests mutate `sandbox.__rngValue.v` directly to control what the
  // GLUE code's `Math.random`-backed rng returns. Only ever affects code
  // running inside this one sandbox; games.js itself still never touches
  // Math.random (see the purity gate) - this only fakes what terminal.js's
  // `_startSnake()`/`_start2048()` pass AS the injected rng.
  sandbox.__rngValue = { v: 0.5 };
  vm.runInContext('Math.random = function () { return __rngValue.v; };', sandbox, { filename: 'rng-shim.js' });

  // ---- chrome mock (storage.local synchronous, runtime.sendMessage -> fake SW) ----
  const storageStore = {};
  const fakeSw = makeFakeSw(sandbox.window.LFL.rateLimiter.DEFAULTS);
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

  return {
    sandbox,
    terminal: sandbox.window.LFL.terminal,
    fakeSw,
    storageStore,
    intervals,
    windowListeners,
  };
}

async function testRunnerLifecycle() {
  console.log('\n[7] runner lifecycle - real terminal.js constructed in a vm sandbox (design §3)');

  await acheck('typing "snake" enters program mode: mode=program, one <pre class="lfl-frame"> appended, input readOnly', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('snake');
    await flush();
    assert.strictEqual(terminal.state.mode, 'program');
    assert.ok(terminal._activeProgram, 'a program must be active');
    assert.strictEqual(terminal._activeProgram.prog.name, 'snake');
    assert.strictEqual(terminal._activeProgram.frameEl.className, 'lfl-frame');
    assert.ok(terminal.outputEl.children.includes(terminal._activeProgram.frameEl));
    assert.strictEqual(terminal.inputEl.readOnly, true);
  });

  await acheck('typing "2048" enters program mode the same way, with no tick interval (key-driven only)', async () => {
    const { terminal, intervals } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('2048');
    await flush();
    assert.strictEqual(terminal._activeProgram.prog.name, '2048');
    assert.strictEqual(terminal._activeProgram.intervalId, null);
    assert.strictEqual(intervals.size, 0, '2048 must never register a setInterval tick');
  });

  await acheck('an isTrusted:false key while a program is active is completely ignored', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('snake');
    await flush();
    const before = terminal._activeProgram;
    terminal._onInputKeydown({ isTrusted: false, key: 'q', preventDefault() {} });
    assert.strictEqual(terminal._activeProgram, before, 'a synthetic (non-isTrusted) key must not exit the program');
  });

  await acheck('arrow keys always get preventDefault() while a program is active', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('snake');
    await flush();
    let calls = 0;
    terminal._onInputKeydown({ isTrusted: true, key: 'ArrowUp', preventDefault() { calls += 1; } });
    assert.strictEqual(calls, 1);
  });

  await acheck('"q" exits the running program: interval cleared, prompt restored, score summary printed', async () => {
    const { terminal, intervals } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('snake');
    await flush();
    const intervalId = terminal._activeProgram.intervalId;
    assert.ok(intervals.has(intervalId), 'tick interval must be registered while active');
    terminal._onInputKeydown({ isTrusted: true, key: 'q', preventDefault() {} });
    assert.strictEqual(terminal._activeProgram, null);
    assert.strictEqual(terminal.inputEl.readOnly, false);
    assert.ok(!intervals.has(intervalId), 'clearInterval must have been called on exit');
    const printed = terminal.outputEl.children.map((c) => c.textContent).join('\n');
    assert.match(printed, /snake: game over - score \d+/);
  });

  await acheck('"Escape" also exits the running program', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('2048');
    await flush();
    terminal._onInputKeydown({ isTrusted: true, key: 'Escape', preventDefault() {} });
    assert.strictEqual(terminal._activeProgram, null);
  });

  await acheck('close() force-exits an active program without refocusing the (now-hidden) input', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('snake');
    await flush();
    terminal.inputEl.__focused = false;
    terminal.close();
    assert.strictEqual(terminal._activeProgram, null);
    assert.strictEqual(terminal.inputEl.readOnly, false);
    assert.strictEqual(terminal.inputEl.__focused, false, 'closing must not refocus the input');
  });

  await acheck('a "pagehide" event force-exits an active program', async () => {
    const { terminal, windowListeners } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('snake');
    await flush();
    assert.ok(windowListeners.pagehide && windowListeners.pagehide.length > 0, 'pagehide listener must be wired');
    windowListeners.pagehide.forEach((fn) => fn());
    assert.strictEqual(terminal._activeProgram, null);
  });

  await acheck('a window.navigation "navigate" event force-exits an active program (reuses nav-watch.js\'s own API)', async () => {
    const { terminal, sandbox } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('2048');
    await flush();
    const navListeners = sandbox.navigation.__listeners.navigate;
    assert.ok(navListeners && navListeners.length > 0, 'window.navigation "navigate" listener must be wired');
    navListeners.forEach((fn) => fn({}));
    assert.strictEqual(terminal._activeProgram, null);
  });

  await acheck('_enterProgram refuses to start while a proposal is awaiting approval', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal.state.mode = 'awaiting-approval';
    const started = terminal._enterProgram({ name: 'snake', onExit: () => [] });
    assert.strictEqual(started, false);
    assert.strictEqual(terminal._activeProgram, null);
    assert.match(terminal._lastResult.message, /awaiting approval/);
    terminal.state.mode = 'idle';
  });

  await acheck('_enterProgram refuses to start a second program while one is already running', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('snake');
    await flush();
    const started = terminal._enterProgram({ name: '2048', onExit: () => [] });
    assert.strictEqual(started, false);
    assert.strictEqual(terminal._activeProgram.prog.name, 'snake', 'the original program must still be the active one');
  });

  await acheck('"snake && stats" is rejected at dispatch (chain context) and never starts a program', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('clear && snake');
    await flush();
    assert.strictEqual(terminal._activeProgram, null);
    const printed = terminal.outputEl.children.map((c) => c.textContent).join('\n');
    assert.match(printed, /cannot run inside a chain or macro/);
  });

  await acheck('"snake" as the FIRST segment of a chain is also rejected (not just later positions)', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('snake && clear');
    await flush();
    assert.strictEqual(terminal._activeProgram, null);
    const printed = terminal.outputEl.children.map((c) => c.textContent).join('\n');
    assert.match(printed, /cannot run inside a chain or macro/);
  });

  await acheck('starting "snake" while an EARLIER chain is still pending is refused, and the pending queue is left untouched', async () => {
    const { terminal, fakeSw } = buildTerminalSandbox();
    await flush();
    fakeSw.state.queue = ['stats'];
    fakeSw.state.expectedOrigin = 'https://example.com';
    terminal._submitCommand('snake');
    await flush();
    assert.strictEqual(terminal._activeProgram, null);
    assert.match(terminal._lastResult.message, /chained command is still pending/);
    assert.deepStrictEqual(fakeSw.state.queue, ['stats'], 'a refused game-start must NOT cancel the pending chain');
  });

  await acheck('"games" lists both games with best/plays from storage, and is itself refused inside a chain', async () => {
    const { terminal, storageStore } = buildTerminalSandbox();
    await flush();
    storageStore.lflGameScores = { snake: { best: 7, plays: 2 }, g2048: { best: 1024, plays: 1 } };
    terminal._submitCommand('games');
    await flush();
    const printed = terminal.outputEl.children.map((c) => c.textContent).join('\n');
    assert.match(printed, /snake\s+best 7\s+plays 2/);
    assert.match(printed, /2048\s+best 1024\s+plays 1/);

    terminal._submitCommand('clear && games');
    await flush();
    const printed2 = terminal.outputEl.children.map((c) => c.textContent).join('\n');
    assert.match(printed2, /cannot run inside a chain or macro/);
  });

  await acheck('_recordGameScore: best only improves, plays always increments', async () => {
    // Field-by-field (not deepStrictEqual against an object literal): the
    // stored object was built INSIDE the vm sandbox's own realm, whose
    // Object.prototype differs from this outer script's - deepStrictEqual
    // correctly treats that as "same shape, not reference-equal" and fails,
    // even though the data itself is exactly right.
    const { terminal, storageStore } = buildTerminalSandbox();
    await flush();
    terminal._recordGameScore('snake', 5);
    await flush();
    assert.strictEqual(storageStore.lflGameScores.snake.best, 5);
    assert.strictEqual(storageStore.lflGameScores.snake.plays, 1);
    terminal._recordGameScore('snake', 3); // lower score
    await flush();
    assert.strictEqual(storageStore.lflGameScores.snake.best, 5, 'best must not regress');
    assert.strictEqual(storageStore.lflGameScores.snake.plays, 2);
    terminal._recordGameScore('snake', 9); // higher score
    await flush();
    assert.strictEqual(storageStore.lflGameScores.snake.best, 9);
    assert.strictEqual(storageStore.lflGameScores.snake.plays, 3);
  });

  await acheck('full snake game via simulated ticks: wall death stops the interval, "q" exits and records the score', async () => {
    const { terminal, sandbox, intervals, storageStore } = buildTerminalSandbox();
    await flush();
    // Deterministic rng: always 0 -> food is placed at the first empty cell
    // (0,0), far from the snake's initial rightward path, so this run walks
    // straight into the right wall with zero food eaten (score stays 0) --
    // an exact, fully reproducible death.
    sandbox.__rngValue.v = 0;
    terminal._submitCommand('snake');
    await flush();
    const intervalId = terminal._activeProgram.intervalId;
    const tickFn = intervals.get(intervalId);
    assert.ok(typeof tickFn === 'function');
    // 100ms scheduler ticks, ~5fps (200ms/tick) at the start -> 2 scheduler
    // ticks per game step; run well past the 12 steps needed to hit the wall
    // (grid width 24, starting head x=12).
    for (let i = 0; i < 60; i++) tickFn();
    assert.ok(!intervals.has(intervalId), 'the tick interval must have stopped itself on death');
    assert.match(terminal._activeProgram.frameEl.textContent, /GAME OVER/);
    terminal._onInputKeydown({ isTrusted: true, key: 'q', preventDefault() {} });
    assert.strictEqual(terminal._activeProgram, null);
    assert.ok(storageStore.lflGameScores && storageStore.lflGameScores.snake, 'score must have been recorded on exit');
    assert.strictEqual(storageStore.lflGameScores.snake.plays, 1);
  });

  await acheck('tick is paused while document.hidden is true', async () => {
    const { terminal, sandbox, intervals } = buildTerminalSandbox();
    await flush();
    sandbox.__rngValue.v = 0;
    terminal._submitCommand('snake');
    await flush();
    const before = terminal._activeProgram.frameEl.textContent;
    sandbox.document.hidden = true;
    const tickFn = intervals.get(terminal._activeProgram.intervalId);
    for (let i = 0; i < 10; i++) tickFn();
    assert.strictEqual(terminal._activeProgram.frameEl.textContent, before, 'frame must not advance while hidden');
    sandbox.document.hidden = false;
  });
}

// =====================================================================
// Part 8 - Fable-verify fixes (2026-07-13 PASS-with-notes follow-up):
// MED-1 program/proposal mutual exclusion (reverse arm), MED-2 funpack
// chain/macro rejection, LOW-4 stopPropagation, plus the two coverage
// gaps flagged as finding 6 (bare-number precedence, alias-inside-macro
// indirection).
// =====================================================================

async function testVerifyFixes() {
  console.log('\n[8] verify fixes - MED-1 mutual exclusion, MED-2 funpack chain posture, LOW-4 stopPropagation, finding-6 coverage');

  await acheck('MED-1: a mutating proposal arriving mid-game force-exits the program FIRST (interval cleared, "game ended" printed), THEN presents', async () => {
    const { terminal, intervals } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('snake');
    await flush();
    const intervalId = terminal._activeProgram.intervalId;
    assert.ok(intervals.has(intervalId));
    terminal._presentProposal({ action: 'click', element: 1, value: '', reason: '' }, 42);
    assert.strictEqual(terminal._activeProgram, null, 'program must have been force-exited');
    assert.ok(!intervals.has(intervalId), 'the game tick interval must be cleared, not left running under the proposal');
    assert.strictEqual(terminal.state.mode, 'awaiting-approval', 'the proposal must still present normally after the forced exit');
    const printed = terminal.outputEl.children.map((c) => c.textContent).join('\n');
    assert.match(printed, /game ended: a proposal arrived/);
    assert.match(printed, /snake: game over - score \d+/, 'the ordinary onExit score summary must still print');
  });

  await acheck('MED-1: after rejecting that proposal, state.mode is idle and NO interval is still registered (the pre-fix inconsistency)', async () => {
    const { terminal, intervals } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('snake');
    await flush();
    terminal._presentProposal({ action: 'fill', element: 2, value: 'x', reason: '' }, 10);
    assert.strictEqual(terminal.state.mode, 'awaiting-approval');
    terminal._rejectProposal();
    assert.strictEqual(terminal.state.mode, 'idle');
    assert.strictEqual(terminal.state.pendingProposal, null);
    assert.strictEqual(intervals.size, 0, 'no orphaned interval may survive the exit+reject sequence');
    assert.strictEqual(terminal._activeProgram, null);
  });

  await acheck('MED-1: an auto-run (non-approval) proposal arriving mid-game also exits the program cleanly first', async () => {
    const { terminal, intervals } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('2048');
    await flush();
    terminal._presentProposal({ action: 'answer', element: null, value: 'hi', reason: '' }, 5);
    await flush();
    assert.strictEqual(terminal._activeProgram, null);
    assert.strictEqual(terminal.state.mode, 'idle');
    assert.strictEqual(intervals.size, 0);
    const printed = terminal.outputEl.children.map((c) => c.textContent).join('\n');
    assert.match(printed, /game ended: a proposal arrived/);
  });

  await acheck('MED-1: a navigation confirm (_confirmOrNavigate) arriving mid-game force-exits the program first, then awaits confirmation', async () => {
    const { terminal, sandbox, intervals } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('snake');
    await flush();
    const intervalId = terminal._activeProgram.intervalId;
    await terminal._confirmOrNavigate(new sandbox.URL('https://newsite.example/'), { modelResolved: false });
    assert.strictEqual(terminal._activeProgram, null, 'program must have been force-exited');
    assert.ok(!intervals.has(intervalId));
    assert.strictEqual(terminal.state.mode, 'awaiting-nav-confirm');
    const printed = terminal.outputEl.children.map((c) => c.textContent).join('\n');
    assert.match(printed, /game ended: a proposal arrived/);
    terminal._rejectNav();
    await flush();
    assert.strictEqual(terminal.state.mode, 'idle');
    assert.strictEqual(intervals.size, 0);
  });

  await acheck('MED-2: "clear && fortune" rejects the fortune segment at dispatch - no page-lane model call, no "model offline" error', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('clear && fortune');
    await flush(12);
    const printed = terminal.outputEl.children.map((c) => c.textContent).join('\n');
    assert.match(printed, /"fortune" does not run in chains or macros/);
    assert.ok(!printed.includes('asking the local model'), 'the model must never have been consulted');
    assert.ok(!printed.includes('model offline'), 'the segment must be rejected, not fall through to the LLM path');
    assert.strictEqual(terminal.state.mode, 'idle');
  });

  await acheck('MED-2: stats/theme/cowsay in a chain are rejected the same way', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    // Asserted via _lastResult per iteration ("clear" as the first segment
    // wipes the output pane, so a printed-lines check would only ever see
    // the final iteration).
    for (const [seg, name] of [['stats', 'stats'], ['theme phosphor', 'theme'], ['cowsay hi', 'cowsay']]) {
      terminal._submitCommand(`clear && ${seg}`);
      await flush(12);
      assert.strictEqual(terminal._lastResult.ok, false, `${name} in a chain must be rejected`);
      assert.match(terminal._lastResult.message, new RegExp(`"${name}" does not run in chains or macros`));
    }
  });

  await acheck('MED-2: an alias for "fortune" typed ALONE routes to the real handler (prints a fortune), never to the model', async () => {
    const { terminal, sandbox } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('alias f = fortune');
    await flush();
    terminal._submitCommand('f');
    await flush();
    assert.strictEqual(terminal._lastResult.ok, true);
    assert.ok(sandbox.window.LFL.funpack.FORTUNES.includes(terminal._lastResult.message),
      `expected a real FORTUNES entry, got: "${terminal._lastResult.message}"`);
    const printed = terminal.outputEl.children.map((c) => c.textContent).join('\n');
    assert.ok(!printed.includes('asking the local model'));
  });

  await acheck('LOW-4: keys are stopPropagation\'d while a program is active (and only then)', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('snake');
    await flush();
    let stopped = 0;
    terminal._onInputKeydown({ isTrusted: true, key: 'ArrowUp', preventDefault() {}, stopPropagation() { stopped += 1; } });
    assert.strictEqual(stopped, 1, 'program-mode keys must not bubble to page document listeners');
    // Exit and confirm ordinary typing does NOT gain a stopPropagation call
    // (unchanged general semantics).
    terminal._onInputKeydown({ isTrusted: true, key: 'q', preventDefault() {}, stopPropagation() { stopped += 1; } });
    assert.strictEqual(terminal._activeProgram, null);
    const afterExit = stopped;
    terminal._onInputKeydown({ isTrusted: true, key: 'x', preventDefault() {}, stopPropagation() { stopped += 1; } });
    assert.strictEqual(stopped, afterExit, 'ordinary (non-program) typing must keep its original propagation semantics');
  });

  await acheck('finding 6a: "2048" typed while an ls-listing is active runs the GAME, not the bare-number listing action', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    // A live listing context - the shape engine.js's doLs() builds. A bare
    // number would normally act on it; the game name must win precedence.
    terminal.state.listingContext = { entries: [], map: new Map(), notes: [] };
    terminal._submitCommand('2048');
    await flush();
    assert.ok(terminal._activeProgram, 'a program must be running');
    assert.strictEqual(terminal._activeProgram.prog.name, '2048');
    assert.strictEqual(terminal.state.mode, 'program');
  });

  await acheck('finding 6b: alias-inside-macro indirection reaching a game name is caught at RUNTIME with chain context (write-time cannot see it)', async () => {
    const { terminal } = buildTerminalSandbox();
    await flush();
    terminal._submitCommand('alias s = snake');
    await flush();
    // Write time only sees the head word "s" - this MUST be accepted
    // (proving the runtime check below is load-bearing, not redundant).
    terminal._submitCommand('macro m = clear && s');
    await flush();
    assert.match(terminal._lastResult.message, /macro defined/, 'the macro must be accepted at write time (head word is "s", not a game name)');
    terminal._submitCommand('m');
    await flush(16);
    assert.strictEqual(terminal._activeProgram, null, 'the game must NOT have started via the alias-in-macro indirection');
    const printed = terminal.outputEl.children.map((c) => c.textContent).join('\n');
    assert.match(printed, /"snake" cannot run inside a chain or macro/);
  });
}

// ---- run everything ----

async function main() {
  console.log('tests/m4b_games.test.js - M4b fun pack v2: snake, 2048, games');
  testSnakeLogic();
  testGame2048Logic();
  testPurityGate();
  testRegistryLocks();
  testDidYouMeanPickup();
  testManifestAndCss();
  await testRunnerLifecycle();
  await testVerifyFixes();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
