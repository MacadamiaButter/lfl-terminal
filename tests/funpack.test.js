#!/usr/bin/env node
/**
 * tests/funpack.test.js — unit proof of the "fun pack v1" pure functions in
 * `extension/content/funpack.js` (fortune picker, MOTD once-per-day gate,
 * stats math incl. streak rollover, theme name validation, cowsay wrapping).
 *
 * funpack.js is dual-mode (window.LFL.funpack in the browser, module.exports
 * under Node — same convention as registry.js), and every function in it is
 * pure (no DOM, no chrome.*, no network, no Math.random — see the file's own
 * header comment) — so unlike tests/m4_friction.test.js this suite needs no
 * `vm` sandbox at all; it just requires the real, unmodified source directly.
 *
 * Run: node tests/funpack.test.js
 */
'use strict';

const path = require('path');
const assert = require('assert');

const FUNPACK_PATH = path.join(__dirname, '..', 'extension', 'content', 'funpack.js');
const funpack = require(FUNPACK_PATH);

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
// Part 1 — fortune picker (pure function of an integer index)
// =====================================================================

function testFortunePicker() {
  console.log('\n[1] fortune — pickFortuneIndex()/getFortune() are pure functions of an integer, never Math.random');

  check('FORTUNES has at least 30 entries', () => {
    assert.ok(funpack.FORTUNES.length >= 30, `only ${funpack.FORTUNES.length} entries`);
  });

  check('FORTUNES contains no em dash character in any entry (house style)', () => {
    for (const f of funpack.FORTUNES) {
      assert.ok(!f.includes('—'), `entry contains an em dash: "${f}"`);
    }
  });

  check('pickFortuneIndex(0, len) -> 0', () => {
    assert.strictEqual(funpack.pickFortuneIndex(0, 10), 0);
  });

  check('pickFortuneIndex(n, len) wraps around at the array length', () => {
    assert.strictEqual(funpack.pickFortuneIndex(10, 10), 0);
    assert.strictEqual(funpack.pickFortuneIndex(11, 10), 1);
    assert.strictEqual(funpack.pickFortuneIndex(25, 10), 5);
  });

  check('pickFortuneIndex handles negative n without throwing, stays in range', () => {
    const i = funpack.pickFortuneIndex(-1, 10);
    assert.ok(i >= 0 && i < 10, `got ${i}`);
    assert.strictEqual(i, 9);
  });

  check('pickFortuneIndex is deterministic — same input always gives same output', () => {
    const a = funpack.pickFortuneIndex(12345, funpack.FORTUNES.length);
    const b = funpack.pickFortuneIndex(12345, funpack.FORTUNES.length);
    assert.strictEqual(a, b);
  });

  check('pickFortuneIndex(n, 0) does not throw, returns 0', () => {
    assert.strictEqual(funpack.pickFortuneIndex(5, 0), 0);
  });

  check('getFortune(n) always returns a real FORTUNES entry, in range or out', () => {
    for (const n of [0, 1, 29, 30, 500, -3]) {
      const line = funpack.getFortune(n);
      assert.ok(funpack.FORTUNES.includes(line), `getFortune(${n}) -> "${line}" not in FORTUNES`);
    }
  });

  check('getFortune(n) and getFortune(n + FORTUNES.length) return the same line (period = array length)', () => {
    const len = funpack.FORTUNES.length;
    assert.strictEqual(funpack.getFortune(3), funpack.getFortune(3 + len));
  });
}

// =====================================================================
// Part 2 — date helpers + MOTD once-per-day gate
// =====================================================================

function testDatesAndMotd() {
  console.log('\n[2] dayOfYear()/todayStr()/isConsecutiveDay()/shouldShowMotd() — MOTD once-per-day logic');

  check('dayOfYear: Jan 1 -> 1', () => {
    assert.strictEqual(funpack.dayOfYear(new Date('2026-01-01T12:00:00Z')), 1);
  });

  check('dayOfYear: Dec 31 of a non-leap year -> 365', () => {
    assert.strictEqual(funpack.dayOfYear(new Date('2026-12-31T00:00:00Z')), 365);
  });

  check('dayOfYear: Dec 31 of a leap year -> 366', () => {
    assert.strictEqual(funpack.dayOfYear(new Date('2024-12-31T00:00:00Z')), 366);
  });

  check('todayStr: formats as YYYY-MM-DD, UTC-based', () => {
    assert.strictEqual(funpack.todayStr(new Date('2026-07-13T23:59:59Z')), '2026-07-13');
  });

  check('todayStr: zero-pads single-digit month/day', () => {
    assert.strictEqual(funpack.todayStr(new Date('2026-01-05T00:00:00Z')), '2026-01-05');
  });

  check('isConsecutiveDay: exactly one day apart -> true', () => {
    assert.strictEqual(funpack.isConsecutiveDay('2026-07-12', '2026-07-13'), true);
  });

  check('isConsecutiveDay: same day -> false (not "consecutive", it is the SAME day)', () => {
    assert.strictEqual(funpack.isConsecutiveDay('2026-07-13', '2026-07-13'), false);
  });

  check('isConsecutiveDay: a gap of two or more days -> false', () => {
    assert.strictEqual(funpack.isConsecutiveDay('2026-07-10', '2026-07-13'), false);
  });

  check('isConsecutiveDay: month rollover (Jan 31 -> Feb 1) counts as consecutive', () => {
    assert.strictEqual(funpack.isConsecutiveDay('2026-01-31', '2026-02-01'), true);
  });

  check('isConsecutiveDay: missing/malformed input -> false, no throw', () => {
    assert.strictEqual(funpack.isConsecutiveDay(null, '2026-07-13'), false);
    assert.strictEqual(funpack.isConsecutiveDay('2026-07-12', ''), false);
    assert.strictEqual(funpack.isConsecutiveDay('not-a-date', '2026-07-13'), false);
  });

  check('shouldShowMotd: never shown before (null/undefined stored) -> true', () => {
    assert.strictEqual(funpack.shouldShowMotd(null, '2026-07-13'), true);
    assert.strictEqual(funpack.shouldShowMotd(undefined, '2026-07-13'), true);
  });

  check('shouldShowMotd: already shown today -> false', () => {
    assert.strictEqual(funpack.shouldShowMotd('2026-07-13', '2026-07-13'), false);
  });

  check('shouldShowMotd: shown yesterday, asking about today -> true', () => {
    assert.strictEqual(funpack.shouldShowMotd('2026-07-12', '2026-07-13'), true);
  });

  check('shouldShowMotd: garbage stored value -> true (fail open toward showing once, not toward never showing again)', () => {
    assert.strictEqual(funpack.shouldShowMotd(12345, '2026-07-13'), true);
  });
}

// =====================================================================
// Part 3 — stats math: mergeStats/applyStatsIncrement/applyDailyStreak/
// percentOf/formatStatsSummary
// =====================================================================

function testStatsMath() {
  console.log('\n[3] stats — mergeStats/applyStatsIncrement/applyDailyStreak/percentOf/formatStatsSummary');

  check('mergeStats: missing/undefined stored -> DEFAULT_STATS shape', () => {
    const s = funpack.mergeStats(undefined);
    assert.deepStrictEqual(s, {
      totalCommands: 0, deterministicHits: 0, modelProposals: 0, approvals: 0, lastDay: null, streak: 0,
    });
  });

  check('mergeStats: corrupt/wrong-typed fields fall back to defaults, do not propagate NaN', () => {
    const s = funpack.mergeStats({ totalCommands: 'nope', lastDay: 42, streak: undefined });
    assert.strictEqual(s.totalCommands, 0);
    assert.strictEqual(s.lastDay, null);
    assert.strictEqual(s.streak, 0);
  });

  check('mergeStats: valid stored fields pass through unchanged', () => {
    const stored = { totalCommands: 10, deterministicHits: 6, modelProposals: 4, approvals: 2, lastDay: '2026-07-12', streak: 3 };
    assert.deepStrictEqual(funpack.mergeStats(stored), stored);
  });

  check('applyStatsIncrement: bumps only the fields given, others unchanged', () => {
    const base = { totalCommands: 5, deterministicHits: 2, modelProposals: 1, approvals: 0, lastDay: '2026-07-13', streak: 1 };
    const next = funpack.applyStatsIncrement(base, { totalCommands: 1, deterministicHits: 1 });
    assert.strictEqual(next.totalCommands, 6);
    assert.strictEqual(next.deterministicHits, 3);
    assert.strictEqual(next.modelProposals, 1);
    assert.strictEqual(next.approvals, 0);
    assert.strictEqual(next.lastDay, '2026-07-13');
    assert.strictEqual(next.streak, 1);
  });

  check('applyStatsIncrement: empty/missing fields object -> no change to counters', () => {
    const base = funpack.mergeStats({ totalCommands: 3, deterministicHits: 3, modelProposals: 0, approvals: 0 });
    const next = funpack.applyStatsIncrement(base, {});
    assert.strictEqual(next.totalCommands, 3);
    assert.strictEqual(next.deterministicHits, 3);
    const next2 = funpack.applyStatsIncrement(base, undefined);
    assert.strictEqual(next2.totalCommands, 3);
  });

  check('applyStatsIncrement: never mutates the input object (returns a new one)', () => {
    const base = funpack.mergeStats({ totalCommands: 1 });
    const next = funpack.applyStatsIncrement(base, { totalCommands: 1 });
    assert.strictEqual(base.totalCommands, 1, 'input must not be mutated');
    assert.strictEqual(next.totalCommands, 2);
  });

  check('applyDailyStreak: first ever day (lastDay null) -> streak becomes 1', () => {
    const base = funpack.mergeStats({});
    const next = funpack.applyDailyStreak(base, '2026-07-13');
    assert.strictEqual(next.lastDay, '2026-07-13');
    assert.strictEqual(next.streak, 1);
  });

  check('applyDailyStreak: same day again -> idempotent, streak NOT double-counted', () => {
    const base = { totalCommands: 0, deterministicHits: 0, modelProposals: 0, approvals: 0, lastDay: '2026-07-13', streak: 4 };
    const next = funpack.applyDailyStreak(base, '2026-07-13');
    assert.strictEqual(next.streak, 4);
    assert.strictEqual(next.lastDay, '2026-07-13');
  });

  check('applyDailyStreak: yesterday -> today increments the streak by 1', () => {
    const base = { totalCommands: 0, deterministicHits: 0, modelProposals: 0, approvals: 0, lastDay: '2026-07-12', streak: 4 };
    const next = funpack.applyDailyStreak(base, '2026-07-13');
    assert.strictEqual(next.streak, 5);
    assert.strictEqual(next.lastDay, '2026-07-13');
  });

  check('applyDailyStreak: a gap of 2+ days resets the streak to 1', () => {
    const base = { totalCommands: 0, deterministicHits: 0, modelProposals: 0, approvals: 0, lastDay: '2026-07-01', streak: 10 };
    const next = funpack.applyDailyStreak(base, '2026-07-13');
    assert.strictEqual(next.streak, 1);
    assert.strictEqual(next.lastDay, '2026-07-13');
  });

  check('applyDailyStreak: multi-day rollover sequence (day1 -> day2 -> gap -> day again) matches by-hand math', () => {
    let s = funpack.mergeStats({});
    s = funpack.applyDailyStreak(s, '2026-07-10'); // first day
    assert.strictEqual(s.streak, 1);
    s = funpack.applyDailyStreak(s, '2026-07-11'); // consecutive
    assert.strictEqual(s.streak, 2);
    s = funpack.applyDailyStreak(s, '2026-07-11'); // same day again, idempotent
    assert.strictEqual(s.streak, 2);
    s = funpack.applyDailyStreak(s, '2026-07-13'); // gap (skipped the 12th)
    assert.strictEqual(s.streak, 1);
  });

  check('percentOf: normal fraction rounds to nearest integer', () => {
    assert.strictEqual(funpack.percentOf(1, 3), 33);
    assert.strictEqual(funpack.percentOf(2, 3), 67);
  });

  check('percentOf: zero total -> 0, no divide-by-zero throw', () => {
    assert.strictEqual(funpack.percentOf(0, 0), 0);
    assert.strictEqual(funpack.percentOf(5, 0), 0);
  });

  check('percentOf: part === total -> 100', () => {
    assert.strictEqual(funpack.percentOf(10, 10), 100);
  });

  check('formatStatsSummary: includes the exact load-bearing phrase "actions that never touched the model: N (X%)"', () => {
    const stats = { totalCommands: 10, deterministicHits: 8, modelProposals: 2, approvals: 1, lastDay: '2026-07-13', streak: 3 };
    const out = funpack.formatStatsSummary(stats);
    assert.match(out, /actions that never touched the model:\s+8 \(80%\)/);
  });

  check('formatStatsSummary: is aligned monospace (every line same length or label-padded consistently) and includes all four counters', () => {
    const stats = { totalCommands: 5, deterministicHits: 5, modelProposals: 0, approvals: 0, lastDay: null, streak: 0 };
    const out = funpack.formatStatsSummary(stats);
    const lines = out.split('\n');
    assert.strictEqual(lines.length, 5);
    assert.match(out, /total commands:\s+5/);
    assert.match(out, /model proposals:\s+0/);
    assert.match(out, /approvals:\s+0/);
    assert.match(out, /days used \(streak\):\s+0/);
  });

  check('formatStatsSummary: zero commands -> 0% (not NaN%), no throw', () => {
    const out = funpack.formatStatsSummary({ totalCommands: 0, deterministicHits: 0, modelProposals: 0, approvals: 0, lastDay: null, streak: 0 });
    assert.match(out, /actions that never touched the model:\s+0 \(0%\)/);
  });
}

// =====================================================================
// Part 4 — theme name validation
// =====================================================================

function testThemes() {
  console.log('\n[4] theme — isValidTheme()/themeListText()');

  check('THEMES has exactly the four required entries', () => {
    assert.deepStrictEqual(funpack.THEMES.slice().sort(), ['amber', 'default', 'paper', 'phosphor']);
  });

  check('isValidTheme: all four real names are valid', () => {
    for (const t of funpack.THEMES) assert.strictEqual(funpack.isValidTheme(t), true, t);
  });

  check('isValidTheme: unknown name -> false', () => {
    assert.strictEqual(funpack.isValidTheme('solarized'), false);
  });

  check('isValidTheme: case-sensitive (themes are lowercase only) -> "Phosphor" is invalid', () => {
    assert.strictEqual(funpack.isValidTheme('Phosphor'), false);
  });

  check('isValidTheme: non-string / empty / null input -> false, no throw', () => {
    assert.strictEqual(funpack.isValidTheme(''), false);
    assert.strictEqual(funpack.isValidTheme(null), false);
    assert.strictEqual(funpack.isValidTheme(undefined), false);
    assert.strictEqual(funpack.isValidTheme(42), false);
  });

  check('themeListText: marks the active theme with a leading marker and "(active)"', () => {
    const out = funpack.themeListText('phosphor');
    const lines = out.split('\n');
    assert.strictEqual(lines.length, 4);
    const activeLine = lines.find((l) => l.includes('phosphor'));
    assert.match(activeLine, /^\* phosphor \(active\)$/);
  });

  check('themeListText: an invalid/unknown active name falls back to marking "default" active', () => {
    const out = funpack.themeListText('nonsense');
    const lines = out.split('\n');
    const activeLine = lines.find((l) => l.startsWith('*'));
    assert.match(activeLine, /^\* default \(active\)$/);
  });

  check('themeListText: lists all four theme names exactly once each', () => {
    const out = funpack.themeListText('amber');
    for (const t of funpack.THEMES) {
      assert.strictEqual(out.split(t).length - 1, 1, `"${t}" should appear exactly once`);
    }
  });
}

// =====================================================================
// Part 5 — cowsay: wrapCowText()/buildCowBubble()/cowsay()
// =====================================================================

function testCowsay() {
  console.log('\n[5] cowsay — wrapCowText() word-wrap + buildCowBubble() + cowsay()');

  check('wrapCowText: short text (well under 40 cols) -> a single line, unchanged', () => {
    const lines = funpack.wrapCowText('hello there', 40);
    assert.deepStrictEqual(lines, ['hello there']);
  });

  check('wrapCowText: empty string -> a single empty line, not an empty array', () => {
    const lines = funpack.wrapCowText('', 40);
    assert.deepStrictEqual(lines, ['']);
  });

  check('wrapCowText: whitespace-only string -> a single empty line, no throw', () => {
    const lines = funpack.wrapCowText('   \t  ', 40);
    assert.deepStrictEqual(lines, ['']);
  });

  check('wrapCowText: null/undefined input -> a single empty line, no throw', () => {
    assert.deepStrictEqual(funpack.wrapCowText(null, 40), ['']);
    assert.deepStrictEqual(funpack.wrapCowText(undefined, 40), ['']);
  });

  check('wrapCowText: long text wraps at the given width, never mid-word for ordinary words', () => {
    const text = 'this is a moderately long sentence that should wrap across more than one line of output';
    const lines = funpack.wrapCowText(text, 40);
    assert.ok(lines.length > 1, `expected multiple lines, got ${lines.length}`);
    for (const line of lines) {
      assert.ok(line.length <= 40, `line exceeds width: "${line}" (${line.length})`);
    }
    // rejoining with spaces must reproduce the original words in order,
    // proving no word was dropped or corrupted by the wrap
    assert.strictEqual(lines.join(' '), text);
  });

  check('wrapCowText: a single word longer than the width is hard-split, not left overflowing', () => {
    const longWord = 'x'.repeat(97); // 97 chars, > 40
    const lines = funpack.wrapCowText(longWord, 40);
    assert.ok(lines.length >= 3, `expected at least 3 chunks, got ${lines.length}`);
    for (const line of lines) assert.ok(line.length <= 40);
    assert.strictEqual(lines.join(''), longWord, 'no characters lost across the hard split');
  });

  check('wrapCowText: default width is 40 when none given', () => {
    const withDefault = funpack.wrapCowText('a '.repeat(30).trim());
    const withExplicit40 = funpack.wrapCowText('a '.repeat(30).trim(), 40);
    assert.deepStrictEqual(withDefault, withExplicit40);
  });

  check('buildCowBubble: single line -> classic "< ... >" shape with matching top/bottom width', () => {
    const out = funpack.buildCowBubble(['hi']);
    const lines = out.split('\n');
    assert.strictEqual(lines.length, 3);
    assert.match(lines[1], /^< hi >$/);
    assert.strictEqual(lines[0][0], ' ');
    assert.ok(lines[0].includes('_'));
    assert.ok(lines[2].includes('-'));
  });

  check('buildCowBubble: multi-line -> "/ ... \\\\" first, "| ... |" middle, "\\\\ ... /" last', () => {
    const out = funpack.buildCowBubble(['one', 'two', 'three']);
    const lines = out.split('\n');
    // top border, 3 body lines, bottom border = 5 lines
    assert.strictEqual(lines.length, 5);
    assert.ok(lines[1].startsWith('/ '), lines[1]);
    assert.ok(lines[1].endsWith(' \\'), lines[1]);
    assert.ok(lines[2].startsWith('| '), lines[2]);
    assert.ok(lines[2].endsWith(' |'), lines[2]);
    assert.ok(lines[3].startsWith('\\ '), lines[3]);
    assert.ok(lines[3].endsWith(' /'), lines[3]);
  });

  check('buildCowBubble: pads shorter lines to the widest line so the box is rectangular', () => {
    const out = funpack.buildCowBubble(['a', 'much longer line here']);
    const lines = out.split('\n');
    const bodyLines = lines.slice(1, -1);
    const widths = new Set(bodyLines.map((l) => l.length));
    assert.strictEqual(widths.size, 1, `body lines have inconsistent widths: ${JSON.stringify(bodyLines)}`);
  });

  check('cowsay: returns the bubble followed by the cow art, both present', () => {
    const out = funpack.cowsay('moo');
    assert.match(out, /< moo >/);
    assert.match(out, /\^__\^/);
    assert.match(out, /\(oo\)/);
  });

  check('cowsay: empty text still renders a full cow (usage-guarding is terminal.js\'s job, not this pure function\'s)', () => {
    const out = funpack.cowsay('');
    assert.match(out, /\^__\^/);
    assert.ok(out.includes('<'), 'still renders an (empty) bubble');
  });

  check('cowsay: long text produces a multi-line bubble that still ends in the same cow art', () => {
    const out = funpack.cowsay('this is a long enough message that it will definitely need to wrap across several lines of bubble');
    assert.match(out, /\(__\)\\/);
    const bubbleLines = out.split('\n').filter((l) => l.startsWith('/') || l.startsWith('|') || l.startsWith('\\'));
    assert.ok(bubbleLines.length >= 3, `expected a multi-line bubble, got ${bubbleLines.length} body lines`);
  });
}

// ---- run everything ----

console.log('tests/funpack.test.js — funpack v1: fortune, MOTD, stats, theme, cowsay');
testFortunePicker();
testDatesAndMotd();
testStatsMath();
testThemes();
testCowsay();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
