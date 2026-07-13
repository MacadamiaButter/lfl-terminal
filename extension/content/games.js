/**
 * games.js — M4b fun pack v2: PURE LOGIC ONLY for `snake` and `2048` (design
 * doc §2/§4, LFL-TERMINAL-FUN-PACK-DESIGN.md).
 *
 * Hard split (design §2): this file may contain step/merge/spawn functions
 * and frame-string renderers, and NOTHING ELSE. No `document`, no
 * `window.*` page APIs, no `chrome.*`, no timers (`setInterval`/
 * `setTimeout`), no listeners (`addEventListener`), no network calls of any
 * kind (no fetch, no XHR, no raw sockets), no `innerHTML`, no `location`, and
 * no `Math.random()` anywhere — every function that needs randomness (food
 * placement, tile spawn) takes an injected `rng()` argument (a function
 * returning a float in [0, 1), the same calling convention as
 * `Math.random`) so the whole file is exactly reproducible from tests
 * (tests/m4b_games.test.js) with a canned rng sequence. terminal.js is the
 * ONLY caller that ever passes a REAL `Math.random`-backed rng, owns the
 * `setInterval` tick, the `<pre class="lfl-frame">` element, key routing,
 * and the `chrome.storage.local` high-score writes — same division of
 * labor funpack.js's header comment describes for fortune/MOTD/stats.
 *
 * A dedicated grep test (tests/m4b_games.test.js, "purity gate") enforces
 * the token list above is absent from this file's source; see design §6.
 *
 * Dual-mode like funpack.js/registry.js: window.LFL.games in the browser,
 * module.exports under Node (tests/m4b_games.test.js requires it directly,
 * no DOM/vm sandbox needed for the pure-logic half of that suite).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.LFL = root.LFL || {};
    root.LFL.games = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // =====================================================================
  // snake
  // =====================================================================

  const SNAKE_WIDTH = 24;
  const SNAKE_HEIGHT = 14;

  const DIR_VECTORS = Object.freeze({
    up: Object.freeze({ x: 0, y: -1 }),
    down: Object.freeze({ x: 0, y: 1 }),
    left: Object.freeze({ x: -1, y: 0 }),
    right: Object.freeze({ x: 1, y: 0 }),
  });

  // Pure helper: every (x,y) in `width`x`height` NOT present in `occupied`,
  // in a fixed row-major order (deterministic — needed so an injected rng
  // index always names the same cell for the same state).
  function emptyCells(width, height, occupied) {
    const occSet = new Set((occupied || []).map((p) => `${p.x},${p.y}`));
    const out = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!occSet.has(`${x},${y}`)) out.push({ x, y });
      }
    }
    return out;
  }

  // Pure: rng() must return a float in [0, 1). Clamped so a boundary value
  // (rng() returning exactly 1, or a buggy caller passing something out of
  // range) never indexes out of bounds.
  function pickRandomCell(rng, cells) {
    if (!cells || cells.length === 0) return null;
    const idx = Math.min(cells.length - 1, Math.max(0, Math.floor(rng() * cells.length)));
    return cells[idx];
  }

  // Pure speed curve: ~5 fps at the start, +0.5 fps every 3 foods eaten,
  // clamped to 10 (design §4). A pure function of the running foods-eaten
  // counter, not of wall-clock time, so it is exactly testable.
  function snakeFps(foodsEaten) {
    const n = Number.isFinite(foodsEaten) && foodsEaten > 0 ? Math.floor(foodsEaten) : 0;
    const fps = 5 + 0.5 * Math.floor(n / 3);
    return Math.min(10, fps);
  }

  // Initial state: a length-3 snake, centered, moving right; one food tile
  // placed via the injected rng. `state.alive` starts true; `foodsEaten`
  // (distinct from `score`, though they move in lockstep here) exists so a
  // future scoring tweak wouldn't have to renumber this field.
  function createSnakeGame(rng) {
    const width = SNAKE_WIDTH;
    const height = SNAKE_HEIGHT;
    const startY = Math.floor(height / 2);
    const startX = Math.floor(width / 2);
    const snake = [
      { x: startX, y: startY },
      { x: startX - 1, y: startY },
      { x: startX - 2, y: startY },
    ];
    const food = pickRandomCell(rng, emptyCells(width, height, snake));
    return {
      width,
      height,
      snake,
      dir: DIR_VECTORS.right,
      food,
      alive: true,
      score: 0,
      foodsEaten: 0,
    };
  }

  // Pure: changes `state.dir` unless `dirKey` is unrecognized, the snake is
  // already dead, or `dirKey` is the exact reverse of the CURRENT direction
  // (design §4: "reverse-into-self ignored") — in every ignored case the
  // input state is returned completely unchanged (same reference-equality-
  // friendly contract stepSnake() below uses).
  function turnSnake(state, dirKey) {
    const vec = DIR_VECTORS[dirKey];
    if (!vec || !state.alive) return state;
    const cur = state.dir;
    const isReverse = vec.x === -cur.x && vec.y === -cur.y;
    if (isReverse) return state;
    return Object.assign({}, state, { dir: vec });
  }

  // Pure: advances the snake exactly one cell in its current direction.
  // Wall collision and self collision both set `alive:false` and otherwise
  // leave the state exactly as it was at the moment of death (no partial
  // move applied) — so a death frame always shows precisely where the fatal
  // move was attempted from. Self-collision is checked against the body
  // MINUS the tail segment when not eating this move (the tail cell is
  // vacated the same tick), and against the FULL body when eating (the
  // snake grows, so the tail does not vacate) — the classic snake rule.
  function stepSnake(state, rng) {
    if (!state.alive) return state;
    const head = state.snake[0];
    const newHead = { x: head.x + state.dir.x, y: head.y + state.dir.y };
    const hitWall = newHead.x < 0 || newHead.x >= state.width || newHead.y < 0 || newHead.y >= state.height;
    if (hitWall) return Object.assign({}, state, { alive: false });

    const willEat = !!state.food && newHead.x === state.food.x && newHead.y === state.food.y;
    const bodyToCheck = willEat ? state.snake : state.snake.slice(0, -1);
    const hitSelf = bodyToCheck.some((seg) => seg.x === newHead.x && seg.y === newHead.y);
    if (hitSelf) return Object.assign({}, state, { alive: false });

    let newSnakeBody = [newHead].concat(state.snake);
    let score = state.score;
    let foodsEaten = state.foodsEaten;
    let food = state.food;
    if (willEat) {
      score += 1;
      foodsEaten += 1;
      food = pickRandomCell(rng, emptyCells(state.width, state.height, newSnakeBody));
    } else {
      newSnakeBody = newSnakeBody.slice(0, -1);
    }
    return Object.assign({}, state, {
      snake: newSnakeBody, food, score, foodsEaten, alive: true,
    });
  }

  // Pure renderer: one box-drawn frame + a status line. `█` snake, `●`
  // food, plain box-drawing border. Dead state swaps the status line for a
  // "GAME OVER" notice rather than mutating the board — the last live frame
  // stays visible underneath it.
  function renderSnake(state) {
    const w = state.width;
    const h = state.height;
    const cells = [];
    for (let y = 0; y < h; y++) cells.push(new Array(w).fill(' '));
    state.snake.forEach((seg) => {
      if (seg.x >= 0 && seg.x < w && seg.y >= 0 && seg.y < h) cells[seg.y][seg.x] = '█';
    });
    if (state.food && state.food.x >= 0 && state.food.x < w && state.food.y >= 0 && state.food.y < h) {
      cells[state.food.y][state.food.x] = '●';
    }
    const top = '┌' + '─'.repeat(w) + '┐';
    const bottom = '└' + '─'.repeat(w) + '┘';
    const body = cells.map((row) => '│' + row.join('') + '│');
    const statusLine = state.alive
      ? `score: ${state.score}  fps: ${snakeFps(state.foodsEaten)}`
      : `GAME OVER - score: ${state.score} (press q to exit)`;
    return [top].concat(body, [bottom, statusLine]).join('\n');
  }

  // =====================================================================
  // 2048
  // =====================================================================

  const BOARD_SIZE = 4;

  function emptyBoard() {
    const out = [];
    for (let r = 0; r < BOARD_SIZE; r++) out.push(new Array(BOARD_SIZE).fill(0));
    return out;
  }

  function boardEmptyPositions(board) {
    const out = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (board[r][c] === 0) out.push({ r, c });
      }
    }
    return out;
  }

  // Pure: places one new tile (2 with 0.9 probability, 4 with 0.1 — both
  // read off the SAME single rng() call's fractional value, so this
  // consumes exactly one rng() draw for the position and one for the
  // value) into a uniformly-chosen empty cell. A full board is returned
  // unchanged (nothing to spawn into).
  function spawnTile(board, rng) {
    const empties = boardEmptyPositions(board);
    if (empties.length === 0) return board;
    const idx = Math.min(empties.length - 1, Math.max(0, Math.floor(rng() * empties.length)));
    const pos = empties[idx];
    const value = rng() < 0.9 ? 2 : 4;
    const next = board.map((row) => row.slice());
    next[pos.r][pos.c] = value;
    return next;
  }

  // Initial state: an empty 4x4 board with exactly two tiles spawned (the
  // classic 2048 opening position). `won` (persistent: "has this game EVER
  // reached a 2048 tile") starts false; see move2048()'s "continue after
  // 2048" comment for why this is tracked separately from a per-move flag.
  function createGame2048(rng) {
    let board = emptyBoard();
    board = spawnTile(board, rng);
    board = spawnTile(board, rng);
    return { board, score: 0, over: false, won: false };
  }

  // Pure: slides+merges ONE row toward index 0 (i.e. "left"). Classic 2048
  // rule: a tile that was JUST created by a merge this move cannot merge
  // again in the same slide — e.g. `[4,4,8,0]` -> merge the two 4s into an
  // 8, then the ORIGINAL 8 is examined next and does NOT merge with the
  // freshly-made 8 (design §6: `[4,4,8]` -> `[8,8]`, never `[16]`).
  // Returns `{row, scoreDelta}`; `row` is always exactly `row.length` long
  // (zero-padded on the right).
  function slideRowLeft(row) {
    const nonZero = row.filter((v) => v !== 0);
    const merged = [];
    let scoreDelta = 0;
    let i = 0;
    while (i < nonZero.length) {
      if (i + 1 < nonZero.length && nonZero[i] === nonZero[i + 1]) {
        const value = nonZero[i] * 2;
        merged.push(value);
        scoreDelta += value;
        i += 2;
      } else {
        merged.push(nonZero[i]);
        i += 1;
      }
    }
    while (merged.length < row.length) merged.push(0);
    return { row: merged, scoreDelta };
  }

  function reverseRow(row) { return row.slice().reverse(); }

  function transpose(board) {
    const out = emptyBoard();
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) out[c][r] = board[r][c];
    }
    return out;
  }

  function boardsEqual(a, b) {
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (a[r][c] !== b[r][c]) return false;
      }
    }
    return true;
  }

  // Pure: applies slideRowLeft() to every row of `board`, after rotating/
  // mirroring the board so "left" is always the working direction, then
  // rotating/mirroring back. `moved` is true iff the resulting board
  // differs from the input in at least one cell (2048's own rule for
  // "was this a legal move" — an attempted slide that changes nothing does
  // not consume a turn or spawn a tile).
  function slideBoard(board, dirKey) {
    let working = board.map((row) => row.slice());
    let scoreDelta = 0;
    const applyRows = (rows) => rows.map((row) => {
      const res = slideRowLeft(row);
      scoreDelta += res.scoreDelta;
      return res.row;
    });

    if (dirKey === 'left') {
      working = applyRows(working);
    } else if (dirKey === 'right') {
      working = applyRows(working.map(reverseRow)).map(reverseRow);
    } else if (dirKey === 'up') {
      working = transpose(applyRows(transpose(working)));
    } else if (dirKey === 'down') {
      working = transpose(applyRows(transpose(working).map(reverseRow)).map(reverseRow));
    } else {
      return { board, scoreDelta: 0, moved: false };
    }
    const moved = !boardsEqual(board, working);
    return { board: working, scoreDelta, moved };
  }

  function boardHasTile(board, value) {
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (board[r][c] === value) return true;
      }
    }
    return false;
  }

  // Pure: true iff there is no empty cell AND no pair of horizontally- or
  // vertically-adjacent equal tiles anywhere — i.e. no move in any of the
  // 4 directions could possibly change the board.
  function isGameOver2048(board) {
    if (boardEmptyPositions(board).length > 0) return false;
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const v = board[r][c];
        if (c + 1 < BOARD_SIZE && board[r][c + 1] === v) return false;
        if (r + 1 < BOARD_SIZE && board[r + 1][c] === v) return false;
      }
    }
    return true;
  }

  // Pure: one full move — slide+merge, then (only if something actually
  // moved) spawn one new tile and recompute score/won/over. Returns
  // `{state, moved, justWon}`; `state` is the (possibly unchanged) new
  // state, `moved` is whether this call had any effect, `justWon` is true
  // only on the SINGLE move that first produces a 2048 tile (design §4:
  // "reaching 2048 prints '2048!' and play continues" — `state.won` stays
  // true for the rest of the game so callers can keep showing the
  // achievement without re-announcing it every subsequent move).
  function move2048(state, dirKey, rng) {
    if (state.over) return { state, moved: false, justWon: false };
    const slid = slideBoard(state.board, dirKey);
    if (!slid.moved) return { state, moved: false, justWon: false };

    const boardAfterSpawn = spawnTile(slid.board, rng);
    const score = state.score + slid.scoreDelta;
    const reachedNow = !state.won && boardHasTile(boardAfterSpawn, 2048);
    const won = state.won || reachedNow;
    const over = isGameOver2048(boardAfterSpawn);
    const newState = { board: boardAfterSpawn, score, over, won };
    return { state: newState, moved: true, justWon: reachedNow };
  }

  // Pure renderer: a fixed-width grid (`.` for empty cells) plus a status
  // line. Shows "2048!" for the remainder of the game once reached (see
  // move2048()'s comment), and a "GAME OVER" notice once no move remains.
  function render2048(state) {
    const cellWidth = 6;
    const sepCell = '-'.repeat(cellWidth);
    const sep = `+${[sepCell, sepCell, sepCell, sepCell].join('+')}+`;
    const rows = state.board.map((row) => {
      const cells = row.map((v) => {
        const s = v === 0 ? '.' : String(v);
        const pad = cellWidth - s.length;
        const left = Math.floor(pad / 2);
        const right = pad - left;
        return ' '.repeat(Math.max(0, left)) + s + ' '.repeat(Math.max(0, right));
      });
      return `|${cells.join('|')}|`;
    });
    const grid = [sep, rows.join(`\n${sep}\n`), sep].join('\n');
    const statusParts = [`score: ${state.score}`];
    if (state.won) statusParts.push('2048!');
    if (state.over) statusParts.push('GAME OVER (press q to exit)');
    return `${grid}\n${statusParts.join('  ')}`;
  }

  return {
    // snake
    SNAKE_WIDTH, SNAKE_HEIGHT, createSnakeGame, turnSnake, stepSnake, snakeFps, renderSnake,
    // 2048
    BOARD_SIZE, createGame2048, slideRowLeft, slideBoard, move2048, isGameOver2048, render2048,
  };
});
