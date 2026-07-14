/**
 * terminal.js - the overlay UI and the human approval gate. This is the core of
 * the product: proposals from the local model are rendered deterministically
 * from the raw action JSON (never model-generated prose) and require an
 * explicit Enter/click-Approve to execute; Esc/click-Reject always rejects.
 * click/fill/select/navigate are gated; answer/extract/scroll/abort are
 * read-only and auto-run.
 *
 * Rate-limit state (M2.3) is NOT owned by this class as of 2026-07-12 - it
 * used to be a local `LFL.rateLimiter.createRateLimiter()` instance, which
 * meant the counters and the paused latch were destroyed and reset every
 * time this class was re-constructed (top-frame navigation, reload - the
 * content script re-injects and runs `new Terminal()` from scratch). That
 * defeated the control. The AUTHORITATIVE state now lives in the background
 * service worker, keyed by tab id and backed by chrome.storage.session (see
 * background/service-worker.js's header comment and docs/threat-model.md
 * item #7); this class only holds a short-lived CACHE of the last budget
 * snapshot it was told (`_rlBudgetCache`, for synchronous titlebar
 * rendering) and talks to the SW via the `_rl*` async helper methods below.
 *
 * Rendered inside a CLOSED shadow root appended to documentElement (limits
 * page CSS/JS interference), AND - M2.1 - the host element carries
 * `popover="manual"` and is shown/hidden via showPopover()/hidePopover(),
 * promoting the whole overlay (terminal panel + approval card, since the
 * card is a descendant of the popover host) into the browser TOP LAYER.
 * Page z-index/position tricks cannot occlude or reposition top-layer
 * content - this is the documented fix for DOM-based extension clickjacking
 * (defeated 11 password managers in 2025, see docs/threat-model.md).
 *
 * Top-layer positioning alone does not fully close the loop, though: two
 * top-layer elements still have a paint/stacking order between themselves,
 * so a hostile page that ALSO reaches the top layer (e.g. its own
 * `popover`/`<dialog>`) could in principle race to render above ours. That
 * is exactly why _probeApprovalOcclusion() re-checks, immediately before
 * executing an APPROVED mutating action, that the approve control was
 * genuinely the topmost, un-occluded element at click time - occlusion
 * detected there means ABORT, not "warn and proceed". See
 * tests/fixtures/occlusion-attack.html for the adversarial case this is
 * built against.
 */
(function () {
  'use strict';

  if (document.documentElement.hasAttribute('data-lfl-terminal-injected')) return;
  document.documentElement.setAttribute('data-lfl-terminal-injected', '1');

  window.LFL = window.LFL || {};

  const MAX_HISTORY = 50;
  const MAX_OUTPUT_LINES = 400;
  const APPROVAL_ACTIONS = new Set(['click', 'fill', 'select', 'navigate']);
  // M4b fun pack v2 (design doc §4/§5): the fixed set of game command
  // names. Kept in sync with registry.js's RESERVED_NAMES/GAME_NAMES and
  // engine.js's reg.register() calls for these three names.
  // `sl` (steam locomotive easter egg, added later): same set, same
  // chain/macro/awaiting-something/already-running locks, all inherited
  // for free via _handleGameCommand()/_enterProgram() below - see
  // _startSL()'s own comment for the one thing that's different about it
  // (auto-exit on its own, no human quit required to finish a run).
  const GAME_NAMES = new Set(['snake', '2048', 'games', 'sl']);
  // M4b verify fix (MED-2): the four funpack-v1 names get the same
  // chain/macro posture as the games. Directly-typed, they are matched in
  // _submitCommand() and never reach _dispatchSegment() at all - but a
  // chain segment (`go x && fortune`) or an alias expansion DOES reach it,
  // and previously fell through to the page-lane model (burning an LLM
  // budget slot and popping an unrelated proposal for a command that is
  // supposed to be free and local). Kept in sync with registry.js's
  // FUNPACK_NAMES (the macro write-time half of the same lock).
  // Deliberately does NOT include the pre-existing meta-commands
  // (budget/dev/origins/continue/alias/macro/...) - their posture is
  // unchanged by this fix, per the verify scope.
  const FUNPACK_NAMES = new Set(['fortune', 'stats', 'theme', 'cowsay']);
  // Storage-key form of each playable game's name, used only for the
  // chrome.storage.local `lflGameScores` object's keys (design §4) - "2048"
  // is not a valid property to reach via dot-notation and reads oddly as a
  // bare numeric-looking key, so the design doc gives it the storage key
  // `g2048` (see _recordGameScore()/_printGamesList()).
  const GAME_STORAGE_KEY = Object.freeze({ snake: 'snake', '2048': 'g2048' });
  const ARROW_KEY_DIRS = Object.freeze({
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  });

  // Kept in sync with content/terminal.css - see the TODO note there.
  const CSS_TEXT = `
:host{all:initial;position:fixed;inset:auto 0 40px 0;margin:0;padding:0;border:none;width:auto;height:auto;background:transparent;color:inherit;overflow:visible;z-index:2147483647;display:block;}
.lfl-panel{display:none;flex-direction:column;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.45;color:var(--lfl-fg,#dbe4f0);background:var(--lfl-bg,#0b0e14);border-top:2px solid var(--lfl-accent,#e0a339);box-shadow:0 -8px 24px rgba(0,0,0,.55);max-height:46vh;}
.lfl-panel.lfl-open{display:flex;}
.lfl-panel.lfl-theme-default{--lfl-bg:#0b0e14;--lfl-fg:#dbe4f0;--lfl-accent:#e0a339;--lfl-accent-bright:#f5a623;--lfl-titlebar-bg:#151a24;--lfl-titlebar-fg:#8fa3c0;--lfl-dim:#5d7290;--lfl-dim-input:#4b5768;--lfl-cmd:#8fd0ff;--lfl-info:#9fb0c3;--lfl-error:#ff6b6b;--lfl-ok:#7ee787;--lfl-border:#2a3140;--lfl-proposal-bg:#1a1408;--lfl-proposal-fg:#f2d9a8;--lfl-proposal-detail:#c9b28a;--lfl-approve-bg:#1c3a1c;--lfl-reject-bg:#3a1c1c;--lfl-input-bg:#0e131c;}
.lfl-panel.lfl-theme-phosphor{--lfl-bg:#000000;--lfl-fg:#33ff33;--lfl-accent:#33ff33;--lfl-accent-bright:#66ff66;--lfl-titlebar-bg:#001a00;--lfl-titlebar-fg:#22cc22;--lfl-dim:#177217;--lfl-dim-input:#177217;--lfl-cmd:#33ff33;--lfl-info:#2ecc2e;--lfl-error:#ff5555;--lfl-ok:#33ff33;--lfl-border:#0a3d0a;--lfl-proposal-bg:#001a00;--lfl-proposal-fg:#33ff33;--lfl-proposal-detail:#22aa22;--lfl-approve-bg:#003300;--lfl-reject-bg:#330000;--lfl-input-bg:#000000;}
.lfl-panel.lfl-theme-amber{--lfl-bg:#1a0f00;--lfl-fg:#ffb000;--lfl-accent:#ffb000;--lfl-accent-bright:#ffd166;--lfl-titlebar-bg:#241500;--lfl-titlebar-fg:#cc8b00;--lfl-dim:#805800;--lfl-dim-input:#805800;--lfl-cmd:#ffcc66;--lfl-info:#e0a339;--lfl-error:#ff6b4a;--lfl-ok:#ffb000;--lfl-border:#3a2200;--lfl-proposal-bg:#241500;--lfl-proposal-fg:#ffd166;--lfl-proposal-detail:#cc8b00;--lfl-approve-bg:#332200;--lfl-reject-bg:#3a1400;--lfl-input-bg:#1a0f00;}
.lfl-panel.lfl-theme-paper{--lfl-bg:#f7f5f0;--lfl-fg:#1c1c1c;--lfl-accent:#a15c00;--lfl-accent-bright:#c97a00;--lfl-titlebar-bg:#ece7dc;--lfl-titlebar-fg:#4a4a4a;--lfl-dim:#8a8a8a;--lfl-dim-input:#8a8a8a;--lfl-cmd:#0b5fa5;--lfl-info:#4a4a4a;--lfl-error:#b3261e;--lfl-ok:#1e7b34;--lfl-border:#d8d2c4;--lfl-proposal-bg:#fff8e6;--lfl-proposal-fg:#3a3a3a;--lfl-proposal-detail:#6b5c3f;--lfl-approve-bg:#e3f3e6;--lfl-reject-bg:#f8e4e2;--lfl-input-bg:#ffffff;}
.lfl-titlebar{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:4px 10px;background:var(--lfl-titlebar-bg,#151a24);border-bottom:1px solid var(--lfl-border,#2a3140);color:var(--lfl-titlebar-fg,#8fa3c0);font-size:11px;letter-spacing:.04em;text-transform:uppercase;}
.lfl-titlebar .lfl-badge{color:var(--lfl-accent,#e0a339);}
.lfl-titlebar .lfl-budget{margin-left:auto;color:var(--lfl-dim,#5d7290);letter-spacing:normal;text-transform:none;font-size:10px;}
.lfl-output{flex:1;overflow-y:auto;padding:8px 10px;white-space:pre-wrap;word-break:break-word;}
.lfl-line{margin:0 0 4px 0;}
.lfl-line.lfl-cmd{color:var(--lfl-cmd,#8fd0ff);}
.lfl-line.lfl-cmd::before{content:'lfl> ';color:var(--lfl-accent,#e0a339);}
.lfl-line.lfl-info{color:var(--lfl-info,#9fb0c3);}
.lfl-line.lfl-error{color:var(--lfl-error,#ff6b6b);}
.lfl-line.lfl-ok{color:var(--lfl-ok,#7ee787);}
.lfl-line.lfl-motd{color:var(--lfl-dim,#5d7290);font-style:italic;}
.lfl-frame{margin:0 0 4px 0;font-family:inherit;white-space:pre;color:var(--lfl-fg,#dbe4f0);}
.lfl-proposal{margin:0 10px 8px 10px;padding:8px 10px;border:1px solid var(--lfl-accent,#e0a339);background:var(--lfl-proposal-bg,#1a1408);color:var(--lfl-proposal-fg,#f2d9a8);}
.lfl-proposal[hidden]{display:none;}
.lfl-proposal .lfl-gloss{color:var(--lfl-accent-bright,#f5a623);font-weight:600;}
.lfl-proposal .lfl-detail{color:var(--lfl-proposal-detail,#c9b28a);font-size:12px;margin-top:4px;white-space:pre-wrap;}
.lfl-proposal .lfl-hint{color:var(--lfl-titlebar-fg,#8fa3c0);font-size:11px;margin-top:6px;}
.lfl-approval-actions{display:flex;gap:8px;margin-top:8px;}
.lfl-approve-btn,.lfl-reject-btn{font:inherit;font-size:12px;padding:4px 12px;border-radius:2px;cursor:pointer;}
.lfl-approve-btn{background:var(--lfl-approve-bg,#1c3a1c);border:1px solid var(--lfl-ok,#7ee787);color:var(--lfl-ok,#7ee787);}
.lfl-approve-btn:focus{outline:2px solid var(--lfl-ok,#7ee787);outline-offset:2px;}
.lfl-reject-btn{background:var(--lfl-reject-bg,#3a1c1c);border:1px solid var(--lfl-error,#ff6b6b);color:var(--lfl-error,#ff6b6b);}
.lfl-reject-btn:focus{outline:2px solid var(--lfl-error,#ff6b6b);outline-offset:2px;}
.lfl-inputrow{display:flex;align-items:center;padding:6px 10px;border-top:1px solid var(--lfl-border,#2a3140);background:var(--lfl-input-bg,#0e131c);}
.lfl-prompt{color:var(--lfl-accent,#e0a339);margin-right:6px;}
.lfl-input{flex:1;background:transparent;border:none;outline:none;color:var(--lfl-fg,#dbe4f0);font:inherit;}
.lfl-input::placeholder{color:var(--lfl-dim-input,#4b5768);}
.lfl-input[readonly]{color:var(--lfl-dim-input,#4b5768);}
`;

  function createAuditLog() {
    const entries = [];
    return {
      push(entry) {
        const withTs = Object.assign({ ts: Date.now() }, entry);
        entries.push(withTs);
        console.info('[lfl-terminal audit]', withTs);
      },
      render() {
        if (entries.length === 0) return '(no audit log entries yet)';
        return entries
          .map((e, i) => {
            const t = new Date(e.ts).toLocaleTimeString();
            return `${i + 1}. [${t}] cmd="${e.command}" -> ${e.summary}  verdict=${e.verdict}  result=${e.result || ''}`;
          })
          .join('\n');
      },
      all() {
        return entries.slice();
      },
    };
  }
  LFL.auditLog = createAuditLog();

  class Terminal {
    constructor() {
      this.state = {
        mode: 'idle', // 'idle' | 'awaiting-approval' | 'awaiting-nav-confirm' (M3)
        pendingCrossOriginUrl: null,
        pendingProposal: null,
        pendingNav: null, // M3: {url, origin, modelResolved} - see _handleGo/_confirmOrNavigate
        history: [],
        historyIdx: -1,
        // M4a: the `ls`-built index->element listing context ({entries, map,
        // notes}, EXACTLY axtree.build()'s own return shape - see
        // engine.js's doLs()) and the active `find` match state
        // ({query, matches, idx}). Both are page-scoped, human-visible-only
        // memory: never persisted (no TS_* key), never sent to either LLM
        // lane's payload, and cleared by `clear` (engine.js's clear branch)
        // in addition to dying naturally with this whole `state` object on
        // the next navigation's fresh content-script injection.
        listingContext: null,
        findContext: null,
        // M4a: a live mirror of this._rlBudgetCache (see below) so
        // engine.js's `here` handler - which only receives `state`, not this
        // Terminal instance - can render the already-cached rate-limit
        // budget synchronously, without needing terminal.js's separate
        // chrome.*-capable async dispatch path the way go/alias/macro/dev/
        // origins need. Kept in sync everywhere _rlBudgetCache is assigned.
        rlBudgetCache: null,
      };
      // M3: the alias/macro store (registry.js) - chrome.storage.local
      // backed, loaded async below. The ONLY writers of it are
      // _handleAliasCommand/_handleMacroCommand (typed `alias`/`macro`
      // commands) - see registry.js's header comment for the write-path
      // lock this is built around.
      this._aliasStore = LFL.registry.createAliasStore(
        (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null,
      );
      this._aliasStore.load();
      // M3 H2 (design doc §8): the data-lfl-state test hook is OFF by
      // default - see _updateTestHook()'s own comment. Loaded async from
      // storage.local `lflDevHooks`; stays false (hidden) until that
      // resolves, which is the safe default direction to fail in.
      this._devHooksEnabled = false;
      this._loadDevHooksFlag();
      // funpack v1: persisted theme choice (storage.local `lflTheme`) --
      // loaded async, applied via _applyTheme() as soon as it resolves;
      // stays on the 'default' theme's fallback CSS values until then, the
      // safe default direction. See _loadTheme()/_applyTheme() below.
      this._loadTheme();
      this.elementMap = new Map();
      this._lastCommand = '';
      // Monotonic counter bumped at every "settle" point (deterministic result
      // printed, proposal rendered awaiting approval, LLM error surfaced, or
      // approve/reject resolved, or an async nav-watch/rate-limit event) -
      // see reportAsync(). Exposed via the test hook so tests/run_battery.py
      // can detect "this command is done" without guessing a fixed sleep, and
      // can measure real submit->settle latency instead of polling only for
      // the LLM-proposal case.
      this._seq = 0;
      // Last execution/verdict result, also exposed on the test hook so tests
      // can verify hard-block enforcement (e.g. password-field refusal)
      // without needing to read text out of the closed shadow root.
      this._lastResult = null;
      // M2.3 rate limiting is now SW-authoritative (see class header comment
      // and background/service-worker.js) - this is only a cache of the
      // last real snapshot the service worker returned, for synchronous
      // titlebar rendering between async round trips. Seeded with
      // optimistic (full-budget, not-paused) placeholder numbers from
      // LFL.rateLimiter.DEFAULTS until the first real fetch resolves
      // (_refreshRateLimitBudget(), kicked off below) - if this tab was
      // already paused/partially-consumed from before a reload, that first
      // fetch corrects the placeholder immediately.
      this._rlBudgetCache = {
        llmRemaining: LFL.rateLimiter.DEFAULTS.llmMax,
        llmMax: LFL.rateLimiter.DEFAULTS.llmMax,
        actionRemaining: LFL.rateLimiter.DEFAULTS.actionMax,
        actionMax: LFL.rateLimiter.DEFAULTS.actionMax,
        paused: false,
        pauseReason: null,
      };
      this.state.rlBudgetCache = this._rlBudgetCache; // M4a - see state's own comment above
      // Reentrancy guard for _approveProposal()'s async SW round trip - see
      // that method for why.
      this._approvalBusy = false;
      // M4b fun pack v2 (design §3): non-null while `snake`/`2048` is
      // actively running - { prog, frameEl, intervalId }. `prog` is the
      // {name, onKey, onTick?, getFps?, onExit} object the game-start
      // handler built (see _startSnake()/_start2048()); `frameEl` is the
      // single <pre class="lfl-frame"> whose textContent every redraw
      // replaces; `intervalId` is whatever setInterval() returned for the
      // tick (null for 2048, which is key-driven only). See _enterProgram()/
      // _exitProgram() below - this is the ONLY state the program-mode
      // primitive needs beyond the ordinary command state above.
      this._activeProgram = null;
      this._buildDom();
      this._wireEvents();
      this._loadHistory();
      this._updateTestHook();
      // Fire-and-forget: pulls the SW-authoritative numbers as soon as
      // possible after (re)injection - this is what makes a just-reloaded
      // page's titlebar honestly reflect a pre-existing pause/partial budget
      // instead of the optimistic placeholder above.
      this._refreshRateLimitBudget();
      // M3 (design doc §4): restore scrollback (display-only), auto-reopen
      // if this tab's terminal was open before the last navigation, and
      // continue any in-flight `&&` chain (arrival check first) - all via
      // the SW-authoritative per-tab TS_* state. Fire-and-forget; nothing
      // here blocks the terminal being usable immediately.
      this._restoreTerminalState();
    }

    // ---- M3 terminal-state (TS_*) SW messaging ----
    //
    // Mirrors _rlSend()'s shape but without the rate-limiter's fail-closed
    // "block the action" posture - none of TS_* gates a mutation by itself
    // (the one TS_*-informed safety decision, the queue's arrival check, is
    // its own explicit fail-closed comparison in _advanceQueue(), not a
    // property of this transport helper). A messaging failure here simply
    // yields {ok:false} and the caller treats that as "nothing to restore/
    // nothing queued", which is always the safe direction for optional
    // continuity state.
    async _tsSend(type, extra) {
      const payload = Object.assign({ type }, extra || {});
      try {
        const resp = await chrome.runtime.sendMessage(payload);
        return resp && typeof resp === 'object' ? resp : { ok: false };
      } catch (_e) {
        return { ok: false };
      }
    }

    _loadDevHooksFlag() {
      try {
        chrome.storage.local.get(['lflDevHooks'], (res) => {
          if (chrome.runtime.lastError) return;
          this._devHooksEnabled = !!(res && res.lflDevHooks);
          this._updateTestHook();
        });
      } catch (_e) { /* storage unavailable - stays off, the safe default */ }
    }

    async _restoreTerminalState() {
      // Scrollback restore - display-only, rendered via the DOM-only helper
      // (never re-persisted, never re-executed, never fed into either LLM
      // lane's payload - see buildNavLanePayload()'s/buildPayload()'s own
      // comments in service-worker.js for why there is nothing here to
      // wire in even if a future edit wanted to).
      const sb = await this._tsSend('TS_SCROLLBACK_GET');
      if (sb.ok && Array.isArray(sb.scrollback) && sb.scrollback.length > 0) {
        this._appendLineDom('(restored scrollback from before navigation)', 'info');
        for (const line of sb.scrollback) {
          this._appendLineDom((line && line.text) || '', (line && line.cls) || 'info');
        }
      }
      const openState = await this._tsSend('TS_OPEN_GET');
      if (openState.ok && openState.open) {
        this.open();
      }
      await this._advanceQueue();
    }

    // ---- M2.3 rate-limit SW messaging (see class header comment) ----

    // Sends one rate-limit message to the service worker and returns its
    // response. Fails CLOSED on any messaging error (SW unreachable,
    // extension context invalidated, etc.) - same posture as the M2.1
    // occlusion probe's "can't check" != "check passed": a safety control
    // that cannot be consulted must not silently permit the thing it exists
    // to gate.
    async _rlSend(type, extra) {
      const payload = Object.assign({ type }, extra || {});
      let resp;
      try {
        resp = await chrome.runtime.sendMessage(payload);
      } catch (e) {
        resp = null;
      }
      if (!resp || !resp.ok) {
        const reason = (resp && resp.error) || 'rate-limit check unavailable (service worker unreachable) - blocked for safety';
        return { ok: false, allowed: false, paused: true, reason, resumed: false, recorded: false, budget: this._rlBudgetCache };
      }
      if (resp.budget) {
        this._rlBudgetCache = resp.budget;
        this.state.rlBudgetCache = resp.budget; // M4a - keep `here`'s synchronous view in sync
      }
      return resp;
    }

    _rlCheck(kind) {
      return this._rlSend('RL_CHECK', { kind });
    }

    _rlRecord(kind) {
      return this._rlSend('RL_RECORD', { kind });
    }

    _rlResume() {
      return this._rlSend('RL_RESUME');
    }

    async _refreshRateLimitBudget() {
      const resp = await this._rlSend('RL_BUDGET');
      // _rlSend already updated this._rlBudgetCache on success; on failure it
      // leaves the previous cache in place rather than overwriting it with a
      // synthetic "paused" budget shape (that failure mode is for gating an
      // in-flight action, not for permanently mislabeling the titlebar).
      if (resp.ok) this._updateTestHook();
    }

    _buildDom() {
      this.host = document.createElement('div');
      this.host.id = 'lfl-terminal-host';
      // M2.1: promote the whole overlay (panel + approval card, both
      // descendants of this host) into the browser top layer. "manual" mode
      // means WE control show/hide (open()/hidePopover() below) - no
      // light-dismiss-on-outside-click, no auto-close-on-Escape (we already
      // handle Escape ourselves, deliberately, to route it through the
      // approval-reject / close logic instead of the UA default).
      try { this.host.setAttribute('popover', 'manual'); } catch (_e) { /* attribute set is always safe even if unsupported */ }
      document.documentElement.appendChild(this.host);
      this.shadow = this.host.attachShadow({ mode: 'closed' });

      const style = document.createElement('style');
      style.textContent = CSS_TEXT;
      this.shadow.appendChild(style);

      this.panel = document.createElement('div');
      this.panel.className = 'lfl-panel';

      const titlebar = document.createElement('div');
      titlebar.className = 'lfl-titlebar';
      const badge = document.createElement('span');
      badge.className = 'lfl-badge';
      badge.textContent = 'lfl-terminal';
      const hint = document.createElement('span');
      hint.textContent = '` or Ctrl+K to toggle · Esc to close';
      this.budgetEl = document.createElement('span');
      this.budgetEl.className = 'lfl-budget';
      titlebar.appendChild(badge);
      titlebar.appendChild(hint);
      titlebar.appendChild(this.budgetEl);

      this.outputEl = document.createElement('div');
      this.outputEl.className = 'lfl-output';

      this.proposalEl = document.createElement('div');
      this.proposalEl.className = 'lfl-proposal';
      this.proposalEl.hidden = true;
      this.glossEl = document.createElement('div');
      this.glossEl.className = 'lfl-gloss';
      this.detailEl = document.createElement('div');
      this.detailEl.className = 'lfl-detail';
      this.hintEl = document.createElement('div');
      this.hintEl.className = 'lfl-hint';
      this.hintEl.textContent = 'Enter/click Approve = approve · Esc/click Reject = reject';

      this.actionsEl = document.createElement('div');
      this.actionsEl.className = 'lfl-approval-actions';
      this.approveBtn = document.createElement('button');
      this.approveBtn.type = 'button';
      this.approveBtn.className = 'lfl-approve-btn';
      this.approveBtn.textContent = 'Approve (Enter)';
      this.approveBtn.addEventListener('click', (e) => {
        if (!LFL.guards.isTrustedInputEvent(e)) return; // M3 H1 - see guards.js
        this._approvePending();
      });
      this.rejectBtn = document.createElement('button');
      this.rejectBtn.type = 'button';
      this.rejectBtn.className = 'lfl-reject-btn';
      this.rejectBtn.textContent = 'Reject (Esc)';
      this.rejectBtn.addEventListener('click', (e) => {
        if (!LFL.guards.isTrustedInputEvent(e)) return; // M3 H1 - see guards.js
        this._rejectPending();
      });
      this.actionsEl.appendChild(this.approveBtn);
      this.actionsEl.appendChild(this.rejectBtn);

      this.proposalEl.appendChild(this.glossEl);
      this.proposalEl.appendChild(this.detailEl);
      this.proposalEl.appendChild(this.actionsEl);
      this.proposalEl.appendChild(this.hintEl);

      const inputrow = document.createElement('div');
      inputrow.className = 'lfl-inputrow';
      const prompt = document.createElement('span');
      prompt.className = 'lfl-prompt';
      prompt.textContent = 'lfl>';
      this.inputEl = document.createElement('input');
      this.inputEl.className = 'lfl-input';
      this.inputEl.type = 'text';
      this.inputEl.autocomplete = 'off';
      this.inputEl.spellcheck = false;
      this.inputEl.placeholder = 'type a command - try "help"';
      inputrow.appendChild(prompt);
      inputrow.appendChild(this.inputEl);

      this.panel.appendChild(titlebar);
      this.panel.appendChild(this.outputEl);
      this.panel.appendChild(this.proposalEl);
      this.panel.appendChild(inputrow);
      this.shadow.appendChild(this.panel);

      this._popoverSupported = typeof this.host.showPopover === 'function';
    }

    _wireEvents() {
      document.addEventListener('keydown', this._onGlobalKeydown.bind(this), true);
      this.inputEl.addEventListener('keydown', this._onInputKeydown.bind(this));
      // M4b (design §3): force-exit an active program on ANY navigation
      // signal. Reuses the SAME Navigation API technique nav-watch.js
      // already established for runtime navigation interception -
      // `window.navigation`'s `navigate` event - for same-document/SPA-style
      // navigations, plus `pagehide` (always available) as the universal
      // signal for an actual top-level unload. A full top-level navigation
      // destroys this whole content-script realm anyway (the interval dies
      // with it for free), but `pagehide` fires just BEFORE that teardown,
      // which is what lets _exitProgram() run its ordinary cleanup
      // (clearInterval, restore prompt, print the score summary) instead of
      // the program just vanishing mid-frame. Deliberately does NOT touch
      // nav-watch.js itself (design §7 - that file's own short-lived,
      // per-click watcher is out of scope here); this is a second,
      // independent listener with a different job (halt OUR OWN running
      // program, not classify a click's destination).
      if (typeof window !== 'undefined') {
        const forceExitOnNav = () => {
          if (this._activeProgram) this._exitProgram('navigation', { restoreFocus: false });
        };
        window.addEventListener('pagehide', forceExitOnNav);
        if (window.navigation && typeof window.navigation.addEventListener === 'function') {
          window.navigation.addEventListener('navigate', forceExitOnNav);
        }
      }
    }

    // M3 H1 (design doc §8): every input handler ignores non-isTrusted
    // events outright - a page can dispatch synthetic KeyboardEvent/
    // MouseEvent objects at our host element (it's in the light DOM,
    // retargeted from inside the closed shadow root) or its own listeners,
    // and "terminal input = trusted because a human typed it" only holds if
    // every one of these handlers actually checks that. See guards.js's
    // isTrustedInputEvent() for the pure predicate this calls (unit-tested
    // directly; the DOM wiring itself needs a real event object to exercise
    // - see tests/m3_hardening.test.js for what is and isn't covered here).
    _isAwaitingSomething() {
      return this.state.mode === 'awaiting-approval' || this.state.mode === 'awaiting-nav-confirm';
    }

    _approvePending() {
      if (this.state.mode === 'awaiting-approval') return this._approveProposal();
      if (this.state.mode === 'awaiting-nav-confirm') return this._approveNav();
      return undefined;
    }

    _rejectPending() {
      if (this.state.mode === 'awaiting-approval') return this._rejectProposal();
      if (this.state.mode === 'awaiting-nav-confirm') return this._rejectNav();
      return undefined;
    }

    _onGlobalKeydown(e) {
      if (!LFL.guards.isTrustedInputEvent(e)) return; // M3 H1
      // Events originating inside our own closed shadow root are retargeted
      // to this.host.
      if (e.target === this.host) {
        if (this._isAwaitingSomething()) {
          if (e.key === 'Escape') {
            e.preventDefault();
            this._rejectPending();
            return;
          }
          if (e.key === 'Tab') {
            // Focus trap (M2.1): while an approval is pending, Tab only ever
            // cycles between our own Approve/Reject controls - focus can
            // never move onto a page element (which would let a hostile
            // page's own focus/keydown handlers intercept the next
            // keystroke a human thinks is going to the approval gate).
            e.preventDefault();
            const active = this.shadow.activeElement;
            if (active === this.approveBtn) this.rejectBtn.focus();
            else this.approveBtn.focus();
            return;
          }
        }
        return;
      }
      const active = document.activeElement;
      const inEditable = !!(active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable));
      if (e.key === '`' && !inEditable) {
        e.preventDefault();
        this.toggle();
        return;
      }
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        this.toggle();
      }
    }

    _onInputKeydown(e) {
      if (!LFL.guards.isTrustedInputEvent(e)) return; // M3 H1
      // M4b (design §3): while a program is active, EVERY keystroke routes
      // here instead of the ordinary prompt - the input element is also set
      // readOnly for the duration (see _enterProgram()), but readOnly does
      // not stop keydown events from firing, so this check must come first.
      if (this._activeProgram) {
        this._routeProgramKey(e);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this._isAwaitingSomething()) {
          this._approvePending();
        } else {
          const raw = this.inputEl.value;
          this.inputEl.value = '';
          this._submitCommand(raw);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (this._isAwaitingSomething()) {
          this._rejectPending();
        } else {
          this.close();
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._historyStep(-1);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._historyStep(1);
      }
    }

    isOpen() {
      return this.panel.classList.contains('lfl-open');
    }

    open() {
      if (this._popoverSupported) {
        try { this.host.showPopover(); } catch (_e) { /* already open - ignore */ }
      }
      this.panel.classList.add('lfl-open');
      this.inputEl.focus();
      this._updateTestHook();
      // Refresh the SW-authoritative budget every time the overlay is
      // (re)opened, not just at construction - cheap, and keeps the
      // titlebar honest if a lot of async time passed since the last fetch.
      this._refreshRateLimitBudget();
      // M3: persist open state per tab so a later re-injection (navigation)
      // auto-reopens - see _restoreTerminalState(). Fire-and-forget.
      this._tsSend('TS_OPEN_SET', { open: true });
      // funpack v1: at most one dim fortune line per calendar day, shown
      // whenever the overlay is opened. Fire-and-forget, never delays the
      // focus()/updateTestHook() calls above.
      this._maybeShowMotd();
    }

    close() {
      // M4b (design §3): overlay hidden/closed while a program is active is
      // one of the mandatory forced-exit paths - checked first, mutually
      // exclusive with the awaiting-approval/awaiting-nav-confirm branches
      // below (a program never runs at the same time as either of those;
      // see _enterProgram()'s own awaiting-something guard).
      if (this._activeProgram) {
        this._exitProgram('closed', { restoreFocus: false });
      } else if (this.state.mode === 'awaiting-approval') {
        this._auditPush(this.state.pendingProposal, 'rejected(closed)', '(overlay closed while a proposal was pending)');
        this.state.pendingProposal = null;
        this.state.mode = 'idle';
        this.proposalEl.hidden = true;
        this.inputEl.readOnly = false;
        this._seq++;
        this._afterSettle(false); // M3: closing mid-approval clears any in-flight chain, same as an explicit reject
      } else if (this.state.mode === 'awaiting-nav-confirm') {
        this._auditPush({ action: 'go' }, 'rejected(closed)', '(overlay closed while a navigation confirm was pending)');
        this.state.pendingNav = null;
        this.state.mode = 'idle';
        this.proposalEl.hidden = true;
        this.inputEl.readOnly = false;
        this._seq++;
        this._afterSettle(false);
      }
      this.panel.classList.remove('lfl-open');
      if (this._popoverSupported) {
        try { this.host.hidePopover(); } catch (_e) { /* already closed - ignore */ }
      }
      this._updateTestHook();
      this._tsSend('TS_OPEN_SET', { open: false });
    }

    toggle() {
      if (this.isOpen()) this.close();
      else this.open();
    }

    // ---- output helpers ----

    // DOM-only append - used both by _appendLine() (new output, which also
    // persists to the SW-backed scrollback) and by _restoreTerminalState()
    // (rendering PREVIOUSLY-persisted lines, which must not be re-persisted
    // - that would just re-append the same lines to their own backing store
    // on every navigation). H3 (design doc §8): text is always assigned via
    // .textContent, never innerHTML/eval - a restored scrollback line (or
    // any other TS_* response field) is rendered as inert text, never as
    // markup or code.
    _appendLineDom(text, cls) {
      const div = document.createElement('div');
      div.className = `lfl-line lfl-${cls}`;
      div.textContent = text;
      this.outputEl.appendChild(div);
      while (this.outputEl.children.length > MAX_OUTPUT_LINES) {
        this.outputEl.removeChild(this.outputEl.firstChild);
      }
      this.outputEl.scrollTop = this.outputEl.scrollHeight;
    }

    // M3: persists the last ~100 lines per tab (design §4) - fire-and-forget,
    // display-only. Never read back into any LLM prompt (see
    // buildPayload()/buildNavLanePayload() in service-worker.js - neither
    // one accepts or reads a scrollback field at all).
    _appendLine(text, cls) {
      this._appendLineDom(text, cls);
      if (text) this._tsSend('TS_SCROLLBACK_APPEND', { text, cls });
    }

    printCmdEcho(text) { this._appendLine(text, 'cmd'); }
    printInfo(text) { if (text) this._appendLine(text, 'info'); }
    printOk(text) { if (text) this._appendLine(text, 'ok'); }
    printError(text) { if (text) this._appendLine(text, 'error'); }
    clearOutput() {
      this.outputEl.innerHTML = '';
      this._tsSend('TS_SCROLLBACK_CLEAR');
    }

    // Surfaces an event that happens OUTSIDE the synchronous submit->settle
    // flow - e.g. nav-watch.js's onBlocked/onDetectedOnly callbacks, which
    // fire asynchronously (sometime after execute() already returned) when
    // the Navigation API's `navigate` event lands. Bumps `_seq` too, so
    // tests polling the seq counter can observe these the same way they
    // observe ordinary command settles.
    reportAsync(message, level) {
      level = level === 'error' ? 'error' : (level === 'ok' ? 'ok' : 'info');
      if (level === 'error') this.printError(message);
      else if (level === 'ok') this.printOk(message);
      else this.printInfo(message);
      LFL.auditLog.push({
        command: this._lastCommand,
        summary: '(async event)',
        verdict: level === 'error' ? 'blocked' : 'observed',
        result: message,
      });
      this._lastResult = { ok: level !== 'error', message };
      this._seq++;
      this._updateTestHook();
    }

    // ---- history ----

    _loadHistory() {
      try {
        chrome.storage.local.get(['lflHistory'], (res) => {
          if (chrome.runtime.lastError) return;
          if (res && Array.isArray(res.lflHistory)) this.state.history = res.lflHistory;
        });
      } catch (_e) { /* storage unavailable - history just won't persist across pages */ }
    }

    _saveHistory() {
      try {
        chrome.storage.local.set({ lflHistory: this.state.history.slice(-MAX_HISTORY) });
      } catch (_e) { /* best-effort */ }
    }

    _pushHistory(raw) {
      if (!raw) return;
      this.state.history.push(raw);
      if (this.state.history.length > MAX_HISTORY) this.state.history.shift();
      this.state.historyIdx = this.state.history.length;
      this._saveHistory();
    }

    _historyStep(delta) {
      if (this.state.history.length === 0) return;
      let idx = this.state.historyIdx + delta;
      idx = Math.max(0, Math.min(this.state.history.length, idx));
      this.state.historyIdx = idx;
      this.inputEl.value = idx < this.state.history.length ? this.state.history[idx] : '';
    }

    // ---- command dispatch ----

    _settle(ok, message) {
      this._lastResult = { ok, message: message || '' };
      this._seq++;
      this._updateTestHook();
    }

    // M3 (design doc §5): the queue only ever holds user-typed text, and
    // only continues past a successful settle. "Any error/block/rejection/
    // Esc clears the whole queue" (plan §13 item 2) - this is the single
    // choke point that enforces that: every dispatch path below calls
    // _afterSettle(ok) exactly once at its own settle point, ok being
    // whether THAT step succeeded. See registry.js/nav.js for the pure
    // pieces; this is the stateful glue.
    _afterSettle(ok) {
      if (ok) {
        this._advanceQueue();
      } else {
        this._tsSend('TS_QUEUE_CLEAR');
      }
    }

    async _advanceQueue() {
      const peek = await this._tsSend('TS_QUEUE_PEEK');
      if (!peek.ok || !Array.isArray(peek.queue) || peek.queue.length === 0) return;
      // Arrival check (design §5) - fail closed: an origin mismatch (e.g. a
      // redirect, or an open-redirect URL, landing the tab somewhere the
      // human didn't ask for) halts the queue outright rather than running
      // the next typed command on whatever page we actually ended up on.
      const arrival = LFL.nav.checkArrival(
        typeof location !== 'undefined' ? location.origin : null,
        peek.expectedOrigin,
      );
      if (!arrival.ok) {
        this.printError(arrival.message);
        this._auditPush({ action: 'queue' }, 'halted(arrival-mismatch)', arrival.message);
        this._settle(false, arrival.message);
        await this._tsSend('TS_QUEUE_CLEAR');
        return;
      }
      const popped = await this._tsSend('TS_QUEUE_POP');
      if (!popped.ok || popped.next === null || popped.next === undefined) return;
      this._pushHistory(popped.next);
      this._lastCommand = popped.next;
      this.printCmdEcho(popped.next);
      // M4b: anything popped off the queue exists ONLY because an earlier
      // `&&` chain or macro expansion put it there - always chain/macro
      // context, regardless of how many segments came before it (see
      // _handleGameCommand()'s fromChain check).
      await this._dispatchSegment(popped.next, { fromChain: true });
    }

    _submitCommand(rawInput) {
      const raw = rawInput.trim();
      if (!raw) return;
      this._pushHistory(raw);
      this._lastCommand = raw;
      this.printCmdEcho(raw);

      // M2.3: "continue" and "budget" are rate-limiter controls, handled
      // here (not engine.js) because they resolve against the SW-
      // authoritative limiter for this tab - everything else about the
      // deterministic/LLM dispatch split is unchanged. Both are now async
      // (a message round trip to the service worker), unlike the old local-
      // instance version - see class header comment. Neither participates
      // in `&&` chaining (a rate-limit control makes no sense as a chain
      // step) - handled before any chain-splitting is even attempted.
      if (/^continue$/i.test(raw)) {
        this._rlResume().then((res) => {
          const msg = res.resumed ? 'resuming - rate-limit pause cleared' : 'nothing paused to continue';
          this.printInfo(msg);
          this._auditPush({ action: 'continue' }, 'auto', msg);
          this._settle(true, msg);
        });
        return;
      }
      if (/^budget$/i.test(raw)) {
        this._rlSend('RL_BUDGET').then((resp) => {
          const b = resp.budget;
          const msg = `LLM calls: ${b.llmRemaining}/${b.llmMax} remaining this window. Executed actions: ${b.actionRemaining}/${b.actionMax} remaining this window.${b.paused ? ' PAUSED - type "continue" to resume.' : ''}`;
          this.printInfo(msg);
          this._settle(true, msg);
        });
        return;
      }
      // M3 Terminal-level commands (design §6/§8) - need chrome.* / async
      // access engine.js's synchronous tryDeterministic() contract doesn't
      // have, so (like continue/budget above) they're dispatched here
      // rather than through the registry, and (like continue/budget) don't
      // participate in `&&` chaining - each is a standalone control command,
      // not a page-driving verb.
      if (/^dev\s+(on|off)$/i.test(raw)) { this._handleDevCommand(raw); return; }
      if (/^origins$/i.test(raw)) { this._handleOrigins(); return; }
      if (/^alias(\s|$)/i.test(raw)) { this._handleAliasCommand(raw); return; }
      if (/^unalias\s+\S+$/i.test(raw)) { this._handleUnaliasCommand(raw); return; }
      if (/^macro(\s|$)/i.test(raw)) { this._handleMacroCommand(raw); return; }
      if (/^unmacro\s+\S+$/i.test(raw)) { this._handleUnmacroCommand(raw); return; }
      // funpack v1: fortune/stats/theme/cowsay -- same "standalone control
      // command, no chain participation" posture as the M3 cluster just
      // above (they need chrome.storage.local access engine.js's
      // synchronous tryDeterministic() contract doesn't have; see
      // engine.js's registration comment for these four names).
      if (/^fortune$/i.test(raw)) { this._handleFortune(); return; }
      if (/^stats$/i.test(raw)) { this._handleStats(); return; }
      if (/^theme(\s|$)/i.test(raw)) { this._handleTheme(raw); return; }
      if (/^cowsay(\s|$)/i.test(raw)) { this._handleCowsay(raw); return; }

      this._runChain(raw);
    }

    // M3 (design §5/§6): expand a macro (depth-1, whole-input only), split
    // on top-level `&&` (quote-aware, cap 5), queue everything past the
    // first segment, then dispatch the first segment through the same path
    // every subsequent (queued) segment uses.
    async _runChain(raw) {
      const macroExpanded = LFL.registry.expandMacro(raw, this._aliasStore);
      const isMacroExpansion = macroExpanded !== raw;
      const split = LFL.registry.splitChain(macroExpanded, 5);
      if (!split.ok) {
        this.printError(split.reason);
        this._auditPush({ action: 'chain' }, 'blocked', split.reason);
        this._settle(false, split.reason);
        await this._tsSend('TS_QUEUE_CLEAR');
        return;
      }
      const segments = split.segments;
      if (segments.length === 0) return;

      // M4b (design §3): a game may never run as part of a chain or a
      // macro's expansion - `chainContext` is true either because this
      // raw input came from `macro`'s stored body (isMacroExpansion), or
      // because splitting on `&&` produced more than one segment. This is
      // the flag _dispatchSegment()/_handleGameCommand() below rejects on;
      // segments popped later off the SW-backed queue (_advanceQueue) are
      // unconditionally chain context too, by construction.
      const chainContext = isMacroExpansion || segments.length > 1;

      // M4b (design §3): "REFUSE to start a program while a && chain queue
      // is pending... (finish or cancel that first)". This can ONLY be
      // checked for the lone-command case (chainContext false) - and it
      // MUST be checked BEFORE the TS_QUEUE_SET/TS_QUEUE_CLEAR below, which
      // would otherwise silently cancel a still-pending earlier chain as an
      // unavoidable side effect of "typing something new abandons a stale
      // queue" (the very next comment down - true and correct for ordinary
      // commands, but wrong for a REFUSED game-start attempt: the human
      // must explicitly finish or cancel the pending chain themselves, a
      // blocked "snake" must not do it for them).
      if (!chainContext) {
        const resolvedGuess = LFL.registry.expandAlias(segments[0], this._aliasStore);
        const guessTok = (resolvedGuess.trim().split(/\s+/)[0] || '').toLowerCase();
        if (GAME_NAMES.has(guessTok)) {
          const blocked = await this._maybeBlockGameStart(guessTok);
          if (blocked) return;
        }
      }

      if (segments.length > 1) {
        await this._tsSend('TS_QUEUE_SET', {
          queue: segments.slice(1),
          expectedOrigin: typeof location !== 'undefined' ? location.origin : null,
        });
      } else {
        // A lone (non-chain) command abandons any stale queue left over from
        // an earlier interrupted chain - typing something new is itself a
        // decision not to continue waiting on the old one.
        await this._tsSend('TS_QUEUE_CLEAR');
      }
      await this._dispatchSegment(segments[0], { fromChain: chainContext });
    }

    // M4b (design §3): the "a chain queue is pending" half of the program
    // interaction locks (the "a proposal is awaiting approval" half is
    // structurally almost unreachable here - Enter routes to
    // _approvePending() instead of _submitCommand while awaiting something
    // - but _handleGameCommand() re-checks it too, as defense in depth).
    // Returns true (and has already printed/audited/settled the refusal)
    // if a game-start attempt must be blocked; false if it may proceed.
    // Deliberately does NOT call _afterSettle() on the blocked path - this
    // must leave any pending queue completely untouched (see _runChain()'s
    // caller comment for why).
    async _maybeBlockGameStart(name) {
      const peek = await this._tsSend('TS_QUEUE_PEEK');
      const pending = !!(peek.ok && Array.isArray(peek.queue) && peek.queue.length > 0);
      if (!pending) return false;
      const msg = `cannot start ${name} - a chained command is still pending (finish or cancel that first)`;
      this.printError(msg);
      this._auditPush({ action: 'game' }, 'blocked', msg);
      this._settle(false, msg);
      return true;
    }

    // The single per-segment dispatch path - used for both the first
    // segment of a freshly-submitted chain and every segment popped off the
    // SW-backed queue later (possibly after a navigation and a fresh
    // content-script injection). Alias-resolves the segment's leading word,
    // then routes to `go` (§2's ladder), the deterministic engine registry,
    // or (unchanged) the page-lane LLM.
    async _dispatchSegment(segment, opts) {
      opts = opts || {};
      // funpack v1 stats: every dispatched, chain-eligible segment counts
      // once toward `totalCommands` -- fire-and-forget, never awaited, never
      // throws (see _bumpStats()). Meta-commands handled earlier in
      // _submitCommand (continue/budget/alias/macro/fortune/stats/theme/
      // cowsay/etc.) never reach this function, so they're deliberately NOT
      // counted here -- `stats` is about page-driving commands.
      this._bumpStats({ totalCommands: 1 });

      const resolved = LFL.registry.expandAlias(segment, this._aliasStore);
      const firstTok = (resolved.trim().split(/\s+/)[0] || '').toLowerCase();

      if (firstTok === 'go') {
        await this._handleGo(resolved);
        return;
      }

      // M4b fun pack v2 (design §3/§4/§5): snake/2048/games - never part of
      // a chain or macro (opts.fromChain, computed by _runChain()/
      // _advanceQueue() above; this is what actually enforces the "reject
      // at dispatch when the segment comes from a chain/macro context"
      // rule for cases the write-time macro-body check can't see, e.g. an
      // alias whose EXPANSION text is a game name, invoked from inside a
      // macro). Dispatched here (not in _submitCommand, unlike the
      // fortune/stats/theme/cowsay quartet) specifically so this
      // chain-context check is reachable at all - see _handleGameCommand().
      if (GAME_NAMES.has(firstTok)) {
        await this._handleGameCommand(firstTok, opts);
        return;
      }

      // M4b verify fix (MED-2): funpack commands in a chain/macro segment
      // are rejected (previously they silently fell through to _runLlm()
      // below - see FUNPACK_NAMES's own comment). Reached only via a chain
      // segment or an alias expansion; a directly-typed `fortune` never
      // gets here (matched in _submitCommand()). The non-chain case (an
      // alias like `alias f = fortune`, typed alone) routes to the real
      // handler instead of the model - same outcome as typing the name
      // directly, which is what an alias is supposed to mean.
      if (FUNPACK_NAMES.has(firstTok)) {
        if (opts.fromChain) {
          const msg = `"${firstTok}" does not run in chains or macros - type it directly instead`;
          this.printError(msg);
          this._auditPush({ action: 'funpack' }, 'blocked', msg);
          this._settle(false, msg);
          this._afterSettle(false);
          return;
        }
        if (firstTok === 'fortune') { this._handleFortune(); return; }
        if (firstTok === 'stats') { this._handleStats(); return; }
        if (firstTok === 'theme') { this._handleTheme(resolved); return; }
        this._handleCowsay(resolved);
        return;
      }

      const det = LFL.engine.tryDeterministic(resolved, this.state);
      if (det !== null) {
        // funpack v1 stats: this is the "resolved deterministically, never
        // touched the model" point `stats`'s headline percentage is built
        // from (formatStatsSummary() in funpack.js).
        this._bumpStats({ deterministicHits: 1 });
        if (det.clear) this.clearOutput();
        this.printInfo(det.output);
        this._auditPush({ action: 'deterministic' }, 'auto', det.output ? det.output.slice(0, 160) : '');
        this._settle(true, det.output || '');
        // FIX 1 (security verify LOW-1): `back`/same-origin `open`/`open!`/
        // auto-submitting `search` all INITIATE a navigation from inside
        // tryDeterministic() (engine.js tags the result `navInitiated: true`
        // on exactly those branches - see engine.js's own comments). Because
        // location.href/history.back()/form.submit() do not unload the
        // document synchronously, calling the ordinary _afterSettle(true) ->
        // _advanceQueue() here would run the NEXT queued segment against the
        // OLD, about-to-unload document - defeating design §5's "run where
        // you arrive" semantics (confirmed non-exploitable for cross-origin
        // execution, since the queue only ever holds typed text either way,
        // but still the wrong document). Skip the synchronous advance
        // entirely for these results - no _afterSettle call at all, so the
        // queue (and its recorded expectedOrigin) is left exactly as it was.
        // Continuation is then driven the same way `go` already drives it:
        // the next content-script injection's _restoreTerminalState() ->
        // _advanceQueue() -> arrival check. See docs/threat-model.md's
        // "Queue risks" section for the full writeup, including the
        // fail-closed `back`-in-chain halt semantics.
        if (det.navInitiated) return;
        this._afterSettle(true);
        return;
      }

      // M4a - did-you-mean (tool 3, design note in engine.js's header):
      // NOT an "ask ..." (that's the unambiguous, explicit model path) and
      // NOT a bare number (engine.js's tryDeterministic() above always
      // returns non-null for one - an action or a gentle "no listing"
      // error - so det would never have been null in the first place; this
      // second check is defense in depth for this function's own contract,
      // not a case that can actually be reached via a bare-number input
      // today). Deliberately narrows the model surface, never widens it -
      // this can only intercept some inputs that would otherwise have
      // reached _runLlm() below; nothing here ever routes text TO the model
      // that wouldn't already have gone there.
      const isAsk = /^ask(\s|$)/i.test(resolved);
      if (!isAsk) {
        const candidates = LFL.registry.didYouMean(resolved, LFL.commandRegistry.names());
        if (candidates.length > 0) {
          const token = (resolved.trim().split(/\s+/)[0] || '');
          const suggestion = candidates.length === 1
            ? candidates[0]
            : candidates.join(', ');
          const msg = `unknown command "${token}" - did you mean: ${suggestion}? (or prefix with "ask" to send to the local model)`;
          this.printError(msg);
          this._auditPush({ action: 'did-you-mean' }, 'blocked', msg);
          this._settle(false, msg);
          this._afterSettle(false);
          return;
        }
      }

      const command = resolved.replace(/^ask\s+/i, '');
      await this._runLlm(command);
    }

    // ---- M3 alias/macro/origins/dev commands ----

    _handleAliasCommand(raw) {
      const m = raw.match(/^alias\s+(\S+)\s*=\s*(.+)$/i);
      if (!m) {
        const list = this._aliasStore.listAliases();
        const keys = Object.keys(list);
        const msg = keys.length ? keys.map((k) => `${k} = ${list[k]}`).join('\n') : '(no aliases defined)';
        this.printInfo(msg);
        this._auditPush({ action: 'alias' }, 'auto', msg.slice(0, 160));
        this._settle(true, msg);
        return;
      }
      const [, name, expansion] = m;
      const res = this._aliasStore.setAlias(name.toLowerCase(), expansion);
      const msg = res.ok ? `alias defined: ${name} = ${expansion.trim()}` : `alias: ${res.reason}`;
      if (res.ok) this.printOk(msg); else this.printError(msg);
      this._auditPush({ action: 'alias' }, res.ok ? 'auto' : 'blocked', msg);
      this._settle(res.ok, msg);
    }

    _handleUnaliasCommand(raw) {
      const m = raw.match(/^unalias\s+(\S+)$/i);
      const name = m ? m[1].toLowerCase() : '';
      const res = this._aliasStore.unsetAlias(name);
      const msg = res.ok ? `alias removed: ${name}` : `unalias: ${res.reason}`;
      if (res.ok) this.printOk(msg); else this.printError(msg);
      this._auditPush({ action: 'unalias' }, res.ok ? 'auto' : 'blocked', msg);
      this._settle(res.ok, msg);
    }

    _handleMacroCommand(raw) {
      const m = raw.match(/^macro\s+(\S+)\s*=\s*(.+)$/i);
      if (!m) {
        const list = this._aliasStore.listMacros();
        const keys = Object.keys(list);
        const msg = keys.length ? keys.map((k) => `${k} = ${list[k]}`).join('\n') : '(no macros defined)';
        this.printInfo(msg);
        this._auditPush({ action: 'macro' }, 'auto', msg.slice(0, 160));
        this._settle(true, msg);
        return;
      }
      const [, name, chainText] = m;
      const res = this._aliasStore.setMacro(name.toLowerCase(), chainText);
      const msg = res.ok ? `macro defined: ${name} = ${chainText.trim()}` : `macro: ${res.reason}`;
      if (res.ok) this.printOk(msg); else this.printError(msg);
      this._auditPush({ action: 'macro' }, res.ok ? 'auto' : 'blocked', msg);
      this._settle(res.ok, msg);
    }

    _handleUnmacroCommand(raw) {
      const m = raw.match(/^unmacro\s+(\S+)$/i);
      const name = m ? m[1].toLowerCase() : '';
      const res = this._aliasStore.unsetMacro(name);
      const msg = res.ok ? `macro removed: ${name}` : `unmacro: ${res.reason}`;
      if (res.ok) this.printOk(msg); else this.printError(msg);
      this._auditPush({ action: 'unmacro' }, res.ok ? 'auto' : 'blocked', msg);
      this._settle(res.ok, msg);
    }

    // ---- funpack v1: fortune / stats / theme / cowsay ----
    //
    // All four are pure-data/pure-function driven by extension/content/
    // funpack.js -- this class's job is only the chrome.storage.local round
    // trip and the printing/DOM-class-toggling around them, same division of
    // labor as the alias/macro handlers just above use for registry.js.

    _handleFortune() {
      const line = LFL.funpack.getFortune(Date.now());
      this.printInfo(line);
      this._auditPush({ action: 'fortune' }, 'auto', line);
      this._settle(true, line);
    }

    _statsUnavailable() {
      const msg = 'stats unavailable (storage error)';
      this.printError(msg);
      this._auditPush({ action: 'stats' }, 'n/a', msg);
      this._settle(false, msg);
    }

    _handleStats() {
      try {
        chrome.storage.local.get(['lflStats'], (res) => {
          if (chrome.runtime.lastError) { this._statsUnavailable(); return; }
          try {
            const stats = LFL.funpack.mergeStats(res && res.lflStats);
            const msg = LFL.funpack.formatStatsSummary(stats);
            this.printInfo(msg);
            this._auditPush({ action: 'stats' }, 'auto', msg.slice(0, 160));
            this._settle(true, msg);
          } catch (_e) {
            this._statsUnavailable();
          }
        });
      } catch (_e) {
        this._statsUnavailable();
      }
    }

    // Toggles the `.lfl-theme-<name>` class on `this.panel` -- the shadow
    // root's own top-level container, see terminal.css's funpack-v1 comment
    // block for how the --lfl-* custom properties this switches cascade down
    // to every color rule below it.
    _applyTheme(name) {
      LFL.funpack.THEMES.forEach((t) => this.panel.classList.remove(`lfl-theme-${t}`));
      this.panel.classList.add(`lfl-theme-${name}`);
    }

    // Loads the persisted theme choice (storage.local `lflTheme`) once at
    // construction and applies it -- fire-and-forget; any storage error just
    // leaves the panel on its default (no-class) fallback CSS values, which
    // is visually identical to `.lfl-theme-default` anyway.
    _loadTheme() {
      try {
        chrome.storage.local.get(['lflTheme'], (res) => {
          if (chrome.runtime.lastError) return;
          const name = LFL.funpack.isValidTheme(res && res.lflTheme) ? res.lflTheme : LFL.funpack.THEME_DEFAULT;
          this._applyTheme(name);
        });
      } catch (_e) { /* storage unavailable -- stays on the default theme's fallback CSS values */ }
    }

    _handleTheme(raw) {
      const m = raw.match(/^theme\s+(\S+)$/i);
      if (!m) {
        try {
          chrome.storage.local.get(['lflTheme'], (res) => {
            const active = (!chrome.runtime.lastError && LFL.funpack.isValidTheme(res && res.lflTheme))
              ? res.lflTheme
              : LFL.funpack.THEME_DEFAULT;
            const msg = LFL.funpack.themeListText(active);
            this.printInfo(msg);
            this._auditPush({ action: 'theme' }, 'auto', msg.slice(0, 160));
            this._settle(true, msg);
          });
        } catch (_e) {
          const msg = LFL.funpack.themeListText(LFL.funpack.THEME_DEFAULT);
          this.printInfo(msg);
          this._settle(true, msg);
        }
        return;
      }
      const name = m[1].toLowerCase();
      if (!LFL.funpack.isValidTheme(name)) {
        const msg = `theme: unknown theme "${name}" - try: ${LFL.funpack.THEMES.join(', ')}`;
        this.printError(msg);
        this._auditPush({ action: 'theme' }, 'blocked', msg);
        this._settle(false, msg);
        return;
      }
      this._applyTheme(name);
      try { chrome.storage.local.set({ lflTheme: name }); } catch (_e) { /* best-effort */ }
      const msg = `theme set: ${name}`;
      this.printOk(msg);
      this._auditPush({ action: 'theme' }, 'auto', msg);
      this._settle(true, msg);
    }

    _handleCowsay(raw) {
      const m = raw.match(/^cowsay\s+([\s\S]+)$/i);
      const text = m ? m[1].trim() : '';
      if (!text) {
        const msg = 'usage: cowsay <text>';
        this.printError(msg);
        this._auditPush({ action: 'cowsay' }, 'blocked', msg);
        this._settle(false, msg);
        return;
      }
      const out = LFL.funpack.cowsay(text);
      this.printInfo(out);
      this._auditPush({ action: 'cowsay' }, 'auto', 'cowsay');
      this._settle(true, out);
    }

    // ---- M4b fun pack v2: snake / 2048 / games (design doc §3/§4/§5) ----
    //
    // All game LOGIC (step/turn/merge/spawn/render) lives in
    // extension/content/games.js, pure and DOM/chrome-free (see that file's
    // header comment and the purity-grep test). Everything below is glue:
    // dispatch-context locks, the `<pre class="lfl-frame">` element, the
    // setInterval tick, key routing while a program is active, and the
    // chrome.storage.local high-score round trip -- same division of labor
    // the fortune/stats/theme/cowsay handlers above use for funpack.js.

    // Dispatched only when NOT fromChain (see _dispatchSegment()) and only
    // for `games` itself -- `snake`/`2048` route to _enterProgram() instead,
    // which owns the "awaiting-something"/already-running checks (design
    // §3's OTHER interaction lock; the "chain queue pending" lock is
    // enforced earlier, in _runChain()/_maybeBlockGameStart(), before this
    // function is ever reached).
    async _handleGameCommand(name, opts) {
      opts = opts || {};
      if (opts.fromChain) {
        const msg = `"${name}" cannot run inside a chain or macro - play it directly instead`;
        this.printError(msg);
        this._auditPush({ action: 'game' }, 'blocked', msg);
        this._settle(false, msg);
        this._afterSettle(false); // consistent with every other blocked-segment case: clears the rest of the chain
        return;
      }
      if (name === 'games') {
        await this._printGamesList();
        this._afterSettle(true);
        return;
      }
      if (name === 'snake') this._startSnake();
      else if (name === '2048') this._start2048();
      else if (name === 'sl') this._startSL();
      // Starting a program does NOT itself settle/advance a chain the way
      // every other command does (see _settle()/_afterSettle()) -- a
      // program stays interactively active until an explicit exit path
      // fires _exitProgram(), which performs the real settle/audit at THAT
      // point. _enterProgram() below settles once immediately too (whether
      // it actually started or was refused), so the caller always sees a
      // seq bump either way.
    }

    // `games` -- list available games plus their persisted best score/play
    // count. Read-only, never enters program mode, so it does not need
    // _enterProgram()'s awaiting-something/already-running guard.
    async _printGamesList() {
      const rows = [{ label: 'snake', key: 'snake' }, { label: '2048', key: 'g2048' }];
      const scores = await new Promise((resolve) => {
        try {
          chrome.storage.local.get(['lflGameScores'], (res) => {
            const ok = !chrome.runtime.lastError;
            resolve(ok && res && res.lflGameScores && typeof res.lflGameScores === 'object' ? res.lflGameScores : {});
          });
        } catch (_e) { resolve({}); }
      });
      const lines = rows.map(({ label, key }) => {
        const s = (scores[key] && typeof scores[key] === 'object') ? scores[key] : {};
        const best = Number.isFinite(s.best) ? s.best : 0;
        const plays = Number.isFinite(s.plays) ? s.plays : 0;
        return `  ${label.padEnd(8)}best ${best}  plays ${plays}`;
      });
      const msg = `available games (q or Esc to quit any of them):\n${lines.join('\n')}`;
      this.printInfo(msg);
      this._auditPush({ action: 'games' }, 'auto', msg.slice(0, 160));
      this._settle(true, msg);
    }

    // Fire-and-forget high-score write (design §4): chrome.storage.local key
    // `lflGameScores` = `{snake:{best,plays}, g2048:{best,plays}}`. `best`
    // only ever increases (Math.max against whatever was already stored);
    // `plays` always increments, win or lose. Storage errors are swallowed
    // -- a missed high-score write is harmless, unlike blocking the command
    // path on it.
    _recordGameScore(storageKind, score) {
      try {
        chrome.storage.local.get(['lflGameScores'], (res) => {
          try {
            if (chrome.runtime.lastError) return;
            const all = (res && res.lflGameScores && typeof res.lflGameScores === 'object') ? res.lflGameScores : {};
            const prev = (all[storageKind] && typeof all[storageKind] === 'object') ? all[storageKind] : {};
            const prevBest = Number.isFinite(prev.best) ? prev.best : 0;
            const prevPlays = Number.isFinite(prev.plays) ? prev.plays : 0;
            const next = Object.assign({}, all, {
              [storageKind]: { best: Math.max(prevBest, Number.isFinite(score) ? score : 0), plays: prevPlays + 1 },
            });
            chrome.storage.local.set({ lflGameScores: next });
          } catch (_e) { /* best-effort, fire-and-forget */ }
        });
      } catch (_e) { /* storage unavailable this play -- score just isn't recorded */ }
    }

    _startSnake() {
      const rng = Math.random;
      let state = LFL.games.createSnakeGame(rng);
      const renderNow = () => LFL.games.renderSnake(state);
      const prog = {
        name: 'snake',
        initialFrame: renderNow(),
        getFps: () => LFL.games.snakeFps(state.foodsEaten),
        onKey: (key) => {
          const dirKey = ARROW_KEY_DIRS[key];
          if (!dirKey || !state.alive) return null;
          state = LFL.games.turnSnake(state, dirKey);
          return renderNow();
        },
        onTick: () => {
          if (!state.alive) return null;
          state = LFL.games.stepSnake(state, rng);
          // Death stops the TICK (no more frames advance on their own) but
          // deliberately does NOT force-exit the program -- the human sees
          // the final board + "GAME OVER" line and presses q/Esc themselves,
          // same as every other exit path (design §3/§4).
          if (!state.alive) this._stopProgramTick();
          return renderNow();
        },
        onExit: () => {
          this._recordGameScore('snake', state.score);
          return [`snake: game over - score ${state.score}`];
        },
      };
      this._enterProgram(prog);
    }

    _start2048() {
      const rng = Math.random;
      let state = LFL.games.createGame2048(rng);
      const renderNow = () => LFL.games.render2048(state);
      const prog = {
        name: '2048',
        initialFrame: renderNow(),
        // Key-driven only (design §4) -- no onTick/getFps at all.
        onKey: (key) => {
          const dirKey = ARROW_KEY_DIRS[key];
          if (!dirKey) return null;
          const result = LFL.games.move2048(state, dirKey, rng);
          state = result.state;
          return renderNow();
        },
        onExit: () => {
          this._recordGameScore('g2048', state.score);
          return [`2048: game over - score ${state.score}`];
        },
      };
      this._enterProgram(prog);
    }

    // `sl` - the classic steam-locomotive easter egg. No game state at
    // all (unlike snake/2048): a plain tick counter and games.js's pure
    // slFrame()/slTotalTicks(). The one thing that makes this program
    // different from snake/2048 is that it EXITS ITSELF once the engine
    // has fully crossed off the left edge, instead of waiting for q/Esc
    // (the classic `sl` is famously uninterruptible - ours isn't: q/Esc
    // still work early, same fail-safe as every other program, see
    // _routeProgramKey() - but it doesn't need them to end normally).
    // onTick is a closure over `this` (same as every prog callback here),
    // so it can call _exitProgram() directly on the final tick - no new
    // primitive needed in _enterProgram()/_startProgramTick() for this;
    // every existing lock (chain/macro rejection, awaiting-something,
    // already-running) is inherited automatically because GAME_NAMES/
    // _handleGameCommand() route `sl` through the exact same path as
    // snake/2048.
    _startSL() {
      const cols = LFL.games.SL_COLS;
      const rows = LFL.games.SL_ROWS;
      const totalTicks = LFL.games.slTotalTicks(cols);
      let tick = 0;
      const prog = {
        name: 'sl',
        initialFrame: LFL.games.slFrame(0, cols, rows),
        getFps: () => 8,
        // No onKey - sl takes no input while running, same as 2048 has no
        // onTick; q/Esc are intercepted before onKey is ever consulted
        // (see _routeProgramKey()).
        onTick: () => {
          tick += 1;
          if (tick >= totalTicks) {
            // Auto-exit choke point: the SAME _exitProgram() every other
            // exit path uses (q/Esc, navigation, proposal arriving) - so
            // the onExit summary line, audit entry, and _settle() all
            // happen exactly once, exactly the normal way. Returning null
            // here (rather than a final blank frame) is fine - the engine
            // is already fully off-screen by definition of totalTicks
            // (see games.js's slTotalTicks() comment), so there is
            // nothing left worth drawing.
            this._exitProgram('complete');
            return null;
          }
          return LFL.games.slFrame(tick, cols, rows);
        },
        onExit: () => ['you meant ls. the train forgives.'],
      };
      this._enterProgram(prog);
    }

    // ---- M4b program-mode primitive (design §3) ----
    //
    // `prog = {name, onKey(key)->frameStr|null, onTick?()->frameStr|null,
    // getFps?()->number, initialFrame?, onExit()->summaryLines[]}`. This is
    // the ONLY place the "awaiting-something" interaction lock and the
    // already-running guard are enforced for program entry (the "chain
    // queue pending" lock is enforced earlier still, in _runChain(), before
    // _dispatchSegment() is even reached with a lone command -- see
    // _maybeBlockGameStart()'s own comment for why it has to run that
    // early). Any FUTURE program (this build only ships snake/2048)
    // automatically inherits every lock here for free.
    _enterProgram(prog) {
      if (this._isAwaitingSomething()) {
        const msg = `cannot start ${prog.name} while a proposal is awaiting approval (finish or cancel that first)`;
        this.printError(msg);
        this._auditPush({ action: 'game' }, 'blocked', msg);
        this._settle(false, msg);
        return false;
      }
      if (this._activeProgram) {
        const msg = `${this._activeProgram.prog.name} is already running - press q or Esc to quit it first`;
        this.printError(msg);
        this._auditPush({ action: 'game' }, 'blocked', msg);
        this._settle(false, msg);
        return false;
      }
      const frameEl = this._createFrameElement();
      frameEl.textContent = typeof prog.initialFrame === 'string' ? prog.initialFrame : '';
      this._activeProgram = { prog, frameEl, intervalId: null };
      this._activeProgram.intervalId = this._startProgramTick(prog);
      this.state.mode = 'program';
      this.inputEl.readOnly = true;
      this._auditPush({ action: 'game' }, 'auto', `${prog.name} started`);
      this._settle(true, `${prog.name} started`);
      this._updateTestHook();
      return true;
    }

    // Appends ONE <pre class="lfl-frame"> to the existing shadow-root output
    // path (design §3) -- every redraw thereafter is a single
    // `frameEl.textContent = str` assignment (_renderProgramFrame()), never
    // per-line node churn, never innerHTML.
    _createFrameElement() {
      const el = document.createElement('pre');
      el.className = 'lfl-frame';
      this.outputEl.appendChild(el);
      this.outputEl.scrollTop = this.outputEl.scrollHeight;
      return el;
    }

    _renderProgramFrame(text) {
      if (!this._activeProgram) return;
      this._activeProgram.frameEl.textContent = text;
      this.outputEl.scrollTop = this.outputEl.scrollHeight;
    }

    // Runner-owned setInterval (design §3): fps is clamped to <=10 here
    // REGARDLESS of what the game reports (defense in depth against a game
    // bug ever exceeding the design ceiling), and the tick pauses entirely
    // while `document.hidden` (a read-only visibility check -- never a page-
    // DOM interaction). Runs a fixed 100ms (10Hz) scheduler and only fires
    // `prog.onTick()` once enough accumulated time has passed for the
    // CURRENT fps -- this lets a game's own speed (snake's foods-eaten speed
    // curve) change smoothly without ever tearing down/recreating the
    // interval.
    _startProgramTick(prog) {
      if (typeof prog.onTick !== 'function') return null;
      const BASE_MS = 100;
      let acc = 0;
      return setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        const rawFps = typeof prog.getFps === 'function' ? prog.getFps() : (prog.fps || 5);
        const fps = Math.min(10, Math.max(1, Number.isFinite(rawFps) ? rawFps : 5));
        acc += BASE_MS;
        if (acc < 1000 / fps) return;
        acc = 0;
        const frame = prog.onTick();
        if (typeof frame === 'string') this._renderProgramFrame(frame);
      }, BASE_MS);
    }

    // Stops ticking WITHOUT exiting the program (used on snake death -- the
    // final frame stays up, the human still has to press q/Esc to actually
    // leave; see _startSnake()'s onTick).
    _stopProgramTick() {
      if (this._activeProgram && this._activeProgram.intervalId) {
        clearInterval(this._activeProgram.intervalId);
        this._activeProgram.intervalId = null;
      }
    }

    // Routes every keydown to the active program while one is running
    // (called from _onInputKeydown, already isTrusted-gated by H1 -- see
    // that method). `q`/`Q`/`Escape` are intercepted HERE, never passed to
    // `prog.onKey`, so no game needs to reimplement its own quit key.
    // Arrow keys always get preventDefault() (design §3), even for a key
    // the active program doesn't otherwise use, so the underlying page
    // never scrolls out from under a running game.
    _routeProgramKey(e) {
      // M4b verify fix (LOW-4): while a program is active, no keystroke
      // aimed at the game should bubble out to page document listeners
      // (shadow-root events retarget but still propagate to the document).
      // Scoped ONLY to this program-mode path - ordinary typing keeps the
      // terminal's original propagation semantics untouched.
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      const key = e.key;
      if (Object.prototype.hasOwnProperty.call(ARROW_KEY_DIRS, key)) {
        e.preventDefault();
      }
      if (key === 'q' || key === 'Q' || key === 'Escape') {
        e.preventDefault();
        this._exitProgram('quit');
        return;
      }
      const active = this._activeProgram;
      if (!active || typeof active.prog.onKey !== 'function') return;
      const frame = active.prog.onKey(key);
      if (typeof frame === 'string') this._renderProgramFrame(frame);
    }

    // The single choke point for every exit path (design §3: q/Esc, overlay
    // hidden/closed, any navigation signal -- see close()/_wireEvents()'s
    // pagehide+navigate listeners for the other two call sites). Clears the
    // interval, restores the prompt, keeps the final frame in scrollback
    // (nothing more to do for that -- it is already the last child appended
    // to outputEl, same as any other printed line), and prints onExit()'s
    // score summary. `opts.restoreFocus:false` skips refocusing the input
    // when the overlay is about to hide/unload anyway (close()/navigation),
    // where focusing a now-invisible-or-dying input would be pointless.
    _exitProgram(reason, opts) {
      opts = opts || {};
      const active = this._activeProgram;
      if (!active) return;
      this._activeProgram = null;
      if (active.intervalId) clearInterval(active.intervalId);
      this.state.mode = 'idle';
      this.inputEl.readOnly = false;
      if (opts.restoreFocus !== false) {
        try { this.inputEl.focus(); } catch (_e) { /* best-effort */ }
      }
      let summary = [];
      try {
        summary = (typeof active.prog.onExit === 'function') ? (active.prog.onExit() || []) : [];
      } catch (_e) { summary = []; }
      const lines = Array.isArray(summary) ? summary : [summary];
      lines.forEach((line) => { if (line) this.printInfo(line); });
      this._auditPush({ action: 'game' }, reason, `${active.prog.name} exited (${reason})`);
      this._settle(true, `${active.prog.name} exited (${reason})`);
      this._updateTestHook();
    }

    // M4b verify fix (MED-1): the reverse arm of the program/proposal
    // mutual exclusion. _enterProgram() refuses to start while a proposal/
    // nav-confirm is pending; this closes the OTHER direction - a proposal
    // or navigation confirm arriving (from an async model round trip that
    // was already in flight when the game started) while a program is
    // active. Called at the very top of _presentProposal() and
    // _confirmOrNavigate(), BEFORE either touches state.mode/the approval
    // card/approveBtn.focus(): the program is force-exited through the
    // ordinary _exitProgram() choke point (interval cleared, score summary
    // printed, mode back to 'idle'), with restoreFocus:false since the
    // approval flow is about to claim focus for its own Approve control
    // anyway. Guarantees a proposal can never render over a still-ticking
    // game, and Enter can never be swallowed ambiguously between "game
    // input" and "approve a mutating action".
    _maybeExitProgramForProposal() {
      if (!this._activeProgram) return;
      this._exitProgram('proposal', { restoreFocus: false });
      this.printInfo('game ended: a proposal arrived');
    }

    // Fire-and-forget lflStats bump, called from _dispatchSegment/
    // _presentProposal/_approveProposal above -- never awaited from the
    // command path, and every failure mode here is swallowed (a dropped
    // stats increment is harmless; blocking or throwing on the command path
    // would not be). See funpack.js's mergeStats()/applyDailyStreak()/
    // applyStatsIncrement() for the pure math this wraps.
    _bumpStats(fields) {
      try {
        chrome.storage.local.get(['lflStats'], (res) => {
          try {
            if (chrome.runtime.lastError) return;
            const today = LFL.funpack.todayStr();
            let stats = LFL.funpack.mergeStats(res && res.lflStats);
            stats = LFL.funpack.applyDailyStreak(stats, today);
            stats = LFL.funpack.applyStatsIncrement(stats, fields);
            chrome.storage.local.set({ lflStats: stats });
          } catch (_e) { /* best-effort, fire-and-forget */ }
        });
      } catch (_e) { /* storage unavailable this tick -- next command tries again */ }
    }

    // MOTD (funpack v1): at most one dim fortune line per calendar day,
    // shown when the overlay is opened (see open() above) -- never blocks or
    // delays anything there, and any storage error here is swallowed (no
    // MOTD today is always the safe fallback direction). Uses _appendLineDom
    // directly rather than _appendLine, deliberately NOT persisting this line
    // to the scrollback -- scrollback restore (_restoreTerminalState()) would
    // otherwise replay it on every subsequent navigation this same calendar
    // day, which is not "at most once per day" from the human's point of
    // view.
    _maybeShowMotd() {
      try {
        chrome.storage.local.get(['lflMotdDay'], (res) => {
          try {
            if (chrome.runtime.lastError) return;
            const today = LFL.funpack.todayStr();
            if (!LFL.funpack.shouldShowMotd(res && res.lflMotdDay, today)) return;
            const line = LFL.funpack.getFortune(LFL.funpack.dayOfYear(new Date()));
            this._appendLineDom(line, 'motd');
            chrome.storage.local.set({ lflMotdDay: today });
          } catch (_e) { /* swallow -- MOTD is decorative, never worth surfacing an error for */ }
        });
      } catch (_e) { /* storage unavailable -- no MOTD today, harmless */ }
    }

    _handleDevCommand(raw) {
      const on = /\bon$/i.test(raw.trim());
      this._devHooksEnabled = on;
      try { chrome.storage.local.set({ lflDevHooks: on }); } catch (_e) { /* best-effort */ }
      const msg = `dev hooks ${on ? 'ENABLED' : 'disabled'} (data-lfl-state test attribute) - see docs/threat-model.md H2`;
      this.printInfo(msg);
      this._auditPush({ action: 'dev' }, 'auto', msg);
      this._settle(true, msg);
    }

    async _handleOrigins() {
      const resp = await this._tsSend('TS_VISITED_LIST');
      const origins = (resp.ok && Array.isArray(resp.visitedOrigins)) ? resp.visitedOrigins : [];
      const msg = origins.length ? origins.join('\n') : '(no origins visited yet this tab session)';
      this.printInfo(msg);
      this._auditPush({ action: 'origins' }, 'auto', msg.slice(0, 160));
      this._settle(true, msg);
    }

    // ---- M3 `go` - the navigation verb (design §2/§3) ----

    async _handleGo(resolvedSegment) {
      const arg = resolvedSegment.replace(/^go\s*/i, '').trim();
      if (!arg) {
        const msg = 'usage: go <destination>';
        this.printError(msg);
        this._auditPush({ action: 'go' }, 'blocked', msg);
        this._settle(false, msg);
        this._afterSettle(false);
        return;
      }

      const ladder = LFL.nav.resolveGoLadder({
        arg,
        aliasLookup: (name) => this._aliasStore.getAlias(name),
      });

      if (ladder.ok) {
        await this._confirmOrNavigate(ladder.url, { modelResolved: false });
        return;
      }

      if (!ladder.needsNavLane) {
        const msg = `go: ${ladder.reason}`;
        this.printError(msg);
        this._auditPush({ action: 'go' }, 'blocked', msg);
        this._settle(false, msg);
        this._afterSettle(false);
        return;
      }

      // Step 3 (design §2/§3): the nav-lane model call. Shares the LLM-call
      // rate-limit budget with page-lane (same RL_CHECK/RL_RECORD as
      // _runLlm() below) - both lanes are gated/recorded identically, only
      // the message type and the payload differ.
      const budgetCheck = await this._rlCheck('llm');
      if (!budgetCheck.allowed) {
        this.printError(budgetCheck.reason);
        this._auditPush({ action: 'go-nav-lane-rate-limited' }, 'blocked', budgetCheck.reason);
        this._settle(false, budgetCheck.reason);
        this._afterSettle(false);
        return;
      }
      await this._rlRecord('llm');

      this.printInfo('… asking the local model where to go');
      let resp;
      try {
        // THE isolation-critical call: the payload sent to the model
        // contains ONLY `command` (the user's typed segment text) - no
        // element list, no title, no origin, no scrollback. See
        // service-worker.js's buildNavLanePayload() and
        // tests/m3_nav_lane_isolation.test.js for the proof.
        resp = await chrome.runtime.sendMessage({ type: 'NAV_LLM_REQUEST', command: resolvedSegment });
      } catch (e) {
        resp = { ok: false, error: 'local model offline - deterministic commands still work (' + (e && e.message ? e.message : 'messaging error') + ')' };
      }
      if (!resp || !resp.ok) {
        const errMsg = (resp && resp.error) || 'local model offline - deterministic commands still work';
        this.printError(errMsg);
        this._auditPush({ action: 'go-nav-lane-error' }, 'n/a', errMsg);
        this._settle(false, errMsg);
        this._afterSettle(false);
        return;
      }

      const navAction = resp.action || {};
      if (navAction.action !== 'navigate') {
        const msg = `go: ${navAction.reason || 'the local model could not resolve a destination'}`;
        this.printInfo(msg);
        this._auditPush({ action: 'go-nav-lane-abort' }, 'auto', msg);
        this._settle(false, msg);
        this._afterSettle(false);
        return;
      }

      // Defense in depth: the model's own proposed URL is still validated
      // through the EXACT SAME literal-destination guard as ladder steps
      // 1/2 (http(s)-only, must look like a real destination) - the nav-lane
      // isolation removes page-injection risk, it does not exempt the
      // model's own output from the scheme floor everything else in this
      // extension is held to.
      const check = LFL.nav.resolveLiteralDestination(navAction.value || '');
      if (!check.ok) {
        const msg = `go: model proposed an unusable destination - ${check.reason}`;
        this.printError(msg);
        this._auditPush({ action: 'go-nav-lane-invalid' }, 'blocked', msg);
        this._settle(false, msg);
        this._afterSettle(false);
        return;
      }

      await this._confirmOrNavigate(check.url, { modelResolved: true });
    }

    // First-visit-per-origin (or, always, model-resolved) confirmation -
    // design §2's friction tiers. Reuses the SAME approval-card DOM
    // (glossEl/detailEl/approveBtn/rejectBtn) the LLM-action proposal uses,
    // labeled NAVIGATION, gated by the parallel `awaiting-nav-confirm` mode
    // rather than overloading `state.pendingProposal` (which stays an LLM
    // action object shape - see _normalizeAction()/executor.execute()).
    async _confirmOrNavigate(url, opts) {
      // M4b verify fix (MED-1): the program/proposal mutual exclusion must
      // hold in BOTH directions. _enterProgram() already refuses to start
      // while a confirm/approval is pending; this is the reverse arm - a
      // navigation confirm arriving while a game is running (possible via
      // the async nav-lane round trip: `go <words>` was typed, the model
      // answer is still in flight, the human starts a game meanwhile) must
      // force-exit the program FIRST, through the same _exitProgram()
      // choke point every other exit path uses. Without this, the
      // approval-card state below would clobber state.mode while the tick
      // interval kept running, and approveBtn.focus() would yank focus
      // onto Approve mid-keymash - an Enter meant as game input could
      // approve a navigation unread.
      this._maybeExitProgramForProposal();
      const originStr = url.origin;
      this.printInfo(`go → ${url.href}`);
      const visitedResp = await this._tsSend('TS_VISITED_CHECK', { origin: originStr });
      const alreadyVisited = !!(visitedResp.ok && visitedResp.visited);
      const needsConfirm = opts.modelResolved || !alreadyVisited;

      if (!needsConfirm) {
        await this._doNavigate(url.href, originStr);
        return;
      }

      this.state.pendingNav = { url: url.href, origin: originStr, modelResolved: !!opts.modelResolved };
      this.state.mode = 'awaiting-nav-confirm';
      this.glossEl.textContent = `NAVIGATION: go to ${url.href}`;
      this.detailEl.textContent = opts.modelResolved
        ? `origin=${originStr}  (model-resolved destination - read it before approving)`
        : `origin=${originStr}  (first visit to this origin this tab session)`;
      this.proposalEl.hidden = false;
      this.inputEl.readOnly = true;
      this._seq++;
      this._updateTestHook();
      if (this.approveBtn) this.approveBtn.focus();
    }

    async _doNavigate(urlHref, originStr) {
      await this._tsSend('TS_VISITED_ADD', { origin: originStr });
      // If a chain is mid-flight, pin the queue's expected-arrival origin to
      // the REAL destination right before actually navigating - this is
      // what the arrival check (nav.js's checkArrival(), consulted by
      // _advanceQueue() on the next injection) verifies against (design §5).
      const peek = await this._tsSend('TS_QUEUE_PEEK');
      if (peek.ok && Array.isArray(peek.queue) && peek.queue.length > 0) {
        await this._tsSend('TS_QUEUE_SET', { queue: peek.queue, expectedOrigin: originStr });
      }
      location.href = urlHref;
    }

    async _approveNav() {
      const nav = this.state.pendingNav;
      if (!nav || this._approvalBusy) return;
      this._approvalBusy = true;
      try {
        // Same execution-time occlusion re-check as an LLM-action approval
        // (M2.1) - a navigation confirm is approval-gated for exactly the
        // same clickjacking-style reason a click/fill/select/navigate
        // proposal is.
        const occlusion = this._probeApprovalOcclusion();
        if (occlusion.occluded) {
          this.proposalEl.hidden = true;
          this.inputEl.readOnly = false;
          this.inputEl.focus(); // FIX 3: restore typing focus - mirrors _rejectNav()/_rejectProposal()
          this.state.mode = 'idle';
          const msg = `approval UI was covered - navigation cancelled for safety (${occlusion.reason})`;
          this.printError(msg);
          this._auditPush({ action: 'go' }, 'aborted(occluded)', msg);
          this.state.pendingNav = null;
          this._settle(false, msg);
          this._afterSettle(false);
          return;
        }
        this.proposalEl.hidden = true;
        this.inputEl.readOnly = false;
        this.state.mode = 'idle';
        this.state.pendingNav = null;
        this._auditPush({ action: 'go' }, 'approved', `navigating to ${nav.url}`);
        this._settle(true, `navigating to ${nav.url}`);
        await this._doNavigate(nav.url, nav.origin);
      } finally {
        this._approvalBusy = false;
      }
    }

    _rejectNav() {
      const nav = this.state.pendingNav;
      if (!nav) return;
      this.proposalEl.hidden = true;
      this.inputEl.readOnly = false;
      // FIX 3 (battery-found usability bug): restore focus to the terminal
      // input so the human can immediately keep typing instead of having to
      // click back into the field. This method is only ever reached via an
      // isTrusted-gated entry point (_rejectPending(), called from the
      // isTrusted-checked _onGlobalKeydown/_onInputKeydown handlers or the
      // isTrusted-checked reject-button click listener - see H1), so no
      // additional gating is needed here.
      this.inputEl.focus();
      this.state.mode = 'idle';
      this.printInfo('navigation rejected');
      this._auditPush({ action: 'go' }, 'rejected', '(not navigated)');
      this.state.pendingNav = null;
      this._settle(null, 'rejected (not navigated)');
      this._afterSettle(false);
    }

    async _runLlm(command) {
      // M2.3: LLM-call budget gate. Deterministic, never model-controlled -
      // this check runs before the model is even asked anything. Checked
      // against the SW-authoritative limiter (see class header comment) so
      // the budget/pause latch is real even if this Terminal instance was
      // just (re-)constructed by a content-script re-injection.
      const budgetCheck = await this._rlCheck('llm');
      if (!budgetCheck.allowed) {
        this.printError(budgetCheck.reason);
        this._auditPush({ action: 'llm-rate-limited' }, 'blocked', budgetCheck.reason);
        this._settle(false, budgetCheck.reason);
        this._afterSettle(false);
        return;
      }
      await this._rlRecord('llm');

      this.printInfo('… asking the local model');
      const { entries, map, notes } = LFL.axtree.build();
      this.elementMap = map;
      const elementList = LFL.axtree.serialize(entries, 3200, notes);

      const t0 = performance.now();
      let resp;
      try {
        resp = await chrome.runtime.sendMessage({
          type: 'LFL_LLM_REQUEST',
          command,
          elementList,
          origin: location.origin,
          title: document.title,
        });
      } catch (e) {
        resp = { ok: false, error: 'local model offline - deterministic commands still work (' + (e && e.message ? e.message : 'messaging error') + ')' };
      }
      const latencyMs = Math.round(performance.now() - t0);

      if (!resp || !resp.ok) {
        const errMsg = (resp && resp.error) || 'local model offline - deterministic commands still work';
        this.printError(errMsg);
        this._auditPush({ action: 'llm-error' }, 'n/a', errMsg);
        this._settle(false, errMsg);
        this._afterSettle(false);
        return;
      }

      const action = this._normalizeAction(resp.action);
      this._presentProposal(action, latencyMs);
    }

    _normalizeAction(a) {
      a = a || {};
      const validActions = ['click', 'fill', 'select', 'navigate', 'scroll', 'extract', 'answer', 'abort'];
      return {
        action: validActions.includes(a.action) ? a.action : 'abort',
        element: Number.isInteger(a.element) ? a.element : null,
        value: typeof a.value === 'string' ? a.value : '',
        reason: typeof a.reason === 'string' ? a.reason : (validActions.includes(a.action) ? '' : `model returned unrecognized action "${a.action}"`),
      };
    }

    _describeEl(el) {
      if (!el) return '(element not found or no longer visible)';
      const role = LFL.axtree.implicitRole(el);
      const name = LFL.axtree.accessibleName(el);
      return `<${el.tagName.toLowerCase()}> role=${role} name="${name}"`;
    }

    // Deterministic destination line for a click that resolves to a
    // navigation target (<a href>, ancestor <a>, formaction, form action,
    // area, or svg-a) - built from the LIVE element via guards.js, never
    // from the model's own prose. See MUST-FIX #2 in the M1 security review:
    // an approval card that shows role/name but not where a click actually
    // goes lets a human approve blind. M2.4: uses the element's OWN frame
    // context (frameOptsFor), so an in-iframe click's destination is judged
    // against that iframe's own origin, not the top page's.
    _clickDestinationSuffix(el) {
      if (!el || !window.LFL.guards) return '';
      const opts = (window.LFL.axtree && typeof LFL.axtree.frameOptsFor === 'function') ? LFL.axtree.frameOptsFor(el) : undefined;
      const nav = LFL.guards.checkClickTarget(el, opts);
      if (!nav.hasTarget) return '';
      const dest = nav.url ? nav.url.href : nav.rawUrl;
      const rel = nav.blocked ? `${nav.classification} - WILL BE BLOCKED` : 'same-origin';
      return ` -> ${dest} (${rel})`;
    }

    _glossFor(action, el) {
      switch (action.action) {
        case 'click':
          return `click [${action.element}] ${this._describeEl(el)}${this._clickDestinationSuffix(el)}`;
        case 'fill':
          return `fill [${action.element}] ${this._describeEl(el)} with "${action.value}"`;
        case 'select':
          return `select "${action.value}" in [${action.element}] ${this._describeEl(el)}`;
        case 'navigate': {
          let originTxt = '';
          try { originTxt = new URL(action.value, document.baseURI).origin; } catch (_e) { /* leave blank */ }
          return `navigate to ${action.value}${originTxt ? ' (' + originTxt + ')' : ''}`;
        }
        case 'scroll':
          return `scroll ${action.value || 'down'}`;
        case 'extract':
          return `extract: ${action.value || '(page content)'}`;
        case 'answer':
          return `answer: ${action.value || ''}`;
        case 'abort':
          return `abort: ${action.reason || action.value || '(no reason given)'}`;
        default:
          return `unknown action "${action.action}"`;
      }
    }

    _presentProposal(action, latencyMs) {
      // M4b verify fix (MED-1): force-exit any active program BEFORE
      // presenting - see _confirmOrNavigate()'s twin call and
      // _maybeExitProgramForProposal()'s own comment for the full race
      // (an in-flight _runLlm() answer landing while a game runs).
      // Unconditional (before the requiresApproval split below), so an
      // auto-run answer/extract landing mid-game also exits cleanly
      // instead of printing its result under a still-ticking frame.
      this._maybeExitProgramForProposal();
      // funpack v1 stats: one proposed action came back from the model --
      // counted here regardless of whether it turns out to require approval
      // or auto-runs (answer/extract/scroll/abort), same scope as the
      // README's "one proposed action" wording.
      this._bumpStats({ modelProposals: 1 });
      const requiresApproval = APPROVAL_ACTIONS.has(action.action);
      const targetEl = action.element != null ? LFL.axtree.resolve(this.elementMap, action.element) : null;
      const gloss = this._glossFor(action, targetEl);

      if (!requiresApproval) {
        this.printInfo(`proposal (auto-run, ${latencyMs}ms): ${gloss}`);
        const result = LFL.executor.execute(action, this.elementMap);
        if (result.ok) this.printOk(result.message);
        else this.printError(result.message);
        this._auditPush(action, 'auto', result.message);
        this._settle(result.ok, result.message);
        this._afterSettle(!!result.ok);
        return;
      }

      this.state.pendingProposal = action;
      this.state.mode = 'awaiting-approval';
      this._lastLatencyMs = latencyMs;
      this.glossEl.textContent = gloss;
      this.detailEl.textContent =
        `action=${action.action}  element=${action.element == null ? '(none)' : action.element}` +
        (action.value ? `  value="${action.value}"` : '') +
        (action.reason ? `  reason="${action.reason}"` : '') +
        `  latency=${latencyMs}ms`;
      this.proposalEl.hidden = false;
      this.inputEl.readOnly = true;
      this._seq++; // proposal rendered - this is the "submit -> proposal render" settle point
      this._updateTestHook();
      // M2.1: move focus onto our own extension-owned Approve control - out
      // of any page element's reach - and keep it trapped there (see
      // _onGlobalKeydown's Tab handling) until the proposal resolves.
      if (this.approveBtn) this.approveBtn.focus();
    }

    // M2.1: execution-time occlusion re-check. Samples what's actually
    // topmost at the approve control's on-screen center point RIGHT NOW -
    // immediately before executing an approved mutating action - and aborts
    // if it isn't genuinely our own control. See guards.js
    // classifyOcclusionProbe() for the pure decision logic this wraps.
    _probeApprovalOcclusion() {
      if (!this.approveBtn) return { occluded: true, reason: 'no approval control to check' };
      if (typeof document.elementsFromPoint !== 'function') {
        // Given this project's Chrome >=144 floor, elementsFromPoint has
        // been available for years - this is a documented, extremely
        // unlikely residual, not an expected runtime path. Fail CLOSED: an
        // occlusion check that cannot run is not evidence of no occlusion.
        return { occluded: true, reason: 'occlusion-check API (elementsFromPoint) unavailable in this browser - aborting rather than assuming safety' };
      }
      const rect = this.approveBtn.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return { occluded: true, reason: 'approve control has no visible geometry' };
      }
      const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
      const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);

      const outsideTopmost = document.elementsFromPoint(cx, cy)[0] || null;
      const innerTopmost = typeof this.shadow.elementsFromPoint === 'function'
        ? (this.shadow.elementsFromPoint(cx, cy)[0] || null)
        : this.approveBtn;

      const verdict = LFL.guards.classifyOcclusionProbe({
        outsideTopmost, host: this.host, innerTopmost, approveEl: this.approveBtn,
      });
      if (verdict.occluded) return verdict;

      // Pointer-events probe: temporarily exclude our own overlay from hit
      // testing and resample. A genuinely un-occluded reading should change
      // (reveal page content, or a competing overlay, underneath) - proving
      // the first reading reflected real hit-testing rather than a stale or
      // otherwise wrong result.
      let underneathTopmost = null;
      try {
        this.host.style.pointerEvents = 'none';
        underneathTopmost = document.elementsFromPoint(cx, cy)[0] || null;
      } finally {
        this.host.style.pointerEvents = '';
      }
      if (underneathTopmost === this.host) {
        return { occluded: true, reason: 'pointer-events probe was inconclusive - excluding the overlay from hit-testing did not change the topmost result' };
      }

      return { occluded: false, reason: null };
    }

    // Async now (M2.3 rate-limit check is a message round trip to the
    // service worker - see class header comment). This introduces a real
    // await window between "user clicked Approve" and "action actually
    // executes", during which the user could hit Reject/Esc or close the
    // overlay (both still fully synchronous). `_approvalBusy` blocks a
    // double-Approve (Enter mashed, or Enter+click) from racing two
    // in-flight budget checks against each other; the `pendingProposal !==
    // action` re-checks after every await are what make an interleaved
    // Reject/close during the await window win cleanly instead of this
    // method executing an action the user already rejected.
    async _approveProposal() {
      const action = this.state.pendingProposal;
      if (!action || this._approvalBusy) return;
      this._approvalBusy = true;
      try {
        // M2.1: execution-time occlusion re-check FIRST, still fully
        // synchronous, run at the exact instant Approve was pressed - same
        // zero-added-latency timing this check has always had. Ordered
        // ahead of the (now-async) M2.3 rate-limit check deliberately: the
        // occlusion probe's adversarial fixture
        // (tests/fixtures/occlusion-attack.html) races a page-owned overlay
        // against the moment a human approves, on a real wall-clock timer -
        // inserting an awaited SW round trip BEFORE this probe would push
        // that moment later by a variable amount for no security benefit
        // (both checks must pass before execution either way; which one is
        // evaluated first doesn't change what gets blocked). Not a warning -
        // a detected occlusion cancels the action outright.
        const occlusion = this._probeApprovalOcclusion();
        if (occlusion.occluded) {
          this.proposalEl.hidden = true;
          this.inputEl.readOnly = false;
          this.inputEl.focus(); // FIX 3: restore typing focus - mirrors _rejectProposal()
          this.state.mode = 'idle';
          const msg = `approval UI was covered - action cancelled for safety (${occlusion.reason})`;
          this.printError(msg);
          this._auditPush(action, 'aborted(occluded)', msg);
          this.state.pendingProposal = null;
          this._settle(false, msg);
          this._afterSettle(false);
          return;
        }

        // M2.3: rate-limit gate on EXECUTED mutating actions, checked
        // against the SW-authoritative limiter - still runs before
        // execution, as required; just after the occlusion probe rather
        // than before it (see above).
        const budgetCheck = await this._rlCheck('action');
        if (this.state.pendingProposal !== action) return; // resolved by Reject/close while awaiting
        if (!budgetCheck.allowed) {
          this.proposalEl.hidden = true;
          this.inputEl.readOnly = false;
          this.inputEl.focus(); // FIX 3: restore typing focus - mirrors _rejectProposal()
          this.state.mode = 'idle';
          this.printError(budgetCheck.reason);
          this._auditPush(action, 'blocked(rate-limit)', budgetCheck.reason);
          this.state.pendingProposal = null;
          this._settle(false, budgetCheck.reason);
          this._afterSettle(false);
          return;
        }

        // Only actually-executed mutations count against the action budget
        // (unchanged posture from the pre-M2.3-SW-move design) - record
        // AFTER both the occlusion check and the budget check pass.
        await this._rlRecord('action');
        if (this.state.pendingProposal !== action) return; // resolved by Reject/close while awaiting

        // funpack v1 stats: the human's approval decision is confirmed at
        // exactly this point (both hard blocks above have already passed) --
        // counted here regardless of whether the execution itself then
        // succeeds or fails, since "approvals" measures the human's decision,
        // not the executor's outcome.
        this._bumpStats({ approvals: 1 });

        this.proposalEl.hidden = true;
        this.inputEl.readOnly = false;
        this.state.mode = 'idle';
        const result = LFL.executor.execute(action, this.elementMap);
        if (result.ok) this.printOk(result.message);
        else this.printError(result.message);
        this._auditPush(action, 'approved', result.message);
        this.state.pendingProposal = null;
        this._settle(result.ok, result.message);
        this._afterSettle(!!result.ok);
      } finally {
        this._approvalBusy = false;
      }
    }

    _rejectProposal() {
      const action = this.state.pendingProposal;
      if (!action) return;
      this.proposalEl.hidden = true;
      this.inputEl.readOnly = false;
      // FIX 3 (battery-found usability bug): restore focus to the terminal
      // input - without this the human has to click back into the field to
      // keep typing after a reject. Only ever reached via an isTrusted-gated
      // entry point (_rejectPending(), see H1's guard chain), so no extra
      // gating is needed here.
      this.inputEl.focus();
      this.state.mode = 'idle';
      this.printInfo('rejected');
      this._auditPush(action, 'rejected', '(not executed)');
      this.state.pendingProposal = null;
      this._settle(null, 'rejected (not executed)');
      this._afterSettle(false);
    }

    _auditPush(action, verdict, result) {
      LFL.auditLog.push({
        command: this._lastCommand,
        summary: action && action.action ? this._safeSummary(action) : (action && action.summary) || '',
        verdict,
        result,
      });
    }

    _safeSummary(action) {
      try {
        const el = action.element != null ? LFL.axtree.resolve(this.elementMap, action.element) : null;
        return this._glossFor(action, el);
      } catch (_e) {
        return action.action;
      }
    }

    _updateTestHook() {
      // Test hook per spec: a data-attribute on the overlay root (the host
      // element, NOT inside the closed shadow root) that tests/run_battery.py
      // reads directly without needing to pierce shadow DOM.
      // M2.3: `budget` is the cached last-known SW-authoritative snapshot
      // (_rlBudgetCache), never locally computed - see class header comment.
      // It is refreshed opportunistically (construction, open(), and every
      // RL_* response) rather than on every call to this method, since this
      // method itself must stay synchronous (called from many sync code
      // paths) and a real fetch is async.
      const budget = this._rlBudgetCache;
      this.budgetEl.textContent = `llm ${budget.llmRemaining}/${budget.llmMax} · actions ${budget.actionRemaining}/${budget.actionMax}${budget.paused ? ' · PAUSED' : ''}`;

      // M3 H2 (design doc §8): this attribute exposes pending-proposal
      // contents, budgets, and mode to PAGE JAVASCRIPT on every page (it's a
      // plain DOM attribute on an element that lives in the light DOM - a
      // page's own `MutationObserver`/`getAttribute` can read it same as
      // any other attribute; the closed shadow root only hides the OVERLAY
      // CONTENTS, not this host-level attribute). Fine for a private spike;
      // wrong default for a public product (a page could observe/time the
      // approval flow, or read what command the human just typed). Emitted
      // ONLY when the `dev` command has turned it on this session
      // (storage.local `lflDevHooks`, off by default - see
      // _handleDevCommand()/_loadDevHooksFlag()); the Playwright battery
      // must type `dev on` (or pre-seed `lflDevHooks:true` in
      // storage.local before injection) to read this attribute at all.
      if (!this._devHooksEnabled) {
        if (this.host.hasAttribute('data-lfl-state')) this.host.removeAttribute('data-lfl-state');
        return;
      }

      const payload = {
        open: this.isOpen(),
        mode: this.state.mode,
        seq: this._seq,
        lastResult: this._lastResult,
        rateLimit: budget,
        pendingProposal: this.state.pendingProposal
          ? {
              action: this.state.pendingProposal.action,
              element: this.state.pendingProposal.element,
              value: this.state.pendingProposal.value,
              reason: this.state.pendingProposal.reason,
              gloss: this._glossFor(
                this.state.pendingProposal,
                this.state.pendingProposal.element != null ? LFL.axtree.resolve(this.elementMap, this.state.pendingProposal.element) : null,
              ),
              latencyMs: this._lastLatencyMs || null,
            }
          : null,
        pendingNav: this.state.pendingNav ? Object.assign({}, this.state.pendingNav) : null,
      };
      this.host.setAttribute('data-lfl-state', JSON.stringify(payload));
    }
  }

  window.LFL.terminal = new Terminal();
})();
