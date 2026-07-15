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
  // scripts v1 (2026-07-14): storage key for the script store, alongside
  // aliases/macros - see createAliasStore()'s scripts section below.
  const SCRIPT_KEY = 'lflScripts';
  const NAME_RE = /^[a-z][a-z0-9_-]*$/i;
  // scripts v1 (design doc §9 sign-off #2): owner-approved step cap.
  const SCRIPT_MAX_STEPS = 20;

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
    // auto-open-on-home (2026-07-14): the `autoopen` toggle command - reserved
    // so an alias/macro can't shadow it, same footgun as the rest of this set.
    'autoopen',
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
    // M4c (extension/content/engine.js, design doc
    // LFL-TERMINAL-HIGHLIGHT-DESIGN.md) - `highlight` is an ordinary
    // page-driving built-in like the M4a six above, not a game/funpack
    // entry: same shadowing footgun (`alias highlight = ...` would silently
    // make the persistent-match-layer verb unreachable by its own name), so
    // it's reserved the same way, but it is NOT added to GAME_NAMES/
    // FUNPACK_NAMES below - unlike games/funpack, `highlight` has no
    // chrome.storage.local/game-loop entanglement and is fully chain- and
    // macro-eligible.
    'highlight',
    // `matches` (2026-07-14): the highlight/find match-listing verb - reserved
    // for the same shadowing reason.
    'matches',
    // scripts v1 (2026-07-14, LFL-TERMINAL-SCRIPTS-DESIGN.md): `script`
    // (define/list/show/remove) and `run` (invoke) - same shadowing footgun
    // as every other built-in. `pause` is the in-script hand-back primitive
    // (§1 of the design doc) - reserved so it can never be shadowed either,
    // even though (unlike script/run) it is dispatched as an ordinary chain
    // segment rather than through a dedicated `_handle*Command` - see
    // terminal.js's `_handlePauseSegment()`.
    'script', 'run', 'pause',
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

  // scripts v1 (design doc §3): scripts are invoked ONLY via `run <name>`,
  // never by bare name - unlike an alias/macro, a script name therefore does
  // NOT need to shadow-check against the full built-in verb surface (a
  // script MAY be named `search`; `run search` and the literal `search`
  // verb are simply different things reached different ways). The three
  // names of the script SYSTEM ITSELF are the one narrow exception - a
  // script named `run`/`script`/`pause` would be self-referentially
  // confusing (`run run`, `script rm script`) even though it poses no real
  // shadowing risk, so those three are still refused. See setScript()/
  // checkNameAvailable() below, which check THIS set, not RESERVED_NAMES.
  const SCRIPT_SELF_NAMES = new Set(['script', 'run', 'pause']);

  function firstWord(s) {
    const m = (s || '').trim().match(/^(\S+)/);
    return m ? m[1] : '';
  }

  function createAliasStore(storageArea) {
    let aliases = {};
    let macros = {};
    // scripts v1: { [name]: { body: string, arity: number, usesRest: bool,
    // stepCount: number } } - the ONLY writer is setScript() below, same
    // single-write-path posture as aliases/macros (see this file's header).
    let scripts = {};
    let loaded = false;

    function load() {
      if (!storageArea || typeof storageArea.get !== 'function') {
        loaded = true;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        try {
          storageArea.get([ALIAS_KEY, MACRO_KEY, SCRIPT_KEY], (res) => {
            if (res && res[ALIAS_KEY] && typeof res[ALIAS_KEY] === 'object') aliases = res[ALIAS_KEY];
            if (res && res[MACRO_KEY] && typeof res[MACRO_KEY] === 'object') macros = res[MACRO_KEY];
            if (res && res[SCRIPT_KEY] && typeof res[SCRIPT_KEY] === 'object') scripts = res[SCRIPT_KEY];
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
      try { storageArea.set({ [ALIAS_KEY]: aliases, [MACRO_KEY]: macros, [SCRIPT_KEY]: scripts }); } catch (_e) { /* best-effort */ }
    }

    // scripts v1: is `name` available AS A SCRIPT NAME? Only the script
    // system's own three self-referential names are refused here (design
    // doc §3/SCRIPT_SELF_NAMES's own comment) - NOT the full built-in verb
    // surface, since a script is reached only via `run <name>` and so does
    // not shadow anything by sharing a word with a built-in verb. Cross-
    // checked against aliases/macros too ("one name, one thing" - §9 sign-
    // off #8). Exposed so terminal.js can reject an invalid `script new
    // <name>` BEFORE making the human type an entire multi-line body for
    // nothing; setScript() re-runs the same checks at save time.
    function checkNameAvailable(name) {
      if (!validName(name)) return { ok: false, reason: `invalid name "${name}" - letters/digits/-/_ only, must start with a letter` };
      const lower = (name || '').toLowerCase();
      if (SCRIPT_SELF_NAMES.has(lower)) return { ok: false, reason: `"${name}" is a script-system command - cannot be used as a script name` };
      if (Object.prototype.hasOwnProperty.call(aliases, name)) return { ok: false, reason: `"${name}" is already an alias name - unalias it first` };
      if (Object.prototype.hasOwnProperty.call(macros, name)) return { ok: false, reason: `"${name}" is already a macro name - unmacro it first` };
      if (Object.prototype.hasOwnProperty.call(scripts, name)) return { ok: false, reason: `"${name}" is already a script name - remove it first (script rm ${name})` };
      return { ok: true };
    }

    function validName(name) { return NAME_RE.test(name || ''); }

    // ---- aliases: single-command textual expansion, args appended by the caller ----

    function setAlias(name, expansion) {
      if (!validName(name)) return { ok: false, reason: `invalid alias name "${name}" - letters/digits/-/_ only, must start with a letter` };
      if (RESERVED_NAMES.has((name || '').toLowerCase())) return { ok: false, reason: `"${name}" is a built-in command - cannot be shadowed by an alias` };
      if (!expansion || !expansion.trim()) return { ok: false, reason: 'alias expansion cannot be empty' };
      if (macros[name]) return { ok: false, reason: `"${name}" is already a macro name - unmacro it first` };
      // scripts v1 (design doc §9 sign-off #8): one flat user namespace.
      if (scripts[name]) return { ok: false, reason: `"${name}" is already a script name - remove it first (script rm ${name})` };
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
      // scripts v1 (design doc §9 sign-off #8): one flat user namespace.
      if (scripts[name]) return { ok: false, reason: `"${name}" is already a script name - remove it first (script rm ${name})` };
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

    // ---- scripts v1 (2026-07-14, LFL-TERMINAL-SCRIPTS-DESIGN.md) ----
    //
    // A script is a macro grown up: a named, multi-line, parameterized body,
    // capped at SCRIPT_MAX_STEPS (vs a macro's 5-segment single-line `&&`
    // chain). setScript() is the ONLY writer, same single-write-path lock as
    // setAlias/setMacro. All body validation (step cap, index-verb rejection,
    // games/funpack/nested-run locks, pause syntax) lives in the pure
    // parseScriptBody() below (section on scripts: parse/substitute/
    // tokenize) - re-run here at write time AND again by terminal.js's `run`
    // handler at invocation time (defense in depth: storage could in
    // principle be hand-edited or corrupted between writes, e.g. by a future
    // P2 file import - re-validating on every run keeps that path's trust
    // boundary independent of what write-time already checked).
    function setScript(name, body) {
      if (!validName(name)) return { ok: false, reason: `invalid script name "${name}" - letters/digits/-/_ only, must start with a letter` };
      // Only the script system's own three self-referential names are
      // refused here, NOT the full built-in verb surface - see
      // SCRIPT_SELF_NAMES's own comment (design doc §3): a script is reached
      // only via `run <name>`, so it does not shadow anything by sharing a
      // word with an ordinary verb like `search`.
      if (SCRIPT_SELF_NAMES.has((name || '').toLowerCase())) return { ok: false, reason: `"${name}" is a script-system command - cannot be used as a script name` };
      // one flat user namespace (design doc §9 sign-off #8) - a script may
      // not collide with an existing alias or macro name, symmetric with the
      // scripts[name] checks setAlias/setMacro perform above.
      if (aliases[name]) return { ok: false, reason: `"${name}" is already an alias name - unalias it first` };
      if (macros[name]) return { ok: false, reason: `"${name}" is already a macro name - unmacro it first` };
      // scripts v1 P2 fix (2026-07-14, portability build): setScript() must
      // reject an EXISTING script of the same name too, not just cross-type
      // alias/macro collisions - matching what checkNameAvailable() already
      // promises (its own comment above says exactly this: "cross-checked
      // against aliases/macros too... setScript() re-runs the same checks at
      // save time"). The hand-typed `script new <name>` UI flow never
      // exercised this gap because terminal.js calls checkNameAvailable()
      // BEFORE capturing a body, which already blocks re-using a taken
      // script name - but a caller that writes straight to setScript()
      // (scripts v1 P2's `script import`, in particular - an untrusted
      // file's script MUST NOT silently overwrite an existing script of the
      // same name any more than it may silently overwrite an alias/macro)
      // hit exactly this hole. Redefining your OWN script by name is still
      // possible the same way an alias/macro already requires:
      // `script rm <name>` first, then `script new <name>` again.
      if (scripts[name]) return { ok: false, reason: `"${name}" is already a script name - remove it first (script rm ${name})` };
      const parsed = parseScriptBody(body, { maxSteps: SCRIPT_MAX_STEPS });
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      scripts[name] = {
        body: parsed.steps.join('\n'),
        arity: parsed.arity,
        usesRest: parsed.usesRest,
        stepCount: parsed.stepCount,
      };
      persist();
      return { ok: true, stepCount: parsed.stepCount, arity: parsed.arity };
    }

    function unsetScript(name) {
      if (!scripts[name]) return { ok: false, reason: `no such script: ${name}` };
      delete scripts[name];
      persist();
      return { ok: true };
    }

    function getScript(name) {
      return Object.prototype.hasOwnProperty.call(scripts, name) ? scripts[name] : null;
    }

    function listScripts() { return Object.assign({}, scripts); }

    return {
      load,
      isLoaded: () => loaded,
      checkNameAvailable,
      setAlias, unsetAlias, getAlias, listAliases,
      setMacro, unsetMacro, getMacro, listMacros,
      setScript, unsetScript, getScript, listScripts,
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

  // ---- scripts v1 (2026-07-14, LFL-TERMINAL-SCRIPTS-DESIGN.md): parse / substitute / tokenize ----
  //
  // The governing constraint (design doc §1): "a saved script may only ever
  // contain steps a human could approve one at a time - replay must never
  // widen the trust boundary." click[N]/fill[N]/select[N] and the M4a
  // `open <N>`/bare-number shortcuts are bound to ONE axtree snapshot
  // (executor.js's resolve(elementMap, action.element)) - replaying a stored
  // index against a since-reflowed page would silently authorize whatever
  // element now happens to sit at that index, which is exactly the
  // widening the constraint forbids. `fill <label> with ...` and
  // `open <link text>` are NOT index-bound (resolved fresh against the live
  // page every run, same trust class as `search`/`go`), so they ARE allowed.
  //
  // INDEX_VERB_WORDS: leading words that are ALWAYS index-addressed when
  // typed literally. `select` has no dedicated typed verb today (it only
  // ever arrives as an LLM-executor action, gated by the ordinary approval
  // card) - kept here anyway, matching the design doc's §1 wording, so a
  // future typed `select <N>` verb is refused by a script body for free
  // rather than silently falling through this list.
  const INDEX_VERB_WORDS = new Set(['click', 'select']);

  // `fill` and `open` (M4a) each have both an index-addressed numeric form
  // (`fill <N> with ...`, `open <N>`) and a safe, resolved-fresh form
  // (`fill <label> with ...`, `open <link text>`) - distinguished by
  // inspecting the first argument's shape, not by leading word alone.
  function stepIsIndexAddressed(stepText) {
    const trimmed = (stepText || '').trim();
    if (/^\d+$/.test(trimmed)) return { blocked: true, why: 'a bare number (the M4a ls-index shortcut)' };
    const head = firstWord(trimmed).toLowerCase();
    if (INDEX_VERB_WORDS.has(head)) {
      return { blocked: true, why: `"${head}" always addresses a page element by its ls-listing index` };
    }
    if (head === 'fill' || head === 'open') {
      const m = trimmed.match(new RegExp('^' + head + '\\s+(\\S+)', 'i'));
      const firstArg = m ? m[1] : '';
      if (/^\d+$/.test(firstArg)) {
        return { blocked: true, why: `"${head} <N>" addresses a page element by its ls-listing index` };
      }
    }
    return { blocked: false, why: null };
  }

  // Scans already-split step text (never substituted values - see
  // substituteParams()) for `$1`..`$9`/`$@` tokens. `$10` is NOT a two-digit
  // token: the regex only ever matches a single digit 1-9, so `$10` is `$1`
  // followed by a literal `0` - documented behavior (design doc §4/§7), not
  // a bug.
  const PARAM_TOKEN_RE = /\$([1-9]|@)/g;

  function computeArity(steps) {
    let maxN = 0;
    let usesRest = false;
    for (const step of steps) {
      PARAM_TOKEN_RE.lastIndex = 0;
      let m;
      while ((m = PARAM_TOKEN_RE.exec(step))) {
        if (m[1] === '@') usesRest = true;
        else maxN = Math.max(maxN, Number(m[1]));
      }
    }
    return { arity: maxN, usesRest };
  }

  // Parses a raw script body into validated steps (design doc §3/§6/§9).
  // Pure and DOM-free - the write path (registry.js's setScript()) and the
  // run path (terminal.js's `run` handler, re-validating defensively - see
  // setScript()'s own comment) both call this same function, so "what makes
  // a step valid" has exactly one definition.
  //
  // Line-oriented: one step per line, blank lines and `#`-prefixed comment
  // lines ignored. Deliberately does NOT also split on `&&` within a line -
  // scripts are authored as an explicit multi-line body (design doc §9
  // sign-off #3), not a single `&&`-joined string like a macro.
  function parseScriptBody(raw, opts) {
    const maxSteps = (opts && opts.maxSteps) || 20;
    const lines = (typeof raw === 'string' ? raw : '').split('\n');
    const steps = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.charAt(0) === '#') continue;
      steps.push(trimmed);
    }
    if (steps.length === 0) return { ok: false, reason: 'script body has no steps' };
    if (steps.length > maxSteps) {
      return { ok: false, reason: `too many steps (${steps.length}, max ${maxSteps})` };
    }
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const head = firstWord(step).toLowerCase();
      // Depth-1 lock (same posture as macros never referencing a macro): a
      // script may not invoke another script - prevents recursive/mutually-
      // referencing `run` chains and keeps a script's own step count an
      // honest bound on what one `run` can do.
      if (head === 'run') {
        return { ok: false, reason: `step ${i + 1}: a script cannot invoke another script ("run") - scripts may not be nested (depth-1 lock)` };
      }
      if (GAME_NAMES.has(head)) {
        return { ok: false, reason: `step ${i + 1}: "${head}" cannot run inside a script - games are never chain/script-eligible` };
      }
      if (FUNPACK_NAMES.has(head)) {
        return { ok: false, reason: `step ${i + 1}: "${head}" cannot run inside a script - it does not run in chains or scripts` };
      }
      if (head === 'pause') {
        if (!/^pause\s+"[^"]+"\s*$/i.test(step)) {
          return { ok: false, reason: `step ${i + 1}: pause requires a quoted instruction, e.g. pause "click the buy button"` };
        }
        continue; // pause is never index-addressed - skip the check below
      }
      const idx = stepIsIndexAddressed(step);
      if (idx.blocked) {
        return { ok: false, reason: `step ${i + 1}: ${idx.why} - this cannot be safely replayed later; use pause and do it manually instead` };
      }
    }
    const { arity, usesRest } = computeArity(steps);
    return { ok: true, steps, arity, usesRest, stepCount: steps.length };
  }

  // ---- scripts v1 P2 (2026-07-14, portability - LFL-TERMINAL-SCRIPTS-DESIGN.md
  // "P2 - portability" phase, §9 sign-off #4) ----
  //
  // A `.lflscript` file is plain step-per-line text with a `#!lflscript v1`
  // header the importer version-gates on - not JSON. These two functions
  // (serializeScripts/parseScriptFile) handle ONLY the FILE'S STRUCTURE:
  // splitting it into {name, body} pairs, or building one from the stored
  // scripts object. Neither one validates a body in any way - that is
  // deliberate. setScript()/parseScriptBody() above is the ONE body-
  // validation path this store has, for a hand-typed `script new` body and
  // an imported body alike (see setScript()'s own comment on this). The
  // importer (terminal.js's `script import`) MUST feed every {name, body}
  // pair parseScriptFile() returns through setScript() before it is ever
  // stored - never write the `scripts` map directly from a parsed file. A
  // file is untrusted text; setScript() is what makes it trusted, exactly
  // the same way typing a body at the `script new` prompt does.
  const LFLSCRIPT_HEADER = '#!lflscript v1';
  const LFLSCRIPT_SECTION_RE = /^#!script\s+(\S+)\s*$/i;

  // Deterministic + round-trippable: scripts sorted by name, each rendered
  // as a `#!script <name>` header line followed by its stored body verbatim
  // (the body is already comment/blank-line-stripped - see setScript()/
  // parseScriptBody() - so nothing further needs stripping here).
  function serializeScripts(scriptsObj) {
    const obj = scriptsObj || {};
    const names = Object.keys(obj).sort();
    const parts = [LFLSCRIPT_HEADER];
    for (const name of names) {
      const entry = obj[name];
      const body = (entry && typeof entry.body === 'string') ? entry.body : '';
      parts.push(`#!script ${name}`);
      parts.push(body);
    }
    return parts.join('\n') + '\n';
  }

  // Parses raw file text into {ok:true, version, scripts:[{name, body}]} or
  // {ok:false, reason}. Version-gates on the header: the first non-blank
  // line MUST be exactly LFLSCRIPT_HEADER, or the whole file is rejected
  // outright (no best-effort parse of a format this importer doesn't
  // recognize - a future v2 format gets its own gate, not a silent
  // fallback). Anything before the first `#!script <name>` section header
  // (besides blank lines) is a structural error, not a script - rejected
  // with a clear reason rather than silently discarded. A duplicate name
  // within one file is rejected too (silently merging two bodies under one
  // name would be confusing, not a security question - just good hygiene).
  function parseScriptFile(text) {
    const raw = typeof text === 'string' ? text : '';
    const lines = raw.split('\n');
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length || lines[i].trim() !== LFLSCRIPT_HEADER) {
      return { ok: false, reason: `not a recognized .lflscript file (missing or unknown "${LFLSCRIPT_HEADER}" header)` };
    }
    i++;

    const scripts = [];
    const seenNames = new Set();
    let current = null; // { name, lines: [] }

    function closeCurrent() {
      if (current) scripts.push({ name: current.name, body: current.lines.join('\n').trim() });
    }

    for (; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(LFLSCRIPT_SECTION_RE);
      if (m) {
        closeCurrent();
        const name = m[1];
        const lower = name.toLowerCase();
        if (seenNames.has(lower)) {
          return { ok: false, reason: `duplicate script name "${name}" in file` };
        }
        seenNames.add(lower);
        current = { name, lines: [] };
        continue;
      }
      if (!current) {
        if (line.trim() === '') continue; // blank lines before the first section are harmless
        return { ok: false, reason: 'malformed .lflscript file: content found before any "#!script <name>" header' };
      }
      current.lines.push(line);
    }
    closeCurrent();

    if (scripts.length === 0) return { ok: false, reason: 'no scripts found in file' };
    return { ok: true, version: 'v1', scripts };
  }

  // Verify fix (2026-07-14 Fable pass, MED): re-validate each step AFTER
  // parameter substitution and alias expansion, at run time. parseScriptBody()
  // validates the stored TEMPLATE - but a step template that is entirely a
  // parameter reference (`$1`) takes its head word from the ARGUMENT
  // (`run s "click 4"` would resolve to a bare index click, executing with no
  // approval card), and a step whose head is a user-defined alias takes its
  // real head from the alias's CURRENT expansion (`alias c4 = click 4`).
  // Both would resurrect exactly the snapshot-bound index replay §1 forbids,
  // laundered through a level of indirection the write-time check cannot
  // see. Callers pass the fully-substituted, alias-EXPANDED step text; any
  // failure rejects the whole run before step 1 executes (no partial runs).
  // `run`/`script` heads are rejected too (nested-run depth-1 lock, again
  // post-indirection), as are games/funpack heads (their dispatch-time
  // fromChain blocks in terminal.js remain the security backstop - this just
  // fails the run at preview time with a clear message instead of mid-run).
  // A `pause` head must be the well-formed quoted shape, same as at parse
  // time. Residual (documented in threat-model.md): an alias redefined
  // DURING a run's pause window is not re-checked - the parked queue holds
  // already-validated text, but a segment like `myalias` parks as the alias
  // NAME and expands at dispatch; the human doing that mid-own-script is
  // self-inflicted and every executor hard block still applies.
  function validateResolvedStep(stepText) {
    const head = firstWord(stepText).toLowerCase();
    if (head === 'run' || head === 'script') {
      return { ok: false, reason: `"${head}" cannot run as a script/chain step` };
    }
    if (GAME_NAMES.has(head)) {
      return { ok: false, reason: `"${head}" cannot run inside a script - games are never chain/script-eligible` };
    }
    if (FUNPACK_NAMES.has(head)) {
      return { ok: false, reason: `"${head}" cannot run inside a script - it does not run in chains or scripts` };
    }
    if (head === 'pause') {
      if (!/^pause\s+"[^"]+"\s*$/i.test((stepText || '').trim())) {
        return { ok: false, reason: 'pause requires a quoted instruction, e.g. pause "click the buy button"' };
      }
      return { ok: true };
    }
    const idx = stepIsIndexAddressed(stepText);
    if (idx.blocked) {
      return { ok: false, reason: `${idx.why} - this cannot be safely replayed; use pause and do it manually instead` };
    }
    return { ok: true };
  }

  // Quote-aware whitespace tokenizer for `run <name> [args...]` (design doc
  // §3/§4) - same style as splitChain's quote tracking, splitting on
  // whitespace instead of `&&`. Each token keeps BOTH its unwrapped `value`
  // (used for `$1`..`$9` substitution) and its exact-as-typed `raw` form,
  // quotes included if it was quoted (used for `$@`, which must reproduce
  // the original argument boundaries - see substituteParams()).
  function tokenizeArgs(raw) {
    const s = typeof raw === 'string' ? raw : '';
    const tokens = [];
    let i = 0;
    const n = s.length;
    while (i < n) {
      while (i < n && /\s/.test(s[i])) i++;
      if (i >= n) break;
      if (s[i] === '"') {
        let j = i + 1;
        let buf = '';
        let closed = false;
        while (j < n) {
          if (s[j] === '"') { closed = true; j++; break; }
          buf += s[j];
          j++;
        }
        if (!closed) return { ok: false, reason: 'unterminated quoted argument' };
        tokens.push({ value: buf, raw: s.slice(i, j) });
        i = j;
      } else {
        let j = i;
        while (j < n && !/\s/.test(s[j])) j++;
        const word = s.slice(i, j);
        tokens.push({ value: word, raw: word });
        i = j;
      }
    }
    return { ok: true, tokens };
  }

  // Injection-safe parameter substitution (design doc §4, normative). Chain/
  // step STRUCTURE is already fixed by parseScriptBody() on the stored
  // template, before this ever runs - this function only ever substitutes
  // into the LEAVES of an already-delimited step, so a `&&` inside an
  // argument value cannot create a new step (there is no re-splitting here
  // or anywhere downstream in the run path). A value containing a `"` is
  // rejected outright rather than patched - see the design doc's own
  // reasoning for why silent quote-repair is not attempted in v1.
  function substituteParams(step, argTokens) {
    const tokens = Array.isArray(argTokens) ? argTokens : [];
    let err = null;
    const text = step.replace(PARAM_TOKEN_RE, (whole, g) => {
      if (err) return whole;
      if (g === '@') return tokens.map((t) => t.raw).join(' ');
      const tok = tokens[Number(g) - 1];
      if (!tok) { err = `argument $${g} was not supplied`; return whole; }
      if (tok.value.indexOf('"') !== -1) {
        err = `argument $${g} contains a " character, which cannot be safely substituted into a command`;
        return whole;
      }
      return tok.value;
    });
    if (err) return { ok: false, reason: err };
    return { ok: true, text };
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

  // Auto-open-on-home (2026-07-14): the terminal auto-opens its overlay when a
  // page's origin is on the user's opt-in list (persisted under
  // chrome.storage.local `lflAutoOpenOrigins`, managed by the `autoopen`
  // command - see terminal.js's _handleAutoOpen/_maybeAutoOpenHome). Both
  // helpers are PURE so the match/toggle rules are unit-tested directly; the
  // chrome.storage read/write and the actual open() call stay in terminal.js.
  // origin is compared verbatim (exact string, e.g. "https://www.google.com") -
  // no substring/prefix matching, so an entry can never accidentally arm a
  // different site.
  function autoOpenMatch(origin, list) {
    if (!origin || !Array.isArray(list)) return false;
    return list.indexOf(origin) !== -1;
  }

  // Returns the NEW list plus whether the origin is now enabled, without
  // mutating the input. Skips empty/non-string entries defensively so a
  // corrupted stored value can never crash the toggle.
  function toggleAutoOpen(list, origin) {
    const base = Array.isArray(list) ? list.filter((o) => typeof o === 'string' && o) : [];
    if (!origin) return { list: base, enabled: false };
    const has = base.indexOf(origin) !== -1;
    const next = has ? base.filter((o) => o !== origin) : base.concat([origin]);
    return { list: next, enabled: !has };
  }

  // Panel height control (collapse + resize, 2026-07-14): the docked overlay
  // used to grow to a fixed 46vh cap and crowd the page. It now has a user-set
  // height (a drag grip plus Ctrl+Up/Down preset cycling, persisted in
  // storage.local `lflPanelHeight`) and a manual collapse toggle that hides the
  // scrollback only. These two helpers are the PURE height math; terminal.js
  // owns the DOM/storage/drag glue. All values are in vh.
  const PANEL_PRESETS_VH = [22, 34, 46];   // compact, normal, tall
  const PANEL_DEFAULT_VH = 34;             // "normal" - below the old 46vh hard cap
  const PANEL_MIN_VH = 12;
  const PANEL_MAX_VH = 80;

  // Clamp any candidate height (a stored value, or a live drag position) into
  // the allowed range; a non-finite/garbage value falls back to the default
  // rather than throwing or applying NaN.
  function clampPanelHeightVh(vh) {
    const n = Number(vh);
    if (!Number.isFinite(n)) return PANEL_DEFAULT_VH;
    return Math.min(PANEL_MAX_VH, Math.max(PANEL_MIN_VH, n));
  }

  // Step to the next preset strictly above (dir > 0) or below (dir < 0) the
  // current height, clamped to the ends of the ladder. The 0.5 epsilon means
  // "already exactly on a preset" steps to the neighbour, not back to itself,
  // and an off-preset height (from a free drag) snaps to the next preset in the
  // pressed direction.
  function stepPanelPreset(currentVh, dir) {
    const cur = clampPanelHeightVh(currentVh);
    if (dir > 0) {
      for (const p of PANEL_PRESETS_VH) if (p > cur + 0.5) return p;
      return PANEL_PRESETS_VH[PANEL_PRESETS_VH.length - 1];
    }
    if (dir < 0) {
      for (let i = PANEL_PRESETS_VH.length - 1; i >= 0; i--) {
        if (PANEL_PRESETS_VH[i] < cur - 0.5) return PANEL_PRESETS_VH[i];
      }
      return PANEL_PRESETS_VH[0];
    }
    return cur;
  }

  return {
    createRegistry, createAliasStore, splitChain, expandAlias, expandMacro,
    damerauLevenshtein, didYouMean, autoOpenMatch, toggleAutoOpen,
    clampPanelHeightVh, stepPanelPreset, PANEL_PRESETS_VH, PANEL_DEFAULT_VH,
    // scripts v1
    parseScriptBody, substituteParams, tokenizeArgs, stepIsIndexAddressed,
    validateResolvedStep, SCRIPT_MAX_STEPS,
    // scripts v1 P2 (portability)
    serializeScripts, parseScriptFile,
  };
});
