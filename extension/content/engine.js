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
  reg.register({ name: 'open', argSpec: 'open <link text>', help: 'navigate a same-origin link by visible text' });
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

  const HELP_TEXT = [
    'deterministic commands (never call the local model):',
    reg.helpText(),
    '',
    '`cmd1 && cmd2 && ...` chains up to 5 ordinary commands (M3) — quote-aware,',
    'any error/block/rejection/Esc clears the rest of the chain.',
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

  /**
   * @param {string} raw - trimmed raw command text
   * @param {object} state - terminal state (used for open!/pending cross-origin, audit log)
   * @returns {{output: string} | null} null means "not a deterministic command"
   */
  function tryDeterministic(raw, state) {
    const trimmed = raw.trim();
    if (trimmed === '') return { output: '' };
    if (/^help$/i.test(trimmed)) return { output: HELP_TEXT };
    if (/^clear$/i.test(trimmed)) return { output: '', clear: true };
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

    let m = trimmed.match(/^man\s+(\S+)$/i);
    if (m) return { output: reg.manText(m[1]) };

    m = trimmed.match(/^open\s+(.+)$/i);
    if (m) return doOpen(m[1], state);

    m = trimmed.match(/^search\s+"([^"]+)"$/i);
    if (m) return doSearch(m[1]);
    m = trimmed.match(/^search\s+(.+)$/i);
    if (m) return doSearch(m[1]);

    return null; // not deterministic -> caller sends to LLM
  }

  window.LFL.engine = { tryDeterministic, HELP_TEXT, findSearchInput, visibleLinks };
})();
