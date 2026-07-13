/**
 * registry.js - M3 command registry + alias/macro store + `&&` chain parser.
 *
 * Three separate, composable pieces (plan §11 / design doc §6):
 *
 * 1. createRegistry() - a lightweight, declarative catalogue of
 *    {name, aliases, argSpec, help} entries used to generate `help`/`man`
 *    text and to enumerate the known command surface (see the
 *    registry-cannot-extend-model-vocabulary unit test, which checks that
 *    none of these names ever leak into either LLM lane's response schema
 *    enum). DELIBERATE SCOPE NOTE: this registry does NOT replace
 *    engine.js's existing if/regex dispatch chain for the M1/M2 built-in
 *    verbs - that chain is battery-proven (tests/run_battery.py, 33
 *    commands) and has zero direct unit-test coverage of its own, so
 *    rewriting its actual dispatch logic into a fully data-driven lookup
 *    carries real regression risk with no way for this build pass to
 *    re-verify it (the Playwright battery is a separate agent's job, run
 *    after this build). engine.js instead REGISTERS each existing verb's
 *    name/argSpec/help into a createRegistry() instance purely for
 *    help/man generation and vocabulary enumeration - the dispatch
 *    predicate for each verb stays the original, unmodified regex. New M3
 *    Terminal-level commands (go/alias/unalias/macro/unmacro/origins/dev/
 *    man - see terminal.js) are registered the same way for documentation,
 *    but dispatched via explicit branches in terminal.js (they need
 *    chrome.* / async access that engine.js's synchronous
 *    tryDeterministic() contract does not have).
 *
 * 2. createAliasStore(storageArea) - the ONLY writer of user aliases/macros.
 *    Backed by chrome.storage.local (content scripts may read/write
 *    storage.local directly - unlike storage.session, which stays
 *    service-worker-only per the M2.3 design note this project already
 *    holds itself to; see background/service-worker.js's header comment).
 *    setAlias/setMacro are ONLY ever called from terminal.js's typed
 *    `alias`/`macro` command handlers - no page, model, or remote code path
 *    reaches them; there is no other function anywhere in this file or
 *    engine.js/terminal.js that mutates the backing store. Macro bodies are
 *    validated at WRITE time to reject any segment whose first word is
 *    itself a currently-defined macro name (the depth-1 lock: "a macro may
 *    not reference a macro", plan §13 item 3) - enforced once, at
 *    definition time, rather than by a runtime recursion guard, so a later
 *    `unmacro` of a dependency can't silently resurrect infinite expansion.
 *
 * 3. splitChain(raw, maxSegments) - the quote-aware top-level `&&` splitter
 *    (plan §13 item 2: cap 5, deterministic, user-typed text only). Splits
 *    only on `&&` that is NOT inside a double-quoted string, so
 *    `search "a && b" && open x` yields exactly two segments
 *    (`search "a && b"` and `open x`), not three. A raw command that would
 *    produce MORE than maxSegments after splitting is rejected outright
 *    (ok:false) rather than silently truncated - partially running a chain
 *    the user didn't intend, minus the tail they typed, is worse than
 *    refusing it outright and asking them to retype within the cap.
 *
 * Dual-mode like guards.js/ratelimit.js: window.LFL.registry in the
 * browser, module.exports under Node (this project's tests load it
 * directly - see tests/m3_chain_and_arrival.test.js,
 * tests/m3_alias_macro.test.js).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.LFL = root.LFL || {};
    root.LFL.registry = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- 1. declarative registry (help/man + vocabulary enumeration only) ----

  function createRegistry() {
    const entries = [];

    function register(entry) {
      if (!entry || !entry.name) throw new Error('registry.register: entry needs a name');
      entries.push({
        name: entry.name,
        aliases: entry.aliases || [],
        argSpec: entry.argSpec || entry.name,
        help: entry.help || '',
        // `hidden` (added for the `sl` easter egg): excludes this entry
        // from helpText() ONLY - get()/names()/manText() still see it
        // exactly like every other entry, so `man <name>` keeps working
        // and vocabulary enumeration (did-you-mean, the registry-cannot-
        // extend-model-vocabulary check) is unaffected. Defaults false, so
        // every pre-existing register() call (none of which pass this
        // field) is completely unchanged - this is a strict, additive
        // widening of the entry shape, not a behavior change for anyone
        // who doesn't opt in.
        hidden: !!entry.hidden,
      });
    }

    function get(name) {
      return entries.find((e) => e.name === name || e.aliases.includes(name)) || null;
    }

    function names() {
      const out = [];
      entries.forEach((e) => { out.push(e.name); e.aliases.forEach((a) => out.push(a)); });
      return out;
    }

    function helpText() {
      const pad = (s) => (s.length >= 34 ? s + ' ' : s + ' '.repeat(34 - s.length));
      return entries.filter((e) => !e.hidden).map((e) => `  ${pad(e.argSpec)}- ${e.help}`).join('\n');
    }

    function manText(name) {
      const e = get(name);
      if (!e) return `no such command: ${name}`;
      const aliasTxt = e.aliases.length ? ` (aliases: ${e.aliases.join(', ')})` : '';
      return `${e.name}${aliasTxt}\n  usage: ${e.argSpec}\n  ${e.help}`;
    }

    return { register, get, names, helpText, manText, entries };
  }

  // ---- 2. alias/macro store ----

  const ALIAS_KEY = 'lflAliases';
  const MACRO_KEY = 'lflMacros';
  const NAME_RE = /^[a-z][a-z0-9_-]*$/i;

  // Reserved: the fixed built-in verb/command surface (engine.js's
  // deterministic verbs plus terminal.js's Terminal-level meta-commands -
  // see engine.js's registration block for the authoritative list). An
  // alias/macro named e.g. `go` or `search` would silently SHADOW a trusted
  // built-in primitive every time it's typed - that's a real footgun (the
  // whole `go` resolution ladder, or the credential-guarded `search` flow,
  // would simply stop being reachable by its own name), not a cosmetic
  // naming clash, so it's rejected at write time rather than left as a
  // "don't do that" convention.
  const RESERVED_NAMES = new Set([
    'go', 'alias', 'unalias', 'macro', 'unmacro', 'origins', 'dev', 'man',
    'search', 'open', 'open!', 'back', 'scroll', 'extract', 'log', 'budget',
    'continue', 'help', 'clear', 'ask',
    // M4a friction-trio built-ins (extension/content/engine.js) - same
    // shadowing footgun the original set was created to close: an
    // `alias ls = ...`/`macro click = ...` would silently make the ls-listing
    // tools (and their guard-inheriting click/fill-by-index verbs)
    // unreachable by their own names.
    'ls', 'read', 'find', 'here', 'click', 'fill',
    // funpack v1 (extension/content/funpack.js, dispatched by terminal.js) -
    // same shadowing footgun as above.
    'fortune', 'stats', 'theme', 'cowsay',
    // M4b fun pack v2 (extension/content/games.js, dispatched by
    // terminal.js) - same shadowing footgun as above.
    'snake', '2048', 'games',
    // `sl` easter egg (same file, same dispatch path) - same shadowing
    // footgun; also keeps it out of setAlias/setMacro's NAME_RE-valid
    // namespace as a normal by-product of being reserved.
    'sl',
  ]);

  // M4b (design doc §3/§5): games are never allowed to run as part of a
  // macro body, checked at WRITE time here (in addition to the runtime
  // "fromChain" dispatch-context check terminal.js's _handleGameCommand()
  // performs for the chain/alias-indirection cases this narrower,
  // direct-name write-time check cannot see - see that method's own
  // comment). Deliberately a separate, narrower set from RESERVED_NAMES:
  // RESERVED_NAMES governs what a macro/alias may be NAMED, and reusing it
  // here would wrongly reject perfectly normal macros like
  // `macro x = go foo && ls` (both `go` and `ls` are themselves reserved
  // names, but are exactly the kind of built-in verb macros exist to
  // chain together).
  const GAME_NAMES = new Set(['snake', '2048', 'games', 'sl']);

  // M4b verify fix (MED-2): the funpack-v1 quartet gets the same
  // macro-body write-time block as the games - previously
  // `macro morning = go example.com && fortune` was accepted at write time
  // and the `fortune` segment then silently fell through to the page-lane
  // model at run time (burning an LLM budget slot on a command that is
  // supposed to be free and local). See terminal.js's FUNPACK_NAMES for
  // the matching dispatch-time half of this lock. Scope is deliberately
  // ONLY the four names funpack v1 added - the posture of pre-existing
  // meta-commands (budget/dev/origins/continue/...) in macro bodies is
  // unchanged.
  const FUNPACK_NAMES = new Set(['fortune', 'stats', 'theme', 'cowsay']);

  function firstWord(s) {
    const m = (s || '').trim().match(/^(\S+)/);
    return m ? m[1] : '';
  }

  function createAliasStore(storageArea) {
    let aliases = {};
    let macros = {};
    let loaded = false;

    function load() {
      if (!storageArea || typeof storageArea.get !== 'function') {
        loaded = true;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        try {
          storageArea.get([ALIAS_KEY, MACRO_KEY], (res) => {
            if (res && res[ALIAS_KEY] && typeof res[ALIAS_KEY] === 'object') aliases = res[ALIAS_KEY];
            if (res && res[MACRO_KEY] && typeof res[MACRO_KEY] === 'object') macros = res[MACRO_KEY];
            loaded = true;
            resolve();
          });
        } catch (_e) {
          loaded = true;
          resolve();
        }
      });
    }

    function persist() {
      if (!storageArea || typeof storageArea.set !== 'function') return;
      try { storageArea.set({ [ALIAS_KEY]: aliases, [MACRO_KEY]: macros }); } catch (_e) { /* best-effort */ }
    }

    function validName(name) { return NAME_RE.test(name || ''); }

    // ---- aliases: single-command textual expansion, args appended by the caller ----

    function setAlias(name, expansion) {
      if (!validName(name)) return { ok: false, reason: `invalid alias name "${name}" - letters/digits/-/_ only, must start with a letter` };
      if (RESERVED_NAMES.has((name || '').toLowerCase())) return { ok: false, reason: `"${name}" is a built-in command - cannot be shadowed by an alias` };
      if (!expansion || !expansion.trim()) return { ok: false, reason: 'alias expansion cannot be empty' };
      if (macros[name]) return { ok: false, reason: `"${name}" is already a macro name - unmacro it first` };
      aliases[name] = expansion.trim();
      persist();
      return { ok: true };
    }

    function unsetAlias(name) {
      if (!aliases[name]) return { ok: false, reason: `no such alias: ${name}` };
      delete aliases[name];
      persist();
      return { ok: true };
    }

    function getAlias(name) {
      return Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : null;
    }

    function listAliases() { return Object.assign({}, aliases); }

    // ---- macros: named && chains, depth-1 (no macro may reference a macro) ----

    function setMacro(name, chainText) {
      if (!validName(name)) return { ok: false, reason: `invalid macro name "${name}" - letters/digits/-/_ only, must start with a letter` };
      if (RESERVED_NAMES.has((name || '').toLowerCase())) return { ok: false, reason: `"${name}" is a built-in command - cannot be shadowed by a macro` };
      if (!chainText || !chainText.trim()) return { ok: false, reason: 'macro body cannot be empty' };
      if (aliases[name]) return { ok: false, reason: `"${name}" is already an alias name - unalias it first` };
      const split = splitChain(chainText, 5);
      if (!split.ok) return { ok: false, reason: split.reason };
      // Depth-1 lock: no segment's leading command word may itself be a
      // (currently defined) macro name - a macro may only ever expand into
      // ordinary commands/aliases, never into another macro invocation.
      for (const seg of split.segments) {
        const head = firstWord(seg).toLowerCase();
        if (Object.prototype.hasOwnProperty.call(macros, head) || head === name) {
          return { ok: false, reason: `macro "${name}" cannot reference macro "${head}" - macros may not be nested (depth-1 lock)` };
        }
        // M4b (design §3/§5): a game command may never appear as a macro
        // segment's own leading word - rejected here, at definition time,
        // rather than only when the macro is later invoked.
        if (GAME_NAMES.has(head)) {
          return { ok: false, reason: `macro "${name}" cannot include "${head}" - games cannot run inside a macro` };
        }
        // M4b verify fix (MED-2): same for the funpack quartet - see
        // FUNPACK_NAMES's own comment above.
        if (FUNPACK_NAMES.has(head)) {
          return { ok: false, reason: `macro "${name}" cannot include "${head}" - "${head}" does not run in chains or macros` };
        }
      }
      macros[name] = chainText.trim();
      persist();
      return { ok: true };
    }

    function unsetMacro(name) {
      if (!macros[name]) return { ok: false, reason: `no such macro: ${name}` };
      delete macros[name];
      persist();
      return { ok: true };
    }

    function getMacro(name) {
      return Object.prototype.hasOwnProperty.call(macros, name) ? macros[name] : null;
    }

    function listMacros() { return Object.assign({}, macros); }

    return {
      load,
      isLoaded: () => loaded,
      setAlias, unsetAlias, getAlias, listAliases,
      setMacro, unsetMacro, getMacro, listMacros,
    };
  }

  // ---- 3. quote-aware top-level `&&` splitter ----

  function splitChain(raw, maxSegments) {
    const cap = maxSegments || 5;
    const s = typeof raw === 'string' ? raw : '';
    const segments = [];
    let cur = '';
    let inQuotes = false;
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
        cur += ch;
        i += 1;
        continue;
      }
      if (!inQuotes && ch === '&' && s[i + 1] === '&') {
        segments.push(cur);
        cur = '';
        i += 2;
        continue;
      }
      cur += ch;
      i += 1;
    }
    segments.push(cur);

    const trimmed = segments.map((seg) => seg.trim()).filter((seg) => seg.length > 0);

    if (trimmed.length === 0) return { ok: true, segments: [] };
    if (trimmed.length > cap) {
      return { ok: false, reason: `too many chained commands (${trimmed.length}, max ${cap}) - chain rejected, nothing executed` };
    }
    return { ok: true, segments: trimmed };
  }

  // ---- alias expansion (single command, args appended) ----
  // Given one segment's raw text, if its leading word is a defined alias,
  // replace that leading word with the alias's stored expansion text and
  // append whatever args followed it in the original segment. Not
  // recursive - an alias's own expansion is used verbatim (it may itself
  // start with another alias's name, but this function only ever performs
  // ONE substitution per call; callers that want the substituted text
  // dispatched normally send it through the ordinary command path once,
  // exactly like directly-typed text, rather than looping expandAlias
  // again - this keeps aliases from becoming a de facto macro/recursion
  // mechanism of their own).
  function expandAlias(segment, aliasStore) {
    const head = firstWord(segment);
    if (!head) return segment;
    const expansion = aliasStore.getAlias(head);
    if (expansion === null) return segment;
    const rest = segment.slice(head.length);
    return (expansion + rest).trim();
  }

  // Macro expansion (depth-1): if the WHOLE raw input's leading word (with
  // no trailing args - macros take no arguments, only named && chains) is a
  // defined macro name, replace the raw input with the macro's stored chain
  // text. Only ever applied once, before chain splitting - a macro's own
  // stored body is guaranteed (by setMacro's write-time lock) to contain no
  // further macro invocations, so there is nothing further to expand.
  function expandMacro(raw, aliasStore) {
    const trimmedRaw = (raw || '').trim();
    const head = firstWord(trimmedRaw);
    if (!head) return raw;
    const body = aliasStore.getMacro(head);
    if (body === null) return raw;
    return body;
  }

  // ---- 4. did-you-mean (M4a friction trio, tool 3) ----
  //
  // Pure, DOM-free - used by terminal.js's `_dispatchSegment()` between "no
  // deterministic command matched" and "fall through to the LLM", so a typo
  // like `serach wikipedia` gets a suggestion instead of spending an LLM call
  // (and a slice of the LLM-call rate-limit budget) on a command the human
  // almost certainly meant to be deterministic. Deliberately narrow: this
  // NARROWS the model surface (fewer accidental LLM calls for near-miss
  // typos), it does not widen it - nothing here can route text TO the model
  // that wouldn't already have gone there; it can only intercept some of what
  // would have.
  //
  // Damerau-Levenshtein (adjacent-transposition-aware edit distance) rather
  // than plain Levenshtein specifically because the canonical typo shape this
  // exists for - two adjacent letters swapped ("serach" for "search",
  // "operatinos" for... well, not a real command, but the shape generalizes)
  // - costs 1 under Damerau-Levenshtein and 2 under plain Levenshtein; the
  // distance<=2 threshold below is calibrated assuming transpositions are
  // cheap, which only holds for the Damerau variant.
  function damerauLevenshtein(a, b) {
    a = String(a || '');
    b = String(b || '');
    const al = a.length;
    const bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    // (al+2) x (bl+2) table, the standard Damerau-Levenshtein construction
    // (optimal string alignment would be simpler but doesn't allow a
    // transposed pair to be edited again - the full DL table costs a little
    // more code for a correctness edge case that doesn't matter at the
    // string lengths command names ever reach, but is cheap to just do
    // right).
    const maxDist = al + bl;
    const d = [];
    for (let i = 0; i <= al + 1; i++) { d.push(new Array(bl + 2).fill(0)); }
    d[0][0] = maxDist;
    for (let i = 0; i <= al; i++) { d[i + 1][0] = maxDist; d[i + 1][1] = i; }
    for (let j = 0; j <= bl; j++) { d[0][j + 1] = maxDist; d[1][j + 1] = j; }
    const lastRow = {};
    for (let i = 1; i <= al; i++) {
      let lastMatchCol = 0;
      const ai = a[i - 1];
      for (let j = 1; j <= bl; j++) {
        const bj = b[j - 1];
        const i1 = lastRow[bj] || 0;
        const j1 = lastMatchCol;
        let cost = 1;
        if (ai === bj) { cost = 0; lastMatchCol = j; }
        const del = d[i][j + 1] + 1;
        const ins = d[i + 1][j] + 1;
        const sub = d[i][j] + cost;
        const trans = d[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1);
        d[i + 1][j + 1] = Math.min(del, ins, sub, trans);
      }
      lastRow[ai] = i;
    }
    return d[al + 1][bl + 1];
  }

  const DID_YOU_MEAN_MIN_TOKEN_LEN = 3;
  const DID_YOU_MEAN_MAX_DISTANCE = 2;
  const DID_YOU_MEAN_MAX_CANDIDATES = 3;

  // rawInput: the full segment text that already failed every deterministic
  // match (caller's responsibility - this function does not re-check that).
  // candidateNames: the registry's known verb/alias-target names (typically
  // LFL.commandRegistry.names()) - pure array of strings in, pure array of
  // strings (verb names, closest first) out. Never mutates or reads any
  // global state.
  function didYouMean(rawInput, candidateNames) {
    const trimmed = (rawInput || '').trim();
    if (!trimmed) return [];
    // "ask ..." is the unambiguous, explicit model path - never second-guess
    // it. A bare integer is handled entirely inside engine.js's tryDeterministic
    // (it always returns non-null, action-or-gentle-error), so it never
    // reaches this function in practice, but the guard is kept here too so
    // this pure function's own contract holds regardless of caller wiring.
    if (/^ask(\s|$)/i.test(trimmed)) return [];
    if (/^\d+$/.test(trimmed)) return [];
    const token = (trimmed.split(/\s+/)[0] || '').toLowerCase();
    if (token.length < DID_YOU_MEAN_MIN_TOKEN_LEN) return [];
    const seen = new Set();
    const scored = [];
    for (const name of candidateNames || []) {
      const lower = String(name || '').toLowerCase();
      if (!lower || lower === token || seen.has(lower)) continue;
      seen.add(lower);
      const dist = damerauLevenshtein(token, lower);
      if (dist >= 1 && dist <= DID_YOU_MEAN_MAX_DISTANCE) {
        scored.push({ name: lower, dist });
      }
    }
    scored.sort((x, y) => (x.dist - y.dist) || x.name.localeCompare(y.name));
    return scored.slice(0, DID_YOU_MEAN_MAX_CANDIDATES).map((s) => s.name);
  }

  return {
    createRegistry, createAliasStore, splitChain, expandAlias, expandMacro,
    damerauLevenshtein, didYouMean,
  };
});
