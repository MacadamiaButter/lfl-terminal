/**
 * engine.js - deterministic command engine.
 *
 * Every command handled here NEVER touches the LLM. tryDeterministic() returns
 * null when the command doesn't match a known verb, which tells terminal.js to
 * fall through to the LLM path (engine.js knows nothing about the LLM).
 *
 * M3: tryDeterministic()'s dispatch chain below is DELIBERATELY unchanged
 * from M1/M2 - same regex branches, same handlers, same behavior - see
 * registry.js's header comment for why (it's the one part of this build
 * with no direct unit-test coverage of its own; only the separately-run
 * Playwright battery exercises it end to end, and rewriting its dispatch
 * into a fully data-driven lookup during a build pass that can't re-run
 * that battery is a regression risk not worth taking). What IS new: a
 * parallel, purely-declarative `LFL.commandRegistry` (registry.js's
 * createRegistry()) that every command below registers itself into, used
 * ONLY for `help`/`man <cmd>` text generation and for the
 * registry-cannot-extend-model-vocabulary unit test's enumeration of known
 * command names - it never drives dispatch. New M3 Terminal-level commands
 * (go/alias/unalias/macro/unmacro/origins/dev/man) are registered here too,
 * for the same documentation purpose, even though terminal.js dispatches
 * them itself (they need chrome.* / async access this file's synchronous
 * tryDeterministic() contract doesn't have - see terminal.js's header
 * comment).
 */
(function () {
  'use strict';

  window.LFL = window.LFL || {};

  window.LFL.commandRegistry = LFL.registry.createRegistry();
  const reg = LFL.commandRegistry;

  reg.register({ name: 'search', argSpec: 'search "query" | search query', help: 'fill+submit the page search box' });
  reg.register({ name: 'open', argSpec: 'open <link text> | open <N>', help: 'navigate a same-origin link by visible text, or by the number shown in the last `ls` (M4a)' });
  reg.register({ name: 'open!', argSpec: 'open!', help: 'confirm the last cross-origin open' });
  reg.register({ name: 'back', argSpec: 'back', help: 'browser back' });
  reg.register({ name: 'scroll', argSpec: 'scroll up | scroll down', help: 'scroll the page' });
  reg.register({ name: 'extract-links', argSpec: 'extract links', help: 'list visible links (text + href)' });
  reg.register({ name: 'extract-table', argSpec: 'extract table', help: 'dump the first table as aligned text' });
  reg.register({ name: 'log', argSpec: 'log', help: 'show this session\'s proposal/verdict audit log' });
  reg.register({ name: 'budget', argSpec: 'budget', help: 'show remaining LLM-call / executed-action rate-limit budget' });
  reg.register({ name: 'continue', argSpec: 'continue', help: 'resume after a rate-limit pause (M2.3)' });
  reg.register({ name: 'help', argSpec: 'help', help: 'this text' });
  reg.register({ name: 'man', argSpec: 'man <cmd>', help: 'detailed usage for one command (M3)' });
  reg.register({ name: 'clear', argSpec: 'clear', help: 'clear the output pane' });
  // M3 terminal-browser commands (design doc §2/§5/§6) - dispatched by
  // terminal.js, see this file's header comment.
  reg.register({ name: 'go', argSpec: 'go <destination>', help: 'navigate anywhere - literal URL/domain, a defined alias, or (as a last resort) the local model resolves a destination from your typed words alone. First visit to a new origin (or any model-resolved destination) asks for confirmation.' });
  reg.register({ name: 'alias', argSpec: 'alias <name> = <command>', help: 'define a single-command shortcut, e.g. alias wiki = go en.wikipedia.org (M3)' });
  reg.register({ name: 'unalias', argSpec: 'unalias <name>', help: 'remove a defined alias (M3)' });
  reg.register({ name: 'macro', argSpec: 'macro <name> = <cmd1> && <cmd2>...', help: 'define a named && chain, depth-1 (a macro may not reference another macro) (M3)' });
  reg.register({ name: 'unmacro', argSpec: 'unmacro <name>', help: 'remove a defined macro (M3)' });
  reg.register({ name: 'origins', argSpec: 'origins', help: 'list origins visited by this tab this session (M3)' });
  reg.register({ name: 'dev', argSpec: 'dev on | dev off', help: 'toggle the data-lfl-state test hook (off by default - see docs/threat-model.md H2) (M3)' });
  reg.register({ name: 'autoopen', argSpec: 'autoopen', help: 'toggle auto-opening the terminal when you land on THIS site (e.g. your start page) - opt-in per origin, off by default' });
  // scripts v1 (2026-07-14, LFL-TERMINAL-SCRIPTS-DESIGN.md) - dispatched by
  // terminal.js (script/run need chrome.* async access; pause is dispatched
  // as an ordinary chain segment via _dispatchSegment - see that file's
  // _handleScriptCommand()/_handleRunCommand()/_handlePauseSegment()).
  reg.register({ name: 'script', argSpec: 'script new|ls|show|rm <name> | export [<name>|--all] | import', help: 'define/list/show/remove a named, parameterized, multi-step script; export to or import from a plain-text .lflscript file (v1/P2)' });
  reg.register({ name: 'run', argSpec: 'run <name> [args...]', help: 'preview then run a defined script, substituting $1..$9/$@ - Enter to run, Esc to cancel (v1)' });
  reg.register({ name: 'pause', argSpec: 'pause "<instruction>"', help: 'inside a script: stop and hand control back for a manual step (e.g. an index-addressed click); "continue" resumes (v1)' });
  // brainstorm lane (2026-07-15, LFL-TERMINAL-BRAINSTORM-LANE-DESIGN.md) -
  // dispatched by terminal.js (`teach` needs chrome.* async access and the
  // plan-preview approval card, same posture as script/run above). Opt-in,
  // off by default (`teach on`/`teach off`); a bare `teach` prints status.
  reg.register({ name: 'teach', argSpec: 'teach <goal> [as <name>] | teach on|off', help: 'describe a workflow, the local model drafts a script you approve (opt-in, off by default)' });
  // M4a "friction trio" - three deterministic tools that never call the
  // local model, registered here for help/man text same as everything
  // above; dispatched inside tryDeterministic() below except `here`, which
  // is chain-compatible and ALSO dispatched inside tryDeterministic() (it
  // only needs the terminal's already-cached rate-limit budget snapshot via
  // state.rlBudgetCache - see doHere()'s comment - not a fresh async call,
  // so unlike go/alias/macro/dev/origins it does NOT need terminal.js's
  // chrome.*-capable dispatch path).
  reg.register({ name: 'ls', argSpec: 'ls | ls links [filter] | ls buttons [filter] | ls fields [filter]', help: 'numbered listing of visible links/buttons/fields on the page (M4a)' });
  reg.register({ name: 'click', argSpec: 'click <N>', help: 'click the ls-listing item numbered N - same hard blocks as an approved LLM click, no approval card (M4a)' });
  reg.register({ name: 'fill', argSpec: 'fill <N> with <text> | fill <label> with <text>', help: 'fill the ls-listing field numbered N, or matched by its label - credential fields still blocked (M4a)' });
  reg.register({ name: 'read', argSpec: 'read', help: 'extract the page\'s main readable content (article/main, or the largest visible text block) (M4a)' });
  reg.register({ name: 'find', argSpec: 'find <text> | find', help: 'search visible page text and scroll to it; bare find advances to the next match (M4a)' });
  reg.register({
    name: 'highlight',
    argSpec: 'highlight <text> | highlight clear | highlight',
    help: 'mark every visible occurrence of <text> on the page (read-only visual layer, CSS Custom Highlight API - no page DOM is modified); bare highlight shows status; highlight clear removes the marks; matches also feed `find`, so bare `find` steps through them (M4c)',
  });
  reg.register({ name: 'matches', argSpec: 'matches', help: 'list all current highlight/find matches with surrounding context, numbered; step through them with `find` (M4c)' });
  reg.register({ name: 'here', argSpec: 'here', help: 'compact orientation: origin, element counts, search/pagination hints, suggested next commands (M4a)' });
  // funpack v1 (extension/content/funpack.js) - fortune/stats/theme/cowsay
  // are dispatched by terminal.js, not this file's tryDeterministic() chain,
  // because they need chrome.storage.local access (persisted theme choice,
  // stats counters, MOTD day) this file's synchronous DOM-only contract
  // doesn't have - same posture as go/alias/macro/unmacro/origins/dev above.
  // Registered here purely for help/man text and vocabulary enumeration
  // (including did-you-mean's candidate list, via LFL.commandRegistry.names()).
  // MOTD itself has no typed command name to register - it is shown
  // automatically, at most once per calendar day, when the overlay is opened.
  reg.register({ name: 'fortune', argSpec: 'fortune', help: 'print one local-first/privacy one-liner or command tip (funpack v1)' });
  reg.register({ name: 'stats', argSpec: 'stats', help: 'this session\'s command counters, including the share that never touched the model (funpack v1)' });
  reg.register({ name: 'theme', argSpec: 'theme [name]', help: 'switch (or list) the overlay color theme: default, phosphor, amber, paper (funpack v1)' });
  reg.register({ name: 'cowsay', argSpec: 'cowsay <text>', help: 'classic ASCII cow with a word-wrapped, 40-col speech bubble (funpack v1)' });
  // M4b fun pack v2 (extension/content/games.js) - snake/2048 are
  // dispatched by terminal.js's program-mode runner (_enterProgram, design
  // doc §3), not this file's tryDeterministic() chain, for the same reason
  // go/alias/dev/fortune/etc. above are: they need chrome.storage.local
  // (high scores) and setInterval (the tick), neither of which this file's
  // synchronous DOM-only contract has. Registered here purely for help/man
  // text and vocabulary enumeration, same as the funpack v1 block above.
  // Never allowed inside a `&&` chain or a macro body - see registry.js's
  // GAME_NAMES/RESERVED_NAMES and terminal.js's _handleGameCommand().
  reg.register({ name: 'snake', argSpec: 'snake', help: 'classic snake - arrows to move, q or Esc to quit (fun pack v2)' });
  reg.register({ name: '2048', argSpec: '2048', help: '2048 - arrows to slide/merge, q or Esc to quit (fun pack v2)' });
  reg.register({ name: 'games', argSpec: 'games', help: 'list available games and best scores (fun pack v2)' });
  // `sl` - the classic steam-locomotive easter egg. Deliberately hidden
  // (registry.js's `hidden` flag) from the general `help` listing above -
  // easter eggs stay undiscoverable by browsing help - but still fully
  // reachable via `man sl`, since registry.js's get()/manText() ignore
  // `hidden` (it only filters helpText()). Not listed in `games` either
  // (terminal.js's _printGamesList() hardcodes snake/2048 only) and has no
  // chrome.storage.local score entry - no high-score/storage entanglement
  // for this one, by design.
  reg.register({
    name: 'sl',
    argSpec: 'sl',
    hidden: true,
    help: 'steam locomotive easter egg - one silent pass chugging right to left across the terminal (~5s), then exits on its own with a dry one-liner; q or Esc still quit it early, unlike the classic',
  });

  const HELP_TEXT = [
    'deterministic commands (never call the local model):',
    reg.helpText(),
    '',
    '`cmd1 && cmd2 && ...` chains up to 5 ordinary commands (M3) - quote-aware,',
    'any error/block/rejection/Esc clears the rest of the chain.',
    '',
    'a bare number (e.g. "3") after `ls` opens a link, clicks a button, or',
    'names a field to fill, by its listed number (M4a).',
    '',
    'a mistyped command name (e.g. "serach") gets a "did you mean" suggestion',
    'instead of being sent to the local model (M4a) - prefix with "ask" to',
    'force something to the model regardless of how close it looks to a',
    'known command name.',
    '',
    'anything else, or "ask <...>", is sent to the local model as ONE proposed',
    'action. click/fill/select/navigate require your approval (Enter/click',
    'Approve, or Esc/click Reject).',
  ].join('\n');

  function findSearchInput() {
    const selectors = [
      'input[type="search"]',
      '[role="searchbox"]',
      'input[name="q"]',
      'input#q',
      'input[name*="search" i]',
      'input[id*="search" i]',
      'input[placeholder*="search" i]',
      'input[aria-label*="search" i]',
    ];
    for (const sel of selectors) {
      const candidates = document.querySelectorAll(sel);
      for (const el of candidates) {
        if (LFL.axtree.isElementVisible(el)) return el;
      }
    }
    return null;
  }

  function doSearch(query) {
    const input = findSearchInput();
    if (!input) {
      return { output: 'no search box found - try: ask <what you want>' };
    }
    LFL.executor.fillNative(input, query);
    const form = input.form;
    if (form) {
      // Same posture as doOpen()'s cross-origin handling: a search form can
      // point `action` at a different origin than the page it's on. Don't
      // auto-submit that silently - print it instead. See SHOULD-FIX #7 in
      // the security review. form.action (the property, not the attribute)
      // is always an absolute URL, defaulting to the page's own URL when no
      // action attribute is set.
      let actionOrigin = null;
      try {
        actionOrigin = new URL(form.action).origin;
      } catch (_e) { /* unparseable action - treat as same-origin, browser would too */ }
      if (actionOrigin && actionOrigin !== location.origin) {
        return {
          output: `filled search box with "${query}" but the form submits cross-origin (${actionOrigin}) - not auto-submitting; press Enter in the field yourself if you want to proceed`,
        };
      }
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      // FIX 1: form submission is a navigation-initiating action (same
      // reasoning as doOpen's same-origin branch above) - tag it. The
      // cross-origin-form branch just above this one does NOT submit (it
      // only prints a message), so it is left untagged.
      return { output: `submitted search for "${query}"`, navInitiated: true };
    }
    // No enclosing form: simulate Enter, the common pattern for JS-driven search boxes.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    // FIX 1: the synthetic Enter dispatch is the documented mechanism a
    // JS-driven (formless) search box uses to submit-and-navigate - treated
    // identically to the form.requestSubmit()/form.submit() branch above.
    return { output: `filled search box with "${query}" and pressed Enter`, navInitiated: true };
  }

  function visibleLinks() {
    return Array.from(document.querySelectorAll('a[href]')).filter((a) => LFL.axtree.isElementVisible(a));
  }

  function doOpen(linkText, state) {
    // Quoted link text is stripped to what the quotes contain - see
    // stripOuterQuotes()'s own comment (the brainstorm-lane prompt teaches
    // `open "Contact us"`, which must match a link whose text is Contact us).
    const stripped = stripOuterQuotes(linkText);
    const query = stripped.toLowerCase();
    if (!query) return { output: 'usage: open <link text>' };
    const links = visibleLinks();
    let best = null;
    let bestScore = -1;
    let bestLen = Infinity;
    for (const a of links) {
      const text = (a.textContent || '').trim().toLowerCase();
      if (!text) continue;
      let score = -1;
      if (text === query) score = 3;
      else if (text.startsWith(query)) score = 2;
      else if (text.includes(query)) score = 1;
      if (score < 0) continue; // non-matches never tie-break their way in
      // Tie-break equal scores toward the SHORTEST visible text - the link
      // closest to what was actually typed. Live smoke 2026-07-15: on the
      // Eiffel Tower article (no exact-text link visible), first-wins picked
      // the "Eiffel Tower (Delaunay series)" hatnote purely because it
      // appeared earliest among equal prefix matches.
      if (score > bestScore || (score === bestScore && text.length < bestLen)) {
        bestScore = score;
        bestLen = text.length;
        best = a;
      }
    }
    // Echo the STRIPPED text, not the raw arg: echoing the raw arg made a
    // genuine no-match on `open "Eiffel Tower"` print the same doubled-quote
    // message (no visible link matching ""Eiffel Tower"") as the pre-strip
    // bug it replaced - indistinguishable from the fix not being loaded at
    // all (live smoke 2026-07-15, twice).
    if (!best) return { output: `no visible link matching "${stripped}"` };
    let url;
    try {
      url = new URL(best.getAttribute('href'), document.baseURI);
    } catch (_e) {
      return { output: 'link has an unusable href' };
    }
    if (!/^https?:$/.test(url.protocol)) {
      return { output: `refusing to open non-http(s) link: ${url.href}` };
    }
    if (url.origin === location.origin) {
      location.href = url.href;
      // FIX 1 (chain-queue nav race, security verify LOW-1): this branch
      // actually initiates a same-document-unloading navigation. Tag the
      // result so terminal.js's _dispatchSegment() skips the synchronous
      // queue advance and instead lets the arrival check on the NEXT
      // injection drive continuation - same posture `go` already has. The
      // cross-origin branch below does NOT navigate (it only stores a
      // pending confirm and prints a message), so it is deliberately left
      // untagged. See docs/threat-model.md's "Queue risks" section for the
      // full writeup and terminal.js's `navInitiated` handling.
      return { output: `opening "${best.textContent.trim()}" -> ${url.href}`, navInitiated: true };
    }
    state.pendingCrossOriginUrl = url.href;
    return { output: `cross-origin link: ${url.href}\ntype "open!" to confirm navigation off this site` };
  }

  function doOpenConfirm(state) {
    if (!state.pendingCrossOriginUrl) return { output: 'no pending cross-origin open to confirm' };
    const url = state.pendingCrossOriginUrl;
    state.pendingCrossOriginUrl = null;
    location.href = url;
    // FIX 1: navigates (possibly cross-origin, confirming a previously-seen
    // cross-origin link) - tag it. Unlike `open`'s same-origin branch, this
    // does NOT update the queue's recorded expectedOrigin, so a cross-origin
    // `open!` inside a chain halts the queue fail-closed on the next
    // injection's arrival check (same outcome as a chain-internal `back` -
    // see docs/threat-model.md).
    return { output: `opening ${url}`, navInitiated: true };
  }

  function doScroll(dir) {
    const delta = dir === 'up' ? -600 : 600;
    window.scrollBy({ top: delta, behavior: 'auto' });
    return { output: `scrolled ${dir}` };
  }

  function doExtractLinks() {
    const links = visibleLinks();
    if (links.length === 0) return { output: '(no visible links)' };
    const cap = 40;
    const lines = links.slice(0, cap).map((a) => {
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim() || '(no text)';
      let href = a.getAttribute('href') || '';
      try { href = new URL(href, document.baseURI).href; } catch (_e) { /* keep raw */ }
      return `${text}  ->  ${href}`;
    });
    if (links.length > cap) lines.push(`…(${links.length - cap} more links not shown)`);
    return { output: lines.join('\n') };
  }

  function doExtractTable() {
    const table = document.querySelector('table');
    if (!table) return { output: '(no table found on page)' };
    const rows = Array.from(table.querySelectorAll('tr')).slice(0, 30);
    if (rows.length === 0) return { output: '(table has no rows)' };
    const grid = rows.map((tr) =>
      Array.from(tr.querySelectorAll('th,td')).map((cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim()),
    );
    const colCount = Math.max(...grid.map((r) => r.length));
    const widths = new Array(colCount).fill(0);
    for (const row of grid) {
      row.forEach((cell, i) => { widths[i] = Math.max(widths[i], cell.length); });
    }
    const lines = grid.map((row) =>
      row.map((cell, i) => cell.padEnd(widths[i] || 0)).join(' | '),
    );
    return { output: lines.join('\n') };
  }

  // =====================================================================
  // M4a friction trio - three deterministic tools (`ls`+numbered actions,
  // `read`/`find`, `here`+did-you-mean). Reuses axtree.js's index->element
  // map verbatim (LFL.axtree.build()/resolve()) and executor.js's
  // execute() verbatim for click/fill-by-index - no parallel element-
  // indexing or guard logic is introduced here. Functions below are split
  // into PURE helpers (no DOM reads - directly unit-testable, see
  // tests/m4_friction.test.js) and DOM-touching handlers that call them.
  // =====================================================================

  const LS_SECTION_CAP = 40;
  const READ_LINE_CAP = 120;
  // M4c (design doc LFL-TERMINAL-HIGHLIGHT-DESIGN.md §6): cap the total
  // number of Ranges REGISTERED by one `highlight <q>` call, not the number
  // of matching text nodes - a single node can hold many occurrences.
  // Collection stops scanning at the cap (see doHighlight below) rather than
  // collecting everything then slicing, because each Range is retained
  // browser-side and an adversarial or just very long page ("highlight e" on
  // a long article) must not be allowed to build an unbounded list before
  // the cap is applied.
  const HIGHLIGHT_MAX_RANGES = 2000;

  // ---- pure: generic truncation-cap helper (ls sections + read output) ----
  function capLines(lines, cap) {
    const arr = Array.isArray(lines) ? lines : [];
    if (arr.length <= cap) return { lines: arr.slice(), truncated: 0 };
    return { lines: arr.slice(0, cap), truncated: arr.length - cap };
  }

  // ---- pure: classify an axtree entry into ls's three sections ----
  // Deliberately a simple, honest three-way split (link / button / field)
  // over axtree's flat interactive-element model, not a full ARIA-role
  // taxonomy: anything not a link or button-like control falls into
  // "fields" (textbox/combobox/checkbox/radio/switch/searchbox/select/
  // textarea/contenteditable and other less-common interactive roles like
  // tab/menuitem/slider). This is a build decision, not an axtree change -
  // fill's own tag/isContentEditable/isPasswordField checks in executor.js
  // remain the real gate on what's actually fillable; ls's "fields" bucket
  // is only a display grouping.
  function classifyEntry(entry) {
    const tag = ((entry && entry.tag) || '').toLowerCase();
    const role = ((entry && entry.role) || '').toLowerCase();
    const extra = (entry && entry.extra) || '';
    if (tag === 'a' || role === 'link') return 'link';
    if (tag === 'button' || role === 'button') return 'button';
    if (tag === 'input' && /type=(submit|button|reset)\b/.test(extra)) return 'button';
    return 'field';
  }

  // ---- pure: render one listing line, same shape axtree.serialize() uses ----
  function formatListingEntry(e) {
    const extra = e.extra ? ` (${e.extra})` : '';
    return `[${e.index}] ${e.role} "${e.name}"${extra}`;
  }

  // ---- pure: case-insensitive substring filter on an entry's accessible name ----
  function filterEntriesByText(entries, filter) {
    const f = (filter || '').trim().toLowerCase();
    if (!f) return entries.slice();
    return entries.filter((e) => (e.name || '').toLowerCase().includes(f));
  }

  function sectionLines(entries, kind, filter) {
    const filtered = filterEntriesByText(entries.filter((e) => classifyEntry(e) === kind), filter);
    const { lines, truncated } = capLines(filtered.map(formatListingEntry), LS_SECTION_CAP);
    if (truncated > 0) lines.push(`(${truncated} more)`);
    return lines;
  }

  // ---- pure: fill-by-label matching (exact wins, else unique substring, else ambiguous) ----
  // candidates: array of axtree entries already filtered to "field"-classified
  // (fillableFieldEntries()). Returns exactly one of:
  //   { match: entry }        - unambiguous hit (exact name match wins over
  //                              substring; a single substring hit if no
  //                              exact hit exists)
  //   { ambiguous: [entries] } - more than one candidate at the winning tier
  //   { none: true }           - nothing matched at all
  function pickLabelMatch(candidates, label) {
    const l = (label || '').trim().toLowerCase();
    if (!l) return { none: true };
    const exact = candidates.filter((e) => (e.name || '').trim().toLowerCase() === l);
    if (exact.length === 1) return { match: exact[0] };
    if (exact.length > 1) return { ambiguous: exact };
    const substr = candidates.filter((e) => (e.name || '').toLowerCase().includes(l));
    if (substr.length === 1) return { match: substr[0] };
    if (substr.length > 1) return { ambiguous: substr };
    return { none: true };
  }

  function fillableFieldEntries(entries) {
    return entries.filter((e) => classifyEntry(e) === 'field');
  }

  // ---- pure: strip ONE symmetric pair of surrounding double quotes ----
  // The brainstorm lane's system prompt (and plain shell habit) teaches
  // quoted arguments - `open "Contact us"`, `fill email with "me@example.com"`
  // - and `search` already tolerates them, but `open`/`fill` previously
  // matched the quote characters LITERALLY (live smoke 2026-07-15:
  // `open "Eiffel Tower"` -> no visible link matching ""Eiffel Tower"").
  // Only a symmetric OUTER pair is stripped; interior quotes are preserved
  // and an unmatched quote is left alone (fail toward matching what the
  // user actually typed rather than guessing).
  function stripOuterQuotes(s) {
    const t = (s || '').trim();
    if (t.length >= 2 && t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') {
      return t.slice(1, -1).trim();
    }
    return t;
  }

  // ---- pure: does a visible text node's content match a find query? ----
  function textIncludesQuery(text, query) {
    if (!text || !query) return false;
    return text.toLowerCase().includes(query.toLowerCase());
  }

  // ---- pure: M4c `highlight` helpers (design doc §2/§6/§7) ----

  // Every non-overlapping, case-insensitive occurrence of `query` inside one
  // node's `text`, as [{start, end}] offsets. `find`'s own matching is
  // node-level (textIncludesQuery above just answers yes/no); highlight
  // needs the finer OCCURRENCE unit because a Range must cover exactly the
  // matched substring, and one node's text can contain the query more than
  // once. Non-overlapping means the next scan resumes at the END of the
  // previous match - so "aa" against "aaa" yields exactly one match, not two
  // overlapping ones.
  function findOccurrenceOffsets(text, query) {
    const out = [];
    if (!text || !query) return out;
    const hay = text.toLowerCase();
    const needle = query.toLowerCase();
    let i = 0;
    while (i <= hay.length - needle.length) {
      const idx = hay.indexOf(needle, i);
      if (idx === -1) break;
      out.push({ start: idx, end: idx + needle.length });
      i = idx + needle.length;
    }
    return out;
  }

  // Parses `highlight`'s captured arg text into a dumb, three-way shape, so
  // both tryDeterministic's dispatch branches and doHighlight itself stay
  // dumb (§7). Recognizing "clear" here too (in addition to the dedicated
  // `/^highlight\s+clear$/i` dispatch branch, checked first) is deliberate
  // defense in depth, not dead code: it keeps this parser correct on its own
  // terms for anyone calling doHighlight() directly (e.g. this file's own
  // tests), not just reachable-through-dispatch input.
  function parseHighlightArg(raw) {
    const q = (raw || '').trim();
    if (!q) return { mode: 'status' };
    if (/^clear$/i.test(q)) return { mode: 'clear' };
    return { mode: 'set', query: q };
  }

  // The `highlight <q>` result line - all three variants (0 matches, N
  // matches, capped). Keeps doHighlight thin: one function owns every
  // wording decision for this one line.
  function formatHighlightSummary(count, capped, cap, query) {
    if (count === 0) return `no matches for "${query}"`;
    if (capped) return `highlighted ${cap} of ${cap}+ matches for "${query}" (capped)`;
    return `highlighted ${count} matches`;
  }

  // `matches` command helpers (2026-07-14). matchSnippet returns a one-line,
  // whitespace-collapsed slice of `text` centred on the first case-insensitive
  // occurrence of `query`, with `radius` chars of context each side and "..."
  // where it was trimmed. Pure and DOM-free (it works on a node's textContent
  // string), so it is unit-tested directly; falls back to a head-truncation
  // when the query is empty or (defensively) not present in the text.
  const MATCH_SNIPPET_RADIUS = 32;
  const MATCH_LIST_CAP = 50;
  function matchSnippet(text, query, radius) {
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const qq = String(query == null ? '' : query);
    const windowLen = radius * 2 + qq.length;
    const headTrunc = () => (t.length > windowLen ? `${t.slice(0, windowLen)}...` : t);
    if (!qq) return headTrunc();
    const idx = t.toLowerCase().indexOf(qq.toLowerCase());
    if (idx < 0) return headTrunc();
    const start = Math.max(0, idx - radius);
    const end = Math.min(t.length, idx + qq.length + radius);
    return `${start > 0 ? '...' : ''}${t.slice(start, end)}${end < t.length ? '...' : ''}`;
  }

  // ---- pure: suggested-commands rules for `here` ----
  function suggestCommands(stats) {
    const s = stats || {};
    const suggestions = [];
    if (s.searchBoxPresent) suggestions.push('search "..."');
    if (s.linkCount > 10) suggestions.push('ls links');
    if (s.tableCount > 0) suggestions.push('extract table');
    if (s.articlePresent) suggestions.push('read');
    if (suggestions.length < 2) suggestions.push('ls');
    if (suggestions.length < 2) suggestions.push('help');
    return suggestions.slice(0, 4);
  }

  // ---- pure: format the `here` report from precomputed stats/budget ----
  function formatHereReport(stats, suggestions, budget) {
    const s = stats || {};
    const b = budget || { llmRemaining: '?', llmMax: '?', actionRemaining: '?', actionMax: '?', paused: false };
    return [
      `origin: ${s.origin || '(unknown)'}`,
      `title: ${s.title || '(untitled)'}`,
      `links: ${s.linkCount || 0}  buttons: ${s.buttonCount || 0}  fields: ${s.fieldCount || 0}  forms: ${s.formCount || 0}  tables: ${s.tableCount || 0}`,
      `search box: ${s.searchBoxPresent ? 'yes' : 'no'}`,
      `pagination: ${s.paginationHint ? 'next-page link detected' : 'none detected'}`,
      `listing context: ${s.listingActive ? `active (${s.listingCount} items - see \`ls\`)` : 'none - run `ls`'}`,
      `budget: llm ${b.llmRemaining}/${b.llmMax} · actions ${b.actionRemaining}/${b.actionMax}${b.paused ? ' · PAUSED' : ''}`,
      `try: ${(suggestions || []).join(' | ')}`,
    ].join('\n');
  }

  // =====================================================================
  // DOM-touching handlers (thin - delegate real work to the pure helpers
  // above wherever possible)
  // =====================================================================

  function isFillableFieldEl(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return !['submit', 'button', 'reset', 'checkbox', 'radio', 'image', 'hidden', 'file'].includes(type);
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function doLs(kind, filter, state) {
    const built = LFL.axtree.build();
    state.listingContext = { entries: built.entries, map: built.map, notes: built.notes };
    const entries = built.entries;
    if (kind === 'all') {
      const parts = [];
      for (const sect of ['link', 'button', 'field']) {
        const count = entries.filter((e) => classifyEntry(e) === sect).length;
        const label = sect === 'link' ? 'links' : sect === 'button' ? 'buttons' : 'fields';
        const lines = sectionLines(entries, sect, null);
        parts.push(`${label} (${count}):`);
        parts.push(lines.length ? lines.map((l) => `  ${l}`).join('\n') : '  (none)');
      }
      return { output: parts.join('\n') };
    }
    const lines = sectionLines(entries, kind, filter);
    if (lines.length === 0) {
      return { output: `(no ${kind}${filter ? ` matching "${filter}"` : ''})` };
    }
    return { output: lines.join('\n') };
  }

  function resolveListingEntry(state, n) {
    if (!state.listingContext) return { error: 'no listing - run `ls` first' };
    const entry = state.listingContext.entries.find((e) => e.index === n);
    if (!entry) return { error: `no such item: [${n}] - run \`ls\` again` };
    return { entry };
  }

  // `open <N>` - mirrors doOpen()'s same-origin/cross-origin/non-http(s)
  // posture exactly (same navInitiated/pendingCrossOriginUrl semantics -
  // reused, not reimplemented), resolved against the LIVE element from the
  // listing context's map instead of a fresh link-text search. A link
  // living inside a same-origin iframe is intentionally still navigated via
  // the TOP document's location (same posture as doOpen(), which only ever
  // considered top-document links in the first place) - a build decision,
  // not an oversight; see this build's final report.
  function doOpenIndex(n, state) {
    const found = resolveListingEntry(state, n);
    if (found.error) return { output: found.error };
    if (classifyEntry(found.entry) !== 'link') {
      return { output: `[${n}] is not a link - try \`click ${n}\`` };
    }
    const el = LFL.axtree.resolve(state.listingContext.map, n);
    if (!el) return { output: `[${n}] is stale or no longer visible - re-run \`ls\`` };
    const href = typeof el.getAttribute === 'function' ? el.getAttribute('href') : null;
    if (!href) return { output: `[${n}] has no usable href` };
    const opts = (window.LFL.axtree && typeof LFL.axtree.frameOptsFor === 'function') ? LFL.axtree.frameOptsFor(el) : undefined;
    const baseURI = (opts && opts.baseURI) || document.baseURI;
    const origin = (opts && opts.origin) || location.origin;
    let url;
    try {
      url = new URL(href, baseURI);
    } catch (_e) {
      return { output: `[${n}] has an unusable href` };
    }
    if (!/^https?:$/.test(url.protocol)) {
      return { output: `refusing to open non-http(s) link: ${url.href}` };
    }
    if (url.origin === origin) {
      location.href = url.href;
      // Same reasoning as doOpen()'s same-origin branch (see its own
      // comment) - this initiates a real navigation, so the chain queue
      // must defer its advance to the next injection's arrival check.
      return { output: `opening [${n}] "${found.entry.name}" -> ${url.href}`, navInitiated: true };
    }
    state.pendingCrossOriginUrl = url.href;
    return { output: `cross-origin link: ${url.href}\ntype "open!" to confirm navigation off this site` };
  }

  // `click <N>` - reuses LFL.executor.execute() verbatim, so every hard
  // block (credential guard is fill/select-only, but the click-target
  // scheme/origin guard and nav-watch arming) applies exactly as it does
  // for an APPROVED LLM click. Deliberately no approval card: a
  // deterministic, user-typed `click <N>` is direct user intent (same
  // posture `search`/`open` already have) - the hard blocks are what stay
  // unconditional, not the approval card. NOT tagged navInitiated even when
  // the click happens to navigate - executor.js's click branch has no way
  // to know in advance whether el.click() will trigger a navigation (unlike
  // engine.js's own doOpen(), which controls location.href directly), so
  // chain continuation is left to nav-watch's re-injection + the queue's own
  // arrival check on the next command, same as any LLM-approved click always
  // has been. See docs/threat-model.md's M4a section.
  function doClickIndex(n, state) {
    const found = resolveListingEntry(state, n);
    if (found.error) return { output: found.error };
    const result = LFL.executor.execute({ action: 'click', element: n }, state.listingContext.map);
    return { output: result.message };
  }

  function doFillIndex(n, text, state) {
    const found = resolveListingEntry(state, n);
    if (found.error) return { output: found.error };
    const result = LFL.executor.execute({ action: 'fill', element: n, value: text }, state.listingContext.map);
    return { output: result.message };
  }

  function doFillLabel(label, text, state) {
    // fill-by-label used to demand the `ls` ritual first ("no listing - run
    // `ls` first"), which a taught script (brainstorm lane, live smoke
    // 2026-07-15) can never have performed - the prompt teaches
    // `fill <label> with "<text>"` with no mention of `ls`. Build the SAME
    // deterministic listing doLs() builds, fresh, right before use: a fresh
    // snapshot is strictly safer than a stale one (same live-DOM resolve
    // either way), and everything downstream is unchanged - doFillIndex()
    // still routes through executor.execute(), whose hard blocks
    // (credential fields included) apply exactly as before.
    if (!state.listingContext) {
      const built = LFL.axtree.build();
      state.listingContext = { entries: built.entries, map: built.map, notes: built.notes };
    }
    const fields = fillableFieldEntries(state.listingContext.entries);
    const res = pickLabelMatch(fields, label);
    if (res.none) return { output: `no fillable field matching "${label}" - try \`ls fields\`` };
    if (res.ambiguous) {
      const candidates = res.ambiguous.map(formatListingEntry).join('\n');
      return { output: `ambiguous field "${label}" - candidates:\n${candidates}\nbe more specific, or use \`fill <N> with ...\`` };
    }
    return doFillIndex(res.match.index, text, state);
  }

  // Bare `<N>` - default action by the listing entry's type. Never reached
  // while awaiting approval: the input is readonly in that mode (see
  // terminal.js's proposalEl/inputEl.readOnly handling), so this branch is
  // only ever dispatched from idle mode by construction, not by an explicit
  // check here.
  function doBareNumber(n, state) {
    const found = resolveListingEntry(state, n);
    if (found.error) return { output: found.error };
    const kind = classifyEntry(found.entry);
    if (kind === 'link') return doOpenIndex(n, state);
    if (kind === 'button') return doClickIndex(n, state);
    return { output: `field [${n}]: use \`fill ${n} with <text>\`` };
  }

  // ---- `read` ----

  const READ_EXCLUDE_TAGS = new Set(['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript']);

  function pickReadRoot() {
    const preferred = ['article', 'main', '[role="main"]'];
    for (const sel of preferred) {
      const el = document.querySelector(sel);
      if (el && LFL.axtree.isElementVisible(el)) return el;
    }
    // Fallback: largest-visible-text-block heuristic - simple and honest,
    // not a real readability algorithm. Deliberately does not try to dedupe
    // nested candidates (a child block's text is also counted inside its
    // parent's) - picking by raw textContent length still tends to find the
    // real content region on ordinary pages, and overengineering this was
    // explicitly out of scope for M4a.
    const candidates = document.querySelectorAll('div,section,td');
    let best = null;
    let bestLen = 0;
    for (const el of candidates) {
      if (READ_EXCLUDE_TAGS.has(el.tagName.toLowerCase())) continue;
      if (!LFL.axtree.isElementVisible(el)) continue;
      const len = (el.textContent || '').trim().length;
      if (len > bestLen) { bestLen = len; best = el; }
    }
    return best || document.body;
  }

  function extractReadLines(root) {
    const nodes = root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li');
    const lines = [];
    for (const n of nodes) {
      if (!LFL.axtree.isElementVisible(n)) continue;
      const text = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const tag = n.tagName.toLowerCase();
      if (tag === 'h1' || tag === 'h2') lines.push(`# ${text}`);
      else if (/^h[3-6]$/.test(tag)) lines.push(`## ${text}`);
      else lines.push(text);
    }
    if (lines.length === 0) {
      const text = (root.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
    }
    return lines;
  }

  function doRead() {
    const root = pickReadRoot();
    if (!root) return { output: '(no readable content found)' };
    const lines = extractReadLines(root);
    if (lines.length === 0) return { output: '(no readable text found)' };
    const { lines: shown, truncated } = capLines(lines, READ_LINE_CAP);
    if (truncated > 0) shown.push(`…(${truncated} more lines truncated)`);
    return { output: shown.join('\n') };
  }

  // ---- `find` ----

  const FIND_HIGHLIGHT_MS = 1500;

  function collectVisibleTextMatches(query) {
    const matches = [];
    if (typeof document.createTreeWalker !== 'function') return matches;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!textIncludesQuery(node.textContent, query)) return NodeFilter.FILTER_SKIP;
        const parent = node.parentElement;
        if (!parent || !LFL.axtree.isElementVisible(parent)) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n = walker.nextNode();
    while (n) { matches.push(n); n = walker.nextNode(); }
    return matches;
  }

  // Scrolls the match into view and applies a temporary inline style
  // highlight, restored after FIND_HIGHLIGHT_MS - no stylesheet is injected
  // into the page (H3-style posture: this extension never writes markup/CSS
  // rules a page could observe as a persistent artifact).
  function highlightAndScrollMatch(node) {
    const parent = node && node.parentElement;
    if (!parent || typeof parent.scrollIntoView !== 'function') return;
    parent.scrollIntoView({ block: 'center' });
    const prevOutline = parent.style.outline;
    const prevBg = parent.style.backgroundColor;
    parent.style.outline = '2px solid #f5a623';
    parent.style.backgroundColor = 'rgba(245,166,35,0.25)';
    setTimeout(() => {
      parent.style.outline = prevOutline;
      parent.style.backgroundColor = prevBg;
    }, FIND_HIGHLIGHT_MS);
  }

  function doFind(argText, state) {
    const q = (argText || '').trim();
    if (!q) {
      const ctx = state.findContext;
      if (!ctx || !ctx.matches || ctx.matches.length === 0) {
        return { output: 'no active find - try: find <text>' };
      }
      ctx.idx = (ctx.idx + 1) % ctx.matches.length;
      highlightAndScrollMatch(ctx.matches[ctx.idx]);
      return { output: `match ${ctx.idx + 1}/${ctx.matches.length}` };
    }
    const matches = collectVisibleTextMatches(q);
    if (matches.length === 0) {
      state.findContext = null;
      return { output: `no matches for "${q}"` };
    }
    state.findContext = { query: q, matches, idx: 0 };
    highlightAndScrollMatch(matches[0]);
    return { output: `match 1/${matches.length}` };
  }

  // ---- M4c: `highlight` (persistent visual match layer, see design doc
  // LFL-TERMINAL-HIGHLIGHT-DESIGN.md) ----
  //
  // Reuses collectVisibleTextMatches() above - the SAME collector `find`
  // calls - as the one match engine (design doc §2): one collector, one
  // definition of "a visible match". Renders via the CSS Custom Highlight
  // API (`CSS.highlights` + `Range` + a `::highlight()` rule), never by
  // wrapping page text in injected <span> elements - zero page-DOM
  // mutation, see the design doc §3 for the full rationale and the one
  // disclosed, owner-accepted deviation from `highlightAndScrollMatch`'s
  // "never inject page-observable CSS" posture above: while a highlight is
  // active, the page CAN read/delete our `CSS.highlights` entry and our
  // adopted stylesheet. That artifact is inert decoration (§3) - it cannot
  // change layout, capture input, or carry data, and nothing in this
  // extension ever reads it back. THE RULE, stated plainly and mirrored
  // verbatim in docs/threat-model.md's M4c section: a highlight is never a
  // trust surface - a hostile page can hide, remove, or forge on-page marks;
  // no user or extension flow may treat a painted mark as proof of anything.
  // The authoritative datum is always the match COUNT this file computes
  // from the DOM and prints inside the closed-shadow terminal.

  const HL_NAME = 'lfl-hl';
  const HL_CSS = `::highlight(${HL_NAME}){background-color:rgba(245,166,35,.45);color:#111;}`;
  const HL_UNSUPPORTED_MSG = 'highlight: not supported by this browser (CSS Custom Highlight API required)';

  // Chrome 105+ (well within this project's Chrome >=144 floor) - NO span
  // fallback if missing (design doc §3): fail closed with HL_UNSUPPORTED_MSG.
  function highlightApiAvailable() {
    return typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
  }

  // Module-level handle for the one constructed stylesheet this feature ever
  // installs - lets teardownHighlight() remove exactly the sheet it added
  // (never touching any other entry a page or another extension put in
  // document.adoptedStyleSheets) and lets installHighlightStylesheet() be a
  // cheap no-op on the (common) "already installed" path.
  let hlStyleSheet = null;

  // Append-only (never replace() on the array itself), try/catch, fail
  // closed - see design doc §3's "one deviation that needs sign-off".
  function installHighlightStylesheet() {
    if (hlStyleSheet) return true;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(HL_CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      hlStyleSheet = sheet;
      return true;
    } catch (_e) {
      return false;
    }
  }

  function removeHighlightStylesheet() {
    if (!hlStyleSheet) return;
    try {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== hlStyleSheet);
    } catch (_e) { /* nothing more we can do - not worth surfacing to the user */ }
    hlStyleSheet = null;
  }

  // Single choke point for every clear path (design doc §5): `highlight
  // clear`, a replacing `highlight <newquery>`, and the global `clear`
  // branch below all call this - mirrors _exitProgram's one-exit-path
  // discipline (terminal.js). Full navigation needs no call at all: the
  // document (and with it CSS.highlights, a per-document registry) simply
  // dies, and the fresh injection constructs a fresh `state`.
  function teardownHighlight(state) {
    try { if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete(HL_NAME); } catch (_e) {}
    removeHighlightStylesheet();
    state.highlightContext = null;
  }

  function doHighlightClear(state) {
    if (!state.highlightContext) return { output: 'no active highlight' };
    const { query } = state.highlightContext;
    teardownHighlight(state);
    // design doc §5 item 1: findContext is only nulled if it still belongs
    // to THIS highlight's query - a later `find <other>` already retargeted
    // findContext on its own and that context is left alone.
    if (state.findContext && state.findContext.query === query) state.findContext = null;
    return { output: 'highlight cleared' };
  }

  function doHighlight(argText, state) {
    const parsed = parseHighlightArg(argText);
    if (parsed.mode === 'clear') return doHighlightClear(state);
    if (parsed.mode === 'status') {
      const ctx = state.highlightContext;
      if (!ctx) return { output: 'no active highlight - try: highlight <text>' };
      return { output: `highlight: "${ctx.query}" - ${ctx.count} matches marked${ctx.capped ? ' (capped)' : ''}` };
    }
    // mode === 'set' - fail closed BEFORE touching anything, per §3.
    if (!highlightApiAvailable()) return { output: HL_UNSUPPORTED_MSG };
    const q = parsed.query;
    // Replace semantics (§2/§5): tear down any previous paint first, so a
    // failed retarget (no matches below) can never leave stale marks for
    // the OLD query lying around - "stale amber lies" is explicitly the
    // thing §6 rules out.
    teardownHighlight(state);
    const matches = collectVisibleTextMatches(q);
    if (matches.length === 0) {
      state.findContext = null; // mirrors doFind's own miss posture above
      return { output: formatHighlightSummary(0, false, HIGHLIGHT_MAX_RANGES, q) };
    }
    // Build one Range per OCCURRENCE (not per node - a node's text can
    // contain the query more than once, §2). Stop scanning at the cap
    // rather than collect-then-slice (§6): each Range is retained
    // browser-side, so an adversarial or just very long page must not be
    // allowed to build an unbounded list before the cap kicks in.
    const ranges = [];
    let capped = false;
    scan:
    for (const node of matches) {
      const offsets = findOccurrenceOffsets(node.textContent || '', q);
      for (const off of offsets) {
        if (ranges.length >= HIGHLIGHT_MAX_RANGES) { capped = true; break scan; }
        try {
          const r = new Range();
          r.setStart(node, off.start);
          r.setEnd(node, off.end);
          ranges.push(r);
        } catch (_e) {
          // A hostile/live page mutated this node between collection and
          // Range construction - skip this one occurrence, keep scanning
          // the rest (graceful decay, same posture as the Highlight API's
          // own documented behavior for a Range whose node is later removed).
        }
      }
    }
    installHighlightStylesheet(); // best-effort; painting still proceeds even if styling failed to install (matches are tracked either way via CSS.highlights, they would just render unstyled) - see removeHighlightStylesheet() for the matching teardown half.
    try {
      CSS.highlights.set(HL_NAME, new Highlight(...ranges));
    } catch (_e) {
      return { output: HL_UNSUPPORTED_MSG };
    }
    state.highlightContext = { query: q, count: ranges.length, capped };
    // Populates the SAME state.findContext `find` reads (§2) - idx: -1
    // (not find's own idx: 0) is deliberate: highlight scrolls nowhere
    // itself, so the FIRST bare `find` afterwards should visit match 1, not
    // skip to match 2.
    state.findContext = { query: q, matches, idx: -1 };
    // discoverability hint (friction find 2026-07-14): the bare count did not
    // tell the user how to SEE the matches, so intuitive phrases like "show
    // matches" leaked to the model and returned noise. Point at `matches`.
    return { output: `${formatHighlightSummary(ranges.length, capped, HIGHLIGHT_MAX_RANGES, q)} - type "matches" to list them` };
  }

  // `matches` - list the current find/highlight matches with surrounding
  // context, one numbered line each, marking the active `find` cursor with ">".
  // Read-only and deterministic (never the model); reuses the SAME
  // state.findContext that `find` navigates and `highlight` populates, so the
  // list and `find`'s "match X/N" stepping stay in lockstep (node-level, per
  // the highlight design doc section 2 - a node with several occurrences is one
  // entry). Added because typing an intuitive phrase like "show matches"
  // otherwise fell through to the LLM and came back with an unrelated answer.
  function doMatches(state) {
    const ctx = state.findContext;
    if (!ctx || !ctx.matches || ctx.matches.length === 0) {
      return { output: 'no matches - run "highlight <text>" or "find <text>" first' };
    }
    const q = ctx.query;
    const total = ctx.matches.length;
    const shown = ctx.matches.slice(0, MATCH_LIST_CAP);
    const lines = shown.map((node, i) => {
      const cursor = (i === ctx.idx) ? '>' : ' ';
      const snippet = matchSnippet((node && node.textContent) || '', q, MATCH_SNIPPET_RADIUS);
      return `${cursor}${i + 1}. ${snippet}`;
    });
    const capNote = total > MATCH_LIST_CAP ? ` (showing first ${MATCH_LIST_CAP})` : '';
    const header = `${total} match${total === 1 ? '' : 'es'} for "${q}"${capNote}`;
    return { output: `${header}\n${lines.join('\n')}` };
  }

  // ---- `here` ----

  function detectPaginationHint() {
    const linkNext = document.querySelector('link[rel="next"]');
    if (linkNext && linkNext.getAttribute('href')) return true;
    return visibleLinks().some((a) => {
      const text = (a.textContent || '').trim();
      return /^next\b/i.test(text) || /\bnext\s*page\b/i.test(text);
    });
  }

  function computeHereStats(state) {
    const links = visibleLinks();
    const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]'))
      .filter((el) => LFL.axtree.isElementVisible(el));
    const fields = Array.from(document.querySelectorAll('input,textarea,select,[contenteditable="true"]'))
      .filter((el) => LFL.axtree.isElementVisible(el) && isFillableFieldEl(el));
    return {
      origin: location.origin,
      title: document.title,
      linkCount: links.length,
      buttonCount: buttons.length,
      fieldCount: fields.length,
      formCount: document.querySelectorAll('form').length,
      tableCount: document.querySelectorAll('table').length,
      searchBoxPresent: !!findSearchInput(),
      paginationHint: detectPaginationHint(),
      articlePresent: !!document.querySelector('article,main,[role="main"]'),
      listingActive: !!state.listingContext,
      listingCount: state.listingContext ? state.listingContext.entries.length : 0,
    };
  }

  // `here` needs the rate-limit budget line, but - unlike go/alias/macro/
  // dev/origins - does NOT need a fresh async SW round trip to get it:
  // terminal.js mirrors its already-cached snapshot onto state.rlBudgetCache
  // (see terminal.js's constructor / _rlSend()) precisely so `here` can stay
  // fully synchronous and chain-compatible, going through this file's
  // ordinary tryDeterministic() contract like every other page-driving verb
  // instead of terminal.js's separate chrome.*-capable dispatch path.
  function doHere(state) {
    const stats = computeHereStats(state);
    const suggestions = suggestCommands(stats);
    const budget = state.rlBudgetCache || null;
    return { output: formatHereReport(stats, suggestions, budget) };
  }

  /**
   * @param {string} raw - trimmed raw command text
   * @param {object} state - terminal state (used for open!/pending cross-origin, audit log)
   * @returns {{output: string} | null} null means "not a deterministic command"
   */
  function tryDeterministic(raw, state) {
    const trimmed = raw.trim();
    if (trimmed === '') return { output: '' };
    if (/^help$/i.test(trimmed)) return { output: HELP_TEXT };
    if (/^clear$/i.test(trimmed)) {
      // M4a: the ls-listing context and any active find are page-scoped,
      // human-visible state - `clear` is an explicit "start fresh" gesture,
      // so reset both here too (they also naturally die on navigation, since
      // `state` itself is rebuilt from scratch by the next content-script
      // injection - see terminal.js's constructor).
      state.listingContext = null;
      state.findContext = null;
      // M4c: same "start fresh" gesture - also tear down any active
      // highlight paint + its adopted stylesheet (design doc §5 item 3).
      teardownHighlight(state);
      return { output: '', clear: true };
    }
    if (/^log$/i.test(trimmed)) return { output: LFL.auditLog ? LFL.auditLog.render() : '(no audit log)' };
    if (/^back$/i.test(trimmed)) {
      history.back();
      // FIX 1: history.back()'s destination is statically UNKNOWABLE here
      // (browser history, not a URL this code ever sees) - tag it as
      // navigation-initiated anyway so _dispatchSegment() defers to the
      // arrival check on the next injection rather than advancing the
      // queue synchronously against the old document. Because `back` never
      // updates the queue's recorded expectedOrigin, that arrival check
      // fails closed for a cross-origin `back` (halts the queue) and
      // passes for a same-origin one (continues) - see
      // docs/threat-model.md's "Queue risks" section.
      return { output: 'back', navInitiated: true };
    }
    if (/^scroll\s+up$/i.test(trimmed)) return doScroll('up');
    if (/^scroll\s+down$/i.test(trimmed)) return doScroll('down');
    if (/^extract\s+links$/i.test(trimmed)) return doExtractLinks();
    if (/^extract\s+table$/i.test(trimmed)) return doExtractTable();
    if (/^open!$/i.test(trimmed)) return doOpenConfirm(state);
    if (/^read$/i.test(trimmed)) return doRead();
    if (/^here$/i.test(trimmed)) return doHere(state);

    let m = trimmed.match(/^man\s+(\S+)$/i);
    if (m) return { output: reg.manText(m[1]) };

    // ---- M4a: `ls` + numbered actions ----
    if (/^ls$/i.test(trimmed)) return doLs('all', null, state);
    m = trimmed.match(/^ls\s+links(?:\s+(.+))?$/i);
    if (m) return doLs('link', m[1] || null, state);
    m = trimmed.match(/^ls\s+buttons(?:\s+(.+))?$/i);
    if (m) return doLs('button', m[1] || null, state);
    m = trimmed.match(/^ls\s+fields(?:\s+(.+))?$/i);
    if (m) return doLs('field', m[1] || null, state);

    // `open <N>` (digit-only remainder) must be checked BEFORE the generic
    // `open <link text>` match below, since a bare integer would otherwise
    // also satisfy that pattern's `(.+)` capture.
    m = trimmed.match(/^open\s+(\d+)$/i);
    if (m) return doOpenIndex(parseInt(m[1], 10), state);

    m = trimmed.match(/^click\s+(\d+)$/i);
    if (m) return doClickIndex(parseInt(m[1], 10), state);

    // `fill <N> with <text>` (index form) checked before the label form -
    // an all-digit first token is unambiguously an index, never a label.
    // Both fill forms strip a symmetric outer quote pair from the VALUE
    // (and the label form from the label too) - the brainstorm-lane prompt
    // teaches `fill email with "me@example.com"`, and typing literal quote
    // characters into the field was never what anyone meant. See
    // stripOuterQuotes()'s own comment.
    m = trimmed.match(/^fill\s+(\d+)\s+with\s+([\s\S]*)$/i);
    if (m) return doFillIndex(parseInt(m[1], 10), stripOuterQuotes(m[2]), state);
    m = trimmed.match(/^fill\s+(\S[\s\S]*?)\s+with\s+([\s\S]*)$/i);
    if (m) return doFillLabel(stripOuterQuotes(m[1]), stripOuterQuotes(m[2]), state);

    // ---- M4a: `find` (bare form advances to the next match) ----
    m = trimmed.match(/^find(?:\s+(.+))?$/i);
    if (m) return doFind(m[1] || '', state);

    // ---- M4c: `highlight` (persistent visual match layer, see design doc) ----
    if (/^highlight\s+clear$/i.test(trimmed)) return doHighlightClear(state);
    m = trimmed.match(/^highlight(?:\s+([\s\S]+))?$/i);
    if (m) return doHighlight(m[1] || '', state);

    // ---- M4c: `matches` - list the current highlight/find matches. Also
    // accepts the natural "show matches" / "list matches" phrasings a user is
    // likely to reach for (the bare-verb friction find that prompted this), so
    // they resolve deterministically instead of leaking to the model. ----
    if (/^(?:(?:show|list)\s+)?matches$/i.test(trimmed)) return doMatches(state);

    m = trimmed.match(/^open\s+(.+)$/i);
    if (m) return doOpen(m[1], state);

    m = trimmed.match(/^search\s+"([^"]+)"$/i);
    if (m) return doSearch(m[1]);
    m = trimmed.match(/^search\s+(.+)$/i);
    if (m) return doSearch(m[1]);

    // ---- M4a: bare `<N>` - default action by the ls-listing entry's type ----
    m = trimmed.match(/^(\d+)$/);
    if (m) return doBareNumber(parseInt(m[1], 10), state);

    return null; // not deterministic -> caller sends to LLM
  }

  window.LFL.engine = {
    tryDeterministic, HELP_TEXT, findSearchInput, visibleLinks,
    // M4a pure helpers, exported for direct unit testing (tests/m4_friction.test.js)
    // without needing a DOM - see this file's "friction trio" section above.
    capLines, classifyEntry, formatListingEntry, filterEntriesByText,
    pickLabelMatch, fillableFieldEntries, textIncludesQuery,
    suggestCommands, formatHereReport, computeHereStats,
    // M4a DOM-touching handlers, exported so a test can drive them directly
    // against a constructed state.listingContext without going through `ls`
    // itself (which needs a full DOM/axtree.build() call - see
    // tests/m4_friction.test.js's header comment).
    doOpenIndex, doClickIndex, doFillIndex, doFillLabel, doBareNumber,
    // M4c pure helpers, exported for direct unit testing (tests/m4c_highlight.test.js)
    // without needing a DOM - see this file's "highlight" section above.
    findOccurrenceOffsets, parseHighlightArg, formatHighlightSummary, matchSnippet,
    // M4c DOM-touching handlers, exported so a test can drive/inspect them
    // directly (paint, status, clear, teardown, list) the same way the M4a set above is.
    doHighlight, doHighlightClear, teardownHighlight, doMatches,
  };
})();
