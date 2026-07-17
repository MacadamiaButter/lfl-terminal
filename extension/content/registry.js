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
        // color grammar v2 (2026-07-17, LFL-TERMINAL-COLOR-GRAMMAR-DESIGN.md
        // §5): the `help` grouping bucket this entry belongs under (e.g.
        // "pages & navigation") - a plain display label, never read by
        // dispatch. Required (unit-test enforced, see
        // tests/color_grammar.test.js) on every entry that is not
        // `hidden` - a hidden entry (the `sl` easter egg) is excluded from
        // helpRich()/helpText() alike, so it has nothing to be grouped
        // under. Defaults to null (an entry that forgets to set it simply
        // falls into helpRich()'s own defensive "other" bucket rather than
        // throwing) - additive widening of the entry shape, same posture as
        // `hidden` above.
        group: entry.group || null,
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

    // color grammar v2 (design doc §5) - groups non-hidden entries by their
    // `group` field, preserving both group-of-first-appearance order and
    // each group's own registration order (a plain Map walk, no sorting) -
    // deterministic for a given registration sequence, same posture as
    // helpText()'s own entries.filter().map() above.
    function groupedEntries() {
      const groups = new Map();
      for (const e of entries) {
        if (e.hidden) continue;
        const g = e.group || 'other';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(e);
      }
      return groups;
    }

    // One command's rich line: `name` in cls 'lfl-syn-cmd' (bold, per
    // argSpecSpans()), placeholder runs in cls 'lfl-syn-arg', a literal "  - "
    // separator (unclassed - matches helpText()'s own "- " separator, just
    // without the column-padding that only makes sense in a monospace flat
    // dump), then the description via richTextSpans() (backtick convention,
    // design doc §5).
    function commandLineSpans(e) {
      const spans = argSpecSpans(e.argSpec, e.name);
      spans.push({ text: '  - ', cls: null });
      return spans.concat(richTextSpans(e.help, 'lfl-syn-info'));
    }

    // helpRich() -> array of line objects [{spans:[{text, cls}]}] (design
    // doc §5): per group, a section-header line (accent "$ " prefix + dim
    // uppercase group name), then one line per command in that group.
    // helpText() (above) is UNCHANGED and stays the source of truth for
    // scrollback/man-fallback/existing tests - this is purely an additional,
    // richer view of the exact same entries.
    function helpRich() {
      const lines = [];
      for (const [group, groupEntries] of groupedEntries()) {
        lines.push({
          spans: [
            { text: '$ ', cls: 'lfl-syn-accent' },
            { text: group.toUpperCase(), cls: 'lfl-syn-header' },
          ],
        });
        for (const e of groupEntries) lines.push({ spans: commandLineSpans(e) });
      }
      return lines;
    }

    // manRich(name) -> array of line objects, the same treatment as
    // helpRich() but for exactly one command (design doc §5) - mirrors
    // manText()'s own shape (name+aliases / usage / description), one field
    // per line.
    function manRich(name) {
      const e = get(name);
      if (!e) return [{ spans: [{ text: `no such command: ${name}`, cls: 'lfl-syn-info' }] }];
      const aliasTxt = e.aliases.length ? ` (aliases: ${e.aliases.join(', ')})` : '';
      return [
        { spans: [{ text: e.name, cls: 'lfl-syn-cmd' }, { text: aliasTxt, cls: null }] },
        { spans: [{ text: '  usage: ', cls: null }].concat(argSpecSpans(e.argSpec, e.name)) },
        { spans: [{ text: '  ', cls: null }].concat(richTextSpans(e.help, 'lfl-syn-info')) },
      ];
    }

    return { register, get, names, helpText, manText, helpRich, manRich, entries };
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
    // brainstorm lane (2026-07-15, LFL-TERMINAL-BRAINSTORM-LANE-DESIGN.md):
    // `teach` asks the local model to draft a script from a plain-language
    // goal - same shadowing footgun as every other built-in (an
    // `alias teach = ...`/`macro teach = ...` would silently make the verb
    // unreachable by its own name), so it is reserved the same way.
    'teach',
    // popover redesign (2026-07-15, LFL-TERMINAL-POPOVER-REDESIGN.md): `config`
    // (anchor/middle-click settings), `pin`/`unpin` (freeze the floating panel
    // in place) - same shadowing footgun as every other standalone control
    // command above.
    'config', 'pin', 'unpin',
    // memory lane M1/M2 (2026-07-16, LFL-TERMINAL-MEMORY-LANE-DESIGN.md):
    // `memory` (show/on/off/quiet/loud/forget/clear) and its two aliases
    // `remember` (-> `memory on`) / `forget <origin>` (-> `memory forget
    // <origin>`) - same shadowing footgun as every other standalone control
    // command above (`terminal.js`'s `_submitCommand` intercepts all three
    // before chain-splitting, exactly like `dev`/`origins`/`autoopen`
    // already do, so an alias/macro defined under one of these three names
    // would silently be unreachable by its own name).
    'memory', 'remember', 'forget',
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

  // scripts P2 hardening (2026-07-14, brainstorm-probe finding): the set of
  // command names a script step's leading word is allowed to be. `knownVerbs`
  // is the full built-in command surface (LFL.commandRegistry.names(), passed
  // in by terminal.js since this pure module cannot reach the engine's
  // registry itself); `ask` is added explicitly because it is the
  // explicit-model prefix, dispatched specially and NOT a registered command.
  // A script step whose leading word is none of {a known command, a defined
  // alias, `ask`} is rejected at write time - closing the gap the lab probe
  // surfaced (parseScriptBody alone accepts a nonsense verb like `dance now`,
  // and an implicit natural-language step like `book the flight` is exactly
  // the text a shared/imported script could use to inject an arbitrary prompt
  // into the page-lane model). This is enforced ONLY when knownVerbs is
  // supplied (production always supplies it via terminal.js); callers that
  // omit it - unit tests exercising the collision/parse logic - skip the
  // whitelist, same optional-dependency posture as storageArea.
  function createAliasStore(storageArea, knownVerbs) {
    const knownVerbSet = new Set(
      (Array.isArray(knownVerbs) ? knownVerbs : []).map((v) => String(v || '').toLowerCase()),
    );
    // `ask` is the explicit model-lane prefix (dispatched specially, never a
    // registered command) - always allowed as a script step's leading word so
    // a deliberate model step (`ask summarize this page`) is expressible.
    if (knownVerbSet.size > 0) knownVerbSet.add('ask');
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
    // brainstorm lane (2026-07-15, LFL-TERMINAL-BRAINSTORM-LANE-DESIGN.md §4):
    // the pure "would setScript accept this?" check, factored OUT of
    // setScript() below so the `teach` flow can validate a model-drafted body
    // (and render the verdict + numbered steps) BEFORE the human approves it,
    // without writing anything to storage on a draft that is never saved -
    // "validate first without persisting, write only on approval". This is
    // exactly setScript()'s own rule set, run against the same closed-over
    // aliases/macros/scripts/knownVerbSet state, so there is still exactly
    // ONE definition of "what makes a script valid" (no duplicated rules to
    // drift apart). `name` is OPTIONAL here (unlike setScript(), which always
    // requires one): the no-`as <name>` teach flow validates the BODY alone
    // first and only learns the name afterward (typed on the input line,
    // approved separately) - passing `name` as null/undefined skips every
    // name-specific check (validName/self-name/collisions) and validates only
    // the body + verb whitelist; passing a real name runs the full check,
    // identical to what setScript() itself will re-run at save time.
    function validateScriptBody(name, body) {
      if (name !== null && name !== undefined) {
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
      }
      const parsed = parseScriptBody(body, { maxSteps: SCRIPT_MAX_STEPS });
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      // Verb whitelist (scripts P2 hardening - see knownVerbSet's comment
      // above). Enforced only when a known-verb list was supplied. A step's
      // leading word must be a known command, a currently-defined alias, or
      // `ask`; anything else (a nonsense verb, or an implicit
      // natural-language step that would otherwise be routed to the page-lane
      // model) is refused. Runs on the parsed steps AFTER parseScriptBody's
      // own structural/index/games/pause/teach checks, so those specific
      // messages still win for the cases they cover. Aliases are allowed by
      // NAME here (they expand at dispatch, where validateResolvedStep
      // re-checks the index/games shape of the expansion); documented
      // residual: an alias whose expansion is itself an unknown verb passes
      // this check and, at run time, falls through to the gated model lane
      // (never a new capability, always human-approved) rather than being
      // refused.
      if (knownVerbSet.size > 0) {
        for (let i = 0; i < parsed.steps.length; i++) {
          const head = firstWord(parsed.steps[i]).toLowerCase();
          if (!knownVerbSet.has(head) && !Object.prototype.hasOwnProperty.call(aliases, head)) {
            return { ok: false, reason: `step ${i + 1}: "${head}" is not a known command, a defined alias, or "ask" - script steps must use the fixed vocabulary (prefix a model request with "ask")` };
          }
        }
      }
      return { ok: true, steps: parsed.steps, arity: parsed.arity, usesRest: parsed.usesRest, stepCount: parsed.stepCount };
    }

    function setScript(name, body) {
      const v = validateScriptBody(name, body);
      if (!v.ok) return v;
      scripts[name] = {
        body: v.steps.join('\n'),
        arity: v.arity,
        usesRest: v.usesRest,
        stepCount: v.stepCount,
      };
      persist();
      return { ok: true, stepCount: v.stepCount, arity: v.arity };
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
      // brainstorm lane: validate-without-writing, see its own comment above.
      validateScriptBody,
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
      // brainstorm lane (LFL-TERMINAL-BRAINSTORM-LANE-DESIGN.md §4): `teach`
      // is excluded from the script-step surface the SAME way as SCRIPT_SELF_
      // NAMES - checked here, structurally, BEFORE the knownVerbSet whitelist
      // in setScript()/validateScriptBody() even runs, so this holds whether
      // or not `teach` happens to be a registered command name (it is, for
      // help/man text) - a script can never contain a `teach` step, typed or
      // imported, no matter what the whitelist would otherwise allow.
      if (head === 'teach') {
        return { ok: false, reason: `step ${i + 1}: "teach" cannot run inside a script - the brainstorm lane is never chain/script-eligible` };
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
    // brainstorm lane: `teach` gets the same post-indirection block as
    // run/script - see parseScriptBody()'s matching define-time check above.
    if (head === 'run' || head === 'script' || head === 'teach') {
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

  // Popover redesign (2026-07-15, LFL-TERMINAL-POPOVER-REDESIGN.md §4): pure
  // placement geometry for the cursor-anchored floating panel. All inputs/
  // outputs are CSS px, viewport-relative (the panel is `position:fixed`, so
  // its origin IS the viewport). No DOM, no clock, no randomness - terminal.js
  // supplies the anchor point, the panel's estimated box, and the current
  // viewport size; this only does the arithmetic, which is what makes it
  // unit-testable the same way clampPanelHeightVh/stepPanelPreset are above.
  const PANEL_PLACEMENT_MARGIN = 8;   // min gap kept from every viewport edge
  const PANEL_PLACEMENT_OFFSET = 14;  // gap between the anchor point and the panel's near edge

  // Given an anchor point (typically the pointer position at trigger time)
  // and the panel's box, returns the {left, top} that keeps the panel fully
  // on-screen: prefers below-and-right of the anchor, shifts left if it would
  // overflow the right edge, and flips above the anchor (rather than just
  // clamping down) if it would overflow the bottom edge - clamping only as
  // the last resort, when the panel is taller or wider than the viewport has
  // room for either way.
  function placePanel(opts) {
    opts = opts || {};
    const margin = Number.isFinite(opts.margin) ? opts.margin : PANEL_PLACEMENT_MARGIN;
    const anchorX = Number(opts.anchorX) || 0;
    const anchorY = Number(opts.anchorY) || 0;
    const panelW = Math.max(0, Number(opts.panelW) || 0);
    const panelH = Math.max(0, Number(opts.panelH) || 0);
    const vpW = Math.max(1, Number(opts.vpW) || 0);
    const vpH = Math.max(1, Number(opts.vpH) || 0);

    let left = anchorX;
    const maxLeft = vpW - margin - panelW;
    const minLeft = margin;
    if (left > maxLeft) left = maxLeft;
    if (left < minLeft) left = minLeft;

    let top = anchorY + PANEL_PLACEMENT_OFFSET;
    const minTop = margin;
    const maxTop = vpH - margin - panelH;
    if (top > maxTop) {
      // Flip above the anchor instead of just clamping down against the
      // bottom edge - keeps the panel from sitting on top of (and hiding)
      // whatever the anchor point itself was.
      const flipped = anchorY - panelH - PANEL_PLACEMENT_OFFSET;
      top = flipped >= minTop ? flipped : minTop;
    }
    if (top < minTop) top = minTop;

    return { left, top };
  }

  // Deterministic anchor for keyboard-triggered opens (backtick/Ctrl+K/
  // toolbar) - there is no meaningful pointer position to anchor to (the
  // mouse could be anywhere), so spawning under a stale/unrelated cursor
  // position would be worse than a predictable, centered-near-top spot.
  function defaultAnchor(vpW, vpH, panelW) {
    const w = Math.max(0, Number(vpW) || 0);
    const h = Math.max(0, Number(vpH) || 0);
    const pw = Math.max(0, Number(panelW) || 0);
    return { x: (w - pw) / 2, y: h * 0.12 };
  }

  // ---- live syntax highlighting (2026-07-16,
  // LFL-TERMINAL-SYNTAX-HIGHLIGHT-DESIGN.md) ----
  //
  // synSpans(line, knownNames) -> array of {text, cls} covering the ENTIRE
  // input line - concatenating every piece's `text` reproduces `line`
  // exactly (test-enforced) - so terminal.js's mirror-overlay and
  // scrollback-echo renderers can build the highlighted DOM purely from this
  // array, with no further string surgery of their own. Pure and DOM-free:
  // no chrome.*, no storage, no registry access - `knownNames` (typically
  // LFL.commandRegistry.names() plus the live alias/macro store keys - see
  // terminal.js's _knownSynNames()) is supplied by the CALLER so this
  // function never reaches outside its own arguments (design doc §4).
  //
  // DIVERGENCE FROM THE DESIGN DOC (§4 says code wins when the two
  // disagree): the design doc's color table (§2) describes quoted spans as
  // `"..."` OR `'...'` (double OR single quotes). The terminal's actual
  // quote-aware parsers - splitChain() and tokenizeArgs() above, the two
  // functions that determine what a typed line ACTUALLY does at dispatch
  // time - only ever treat the double quote (") as a delimiter; a single
  // quote (') is just an ordinary literal character with no special meaning
  // anywhere in this file. Highlighting single-quoted text as a string
  // would show the human a grouping the dispatcher does not honor (e.g.
  // `search 'a && b'` really does split into two chained commands at the
  // &&, unlike inside a real double-quoted span) - actively misleading for
  // a feature whose entire job is honest lane feedback (design doc §1).
  // synSpans() therefore mirrors splitChain()/tokenizeArgs() exactly:
  // double quotes only, no escapes, an unmatched opening quote runs to
  // end-of-line - the same "open quote to close-or-EOL" shape splitChain's
  // own unterminated-quote state already produces, not a separate rule
  // invented here.
  //
  // Single pass over the line classifies every character index as 'quote'
  // (inside a "..." span, delimiters included), 'op' (part of a real,
  // outside-quotes "&&" separator), or 'plain' - by literally re-running
  // splitChain's own char-by-char state machine, so this can never silently
  // drift from what splitChain actually splits on. At each segment
  // boundary (an 'op' pair, or end of line) the segment's leading token is
  // found the same whitespace-blind way _dispatchSegment() resolves a head
  // (`resolved.trim().split(/\s+/)[0]`, matched here via `/^(\s*)(\S+)/`)
  // and, if it is an EXACT, case-sensitive match in knownNames, its
  // 'plain'-classified characters are upgraded to 'cmd' - a token that
  // starts inside quotes (e.g. the literal text `"go"`) can never match a
  // bare known name and so never upgrades, consistent with "exact-match...
  // token boundary = whitespace, quotes not stripped" (design doc §2). A
  // final pass merges consecutive same-classified characters into runs and
  // maps each run to its CSS class - null means "default, inherit".
  const SYN_CLASS = {
    cmd: 'lfl-syn-cmd', quote: 'lfl-syn-str', op: 'lfl-syn-op',
    // color grammar v2 (2026-07-17, LFL-TERMINAL-COLOR-GRAMMAR-DESIGN.md §3):
    // two new per-character kinds a v2 call can produce - see synSpans()'s
    // own v2 gate below for exactly when.
    sub: 'lfl-syn-sub', num: 'lfl-syn-num',
  };
  const SYN_HEAD_RE = /^(\s*)(\S+)/;
  // color grammar v2: a plain whitespace-delimited token, walked within one
  // already-delimited segment's raw text (quote characters included
  // verbatim, same "token boundary = whitespace, quotes not stripped"
  // posture as SYN_HEAD_RE above - see markSegmentTokensV2()'s own comment).
  const SYN_TOKEN_RE = /\S+/g;
  const SYN_NUMERIC_TOKEN_RE = /^\d+$/;

  // synSpans(line, knownNames, subTable) -> array of {text, cls}. Extends
  // the M4c/M4c-syntax-highlight-era two-arg contract (design doc §3):
  // per-segment classification order is head lookup (cls 'cmd') -> known
  // subcommand for the segment's SECOND token (cls 'sub') -> pure-numeric
  // token, any position (cls 'num') -> quoted string / && operator (cls
  // 'str'/'op', unchanged from v1). Unknown heads stay unlit (P3 - no
  // per-verb category hues, ever).
  //
  // BACKWARD COMPATIBILITY (normative, unit-tested in
  // tests/syntax_highlight.test.js AND tests/color_grammar.test.js): a call
  // with no third argument (or an explicit `undefined`/`null` third
  // argument) MUST reproduce today's (pre-color-grammar) two-arg output
  // byte-for-byte - no num/sub classification at all. This is what makes
  // the change additive rather than a breaking change to every existing
  // caller/test of this function: v2 behavior is opt-in, keyed off whether
  // a subTable was actually supplied, not off any property of the line
  // itself.
  function synSpans(line, knownNames, subTable) {
    const s = typeof line === 'string' ? line : '';
    const n = s.length;
    if (n === 0) return [];
    const known = new Set(Array.isArray(knownNames) ? knownNames : []);
    const v2 = subTable !== undefined && subTable !== null;
    const subs = (v2 && typeof subTable === 'object') ? subTable : {};
    const kind = new Array(n); // 'quote' | 'op' | 'plain' | 'cmd' | 'sub' | 'num'

    // v1, UNCHANGED byte-for-byte (see this function's own backward-
    // compatibility note above) - the segment's leading token becomes 'cmd'
    // when it is an exact, case-sensitive match in `known`. Returns the
    // matched head's {text, start, end} (or null) so the v2 pass below can
    // reuse it without re-parsing the segment a second time.
    function markHeadIfKnown(segStart, segEnd) {
      const seg = s.slice(segStart, segEnd);
      const m = SYN_HEAD_RE.exec(seg);
      if (!m || !m[2] || !known.has(m[2])) return null;
      const headStart = segStart + m[1].length;
      const headEnd = headStart + m[2].length;
      for (let k = headStart; k < headEnd; k++) {
        if (kind[k] === 'plain') kind[k] = 'cmd';
      }
      return { text: m[2], start: headStart, end: headEnd };
    }

    // v2 only: within one already-delimited segment, upgrade the segment's
    // exact SECOND whitespace-delimited token to 'sub' when the matched
    // head is a real, recognized command (design doc §3: subcommand shading
    // only ever applies under a real parent command name) whose subTable
    // entry lists that exact token; separately, upgrade ANY still-'plain'
    // pure-digit token (any position, including an unmatched numeric head -
    // "a bare-number command", design doc §3) to 'num'. Only ever touches
    // characters still marked 'plain' - a character already 'quote'/'op'/
    // 'cmd' is never revisited, so this pass can only ever ADD structure on
    // top of what markHeadIfKnown and the quote/op scan already decided,
    // never override it.
    function markSegmentTokensV2(segStart, segEnd, head) {
      const segText = s.slice(segStart, segEnd);
      const subList = (head && Object.prototype.hasOwnProperty.call(subs, head.text) && Array.isArray(subs[head.text]))
        ? subs[head.text] : null;
      SYN_TOKEN_RE.lastIndex = 0;
      let m;
      let tokenIdx = 0;
      while ((m = SYN_TOKEN_RE.exec(segText))) {
        tokenIdx += 1;
        const tokStart = segStart + m.index;
        const tokEnd = tokStart + m[0].length;
        if (tokenIdx === 2 && subList && subList.indexOf(m[0]) !== -1) {
          for (let k = tokStart; k < tokEnd; k++) if (kind[k] === 'plain') kind[k] = 'sub';
          continue;
        }
        if (SYN_NUMERIC_TOKEN_RE.test(m[0])) {
          for (let k = tokStart; k < tokEnd; k++) if (kind[k] === 'plain') kind[k] = 'num';
        }
      }
    }

    let inQuotes = false;
    let segStart = 0;
    let i = 0;
    while (i < n) {
      const ch = s[i];
      if (ch === '"') {
        kind[i] = 'quote';
        inQuotes = !inQuotes;
        i += 1;
        continue;
      }
      if (!inQuotes && ch === '&' && s[i + 1] === '&') {
        kind[i] = 'op';
        kind[i + 1] = 'op';
        const head = markHeadIfKnown(segStart, i);
        if (v2) markSegmentTokensV2(segStart, i, head);
        segStart = i + 2;
        i += 2;
        continue;
      }
      kind[i] = inQuotes ? 'quote' : 'plain';
      i += 1;
    }
    const lastHead = markHeadIfKnown(segStart, n);
    if (v2) markSegmentTokensV2(segStart, n, lastHead);

    const spans = [];
    let runStart = 0;
    let runKind = kind[0];
    for (let idx = 1; idx <= n; idx++) {
      if (idx === n || kind[idx] !== runKind) {
        spans.push({ text: s.slice(runStart, idx), cls: SYN_CLASS[runKind] || null });
        if (idx < n) { runStart = idx; runKind = kind[idx]; }
      }
    }
    return spans;
  }

  // ---- color grammar v2 (2026-07-17, LFL-TERMINAL-COLOR-GRAMMAR-DESIGN.md
  // §3) - the subcommand table synSpans()'s v2 path reads ----
  //
  // DATA, not guesswork: every list below was verified against the actual
  // dispatch code that accepts it (see the file/line noted per entry - all
  // in extension/content/terminal.js unless stated otherwise). A command
  // not listed here simply gets no 'sub' classification for its second
  // token (falls through to the numeric-token test, then stays unlit) -
  // that is a correct, safe default for every command with no fixed
  // subcommand vocabulary (search/open/go/alias/... take free-form
  // arguments, not a closed set of second words).
  const SUBCOMMAND_TABLE = Object.freeze({
    // _handleMemoryCommand() (terminal.js): show|on|off|quiet|loud|clear|forget.
    memory: Object.freeze(['show', 'on', 'off', 'quiet', 'loud', 'clear', 'forget']),
    // _handleScriptCommand() (terminal.js): new|ls|show|rm|export|import.
    script: Object.freeze(['new', 'ls', 'show', 'rm', 'export', 'import']),
    // _handleTeachCommand() (terminal.js): on|off, plus the fixed "save
    // that" magic-goal phrase's leading word.
    teach: Object.freeze(['on', 'off', 'save']),
    // _handleTheme() (terminal.js) accepts exactly LFL.funpack.THEMES
    // (extension/content/funpack.js) as the second token.
    theme: Object.freeze(['default', 'phosphor', 'amber', 'paper']),
    // _handleConfigCommand() (terminal.js): anchor|middleclick.
    config: Object.freeze(['anchor', 'middleclick']),
  });

  // ---- color grammar v2: help/man rich-text builders (design doc §5) ----
  //
  // Engine-authored text ONLY - every string these two helpers ever read
  // (an argSpec, a help description, a prose line) originates from this
  // module's own registered entries or from a caller-supplied literal
  // string that is itself engine-authored (see engine.js's own comment on
  // HELP_PROSE_LINES). NEVER feed page-derived or model-lane text through
  // either of these - that is the load-bearing P4 invariant this whole
  // feature is built around; the whole reason richness is available at all
  // is that this text was never attacker-influenced in the first place.
  const BACKTICK_RE = /`([^`]*)`/g;

  // Splits `text` on `` `code` `` spans (the backtick convention already
  // present throughout this codebase's help/man strings - see e.g. the
  // existing `open`/`unpin`/`matches`/HELP_TEXT strings in engine.js),
  // stripping the backticks themselves. A backtick-wrapped span gets cls
  // 'lfl-syn-cmd' (visually, a literal command word); everything else gets
  // `plainCls` (typically 'lfl-syn-info'). Pure and DOM-free.
  function richTextSpans(text, plainCls) {
    const s = typeof text === 'string' ? text : '';
    const spans = [];
    let last = 0;
    BACKTICK_RE.lastIndex = 0;
    let m;
    while ((m = BACKTICK_RE.exec(s))) {
      if (m.index > last) spans.push({ text: s.slice(last, m.index), cls: plainCls || null });
      spans.push({ text: m[1], cls: 'lfl-syn-cmd' });
      last = m.index + m[0].length;
    }
    if (last < s.length) spans.push({ text: s.slice(last), cls: plainCls || null });
    if (spans.length === 0) spans.push({ text: '', cls: plainCls || null });
    return spans;
  }

  // Marks every non-word-adjacent, exact occurrence of `name` inside `s` as
  // 'cmd' in the `marks` array (only where still unmarked - a placeholder
  // run already claims priority, mirroring synSpans()'s own "head lookup
  // first" ordering). Deliberately NOT a `\b`-anchored regex: a command
  // name can itself end in a non-word character (e.g. "open!"), and `\b`
  // does not match between two non-word characters (a trailing "!" followed
  // by end-of-string/whitespace would silently never match) - a plain
  // indexOf scan with an explicit "is the character on each side a
  // word character" check has no such blind spot.
  function markNameOccurrences(s, name, marks) {
    if (!name) return;
    const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
    let from = 0;
    while (from <= s.length) {
      const idx = s.indexOf(name, from);
      if (idx === -1) break;
      const before = idx > 0 ? s[idx - 1] : undefined;
      const after = idx + name.length < s.length ? s[idx + name.length] : undefined;
      if (!isWordChar(before) && !isWordChar(after)) {
        for (let k = idx; k < idx + name.length; k++) {
          if (marks[k] === null) marks[k] = 'cmd';
        }
      }
      from = idx + name.length;
    }
  }

  // `<...>` / `[...]` (no nesting - registry argSpecs never nest these) and
  // a TIGHT `a|b|c` alternation (no surrounding whitespace, e.g. "on|off",
  // "new|ls|show|rm") - the three placeholder shapes design doc §5 names.
  // A spaced-out `cmd1 | cmd2` usage-variant separator (e.g. "dev on | dev
  // off") is deliberately NOT matched here - that pipe separates two whole
  // usage lines, not a single placeholder's alternatives, and is left as
  // plain text.
  const ARG_PLACEHOLDER_RE = /<[^<>]*>|\[[^[\]]*\]|\b[A-Za-z0-9!]+(?:\|[A-Za-z0-9!]*)+\b/g;

  // Tokenizes one registry entry's argSpec (design doc §5): every exact,
  // whole-word occurrence of the command's own `name` gets cls 'lfl-syn-cmd'
  // (bold via that class's own font-weight:600, same as a live-typed head);
  // a placeholder run gets cls 'lfl-syn-arg' (italic dim); everything else
  // is left plain (null - inherits the line's own color). Pure and DOM-free.
  function argSpecSpans(argSpec, name) {
    const s = typeof argSpec === 'string' ? argSpec : '';
    if (!s) return [];
    const marks = new Array(s.length).fill(null); // null | 'arg' | 'cmd'
    ARG_PLACEHOLDER_RE.lastIndex = 0;
    let m;
    while ((m = ARG_PLACEHOLDER_RE.exec(s))) {
      for (let k = m.index; k < m.index + m[0].length; k++) marks[k] = 'arg';
    }
    markNameOccurrences(s, name, marks);
    // A registry `name` is sometimes a disambiguating KEY, not the literal
    // typed word - e.g. the two `extract` entries are registered as
    // "extract-links"/"extract-table" (so they can each have their own
    // help/man text) but their argSpec text reads "extract links"/"extract
    // table"; the literal typed head word is "extract", not the registry
    // key. Also mark occurrences of argSpec's OWN leading token so a
    // mismatch like this still gets its real command word highlighted,
    // rather than silently rendering with no cls 'lfl-syn-cmd' span at all.
    // A no-op when the two already agree (the common case) - markNameOccurrences()
    // only ever upgrades a still-unmarked character.
    const headMatch = SYN_HEAD_RE.exec(s);
    const headWord = headMatch ? headMatch[2] : null;
    if (headWord && headWord !== name) markNameOccurrences(s, headWord, marks);
    const spans = [];
    let runStart = 0;
    let runMark = marks[0];
    for (let idx = 1; idx <= s.length; idx++) {
      if (idx === s.length || marks[idx] !== runMark) {
        const cls = runMark === 'arg' ? 'lfl-syn-arg' : (runMark === 'cmd' ? 'lfl-syn-cmd' : null);
        spans.push({ text: s.slice(runStart, idx), cls });
        if (idx < s.length) { runStart = idx; runMark = marks[idx]; }
      }
    }
    return spans;
  }

  // ---- memory lane M1/M2 (2026-07-16, LFL-TERMINAL-MEMORY-LANE-DESIGN.md
  // §2/§3/§4/§8) ----
  //
  // 100% deterministic: a terminal-scoped, opt-in, chrome.storage.local
  // `lflMemory` store of "which VERB ran on which ORIGIN how many times" plus
  // a short per-origin "recent verbs" ring for repeat-detection, and its
  // controls. NO model call anywhere in this section - the brainstorm/`teach`
  // wiring that will eventually READ this store (buildMemoryContext(),
  // design doc §4) is explicitly M3, out of scope here. See terminal.js's
  // `_recordMemoryVerb()`/`_maybeNudge()` for the one write/read choke point
  // this is built around.
  //
  // Schema: { v:1, origins: { <origin>: { <verb>: {n, lastUsed} } },
  //           prefs: {...}, recent: { <origin>: [verb, verb, ...] } }.
  // `origins`/`prefs` are exactly the design doc §3 shape. `recent` is an
  // additive sibling field (same storage key, not a schema break) that
  // realizes the design doc §2 HOLDS bullet "a tiny rolling 'recent verbs
  // this session' ring for repeat-detection" - it has to live INSIDE this
  // persisted object (not a separate ephemeral in-memory ring on the
  // Terminal instance) because `go`/an auto-submitting `search` navigate,
  // which destroys and freshly reconstructs the content script's entire
  // `state` on every injection (see terminal.js's own header comment) - a
  // ring held only in that per-injection state could never survive the very
  // navigations a "go, search, read" workflow is made of. Persisting it
  // instead in chrome.storage.local (content-script-writable, no
  // background/service-worker.js change needed) is what makes cross-
  // navigation repeat-detection possible at all. Capped small (verbs only,
  // never arguments - same content rule as `origins`) and evicted alongside
  // an origin's verb-count map, so it never grows the recorded surface in
  // any way the design doc's threat model didn't already cover.
  const MEMORY_KEY = 'lflMemory';
  const MEMORY_ENABLED_KEY = 'lflMemoryEnabled';
  const MEMORY_SCHEMA_VERSION = 1;
  const MEMORY_MAX_ORIGINS = 200;
  const MEMORY_MAX_VERBS_PER_ORIGIN = 64;
  const MEMORY_MAX_RECENT_PER_ORIGIN = 12;
  const MEMORY_REPEAT_THRESHOLD = 3;
  const MEMORY_NUDGE_MAX_UNIT = 6; // longest single repeating verb-sequence unit considered
  // Known-verb-SHAPED (not registry-membership-checked - registry.js stays
  // decoupled from LFL.commandRegistry so this pure module has no dependency
  // on load order): a short bare word, letters/digits/-/_ only, starting
  // with a letter, capped at 24 chars. This is the actual enforcement
  // mechanism behind "arguments are never stored" (design doc §2/§9 sign-off
  // A) - `search "divorce lawyer"`, `fill email with "x@y.com"`, or any
  // other argument-shaped text fails this shape and is silently dropped by
  // recordVerb() below, never persisted.
  const MEMORY_VERB_RE = /^[a-z][a-z0-9_-]{0,23}$/i;

  function createEmptyMemory() {
    return { v: MEMORY_SCHEMA_VERSION, origins: {}, prefs: {}, recent: {} };
  }

  // Schema-version guard (design doc §3) - also the ONE re-validator every
  // memory-mutating function below runs its input through first, so a
  // corrupted/hand-edited/pre-v1 stored value can never propagate garbage
  // into a write; an unrecognized shape (missing/wrong `v`, non-object
  // `origins`/`prefs`/`recent`, a verb entry that isn't
  // known-verb-shaped/{n,lastUsed}-shaped) is dropped rather than repaired -
  // "reset to empty" is always the safe direction for a transparency store
  // whose only job is a best-effort script-suggestion hint, never a
  // security-relevant record.
  function normalizeMemory(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== MEMORY_SCHEMA_VERSION) {
      return createEmptyMemory();
    }
    const origins = {};
    const rawOrigins = (raw.origins && typeof raw.origins === 'object' && !Array.isArray(raw.origins)) ? raw.origins : {};
    for (const originKey of Object.keys(rawOrigins)) {
      const rawVerbs = rawOrigins[originKey];
      if (!rawVerbs || typeof rawVerbs !== 'object' || Array.isArray(rawVerbs)) continue;
      const verbs = {};
      for (const verbKey of Object.keys(rawVerbs)) {
        if (!MEMORY_VERB_RE.test(verbKey)) continue;
        const entry = rawVerbs[verbKey];
        const n = (entry && typeof entry.n === 'number' && entry.n >= 0) ? Math.floor(entry.n) : 0;
        const lastUsed = (entry && typeof entry.lastUsed === 'number' && entry.lastUsed >= 0) ? entry.lastUsed : 0;
        verbs[verbKey] = { n, lastUsed };
      }
      origins[originKey] = verbs;
    }
    const rawPrefs = (raw.prefs && typeof raw.prefs === 'object' && !Array.isArray(raw.prefs)) ? raw.prefs : {};
    // Enumerated-prefs allowlist (design doc §2: "explicit, enumerated keys
    // only") - `nudgeQuiet` is the one preference this phase defines; any
    // other key is dropped rather than passed through, so a future pref
    // always has to be added here deliberately, never silently inherited
    // from whatever happened to be in storage.
    const prefs = {};
    if (typeof rawPrefs.nudgeQuiet === 'boolean') prefs.nudgeQuiet = rawPrefs.nudgeQuiet;
    const recent = {};
    const rawRecent = (raw.recent && typeof raw.recent === 'object' && !Array.isArray(raw.recent)) ? raw.recent : {};
    for (const originKey of Object.keys(rawRecent)) {
      const arr = rawRecent[originKey];
      if (!Array.isArray(arr)) continue;
      const cleaned = arr.filter((v) => typeof v === 'string' && MEMORY_VERB_RE.test(v)).slice(-MEMORY_MAX_RECENT_PER_ORIGIN);
      if (cleaned.length > 0) recent[originKey] = cleaned;
    }
    return { v: MEMORY_SCHEMA_VERSION, origins, prefs, recent };
  }

  // Strips any origin-LIKE input down to scheme+host, http(s) only - the
  // structural half of "arguments/URL-paths are never stored" (design doc
  // §2/§9 sign-off A). Fed a full URL (path/query included) it keeps only
  // the origin; fed a bare host (no scheme, e.g. from a hand-typed `memory
  // forget example.com`) it tries again with an assumed `https://`; fed
  // anything that still doesn't parse to a real http(s) host (an empty
  // string, `javascript:...`, a lone word with no dot that happens to parse
  // as a one-label host but was never meant as one, etc.) it returns null -
  // the caller's job is then to no-op rather than store/act on a guess.
  function normalizeOriginKey(input) {
    const s = typeof input === 'string' ? input.trim() : '';
    if (!s) return null;
    const tryParse = (str) => {
      try {
        const u = new URL(str);
        return u.host ? u : null;
      } catch (_e) {
        return null;
      }
    };
    let u = tryParse(s);
    if (!u) u = tryParse('https://' + s);
    if (!u || !/^https?:$/i.test(u.protocol)) return null;
    return `${u.protocol}//${u.host}`;
  }

  // Known-verb-shaped validator (see MEMORY_VERB_RE's own comment) - the
  // other half of the arity/whitelist wall. Case-normalized to lowercase so
  // `Search`/`search` count as the same recorded verb.
  function normalizeVerbKey(input) {
    const s = typeof input === 'string' ? input.trim() : '';
    if (!s || !MEMORY_VERB_RE.test(s)) return null;
    return s.toLowerCase();
  }

  // THE recording choke point (design doc §2/§3, this build's invariant-1c
  // wall): the ONLY function anywhere in this codebase that writes a verb
  // count into memory. Arity is exactly (memoryObject, origin-string,
  // verb-string) - there is no fourth parameter for an argument to ride in
  // on, and both string inputs are independently re-validated/normalized
  // HERE (never trusted from the caller), so it is structurally impossible
  // for a call site - however it got the string - to persist anything but a
  // short, known-verb-shaped token against a bare scheme+host origin. An
  // invalid origin or verb is a silent no-op (returns the input, schema-
  // normalized but otherwise unchanged) - never a thrown error, since this
  // sits on the hot dispatch path and a malformed call must never be able to
  // break command execution.
  //
  // Pure: never touches chrome.storage.local itself (terminal.js's
  // `_recordMemoryVerb()` owns the get/set round trip) - takes a plain
  // memory object in, returns a new one out, so this is directly unit-
  // testable with zero DOM/extension APIs, same posture as every other pure
  // helper in this file.
  function recordVerb(mem, origin, verb) {
    const base = normalizeMemory(mem);
    const originKey = normalizeOriginKey(origin);
    const verbKey = normalizeVerbKey(verb);
    if (!originKey || !verbKey) return base;
    const now = Date.now();

    const origins = Object.assign({}, base.origins);
    const verbs = Object.assign({}, origins[originKey]);
    const prevN = (verbs[verbKey] && typeof verbs[verbKey].n === 'number') ? verbs[verbKey].n : 0;
    verbs[verbKey] = { n: prevN + 1, lastUsed: now };
    // Cap verbs/origin - LRU evict the stalest (lowest lastUsed) first.
    let verbNames = Object.keys(verbs);
    if (verbNames.length > MEMORY_MAX_VERBS_PER_ORIGIN) {
      verbNames = verbNames.slice().sort((a, b) => verbs[a].lastUsed - verbs[b].lastUsed);
      const excess = verbNames.length - MEMORY_MAX_VERBS_PER_ORIGIN;
      for (let i = 0; i < excess; i++) delete verbs[verbNames[i]];
    }
    origins[originKey] = verbs;

    const recent = Object.assign({}, base.recent);
    const ring = (recent[originKey] || []).concat([verbKey]);
    recent[originKey] = ring.slice(-MEMORY_MAX_RECENT_PER_ORIGIN);

    // Cap origins - LRU evict by each origin's own most-recently-used verb,
    // dropping the matching `recent` ring entry too so the two maps never
    // drift out of sync (an evicted origin's ring would otherwise be dead
    // weight nothing ever reads again).
    let originNames = Object.keys(origins);
    if (originNames.length > MEMORY_MAX_ORIGINS) {
      const latestOf = (o) => Object.keys(origins[o]).reduce((acc, v) => Math.max(acc, origins[o][v].lastUsed || 0), 0);
      originNames = originNames.slice().sort((a, b) => latestOf(a) - latestOf(b));
      const excess = originNames.length - MEMORY_MAX_ORIGINS;
      for (let i = 0; i < excess; i++) {
        delete origins[originNames[i]];
        delete recent[originNames[i]];
      }
    }

    return { v: MEMORY_SCHEMA_VERSION, origins, prefs: Object.assign({}, base.prefs), recent };
  }

  // `memory forget <origin>` - the only other memory writer, and (like
  // recordVerb) pure: returns {ok, mem} or {ok:false, reason}, never touches
  // storage itself.
  function forgetOrigin(mem, origin) {
    const base = normalizeMemory(mem);
    const originKey = normalizeOriginKey(origin);
    if (!originKey) return { ok: false, mem: base, reason: `not a recognizable origin: "${origin}"` };
    if (!Object.prototype.hasOwnProperty.call(base.origins, originKey)) {
      return { ok: false, mem: base, reason: `no record for origin: ${originKey}` };
    }
    const origins = Object.assign({}, base.origins);
    delete origins[originKey];
    const recent = Object.assign({}, base.recent);
    delete recent[originKey];
    return { ok: true, mem: { v: MEMORY_SCHEMA_VERSION, origins, prefs: Object.assign({}, base.prefs), recent } };
  }

  // `memory clear` - wipes everything (origins + prefs + the recent ring),
  // a full reset back to the empty store. Preferences (like the quiet
  // toggle) are deliberately included - "clear" means a clean slate, not a
  // partial one; re-enabling memory and re-choosing quiet/loud afterward is
  // one command each.
  function clearMemory() {
    return createEmptyMemory();
  }

  // `memory quiet` / `memory loud` - the one enumerated preference this
  // phase defines (design doc §9 sign-off D: nudges on by default,
  // silence-able). Pure, same shape as every other memory writer above.
  function setMemoryQuiet(mem, quiet) {
    const base = normalizeMemory(mem);
    const prefs = Object.assign({}, base.prefs, { nudgeQuiet: !!quiet });
    return { v: MEMORY_SCHEMA_VERSION, origins: base.origins, prefs, recent: base.recent };
  }

  // `memory` / `memory show` - the transparency dump (design doc §3: "the
  // user can always see exactly what it knows"). Pure formatter: sorted by
  // each origin's most-recently-used verb (newest first), each origin's own
  // verbs sorted by count (most-used first) - a deterministic, stable
  // rendering for a given memory object, directly unit-testable without any
  // DOM/storage access. `opts.enabled` is the live master-switch state
  // (kept outside `mem` itself - terminal.js tracks it via the separate
  // `lflMemoryEnabled` key, mirroring `lflBrainstormEnabled`'s own posture)
  // so the dump can honestly report on/off even when there is nothing
  // recorded yet.
  function formatMemoryDump(mem, opts) {
    const o = opts || {};
    const base = normalizeMemory(mem);
    const quiet = !!base.prefs.nudgeQuiet;
    const lines = [`memory: ${o.enabled ? 'ON' : 'OFF'} (nudges ${quiet ? 'quiet' : 'on'})`];
    const originNames = Object.keys(base.origins);
    if (originNames.length === 0) {
      lines.push(o.enabled ? '(nothing recorded yet - run some commands)' : '(nothing recorded - memory is off; "memory on" to start)');
      return lines.join('\n');
    }
    const latestOf = (name) => Object.keys(base.origins[name]).reduce((acc, v) => Math.max(acc, base.origins[name][v].lastUsed || 0), 0);
    const sortedOrigins = originNames.slice().sort((a, b) => latestOf(b) - latestOf(a));
    for (const originName of sortedOrigins) {
      const verbs = base.origins[originName];
      const verbNames = Object.keys(verbs).sort((a, b) => verbs[b].n - verbs[a].n);
      const verbTxt = verbNames.map((v) => `${v}(${verbs[v].n})`).join(', ') || '(none)';
      lines.push(`${originName}: ${verbTxt}`);
    }
    return lines.join('\n');
  }

  // Repeat-detector (design doc §4, deterministic-only in M1/M2 - the
  // nudge here is a PRINT, never a model call; `teach save that` is only
  // ever invoked by the human typing it, M3's job to wire up). Pure: takes
  // the origin's `recent` verb ring (chronological, oldest first - exactly
  // `mem.recent[originKey]`, see recordVerb() above) and a threshold N,
  // and answers "does some contiguous unit repeat N times back-to-back at
  // the END of the ring?" - checking the LONGEST plausible unit first (a 3-
  // verb workflow repeated 3x is a more useful nudge than the coincidental
  // 1-verb repeat buried inside it), capped at MEMORY_NUDGE_MAX_UNIT so this
  // stays cheap even against a full-length ring.
  function detectRepeat(recentVerbs, threshold) {
    const ring = Array.isArray(recentVerbs) ? recentVerbs.filter((v) => typeof v === 'string' && v) : [];
    const N = (Number.isFinite(threshold) && threshold > 1) ? Math.floor(threshold) : MEMORY_REPEAT_THRESHOLD;
    const maxL = Math.min(MEMORY_NUDGE_MAX_UNIT, Math.floor(ring.length / N));
    for (let L = maxL; L >= 1; L--) {
      const tailLen = L * N;
      const tail = ring.slice(ring.length - tailLen);
      const unit = tail.slice(0, L);
      let ok = true;
      for (let i = 1; i < N && ok; i++) {
        const chunk = tail.slice(i * L, (i + 1) * L);
        if (chunk.length !== L) { ok = false; break; }
        for (let j = 0; j < L; j++) {
          if (chunk[j] !== unit[j]) { ok = false; break; }
        }
      }
      if (ok) return { fire: true, verbs: unit.slice(), count: N };
    }
    return { fire: false, verbs: [], count: 0 };
  }

  // The nudge line itself (design doc §4's exact worked example). A pure
  // formatter, never emits anything model-facing - `teach save that` is
  // named here only as a hint string a human reads, not invoked.
  function formatNudge(verbs, count) {
    const list = Array.isArray(verbs) ? verbs : [];
    return `you've run "${list.join(', ')}" here ${count} times - type "teach save that" to make it a script`;
  }

  // ---- memory lane M3 (2026-07-16, LFL-TERMINAL-MEMORY-LANE-DESIGN.md
  // §4/§6/§8) - buildMemoryContext(): THE ONE function anywhere in this
  // codebase that turns a stored memory object into text a MODEL will ever
  // see. Wired into exactly one place: terminal.js's `teach` handling, which
  // attaches its output to a BRAINSTORM_LLM_REQUEST message as an OPTIONAL
  // `memoryContext` field (see service-worker.js's buildBrainstormPayload()).
  // The execution lane (LFL_LLM_REQUEST, page-driving) never calls this
  // function and never reads chrome.storage.local's memory key at all - see
  // tests/memory_lane.test.js's M3 isolation section for the byte-identical
  // proof.
  //
  // Caps small on purpose - this is meant to be a SHORT hint, not a data
  // dump: only the top few verbs by count, only the most recent detected
  // repeat pattern, only a bounded number of script names.
  const MEMORY_CONTEXT_MAX_VERBS = 12;
  const MEMORY_CONTEXT_MAX_SCRIPT_NAMES = 20;
  // Script names come from createAliasStore()'s NAME_RE (letters/digits/-/_,
  // starting with a letter), which has no length cap of its own - this is a
  // defensive bound on how much of a hand-typed script name gets echoed into
  // a model prompt, nothing more; it does not change what names are valid to
  // save a script under.
  const MEMORY_CONTEXT_SCRIPT_NAME_MAX_LEN = 40;

  // buildMemoryContext(mem, origin, scriptNames) - reads exactly three
  // things and nothing else:
  //   (a) mem.origins[originKey] - a {verb: {n, lastUsed}} map. Re-validates
  //       every verb key against MEMORY_VERB_RE and every count as a
  //       non-negative number HERE, independently of normalizeMemory()'s own
  //       guarantees (the same "revalidate at every hop" posture recordVerb()
  //       holds itself to, not "trust the last function that touched it").
  //       Only verbKey and n are ever read; lastUsed and any other property
  //       an entry might carry (however it got there) is never touched.
  //   (b) mem.recent[originKey], fed through the existing, pure
  //       detectRepeat() (itself re-filtered to verb-shaped strings here,
  //       belt-and-suspenders on top of normalizeMemory()'s own recent-ring
  //       cleaning) - never printed raw, only its {verbs, count} return
  //       value.
  //   (c) scriptNames - an OPTIONAL third argument (e.g. the keys of
  //       this._aliasStore.listScripts() - scripts are a flat, global
  //       namespace, not part of the `mem` object itself), each
  //       independently checked against NAME_RE and a defensive length cap
  //       before being echoed. Left out of the (mem, origin) contract this
  //       function's arity is measured by (defaulted to `[]`, so
  //       buildMemoryContext.length === 2, matching every other memory
  //       function's "no room for a smuggled extra input" shape) - passing
  //       script names is a caller-side enrichment this function does not
  //       depend on to stay safe without it.
  //
  // NEVER does `JSON.stringify(mem)`, `Object.values(entry)`,
  // `Object.assign({}, entry)`, or any other generic serialization of
  // anything read from storage - every line of the output is built by
  // naming one specific, whitelisted field. That is what makes "whatever
  // got into the store, however it got there, still cannot reach the model
  // as anything but a verb/count/script-name" true by construction rather
  // than by review: tests/memory_lane.test.js's M3 section feeds this
  // function memory hand-seeded with argument-shaped strings in every
  // position it can reach (extra properties on a verb entry, extra
  // top-level keys on `mem` itself, oversized/space-containing script
  // names) and asserts none of it survives into the returned string.
  //
  // Deterministic (sorted output, no Date.now()/Math.random() anywhere in
  // this function) and pure - never touches chrome.storage.local itself,
  // same posture as every other function in this section; the caller
  // already has `mem` in hand.
  function buildMemoryContext(mem, origin, scriptNames = []) {
    const base = normalizeMemory(mem);
    const originKey = normalizeOriginKey(origin);
    const lines = [];

    if (originKey && Object.prototype.hasOwnProperty.call(base.origins, originKey)) {
      const verbs = base.origins[originKey];
      const verbNames = Object.keys(verbs)
        .filter((v) => MEMORY_VERB_RE.test(v))
        .sort((a, b) => {
          const na = (verbs[a] && typeof verbs[a].n === 'number' && verbs[a].n >= 0) ? verbs[a].n : 0;
          const nb = (verbs[b] && typeof verbs[b].n === 'number' && verbs[b].n >= 0) ? verbs[b].n : 0;
          return nb - na;
        })
        .slice(0, MEMORY_CONTEXT_MAX_VERBS);
      if (verbNames.length > 0) {
        const verbTxt = verbNames
          .map((v) => {
            const n = (verbs[v] && typeof verbs[v].n === 'number' && verbs[v].n >= 0) ? Math.floor(verbs[v].n) : 0;
            return `${v}(${n})`;
          })
          .join(', ');
        lines.push(`commands the user has run on this site: ${verbTxt}`);
      }
    }

    if (originKey) {
      const rawRing = (base.recent && Array.isArray(base.recent[originKey])) ? base.recent[originKey] : [];
      const ring = rawRing.filter((v) => typeof v === 'string' && MEMORY_VERB_RE.test(v));
      const rep = detectRepeat(ring, MEMORY_REPEAT_THRESHOLD);
      if (rep.fire) {
        lines.push(`repeated pattern on this site: "${rep.verbs.join(', ')}" (${rep.count} times)`);
      }
    }

    const rawNames = Array.isArray(scriptNames) ? scriptNames : [];
    const cleanNames = rawNames
      .filter((n) => typeof n === 'string' && n.length > 0 && n.length <= MEMORY_CONTEXT_SCRIPT_NAME_MAX_LEN && NAME_RE.test(n))
      .slice(0, MEMORY_CONTEXT_MAX_SCRIPT_NAMES);
    if (cleanNames.length > 0) {
      lines.push(`scripts the user already has: ${cleanNames.join(', ')}`);
    }

    return lines.join('\n');
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
    // popover redesign
    placePanel, defaultAnchor, PANEL_PLACEMENT_MARGIN, PANEL_PLACEMENT_OFFSET,
    // live syntax highlighting
    synSpans,
    // color grammar v2
    SUBCOMMAND_TABLE, richTextSpans, argSpecSpans,
    // memory lane M1/M2
    MEMORY_KEY, MEMORY_ENABLED_KEY, MEMORY_SCHEMA_VERSION, MEMORY_MAX_ORIGINS,
    MEMORY_MAX_VERBS_PER_ORIGIN, MEMORY_MAX_RECENT_PER_ORIGIN, MEMORY_REPEAT_THRESHOLD,
    createEmptyMemory, normalizeMemory, normalizeOriginKey, normalizeVerbKey,
    recordVerb, forgetOrigin, clearMemory, setMemoryQuiet, formatMemoryDump,
    detectRepeat, formatNudge,
    // memory lane M3 (trusted preface into the brainstorm/teach lane only)
    MEMORY_CONTEXT_MAX_VERBS, MEMORY_CONTEXT_MAX_SCRIPT_NAMES,
    MEMORY_CONTEXT_SCRIPT_NAME_MAX_LEN, buildMemoryContext,
  };
});
