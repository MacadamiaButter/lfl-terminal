/**
 * registry.js — M3 command registry + alias/macro store + `&&` chain parser.
 *
 * Three separate, composable pieces (plan §11 / design doc §6):
 *
 * 1. createRegistry() — a lightweight, declarative catalogue of
 *    {name, aliases, argSpec, help} entries used to generate `help`/`man`
 *    text and to enumerate the known command surface (see the
 *    registry-cannot-extend-model-vocabulary unit test, which checks that
 *    none of these names ever leak into either LLM lane's response schema
 *    enum). DELIBERATE SCOPE NOTE: this registry does NOT replace
 *    engine.js's existing if/regex dispatch chain for the M1/M2 built-in
 *    verbs — that chain is battery-proven (tests/run_battery.py, 33
 *    commands) and has zero direct unit-test coverage of its own, so
 *    rewriting its actual dispatch logic into a fully data-driven lookup
 *    carries real regression risk with no way for this build pass to
 *    re-verify it (the Playwright battery is a separate agent's job, run
 *    after this build). engine.js instead REGISTERS each existing verb's
 *    name/argSpec/help into a createRegistry() instance purely for
 *    help/man generation and vocabulary enumeration — the dispatch
 *    predicate for each verb stays the original, unmodified regex. New M3
 *    Terminal-level commands (go/alias/unalias/macro/unmacro/origins/dev/
 *    man — see terminal.js) are registered the same way for documentation,
 *    but dispatched via explicit branches in terminal.js (they need
 *    chrome.* / async access that engine.js's synchronous
 *    tryDeterministic() contract does not have).
 *
 * 2. createAliasStore(storageArea) — the ONLY writer of user aliases/macros.
 *    Backed by chrome.storage.local (content scripts may read/write
 *    storage.local directly — unlike storage.session, which stays
 *    service-worker-only per the M2.3 design note this project already
 *    holds itself to; see background/service-worker.js's header comment).
 *    setAlias/setMacro are ONLY ever called from terminal.js's typed
 *    `alias`/`macro` command handlers — no page, model, or remote code path
 *    reaches them; there is no other function anywhere in this file or
 *    engine.js/terminal.js that mutates the backing store. Macro bodies are
 *    validated at WRITE time to reject any segment whose first word is
 *    itself a currently-defined macro name (the depth-1 lock: "a macro may
 *    not reference a macro", plan §13 item 3) — enforced once, at
 *    definition time, rather than by a runtime recursion guard, so a later
 *    `unmacro` of a dependency can't silently resurrect infinite expansion.
 *
 * 3. splitChain(raw, maxSegments) — the quote-aware top-level `&&` splitter
 *    (plan §13 item 2: cap 5, deterministic, user-typed text only). Splits
 *    only on `&&` that is NOT inside a double-quoted string, so
 *    `search "a && b" && open x` yields exactly two segments
 *    (`search "a && b"` and `open x`), not three. A raw command that would
 *    produce MORE than maxSegments after splitting is rejected outright
 *    (ok:false) rather than silently truncated — partially running a chain
 *    the user didn't intend, minus the tail they typed, is worse than
 *    refusing it outright and asking them to retype within the cap.
 *
 * Dual-mode like guards.js/ratelimit.js: window.LFL.registry in the
 * browser, module.exports under Node (this project's tests load it
 * directly — see tests/m3_chain_and_arrival.test.js,
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
      return entries.map((e) => `  ${pad(e.argSpec)}- ${e.help}`).join('\n');
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
  // deterministic verbs plus terminal.js's Terminal-level meta-commands —
  // see engine.js's registration block for the authoritative list). An
  // alias/macro named e.g. `go` or `search` would silently SHADOW a trusted
  // built-in primitive every time it's typed — that's a real footgun (the
  // whole `go` resolution ladder, or the credential-guarded `search` flow,
  // would simply stop being reachable by its own name), not a cosmetic
  // naming clash, so it's rejected at write time rather than left as a
  // "don't do that" convention.
  const RESERVED_NAMES = new Set([
    'go', 'alias', 'unalias', 'macro', 'unmacro', 'origins', 'dev', 'man',
    'search', 'open', 'open!', 'back', 'scroll', 'extract', 'log', 'budget',
    'continue', 'help', 'clear', 'ask',
  ]);

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
      if (!validName(name)) return { ok: false, reason: `invalid alias name "${name}" — letters/digits/-/_ only, must start with a letter` };
      if (RESERVED_NAMES.has((name || '').toLowerCase())) return { ok: false, reason: `"${name}" is a built-in command — cannot be shadowed by an alias` };
      if (!expansion || !expansion.trim()) return { ok: false, reason: 'alias expansion cannot be empty' };
      if (macros[name]) return { ok: false, reason: `"${name}" is already a macro name — unmacro it first` };
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
      if (!validName(name)) return { ok: false, reason: `invalid macro name "${name}" — letters/digits/-/_ only, must start with a letter` };
      if (RESERVED_NAMES.has((name || '').toLowerCase())) return { ok: false, reason: `"${name}" is a built-in command — cannot be shadowed by a macro` };
      if (!chainText || !chainText.trim()) return { ok: false, reason: 'macro body cannot be empty' };
      if (aliases[name]) return { ok: false, reason: `"${name}" is already an alias name — unalias it first` };
      const split = splitChain(chainText, 5);
      if (!split.ok) return { ok: false, reason: split.reason };
      // Depth-1 lock: no segment's leading command word may itself be a
      // (currently defined) macro name — a macro may only ever expand into
      // ordinary commands/aliases, never into another macro invocation.
      for (const seg of split.segments) {
        const head = firstWord(seg).toLowerCase();
        if (Object.prototype.hasOwnProperty.call(macros, head) || head === name) {
          return { ok: false, reason: `macro "${name}" cannot reference macro "${head}" — macros may not be nested (depth-1 lock)` };
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
      return { ok: false, reason: `too many chained commands (${trimmed.length}, max ${cap}) — chain rejected, nothing executed` };
    }
    return { ok: true, segments: trimmed };
  }

  // ---- alias expansion (single command, args appended) ----
  // Given one segment's raw text, if its leading word is a defined alias,
  // replace that leading word with the alias's stored expansion text and
  // append whatever args followed it in the original segment. Not
  // recursive — an alias's own expansion is used verbatim (it may itself
  // start with another alias's name, but this function only ever performs
  // ONE substitution per call; callers that want the substituted text
  // dispatched normally send it through the ordinary command path once,
  // exactly like directly-typed text, rather than looping expandAlias
  // again — this keeps aliases from becoming a de facto macro/recursion
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
  // no trailing args — macros take no arguments, only named && chains) is a
  // defined macro name, replace the raw input with the macro's stored chain
  // text. Only ever applied once, before chain splitting — a macro's own
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

  return { createRegistry, createAliasStore, splitChain, expandAlias, expandMacro };
});
