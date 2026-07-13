/**
 * funpack.js - "fun pack v1": fortune, MOTD, stats, theme, cowsay.
 *
 * Every function in this file is PURE data + pure functions: no DOM reads,
 * no DOM writes, no chrome.* calls, no network calls, no Math.random(). All
 * "pick something" behavior (fortune, MOTD) is a pure function of an integer
 * index the caller supplies (a counter, Date.now(), or a day-of-year number)
 * so it is directly unit-testable without mocking time or randomness (see
 * tests/funpack.test.js). terminal.js is the ONLY caller that touches
 * chrome.storage.local / the DOM around these functions (persisting
 * lflStats/lflTheme/lflMotdDay, printing lines, applying a theme class) --
 * same division of labor engine.js's header comment describes for its own
 * pure-helpers-vs-DOM-handlers split.
 *
 * Dual-mode like guards.js/ratelimit.js/registry.js: window.LFL.funpack in
 * the browser, module.exports under Node (tests/funpack.test.js requires it
 * directly, no DOM/vm sandbox needed).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.LFL = root.LFL || {};
    root.LFL.funpack = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // =====================================================================
  // fortune
  // =====================================================================

  // ~30 entries, deliberately mixing genuine local-first/privacy one-liners
  // with real command tips -- this is documentation-as-easter-egg, not filler
  // text. No em dash character in any of these (house style for this file --
  // see the build report for why); plain punctuation only.
  const FORTUNES = Object.freeze([
    'Nothing you type here ever leaves this machine.',
    'try: ls buttons',
    'alias gh = go github.com',
    'The only network call this extension makes is to your own loopback model.',
    'try: macro wiki = go en.wikipedia.org && search',
    "Local-first isn't a slogan here, it's a static test: check_no_egress.sh.",
    'try: here',
    'Supervised means a human sees the exact action before it runs, every time.',
    'try: man click',
    "A closed shadow root keeps the page from reading your terminal's output.",
    'try: theme phosphor',
    'Credentials never go through the model. Ever.',
    'try: find <text>',
    'The model can propose. Only you can approve.',
    'try: budget',
    'Eight action verbs, schema-locked. No free-form code, ever.',
    'try: cowsay hello',
    'A typo like "serach" gets a suggestion, not a wasted model call.',
    'try: ls fields',
    'Deterministic commands work even with the model server offline.',
    'try: read',
    'Your page content never becomes a training example anywhere.',
    'try: open! (confirms a pending cross-origin link)',
    'Every hard block applies whether a click came from you or an approved proposal.',
    'try: origins',
    "The nav lane sees only your typed words, never the page's content.",
    'try: fill 3 with hello',
    "Top-layer rendering means page CSS can't cover the approval card.",
    'try: stats',
    'A quiet extension is a trustworthy one. No telemetry, no accounts.',
  ]);

  // Pure: n can be any integer (a counter, Date.now(), a day-of-year value,
  // even negative) -- always resolves to a valid FORTUNES index. No
  // Math.random anywhere in this file.
  function pickFortuneIndex(n, len) {
    const l = Number.isFinite(len) && len > 0 ? Math.floor(len) : 0;
    if (l === 0) return 0;
    const i = Number.isFinite(n) ? Math.floor(n) : 0;
    return ((i % l) + l) % l;
  }

  function getFortune(n) {
    return FORTUNES[pickFortuneIndex(n, FORTUNES.length)];
  }

  // =====================================================================
  // date helpers (MOTD + stats streak) -- UTC-based so tests are not
  // sensitive to the host machine's local timezone.
  // =====================================================================

  function dayOfYear(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return 1;
    const startOfYear = Date.UTC(d.getUTCFullYear(), 0, 1);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return Math.floor((dayStart - startOfYear) / 86400000) + 1;
  }

  // 'YYYY-MM-DD', UTC calendar day. `input` defaults to now; accepts a Date,
  // a timestamp, or anything `new Date()` accepts, for testability.
  function todayStr(input) {
    const d = input instanceof Date ? input : new Date(input === undefined ? Date.now() : input);
    const safe = Number.isNaN(d.getTime()) ? new Date(0) : d;
    const y = safe.getUTCFullYear();
    const m = String(safe.getUTCMonth() + 1).padStart(2, '0');
    const day = String(safe.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // Pure: exactly one UTC calendar day apart, both well-formed 'YYYY-MM-DD'
  // strings. Anything malformed/missing -> false (fail closed into "not
  // consecutive" -> streak resets rather than silently keeps counting).
  function isConsecutiveDay(prevStr, curStr) {
    if (!prevStr || !curStr) return false;
    const prev = Date.parse(`${prevStr}T00:00:00Z`);
    const cur = Date.parse(`${curStr}T00:00:00Z`);
    if (Number.isNaN(prev) || Number.isNaN(cur)) return false;
    return (cur - prev) === 86400000;
  }

  // ---- MOTD once-per-day gate ----
  // storedDay: whatever storage.local's lflMotdDay currently holds (may be
  // undefined/null/garbage -- treated the same as "never shown"). todayStr:
  // this file's own todayStr() output for "now". Pure boolean.
  function shouldShowMotd(storedDay, today) {
    if (typeof storedDay !== 'string' || !storedDay) return true;
    return storedDay !== today;
  }

  // =====================================================================
  // stats
  // =====================================================================

  const DEFAULT_STATS = Object.freeze({
    totalCommands: 0,
    deterministicHits: 0,
    modelProposals: 0,
    approvals: 0,
    lastDay: null,
    streak: 0,
  });

  // Defensive merge -- storage.local content is never trusted blindly
  // (corrupt/missing/wrong-typed fields all fall back to the default rather
  // than propagating NaN/undefined into arithmetic below).
  function mergeStats(stored) {
    const s = (stored && typeof stored === 'object') ? stored : {};
    return {
      totalCommands: Number.isFinite(s.totalCommands) ? s.totalCommands : 0,
      deterministicHits: Number.isFinite(s.deterministicHits) ? s.deterministicHits : 0,
      modelProposals: Number.isFinite(s.modelProposals) ? s.modelProposals : 0,
      approvals: Number.isFinite(s.approvals) ? s.approvals : 0,
      lastDay: typeof s.lastDay === 'string' ? s.lastDay : null,
      streak: Number.isFinite(s.streak) ? s.streak : 0,
    };
  }

  // Pure counter bump -- fields is a sparse {totalCommands?, deterministicHits?,
  // modelProposals?, approvals?} object; missing fields add 0. Never touches
  // lastDay/streak (that's applyDailyStreak's job, called separately).
  function applyStatsIncrement(stats, fields) {
    const s = mergeStats(stats);
    const f = fields || {};
    return Object.assign({}, s, {
      totalCommands: s.totalCommands + (Number.isFinite(f.totalCommands) ? f.totalCommands : 0),
      deterministicHits: s.deterministicHits + (Number.isFinite(f.deterministicHits) ? f.deterministicHits : 0),
      modelProposals: s.modelProposals + (Number.isFinite(f.modelProposals) ? f.modelProposals : 0),
      approvals: s.approvals + (Number.isFinite(f.approvals) ? f.approvals : 0),
    });
  }

  // Pure daily-streak update. Idempotent within the same day (lastDay ===
  // today -> returns stats unchanged, streak not double-counted), +1 on a
  // consecutive day, resets to 1 on a gap (or on the very first day ever,
  // lastDay === null). Safe to call on every command dispatch -- callers
  // don't need their own once-per-day gate for this (unlike MOTD, which
  // needs shouldShowMotd() because it also decides whether to print a line).
  function applyDailyStreak(stats, today) {
    const s = mergeStats(stats);
    if (s.lastDay === today) return s;
    const streak = (s.lastDay && isConsecutiveDay(s.lastDay, today)) ? s.streak + 1 : 1;
    return Object.assign({}, s, { lastDay: today, streak });
  }

  function percentOf(part, total) {
    if (!total || !Number.isFinite(total) || total <= 0) return 0;
    return Math.round((part / total) * 100);
  }

  // Aligned monospace summary -- the exact substring
  // "actions that never touched the model: N (X%)" is load-bearing (spec
  // wording), kept verbatim.
  function formatStatsSummary(stats) {
    const s = mergeStats(stats);
    const pct = percentOf(s.deterministicHits, s.totalCommands);
    const width = 40;
    const pad = (label) => label + ' '.repeat(Math.max(1, width - label.length));
    return [
      `${pad('total commands:')}${s.totalCommands}`,
      `${pad('model proposals:')}${s.modelProposals}`,
      `${pad('approvals:')}${s.approvals}`,
      `${pad('days used (streak):')}${s.streak}`,
      `${pad('actions that never touched the model:')}${s.deterministicHits} (${pct}%)`,
    ].join('\n');
  }

  // =====================================================================
  // theme
  // =====================================================================

  const THEME_DEFAULT = 'default';
  const THEMES = Object.freeze(['default', 'phosphor', 'amber', 'paper']);

  function isValidTheme(name) {
    return typeof name === 'string' && THEMES.includes(name);
  }

  function themeListText(active) {
    const a = isValidTheme(active) ? active : THEME_DEFAULT;
    return THEMES.map((t) => {
      const marker = t === a ? '* ' : '  ';
      const suffix = t === a ? ' (active)' : '';
      return `${marker}${t}${suffix}`;
    }).join('\n');
  }

  // =====================================================================
  // cowsay
  // =====================================================================

  const COWSAY_DEFAULT_WIDTH = 40;

  // Pure word-wrap: never breaks a word unless the word itself exceeds
  // `width` (in which case it's hard-split into width-sized chunks -- still
  // deterministic, still no data loss). Empty/whitespace-only input -> a
  // single empty line (the bubble still renders, just empty), never an
  // empty array and never a throw.
  function wrapCowText(text, width) {
    const w = Number.isFinite(width) && width > 0 ? Math.floor(width) : COWSAY_DEFAULT_WIDTH;
    const words = String(text === null || text === undefined ? '' : text).trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [''];
    const lines = [];
    let cur = '';
    for (const word of words) {
      if (word.length > w) {
        if (cur) { lines.push(cur); cur = ''; }
        let rest = word;
        while (rest.length > w) {
          lines.push(rest.slice(0, w));
          rest = rest.slice(w);
        }
        cur = rest;
        continue;
      }
      const candidate = cur ? `${cur} ${word}` : word;
      if (candidate.length > w) {
        lines.push(cur);
        cur = word;
      } else {
        cur = candidate;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  // Pure speech-bubble renderer around already-wrapped lines (see
  // wrapCowText). Single line -> classic `< ... >`; multiple lines -> the
  // `/ ... \` / `| ... |` / `\ ... /` box shape.
  function buildCowBubble(lines) {
    const arr = Array.isArray(lines) && lines.length ? lines : [''];
    const width = arr.reduce((m, l) => Math.max(m, String(l).length), 0);
    const top = ` ${'_'.repeat(width + 2)}`;
    const bottom = ` ${'-'.repeat(width + 2)}`;
    const body = arr.map((line, i) => {
      const padded = String(line) + ' '.repeat(width - String(line).length);
      if (arr.length === 1) return `< ${padded} >`;
      if (i === 0) return `/ ${padded} \\`;
      if (i === arr.length - 1) return `\\ ${padded} /`;
      return `| ${padded} |`;
    });
    return [top, ...body, bottom].join('\n');
  }

  const COW_ART = [
    '        \\   ^__^',
    '         \\  (oo)\\_______',
    '            (__)\\       )\\/\\',
    '                ||----w |',
    '                ||     ||',
  ].join('\n');

  function cowsay(text, width) {
    const lines = wrapCowText(text, width || COWSAY_DEFAULT_WIDTH);
    return `${buildCowBubble(lines)}\n${COW_ART}`;
  }

  return {
    // fortune
    FORTUNES, pickFortuneIndex, getFortune,
    // dates / MOTD
    dayOfYear, todayStr, isConsecutiveDay, shouldShowMotd,
    // stats
    DEFAULT_STATS, mergeStats, applyStatsIncrement, applyDailyStreak, percentOf, formatStatsSummary,
    // theme
    THEME_DEFAULT, THEMES, isValidTheme, themeListText,
    // cowsay
    wrapCowText, buildCowBubble, cowsay,
  };
});
