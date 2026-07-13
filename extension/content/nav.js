/**
 * nav.js - M3 `go` navigation verb: the deterministic resolution ladder,
 * arrival check, and the literal-URL/domain guard `go` uses (deliberately
 * separate from guards.js's safeSameOriginHttpUrl(), which is scoped to the
 * SAME-ORIGIN M1/M2 posture for LLM-proposed navigate/click - `go` is a
 * TRUSTED, user-typed command and is allowed to leave the origin by design;
 * see design doc §1's trust split and §2).
 *
 * Pure resolution logic only - no chrome.* calls, no DOM mutation, no
 * location.href assignment. terminal.js owns the actual navigation
 * (location.href=), the approval-card UI, and the SW round trips (TS_*
 * visited-origin checks, NAV_LLM_REQUEST for the nav-lane fallback); this
 * file only decides WHAT destination a `go <thing>` command resolves to and
 * whether an arrived-at origin matches what was expected. That split is
 * what makes the resolution ladder and the arrival check unit-testable
 * under plain Node with fake inputs (tests/m3_go_resolution.test.js,
 * tests/m3_chain_and_arrival.test.js) instead of requiring a real browser.
 *
 * Dual-mode like guards.js: window.LFL.nav in the browser, module.exports
 * under Node.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.LFL = root.LFL || {};
    root.LFL.nav = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- literal URL/domain resolution (design §2 step 1) ----
  //
  // `go en.wikipedia.org` / `go https://x.com/foo` / `go localhost:8080`.
  // Unlike guards.safeSameOriginHttpUrl(), this has NO origin-equality
  // clause - `go` is a trusted, address-bar-equivalent command and may
  // navigate cross-origin. It still hard-rejects non-http(s) schemes
  // (javascript:, file:, data:, chrome:, ...) - that floor is not a
  // same-origin restriction, it's "this extension only ever navigates the
  // page to a real web page", which holds regardless of trust level.
  function resolveLiteralDestination(raw) {
    const s = (raw || '').trim();
    if (!s) return { ok: false, reason: 'empty destination' };

    // A leading `scheme:` (letter, then letters/digits/+/-/.) COULD mean the
    // user supplied an explicit scheme - but a bare `word:1234` with an
    // all-digit remainder and no `//` is far more likely to be a
    // host:port (`localhost:8080`, `example.com:8080`) than someone
    // typing an actual URI scheme - no real scheme is ever purely digits
    // after the colon. `scheme://...` (an authority component present) is
    // always treated as a real explicit scheme, and so is any other
    // `scheme:something-non-numeric` (this is what correctly still catches
    // `javascript:...`/`data:...`/`file:...` and routes them into the
    // non-http(s) rejection below, rather than being mistaken for a bare
    // domain that happens to contain a colon).
    const schemeMatch = s.match(/^([a-z][a-z0-9+.-]*):(.*)$/i);
    let hasScheme = false;
    if (schemeMatch) {
      const rest = schemeMatch[2];
      if (rest.startsWith('//')) hasScheme = true;
      else if (/^\d+(\/.*)?$/.test(rest)) hasScheme = false; // host:port shape
      else hasScheme = true;
    }
    const candidate = hasScheme ? s : `https://${s}`;

    let url;
    try {
      url = new URL(candidate);
    } catch (_e) {
      return { ok: false, reason: `"${raw}" is not a usable URL or domain` };
    }
    if (!/^https?:$/.test(url.protocol)) {
      return { ok: false, reason: `refusing to navigate to a non-http(s) destination: ${url.protocol}` };
    }
    // A bare word with no dot and no path/port very likely isn't a domain at
    // all (e.g. "go the wiki") - reject it here so the ladder correctly
    // falls through to step 2 (alias) / step 3 (nav-lane) instead of
    // "successfully" resolving to https://the-wiki/ and confirming garbage.
    if (!hasScheme && !/\./.test(url.hostname) && url.hostname !== 'localhost') {
      return { ok: false, reason: `"${raw}" does not look like a domain` };
    }
    return { ok: true, url };
  }

  // ---- the ladder itself (design §2) ----
  //
  // opts:
  //   arg          - the text after `go ` (already trimmed)
  //   aliasLookup  - function(name) -> expansion string | null (the alias
  //                  store's getAlias(), so `go wiki` resolves when the user
  //                  has defined `alias wiki = go en.wikipedia.org`)
  //
  // Returns exactly one of:
  //   { ok: true, url, step: 'literal' | 'alias' }   - deterministic hit,
  //     the model was never consulted.
  //   { ok: false, needsNavLane: true }               - steps 1-2 both
  //     missed; caller (terminal.js) must fall back to the nav-lane model
  //     call (§3) with the ORIGINAL typed command text, not just `arg`.
  //   { ok: false, reason }                            - arg was empty /
  //     unusable in a way even the nav-lane fallback has nothing to work
  //     with (currently only the empty-arg case).
  function resolveGoLadder(opts) {
    opts = opts || {};
    const arg = (opts.arg || '').trim();
    if (!arg) return { ok: false, reason: 'usage: go <destination>' };

    // Step 1: literal URL/domain.
    const literal = resolveLiteralDestination(arg);
    if (literal.ok) return { ok: true, url: literal.url, step: 'literal' };

    // Step 2: alias/registry hit. The alias's own expansion is resolved
    // through step 1 only (single level - aliases are not recursively
    // re-walked through the ladder, and per registry.js's setAlias/setMacro
    // an alias can never itself be a macro name or vice versa).
    if (typeof opts.aliasLookup === 'function') {
      const expansion = opts.aliasLookup(arg);
      if (expansion !== null && expansion !== undefined) {
        // An alias may be defined as `alias wiki = go en.wikipedia.org` (the
        // documented form) or as a bare destination (`alias wiki =
        // en.wikipedia.org`) - strip a leading "go " if present either way.
        const dest = expansion.replace(/^go\s+/i, '').trim();
        const aliasResolved = resolveLiteralDestination(dest);
        if (aliasResolved.ok) return { ok: true, url: aliasResolved.url, step: 'alias' };
      }
    }

    // Step 3: nothing deterministic matched - the caller must fall back to
    // the nav-lane model call.
    return { ok: false, needsNavLane: true };
  }

  // ---- arrival check (design §5, queue continuation) ----
  //
  // Fail-closed by construction: any mismatch (including an expectedOrigin
  // that itself failed to parse, which should never happen since it's
  // always derived from a URL this same file already validated) halts
  // rather than proceeds.
  function checkArrival(currentOrigin, expectedOrigin) {
    if (!expectedOrigin) return { ok: true, message: null };
    if (currentOrigin === expectedOrigin) return { ok: true, message: null };
    return {
      ok: false,
      message: `arrived at ${currentOrigin || '(unknown origin)'}, expected ${expectedOrigin} - queue halted`,
    };
  }

  return { resolveLiteralDestination, resolveGoLadder, checkArrival };
});
