/**
 * engine.js — deterministic command engine.
 *
 * Every command handled here NEVER touches the LLM. tryDeterministic() returns
 * null when the command doesn't match a known verb, which tells terminal.js to
 * fall through to the LLM path (engine.js knows nothing about the LLM).
 *
 * M3: tryDeterministic()'s dispatch chain below is DELIBERATELY unchanged
 * from M1/M2 — same regex branches, same handlers, same behavior — see
 * registry.js's header comment for why (it's the one part of this build
 * with no direct unit-test coverage of its own; only the separately-run
 * Playwright battery exercises it end to end, and rewriting its dispatch
 * into a fully data-driven lookup during a build pass that can't re-run
 * that battery is a regression risk not worth taking). What IS new: a
 * parallel, purely-declarative `LFL.commandRegistry` (registry.js's
 * createRegistry()) that every command below registers itself into, used
 * ONLY for `help`/`man <cmd>` text generation and for the
 * registry-cannot-extend-model-vocabulary unit test's enumeration of known
 * command names — it never drives dispatch. New M3 Terminal-level commands
 * (go/alias/unalias/macro/unmacro/origins/dev/man) are registered here too,
 * for the same documentation purpose, even though terminal.js dispatches
 * them itself (they need chrome.* / async access this file's synchronous
 * tryDeterministic() contract doesn't have — see terminal.js's header
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
  // M3 terminal-browser commands (design doc §2/§5/§6) — dispatched by
  // terminal.js, see this file's header comment.
  reg.register({ name: 'go', argSpec: 'go <destination>', help: 'navigate anywhere — literal URL/domain, a defined alias, or (as a last resort) the local model resolves a destination from your typed words alone. First visit to a new origin (or any model-resolved destination) asks for confirmation.' });
  reg.register({ name: 'alias', argSpec: 'alias <name> = <command>', help: 'define a single-command shortcut, e.g. alias wiki = go en.wikipedia.org (M3)' });
  reg.register({ name: 'unalias', argSpec: 'unalias <name>', help: 'remove a defined alias (M3)' });
  reg.register({ name: 'macro', argSpec: 'macro <name> = <cmd1> && <cmd2>...', help: 'define a named && chain, depth-1 (a macro may not reference another macro) (M3)' });
  reg.register({ name: 'unmacro', argSpec: 'unmacro <name>', help: 'remove a defined macro (M3)' });
  reg.register({ name: 'origins', argSpec: 'origins', help: 'list origins visited by this tab this session (M3)' });
  reg.register({ name: 'dev', argSpec: 'dev on | dev off', help: 'toggle the data-lfl-state test hook (off by default — see docs/threat-model.md H2) (M3)' });
  // M4a "friction trio" — three deterministic tools that never call the
  // local model, registered here for help/man text same as everything
  // above; dispatched inside tryDeterministic() below except `here`, which
  // is chain-compatible and ALSO dispatched inside tryDeterministic() (it
  // only needs the terminal's already-cached rate-limit budget snapshot via
  // state.rlBudgetCache — see doHere()'s comment — not a fresh async call,
  // so unlike go/alias/macro/dev/origins it does NOT need terminal.js's
  // chrome.*-capable dispatch path).
  reg.register({ name: 'ls', argSpec: 'ls | ls links [filter] | ls buttons [filter] | ls fields [filter]', help: 'numbered listing of visible links/buttons/fields on the page (M4a)' });
  reg.register({ name: 'click', argSpec: 'click <N>', help: 'click the ls-listing item numbered N — same hard blocks as an approved LLM click, no approval card (M4a)' });
  reg.register({ name: 'fill', argSpec: 'fill <N> with <text> | fill <label> with <text>', help: 'fill the ls-listing field numbered N, or matched by its label — credential fields still blocked (M4a)' });
  reg.register({ name: 'read', argSpec: 'read', help: 'extract the page\'s main readable content (article/main, or the largest visible text block) (M4a)' });
  reg.register({ name: 'find', argSpec: 'find <text> | find', help: 'search visible page text and scroll to it; bare find advances to the next match (M4a)' });
  reg.register({ name: 'here', argSpec: 'here', help: 'compact orientation: origin, element counts, search/pagination hints, suggested next commands (M4a)' });
  // funpack v1 (extension/content/funpack.js) — fortune/stats/theme/cowsay
  // are dispatched by terminal.js, not this file's tryDeterministic() chain,
  // because they need chrome.storage.local access (persisted theme choice,
  // stats counters, MOTD day) this file's synchronous DOM-only contract
  // doesn't have — same posture as go/alias/macro/unmacro/origins/dev above.
  // Registered here purely for help/man text and vocabulary enumeration
  // (including did-you-mean's candidate list, via LFL.commandRegistry.names()).
  // MOTD itself has no typed command name to register — it is shown
  // automatically, at most once per calendar day, when the overlay is opened.
  reg.register({ name: 'fortune', argSpec: 'fortune', help: 'print one local-first/privacy one-liner or command tip (funpack v1)' });
  reg.register({ name: 'stats', argSpec: 'stats', help: 'this session\'s command counters, including the share that never touched the model (funpack v1)' });
  reg.register({ name: 'theme', argSpec: 'theme [name]', help: 'switch (or list) the overlay color theme: default, phosphor, amber, paper (funpack v1)' });
  reg.register({ name: 'cowsay', argSpec: 'cowsay <text>', help: 'classic ASCII cow with a word-wrapped, 40-col speech bubble (funpack v1)' });

  const HELP_TEXT = [
    'deterministic commands (never call the local model):',
    reg.helpText(),
    '',
    '`cmd1 && cmd2 && ...` chains up to 5 ordinary commands (M3) — quote-aware,',
    'any error/block/rejection/Esc clears the rest of the chain.',
    '',
    'a bare number (e.g. "3") after `ls` opens a link, clicks a button, or',
    'names a field to fill, by its listed number (M4a).',
    '',
    'a mistyped command name (e.g. "serach") gets a "did you mean" suggestion',
    'instead of being sent to the local model (M4a) — prefix with "ask" to',
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
      return { output: 'no search box found — try: ask <what you want>' };
    }
    LFL.executor.fillNative(input, query);
    const form = input.form;
    if (form) {
      // Same posture as doOpen()'s cross-origin handling: a search form can
      // point `action` at a different origin than the page it's on. Don't
      // auto-submit that silently — print it instead. See SHOULD-FIX #7 in
      // the security review. form.action (the property, not the attribute)
      // is always an absolute URL, defaulting to the page's own URL when no
      // action attribute is set.
      let actionOrigin = null;
      try {
        actionOrigin = new URL(form.action).origin;
      } catch (_e) { /* unparseable action — treat as same-origin, browser would too */ }
      if (actionOrigin && actionOrigin !== location.origin) {
        return {
          output: `filled search box with "${query}" but the form submits cross-origin (${actionOrigin}) — not auto-submitting; press Enter in the field yourself if you want to proceed`,
        };
      }
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      // FIX 1: form submission is a navigation-initiating action (same
      // reasoning as doOpen's same-origin branch above) — tag it. The
      // cross-origin-form branch just above this one does NOT submit (it
      // only prints a message), so it is left untagged.
      return { output: `submitted search for "${query}"`, navInitiated: true };
    }
    // No enclosing form: simulate Enter, the common pattern for JS-driven search boxes.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    // FIX 1: the synthetic Enter dispatch is the documented mechanism a
    // JS-driven (formless) search box uses to submit-and-navigate — treated
    // identically to the form.requestSubmit()/form.submit() branch above.
    return { output: `filled search box with "${query}" and pressed Enter`, navInitiated: true };
  }

  function visibleLinks() {
    return Array.from(document.querySelectorAll('a[href]')).filter((a) => LFL.axtree.isElementVisible(a));
  }

  function doOpen(linkText, state) {
    const query = linkText.trim().toLowerCase();
    if (!query) return { output: 'usage: open <link text>' };
    const links = visibleLinks();
    let best = null;
    let bestScore = -1;
    for (const a of links) {
      const text = (a.textContent || '').trim().toLowerCase();
      if (!text) continue;
      let score = -1;
      if (text === query) score = 3;
      else if (text.startsWith(query)) score = 2;
      else if (text.includes(query)) score = 1;
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    if (!best) return { output: `no visible link matching "${linkText}"` };
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
      // injection drive continuation — same posture `go` already has. The
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
    // cross-origin link) — tag it. Unlike `open`'s same-origin branch, this
    // does NOT update the queue's recorded expectedOrigin, so a cross-origin
    // `open!` inside a chain halts the queue fail-closed on the next
    // injection's arrival check (same outcome as a chain-internal `back` —
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
  // M4a friction trio — three deterministic tools (`ls`+numbered actions,
  // `read`/`find`, `here`+did-you-mean). Reuses axtree.js's index->element
  // map verbatim (LFL.axtree.build()/resolve()) and executor.js's
  // execute() verbatim for click/fill-by-index — no parallel element-
  // indexing or guard logic is introduced here. Functions below are split
  // into PURE helpers (no DOM reads — directly unit-testable, see
  // tests/m4_friction.test.js) and DOM-touching handlers that call them.
  // =====================================================================

  const LS_SECTION_CAP = 40;
  const READ_LINE_CAP = 120;

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
  // tab/menuitem/slider). This is a build decision, not an axtree change —
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

  // ---- pure: does a visible text node's content match a find query? ----
  function textIncludesQuery(text, query) {
    if (!text || !query) return false;
    return text.toLowerCase().includes(query.toLowerCase());
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
      `listing context: ${s.listingActive ? `active (${s.listingCount} items — see \`ls\`)` : 'none — run `ls`'}`,
      `budget: llm ${b.llmRemaining}/${b.llmMax} · actions ${b.actionRemaining}/${b.actionMax}${b.paused ? ' · PAUSED' : ''}`,
      `try: ${(suggestions || []).join(' | ')}`,
    ].join('\n');
  }

  // =====================================================================
  // DOM-touching handlers (thin — delegate real work to the pure helpers
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
    if (!state.listingContext) return { error: 'no listing — run `ls` first' };
    const entry = state.listingContext.entries.find((e) => e.index === n);
    if (!entry) return { error: `no such item: [${n}] — run \`ls\` again` };
    return { entry };
  }

  // `open <N>` — mirrors doOpen()'s same-origin/cross-origin/non-http(s)
  // posture exactly (same navInitiated/pendingCrossOriginUrl semantics —
  // reused, not reimplemented), resolved against the LIVE element from the
  // listing context's map instead of a fresh link-text search. A link
  // living inside a same-origin iframe is intentionally still navigated via
  // the TOP document's location (same posture as doOpen(), which only ever
  // considered top-document links in the first place) — a build decision,
  // not an oversight; see this build's final report.
  function doOpenIndex(n, state) {
    const found = resolveListingEntry(state, n);
    if (found.error) return { output: found.error };
    if (classifyEntry(found.entry) !== 'link') {
      return { output: `[${n}] is not a link — try \`click ${n}\`` };
    }
    const el = LFL.axtree.resolve(state.listingContext.map, n);
    if (!el) return { output: `[${n}] is stale or no longer visible — re-run \`ls\`` };
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
      // comment) — this initiates a real navigation, so the chain queue
      // must defer its advance to the next injection's arrival check.
      return { output: `opening [${n}] "${found.entry.name}" -> ${url.href}`, navInitiated: true };
    }
    state.pendingCrossOriginUrl = url.href;
    return { output: `cross-origin link: ${url.href}\ntype "open!" to confirm navigation off this site` };
  }

  // `click <N>` — reuses LFL.executor.execute() verbatim, so every hard
  // block (credential guard is fill/select-only, but the click-target
  // scheme/origin guard and nav-watch arming) applies exactly as it does
  // for an APPROVED LLM click. Deliberately no approval card: a
  // deterministic, user-typed `click <N>` is direct user intent (same
  // posture `search`/`open` already have) — the hard blocks are what stay
  // unconditional, not the approval card. NOT tagged navInitiated even when
  // the click happens to navigate — executor.js's click branch has no way
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
    if (!state.listingContext) return { output: 'no listing — run `ls` first' };
    const fields = fillableFieldEntries(state.listingContext.entries);
    const res = pickLabelMatch(fields, label);
    if (res.none) return { output: `no fillable field matching "${label}" — try \`ls fields\`` };
    if (res.ambiguous) {
      const candidates = res.ambiguous.map(formatListingEntry).join('\n');
      return { output: `ambiguous field "${label}" — candidates:\n${candidates}\nbe more specific, or use \`fill <N> with ...\`` };
    }
    return doFillIndex(res.match.index, text, state);
  }

  // Bare `<N>` — default action by the listing entry's type. Never reached
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
    // Fallback: largest-visible-text-block heuristic — simple and honest,
    // not a real readability algorithm. Deliberately does not try to dedupe
    // nested candidates (a child block's text is also counted inside its
    // parent's) — picking by raw textContent length still tends to find the
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
  // highlight, restored after FIND_HIGHLIGHT_MS — no stylesheet is injected
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
        return { output: 'no active find — try: find <text>' };
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

  // `here` needs the rate-limit budget line, but — unlike go/alias/macro/
  // dev/origins — does NOT need a fresh async SW round trip to get it:
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
      // human-visible state — `clear` is an explicit "start fresh" gesture,
      // so reset both here too (they also naturally die on navigation, since
      // `state` itself is rebuilt from scratch by the next content-script
      // injection — see terminal.js's constructor).
      state.listingContext = null;
      state.findContext = null;
      return { output: '', clear: true };
    }
    if (/^log$/i.test(trimmed)) return { output: LFL.auditLog ? LFL.auditLog.render() : '(no audit log)' };
    if (/^back$/i.test(trimmed)) {
      history.back();
      // FIX 1: history.back()'s destination is statically UNKNOWABLE here
      // (browser history, not a URL this code ever sees) — tag it as
      // navigation-initiated anyway so _dispatchSegment() defers to the
      // arrival check on the next injection rather than advancing the
      // queue synchronously against the old document. Because `back` never
      // updates the queue's recorded expectedOrigin, that arrival check
      // fails closed for a cross-origin `back` (halts the queue) and
      // passes for a same-origin one (continues) — see
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

    // `fill <N> with <text>` (index form) checked before the label form —
    // an all-digit first token is unambiguously an index, never a label.
    m = trimmed.match(/^fill\s+(\d+)\s+with\s+([\s\S]*)$/i);
    if (m) return doFillIndex(parseInt(m[1], 10), m[2], state);
    m = trimmed.match(/^fill\s+(\S[\s\S]*?)\s+with\s+([\s\S]*)$/i);
    if (m) return doFillLabel(m[1], m[2], state);

    // ---- M4a: `find` (bare form advances to the next match) ----
    m = trimmed.match(/^find(?:\s+(.+))?$/i);
    if (m) return doFind(m[1] || '', state);

    m = trimmed.match(/^open\s+(.+)$/i);
    if (m) return doOpen(m[1], state);

    m = trimmed.match(/^search\s+"([^"]+)"$/i);
    if (m) return doSearch(m[1]);
    m = trimmed.match(/^search\s+(.+)$/i);
    if (m) return doSearch(m[1]);

    // ---- M4a: bare `<N>` — default action by the ls-listing entry's type ----
    m = trimmed.match(/^(\d+)$/);
    if (m) return doBareNumber(parseInt(m[1], 10), state);

    return null; // not deterministic -> caller sends to LLM
  }

  window.LFL.engine = {
    tryDeterministic, HELP_TEXT, findSearchInput, visibleLinks,
    // M4a pure helpers, exported for direct unit testing (tests/m4_friction.test.js)
    // without needing a DOM — see this file's "friction trio" section above.
    capLines, classifyEntry, formatListingEntry, filterEntriesByText,
    pickLabelMatch, fillableFieldEntries, textIncludesQuery,
    suggestCommands, formatHereReport, computeHereStats,
    // M4a DOM-touching handlers, exported so a test can drive them directly
    // against a constructed state.listingContext without going through `ls`
    // itself (which needs a full DOM/axtree.build() call — see
    // tests/m4_friction.test.js's header comment).
    doOpenIndex, doClickIndex, doFillIndex, doFillLabel, doBareNumber,
  };
})();
