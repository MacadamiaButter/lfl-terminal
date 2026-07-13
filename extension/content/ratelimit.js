/**
 * ratelimit.js — M2.3 deterministic per-tab-session rate limiter: caps LLM
 * proposal calls and executed mutating actions per rolling time window.
 * Pure/testable (time is injectable via opts.now — the only place Date.now()
 * is read is as the default), and never model-controlled: the model has no
 * channel into this file at all — it is a safety control, not a quality
 * heuristic.
 *
 * On exceeding a budget, the limiter latches into a "paused" state that
 * every subsequent canCallLlm()/canExecuteAction() reports as blocked until
 * the caller explicitly calls resumeAfterContinue() (wired to a `continue`
 * terminal command in terminal.js). A silent auto-recovery once the rolling
 * window empties out would defeat the point — a burst-pause-immediately-
 * resume-on-its-own loop is not meaningfully different from no limit at all.
 *
 * AUTHORITY, since the M2-independent-verify fix (2026-07-12): the counters
 * and the paused latch this file computes are only trustworthy when they
 * live somewhere that survives a content-script re-injection (top-frame
 * navigation, location.reload()). A per-page `Terminal` instance does NOT
 * survive that — it is destroyed and rebuilt from scratch — so the
 * AUTHORITATIVE state now lives in the background service worker, keyed by
 * tab id and backed by `chrome.storage.session` (see
 * `background/service-worker.js`'s RL_CHECK/RL_RECORD/RL_RESUME/RL_BUDGET
 * message handlers and docs/threat-model.md item #7). This file is the
 * single source of truth for the ALGORITHM either side runs: `terminal.js`
 * no longer holds its own live instance of it (it only reads
 * `DEFAULTS` for optimistic placeholder UI numbers before the first async
 * fetch resolves); the service worker is the only place that now calls
 * `createRateLimiter()` for real, one instance per message, rehydrated from
 * and immediately re-persisted to `chrome.storage.session` via
 * `opts.initialState` / `exportState()` below — so the algorithm itself
 * never diverges between a "content script copy" and a "service worker
 * copy" the way the task explicitly warned against; there is only ever one
 * copy of the logic, imported (via `importScripts`) by the service worker.
 *
 * Dual-mode like guards.js: window.LFL.rateLimiter in the browser (and
 * self.LFL.rateLimiter in the service worker, which is the same `root`
 * branch — service workers have `self` but no CommonJS `module`),
 * module.exports under Node (tests/m2_security.test.js and
 * tests/sw_ratelimit_persistence.test.js load it directly).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.LFL = root.LFL || {};
    root.LFL.rateLimiter = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    llmWindowMs: 60000,
    llmMax: 20,     // <= 20 LLM proposal calls / 60s
    actionWindowMs: 60000,
    actionMax: 10,  // <= 10 EXECUTED mutating actions (approved click/fill/select/navigate) / 60s
  };

  function createRateLimiter(opts) {
    opts = opts || {};
    const now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    const llmWindowMs = opts.llmWindowMs || DEFAULTS.llmWindowMs;
    const llmMax = opts.llmMax || DEFAULTS.llmMax;
    const actionWindowMs = opts.actionWindowMs || DEFAULTS.actionWindowMs;
    const actionMax = opts.actionMax || DEFAULTS.actionMax;

    // opts.initialState lets a caller REHYDRATE a limiter from a previously
    // exportState()'d snapshot instead of starting empty — this is what
    // makes the background service worker's per-tab, chrome.storage.session-
    // backed limiter possible: it builds a fresh createRateLimiter() per
    // message (service workers can be evicted between messages), seeded from
    // whatever was last persisted, so the counters and the paused latch are
    // continuous across that even though the JS object itself is not.
    // Ignored entirely (defaults to the original empty-state behavior) when
    // absent — existing callers (terminal.js's tests, m2_security.test.js)
    // are unaffected.
    const init = (opts.initialState && typeof opts.initialState === 'object') ? opts.initialState : {};
    let llmTimestamps = Array.isArray(init.llmTimestamps) ? init.llmTimestamps.slice() : [];
    let actionTimestamps = Array.isArray(init.actionTimestamps) ? init.actionTimestamps.slice() : [];
    let paused = !!init.paused;
    let pauseReason = typeof init.pauseReason === 'string' ? init.pauseReason : null;

    function prune(arr, windowMs) {
      const cutoff = now() - windowMs;
      while (arr.length && arr[0] < cutoff) arr.shift();
    }

    function canCallLlm() {
      if (paused) return { allow: false, reason: pauseReason, remaining: 0 };
      prune(llmTimestamps, llmWindowMs);
      if (llmTimestamps.length >= llmMax) {
        paused = true;
        pauseReason = `LLM call budget exceeded (${llmMax} per ${Math.round(llmWindowMs / 1000)}s) — type "continue" to resume`;
        return { allow: false, reason: pauseReason, remaining: 0 };
      }
      return { allow: true, reason: null, remaining: llmMax - llmTimestamps.length };
    }

    function recordLlmCall() {
      prune(llmTimestamps, llmWindowMs);
      llmTimestamps.push(now());
    }

    function canExecuteAction() {
      if (paused) return { allow: false, reason: pauseReason, remaining: 0 };
      prune(actionTimestamps, actionWindowMs);
      if (actionTimestamps.length >= actionMax) {
        paused = true;
        pauseReason = `action budget exceeded (${actionMax} per ${Math.round(actionWindowMs / 1000)}s) — type "continue" to resume`;
        return { allow: false, reason: pauseReason, remaining: 0 };
      }
      return { allow: true, reason: null, remaining: actionMax - actionTimestamps.length };
    }

    function recordAction() {
      prune(actionTimestamps, actionWindowMs);
      actionTimestamps.push(now());
    }

    function remainingBudget() {
      prune(llmTimestamps, llmWindowMs);
      prune(actionTimestamps, actionWindowMs);
      return {
        llmRemaining: Math.max(0, llmMax - llmTimestamps.length),
        llmMax,
        actionRemaining: Math.max(0, actionMax - actionTimestamps.length),
        actionMax,
        paused,
        pauseReason,
      };
    }

    function resumeAfterContinue() {
      if (!paused) return { resumed: false, reason: 'not paused' };
      paused = false;
      pauseReason = null;
      return { resumed: true };
    }

    // Serializes the full internal state as plain, JSON-safe data — the
    // counterpart to opts.initialState above. Round-trips exactly: feeding
    // the return value of exportState() back in as another limiter's
    // opts.initialState reconstructs an equivalent limiter. Used by the
    // service worker to persist state to chrome.storage.session after every
    // state-changing call (see background/service-worker.js).
    function exportState() {
      return {
        llmTimestamps: llmTimestamps.slice(),
        actionTimestamps: actionTimestamps.slice(),
        paused,
        pauseReason,
      };
    }

    return { canCallLlm, recordLlmCall, canExecuteAction, recordAction, remainingBudget, resumeAfterContinue, exportState };
  }

  return { createRateLimiter, DEFAULTS };
});
