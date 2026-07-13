/**
 * terminal.js — the overlay UI and the human approval gate. This is the core of
 * the product: proposals from the local model are rendered deterministically
 * from the raw action JSON (never model-generated prose) and require an
 * explicit Enter/click-Approve to execute; Esc/click-Reject always rejects.
 * click/fill/select/navigate are gated; answer/extract/scroll/abort are
 * read-only and auto-run.
 *
 * Rate-limit state (M2.3) is NOT owned by this class as of 2026-07-12 — it
 * used to be a local `LFL.rateLimiter.createRateLimiter()` instance, which
 * meant the counters and the paused latch were destroyed and reset every
 * time this class was re-constructed (top-frame navigation, reload — the
 * content script re-injects and runs `new Terminal()` from scratch). That
 * defeated the control. The AUTHORITATIVE state now lives in the background
 * service worker, keyed by tab id and backed by chrome.storage.session (see
 * background/service-worker.js's header comment and docs/threat-model.md
 * item #7); this class only holds a short-lived CACHE of the last budget
 * snapshot it was told (`_rlBudgetCache`, for synchronous titlebar
 * rendering) and talks to the SW via the `_rl*` async helper methods below.
 *
 * Rendered inside a CLOSED shadow root appended to documentElement (limits
 * page CSS/JS interference), AND — M2.1 — the host element carries
 * `popover="manual"` and is shown/hidden via showPopover()/hidePopover(),
 * promoting the whole overlay (terminal panel + approval card, since the
 * card is a descendant of the popover host) into the browser TOP LAYER.
 * Page z-index/position tricks cannot occlude or reposition top-layer
 * content — this is the documented fix for DOM-based extension clickjacking
 * (defeated 11 password managers in 2025, see docs/threat-model.md).
 *
 * Top-layer positioning alone does not fully close the loop, though: two
 * top-layer elements still have a paint/stacking order between themselves,
 * so a hostile page that ALSO reaches the top layer (e.g. its own
 * `popover`/`<dialog>`) could in principle race to render above ours. That
 * is exactly why _probeApprovalOcclusion() re-checks, immediately before
 * executing an APPROVED mutating action, that the approve control was
 * genuinely the topmost, un-occluded element at click time — occlusion
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

  // Kept in sync with content/terminal.css — see the TODO note there.
  const CSS_TEXT = `
:host{all:initial;position:fixed;inset:auto 0 0 0;margin:0;padding:0;border:none;width:auto;height:auto;background:transparent;color:inherit;overflow:visible;z-index:2147483647;display:block;}
.lfl-panel{display:none;flex-direction:column;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.45;color:#dbe4f0;background:#0b0e14;border-top:2px solid #e0a339;box-shadow:0 -8px 24px rgba(0,0,0,.55);max-height:46vh;}
.lfl-panel.lfl-open{display:flex;}
.lfl-titlebar{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:4px 10px;background:#151a24;border-bottom:1px solid #2a3140;color:#8fa3c0;font-size:11px;letter-spacing:.04em;text-transform:uppercase;}
.lfl-titlebar .lfl-badge{color:#e0a339;}
.lfl-titlebar .lfl-budget{margin-left:auto;color:#5d7290;letter-spacing:normal;text-transform:none;font-size:10px;}
.lfl-output{flex:1;overflow-y:auto;padding:8px 10px;white-space:pre-wrap;word-break:break-word;}
.lfl-line{margin:0 0 4px 0;}
.lfl-line.lfl-cmd{color:#8fd0ff;}
.lfl-line.lfl-cmd::before{content:'lfl> ';color:#e0a339;}
.lfl-line.lfl-info{color:#9fb0c3;}
.lfl-line.lfl-error{color:#ff6b6b;}
.lfl-line.lfl-ok{color:#7ee787;}
.lfl-proposal{margin:0 10px 8px 10px;padding:8px 10px;border:1px solid #e0a339;background:#1a1408;color:#f2d9a8;}
.lfl-proposal[hidden]{display:none;}
.lfl-proposal .lfl-gloss{color:#f5a623;font-weight:600;}
.lfl-proposal .lfl-detail{color:#c9b28a;font-size:12px;margin-top:4px;white-space:pre-wrap;}
.lfl-proposal .lfl-hint{color:#8fa3c0;font-size:11px;margin-top:6px;}
.lfl-approval-actions{display:flex;gap:8px;margin-top:8px;}
.lfl-approve-btn,.lfl-reject-btn{font:inherit;font-size:12px;padding:4px 12px;border-radius:2px;cursor:pointer;}
.lfl-approve-btn{background:#1c3a1c;border:1px solid #7ee787;color:#7ee787;}
.lfl-approve-btn:focus{outline:2px solid #7ee787;outline-offset:2px;}
.lfl-reject-btn{background:#3a1c1c;border:1px solid #ff6b6b;color:#ff6b6b;}
.lfl-reject-btn:focus{outline:2px solid #ff6b6b;outline-offset:2px;}
.lfl-inputrow{display:flex;align-items:center;padding:6px 10px;border-top:1px solid #2a3140;background:#0e131c;}
.lfl-prompt{color:#e0a339;margin-right:6px;}
.lfl-input{flex:1;background:transparent;border:none;outline:none;color:#dbe4f0;font:inherit;}
.lfl-input::placeholder{color:#4b5768;}
.lfl-input[readonly]{color:#4b5768;}
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
        pendingNav: null, // M3: {url, origin, modelResolved} — see _handleGo/_confirmOrNavigate
        history: [],
        historyIdx: -1,
        // M4a: the `ls`-built index->element listing context ({entries, map,
        // notes}, EXACTLY axtree.build()'s own return shape — see
        // engine.js's doLs()) and the active `find` match state
        // ({query, matches, idx}). Both are page-scoped, human-visible-only
        // memory: never persisted (no TS_* key), never sent to either LLM
        // lane's payload, and cleared by `clear` (engine.js's clear branch)
        // in addition to dying naturally with this whole `state` object on
        // the next navigation's fresh content-script injection.
        listingContext: null,
        findContext: null,
        // M4a: a live mirror of this._rlBudgetCache (see below) so
        // engine.js's `here` handler — which only receives `state`, not this
        // Terminal instance — can render the already-cached rate-limit
        // budget synchronously, without needing terminal.js's separate
        // chrome.*-capable async dispatch path the way go/alias/macro/dev/
        // origins need. Kept in sync everywhere _rlBudgetCache is assigned.
        rlBudgetCache: null,
      };
      // M3: the alias/macro store (registry.js) — chrome.storage.local
      // backed, loaded async below. The ONLY writers of it are
      // _handleAliasCommand/_handleMacroCommand (typed `alias`/`macro`
      // commands) — see registry.js's header comment for the write-path
      // lock this is built around.
      this._aliasStore = LFL.registry.createAliasStore(
        (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null,
      );
      this._aliasStore.load();
      // M3 H2 (design doc §8): the data-lfl-state test hook is OFF by
      // default — see _updateTestHook()'s own comment. Loaded async from
      // storage.local `lflDevHooks`; stays false (hidden) until that
      // resolves, which is the safe default direction to fail in.
      this._devHooksEnabled = false;
      this._loadDevHooksFlag();
      this.elementMap = new Map();
      this._lastCommand = '';
      // Monotonic counter bumped at every "settle" point (deterministic result
      // printed, proposal rendered awaiting approval, LLM error surfaced, or
      // approve/reject resolved, or an async nav-watch/rate-limit event) —
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
      // and background/service-worker.js) — this is only a cache of the
      // last real snapshot the service worker returned, for synchronous
      // titlebar rendering between async round trips. Seeded with
      // optimistic (full-budget, not-paused) placeholder numbers from
      // LFL.rateLimiter.DEFAULTS until the first real fetch resolves
      // (_refreshRateLimitBudget(), kicked off below) — if this tab was
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
      this.state.rlBudgetCache = this._rlBudgetCache; // M4a — see state's own comment above
      // Reentrancy guard for _approveProposal()'s async SW round trip — see
      // that method for why.
      this._approvalBusy = false;
      this._buildDom();
      this._wireEvents();
      this._loadHistory();
      this._updateTestHook();
      // Fire-and-forget: pulls the SW-authoritative numbers as soon as
      // possible after (re)injection — this is what makes a just-reloaded
      // page's titlebar honestly reflect a pre-existing pause/partial budget
      // instead of the optimistic placeholder above.
      this._refreshRateLimitBudget();
      // M3 (design doc §4): restore scrollback (display-only), auto-reopen
      // if this tab's terminal was open before the last navigation, and
      // continue any in-flight `&&` chain (arrival check first) — all via
      // the SW-authoritative per-tab TS_* state. Fire-and-forget; nothing
      // here blocks the terminal being usable immediately.
      this._restoreTerminalState();
    }

    // ---- M3 terminal-state (TS_*) SW messaging ----
    //
    // Mirrors _rlSend()'s shape but without the rate-limiter's fail-closed
    // "block the action" posture — none of TS_* gates a mutation by itself
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
      } catch (_e) { /* storage unavailable — stays off, the safe default */ }
    }

    async _restoreTerminalState() {
      // Scrollback restore — display-only, rendered via the DOM-only helper
      // (never re-persisted, never re-executed, never fed into either LLM
      // lane's payload — see buildNavLanePayload()'s/buildPayload()'s own
      // comments in service-worker.js for why there is nothing here to
      // wire in even if a future edit wanted to).
      const sb = await this._tsSend('TS_SCROLLBACK_GET');
      if (sb.ok && Array.isArray(sb.scrollback) && sb.scrollback.length > 0) {
        this._appendLineDom('— restored scrollback from before navigation —', 'info');
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
    // extension context invalidated, etc.) — same posture as the M2.1
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
        const reason = (resp && resp.error) || 'rate-limit check unavailable (service worker unreachable) — blocked for safety';
        return { ok: false, allowed: false, paused: true, reason, resumed: false, recorded: false, budget: this._rlBudgetCache };
      }
      if (resp.budget) {
        this._rlBudgetCache = resp.budget;
        this.state.rlBudgetCache = resp.budget; // M4a — keep `here`'s synchronous view in sync
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
      // means WE control show/hide (open()/hidePopover() below) — no
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
        if (!LFL.guards.isTrustedInputEvent(e)) return; // M3 H1 — see guards.js
        this._approvePending();
      });
      this.rejectBtn = document.createElement('button');
      this.rejectBtn.type = 'button';
      this.rejectBtn.className = 'lfl-reject-btn';
      this.rejectBtn.textContent = 'Reject (Esc)';
      this.rejectBtn.addEventListener('click', (e) => {
        if (!LFL.guards.isTrustedInputEvent(e)) return; // M3 H1 — see guards.js
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
      this.inputEl.placeholder = 'type a command — try "help"';
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
    }

    // M3 H1 (design doc §8): every input handler ignores non-isTrusted
    // events outright — a page can dispatch synthetic KeyboardEvent/
    // MouseEvent objects at our host element (it's in the light DOM,
    // retargeted from inside the closed shadow root) or its own listeners,
    // and "terminal input = trusted because a human typed it" only holds if
    // every one of these handlers actually checks that. See guards.js's
    // isTrustedInputEvent() for the pure predicate this calls (unit-tested
    // directly; the DOM wiring itself needs a real event object to exercise
    // — see tests/m3_hardening.test.js for what is and isn't covered here).
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
            // cycles between our own Approve/Reject controls — focus can
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
        try { this.host.showPopover(); } catch (_e) { /* already open — ignore */ }
      }
      this.panel.classList.add('lfl-open');
      this.inputEl.focus();
      this._updateTestHook();
      // Refresh the SW-authoritative budget every time the overlay is
      // (re)opened, not just at construction — cheap, and keeps the
      // titlebar honest if a lot of async time passed since the last fetch.
      this._refreshRateLimitBudget();
      // M3: persist open state per tab so a later re-injection (navigation)
      // auto-reopens — see _restoreTerminalState(). Fire-and-forget.
      this._tsSend('TS_OPEN_SET', { open: true });
    }

    close() {
      if (this.state.mode === 'awaiting-approval') {
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
        try { this.host.hidePopover(); } catch (_e) { /* already closed — ignore */ }
      }
      this._updateTestHook();
      this._tsSend('TS_OPEN_SET', { open: false });
    }

    toggle() {
      if (this.isOpen()) this.close();
      else this.open();
    }

    // ---- output helpers ----

    // DOM-only append — used both by _appendLine() (new output, which also
    // persists to the SW-backed scrollback) and by _restoreTerminalState()
    // (rendering PREVIOUSLY-persisted lines, which must not be re-persisted
    // — that would just re-append the same lines to their own backing store
    // on every navigation). H3 (design doc §8): text is always assigned via
    // .textContent, never innerHTML/eval — a restored scrollback line (or
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

    // M3: persists the last ~100 lines per tab (design §4) — fire-and-forget,
    // display-only. Never read back into any LLM prompt (see
    // buildPayload()/buildNavLanePayload() in service-worker.js — neither
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
    // flow — e.g. nav-watch.js's onBlocked/onDetectedOnly callbacks, which
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
      } catch (_e) { /* storage unavailable — history just won't persist across pages */ }
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
    // Esc clears the whole queue" (plan §13 item 2) — this is the single
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
      // Arrival check (design §5) — fail closed: an origin mismatch (e.g. a
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
      await this._dispatchSegment(popped.next);
    }

    _submitCommand(rawInput) {
      const raw = rawInput.trim();
      if (!raw) return;
      this._pushHistory(raw);
      this._lastCommand = raw;
      this.printCmdEcho(raw);

      // M2.3: "continue" and "budget" are rate-limiter controls, handled
      // here (not engine.js) because they resolve against the SW-
      // authoritative limiter for this tab — everything else about the
      // deterministic/LLM dispatch split is unchanged. Both are now async
      // (a message round trip to the service worker), unlike the old local-
      // instance version — see class header comment. Neither participates
      // in `&&` chaining (a rate-limit control makes no sense as a chain
      // step) — handled before any chain-splitting is even attempted.
      if (/^continue$/i.test(raw)) {
        this._rlResume().then((res) => {
          const msg = res.resumed ? 'resuming — rate-limit pause cleared' : 'nothing paused to continue';
          this.printInfo(msg);
          this._auditPush({ action: 'continue' }, 'auto', msg);
          this._settle(true, msg);
        });
        return;
      }
      if (/^budget$/i.test(raw)) {
        this._rlSend('RL_BUDGET').then((resp) => {
          const b = resp.budget;
          const msg = `LLM calls: ${b.llmRemaining}/${b.llmMax} remaining this window. Executed actions: ${b.actionRemaining}/${b.actionMax} remaining this window.${b.paused ? ' PAUSED — type "continue" to resume.' : ''}`;
          this.printInfo(msg);
          this._settle(true, msg);
        });
        return;
      }
      // M3 Terminal-level commands (design §6/§8) — need chrome.* / async
      // access engine.js's synchronous tryDeterministic() contract doesn't
      // have, so (like continue/budget above) they're dispatched here
      // rather than through the registry, and (like continue/budget) don't
      // participate in `&&` chaining — each is a standalone control command,
      // not a page-driving verb.
      if (/^dev\s+(on|off)$/i.test(raw)) { this._handleDevCommand(raw); return; }
      if (/^origins$/i.test(raw)) { this._handleOrigins(); return; }
      if (/^alias(\s|$)/i.test(raw)) { this._handleAliasCommand(raw); return; }
      if (/^unalias\s+\S+$/i.test(raw)) { this._handleUnaliasCommand(raw); return; }
      if (/^macro(\s|$)/i.test(raw)) { this._handleMacroCommand(raw); return; }
      if (/^unmacro\s+\S+$/i.test(raw)) { this._handleUnmacroCommand(raw); return; }

      this._runChain(raw);
    }

    // M3 (design §5/§6): expand a macro (depth-1, whole-input only), split
    // on top-level `&&` (quote-aware, cap 5), queue everything past the
    // first segment, then dispatch the first segment through the same path
    // every subsequent (queued) segment uses.
    async _runChain(raw) {
      const macroExpanded = LFL.registry.expandMacro(raw, this._aliasStore);
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
      if (segments.length > 1) {
        await this._tsSend('TS_QUEUE_SET', {
          queue: segments.slice(1),
          expectedOrigin: typeof location !== 'undefined' ? location.origin : null,
        });
      } else {
        // A lone (non-chain) command abandons any stale queue left over from
        // an earlier interrupted chain — typing something new is itself a
        // decision not to continue waiting on the old one.
        await this._tsSend('TS_QUEUE_CLEAR');
      }
      await this._dispatchSegment(segments[0]);
    }

    // The single per-segment dispatch path — used for both the first
    // segment of a freshly-submitted chain and every segment popped off the
    // SW-backed queue later (possibly after a navigation and a fresh
    // content-script injection). Alias-resolves the segment's leading word,
    // then routes to `go` (§2's ladder), the deterministic engine registry,
    // or (unchanged) the page-lane LLM.
    async _dispatchSegment(segment) {
      const resolved = LFL.registry.expandAlias(segment, this._aliasStore);
      const firstTok = (resolved.trim().split(/\s+/)[0] || '').toLowerCase();

      if (firstTok === 'go') {
        await this._handleGo(resolved);
        return;
      }

      const det = LFL.engine.tryDeterministic(resolved, this.state);
      if (det !== null) {
        if (det.clear) this.clearOutput();
        this.printInfo(det.output);
        this._auditPush({ action: 'deterministic' }, 'auto', det.output ? det.output.slice(0, 160) : '');
        this._settle(true, det.output || '');
        // FIX 1 (security verify LOW-1): `back`/same-origin `open`/`open!`/
        // auto-submitting `search` all INITIATE a navigation from inside
        // tryDeterministic() (engine.js tags the result `navInitiated: true`
        // on exactly those branches — see engine.js's own comments). Because
        // location.href/history.back()/form.submit() do not unload the
        // document synchronously, calling the ordinary _afterSettle(true) ->
        // _advanceQueue() here would run the NEXT queued segment against the
        // OLD, about-to-unload document — defeating design §5's "run where
        // you arrive" semantics (confirmed non-exploitable for cross-origin
        // execution, since the queue only ever holds typed text either way,
        // but still the wrong document). Skip the synchronous advance
        // entirely for these results — no _afterSettle call at all, so the
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

      // M4a — did-you-mean (tool 3, design note in engine.js's header):
      // NOT an "ask ..." (that's the unambiguous, explicit model path) and
      // NOT a bare number (engine.js's tryDeterministic() above always
      // returns non-null for one — an action or a gentle "no listing"
      // error — so det would never have been null in the first place; this
      // second check is defense in depth for this function's own contract,
      // not a case that can actually be reached via a bare-number input
      // today). Deliberately narrows the model surface, never widens it —
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
          const msg = `unknown command "${token}" — did you mean: ${suggestion}? (or prefix with "ask" to send to the local model)`;
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

    _handleDevCommand(raw) {
      const on = /\bon$/i.test(raw.trim());
      this._devHooksEnabled = on;
      try { chrome.storage.local.set({ lflDevHooks: on }); } catch (_e) { /* best-effort */ }
      const msg = `dev hooks ${on ? 'ENABLED' : 'disabled'} (data-lfl-state test attribute) — see docs/threat-model.md H2`;
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

    // ---- M3 `go` — the navigation verb (design §2/§3) ----

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
      // _runLlm() below) — both lanes are gated/recorded identically, only
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
        // contains ONLY `command` (the user's typed segment text) — no
        // element list, no title, no origin, no scrollback. See
        // service-worker.js's buildNavLanePayload() and
        // tests/m3_nav_lane_isolation.test.js for the proof.
        resp = await chrome.runtime.sendMessage({ type: 'NAV_LLM_REQUEST', command: resolvedSegment });
      } catch (e) {
        resp = { ok: false, error: 'local model offline — deterministic commands still work (' + (e && e.message ? e.message : 'messaging error') + ')' };
      }
      if (!resp || !resp.ok) {
        const errMsg = (resp && resp.error) || 'local model offline — deterministic commands still work';
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
      // 1/2 (http(s)-only, must look like a real destination) — the nav-lane
      // isolation removes page-injection risk, it does not exempt the
      // model's own output from the scheme floor everything else in this
      // extension is held to.
      const check = LFL.nav.resolveLiteralDestination(navAction.value || '');
      if (!check.ok) {
        const msg = `go: model proposed an unusable destination — ${check.reason}`;
        this.printError(msg);
        this._auditPush({ action: 'go-nav-lane-invalid' }, 'blocked', msg);
        this._settle(false, msg);
        this._afterSettle(false);
        return;
      }

      await this._confirmOrNavigate(check.url, { modelResolved: true });
    }

    // First-visit-per-origin (or, always, model-resolved) confirmation —
    // design §2's friction tiers. Reuses the SAME approval-card DOM
    // (glossEl/detailEl/approveBtn/rejectBtn) the LLM-action proposal uses,
    // labeled NAVIGATION, gated by the parallel `awaiting-nav-confirm` mode
    // rather than overloading `state.pendingProposal` (which stays an LLM
    // action object shape — see _normalizeAction()/executor.execute()).
    async _confirmOrNavigate(url, opts) {
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
        ? `origin=${originStr}  (model-resolved destination — read it before approving)`
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
      // the REAL destination right before actually navigating — this is
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
        // (M2.1) — a navigation confirm is approval-gated for exactly the
        // same clickjacking-style reason a click/fill/select/navigate
        // proposal is.
        const occlusion = this._probeApprovalOcclusion();
        if (occlusion.occluded) {
          this.proposalEl.hidden = true;
          this.inputEl.readOnly = false;
          this.inputEl.focus(); // FIX 3: restore typing focus — mirrors _rejectNav()/_rejectProposal()
          this.state.mode = 'idle';
          const msg = `approval UI was covered — navigation cancelled for safety (${occlusion.reason})`;
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
      // isTrusted-checked reject-button click listener — see H1), so no
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
      // M2.3: LLM-call budget gate. Deterministic, never model-controlled —
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
        resp = { ok: false, error: 'local model offline — deterministic commands still work (' + (e && e.message ? e.message : 'messaging error') + ')' };
      }
      const latencyMs = Math.round(performance.now() - t0);

      if (!resp || !resp.ok) {
        const errMsg = (resp && resp.error) || 'local model offline — deterministic commands still work';
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
    // area, or svg-a) — built from the LIVE element via guards.js, never
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
      const rel = nav.blocked ? `${nav.classification} — WILL BE BLOCKED` : 'same-origin';
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
      this._seq++; // proposal rendered — this is the "submit -> proposal render" settle point
      this._updateTestHook();
      // M2.1: move focus onto our own extension-owned Approve control — out
      // of any page element's reach — and keep it trapped there (see
      // _onGlobalKeydown's Tab handling) until the proposal resolves.
      if (this.approveBtn) this.approveBtn.focus();
    }

    // M2.1: execution-time occlusion re-check. Samples what's actually
    // topmost at the approve control's on-screen center point RIGHT NOW —
    // immediately before executing an approved mutating action — and aborts
    // if it isn't genuinely our own control. See guards.js
    // classifyOcclusionProbe() for the pure decision logic this wraps.
    _probeApprovalOcclusion() {
      if (!this.approveBtn) return { occluded: true, reason: 'no approval control to check' };
      if (typeof document.elementsFromPoint !== 'function') {
        // Given this project's Chrome >=144 floor, elementsFromPoint has
        // been available for years — this is a documented, extremely
        // unlikely residual, not an expected runtime path. Fail CLOSED: an
        // occlusion check that cannot run is not evidence of no occlusion.
        return { occluded: true, reason: 'occlusion-check API (elementsFromPoint) unavailable in this browser — aborting rather than assuming safety' };
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
      // (reveal page content, or a competing overlay, underneath) — proving
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
        return { occluded: true, reason: 'pointer-events probe was inconclusive — excluding the overlay from hit-testing did not change the topmost result' };
      }

      return { occluded: false, reason: null };
    }

    // Async now (M2.3 rate-limit check is a message round trip to the
    // service worker — see class header comment). This introduces a real
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
        // synchronous, run at the exact instant Approve was pressed — same
        // zero-added-latency timing this check has always had. Ordered
        // ahead of the (now-async) M2.3 rate-limit check deliberately: the
        // occlusion probe's adversarial fixture
        // (tests/fixtures/occlusion-attack.html) races a page-owned overlay
        // against the moment a human approves, on a real wall-clock timer —
        // inserting an awaited SW round trip BEFORE this probe would push
        // that moment later by a variable amount for no security benefit
        // (both checks must pass before execution either way; which one is
        // evaluated first doesn't change what gets blocked). Not a warning —
        // a detected occlusion cancels the action outright.
        const occlusion = this._probeApprovalOcclusion();
        if (occlusion.occluded) {
          this.proposalEl.hidden = true;
          this.inputEl.readOnly = false;
          this.inputEl.focus(); // FIX 3: restore typing focus — mirrors _rejectProposal()
          this.state.mode = 'idle';
          const msg = `approval UI was covered — action cancelled for safety (${occlusion.reason})`;
          this.printError(msg);
          this._auditPush(action, 'aborted(occluded)', msg);
          this.state.pendingProposal = null;
          this._settle(false, msg);
          this._afterSettle(false);
          return;
        }

        // M2.3: rate-limit gate on EXECUTED mutating actions, checked
        // against the SW-authoritative limiter — still runs before
        // execution, as required; just after the occlusion probe rather
        // than before it (see above).
        const budgetCheck = await this._rlCheck('action');
        if (this.state.pendingProposal !== action) return; // resolved by Reject/close while awaiting
        if (!budgetCheck.allowed) {
          this.proposalEl.hidden = true;
          this.inputEl.readOnly = false;
          this.inputEl.focus(); // FIX 3: restore typing focus — mirrors _rejectProposal()
          this.state.mode = 'idle';
          this.printError(budgetCheck.reason);
          this._auditPush(action, 'blocked(rate-limit)', budgetCheck.reason);
          this.state.pendingProposal = null;
          this._settle(false, budgetCheck.reason);
          this._afterSettle(false);
          return;
        }

        // Only actually-executed mutations count against the action budget
        // (unchanged posture from the pre-M2.3-SW-move design) — record
        // AFTER both the occlusion check and the budget check pass.
        await this._rlRecord('action');
        if (this.state.pendingProposal !== action) return; // resolved by Reject/close while awaiting

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
      // input — without this the human has to click back into the field to
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
      // (_rlBudgetCache), never locally computed — see class header comment.
      // It is refreshed opportunistically (construction, open(), and every
      // RL_* response) rather than on every call to this method, since this
      // method itself must stay synchronous (called from many sync code
      // paths) and a real fetch is async.
      const budget = this._rlBudgetCache;
      this.budgetEl.textContent = `llm ${budget.llmRemaining}/${budget.llmMax} · actions ${budget.actionRemaining}/${budget.actionMax}${budget.paused ? ' · PAUSED' : ''}`;

      // M3 H2 (design doc §8): this attribute exposes pending-proposal
      // contents, budgets, and mode to PAGE JAVASCRIPT on every page (it's a
      // plain DOM attribute on an element that lives in the light DOM — a
      // page's own `MutationObserver`/`getAttribute` can read it same as
      // any other attribute; the closed shadow root only hides the OVERLAY
      // CONTENTS, not this host-level attribute). Fine for a private spike;
      // wrong default for a public product (a page could observe/time the
      // approval flow, or read what command the human just typed). Emitted
      // ONLY when the `dev` command has turned it on this session
      // (storage.local `lflDevHooks`, off by default — see
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
