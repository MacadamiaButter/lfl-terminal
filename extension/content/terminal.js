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
:host{all:initial;position:fixed;inset:auto;margin:0;padding:0;border:none;width:auto;height:auto;background:transparent;color:inherit;overflow:visible;z-index:2147483647;display:block;}
:host(.lfl-dock){inset:auto 0 0 0;}
.lfl-panel{display:none;flex-direction:column;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.45;color:var(--lfl-fg,#dbe4f0);background:var(--lfl-bg,#0b0e14);width:min(520px,92vw);min-width:32ch;border:1px solid var(--lfl-accent,#e0a339);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.6);max-height:34vh;}
.lfl-panel.lfl-dock{width:auto;min-width:0;border:none;border-top:2px solid var(--lfl-accent,#e0a339);border-radius:0;box-shadow:0 -8px 24px rgba(0,0,0,.55);}
.lfl-panel.lfl-open{display:flex;}
.lfl-panel.lfl-collapsed .lfl-output{display:none;}
.lfl-resizer{flex:0 0 auto;height:7px;cursor:ns-resize;background:var(--lfl-titlebar-bg,#151a24);}
.lfl-resizer:hover{background:var(--lfl-accent,#e0a339);}
.lfl-panel.lfl-theme-default{--lfl-bg:#0b0e14;--lfl-fg:#dbe4f0;--lfl-accent:#e0a339;--lfl-accent-bright:#f5a623;--lfl-titlebar-bg:#151a24;--lfl-titlebar-fg:#8fa3c0;--lfl-dim:#5d7290;--lfl-dim-input:#4b5768;--lfl-cmd:#8fd0ff;--lfl-info:#9fb0c3;--lfl-error:#ff6b6b;--lfl-ok:#7ee787;--lfl-border:#2a3140;--lfl-proposal-bg:#1a1408;--lfl-proposal-fg:#f2d9a8;--lfl-proposal-detail:#c9b28a;--lfl-approve-bg:#1c3a1c;--lfl-reject-bg:#3a1c1c;--lfl-input-bg:#0e131c;}
.lfl-panel.lfl-theme-phosphor{--lfl-bg:#000000;--lfl-fg:#33ff33;--lfl-accent:#33ff33;--lfl-accent-bright:#66ff66;--lfl-titlebar-bg:#001a00;--lfl-titlebar-fg:#22cc22;--lfl-dim:#177217;--lfl-dim-input:#177217;--lfl-cmd:#33ff33;--lfl-info:#2ecc2e;--lfl-error:#ff5555;--lfl-ok:#33ff33;--lfl-border:#0a3d0a;--lfl-proposal-bg:#001a00;--lfl-proposal-fg:#33ff33;--lfl-proposal-detail:#22aa22;--lfl-approve-bg:#003300;--lfl-reject-bg:#330000;--lfl-input-bg:#000000;}
.lfl-panel.lfl-theme-amber{--lfl-bg:#1a0f00;--lfl-fg:#ffb000;--lfl-accent:#ffb000;--lfl-accent-bright:#ffd166;--lfl-titlebar-bg:#241500;--lfl-titlebar-fg:#cc8b00;--lfl-dim:#805800;--lfl-dim-input:#805800;--lfl-cmd:#ffcc66;--lfl-info:#e0a339;--lfl-error:#ff6b4a;--lfl-ok:#ffb000;--lfl-border:#3a2200;--lfl-proposal-bg:#241500;--lfl-proposal-fg:#ffd166;--lfl-proposal-detail:#cc8b00;--lfl-approve-bg:#332200;--lfl-reject-bg:#3a1400;--lfl-input-bg:#1a0f00;}
.lfl-panel.lfl-theme-paper{--lfl-bg:#f7f5f0;--lfl-fg:#1c1c1c;--lfl-accent:#a15c00;--lfl-accent-bright:#c97a00;--lfl-titlebar-bg:#ece7dc;--lfl-titlebar-fg:#4a4a4a;--lfl-dim:#8a8a8a;--lfl-dim-input:#8a8a8a;--lfl-cmd:#0b5fa5;--lfl-info:#4a4a4a;--lfl-error:#b3261e;--lfl-ok:#1e7b34;--lfl-border:#d8d2c4;--lfl-proposal-bg:#fff8e6;--lfl-proposal-fg:#3a3a3a;--lfl-proposal-detail:#6b5c3f;--lfl-approve-bg:#e3f3e6;--lfl-reject-bg:#f8e4e2;--lfl-input-bg:#ffffff;}
.lfl-titlebar{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:4px 10px;background:var(--lfl-titlebar-bg,#151a24);border-bottom:1px solid var(--lfl-border,#2a3140);color:var(--lfl-titlebar-fg,#8fa3c0);font-size:11px;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;user-select:none;}
.lfl-titlebar .lfl-caret{color:var(--lfl-dim,#5d7290);margin-right:2px;font-size:10px;}
.lfl-titlebar .lfl-badge{color:var(--lfl-accent,#e0a339);}
.lfl-titlebar .lfl-budget{margin-left:auto;color:var(--lfl-dim,#5d7290);letter-spacing:normal;text-transform:none;font-size:10px;}
.lfl-pin-btn{margin-left:8px;padding:1px 6px;border:1px solid var(--lfl-border,#2a3140);border-radius:3px;color:var(--lfl-dim,#5d7290);letter-spacing:normal;text-transform:none;font-size:10px;cursor:pointer;}
.lfl-pin-btn.active{border-color:var(--lfl-accent,#e0a339);color:var(--lfl-accent-bright,#f5a623);}
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
.lfl-inputrow{display:flex;align-items:center;padding:6px 10px 8px 10px;border-top:1px solid var(--lfl-border,#2a3140);background:var(--lfl-input-bg,#0e131c);}
.lfl-panel.lfl-dock .lfl-inputrow{padding-bottom:26px;}
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
                       // | 'awaiting-script-run' | 'editing-script' (scripts v1)
                       // | 'awaiting-teach-save' | 'awaiting-teach-name' (brainstorm lane)
        pendingCrossOriginUrl: null,
        pendingProposal: null,
        pendingNav: null, // M3: {url, origin, modelResolved} - see _handleGo/_confirmOrNavigate
        // scripts v1 (LFL-TERMINAL-SCRIPTS-DESIGN.md §9 sign-off #5): the
        // fully parameter-substituted step list awaiting the single plan-
        // preview approval - {name, steps} - see _handleRunCommand()/
        // _approveScriptRun()/_rejectScriptRun().
        pendingScriptRun: null,
        // scripts v1: the in-progress multi-line capture buffer for
        // `script new <name>` - see _appendScriptEditLine()/
        // _finishScriptEdit()/_cancelScriptEdit(). Reuses the ordinary
        // single-line input row (one line captured per Enter) rather than a
        // separate textarea element - see those methods' own comments.
        scriptEditName: null,
        scriptEditBuffer: null,
        // brainstorm lane (LFL-TERMINAL-BRAINSTORM-LANE-DESIGN.md §4): the
        // in-progress draft awaiting approval (and, if no `as <name>` was
        // typed, awaiting a name too) - { goal, name, body, steps }. `name`
        // is null until either typed with `teach ... as <name>` or captured
        // on the input line after approval - see _approveTeachSave()/
        // _captureTeachName()/_rejectTeachSave()/_cancelTeachName() below.
        pendingTeach: null,
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
        // M4c: the active persistent highlight - { query, count, capped } or
        // null. The Range objects themselves live inside CSS.highlights'
        // registry entry, not here; this field only exists so bare
        // `highlight` can report status and so clear paths know there is
        // something to tear down. Page-scoped, human-visible-only memory:
        // never persisted, never in any LLM payload, dies with `state` on
        // the next injection - same posture as findContext.
        highlightContext: null,
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
      // scripts P2 hardening (2026-07-14): pass the full built-in command
      // surface so setScript() can whitelist script steps to known verbs /
      // defined aliases / `ask` (engine.js has already registered every verb
      // into LFL.commandRegistry by the time this content script runs - see
      // the manifest content_scripts order: engine.js precedes terminal.js).
      this._aliasStore = LFL.registry.createAliasStore(
        (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null,
        (LFL.commandRegistry && typeof LFL.commandRegistry.names === 'function') ? LFL.commandRegistry.names() : [],
      );
      this._aliasStore.load();
      // M3 H2 (design doc §8): the data-lfl-state test hook is OFF by
      // default - see _updateTestHook()'s own comment. Loaded async from
      // storage.local `lflDevHooks`; stays false (hidden) until that
      // resolves, which is the safe default direction to fail in.
      this._devHooksEnabled = false;
      this._loadDevHooksFlag();
      // brainstorm lane (design doc §2 invariant 6, §9 sign-off): opt-in,
      // OFF by default. Loaded async from storage.local `lflBrainstormEnabled`
      // - stays false (the safe/no-op default) until that resolves, same
      // fail-safe-default posture as _devHooksEnabled above. `teach on`/
      // `teach off` (see _setTeachEnabled()) both write storage AND update
      // this cached flag synchronously, so a toggle takes effect immediately
      // within the same session without waiting on another async read.
      this._brainstormEnabled = false;
      this._loadBrainstormFlag();
      // funpack v1: persisted theme choice (storage.local `lflTheme`) --
      // loaded async, applied via _applyTheme() as soon as it resolves;
      // stays on the 'default' theme's fallback CSS values until then, the
      // safe default direction. See _loadTheme()/_applyTheme() below.
      this._loadTheme();
      // Popover redesign (2026-07-15, LFL-TERMINAL-POPOVER-REDESIGN.md): the
      // floating-panel placement prefs. Fail-closed to the safe/default
      // direction (cursor mode, unpinned, middle-click OFF) until storage
      // resolves - same posture as _devHooksEnabled/_brainstormEnabled above.
      // `_lastPointer` is the last TRUSTED pointer position seen anywhere on
      // the page (see _onPointerMove()) - null until one arrives, which is
      // exactly what makes a keyboard-triggered open fall back to
      // _keyboardAnchor() instead of an unrelated stale position (design §5).
      this._anchorMode = 'cursor';
      this._pinned = false;
      this._panelPos = null;
      this._middleClickOpen = false;
      this._middleClickModifier = 'none';
      this._lastPointer = null;
      this._titlebarDragged = false;
      this._loadPlacementPrefs();
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
      // collapse+resize (2026-07-14): default height + expanded state, set
      // BEFORE _buildDom (which calls _applyPanelHeight/_applyCollapsed).
      // _loadPanelHeight() below is async and re-applies any persisted height
      // once storage resolves; collapse is a live toggle, not persisted.
      this._panelHeightVh = LFL.registry.PANEL_DEFAULT_VH;
      this._collapsed = false;
      this._buildDom();
      this._loadPanelHeight();
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

    // brainstorm lane (design doc §2 invariant 6): mirrors _loadDevHooksFlag()
    // exactly - see this._brainstormEnabled's own comment in the constructor.
    _loadBrainstormFlag() {
      try {
        chrome.storage.local.get(['lflBrainstormEnabled'], (res) => {
          if (chrome.runtime.lastError) return;
          this._brainstormEnabled = !!(res && res.lflBrainstormEnabled);
        });
      } catch (_e) { /* storage unavailable - stays off, the safe default */ }
    }

    // Popover redesign (2026-07-15): loads the five placement/trigger prefs
    // in one round trip. Any missing/malformed stored value falls back to
    // the safe default already set in the constructor rather than throwing
    // or applying garbage - same fail-closed-to-default posture as every
    // other _load*Flag() method in this class.
    _loadPlacementPrefs() {
      try {
        chrome.storage.local.get(
          ['lflAnchorMode', 'lflPanelPinned', 'lflPanelPos', 'lflMiddleClickOpen', 'lflMiddleClickModifier'],
          (res) => {
            if (chrome.runtime.lastError || !res) return;
            if (res.lflAnchorMode === 'dock' || res.lflAnchorMode === 'cursor') this._anchorMode = res.lflAnchorMode;
            this._pinned = !!res.lflPanelPinned;
            if (res.lflPanelPos && typeof res.lflPanelPos.left === 'number' && typeof res.lflPanelPos.top === 'number') {
              this._panelPos = res.lflPanelPos;
            }
            this._middleClickOpen = !!res.lflMiddleClickOpen;
            this._middleClickModifier = res.lflMiddleClickModifier === 'alt' ? 'alt' : 'none';
            this._applyPinButtonState();
          },
        );
      } catch (_e) { /* storage unavailable - stays cursor/unpinned/middle-click-off */ }
    }

    // Single best-effort write path for every placement/trigger pref -
    // callers pass only the keys they're changing (chrome.storage.local.set
    // merges, it does not replace the whole bag).
    _persistPlacementPrefs(patch) {
      try { chrome.storage.local.set(patch); } catch (_e) { /* best-effort */ }
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
      // auto-open-on-home (2026-07-14): last, so it defers to a restored open
      // state and to any in-flight chain arrival above - see the method's own
      // comment for the once-per-tab-session latch that respects a manual close.
      await this._maybeAutoOpenHome();
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

      // collapse+resize (2026-07-14): a thin top grip to drag the panel taller
      // or shorter (Ctrl+Up/Down also step presets); the titlebar toggles
      // collapse (fold to just the input strip, hiding the scrollback - never
      // the approval card, which is a sibling of the output pane).
      this.resizerEl = document.createElement('div');
      this.resizerEl.className = 'lfl-resizer';
      this.resizerEl.title = 'drag to resize (or Ctrl+Up / Ctrl+Down)';
      this.resizerEl.addEventListener('mousedown', (e) => this._startResize(e));

      const titlebar = document.createElement('div');
      titlebar.className = 'lfl-titlebar';
      titlebar.title = 'click to fold / unfold (or Ctrl+`)';
      // Popover redesign (2026-07-15): dragging the titlebar (while pinned)
      // moves the floating panel - see _startTitlebarDrag(). That has to be
      // disambiguated from the pre-existing click-to-collapse toggle below:
      // mousedown starts a potential drag, and the 'click' handler skips the
      // collapse toggle if that gesture actually moved the panel past the
      // threshold (_titlebarDragged), so a real drag never ALSO folds the
      // panel on release.
      titlebar.addEventListener('mousedown', (e) => this._startTitlebarDrag(e));
      titlebar.addEventListener('click', (e) => {
        if (!LFL.guards.isTrustedInputEvent(e)) return; // M3 H1 - see guards.js
        if (this._titlebarDragged) { this._titlebarDragged = false; return; }
        if (e.target === this.pinBtn) return; // the pin button handles its own click below
        this._toggleCollapse();
      });
      this.caretEl = document.createElement('span');
      this.caretEl.className = 'lfl-caret';
      this.caretEl.textContent = '▾'; // small down triangle = expanded
      const badge = document.createElement('span');
      badge.className = 'lfl-badge';
      badge.textContent = 'lfl-terminal';
      const hint = document.createElement('span');
      hint.textContent = '` toggle · Esc close · Ctrl+` fold · Ctrl+Up/Down size';
      this.budgetEl = document.createElement('span');
      this.budgetEl.className = 'lfl-budget';
      // Popover redesign: pin toggle - freezes the floating panel at its
      // current spot (draggable via the titlebar) instead of re-anchoring to
      // the cursor on every open. No-op-looking in dock mode (nothing to pin
      // a full-width bar to) but left visible there too, same as every other
      // titlebar control.
      this.pinBtn = document.createElement('span');
      this.pinBtn.className = 'lfl-pin-btn';
      this.pinBtn.title = 'pin panel in place (drag titlebar to move) - or type "pin"/"unpin"';
      this.pinBtn.textContent = 'pin';
      this.pinBtn.addEventListener('click', (e) => {
        if (!LFL.guards.isTrustedInputEvent(e)) return; // M3 H1 - see guards.js
        e.stopPropagation(); // don't also fire the titlebar's own collapse toggle
        this._togglePinned();
      });
      titlebar.appendChild(this.caretEl);
      titlebar.appendChild(badge);
      titlebar.appendChild(hint);
      titlebar.appendChild(this.budgetEl);
      titlebar.appendChild(this.pinBtn);

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

      this.panel.appendChild(this.resizerEl);
      this.panel.appendChild(titlebar);
      this.panel.appendChild(this.outputEl);
      this.panel.appendChild(this.proposalEl);
      this.panel.appendChild(inputrow);
      this.shadow.appendChild(this.panel);

      this._applyPanelHeight();
      this._applyCollapsed();
      this._popoverSupported = typeof this.host.showPopover === 'function';
    }

    _wireEvents() {
      document.addEventListener('keydown', this._onGlobalKeydown.bind(this), true);
      this.inputEl.addEventListener('keydown', this._onInputKeydown.bind(this));
      // Popover redesign (2026-07-15): tracks the last TRUSTED pointer
      // position anywhere on the page, so a mouse-triggered open can anchor
      // the panel there (see open()/_placeAt()). isTrusted-gated (design §5/
      // §7) so a page cannot dispatch a synthetic pointermove to pre-seed
      // where our panel will draw - see guards.js's isTrustedInputEvent.
      // passive+capture: cheap (never calls preventDefault) and sees the
      // event regardless of whether page script stops propagation on it.
      document.addEventListener('pointermove', this._onPointerMove.bind(this), { passive: true, capture: true });
      // Popover redesign: opt-in middle-click trigger (default OFF - see
      // _handleConfigCommand()/config middleclick). auxclick is the correct
      // event for acting on a completed non-primary-button click per spec.
      // Verify fix (2026-07-15 Fable pass): Chrome engages middle-click
      // autoscroll at MOUSEDOWN time (the scroll-origin marker appears
      // before the button is even released, on platforms that have
      // autoscroll at all - Windows; Linux Chrome has none), so a
      // preventDefault() in the auxclick handler fires too late to suppress
      // it. The mousedown listener below cancels the default under EXACTLY
      // the same conditions _onAuxClick() acts on (same trust gate, same
      // enable/modifier flags, same inert-background test), so autoscroll
      // never starts for a click this feature is about to consume - and is
      // left completely untouched for every click it isn't.
      document.addEventListener('auxclick', this._onAuxClick.bind(this), true);
      document.addEventListener('mousedown', (e) => {
        if (!LFL.guards.isTrustedInputEvent(e)) return; // M3 H1 - see guards.js
        if (e.button !== 1 || !this._middleClickOpen) return;
        if (this._middleClickModifier === 'alt' && !e.altKey) return;
        if (!this._isInertBackgroundTarget(e.target)) return;
        e.preventDefault();
      }, true);
      // Toolbar button (SW -> content, 2026-07-14): the browser-action click
      // handler in the service worker sends TOGGLE_TERMINAL to this tab. This is
      // an extension-internal message (a web page cannot reach a content
      // script's chrome.runtime.onMessage), so no isTrusted gate is needed, and
      // toggling the overlay open mutates nothing - every page action still runs
      // through its own approval gate. Gives new users an obvious entry point
      // besides the backtick key.
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage
          && typeof chrome.runtime.onMessage.addListener === 'function') {
        chrome.runtime.onMessage.addListener((msg) => {
          if (msg && msg.type === 'TOGGLE_TERMINAL') this.toggle();
        });
      }
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
      return this.state.mode === 'awaiting-approval' || this.state.mode === 'awaiting-nav-confirm'
        // scripts v1: the plan-preview gate (§9 sign-off #5) reuses the same
        // approval-card Enter/Esc/Tab-trap machinery as approval/nav-confirm.
        || this.state.mode === 'awaiting-script-run'
        // brainstorm lane: the "save this draft?" card reuses the SAME
        // machinery too (design doc §3/§4). 'awaiting-teach-name' is
        // deliberately NOT included here - it is an ordinary typing mode
        // (capturing a name on the input line), same posture as
        // 'editing-script', not an approval card.
        || this.state.mode === 'awaiting-teach-save';
    }

    _approvePending() {
      if (this.state.mode === 'awaiting-approval') return this._approveProposal();
      if (this.state.mode === 'awaiting-nav-confirm') return this._approveNav();
      if (this.state.mode === 'awaiting-script-run') return this._approveScriptRun();
      if (this.state.mode === 'awaiting-teach-save') return this._approveTeachSave();
      return undefined;
    }

    _rejectPending() {
      if (this.state.mode === 'awaiting-approval') return this._rejectProposal();
      if (this.state.mode === 'awaiting-nav-confirm') return this._rejectNav();
      if (this.state.mode === 'awaiting-script-run') return this._rejectScriptRun();
      if (this.state.mode === 'awaiting-teach-save') return this._rejectTeachSave();
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
      // scripts v1 (LFL-TERMINAL-SCRIPTS-DESIGN.md §9 sign-off #3/#7): the
      // `script new <name>` multi-line capture mode. Reuses this SAME
      // single-line input (native <input> elements cannot literally contain
      // a newline) - each Enter appends the current line to an in-memory
      // buffer and clears the field for the next line, instead of the
      // ordinary "Enter submits a command" behavior. Checked before the
      // resize/history branches below so none of those shortcuts leak into
      // an in-progress script body.
      if (this.state.mode === 'editing-script') {
        if (e.key === 'Enter') {
          e.preventDefault();
          const line = this.inputEl.value;
          this.inputEl.value = '';
          // Ctrl+Enter or a blank line both finalize (sign-off #7) - a blank
          // line is the more discoverable gesture, Ctrl+Enter the faster one
          // for someone who never wants to type an empty line by accident.
          const finalize = (e.ctrlKey && !e.altKey && !e.metaKey) || line.trim() === '';
          if (finalize) this._finishScriptEdit();
          else this._appendScriptEditLine(line);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this._cancelScriptEdit();
          return;
        }
        return; // swallow history/resize/etc. shortcuts while capturing a script body
      }
      // brainstorm lane (design doc §3): the "no `as <name>` was given"
      // follow-up - a single line capturing the name to save the already-
      // approved draft under. Same single-line-capture pattern as
      // 'editing-script' just above (native <input> can't hold a name AND a
      // multi-line body at once, but a name is only ever one line anyway).
      // Checked before the resize/history branches for the same reason.
      if (this.state.mode === 'awaiting-teach-name') {
        if (e.key === 'Enter') {
          e.preventDefault();
          const line = this.inputEl.value.trim();
          this.inputEl.value = '';
          this._captureTeachName(line);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this._cancelTeachName();
          return;
        }
        return; // swallow history/resize/etc. shortcuts while capturing a name
      }
      // collapse+resize (2026-07-14): Ctrl+backtick folds/unfolds; Ctrl+Up/Down
      // step the height presets. Handled before the plain Arrow history branches
      // below so a modified arrow never also walks command history. Backtick
      // (not Ctrl+J) is the fold key deliberately: it mirrors the bare-backtick
      // open toggle and, unlike Ctrl+J (Chrome's Downloads shortcut, which a
      // content script cannot reliably suppress), has no browser-level action.
      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.key === '`') { e.preventDefault(); this._toggleCollapse(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); this._stepPanelPreset(1); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); this._stepPanelPreset(-1); return; }
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

    // Popover redesign (2026-07-15): `opts.anchor` ({x, y}, viewport-relative)
    // is where a mouse-triggered open (currently only the opt-in middle-click
    // handler) wants the panel to spawn. Every other trigger (backtick,
    // Ctrl+K, the toolbar button, a restored open-state after navigation)
    // omits it, which falls back to _keyboardAnchor() - see design §5/§6 for
    // why a keyboard-triggered open must never use a possibly-stale/unrelated
    // pointer position instead.
    open(opts) {
      opts = opts || {};
      if (this._anchorMode === 'dock') {
        // Legacy bottom-docked bar (`config anchor dock`) - clear any
        // leftover inline left/top from a previous cursor-mode placement
        // FIRST: inline styles win over the `:host(.lfl-dock)` rule's inset
        // shorthand for those same two longhands, so a stale inline position
        // would otherwise fight the dock geometry (see terminal.css's own
        // comment on this).
        this.host.style.left = '';
        this.host.style.top = '';
        this.host.classList.add('lfl-dock');
        this.panel.classList.add('lfl-dock');
      } else {
        this.host.classList.remove('lfl-dock');
        this.panel.classList.remove('lfl-dock');
        if (this._pinned && this._panelPos) {
          this.host.style.left = `${this._panelPos.left}px`;
          this.host.style.top = `${this._panelPos.top}px`;
        } else {
          const anchor = opts.anchor || this._keyboardAnchor();
          this._placeAt(anchor.x, anchor.y);
        }
      }
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
      } else if (this.state.mode === 'awaiting-script-run') {
        // scripts v1: closing mid-preview discards the preview - nothing was
        // queued yet (TS_QUEUE_SET only happens on approve), so no
        // _afterSettle()/queue-clear is needed, unlike the two branches above.
        const name = this.state.pendingScriptRun && this.state.pendingScriptRun.name;
        this._auditPush({ action: 'run', reason: name }, 'rejected(closed)', '(overlay closed while a script preview was pending)');
        this.state.pendingScriptRun = null;
        this.state.mode = 'idle';
        this.proposalEl.hidden = true;
        this.inputEl.readOnly = false;
        this._seq++;
      } else if (this.state.mode === 'awaiting-teach-save') {
        // brainstorm lane: same posture as awaiting-script-run above -
        // nothing was ever persisted while a draft was only pending approval
        // (setScript() only runs on approve), so closing just discards it.
        const label = (this.state.pendingTeach && this.state.pendingTeach.name) || '(unnamed)';
        this._auditPush({ action: 'teach', reason: label }, 'rejected(closed)', '(overlay closed while a teach draft was pending)');
        this.state.pendingTeach = null;
        this.state.mode = 'idle';
        this.proposalEl.hidden = true;
        this.inputEl.readOnly = false;
        this._seq++;
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

    // ---- popover redesign (2026-07-15, LFL-TERMINAL-POPOVER-REDESIGN.md) ----
    //
    // Cursor-anchored floating panel: placement math is pure (registry.js's
    // placePanel/defaultAnchor, unit-tested in tests/panel_placement.test.js)
    // - everything here is the DOM/storage glue around it, mirroring the
    // collapse+resize section's own split below.

    // isTrusted-gated (design §5/§7): a page must not be able to pre-seed
    // where our panel will spawn by dispatching a synthetic pointermove.
    _onPointerMove(e) {
      if (!LFL.guards.isTrustedInputEvent(e)) return;
      this._lastPointer = { x: e.clientX, y: e.clientY };
    }

    // Deterministic fallback anchor for keyboard/toolbar-triggered opens (no
    // real pointer position to use - see design §5). Estimates the panel's
    // width from the same CSS formula as the stylesheet (`min(520px, 92vw)`)
    // since the panel has no laid-out box to measure while `display:none`.
    _keyboardAnchor() {
      const vpW = window.innerWidth || document.documentElement.clientWidth || 800;
      const vpH = window.innerHeight || document.documentElement.clientHeight || 600;
      const width = Math.min(520, vpW * 0.92);
      return LFL.registry.defaultAnchor(vpW, vpH, width);
    }

    // Computes and applies the panel's on-screen position for the given
    // anchor point (viewport-relative px). Panel width/height are ESTIMATED
    // from the same CSS the stylesheet uses (the real box can't be measured
    // while `display:none`) - close enough for placement purposes; the panel
    // is a fixed-position overlay, not laid-out content, so an estimate that
    // is off by a few px never causes reflow or clipping, only a placement
    // that is a little less than pixel-perfect.
    _placeAt(anchorX, anchorY) {
      const vpW = window.innerWidth || document.documentElement.clientWidth || 800;
      const vpH = window.innerHeight || document.documentElement.clientHeight || 600;
      const width = Math.min(520, vpW * 0.92);
      const heightVh = this._panelHeightVh || LFL.registry.PANEL_DEFAULT_VH;
      const height = Math.min((heightVh / 100) * vpH, vpH - 2 * LFL.registry.PANEL_PLACEMENT_MARGIN);
      const { left, top } = LFL.registry.placePanel({
        anchorX, anchorY, panelW: width, panelH: height, vpW, vpH,
      });
      this.host.style.left = `${left}px`;
      this.host.style.top = `${top}px`;
    }

    // Pin toggle (titlebar button + `pin`/`unpin` commands - see
    // _handlePinCommand()). Pinning captures the panel's CURRENT on-screen
    // spot as the persisted anchor for future opens; unpinning drops it, so
    // the next open re-anchors to the cursor (or the keyboard fallback)
    // again. Only meaningful in cursor mode - has no effect on a docked bar,
    // but toggling it is harmless there too (the position is simply unused
    // until the user switches back to cursor mode).
    _togglePinned() {
      this._pinned = !this._pinned;
      if (this._pinned) {
        const rect = this.host.getBoundingClientRect();
        this._panelPos = { left: rect.left, top: rect.top };
      } else {
        this._panelPos = null;
      }
      this._persistPlacementPrefs({ lflPanelPinned: this._pinned, lflPanelPos: this._panelPos });
      this._applyPinButtonState();
    }

    _applyPinButtonState() {
      if (this.pinBtn) this.pinBtn.classList.toggle('active', this._pinned);
    }

    // Drag-to-move (only meaningful once pinned - see _togglePinned()).
    // Mirrors _startResize()'s isTrusted-gated mousemove/mouseup pattern.
    // Disambiguated from the titlebar's ordinary click-to-collapse toggle by
    // a 4px movement threshold (`_titlebarDragged`) - the 'click' handler
    // (see _buildDom()) checks that flag and skips the collapse toggle if
    // this gesture actually moved the panel.
    _startTitlebarDrag(e) {
      if (!LFL.guards.isTrustedInputEvent(e)) return; // M3 H1 - see guards.js
      if (!this._pinned) return;
      if (e.target === this.pinBtn) return; // the pin button handles its own click
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = this.host.getBoundingClientRect();
      const startLeft = rect.left;
      const startTop = rect.top;
      this._titlebarDragged = false;
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!this._titlebarDragged && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) this._titlebarDragged = true;
        if (!this._titlebarDragged) return;
        const vpW = window.innerWidth || document.documentElement.clientWidth || 800;
        const vpH = window.innerHeight || document.documentElement.clientHeight || 600;
        const panelRect = this.panel.getBoundingClientRect();
        const left = Math.min(Math.max(startLeft + dx, 0), Math.max(0, vpW - panelRect.width));
        const top = Math.min(Math.max(startTop + dy, 0), Math.max(0, vpH - panelRect.height));
        this.host.style.left = `${left}px`;
        this.host.style.top = `${top}px`;
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        if (this._titlebarDragged) {
          const finalRect = this.host.getBoundingClientRect();
          this._panelPos = { left: finalRect.left, top: finalRect.top };
          this._persistPlacementPrefs({ lflPanelPos: this._panelPos });
        }
      };
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
    }

    // Opt-in middle-click trigger (design §6.1) - default OFF
    // (`lflMiddleClickOpen`, toggled via `config middleclick on|off|alt`).
    // Plain middle-click natively starts autoscroll (Linux/Windows) and
    // opens links in a new tab; hijacking it unconditionally across
    // `<all_urls>` would break ordinary browsing. Resolution: only acts on
    // INERT background (never a link/button/field/selection/our own host -
    // see _isInertBackgroundTarget()), and only when enabled; every other
    // middle-click passes through untouched, native behavior intact.
    _onAuxClick(e) {
      if (!LFL.guards.isTrustedInputEvent(e)) return; // M3 H1 - see guards.js
      if (e.button !== 1) return; // middle button only
      if (!this._middleClickOpen) return;
      if (this._middleClickModifier === 'alt' && !e.altKey) return;
      if (!this._isInertBackgroundTarget(e.target)) return;
      e.preventDefault(); // suppress native autoscroll for the click we're about to act on
      if (this.isOpen()) {
        this.close();
      } else {
        this.open({ anchor: { x: e.clientX, y: e.clientY } });
      }
    }

    // True only for a click on ordinary page background: not a link/button/
    // form field/contenteditable/summary (native middle-click on those keeps
    // its own meaning - open-in-tab, native widget behavior, etc.), not
    // inside our own overlay, and not while the user has an active text
    // selection (a middle-click there is very likely "I meant to interact
    // with my selection", not "summon the terminal").
    _isInertBackgroundTarget(target) {
      if (!target) return true;
      if (this.host && (target === this.host || (typeof this.host.contains === 'function' && this.host.contains(target)))) {
        return false;
      }
      const interactive = typeof target.closest === 'function'
        ? target.closest('a[href], button, input, textarea, select, [contenteditable], summary, label')
        : null;
      if (interactive) return false;
      const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
      if (sel && !sel.isCollapsed) return false;
      return true;
    }

    // ---- collapse + resize (2026-07-14) ----
    //
    // Panel height is a user preference (persisted vh in storage.local
    // `lflPanelHeight`); collapse is a live per-instance toggle that folds the
    // scrollback away, leaving titlebar + input (+ the approval card if one is
    // pending - collapse only ever hides `.lfl-output`). The pure clamp/preset
    // math lives in registry.js so it is unit-tested; this is the DOM/storage
    // glue only.
    _applyPanelHeight() {
      if (this.panel) this.panel.style.maxHeight = `${this._panelHeightVh}vh`;
    }

    _setPanelHeightVh(vh, persist) {
      this._panelHeightVh = LFL.registry.clampPanelHeightVh(vh);
      this._applyPanelHeight();
      if (persist) this._savePanelHeight();
    }

    _stepPanelPreset(dir) {
      this._setPanelHeightVh(LFL.registry.stepPanelPreset(this._panelHeightVh, dir), true);
    }

    _loadPanelHeight() {
      try {
        chrome.storage.local.get(['lflPanelHeight'], (res) => {
          if (chrome.runtime.lastError) return;
          if (res && typeof res.lflPanelHeight === 'number') {
            this._panelHeightVh = LFL.registry.clampPanelHeightVh(res.lflPanelHeight);
            this._applyPanelHeight();
          }
        });
      } catch (_e) { /* storage unavailable - stays at the default height */ }
    }

    _savePanelHeight() {
      try { chrome.storage.local.set({ lflPanelHeight: this._panelHeightVh }); } catch (_e) { /* best-effort */ }
    }

    _toggleCollapse() {
      this._collapsed = !this._collapsed;
      this._applyCollapsed();
    }

    _applyCollapsed() {
      if (this.panel) this.panel.classList.toggle('lfl-collapsed', this._collapsed);
      if (this.caretEl) this.caretEl.textContent = this._collapsed ? '▸' : '▾';
      // keep the keyboard flow uninterrupted: on expand, refocus the input
      if (!this._collapsed && this.isOpen() && this.inputEl) this.inputEl.focus();
    }

    // Drag the top resizer grip: set the panel's max-height live from the
    // pointer's distance above the viewport bottom (the panel is anchored
    // there). isTrusted-gated at mousedown (M3 H1); the subsequent move/up are
    // part of that one trusted gesture. Persists once, on release.
    _startResize(e) {
      if (!LFL.guards.isTrustedInputEvent(e)) return; // M3 H1 - see guards.js
      e.preventDefault();
      const vpH = () => (window.innerHeight || document.documentElement.clientHeight || 800);
      const onMove = (ev) => {
        const fromBottom = vpH() - ev.clientY;
        this._setPanelHeightVh((fromBottom / vpH()) * 100, false);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        this._savePanelHeight();
      };
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
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
        // scripts v1: `continue` now resumes TWO independent pause
        // mechanisms that happen to share the same word - a rate-limit
        // pause (M2.3, above) and a parked script queue (a `pause "..."`
        // step - see _handlePauseSegment()). Both are checked; whichever (or
        // both) applied gets reported. A non-empty TS_QUEUE at mode 'idle'
        // can ONLY happen via a parked pause in normal operation (Enter
        // routes to _approvePending, not here, while any other proposal/
        // nav-confirm/script-preview is pending - see _isAwaitingSomething()),
        // so peeking the queue here is a safe, unambiguous signal.
        (async () => {
          const rlRes = await this._rlResume();
          const peek = await this._tsSend('TS_QUEUE_PEEK');
          const hasQueue = !!(peek.ok && Array.isArray(peek.queue) && peek.queue.length > 0);
          if (hasQueue) {
            if (rlRes.resumed) this.printInfo('resuming - rate-limit pause cleared');
            const msg = 'resuming script...';
            this.printInfo(msg);
            this._auditPush({ action: 'continue' }, 'auto', 'resuming paused script');
            this._settle(true, msg);
            await this._advanceQueue();
          } else {
            const msg = rlRes.resumed ? 'resuming - rate-limit pause cleared' : 'nothing paused to continue';
            this.printInfo(msg);
            this._auditPush({ action: 'continue' }, 'auto', msg);
            this._settle(true, msg);
          }
        })();
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
      if (/^autoopen$/i.test(raw)) { this._handleAutoOpen(); return; }
      if (/^alias(\s|$)/i.test(raw)) { this._handleAliasCommand(raw); return; }
      if (/^unalias\s+\S+$/i.test(raw)) { this._handleUnaliasCommand(raw); return; }
      if (/^macro(\s|$)/i.test(raw)) { this._handleMacroCommand(raw); return; }
      if (/^unmacro\s+\S+$/i.test(raw)) { this._handleUnmacroCommand(raw); return; }
      // scripts v1 (LFL-TERMINAL-SCRIPTS-DESIGN.md) - same "standalone
      // control command, no chain participation" posture as alias/macro
      // above (both need this.state/this._aliasStore access, and `run`
      // needs the async plan-preview approval flow).
      if (/^script(\s|$)/i.test(raw)) { this._handleScriptCommand(raw); return; }
      if (/^run(\s|$)/i.test(raw)) { this._handleRunCommand(raw); return; }
      // brainstorm lane (LFL-TERMINAL-BRAINSTORM-LANE-DESIGN.md) - same
      // "standalone control command, no chain participation" posture as
      // script/run just above (`teach` needs this.state/this._aliasStore
      // access, the async SW round trip, and the plan-preview approval flow).
      if (/^teach(\s|$)/i.test(raw)) { this._handleTeachCommand(raw); return; }
      // funpack v1: fortune/stats/theme/cowsay -- same "standalone control
      // command, no chain participation" posture as the M3 cluster just
      // above (they need chrome.storage.local access engine.js's
      // synchronous tryDeterministic() contract doesn't have; see
      // engine.js's registration comment for these four names).
      if (/^fortune$/i.test(raw)) { this._handleFortune(); return; }
      if (/^stats$/i.test(raw)) { this._handleStats(); return; }
      if (/^theme(\s|$)/i.test(raw)) { this._handleTheme(raw); return; }
      if (/^cowsay(\s|$)/i.test(raw)) { this._handleCowsay(raw); return; }
      // Popover redesign (2026-07-15) - same "standalone control command, no
      // chain participation" posture as the rest of this cluster (they need
      // chrome.storage.local access this file's synchronous engine.js
      // counterpart doesn't have).
      if (/^config(\s|$)/i.test(raw)) { this._handleConfigCommand(raw); return; }
      if (/^pin$/i.test(raw)) { this._handlePinCommand(true); return; }
      if (/^unpin$/i.test(raw)) { this._handlePinCommand(false); return; }

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

      // scripts v1 (LFL-TERMINAL-SCRIPTS-DESIGN.md §1): the hand-back
      // primitive. Dispatched here (not _submitCommand) so it works both as
      // a directly-typed segment and as a queued script/chain step, exactly
      // like `go` above.
      if (firstTok === 'pause') {
        this._handlePauseSegment(resolved);
        return;
      }

      // Verify fix (2026-07-14 Fable pass, LOW): `run`/`script` arriving
      // HERE means it came through a chain segment, a macro body, or an
      // alias expansion (a directly-typed lone `run`/`script` is caught by
      // _submitCommand's regex dispatch and never reaches this function).
      // Without this branch it would fall through to the page-lane LLM -
      // burning a model call and popping a confusing unrelated proposal for
      // a command that can never legitimately be a chain step (nested runs
      // are the depth-1 lock; `script` mid-chain is meaningless). Same
      // friendly-refusal posture as the games' fromChain block below.
      // `teach` (brainstorm lane, LFL-TERMINAL-BRAINSTORM-LANE-DESIGN.md §4)
      // gets the SAME dispatch-time refusal, for the same reason: a chain
      // segment, macro body, or alias expansion is never a human directly
      // typing at the prompt, and the brainstorm lane's whole invariant is
      // "only a human typing at the terminal can trigger it".
      if (firstTok === 'run' || firstTok === 'script' || firstTok === 'teach') {
        const msg = `"${firstTok}" cannot run as a chain/macro step - invoke it directly from the prompt`;
        this.printError(msg);
        this._auditPush({ action: firstTok }, 'blocked', msg);
        this._settle(false, msg);
        this._afterSettle(false); // clears the rest of the chain, consistent with every other blocked segment
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

    // ---- scripts v1 (2026-07-14, LFL-TERMINAL-SCRIPTS-DESIGN.md) ----
    //
    // `script new/ls/show/rm <name>` (management, this section) + `run <name>
    // [args...]` (invocation, below) + `pause "<instruction>"` (dispatched as
    // an ordinary chain segment - see _handlePauseSegment() near
    // _dispatchSegment()). A script is a macro grown up: named, multi-line,
    // parameterized, capped at 20 steps - see registry.js's parseScriptBody()/
    // substituteParams()/tokenizeArgs() for all the actual validation/
    // injection-safety logic; this class only owns the chrome.*-capable
    // command surface and the plan-preview approval UI.

    _handleScriptCommand(raw) {
      const m = raw.match(/^script(?:\s+(\S+))?(?:\s+(.*))?$/i);
      const sub = (m && m[1] || '').toLowerCase();
      const rest = (m && m[2] || '').trim();

      if (!sub) {
        const msg = 'usage: script new|ls|show|rm <name> | export [<name>|--all] | import';
        this.printInfo(msg);
        this._settle(true, msg);
        return;
      }

      if (sub === 'new') {
        const name = rest.split(/\s+/)[0] || '';
        if (!name) {
          const msg = 'usage: script new <name>';
          this.printError(msg);
          this._settle(false, msg);
          return;
        }
        // Validate the name BEFORE capturing a whole multi-line body - no
        // point making the human type 20 lines only to reject the name at
        // the end. setScript() re-validates this same check at save time
        // regardless (names could in principle change underneath a long
        // edit session in a multi-tab scenario), so this is a friendlier
        // early error, not the only check.
        const avail = this._aliasStore.checkNameAvailable(name.toLowerCase());
        if (!avail.ok) {
          this.printError(`script: ${avail.reason}`);
          this._settle(false, avail.reason);
          return;
        }
        this.state.mode = 'editing-script';
        this.state.scriptEditName = name.toLowerCase();
        this.state.scriptEditBuffer = [];
        this.printInfo(`entering script "${name}" - one command per line (max ${LFL.registry.SCRIPT_MAX_STEPS}), "#" comments allowed`);
        this.printInfo('blank line or Ctrl+Enter to save, Esc to cancel');
        this._settle(true, `editing script "${name}"`);
        return;
      }

      if (sub === 'ls') {
        const list = this._aliasStore.listScripts();
        const names = Object.keys(list).sort();
        const msg = names.length
          ? names.map((n) => {
            const s = list[n];
            return `  ${n}  (${s.stepCount} step(s), ${s.arity} arg(s)${s.usesRest ? '+' : ''})`;
          }).join('\n')
          : '(no scripts defined)';
        this.printInfo(msg);
        this._auditPush({ action: 'script' }, 'auto', msg.slice(0, 160));
        this._settle(true, msg);
        return;
      }

      if (sub === 'show') {
        if (!rest) {
          const msg = 'usage: script show <name>';
          this.printError(msg);
          this._settle(false, msg);
          return;
        }
        const s = this._aliasStore.getScript(rest.toLowerCase());
        if (s === null) {
          const msg = `no such script: ${rest}`;
          this.printError(msg);
          this._settle(false, msg);
          return;
        }
        const msg = s.body.split('\n').map((line, i) => `  ${i + 1}. ${line}`).join('\n');
        this.printInfo(msg);
        this._settle(true, msg);
        return;
      }

      if (sub === 'rm') {
        if (!rest) {
          const msg = 'usage: script rm <name>';
          this.printError(msg);
          this._settle(false, msg);
          return;
        }
        const res = this._aliasStore.unsetScript(rest.toLowerCase());
        const msg = res.ok ? `script removed: ${rest}` : `script: ${res.reason}`;
        if (res.ok) this.printOk(msg); else this.printError(msg);
        this._auditPush({ action: 'script' }, res.ok ? 'auto' : 'blocked', msg);
        this._settle(res.ok, msg);
        return;
      }

      if (sub === 'export') {
        this._handleScriptExport(rest);
        return;
      }

      if (sub === 'import') {
        this._handleScriptImport();
        return;
      }

      const msg = `unknown script subcommand "${sub}" - try: script new|ls|show|rm <name> | export [<name>|--all] | import`;
      this.printError(msg);
      this._settle(false, msg);
    }

    // ---- scripts v1 P2 (2026-07-14, portability) - export/import a plain
    // `.lflscript` file. NO NEW PERMISSIONS: export is a Blob URL + a
    // transient <a download> click, import is a transient <input type=file>
    // - both are ordinary page-level DOM APIs, needing no downloads-style
    // extension permission at all (see manifest.json, unchanged: permissions
    // stay exactly ["storage"]). Both transient elements live in THIS
    // instance's own closed shadow root (this.shadow), never the page's
    // document - the host page can neither see nor interfere with them, and
    // there is nothing left behind afterwards.
    //
    // THE SECURITY INVARIANT (import): an imported file is untrusted text.
    // _importScriptText() below feeds every {name, body} pair the parser
    // extracts through this._aliasStore.setScript() - the EXACT SAME write
    // path a hand-typed `script new` uses, which re-runs parseScriptBody()
    // (step cap, index-verb rejection, games/funpack/nested-run locks) AND
    // the one-flat-namespace collision checks against existing
    // aliases/macros/scripts (registry.js's setScript()). parseScriptFile()
    // itself validates NOTHING but the file's structural shape (the version
    // header + name/body splitting) - it cannot be the thing that decides an
    // imported script is safe, and it doesn't try to be.

    _handleScriptExport(rest) {
      const arg = (rest || '').trim();
      const all = !arg || arg === '--all';
      let toExport;
      let filename;
      if (all) {
        toExport = this._aliasStore.listScripts();
        if (Object.keys(toExport).length === 0) {
          const msg = 'no scripts defined - nothing to export';
          this.printError(msg);
          this._settle(false, msg);
          return;
        }
        filename = 'scripts.lflscript';
      } else {
        const name = arg.toLowerCase();
        const s = this._aliasStore.getScript(name);
        if (s === null) {
          const msg = `no such script: ${arg}`;
          this.printError(msg);
          this._settle(false, msg);
          return;
        }
        toExport = { [name]: s };
        filename = `${name}.lflscript`;
      }
      const text = LFL.registry.serializeScripts(toExport);
      const names = Object.keys(toExport).sort();
      const ok = this._downloadTextFile(filename, text);
      const msg = ok
        ? `exported ${names.length} script(s) to ${filename}: ${names.join(', ')}`
        : `export failed - could not create the download`;
      if (ok) this.printOk(msg); else this.printError(msg);
      this._auditPush({ action: 'script', reason: `export ${names.join(',')}` }, ok ? 'auto' : 'blocked', msg);
      this._settle(ok, msg);
    }

    // Thin DOM glue - cannot be unit-tested headlessly (no real file-save
    // dialog in Node). See this build's report for the manual smoke steps.
    _downloadTextFile(filename, text) {
      try {
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        this.shadow.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return true;
      } catch (_e) {
        return false;
      }
    }

    // Thin DOM glue - cannot be unit-tested headlessly (no real file-picker
    // dialog in Node). See this build's report for the manual smoke steps.
    // The 'cancel' event on <input type=file> (Chrome/Edge, which is this
    // project's v1 target browser - see README) fires when the picker is
    // dismissed with no file chosen; 'change' fires once a file IS chosen.
    _handleScriptImport() {
      this.printInfo('opening file picker for a .lflscript file...');
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.lflscript,text/plain';
      this.shadow.appendChild(input);

      const finish = (cb) => {
        input.remove();
        cb();
      };
      const reportCancelled = () => {
        const msg = 'import cancelled - no file chosen';
        this.printInfo(msg);
        this._settle(false, msg);
      };

      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) { finish(reportCancelled); return; }
        file.text().then((text) => {
          finish(() => this._importScriptText(text, file.name));
        }).catch((e) => {
          finish(() => {
            const msg = `could not read file: ${e && e.message ? e.message : e}`;
            this.printError(msg);
            this._settle(false, msg);
          });
        });
      });
      input.addEventListener('cancel', () => finish(reportCancelled));
      input.click();
    }

    // The one function that decides whether an imported script is safe to
    // keep: every {name, body} pair from the (untrusted) parsed file is
    // written through this._aliasStore.setScript() - see this section's
    // header comment for why that is the ONLY acceptable write path.
    _importScriptText(text, filename) {
      const parsed = LFL.registry.parseScriptFile(text);
      if (!parsed.ok) {
        const msg = `import failed: ${parsed.reason}`;
        this.printError(msg);
        this._auditPush({ action: 'script', reason: `import ${filename || ''}` }, 'blocked', msg);
        this._settle(false, msg);
        return;
      }
      const imported = [];
      const skipped = [];
      for (const entry of parsed.scripts) {
        const lname = (entry.name || '').toLowerCase();
        const res = this._aliasStore.setScript(lname, entry.body);
        if (res.ok) {
          imported.push(`${lname} (${res.stepCount} step(s))`);
        } else {
          skipped.push(`${entry.name}: ${res.reason}`);
        }
      }
      const lines = [`import from ${filename || '(file)'}: ${imported.length} imported, ${skipped.length} skipped`];
      if (imported.length) lines.push(`  imported: ${imported.join(', ')}`);
      skipped.forEach((s) => lines.push(`  skipped: ${s}`));
      const msg = lines.join('\n');
      if (imported.length) this.printOk(msg); else this.printError(msg);
      this._auditPush({ action: 'script', reason: `import ${filename || ''}` }, imported.length ? 'auto' : 'blocked', msg.slice(0, 200));
      this._settle(imported.length > 0, msg);
    }

    // One line of an in-progress `script new` capture - see the
    // 'editing-script' branch in _onInputKeydown(). Enforces the same step
    // cap parseScriptBody() will re-check at save time (counting raw
    // captured lines, including any blank/comment lines the human typed, is
    // a slightly stricter but simple and safe equivalent).
    _appendScriptEditLine(line) {
      if (this.state.scriptEditBuffer.length >= LFL.registry.SCRIPT_MAX_STEPS) {
        this.printError(`script body already at the ${LFL.registry.SCRIPT_MAX_STEPS}-step cap - blank line/Ctrl+Enter to save, Esc to cancel`);
        return;
      }
      this.state.scriptEditBuffer.push(line);
      this.printInfo(`  ${this.state.scriptEditBuffer.length}. ${line}`);
    }

    _finishScriptEdit() {
      const name = this.state.scriptEditName;
      const body = this.state.scriptEditBuffer.join('\n');
      this.state.mode = 'idle';
      this.state.scriptEditName = null;
      this.state.scriptEditBuffer = null;
      if (!body.trim()) {
        const msg = 'script body cannot be empty - definition cancelled';
        this.printError(msg);
        this._settle(false, msg);
        return;
      }
      const res = this._aliasStore.setScript(name, body);
      const msg = res.ok
        ? `script "${name}" saved (${res.stepCount} step(s)${res.arity ? `, ${res.arity} arg(s)` : ''})`
        : `script: ${res.reason}`;
      if (res.ok) this.printOk(msg); else this.printError(msg);
      this._auditPush({ action: 'script', reason: `define ${name}` }, res.ok ? 'auto' : 'blocked', msg);
      this._settle(res.ok, msg);
    }

    _cancelScriptEdit() {
      const name = this.state.scriptEditName;
      this.state.mode = 'idle';
      this.state.scriptEditName = null;
      this.state.scriptEditBuffer = null;
      const msg = `script "${name}" definition cancelled`;
      this.printInfo(msg);
      this._settle(false, 'cancelled');
    }

    // `pause "<instruction>"` (design doc §1) - dispatched from
    // _dispatchSegment() exactly like `go`, so it works both typed directly
    // and as a queued script/chain step. Prints the instruction and settles
    // true, but deliberately does NOT call _afterSettle() - that is the
    // whole mechanism: it leaves the remaining TS_QUEUE parked exactly as-is
    // instead of auto-advancing, so only an explicit `continue` (see
    // _submitCommand's continue handler) resumes it.
    _handlePauseSegment(resolved) {
      const m = resolved.match(/^pause\s+"([^"]*)"\s*$/i);
      const instruction = m ? m[1] : resolved.replace(/^pause\s*/i, '').trim();
      const msg = instruction ? `paused - ${instruction}` : 'paused';
      this.printInfo(`⏸ ${msg} - type "continue" when ready`);
      this._auditPush({ action: 'pause', reason: instruction }, 'paused', msg);
      this._settle(true, msg);
    }

    // ---- scripts v1: `run <name> [args...]` - injection-safe param
    // substitution + single plan-preview-then-run approval (design doc §9
    // sign-off #5) ----

    async _handleRunCommand(raw) {
      const m = raw.match(/^run\s+(\S+)(?:\s+(.*))?$/i);
      if (!m) {
        const msg = 'usage: run <name> [args...]';
        this.printError(msg);
        this._settle(false, msg);
        return;
      }
      const name = m[1].toLowerCase();
      const argsRaw = m[2] || '';

      // Same "one thing pending at a time" lock the game-start guard uses
      // (_maybeBlockGameStart) - a leftover interrupted chain or a parked
      // script pause must be finished or cancelled before starting a new run.
      const peek = await this._tsSend('TS_QUEUE_PEEK');
      if (peek.ok && Array.isArray(peek.queue) && peek.queue.length > 0) {
        const msg = 'cannot run a script - a chained command is still pending (finish with "continue" or cancel it first)';
        this.printError(msg);
        this._auditPush({ action: 'run', reason: name }, 'blocked', msg);
        this._settle(false, msg);
        return;
      }

      const script = this._aliasStore.getScript(name);
      if (script === null) {
        const msg = `no such script: ${name}`;
        this.printError(msg);
        this._settle(false, msg);
        return;
      }

      const tok = LFL.registry.tokenizeArgs(argsRaw);
      if (!tok.ok) {
        this.printError(`run: ${tok.reason}`);
        this._settle(false, tok.reason);
        return;
      }

      // Re-parse the stored body defensively (setScript() already validated
      // it at write time - see that function's own comment for why `run`
      // re-checks anyway rather than trusting storage unconditionally).
      const parsed = LFL.registry.parseScriptBody(script.body, { maxSteps: LFL.registry.SCRIPT_MAX_STEPS });
      if (!parsed.ok) {
        const msg = `stored script "${name}" is invalid: ${parsed.reason}`;
        this.printError(msg);
        this._settle(false, msg);
        return;
      }
      if (tok.tokens.length < parsed.arity) {
        const msg = `script "${name}" expects ${parsed.arity} arg(s), got ${tok.tokens.length}`;
        this.printError(msg);
        this._settle(false, msg);
        return;
      }

      const resolvedSteps = [];
      for (let i = 0; i < parsed.steps.length; i++) {
        const sub = LFL.registry.substituteParams(parsed.steps[i], tok.tokens);
        if (!sub.ok) {
          const msg = `script "${name}" step ${i + 1}: ${sub.reason}`;
          this.printError(msg);
          this._settle(false, msg);
          return;
        }
        // Verify fix (2026-07-14 Fable pass, MED): re-validate the step
        // AFTER substitution and alias expansion - a head-position parameter
        // (template `$1` run with arg "click 4") or an alias whose current
        // expansion is index-addressed (`alias c4 = click 4`) would
        // otherwise resurrect exactly the snapshot-bound index replay
        // parseScriptBody() rejected at define time, laundered through a
        // level of indirection the write-time check cannot see. See
        // registry.js's validateResolvedStep() for the full rationale and
        // the documented mid-pause-redefinition residual.
        const expanded = LFL.registry.expandAlias(sub.text, this._aliasStore);
        const valid = LFL.registry.validateResolvedStep(expanded);
        if (!valid.ok) {
          const msg = `script "${name}" step ${i + 1} (resolves to "${expanded}"): ${valid.reason}`;
          this.printError(msg);
          this._auditPush({ action: 'run', reason: name }, 'blocked', msg);
          this._settle(false, msg);
          return;
        }
        resolvedSteps.push(sub.text);
      }

      // Plan preview (sign-off #5): show the FULLY substituted step list -
      // what you approve is exactly what runs, no further surprises - via
      // the same approval-card UI as a navigation confirm.
      this.state.pendingScriptRun = { name, steps: resolvedSteps };
      this.state.mode = 'awaiting-script-run';
      this.glossEl.textContent = `SCRIPT: run ${name}${argsRaw ? ' ' + argsRaw : ''}`;
      this.detailEl.textContent = resolvedSteps.map((s, i) => `${i + 1}. ${s}`).join('\n');
      this.proposalEl.hidden = false;
      this.inputEl.readOnly = true;
      this._seq++;
      this._updateTestHook();
      if (this.approveBtn) this.approveBtn.focus();
    }

    async _approveScriptRun() {
      const run = this.state.pendingScriptRun;
      if (!run || this._approvalBusy) return;
      this._approvalBusy = true;
      try {
        // M2.1-style occlusion re-check - same clickjacking-style reasoning
        // as every other approval gate (_approveProposal()/_approveNav()):
        // sample what's actually topmost at the approve control RIGHT NOW,
        // immediately before starting the run.
        const occlusion = this._probeApprovalOcclusion();
        if (occlusion.occluded) {
          this.proposalEl.hidden = true;
          this.inputEl.readOnly = false;
          this.inputEl.focus();
          this.state.mode = 'idle';
          const msg = `approval UI was covered - script run cancelled for safety (${occlusion.reason})`;
          this.printError(msg);
          this._auditPush({ action: 'run', reason: run.name }, 'aborted(occluded)', msg);
          this.state.pendingScriptRun = null;
          this._settle(false, msg);
          return;
        }

        this.proposalEl.hidden = true;
        this.inputEl.readOnly = false;
        this.state.mode = 'idle';
        this.state.pendingScriptRun = null;
        this._auditPush({ action: 'run', reason: run.name }, 'approved', `running ${run.steps.length} step(s)`);

        // Queue everything past the first step, then dispatch the first
        // step through the SAME path _runChain() uses to start a chain -
        // every subsequent step (popped off the SW-backed queue, possibly
        // after a navigation) is unconditionally chain-context, exactly
        // like a macro expansion's segments (see _advanceQueue()'s own
        // comment). No separate _settle() here for "the run started" - each
        // dispatched step produces its own settle, same as an ordinary
        // `&&` chain never settling the chain itself, only its steps.
        if (run.steps.length > 1) {
          await this._tsSend('TS_QUEUE_SET', {
            queue: run.steps.slice(1),
            expectedOrigin: typeof location !== 'undefined' ? location.origin : null,
          });
        } else {
          await this._tsSend('TS_QUEUE_CLEAR');
        }
        await this._dispatchSegment(run.steps[0], { fromChain: true });
      } finally {
        this._approvalBusy = false;
      }
    }

    _rejectScriptRun() {
      const run = this.state.pendingScriptRun;
      if (!run) return;
      this.proposalEl.hidden = true;
      this.inputEl.readOnly = false;
      this.inputEl.focus();
      this.state.mode = 'idle';
      this.printInfo('script run cancelled');
      this._auditPush({ action: 'run', reason: run.name }, 'rejected', '(not run)');
      this.state.pendingScriptRun = null;
      this._settle(null, 'rejected (script not run)');
    }

    // ---- brainstorm lane (2026-07-15, LFL-TERMINAL-BRAINSTORM-LANE-DESIGN.md) ----
    //
    // `teach <goal text> [as <name>]` - describe a workflow in plain words;
    // the local model (background/service-worker.js's BRAINSTORM_LLM_REQUEST
    // lane) drafts a script BODY; the body is validated through the SAME
    // real registry.js path a hand-typed `script new` body goes through
    // (this._aliasStore.validateScriptBody()/setScript() - single source of
    // truth, no reimplemented rules); the human approves (or discards)
    // before anything is ever saved. `teach on`/`teach off` toggle the
    // opt-in (default OFF - design §2 invariant 6); a bare `teach` is
    // status + one-line help. See _isAwaitingSomething()/_approvePending()/
    // _rejectPending() above for how 'awaiting-teach-save' joins the
    // existing approval-card machinery, and the 'awaiting-teach-name'
    // branch in _onInputKeydown() for the no-`as <name>` follow-up prompt.

    _printTeachStatus() {
      const msg = this._brainstormEnabled
        ? 'teach is ON - type: teach <goal text> [as <name>] to draft a script'
        : 'teach is OFF - type "teach on" to enable (asks your local model to draft scripts you approve)';
      this.printInfo(msg);
      this._auditPush({ action: 'teach' }, 'auto', msg);
      this._settle(true, msg);
    }

    _setTeachEnabled(on) {
      this._brainstormEnabled = !!on;
      try { chrome.storage.local.set({ lflBrainstormEnabled: this._brainstormEnabled }); } catch (_e) { /* best-effort */ }
      const msg = `teach ${this._brainstormEnabled ? 'enabled' : 'disabled'}`;
      this.printOk(msg);
      this._auditPush({ action: 'teach' }, 'auto', msg);
      this._settle(true, msg);
    }

    async _handleTeachCommand(raw) {
      const m = raw.match(/^teach(?:\s+(.*))?$/i);
      const rest = (m && m[1] || '').trim();

      if (!rest) { this._printTeachStatus(); return; }
      if (/^on$/i.test(rest)) { this._setTeachEnabled(true); return; }
      if (/^off$/i.test(rest)) { this._setTeachEnabled(false); return; }

      // Opt-in gate (design §2 invariant 6, §3): while off, a draft attempt
      // prints one line and makes ZERO network/SW-LLM calls - checked BEFORE
      // any parsing of the goal/name, before the rate-limit check, before
      // chrome.runtime.sendMessage is ever reached.
      if (!this._brainstormEnabled) {
        const msg = 'teach is off - type "teach on" to enable (asks your local model to draft scripts you approve)';
        this.printInfo(msg);
        this._auditPush({ action: 'teach' }, 'blocked', msg);
        this._settle(false, msg);
        return;
      }

      // Trailing ` as <name>` is optional - `name` is the last token, and
      // must be a plausible script-name token (letters/digits/-/_, starting
      // with a letter - the same shape registry.js's NAME_RE requires) or it
      // is NOT treated as a name (so a goal that happens to end in the word
      // "as" followed by ordinary prose, e.g. "...treat me as a beginner",
      // does not misfire - a real name is one bare word, not a phrase).
      const asMatch = rest.match(/^(.*)\s+as\s+([a-z][a-z0-9_-]*)\s*$/i);
      const goal = (asMatch ? asMatch[1] : rest).trim();
      const name = asMatch ? asMatch[2].toLowerCase() : null;

      if (!goal) {
        const msg = 'usage: teach <goal text> [as <name>]';
        this.printError(msg);
        this._settle(false, msg);
        return;
      }

      // Same early-check UX as `script new <name>` (see _handleScriptCommand):
      // if a name was given, check it BEFORE spending an LLM call on a draft
      // that could never be saved under it.
      if (name) {
        const avail = this._aliasStore.checkNameAvailable(name);
        if (!avail.ok) {
          this.printError(`teach: ${avail.reason}`);
          this._settle(false, avail.reason);
          return;
        }
      }

      // Same LLM-call rate-limit budget as the page-lane/nav-lane (design
      // §4: "a draft costs one slot") - checked/recorded via the SW-
      // authoritative limiter, same _rlCheck/_rlRecord helpers _handleGo()/
      // _runLlm() already use.
      const budgetCheck = await this._rlCheck('llm');
      if (!budgetCheck.allowed) {
        this.printError(budgetCheck.reason);
        this._auditPush({ action: 'teach' }, 'blocked', budgetCheck.reason);
        this._settle(false, budgetCheck.reason);
        return;
      }
      await this._rlRecord('llm');

      this.printInfo('… asking the local model to draft a script');
      let resp;
      try {
        // THE isolation-critical call: the payload sent to the model
        // contains ONLY `goal` (this typed text) - no page content of any
        // kind. See service-worker.js's buildBrainstormPayload() and
        // tests/brainstorm_lane_isolation.test.js for the proof.
        resp = await chrome.runtime.sendMessage({ type: 'BRAINSTORM_LLM_REQUEST', goal });
      } catch (e) {
        resp = { ok: false, error: 'local model offline - deterministic commands still work (' + (e && e.message ? e.message : 'messaging error') + ')' };
      }
      if (!resp || !resp.ok) {
        const errMsg = (resp && resp.error) || 'local model offline - deterministic commands still work';
        this.printError(errMsg);
        this._auditPush({ action: 'teach' }, 'n/a', errMsg);
        this._settle(false, errMsg);
        return;
      }

      const draft = resp.action || {};
      const body = typeof draft.script === 'string' ? draft.script : '';
      if (!body.trim()) {
        const msg = 'the local model returned no script - try re-running with a clearer description';
        this.printError(msg);
        this._auditPush({ action: 'teach' }, 'n/a', msg);
        this._settle(false, msg);
        return;
      }

      // Validate WITHOUT persisting (design §4 - "validate first without
      // persisting... call setScript() only on approval"). `name` may be
      // null here (no `as <name>` was given) - validateScriptBody() skips
      // the name-specific checks in that case and validates the body alone;
      // the name is checked for real (checkNameAvailable(), again, since
      // time has passed) once one is captured, in _captureTeachName() below.
      const validated = this._aliasStore.validateScriptBody(name, body);

      if (!validated.ok) {
        // INVALID draft (design §3): show the model's raw proposed steps
        // (same line-filtering parseScriptBody() itself uses - trimmed,
        // blank/comment lines dropped - so the numbering matches what the
        // reason's "step N" refers to), the reason, and a hint. No approval
        // card, nothing saved, NO auto-retry (§9 sign-off #4).
        const rawLines = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && l.charAt(0) !== '#');
        const stepsText = rawLines.length
          ? rawLines.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
          : '  (model returned no usable lines)';
        this.printInfo(stepsText);
        const msg = `draft rejected: ${validated.reason}`;
        this.printError(msg);
        this.printInfo('re-run "teach" with a clearer description, or write it by hand with "script new"');
        this._auditPush({ action: 'teach', reason: validated.reason }, 'blocked', msg);
        this._settle(false, msg);
        return;
      }

      // VALID draft: numbered steps (same rendering as `script show`) + the
      // approval card - reuses the SAME top-layer card + occlusion probe as
      // `run`'s plan-preview (_probeApprovalOcclusion(), _approvePending()/
      // _rejectPending() routing via 'awaiting-teach-save').
      this.state.pendingTeach = { goal, name, body, steps: validated.steps };
      this.state.mode = 'awaiting-teach-save';
      this.glossEl.textContent = name ? `TEACH: save as "${name}"?` : 'TEACH: save this script?';
      const stepsText = validated.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
      this.detailEl.textContent = name
        ? stepsText
        : `${stepsText}\n(you will be asked for a name after approving)`;
      this.proposalEl.hidden = false;
      this.inputEl.readOnly = true;
      this._seq++;
      this._updateTestHook();
      if (this.approveBtn) this.approveBtn.focus();
    }

    async _approveTeachSave() {
      const draft = this.state.pendingTeach;
      if (!draft || this._approvalBusy) return;
      this._approvalBusy = true;
      try {
        // M2.1-style occlusion re-check, same clickjacking-style reasoning as
        // every other approval gate (_approveProposal()/_approveNav()/
        // _approveScriptRun()).
        const occlusion = this._probeApprovalOcclusion();
        if (occlusion.occluded) {
          this.proposalEl.hidden = true;
          this.inputEl.readOnly = false;
          this.inputEl.focus();
          this.state.mode = 'idle';
          const msg = `approval UI was covered - draft discarded for safety (${occlusion.reason})`;
          this.printError(msg);
          this._auditPush({ action: 'teach', reason: draft.name || '(unnamed)' }, 'aborted(occluded)', msg);
          this.state.pendingTeach = null;
          this._settle(false, msg);
          return;
        }

        if (draft.name) {
          // A name was already given and already checked available - save
          // now through the real setScript() (which re-validates everything,
          // same defense-in-depth posture as `run`'s re-parse of a stored
          // body - see that method's own comment).
          this.proposalEl.hidden = true;
          this.inputEl.readOnly = false;
          this.state.mode = 'idle';
          this.state.pendingTeach = null;
          const res = this._aliasStore.setScript(draft.name, draft.body);
          if (res.ok) {
            const msg = `script "${draft.name}" saved (${res.stepCount} step(s)${res.arity ? `, ${res.arity} arg(s)` : ''}) - try: run ${draft.name}`;
            this.printOk(msg);
            this._auditPush({ action: 'teach', reason: draft.name }, 'approved', msg);
            this._settle(true, msg);
          } else {
            const msg = `teach: could not save "${draft.name}" - ${res.reason}`;
            this.printError(msg);
            this._auditPush({ action: 'teach', reason: draft.name }, 'blocked', msg);
            this._settle(false, msg);
          }
          this.inputEl.focus();
          return;
        }

        // No name was given (design §3): prompt once for one on the input
        // line, reusing the script editor's line-capture pattern - see the
        // 'awaiting-teach-name' branch in _onInputKeydown().
        this.proposalEl.hidden = true;
        this.state.mode = 'awaiting-teach-name';
        this.inputEl.readOnly = false;
        this.inputEl.value = '';
        this.inputEl.focus();
        this.printInfo('name for this script? (Esc to discard)');
        this._settle(true, 'awaiting a name for the drafted script');
      } finally {
        this._approvalBusy = false;
      }
    }

    _rejectTeachSave() {
      const draft = this.state.pendingTeach;
      if (!draft) return;
      this.proposalEl.hidden = true;
      this.inputEl.readOnly = false;
      this.inputEl.focus();
      this.state.mode = 'idle';
      this.printInfo('draft discarded');
      this._auditPush({ action: 'teach', reason: draft.name || '(unnamed)' }, 'rejected', '(not saved)');
      this.state.pendingTeach = null;
      this._settle(null, 'rejected (draft not saved)');
    }

    // The no-`as <name>` follow-up (see _approveTeachSave()'s last branch and
    // the 'awaiting-teach-name' case in _onInputKeydown()). `name` is
    // whatever the human typed, already trimmed; empty input reprompts
    // rather than silently discarding (Esc is the explicit discard gesture -
    // _cancelTeachName() below).
    _captureTeachName(name) {
      const draft = this.state.pendingTeach;
      if (!draft) { this.state.mode = 'idle'; return; }
      if (!name) {
        this.printError('a name is required - type one, or Esc to discard');
        return; // stay in 'awaiting-teach-name', let them try again
      }
      const lower = name.toLowerCase();
      const avail = this._aliasStore.checkNameAvailable(lower);
      if (!avail.ok) {
        this.printError(`teach: ${avail.reason} - try another name, or Esc to discard`);
        return; // stay in the mode, retry
      }
      const res = this._aliasStore.setScript(lower, draft.body);
      this.state.mode = 'idle';
      this.state.pendingTeach = null;
      if (res.ok) {
        const msg = `script "${lower}" saved (${res.stepCount} step(s)${res.arity ? `, ${res.arity} arg(s)` : ''}) - try: run ${lower}`;
        this.printOk(msg);
        this._auditPush({ action: 'teach', reason: lower }, 'approved', msg);
        this._settle(true, msg);
      } else {
        const msg = `teach: could not save "${lower}" - ${res.reason}`;
        this.printError(msg);
        this._auditPush({ action: 'teach', reason: lower }, 'blocked', msg);
        this._settle(false, msg);
      }
    }

    _cancelTeachName() {
      this.state.mode = 'idle';
      this.state.pendingTeach = null;
      this.printInfo('draft discarded');
      this._auditPush({ action: 'teach' }, 'rejected', '(not saved)');
      this._settle(null, 'rejected (draft not saved)');
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

    // ---- popover redesign: `config` / `pin` / `unpin` (2026-07-15) ----

    _configStatusText() {
      const mc = !this._middleClickOpen
        ? 'off'
        : (this._middleClickModifier === 'alt' ? 'on (alt+middle-click)' : 'on (plain middle-click)');
      return [
        `anchor: ${this._anchorMode}  (config anchor cursor|dock)`,
        `pinned: ${this._pinned ? 'yes' : 'no'}  (pin / unpin, or the titlebar pin button)`,
        `middle-click open: ${mc}  (config middleclick on|off|alt|plain)`,
      ].join('\n');
    }

    _handleConfigCommand(raw) {
      const parts = raw.trim().split(/\s+/);
      if (parts.length === 1) {
        const msg = this._configStatusText();
        this.printInfo(msg);
        this._auditPush({ action: 'config' }, 'auto', msg.slice(0, 160));
        this._settle(true, msg);
        return;
      }
      const sub = parts[1].toLowerCase();
      if (sub === 'anchor') {
        const val = (parts[2] || '').toLowerCase();
        if (val !== 'cursor' && val !== 'dock') {
          const msg = 'config anchor: expected "cursor" or "dock"';
          this.printError(msg);
          this._auditPush({ action: 'config' }, 'blocked', msg);
          this._settle(false, msg);
          return;
        }
        this._anchorMode = val;
        this._persistPlacementPrefs({ lflAnchorMode: val });
        const msg = `anchor mode set: ${val}`;
        this.printOk(msg);
        this._auditPush({ action: 'config' }, 'auto', msg);
        this._settle(true, msg);
        return;
      }
      if (sub === 'middleclick') {
        const val = (parts[2] || '').toLowerCase();
        if (val === 'on') {
          this._middleClickOpen = true;
          this._middleClickModifier = 'none';
          this._persistPlacementPrefs({ lflMiddleClickOpen: true, lflMiddleClickModifier: 'none' });
          const msg = 'middle-click open: ON - plain middle-click over inert page background summons the panel; '
            + 'native middle-click autoscroll no longer starts there (links/buttons/fields/selected text are unaffected)';
          this.printOk(msg);
          this._auditPush({ action: 'config' }, 'auto', msg.slice(0, 160));
          this._settle(true, msg);
          return;
        }
        if (val === 'off') {
          this._middleClickOpen = false;
          this._persistPlacementPrefs({ lflMiddleClickOpen: false });
          const msg = 'middle-click open: OFF - native middle-click autoscroll restored';
          this.printOk(msg);
          this._auditPush({ action: 'config' }, 'auto', msg);
          this._settle(true, msg);
          return;
        }
        if (val === 'alt') {
          this._middleClickOpen = true;
          this._middleClickModifier = 'alt';
          this._persistPlacementPrefs({ lflMiddleClickOpen: true, lflMiddleClickModifier: 'alt' });
          const msg = 'middle-click open: ON, Alt+middle-click only - plain middle-click keeps native autoscroll';
          this.printOk(msg);
          this._auditPush({ action: 'config' }, 'auto', msg);
          this._settle(true, msg);
          return;
        }
        if (val === 'plain') {
          this._middleClickModifier = 'none';
          this._persistPlacementPrefs({ lflMiddleClickModifier: 'none' });
          const msg = 'middle-click modifier reset: plain middle-click (must also be "on" to take effect)';
          this.printOk(msg);
          this._auditPush({ action: 'config' }, 'auto', msg);
          this._settle(true, msg);
          return;
        }
        const msg = 'config middleclick: expected "on", "off", "alt", or "plain"';
        this.printError(msg);
        this._auditPush({ action: 'config' }, 'blocked', msg);
        this._settle(false, msg);
        return;
      }
      const msg = `config: unknown setting "${parts[1]}" - try: config anchor cursor|dock, config middleclick on|off|alt|plain`;
      this.printError(msg);
      this._auditPush({ action: 'config' }, 'blocked', msg);
      this._settle(false, msg);
    }

    _handlePinCommand(shouldPin) {
      if (this._pinned === shouldPin) {
        const msg = shouldPin ? 'panel is already pinned' : 'panel is already unpinned';
        this.printInfo(msg);
        this._auditPush({ action: shouldPin ? 'pin' : 'unpin' }, 'auto', msg);
        this._settle(true, msg);
        return;
      }
      this._togglePinned();
      const msg = shouldPin
        ? 'panel pinned - drag the titlebar to move it, or type "unpin"'
        : 'panel unpinned - reopens at the cursor';
      this.printOk(msg);
      this._auditPush({ action: shouldPin ? 'pin' : 'unpin' }, 'auto', msg);
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

    // ---- auto-open-on-home (2026-07-14) ----
    //
    // `autoopen` toggles whether THIS page's origin is on the opt-in list that
    // makes the overlay open by itself on arrival (see _maybeAutoOpenHome).
    // Standalone control command, no `&&` chaining - same posture as origins/
    // dev above (needs chrome.storage.local, which engine.js's synchronous
    // tryDeterministic() contract can't reach). Only real http(s) origins are
    // eligible: chrome://newtab and other privileged pages never run this
    // content script at all, and a null/opaque origin (sandboxed frame,
    // data:/about:) has no stable identity to key the list on.
    _currentAutoOpenOrigin() {
      const origin = (typeof location !== 'undefined' && location.origin) ? location.origin : null;
      if (!origin || origin === 'null' || !/^https?:$/.test((typeof location !== 'undefined' && location.protocol) || '')) {
        return null;
      }
      return origin;
    }

    _handleAutoOpen() {
      const origin = this._currentAutoOpenOrigin();
      if (!origin) {
        const msg = 'autoopen: not available on this page (only http/https sites can be auto-open homes)';
        this.printError(msg);
        this._auditPush({ action: 'autoopen' }, 'blocked', msg);
        this._settle(false, msg);
        return;
      }
      try {
        chrome.storage.local.get(['lflAutoOpenOrigins'], (res) => {
          if (chrome.runtime.lastError) {
            const msg = 'autoopen: storage unavailable';
            this.printError(msg);
            this._settle(false, msg);
            return;
          }
          const cur = (res && Array.isArray(res.lflAutoOpenOrigins)) ? res.lflAutoOpenOrigins : [];
          const next = LFL.registry.toggleAutoOpen(cur, origin);
          try {
            chrome.storage.local.set({ lflAutoOpenOrigins: next.list }, () => {
              if (chrome.runtime.lastError) {
                const msg = 'autoopen: could not save setting';
                this.printError(msg);
                this._settle(false, msg);
                return;
              }
              const msg = next.enabled
                ? `autoopen ON for ${origin} - the terminal now opens by itself when you land here (run "autoopen" again to turn it off)`
                : `autoopen OFF for ${origin}`;
              this.printOk(msg);
              this._auditPush({ action: 'autoopen' }, 'auto', msg);
              this._settle(true, msg);
            });
          } catch (_e) {
            const msg = 'autoopen: storage unavailable';
            this.printError(msg);
            this._settle(false, msg);
          }
        });
      } catch (_e) {
        const msg = 'autoopen: storage unavailable';
        this.printError(msg);
        this._settle(false, msg);
      }
    }

    // Called once at the tail of _restoreTerminalState() (fresh content-script
    // injection). Opens the overlay automatically iff (a) it isn't already open
    // - the per-tab TS_OPEN restore above may have reopened it, or the human
    // may have; (b) this origin is on the opt-in list; and (c) this tab+origin
    // session hasn't already auto-opened once. The (c) latch lives in the
    // page's sessionStorage (per tab, per origin, cleared when the tab closes),
    // so a human who CLOSES the auto-opened overlay is not fought on every
    // subsequent same-origin navigation - it re-arms only in a new tab/session.
    // Failure of any step is silent and simply means "don't auto-open", the
    // safe default direction for a convenience feature.
    async _maybeAutoOpenHome() {
      if (this.isOpen()) return;
      const origin = this._currentAutoOpenOrigin();
      if (!origin) return;
      try {
        if (sessionStorage.getItem('lflAutoOpened') === '1') return;
      } catch (_e) { /* sessionStorage blocked - proceed without the once-per-session latch */ }
      let list = [];
      try {
        list = await new Promise((resolve) => {
          chrome.storage.local.get(['lflAutoOpenOrigins'], (res) => {
            if (chrome.runtime.lastError) return resolve([]);
            resolve((res && Array.isArray(res.lflAutoOpenOrigins)) ? res.lflAutoOpenOrigins : []);
          });
        });
      } catch (_e) { return; }
      if (!LFL.registry.autoOpenMatch(origin, list)) return;
      try { sessionStorage.setItem('lflAutoOpened', '1'); } catch (_e) { /* best-effort latch */ }
      this.open();
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
        // Popover redesign (2026-07-15): exposes placement state the same
        // way as everything else here - so a test can verify anchor mode/
        // pin state without piercing the closed shadow root (see class
        // header comment on why the panel/pin-button internals are
        // otherwise invisible to page-context JS).
        anchorMode: this._anchorMode,
        pinned: this._pinned,
        middleClickOpen: this._middleClickOpen,
        middleClickModifier: this._middleClickModifier,
      };
      this.host.setAttribute('data-lfl-state', JSON.stringify(payload));
    }
  }

  window.LFL.terminal = new Terminal();
})();
