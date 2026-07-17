# lfl-terminal threat model - M1 seed, M2 hardening applied, M3 command browser, M4a friction trio

This is the seed threat model for the M1 feasibility spike: the 13 design
requirements the product is built against, honest implementation status for
each, and the residual risks that follow from what's still open.

**2026-07-12 M1 fix round:** two independent security reviews plus a GPU gate
battery found a critical gap (the `click` action had no scheme/origin guard
at all, unlike `navigate`), a related honesty problem (a README/threat-model
claim about a unit test that did not exist), and several smaller gaps. All
were fixed in a consolidated round and re-verified. See `README.md`'s
"2026-07-12 security fix round" section for those verification numbers.

**2026-07-12 M2 security-hardening round (plan §13):** implements M2.1
top-layer approval UI + execution-time occlusion re-check, M2.2 runtime
navigation interception, M2.3 rate limits/action budget, and M2.4 iframe/
shadow-DOM aware extraction. Same standard as the M1 fix round applies:
nothing below is marked DONE without an actual passing verification result
behind it - see README.md's "2026-07-12 M2 security hardening" section for
the run output (unit counts, egress, adversarial-test proof, battery
numbers).

**2026-07-12 M3 build (persistent command browser, design doc
`AI-BROWSER-TERMINAL-M3-DESIGN.md`):** `go`/aliases/macros/`&&` chains/
scrollback+open-state persistence and a SECOND, narrower LLM lane (nav-lane)
used only by `go`'s NL fallback. See the "M3 - persistent command browser"
section near the end of this file for the full trust-split writeup, the
nav-lane isolation rationale, queue/alias/typosquat residuals, and the H1/H2
hardening notes. Unit-verified (Node, `tests/m3_*.test.js`, 139 assertions
total across all seven suites including the pre-existing M1/M2 ones - see
README.md for the exact per-file counts); the Playwright battery proof of
the live browser flows is a separate, subsequent verification pass, not
part of this build.

**2026-07-13 M4a build ("friction trio"):** three more deterministic,
never-call-the-model tools - `ls`/numbered actions (`open <N>`/`click <N>`/
`fill <N> with ...`/`fill <label> with ...`/bare `<N>`), `read`/`find`, and
`here` + a "did you mean" typo interceptor. Registry/deterministic-layer
work only - no model-vocabulary change, no manifest change, no new
permission, no guard relaxation, no service-worker protocol change. See the
"M4a - friction trio" section near the end of this file for the full
writeup. Unit-verified (Node, `tests/m4_friction.test.js`, 61 assertions
against the real, unmodified `engine.js`/`executor.js`/`guards.js`/
`registry.js` loaded via `vm`); all seven pre-existing suites re-verified
passing byte-for-byte unchanged (211 assertions total across all eight
suites - see README.md for the exact per-file counts).

## The 13 design requirements

1. **UI isolation.** The overlay must be rendered in a boundary resistant to
   page CSS/JS interference and clickjacking-style occlusion tricks.
   **M2.1: DONE.** The closed-shadow-root architecture from M1 is unchanged
   (still stops page stylesheets bleeding in, still hides overlay internals
   from `el.shadowRoot` introspection), but the host element
   (`#lfl-terminal-host`) now also carries `popover="manual"` and is shown/
   hidden via `showPopover()`/`hidePopover()` (`extension/content/
   terminal.js`) - this promotes the WHOLE overlay (terminal panel AND the
   approval card, both descendants of the popover host) into the browser
   **top layer**, so ordinary page CSS/z-index/position tricks structurally
   cannot render over or reposition it. The approval card additionally gets
   an explicit focus trap (Tab cycles only between its own Approve/Reject
   buttons - see `_onGlobalKeydown`'s `awaiting-approval` branch) so
   keyboard focus can never land on a page element while a proposal is
   pending.
   **Honest scope limit:** top-layer positioning bounds page CSS, but two
   top-layer elements still have a paint/stacking order *between themselves*
   - a page that ALSO reaches the top layer (its own `popover`/`<dialog>`)
   could in principle race to render above ours. That is exactly why #11
   (execution-time occlusion re-check) exists as an independent backstop,
   not a redundant belt-and-suspenders check - see
   `tests/fixtures/occlusion-attack.html` for the adversarial case this is
   built against, and `tests/m2_adversarial.py` for the live proof it's
   caught. Browsers without Popover API support (documented as extremely
   unlikely given this project's Chrome ≥144 floor - Popover shipped Chrome
   114) fall back to the M1 shadow-root-only posture for positioning, but
   the occlusion re-check (#11) still runs and is what actually protects
   them, by design (see its own fail-closed note).

2. **Local-only inference; zero non-loopback egress.** The extension must
   never send page content, commands, or telemetry anywhere except the local
   model. **M1: DONE.** `extension/background/service-worker.js` is the only
   file allowed to call any network-capable API, enforced by
   `tests/check_no_egress.sh` (static grep gate, part of the verification
   suite). It only ever targets `http://127.0.0.1:1238`, which is also the
   only entry in `host_permissions`. **2026-07-12:** the grep pattern was
   widened from `fetch`/`XMLHttpRequest`/`WebSocket`/`sendBeacon` to also
   catch `EventSource`, `RTCPeerConnection`, `WebTransport`, dynamic
   `import(`, `.src =` assignment, and common fetch-aliasing tricks
   (`= fetch`, `fetch]`) - the original pattern would have missed all of
   those. Re-verified PASS on the current (clean) tree.

3. **Multi-frame/iframe support.** The element indexer and executor should
   work inside iframes, not just the top document. **M2.4: DONE, scoped.**
   `extension/content/axtree.js`'s `build()` now recursively walks
   SAME-ORIGIN iframes (via `iframe.contentDocument`, bounded to
   `MAX_FRAME_DEPTH = 3` nesting levels) and OPEN shadow roots
   (`el.shadowRoot`), so interactive elements inside them are indexed,
   offered to the model, and clickable/fillable exactly like top-document
   elements. The click/fill/select guards (guards.js) are re-run against
   the element's OWN document/window context (`axtree.frameOptsFor(el)` -
   the iframe's own `baseURI`/origin, not the top page's), not just its own
   node identity, per the "re-run the guard in its own document context"
   requirement - see `tests/m2_security.test.js` Part 4 for the unit proof
   that a supplied per-frame origin is actually load-bearing (not silently
   ignored in favor of the ambient top-page origin).
   **HARD RULE, unchanged from the M1 scope note this replaces, now
   actually enforced by code rather than by absence of iframe support at
   all:** CROSS-ORIGIN iframes are never entered - `iframe.contentDocument`
   is `null` for them by the same-origin policy, which the extractor
   detects and turns into an informational-only marker line
   (`(cross-origin iframe present, not inspectable: <origin>)`) appended to
   the element list, never an indexed/actionable entry. CLOSED shadow roots
   are never entered either - `el.shadowRoot` is `null` from outside a
   closed root (including from this extension's own top-frame content
   script, which never attached them), so there is structurally nothing to
   walk into; no special-case "skip" logic was needed because the platform
   already enforces it.
   **Honest scope limit:** the M2.2 runtime navigation watcher (#7 below)
   only observes the TOP-LEVEL browsing context's navigations - a
   same-origin iframe's own onclick handler navigating THAT iframe (not the
   top page) is not covered by it. `all_frames` stays `false` in the
   manifest by design (a single top-frame content script reaches into
   same-origin iframes via direct DOM access instead of injecting a
   separate content-script instance per frame, which would each try to
   build their own terminal overlay).
   **Live-verified beyond the unit tests:** against
   `tests/fixtures/iframe-mixed.html` (a same-origin iframe with a form +
   input, plus a cross-origin iframe), asking the local model to "fill the
   frame search box with hello" correctly indexed the in-iframe `<input>`,
   proposed `fill [1] <input> role=textbox name="frame search box"`, and -
   after approval - the value was actually written into the IFRAME's own
   `contentDocument`'s input (confirmed by reading it directly:
   `contentDocument.getElementById('frame-input').value === 'hello'`), not
   just accepted-and-discarded. This is real cross-document DOM mutation
   working end to end, not just index bookkeeping.

4. **Constrained, fixed action vocabulary.** The model's output must be
   limited to a small fixed set of actions via a schema, with the extension
   defensive against malformed/adversarial output. **M1: PARTIAL.** Ships as
   `response_format: json_schema` with an enum-constrained `action` field -
   verified working against the pinned llama.cpp build. Empirically hardened
   once already: the schema originally required only `action`, and the 4B
   model was observed to sometimes silently omit `element` even when it had
   clearly identified the right target (`{"action":"fill","value":"..."}`
   with no index at all); making `element` required fixed it. Gaps: `select`
   only supports native `<select>` elements (no custom combobox/listbox
   widgets), and there's no retry-on-malformed-JSON - a single bad response
   just surfaces as an error rather than being retried once.

5. **Deterministic engine for common patterns.** Routine navigation/search
   should never need the model. **M1: CRUDE.** Regex-based command parsing;
   `search` uses a fixed heuristic selector list plus a `name`/`id`/
   `placeholder`/`aria-label` substring match; `open` does case-insensitive
   substring/prefix matching against visible link text with no fuzzy
   matching or synonym handling; `extract table` only looks at the first
   `<table>` on the page. English-only phrasing throughout. **2026-07-12:**
   `search`'s auto-submit now checks the target form's resolved `action`
   origin before calling `requestSubmit()`/`submit()` - cross-origin forms
   are filled but not auto-submitted, printed instead (same posture `open`
   already had for cross-origin links; previously `search` had no such
   check at all).

6. **Safe cross-origin confirmation UX.** **Still NOT DONE - M2 did not
   change this.** The deterministic `open` command still has the crude
   `open!` re-type-to-confirm for cross-origin links; the LLM-proposed
   `navigate` action, and `click` when it resolves (statically) to a
   cross-origin target, still don't get a cross-origin confirmation path -
   both remain hard-blocked outright (see #9) rather than offered a
   confirm flow. **What M2.2 DID add is a different, narrower thing:**
   runtime interception of the specific M1 residual where a click's
   destination has NO static target at all (a page onclick handler
   navigating programmatically) - see the new item below. That closes a
   detection/blocking gap; it is not the same as adding a cross-origin
   confirmation UX for the cases that were already statically classified
   and hard-blocked. Same-origin only remains the policy for everything
   this extension will actually follow.

   **M2.2 - runtime navigation interception (new, closes the M1 onclick
   residual).** `extension/content/nav-watch.js` arms a short-lived
   (1500ms) watcher around every extension-executed `click`
   (`extension/content/executor.js`'s click branch), using the Navigation
   API (`window.navigation`, Chrome ≥102 - well within this project's
   Chrome ≥144 floor): its `navigate` event fires for ANY navigation the
   current browsing context initiates, exposing the real destination URL
   via `event.destination.url` BEFORE the navigation commits, with a
   genuinely silent `event.preventDefault()` when `event.cancelable` is
   true. The destination is classified by the pure, unit-tested
   `guards.classifyRuntimeNavigation()` (`tests/m2_security.test.js` Part
   2): same-origin always proceeds; cross-origin/non-http(s) that was NOT
   the destination shown/approved on the card gets blocked. Live-verified
   against `tests/fixtures/onclick-evil-nav.html` (a plain button whose
   onclick does `location.href = <cross-origin>`, exactly the M1 residual)
   via `tests/m2_adversarial.py` - approving the click leaves the tab on
   the original page; it never reaches the cross-origin target.
   **Precise, honest scope - read before treating this as a general
   guarantee:**
   - `beforeunload` is also armed as a fallback, but ONLY as a detect-and-
     log signal, never to `preventDefault()` on its own - that event
     structurally cannot see the destination URL (deliberate browser
     privacy design), so blocking indiscriminately on it would pop the
     native "leave site?" confirmation on every ordinary APPROVED
     navigation too, which would be a UX regression, not a security win.
   - `window.open()` to a new tab, and an `<a target="_blank">` click, are
     **NOT observable at all** by this watcher - `window.navigation`
     belongs to the browsing context it's created in, and a new tab is a
     different one. Seeing it would require the `tabs` or `webNavigation`
     permission, which this project deliberately does NOT request (plan §5
     item 13, minimal permissions) - this residual is accepted and
     documented, not silently swallowed.
   - The watcher only covers the TOP-LEVEL browsing context's own
     navigations. A same-origin iframe's own onclick navigating THAT
     iframe (not the top document) is outside this watcher's scope - see
     the iframe honest-limit note under #3 above.
   - Only armed around `click`, per the task spec ("and only then - not
     user-initiated page clicks") - `fill`/`select`/`navigate` don't get
     this treatment; `navigate` is already fully statically classified
     before it ever runs, so there's no ambiguity to watch for.
   - **The 1500ms watch window itself is a real, exploitable escape,
     disclosed here 2026-07-12 in response to an independent M2 verify.**
     The watcher's `dispose()` unarms both listeners (Navigation API and the
     `beforeunload` fallback) `windowMs` after the click, via a plain
     `setTimeout`. A page whose click handler DEFERS the actual navigation
     past that window - e.g. `el.addEventListener('click', () => {
     setTimeout(() => { location.href = 'https://evil.example'; }, 1600); })`
     - navigates completely unobserved: by the time the `navigate` event
     would fire, this extension's listener has already been torn down.
     This is not a corner case; it is trivial for any page to construct on
     purpose specifically to defeat this control, and previously went
     undisclosed alongside the window.open/new-tab/cross-origin-frame/
     beforeunload residuals below. **A `<meta http-equiv="refresh"
     content="0;url=https://evil.example">` tag is a second, independent
     escape of the same shape** - a meta-refresh navigation is scheduled by
     the page's markup, not by any click handler this extension observed at
     all, so it is never inside the watch window in the first place (a page
     could inject such a tag from an onclick handler timed to fire after an
     approved click, or have one present from load and simply wait out
     whatever `windowMs` happens to be). Both are BLIND SPOTS of the
     `nav-watch.js` mechanism, not merely "detected but unblockable" like
     `beforeunload` above - no event fires for either case within the armed
     window, so there is nothing to classify or log; the click simply
     resolves and the tab silently ends up elsewhere sometime later. Not
     hardened as of this pass (see the "Still not done" note this item's
     entry now carries) - disclosed here in the interest of the standing
     "no `DONE`/`verified` claim ships without an accompanying honest
     residual" rule this project holds itself to (see the 2026-07-12
     honesty-correction note near the end of this file).

7. **Resource/DoS limits on LLM calls.** **M2.3: DONE, made genuinely
   per-tab-session-persistent 2026-07-12 (independent M2 verify finding -
   see below).** `extension/content/ratelimit.js` implements the
   deterministic (never model-controlled), time-injectable rolling-window
   algorithm: `LFL.rateLimiter.DEFAULTS` caps LLM proposal calls at 20 per
   rolling 60s window and EXECUTED (approved) mutating actions at 10 per
   rolling 60s window. Exceeding EITHER budget latches the limiter into a
   "paused" state (not a silent per-window reset) that blocks every
   subsequent call/action until the human types `continue` - a
   burst-then-immediately-auto-resume design would not meaningfully differ
   from no limit at all. Read-only auto-run actions (`extract`/`answer`/
   `scroll`/`abort`) are not rate-limited, only actually-executed mutations
   count against the action budget.
   **2026-07-12 fix - WHERE this state lives, not just the algorithm:** an
   independent M2 verify found that the counters and the paused latch
   previously lived only inside the per-page `Terminal` instance
   (`extension/content/terminal.js`), which is destroyed and rebuilt from
   scratch on every top-frame navigation or `location.reload()` (the
   content script re-injects). That silently reset the budget to full AND
   cleared an active pause with no `continue` ever typed - a page (or the
   human) could trivially defeat the whole control just by reloading. The
   AUTHORITATIVE state now lives in `extension/background/service-worker.js`
   (which is not destroyed by page navigation), keyed per TAB id, backed by
   `chrome.storage.session` - cleared on `chrome.tabs.onRemoved` (tab close)
   and never written to disk, matching the earlier "session" framing but now
   actually true: the budget and the pause latch persist across navigation
   and reload WITHIN the browser session, per tab, for as long as that tab
   stays open, and are gone when the tab (or the browser) closes. The
   content script talks to this authority over four message types
   (`RL_CHECK`/`RL_RECORD`/`RL_RESUME`/`RL_BUDGET`, see
   `background/service-worker.js`'s header comment) rather than holding its
   own live limiter instance; the decision ALGORITHM is not duplicated
   between the two - the service worker `importScripts()`s the same,
   unmodified `content/ratelimit.js` a classic (non-module) service worker
   can load that way, so there is exactly one copy of the rolling-window/
   latch logic, not a content-script copy and a service-worker copy that
   could silently drift apart. `canCallLlm()`/`recordLlmCall()` are called
   (via `RL_CHECK`/`RL_RECORD`) in `terminal.js`'s `_runLlm()` before the
   model is even asked anything; `canExecuteAction()`/`recordAction()` are
   called in `_approveProposal()` - the occlusion re-check (#11) is
   deliberately run FIRST, synchronously, with the (now async, SW-round-trip)
   rate-limit check after it, so the occlusion probe's timing-sensitive
   adversarial fixture isn't made more racy by an added await before it; both
   checks must still pass before `executor.execute()` runs regardless of
   which is evaluated first. Only actually-executed mutations count against
   the action budget, same as before. Remaining budget is always visible in
   the terminal's titlebar and via the `budget` command - both now reflect
   an async fetch of the SW-authoritative numbers (cached locally between
   fetches for synchronous rendering), not a locally computed value.
   Cleared on `chrome.tabs.onRemoved`, which fires without needing the
   `tabs` permission - only reading a `Tab` object's `url`/`title`/
   `favIconUrl` needs that permission or a matching host permission, and
   `onRemoved`'s callback never receives a `Tab` object at all (just
   `tabId`/`removeInfo`) - no permission was added for this;
   `manifest.json`'s `permissions`/`host_permissions` are unchanged from
   before this fix.
   **Fail-closed messaging posture:** if the content script's message to the
   service worker fails for any reason (SW unreachable, extension context
   invalidated), the check is treated as NOT allowed / paused, never as
   silently permitted - same "can't check isn't the same as passed" posture
   as the #11 occlusion probe.
   Unit-proven two ways: `tests/m2_security.test.js` Part 3 (a fake,
   time-injected clock, no real sleeps) proves the algorithm itself - burst
   trips the limit, the pause survives the window rolling over (no silent
   auto-recovery), `continue` clears it, LLM-call and executed-action
   budgets are independently enforced; `tests/sw_ratelimit_persistence.test.js`
   (new, 2026-07-12) proves the PERSISTENCE claim directly against the real,
   unmodified `background/service-worker.js` source (loaded via Node's `vm`
   module, browser-only APIs faked, clock and `chrome.storage.session`
   injectable) - a completely independent, freshly constructed "service
   worker instance" sharing only the same backing storage (simulating a
   real content-script re-injection / SW eviction-and-restart) still sees an
   already-tripped pause and its exact reason, per-tab isolation holds, and
   `chrome.tabs.onRemoved` clears the right tab's key. Live-verified against
   the real unpacked extension too (real Chrome, real `chrome.storage.session`,
   real `chrome.tabs.query`-resolved tab id): a pause forced into storage for
   a real tab, followed by a real page reload (fresh content-script
   re-injection), shows the pause and its reason in the titlebar/`budget`
   command immediately, blocks a subsequent `ask` before the model is even
   called, and `continue` clears it - the exact failure mode this fix
   closes, proven end to end, not just at the unit level.

8. **Human-in-the-loop approval gate.** No state-changing action executes
   without an explicit human Enter. **M1: DONE.** `click`/`fill`/`select`/
   `navigate` render a proposal card and require Enter (Esc rejects);
   `answer`/`extract`/`scroll`/`abort` are read-only and auto-run. The
   card's text is template-rendered from the raw action JSON and the real
   target element's live attributes - never from the model's own prose.
   **2026-07-12:** the `click` gloss now also shows the resolved navigation
   destination and whether it's same-origin or would be blocked (MUST-FIX
   #2 - previously the card showed role/name but never the href, so a human
   approving a click was approving blind about where it would actually go).
   Built the same way as everything else in the card: from the live element
   via `guards.js`, never from the model's reasoning text.

9. **Hard blocks that approval cannot bypass.** **M1: DONE** (was
   PARTIAL until 2026-07-12 - see below). In `extension/content/executor.js`
   (guard predicates factored into `extension/content/guards.js`, shared
   with the Node unit test), unconditionally:
   - Never fill/select a password field (`type=password` on `<input>`, or
     `autocomplete` containing `current-password`/`new-password`/
     `one-time-code` on `<input>`/`<select>`/`<textarea>`). The
     `one-time-code` coverage and the `<select>`/`<textarea>` autocomplete
     coverage were both added 2026-07-12 (the latter closed a real gap found
     while writing the unit test: the credential check was accidentally
     `<input>`-only even for the autocomplete-token branch, making the
     `select` action's guard dead code for any real `<select>`). **Honest
     scope limit:** a generic `type=text` PIN/OTP field with no
     `autocomplete` hint is not detectable by any of this - there's no
     reliable DOM signal for it.
   - **Never click a resolved non-`http(s)`-scheme or cross-origin target**
     - added 2026-07-12 (MUST-FIX #1 from the security review; previously
     `click` called `el.click()` with zero checks while `navigate` was
     hard-blocked, so a click on a `javascript:` anchor or a cross-origin
     anchor reproduced exactly what the navigate block prevents, via a
     different verb). Covers `<a href>` on the clicked element or an
     ancestor (event bubbling), and `formaction` on `<button>`/`<input>`;
     re-resolves from the live DOM at execution time, closing the TOCTOU
     where a page swaps an href between proposal and approval.
     **2026-07-12, same-day verifier follow-up:** the above list was still
     incomplete - a click on a submit control (`<button>` with no `type`
     attribute or `type=submit`, or `<input type=submit|image>`) inside
     `<form action="https://evil.com">` reached `el.click()` unchecked,
     because only `formaction` was resolved, never the *enclosing form's*
     `action`; `<area href>` and SVG `<a xlink:href>` had the same gap. All
     three are now resolved the same way - live, at execution time, through
     the identical scheme/origin check - before `el.click()` runs. A
     same-origin (or action-less, which resolves to the current document URL
     per spec) form submit is correctly **allowed**; only a resolved
     cross-origin or non-`http(s)` (e.g. `javascript:`) form action, area
     href, or svg-anchor href blocks.
   - Never navigate to a non-`http(s)` scheme; never navigate cross-origin
     (M1 same-origin only).
   - Always re-resolve and re-verify the target element (attached +
     visible) immediately before executing, aborting on staleness.

   Verified three ways: end-to-end in the browser battery (saucedemo login
   commands, and - 2026-07-12 - three dedicated click-guard entries against a
   local fixture page proving the `javascript:` case is blocked live with
   the destination shown, and the same-origin case is allowed); with a
   direct unit-level test (`tests/executor_credential.test.js`, 31
   assertions as of the same-day form-action/area/svg follow-up, `node
   tests/executor_credential.test.js`) that loads the real
   `guards.js`/`executor.js` source via Node's `vm` module and calls
   `execute()` directly with synthetic malicious `fill`/`select`/`click`
   actions - including a TOCTOU probe, an ancestor-bubbling click probe, and
   (the follow-up) a same-origin-form-submit ALLOW case alongside the
   cross-origin-form/area/svg-anchor/`javascript:`-form-action BLOCK
   cases - bypassing the model and the UI entirely; and manually via the
   saucedemo login flow. This test did not exist before 2026-07-12 despite
   both documents previously claiming it did - see the residual-risk note at
   the end of this file.

10. **Session audit trail.** **M1: DONE.** Every proposal + verdict +
    execution result is kept in an in-memory array and logged via
    `console.info`; the `log` command renders it in the terminal.

11. **At-execution-time occlusion verification.** Beyond a single
    `elementFromPoint` sample when the element list is built, re-verify
    immediately before executing that the target is still the topmost
    element at its location (not freshly covered by a page-injected
    overlay). **M2.1: DONE.** `terminal.js`'s `_probeApprovalOcclusion()`
    runs immediately before `_approveProposal()` calls
    `executor.execute()` (after the M2.3 rate-limit check, before
    execution) - NOT a warning, an ABORT: a detected occlusion cancels the
    action outright and surfaces "approval UI was covered - action
    cancelled for safety" in the terminal. Two samples, both against the
    approve button's on-screen center point:
    - `document.elementsFromPoint()` from OUTSIDE the closed shadow root
      (retargets to the popover host for closed-shadow content) - must
      resolve to the extension's own host element, not a page element.
    - `this.shadow.elementsFromPoint()`, using the direct `ShadowRoot`
      reference this script itself holds (closed mode only blocks
      *external* access via `el.shadowRoot`, not our own captured
      reference) - must resolve to the approve button itself (or a
      descendant of it), not some other part of our own panel.
    - Followed by a confirmatory pointer-events probe: temporarily exclude
      the whole overlay from hit-testing (`pointerEvents = 'none'` on the
      host) and resample - a genuinely un-occluded reading must change
      (reveal page content or a competing overlay underneath); if it
      doesn't, the check fails closed rather than trusting a possibly-stale
      first reading.
    The pure comparison logic (`guards.classifyOcclusionProbe()`) is
    separated from the impure DOM sampling specifically so it's unit-
    testable with plain fake objects (`tests/m2_security.test.js` Part 1:
    un-occluded/occluded/malformed-input cases). The DOM sampling itself is
    proven end-to-end by `tests/m2_adversarial.py` against
    `tests/fixtures/occlusion-attack.html` (a page that races its own
    top-layer popover over the approval card) - approving the click there
    is ABORTED with the occlusion message, not executed.
    **Fail-closed, by design:** if `document.elementsFromPoint` is
    unavailable in the running browser at all (documented as an extremely
    unlikely path given this project's Chrome ≥144 floor), or the approve
    control has no visible geometry, the probe reports occluded rather than
    assuming safety - "the check couldn't run" is never treated as
    equivalent to "the check passed".

12. **Deterministic coverage broad enough to rarely need the model** for
    common CRUD-like page interactions beyond search/open (pagination,
    tab-switching, multi-field forms). **Still NOT DONE.** Out of M2's
    scope (M2 was security hardening, not deterministic-engine breadth);
    unchanged from M1.

13. **Rollback/undo affordance.** **M1: NOT DONE.** `fill`/`click`/`select`/
    `navigate` are one-way; the only safety net after approval is human
    vigilance plus the audit log. No undo stack.

## M1 implements

\#1 (partially, see #1's M2.1 entry above for what M2 added on top), #2, #4
(partially), #5 (crude), #8, #9, #10.

## M2 implements (2026-07-12, plan §13)

\#1 (top-layer + focus trap, completing the M1-partial state - occlusion
race between two top-layer surfaces remains the honest residual, backstopped
by #11), #3 (same-origin iframes + open shadow roots, cross-origin
frames/closed shadow roots structurally excluded), #7's runtime-navigation
half (M2.2 - narrower than full item #6, see #6's entry for the
distinction), #7 (M2.3 rate limits/action budget), #11 (execution-time
occlusion re-check, fail-closed).

## Still not done - out of M2's scope

\#6 (safe cross-origin confirmation UX - same-origin-only hard block
remains the policy), #12 (broader deterministic engine coverage), #13
(rollback/undo affordance). None of these were in plan §13's M2 item list;
they remain open for a future milestone.

## Residual risk

**Prompt injection resistance is probabilistic, not absolute.** The system
prompt frames the page's element list, title, and origin as untrusted data to
read rather than instructions to follow, and the few-shot examples reinforce
that framing - but a sufficiently adversarial page could still bias which
*legitimate* action the model reaches for (e.g. nudging it toward clicking a
malicious-but-visible button when the user's command was vague). This is why
the hard blocks in #9 exist as an independent backstop rather than relying on
prompt hygiene alone: a fully compromised model output cannot fill a
password field, or use `click`/`navigate` to leave the origin or resolve to a
non-`http(s)` scheme - that check runs in code the model never touches, after
approval, not before it. As of 2026-07-12 this covers `<a href>` (self or
ancestor), `formaction`, the enclosing `<form>`'s `action`, `<area href>`,
and SVG `<a xlink:href>` - every *statically resolvable* navigation/submission
target reachable from a `click` action. **This is not an absolute "a
compromised model can never leave the origin via a click" guarantee,** and
should not be described as one: a plain `<button>` (or any element) whose own
page-supplied `onclick`/event-listener code runs `location.href =
'https://evil.com'` (or `fetch()`/`form.submit()` some other element
programmatically) has no static `href`/`action`/`formaction` for
`resolveClickNavTarget()` to resolve *before* the click fires - `hasTarget`
is correctly `false` for such an element, and `el.click()` still executes
(that part is unchanged and, per the M1 note below, structurally cannot be
avoided without refusing to click anything with an unpredictable handler at
all - which would break the product). **2026-07-12 (M2.2) update:** what
*can* now be caught is the RESULT - `extension/content/nav-watch.js` arms a
runtime watcher around every extension-executed click that classifies and
(where the platform allows) silently cancels any cross-origin/non-http(s)
navigation the click's handler triggers, using the Navigation API's
`navigate` event (see item #7/M2.2 above for the full mechanism and its own
honest limits - `window.open`/new-tab navigation and other-browsing-context
navigation remain genuinely unobservable, not merely unblocked). This
converts what was a pure "documented but unmitigated" residual into a
"detected-and-usually-blocked, with named exceptions" one - still not an
absolute guarantee, but no longer a hole with zero backstop.
It belongs in the honest residual-risk list, not in the guarantee.

**"Named exceptions," disclosed in full as of 2026-07-12 (an independent M2
verify found the two below were true but undisclosed - same standing rule
as the honesty-correction note further down this file):** beyond
`window.open`/new-tab and other-browsing-context navigation (already
disclosed above), the watcher's own `windowMs` (1500ms by default) is a
genuine TIMING escape - a click handler that defers its navigation past
that window (`setTimeout(() => location.href = '...', 1600)`) navigates
with the watcher already torn down and nothing armed to see it, and a
`<meta http-equiv="refresh">` navigation is never inside the watch window
in the first place (it isn't triggered by the click handler this extension
observed at all). Neither produces a `navigate` event within the armed
window, so neither is even DETECTED, let alone blocked - a strictly weaker
posture than the `window.open`/new-tab case, which is at least honestly
named as "not observable" right where the mechanism is described. See item
#7/M2.2's own entry above for the full, precise wording now covering these.
Not hardened in this pass - see that item's note on why (mechanism is fine;
the gap was that these two were true and unmentioned, which is the honesty
problem this update fixes, not necessarily the security problem, though
narrowing this residual remains open future work).

**2026-07-12:** the system prompt gained an explicit rule - "if no element on
the page satisfies the command, you MUST emit `abort`... never click a
merely-plausible or barely-related element as a guess" - plus a few-shot
example, in response to a verified gate-battery failure (the model reasoned
"no astronomy link exists" and then clicked an unrelated link anyway instead
of aborting). This is a prompt-hygiene mitigation, not a hard guarantee: it
measurably reduces one specific class of "wrong but legitimate-looking same-
origin click," but there is no code-level backstop for it the way there is
for credentials/scheme/origin - a same-origin click on the *wrong* element is
still something only the human approval gate and this prompt rule guard
against, not the executor. Re-running the exact regression case wasn't part
of this verification pass (no held-out negative-control page was crafted);
the fix is a targeted response to the documented failure mode, applied with
"do not overfit" as an explicit constraint, and its effect should be watched
in future battery runs rather than assumed.

**Honesty correction, 2026-07-12:** this document and README.md previously
claimed "a direct unit-level test that force-feeds a malicious fill-the-
password action straight into execute()" existed. It did not - no such file
was in the repo, and the gate battery never exercised the password block
either (the model aborted before reaching it in every observed run, so the
hard block itself was never actually proven to fire). Both claims have been
corrected to describe what's actually true now:
`tests/executor_credential.test.js` exists, passes 23/23 assertions, and
does exactly what was claimed - see README.md's "2026-07-12 security fix
round" section for the run output. Treat any "DONE"/"verified" claim in this
project's docs as suspect until you've re-run the thing it cites; this
incident is the reason why.

**The closed shadow root, by itself, was never a security boundary against a
determined page** - it raises the bar against casual interference (CSS
bleed-through, trivial DOM queries) but a page script still shares the same
document and input event stream. **2026-07-12 (M2.1) update:** this is now
addressed two ways, not one: top-layer rendering (Popover API) removes
ordinary page CSS/z-index as a vector entirely, and the execution-time
occlusion re-check (#11) independently catches the narrower remaining case
of another top-layer surface racing to cover the approval card - see
`tests/fixtures/occlusion-attack.html` for the adversarial page this is
proven against. The shadow root itself still isn't "a security boundary" in
isolation; the combination of top-layer + occlusion re-check is what closes
the gap, and the occlusion re-check is deliberately NOT redundant - it's
what protects the (documented, unlikely) case where top-layer isn't
available or is itself contested.

**What you approve is truthful about the target, not about the model's
stated reasoning.** The proposal card's gloss and detail lines are built
entirely from the action's `element`/`value` fields resolved against the
*real* live element (tag, role, accessible name) - never from the model's
`reason` string, which is unvalidated model prose and should be read as a
hint, not a guarantee. A human approving "fill [2] `<input>` role=searchbox
name=\"Search Wikipedia\" with \"intel arc\"" is trusting the DOM
introspection, not the model's explanation of why it chose that.

**CPU latency (2–8s per LLM call observed on this box) was incidentally
self-limiting** against rapid-fire approval fatigue in M1, but that was a
side effect of hardware, not a designed rate limit. **2026-07-12 (M2.3)
update:** this is now closed by an actual, deterministic, hardware-
independent limiter (`extension/content/ratelimit.js`, see #7 above) -
GPU-backed deployments (this box's current default is GPU, sub-2s p50) no
longer lose their only protection against burst/rubber-stamping abuse.

**M2 additions, consolidated honest-limits summary (see the individual
items above for full detail):** the M2.2 navigation watcher cannot see
`window.open()`/new-tab navigation or navigation of a browsing context
other than the one the click ran in (deliberately not requesting the
`tabs`/`webNavigation` permission this would need), and - disclosed
2026-07-12 - cannot see a navigation a click handler defers past its
1500ms watch window, or a `<meta http-equiv="refresh">` navigation (neither
produces an event inside the armed window at all); the M2.4 extractor
structurally cannot and does not enter cross-origin iframes or closed
shadow roots (both are platform-enforced, not extension policy choices);
the M2.1 occlusion re-check fails closed (treats "can't check" as
"occluded") rather than assuming safety if `elementsFromPoint` is ever
unavailable; the M2.3 rate limiter's constants (20 LLM calls/60s, 10
executed actions/60s) are judgment calls about "sane defaults" for an
interactive, human-approved terminal, not a formally derived bound - they
may need tuning as real usage patterns emerge.

## M3 - persistent command browser (2026-07-12, design doc)

M3 turns the terminal into a command-line BROWSER: `go` navigates anywhere
(not just same-origin link clicks), state survives the content-script
re-injection every navigation causes, aliases/macros formalize a small DSL,
and `&&` chains a handful of steps together. This section covers the new
trust boundary M3 introduces and its honest residuals; items #1-#13 above
are otherwise unchanged by M3 (M3 is not a security-hardening pass over
M1/M2's existing controls - the page-lane's same-origin hard block, the
credential guard, the occlusion re-check, the rate limiter, and nav-watch.js
are all UNTOUCHED, byte-for-byte in the case of every M1/M2 hard-block
predicate in `guards.js`/`executor.js`).

### The trust split (normative - everything else in this section derives from it)

Two channels, never mixed, and - this is the important part - **provenance
is carried by WHICH CODE PATH produced an action, never by a flag on the
action object itself.** There is no `trusted: true` field anywhere in this
codebase; a boolean flag can be forged, defaulted wrong, or silently
dropped by a future refactor in a way a code-path distinction cannot be.

- **TRUSTED: user-typed terminal input.** Keystrokes a human physically
  types into the closed-shadow input (gated by isTrusted - see H1 below).
  Address-bar-equivalent authority: `go` may navigate cross-origin, unlike
  everything the LLM lanes can propose. The `&&` chain queue (design §5)
  only ever holds STRINGS THAT WERE ONCE TYPED THIS WAY - a macro's stored
  body is itself only ever writable by a typed `macro` command (see the
  alias-poisoning analysis below), so even a queued/replayed segment traces
  back to a keystroke, not to page or model output, by construction.
- **UNTRUSTED: everything read from a page** - element lists, titles,
  extracted text, and (critically, unchanged from M1/M2) any model output
  produced from a prompt that contained page data. Untrusted-derived actions
  stay same-origin-scoped and approval-gated exactly as before; page-lane's
  `navigate`/click cross-origin hard block is BYTE-FOR-BYTE UNCHANGED by
  this build (`extension/content/guards.js`'s `safeSameOriginHttpUrl`/
  `checkClickTarget`/`resolveClickNavTarget` were not edited at all except
  for the new, additive `isTrustedInputEvent` export at the bottom of the
  file - see `git diff` on that file for confirmation).

### Why a second LLM lane exists, and why isolation is proven by a payload test, not by prompting

`go`'s resolution ladder (design §2) is fully deterministic for steps 1-2
(literal URL/domain, alias lookup) - the model is never consulted for those.
Step 3 (an NL destination like `go the arch linux wiki`) needs a model call,
but routing that through the EXISTING page-lane prompt (which carries the
element list/title/origin) would mean a hostile page could, in principle,
try to bias that call the same way it can try to bias page-lane's action
choice today - even though `go`'s own cross-origin allowance means the
consequence would be worse than page-lane's (page-lane's own worst case is
still same-origin-hard-blocked).

The fix is not "tell the model harder not to listen to the page" (that is
prompt-level separation - the model as a security boundary, a scope-lock
violation per the plan). The fix is that **the nav-lane prompt structurally
cannot contain page data at all** - `service-worker.js`'s
`buildNavLanePayload(msg)` reads exactly one field off its input
(`msg.command`) and nothing else, regardless of what other fields the
caller's message object happens to carry. Because there is no code path by
which an element list, title, origin, or scrollback line could ever reach
this function's output, a hostile page has *nothing to inject into* - not
"the model has been told to ignore it," but "the bytes never arrive."

This is why the isolation is proven by
`tests/m3_nav_lane_isolation.test.js` against the REAL, unmodified
`buildNavLanePayload`/`callNavLaneModel` code path (loaded via Node's `vm`
module, a fake `fetch` capturing the exact request body sent, exercised
through the real `chrome.runtime.onMessage` listener) rather than by
asserting the system prompt contains the right words: a message object
carrying `elementList`/`title`/`origin`/`scrollback` fields filled with
canary strings is sent through `NAV_LLM_REQUEST`, and the captured body is
asserted to contain NONE of them, with the user message's parsed JSON
asserted to have EXACTLY the key `command` - nothing else. A contrasting
case in the same file proves this isn't an accidental global no-op: the
identical canary fields sent via the EXISTING page-lane message type
(`LFL_LLM_REQUEST`) DO appear in ITS body, because page-lane is *supposed*
to carry them (that's why page-lane still has its own hard blocks).

**Both lanes still share exactly one thing:** the single fetch sink
(`callLocalModelWithPayload`, the one function in the codebase that calls
`fetch`), the same `127.0.0.1:1238` endpoint, and the same LLM-call
rate-limit budget (both `_runLlm()` and `_handleGo()`'s nav-lane branch in
`terminal.js` gate/record through the identical `RL_CHECK`/`RL_RECORD`
messages before either lane's request fires). `tests/check_no_egress.sh`
still passes untouched - no new network sink was added, only a second
payload shape sent through the existing one.

**Model output is still validated after the isolation boundary, not
trusted because of it.** The nav-lane response schema constrains `action`
to the 2-element enum `['navigate', 'abort']` (proven exactly, not just
"probably," by `tests/m3_nav_lane_isolation.test.js` and
`tests/m3_hardening.test.js`'s vocabulary-lock tests, both against the real
schema object as actually sent on the wire). Even so, a `navigate` action's
proposed `value` is re-validated through the EXACT SAME
`resolveLiteralDestination()` guard the deterministic ladder steps use
(`terminal.js`'s `_handleGo()`, the "defense in depth" comment right before
the check) - the isolation removes the page-injection vector, it does not
exempt the model's own output from the http(s)-only scheme floor everything
else in this extension is held to.

### Queue risks (design §5's `&&` chaining)

The queue (SW-backed, per tab, `chrome.storage.session`, mirrors the RL_*
persistence pattern via `termstate:<tabId>`) only ever holds strings that
were typed or expanded from a typed alias/macro - see the trust-split
section above. The two residuals that follow from a persisted, cross-
navigation command queue, both accepted and mitigated as described:

1. **A compromised/redirecting destination could otherwise run the next
   queued command on an attacker's page.** This is exactly what the
   arrival check (`nav.js`'s `checkArrival()`, consulted by
   `terminal.js`'s `_advanceQueue()` on every continuation, including the
   first thing a freshly re-injected `Terminal` does) exists to stop:
   `location.origin` at continuation time must EXACTLY equal the origin
   recorded at enqueue/navigate time, or the queue halts with an explicit
   `arrived at X, expected Y - queue halted` message and requires the human
   to re-issue by hand. This is fail-closed by construction (a null/
   unparseable current origin with an expected origin recorded also halts -
   see `tests/m3_go_resolution.test.js`'s "current origin unknown" case) -
   not a best-effort heuristic. **Residual:** the arrival check only
   verifies ORIGIN, not the full URL/path - a same-origin open redirect
   that lands the tab on a different PAGE within the expected origin is not
   caught by this check (same posture the M1/M2 nav-watch honest-limits
   section already documents for a narrower case: origin-level checks
   cannot see intra-origin manipulation). This is an accepted scope limit,
   not an oversight - a same-origin redirect is not new attacker leverage
   this build introduces; the human still approves/sees every subsequent
   mutating step.

   **FIXED (fix round, independent security verify's LOW-1): the
   client-side-advance race this same arrival-check mechanism used to leave
   open.** Before this fix, four deterministic verbs that themselves
   INITIATE a navigation from inside `engine.js`'s `tryDeterministic()` -
   `back` (`history.back()`), the same-origin branch of `open`
   (`location.href = ...`), `open!` (confirms a pending cross-origin
   `location.href = ...`), and the auto-submitting branches of `search`
   (`form.requestSubmit()`/`form.submit()`/the no-form synthetic-Enter
   dispatch) - returned through `_dispatchSegment()`'s ordinary success
   path, which called the same synchronous `_afterSettle(true) ->
   _advanceQueue()` every non-navigating deterministic command does.
   Because none of `location.href = ...`/`history.back()`/`form.submit()`
   unload the document synchronously, `_advanceQueue()` could run the NEXT
   queued segment against the OLD, about-to-unload document a beat before
   the browser actually navigated - defeating design §5's "run where you
   arrive" intent. (The independent verify confirmed this could never cause
   cross-origin EXECUTION - the queue only ever holds typed text regardless
   of which document a segment happens to run against, so provenance was
   never at risk - but it was a real semantics bug, not a cosmetic one.)

   **Fix:** `engine.js`'s handlers now tag their return object
   `navInitiated: true` on exactly the branches that actually call
   `location.href`/`history.back()`/`form.requestSubmit()`/`form.submit()`/
   the synthetic-Enter dispatch - the cross-origin-PENDING branches of
   `open`/`open!` that only print a message and do NOT navigate are
   deliberately left untagged (see engine.js's inline comments on each
   branch). `terminal.js`'s `_dispatchSegment()` checks this flag and, when
   set, skips the synchronous `_afterSettle(true)` call entirely (no queue
   advance, no `TS_QUEUE_CLEAR` either) - the queue is left exactly as
   recorded. Continuation is then driven the same way `go` already drives
   it: the next content-script injection's `_restoreTerminalState()` ->
   `_advanceQueue()` -> this same arrival check.

   **`back`-in-chain fail-closed halt semantics:** unlike `go` (which pins
   the queue's recorded `expectedOrigin` to the real destination in
   `_doNavigate()` right before `location.href` fires), none of these four
   verbs update `expectedOrigin` before navigating. For `open`'s
   same-origin branch and auto-submit `search`, that is correct by
   construction - both stay on the current origin, which is exactly what
   was already recorded at enqueue time, so the arrival check passes and
   the chain continues normally. For `back`, the destination is statically
   UNKNOWABLE to this code (browser history, never a URL engine.js sees) -
   leaving `expectedOrigin` unchanged is the deliberate fail-closed choice:
   a same-origin `back` lands on the recorded origin and the chain
   continues; a cross-origin `back` (multi-origin history) lands somewhere
   the queue did NOT expect, and the arrival check halts the queue with the
   same `arrived at X, expected Y - queue halted` message a hostile
   redirect would produce, requiring the human to re-issue by hand. `open!`
   gets the identical fail-closed treatment (it can navigate cross-origin,
   confirming a previously-seen cross-origin link) - though in practice its
   `pendingCrossOriginUrl` latch dies on navigation (§4 above), so this only
   matters within a single page's segment run. See
   `tests/m3_chain_and_alias_macro.test.js`'s `navInitiated` coverage for
   the unit proof that the flag is set only on the navigating branches and
   that `_dispatchSegment()` skips the synchronous advance when it's set.

   **Residual (accepted, disclosed):** a tagged branch can initiate a
   navigation that never actually happens - the canonical case is the
   formless-`search` synthetic-Enter path against a JS search box that
   filters in place instead of navigating. The queue then stays pending:
   it is cleared/overwritten the moment the user types anything
   (`_runChain()`'s lone-command `TS_QUEUE_CLEAR`), but if the user instead
   navigates manually first, a later same-origin arrival re-runs the stale
   queued segment (visibly - echoed in the terminal; cross-origin arrivals
   halt as usual). Display-only worst case; mutating segments still hit the
   approval gate + budgets wherever they run. A queue TTL would close it;
   deferred as not worth the machinery at this severity.
2. **Any error/block/rejection/Esc clears the whole queue** (`terminal.js`'s
   `_afterSettle(ok)` is the single choke point enforcing this - every
   CHAIN-PARTICIPATING dispatch path calls it exactly once per settle.
   **Correction (fix round, independent security verify):** the original
   wording of this note said "every dispatch path in the file," which
   over-generalizes - the meta-command handlers (`_handleAliasCommand`/
   `_handleMacroCommand`/`_handleUnaliasCommand`/`_handleUnmacroCommand`/
   `_handleDevCommand`/`_handleOrigins`, plus the inline `continue`/`budget`
   branches) settle via `_settle()` directly, WITHOUT ever calling
   `_afterSettle()`. That is not a gap in the guarantee above: all eight are
   intercepted by `_submitCommand`'s own regex dispatch BEFORE `_runChain`
   (and therefore before any `&&` splitting) is even attempted, and
   `_dispatchSegment()` - the one function a queued/chain segment is ever
   run through, whether it's the first segment of a freshly-typed chain or a
   later one popped off the SW-backed queue after a navigation - never
   routes to any of them. So none of these six handler functions can ever
   be the thing that executes for a chain segment; the "_afterSettle called
   exactly once per settle" invariant holds for every dispatch path that
   *can* participate in a chain, which is the actual property `&&`'s
   never-continue-past-a-failure posture depends on.) This is a
   deliberate "never continue past a failure" posture, not a UX nicety: a
   chain that silently skipped a failed/blocked step and kept going could
   let a human approve step 3 believing step 2 already succeeded when it
   didn't. **Residual, by design, not fixed:** the existing M1/M2
   deterministic engine handlers (`search`, `open`, `extract links/table`,
   etc. - unmodified by this build) don't have a structured success/failure
   signal of their own; a chain segment like `search "x"` that finds no
   search box on the page still reports `_settle(true, ...)` (informational
   text, same as it always has outside a chain) and the chain continues.
   This is a conscious scope limit (documented in the build's own commit
   history), not a silent gap: none of those existing handlers mutate the
   page in a way approval-gating exists to protect, and rewriting their
   success/failure contract was out of this build's risk budget (see
   `registry.js`'s header comment on why the M1/M2 dispatch chain itself
   was deliberately left unmodified).

### Alias-poisoning analysis

The concern this section is named for: could a page, a model, or a remote
source ever get a malicious command into an alias/macro that a human later
runs by typing an innocent-looking short name? The answer this build is
built to hold is **no, by construction**:

- `registry.js`'s `createAliasStore(storageArea)` exposes exactly two
  mutating functions, `setAlias`/`setMacro` (plus their `unset*`
  counterparts). Both are called from EXACTLY ONE place each in the entire
  codebase: `terminal.js`'s `_handleAliasCommand`/`_handleMacroCommand`,
  which are themselves only reached from `_submitCommand`'s regex dispatch
  on RAW TYPED TEXT (`/^alias(\s|$)/i`/`/^macro(\s|$)/i`) - never from
  `_dispatchSegment` (the path a page-lane/nav-lane action or a queued
  chain segment goes through), never from `executor.js`'s action vocabulary
  (there is no `alias`/`macro`-defining action in either LLM lane's fixed
  vocabulary - see the registry-cannot-extend-model-vocabulary test below),
  and never from any chrome.storage write outside this one file. A page has
  no channel to `chrome.storage.local` at all (content scripts don't expose
  their storage bindings to page JS, and this extension never bridges one).
- **Backing store is `chrome.storage.local`, not `session`, and is NOT
  sandboxed per-tab or per-site** - an alias/macro defined on one site is
  usable (and, more importantly, OVERWRITABLE) from any site, because it's
  the human's own terminal-wide shortcut list, the same trust level as
  command history (which already worked this way pre-M3). This is
  intentional (a `wiki` alias should work everywhere), and the write path
  above is what makes it safe: only a human's own keystrokes can ever
  change what `wiki` points to, regardless of which site's terminal they
  typed `alias wiki = ...` into.
- **Reserved-name lock (found and closed during this build, not part of the
  original design doc):** nothing in the design doc stopped a typed
  `alias go = <anything>` from silently SHADOWING the built-in `go` verb (or
  `search`, or any other built-in) every time it was typed thereafter - a
  real footgun, not a cosmetic naming clash, since the entire `go`
  resolution ladder (including its confirm-on-first-visit/model-resolved
  friction) would simply stop being reachable by its own name. Closed by a
  `RESERVED_NAMES` set in `registry.js`'s `setAlias`/`setMacro`, checked at
  write time - see `tests/m3_chain_and_alias_macro.test.js`'s "an alias
  named 'go'" / "a macro named 'go'" cases. This is a build-time-found
  correctness fix disclosed here per this project's standing rule of
  surfacing what was actually found, not just what the design doc asked
  for.
- **Depth-1 lock (macros cannot reference macros)** is enforced at
  DEFINITION time in `setMacro` - a macro body's segments are checked
  against the currently-defined macro names before being accepted, not
  merely "not expanded recursively" at run time. This closes a subtler
  poisoning shape: without a definition-time check, a human could define
  `macro a = go x && b`, then separately (and confusingly, at a later,
  unrelated moment) define `macro b = a`, and now invoking `a` again would
  silently no longer do what its own definition says (since `expandMacro`
  only ever performs one substitution - it would just run the literal text
  `b`, not `a`'s original chain). Rejecting the SECOND definition at write
  time (`"b" cannot reference macro "a"` - wait, in this concrete case it's
  `a` that already exists and referencing `a` from a NEW macro is what gets
  rejected) keeps the invariant "what a macro's stored body says is exactly
  what running it will do" intact, rather than relying on run-time
  non-recursion alone to make an already-confusing edit merely inert
  instead of also disallowed.

### Typosquat residual (nav-lane / model-resolved destinations)

`go the arch linux wiki` resolving to a plausible-but-wrong domain (a
typosquat, a similarly-named unofficial mirror, or simply the model's best
guess being wrong) is a real, NOT eliminated residual - this build's
mitigation is procedural (a human reads the destination before it fires),
not cryptographic or allowlist-based:

- **Every model-resolved (nav-lane) destination ALWAYS requires
  confirmation, regardless of whether the origin was already visited this
  tab session** - unlike a deterministic `go` hit (literal/alias), which
  only confirms on first visit to a new origin. This is deliberate friction
  asymmetry (design §2's decided friction tiers, plan §13 item 1): a
  human-typed literal domain is address-bar-equivalent trust; a
  model-guessed one is not, no matter how many times it's been approved
  before, because a DIFFERENT wrong guess is a fresh risk each time, not a
  repeat of a previously-vetted one.
- The confirmation card explicitly labels the destination `NAVIGATION: go
  to <full URL>` plus `(model-resolved destination - read it before
  approving)` in the detail line (`terminal.js`'s `_confirmOrNavigate`) -
  the exact string, not a summarized/truncated one, so a typosquat
  (`wikipedia-org.example` vs `wikipedia.org`, or similar) is visually
  present for a human to catch, the same "approval card must be truthful
  about the target" principle the M1/M2 click-destination-suffix work
  already established for click actions.
- **What this does NOT do:** there is no domain-reputation check, no
  allowlist, no Levenshtein-distance-to-known-brands heuristic. A human who
  doesn't read the confirmation card carefully, or who doesn't recognize a
  convincing typosquat by sight, is not protected by anything else in this
  build. This is the same class of residual the M1/M2 approval-gate design
  has always accepted for "a wrong-but-legitimate-shaped action" (see the
  existing "prompt injection resistance is probabilistic" residual note
  above) - extended here to a cross-origin destination specifically because
  `go` is the first M3 mechanism able to reach one at all via a model call.

### Test-hook gating (H2)

`terminal.js`'s `data-lfl-state` attribute (pending-proposal contents,
rate-limit budget, mode, last result) is set on `#lfl-terminal-host`, which
lives in the PAGE'S OWN LIGHT DOM (the closed shadow root only hides the
overlay's internal contents - this host-level attribute is readable by any
page script via a plain `getAttribute`/`MutationObserver`, same as any
other DOM attribute). Pre-M3 this was emitted unconditionally - fine for a
private spike, wrong default for a public product: a page could observe
the approval flow's timing, contents, and rate-limit state on every load.

M3 gates it behind a `lflDevHooks` flag in `chrome.storage.local`
(`terminal.js`'s `_updateTestHook()` - see the H2 comment right above the
gating `if`), **OFF by default**, toggled only by a typed `dev on`/`dev
off` command (`_handleDevCommand`, itself only reachable from
`_submitCommand`'s typed-text regex dispatch, same write-path posture as
alias/macro). When off, any previously-set attribute is actively removed
(`removeAttribute`), not merely left un-updated - a page cannot read a
stale-but-still-present value from before the flag was toggled off.

**What the Playwright battery agent needs to know:** the battery must
either type `dev on` before relying on `data-lfl-state`, or pre-seed
`chrome.storage.local.set({lflDevHooks: true})` before the content script
injects (the flag is read once, async, at `Terminal` construction - see
`_loadDevHooksFlag()`). Without one of those, `host.getAttribute('data-lfl-
state')` will be `null` and any battery logic that polls it will need a
different signal (or the battery should simply always seed the flag at
profile setup, since the battery agent's own trust level is far higher than
an arbitrary page's).

### `event.isTrusted` gating (H1)

Every one of `terminal.js`'s four input-reactive handlers -
`_onGlobalKeydown`, `_onInputKeydown`, the Approve button's click listener,
the Reject button's click listener - now calls
`guards.isTrustedInputEvent(e)` as its first statement and returns early on
`false`. The concrete threat: our overlay host element lives in the page's
light DOM (events from inside the closed shadow root are retargeted to it -
see `_onGlobalKeydown`'s own comment), so a page can dispatch a SYNTHETIC
`KeyboardEvent`/`MouseEvent` at it (`el.dispatchEvent(new
KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`) with
`event.isTrusted === false`. Pre-M3 the practical impact of that was
narrow (a synthetic Escape could reject a pending proposal - a
harmless-direction DoS, not a mutation hole, since REJECT is always the
safe direction). M3 leans much harder on "terminal input is trusted because
a human typed it" (the whole `go`/alias/macro/queue trust model above), so
this is made an explicit, tested invariant rather than an implicit
side-effect of REJECT-only being reachable.

**Honest test-coverage limitation:** `guards.isTrustedInputEvent()` itself
is a pure predicate, fully unit-tested (`tests/m3_hardening.test.js` Part
1) - trivial logic, but load-bearing. The actual DOM WIRING (that each of
the four handlers really does call it, and really does return early)
is proven only by a STATIC SOURCE-SHAPE check in the same test file, not a
full behavioral DOM test with real vs. synthetic events - `terminal.js` has
never had a direct Node unit-test harness in this project (it needs
`attachShadow`/`popover`/`elementsFromPoint`/a real event-dispatch pipeline,
a much heavier DOM surface than `guards.js`/`executor.js`/`ratelimit.js`
need, which is why those three have been the ones directly `vm`-loaded
since M1/M2). This is disclosed as a real, documented gap: the source-shape
test fails if the guard call is ever textually removed from one of the four
sites, but it cannot catch a change that keeps the call present while
subtly breaking its effect (e.g. an `||` typo inverting the condition). The
Playwright battery, which DOES drive a real browser, is the place a
behavioral proof of this control belongs - a fixture page that dispatches a
synthetic Escape/click at the overlay host and asserts no state change
occurred would close this gap; it was not in this build's required test
list (design §11 lists it as a unit-test item, and a unit test is what was
built) and is flagged here as follow-up work for the battery agent or a
future pass, not silently omitted.

### H3 - TS_* responses are data, not code

Every `TS_*` handler in `service-worker.js` returns plain JSON-serializable
data (strings/booleans/arrays of strings) - see the comment directly above
`handleTerminalStateMessage`. On the content-script side, restored
scrollback lines are rendered via `_appendLineDom`'s `.textContent`
assignment (never `innerHTML`, never a template that could be reinterpreted
as markup); a popped queue segment is a plain string handed to the SAME
`_dispatchSegment` path ordinary typed input already goes through - it is
never `eval`'d, and it was never anything other than previously-typed text
to begin with (see the trust-split section above). There is no code path in
this build that constructs a DOM subtree, a `Function`, or a dynamic
`import()` from a TS_* response field.

## M4a - friction trio (2026-07-13)

Three deterministic tools, all built inside `extension/content/engine.js`
(dispatched from `tryDeterministic()`, the same synchronous, chrome.*-free
contract every M1/M2 built-in verb already uses) plus one addition to
`extension/content/registry.js`. Nothing here changes the model's fixed
action vocabulary, the manifest, any permission, any guard predicate in
`guards.js`, or the service-worker message protocol - `git diff` on
`guards.js`/`executor.js`/`service-worker.js`/`manifest.json` shows only the
one-line `RESERVED_NAMES` addition in `registry.js` (the new built-in verb
names - see below) and, in `executor.js`, no changes at all: `ls`'s
click-by-index/fill-by-index verbs call `LFL.executor.execute()` completely
unmodified.

### Listing-context lifecycle - page-scoped, model-never-sees-it

`ls` builds an index→element map by calling `LFL.axtree.build()` - the
EXACT same function the LLM page-lane already calls before every model
request (`terminal.js`'s `_runLlm()`) - and stores the result verbatim as
`state.listingContext = { entries, map, notes }`. This is a deliberate
reuse, not a parallel structure: `open <N>`/`click <N>`/`fill <N> with
...`/bare `<N>` all resolve against `state.listingContext.map` via
`LFL.axtree.resolve()`, and `click <N>`/`fill <N>` hand that SAME map,
unmodified, to `LFL.executor.execute()` - the identical map shape and
resolution path an approved LLM `click`/`fill` action already goes through.
`tests/m4_friction.test.js` Part 1 proves this directly: the map `ls`
builds is handed to the real `executor.execute()` and a real (fake, but
guard-realistic) element is actually clicked through it.

This map/entries object is:
- **Page-scoped, in-memory only.** It lives on `state` (the `Terminal`
  instance's per-page state object, per `terminal.js`'s header comment) and
  is never written to `chrome.storage.local`/`.session`, never has a
  `TS_*` message type of its own, and is REPLACED (never merged) by every
  fresh `ls`/`ls links`/`ls buttons`/`ls fields` call. It dies naturally on
  navigation (a fresh content-script injection constructs a fresh `state`
  from scratch, same as `pendingCrossOriginUrl`/`pendingProposal` already
  do), and is additionally cleared by an explicit `clear` command
  (`engine.js`'s `clear` branch now resets `state.listingContext` and
  `state.findContext` too, not just the output pane).
- **Never sent to either LLM lane.** Neither `buildPayload()` (page-lane)
  nor `buildNavLanePayload()` (nav-lane) in `service-worker.js` reads
  anything resembling a listing context - both were UNCHANGED by this
  build (see the M3 section above for the nav-lane isolation proof this
  build did not touch). The model has no channel to learn what number
  `ls` assigned to anything; a human types the number back in themselves.
- **Numbers shown == map indexes, always.** `ls`'s section caps (~40 per
  section, `"(N more)"` marker) only affect what's PRINTED, never the
  underlying map - an item not shown because its section was capped is
  still resolvable by its real index if the human already knows it (e.g.
  from a previous, unfiltered `ls`), same posture `extract links`'s
  pre-existing 40-link cap already had.

### Deterministic fill/click-without-approval-card - rationale, and what does NOT change

`click <N>` and `fill <N> with <text>`/`fill <label> with <text>` execute
immediately, with no approval card, exactly like `search`/`open`/`go`
already do. This is a deliberate continuation of an existing product
posture, not a new exception carved out for M4a: **a deterministic command
IS the human's approval** - it was typed by a human, for this exact action,
right now (same "TRUSTED: user-typed terminal input" framing the M3 trust
split above already establishes for `go`/aliases/macros). The approval
card exists to gate an action a MODEL proposed on the human's behalf, where
the human is approving an interpretation of their intent; there is no
interpretation gap to bridge when the human typed `click 3` themselves.

**What stays unconditional regardless:** every hard block in `guards.js`/
`executor.js` - the credential guard (`isPasswordField`, never bypassable
by deterministic OR model-proposed fill/select), the click-target
scheme/origin guard (`checkClickTarget`/`resolveClickNavTarget`, blocking
`javascript:`/cross-origin targets identically), and `nav-watch.js`'s
runtime navigation-interception arming (armed around every executor-level
`click`, deterministic or LLM-approved, with the same honest limits
documented under item #7/M2.2 above) - because `click <N>`/`fill <N>` call
`LFL.executor.execute()` UNMODIFIED. `tests/m4_friction.test.js` Parts 3-4
prove this directly: a `click <N>` against a `javascript:`/cross-origin
target is blocked (`el.click()` never fires) exactly like an approved LLM
click would be; a `fill <N>`/`fill <label>` against a password-type field
is refused exactly like an approved LLM fill would be.

### `click <N>` and the chain queue - no `navInitiated`, arrival check governs

Unlike `open <N>` (which controls `location.href` directly and so CAN
truthfully self-report whether it just initiated a navigation - same-origin
branch is tagged `navInitiated: true`, cross-origin-pending branch is not,
mirroring `doOpen()`'s existing FIX 1 posture exactly), `click <N>` calls
`el.click()` through `executor.execute()` and has **no way to know in
advance** whether that click will trigger a navigation - a page's own
`onclick` handler might navigate, might not, might defer, might do
something else entirely. `doClickIndex()` therefore never sets
`navInitiated` on its result, for ANY click, allowed or blocked.

This is an accepted, deliberate scope limit, not an oversight: if a
`click <N>` inside a chain (`click 3 && ls`) DOES trigger a navigation, the
chain queue's own existing machinery still governs correctly, the same way
it already does for an approved LLM-proposed click (which has never had a
`navInitiated` concept either - see `_presentProposal()`/`_approveProposal()`
in `terminal.js`, neither of which tags LLM actions this way). Concretely:
`_dispatchSegment()` runs its ordinary `_settle(true, ...)` →
`_afterSettle(true)` → synchronous `_advanceQueue()` path for a `click <N>`
result exactly like it does for `search`/`extract links`/every other
existing deterministic verb with no navigation signal of its own (see the
"Queue risks" item 2 residual above, which already documents this exact
class of gap for the pre-existing engine.js handlers) - if the click DID
just start an unloading navigation, `_advanceQueue()` may run the next
queued segment a beat early, against the still-current document. This
cannot cause cross-origin EXECUTION (the queue only ever holds previously
typed text regardless of which document a segment runs against - same
non-exploitability argument the pre-existing "Queue risks" section already
makes), and any subsequent injection's OWN arrival check
(`nav.checkArrival()`, run by `_restoreTerminalState()` → `_advanceQueue()`
on the freshly re-injected page) still fail-closes a same-origin-vs-
cross-origin mismatch the same way it always has. Net effect: a click that
happens to navigate mid-chain is governed by the exact same arrival-check
machinery `back`/`open!`/auto-submitting `search` already rely on for
cross-origin cases, with the display-only worst case (a stale queued
segment visibly re-running after a manual same-origin arrival) already
disclosed and accepted under the pre-existing "Queue risks" section - M4a
does not introduce a new failure mode here, it inherits an already-disclosed
one. `fill <N>`/`fill <label>` are non-navigating by construction (a fill
never triggers a page navigation on its own) and are likewise left
untagged.

### `open <N>` and iframe-indexed links - a build decision, not an oversight

`LFL.axtree.build()` indexes interactive elements inside same-origin
iframes too (M2.4, item #3 above) - so, in principle, `ls` can list a link
that actually lives inside a same-origin iframe. `open <N>` on such an
entry still navigates the TOP document's `location.href` (using
`axtree.frameOptsFor(el)` only to resolve the link's own origin/baseURI
for the same-origin/cross-origin classification, not to navigate that
iframe specifically) - the same posture the pre-existing `doOpen()`
text-search command has always had (it only ever considered top-document
links via `document.querySelectorAll`, so this question never arose for
it before). Navigating a specific same-origin iframe in place, rather than
the whole tab, was out of scope for this build; `click <N>`/`fill <N>` DO
work correctly against iframe-indexed elements (via `executor.execute()`,
which already resolves/mutates the element in its own document - M2.4's
existing guarantee, unchanged).

### Did-you-mean narrows the model surface, it does not widen it

`terminal.js`'s `_dispatchSegment()` now checks `LFL.registry.didYouMean()`
(a new, pure, DOM-free function in `registry.js`) between "no deterministic
command matched" and "send to the model" - a Damerau-Levenshtein distance
≤2 (and ≥1) match, on the first token only (minimum 3 characters), against
the real registered command surface (`LFL.commandRegistry.names()`),
capped at 3 suggestions. When it fires, the input is REFUSED with a
suggestion message - it is never sent to the model for that segment.

This can only ever REMOVE inputs from the set that reaches `_runLlm()`;
there is no code path by which it adds one. It is inert (returns `[]`,
falls through exactly as before) for: an explicit `ask ...` (the
unambiguous, always-to-the-model escape hatch - checked first and skips
`didYouMean()` entirely), a bare integer (already fully handled inside
`tryDeterministic()` - every bare-number input returns non-null there,
either an action or a "no listing" error, so it never reaches this check
in the first place; `didYouMean()` guards against it internally too, as a
second, independent safety net for its own standalone contract), an exact
registered verb name (already matched deterministically before this check
runs), and anything more than distance-2 away from every known name (falls
through to the model exactly as it did before this build).
`tests/m4_friction.test.js` Part 8 proves all of these cases directly
against the real, unmodified `didYouMean()`, including one integration
check against the REAL `LFL.commandRegistry.names()` output (not a
synthetic candidate list) to prove the suggestion is grounded in the
actual registered command surface, not a hand-maintained duplicate of it.

**Honest scope note:** this is a heuristic distance threshold, not a
formally derived one - a legitimate short command the model was meant to
receive that HAPPENS to be within edit-distance-2 of a real verb name
(unlikely in practice, since real English commands sent via `ask` almost
always start with a longer, more natural-language first word) would be
intercepted and require the `ask` prefix to get through. This trades a
small amount of friction for the common case (a genuine typo) against a
rare false-positive (a short, verb-adjacent-looking `ask`-worthy phrase),
and is disclosed here as a deliberate, reversible-by-typing-`ask` trade,
not a claimed-perfect heuristic.

### New reserved names

`registry.js`'s `RESERVED_NAMES` set (the alias/macro shadowing guard -
see the "Alias-poisoning analysis" section above) gained six entries:
`ls`, `read`, `find`, `here`, `click`, `fill` - the same reasoning that
protects `go`/`search`/`open` from being silently shadowed by a
same-named alias/macro now protects these six too. No other change to
the alias/macro write path (`setAlias`/`setMacro`, still the only two
mutating functions, still only ever called from `terminal.js`'s typed-input
handlers) was made.

(Later additions to the same set, same reasoning: `autoopen` (the
per-origin auto-open toggle, 2026-07-14) and `highlight` (the M4c visual
match layer, below).)

## M4c - highlight (persistent visual match layer, 2026-07-14)

`highlight <text>` marks every visible occurrence of a literal query on the
page and prints the match count; `highlight clear` removes the marks; bare
`highlight` reports status. It is a read-only deterministic verb (dispatched
inside `engine.js`'s `tryDeterministic()`, never through `_runLlm`), so it
auto-runs with no approval card, exactly like `find`/`read`/`ls`.

### Isolation - nothing reaches either model lane

The query and the matched nodes live only in the content script:
`state.highlightContext` and `state.findContext` are page-scoped in-memory
fields, never persisted (no TS_* key), never added to any LLM payload. No
`service-worker.js` payload builder was touched, so the existing nav-lane and
page-lane isolation proofs stand unchanged. There is no fetch or network path
anywhere near this code (the egress gate still passes).

### The one disclosed deviation - a page-observable CSS artifact (owner-accepted)

`find`'s own `highlightAndScrollMatch` applies a transient inline style to an
existing page element and restores it; it deliberately injects no stylesheet,
so it leaves no persistent artifact a page could observe (see engine.js's
comment there). `highlight` renders via the CSS Custom Highlight API
(`CSS.highlights` + `Range` + one adopted `::highlight()` stylesheet). While a
highlight is active, that is the first persistent, page-observable artifact
this extension leaves: the page can read `document.adoptedStyleSheets` and
`CSS.highlights`, can delete our entry, and can register its own
identically-styled highlights.

This deviation was reviewed and ACCEPTED by the owner (2026-07-14) on the
following basis:

1. The artifact is inert decoration. It cannot change layout, size, or
   position (the highlight-pseudo styling subset structurally cannot), cannot
   capture input (a `Range` is not an event target; hit-testing still resolves
   to the page's own elements), and carries no data. Nothing in the extension
   ever reads it back, so a page tampering with it cannot influence any
   extension decision.
2. **A highlight mark is never a trust surface.** The authoritative datum is
   the match count printed inside the closed-shadow, top-layer terminal,
   computed from the DOM by our own code. A hostile page can hide, remove, or
   forge on-page marks; no user or extension flow may treat a painted mark as
   proof of anything. This is the same class of statement as "the model's
   reason string is a hint, not a guarantee."
3. It exists only while a highlight is active and is removed on every clear
   path (`highlight clear`, a replacing `highlight <other>`, the global
   `clear`, and - for free - any full navigation, since `CSS.highlights` is
   per-document and the document dies).

Because a highlight gates nothing (unlike the approval card, which gates a
mutation and therefore runs the occlusion probe), there is deliberately no
occlusion/spoof probing for highlight marks - page-layer paint being coverable
or forgeable is acceptable exactly where it decides nothing.

### The API is required, and the verb fails closed without it

If the CSS Custom Highlight API is unavailable (`CSS.highlights`/`Highlight`
missing), the verb prints a "not supported by this browser" message and paints
nothing - it never falls back to wrapping matched text in `<span>` elements.
Span-wrapping was rejected outright: it would mutate page DOM structure for
content nodes (breaking framework reconciliation, page selectors, and event
delegation) and inject extension-owned event targets into page content - a
strictly larger footprint on the same axis as the deviation above.

### Scope exclusions (v1)

Matches inside `<input>`/`<textarea>` values are out of scope (they are not
text nodes; the shared collector never sees them - identical to `find`).
Same-origin iframes and shadow DOM are out of scope for v1, matching `find`'s
`document.body`-only TreeWalk exactly; `CSS.highlights` is per-document, so
widening would require a per-frame registry and is deferred with `find` as a
single future change. A match cap (`HIGHLIGHT_MAX_RANGES`) bounds how many
Ranges are retained so an enormous or adversarial page cannot be used to build
an unbounded Range list; the count is reported as capped when it engages.

## M5 - scripts v1 (2026-07-14)

`script new/ls/show/rm <name>` defines/manages a named, multi-line, capped-at-
20-step body; `run <name> [args...]` substitutes `$1..$9`/`$@`, previews the
fully-resolved step list, and runs it after one approval. Design doc:
`LFL-TERMINAL-SCRIPTS-DESIGN.md`.

### The governing constraint and how it's enforced

A saved script may only ever contain steps a human could approve one at a
time - replay must never widen the trust boundary. `click <N>`/`fill <N> with
...`/`select <N>`/`open <N>`/the bare-number M4a shortcut are all bound to
one specific `ls`-built axtree snapshot (`executor.js`'s
`resolve(elementMap, action.element)`); replaying a stored index against a
since-reflowed page would silently authorize whatever element now happens to
sit at that index. `registry.js`'s `parseScriptBody()`/`stepIsIndexAddressed()`
reject every such step **at define time**, pointing the author at
`pause "<instruction>"` instead - a step that stops the run and hands control
back for a live, freshly-approved manual action (`continue` resumes). This is
enforced once, at the single write path (`setScript()`), and re-checked again
at every `run` (`terminal.js`'s `_handleRunCommand()` re-parses the stored
body before substituting anything) - defense in depth against a future write
path (e.g. a P2 file import) that might not go through `setScript()`.

`fill <label> with ...` and `open <link text>` are deliberately NOT blocked:
both are resolved fresh against the live page at dispatch time (same trust
class as `search`/`go`), not bound to a stale snapshot.

### Injection-safe parameter substitution

`substituteParams()` never re-splits a step's text - `parseScriptBody()` (and,
for chains, `splitChain()`) fixes step/segment structure on the TEMPLATE
before any argument value is known; substitution only ever replaces a
`$1`..`$9`/`$@` token with an opaque value inside an already-delimited step.
A `&&` inside an argument value therefore cannot create a new step - it is
inert text, the way it always would be if you had typed it as an ordinary
argument to any other command. A value containing a `"` character is rejected
outright (not patched) to avoid unbalancing the step's quoting. `$@` expands
to the original quote-preserving argument text via `tokenizeArgs()`'s
per-token `raw` field, so a quoted multi-word argument re-inserts as one
well-formed unit. Unbound `$k` (fewer args supplied than the script's
computed arity) aborts the run before step 1 executes - no partial runs. See
`tests/m5_scripts.test.js` §5 for the full matrix, and design doc §4 for the
normative statement this implements.

### Isolation - nothing reaches either model lane

`script`/`run`/`pause` are ordinary reserved names (`RESERVED_NAMES`, same
alias/macro-shadowing lock as every other built-in) and are added to
`tests/m3_hardening.test.js`'s `M3_NEW_COMMAND_NAMES` vocabulary-lock list -
none of the three may ever appear in either lane's response-schema enum. A
script body is user-authored, deterministically expanded text, exactly like a
macro; the only way a model is ever consulted during a `run` is if a step the
AUTHOR wrote is itself an NL `go <phrase>` or `ask <...>` - and that step then
follows its own pre-existing lane rules unchanged. Scripts add no new path
from page or model data into an executed action.

### Namespace design - "one name, one thing", except for built-in verbs

Aliases, macros, and scripts share one flat user namespace (`setAlias`/
`setMacro`/`setScript` all cross-check the other two stores) - a name never
means two different things depending on how it's invoked. The one deliberate
exception: a script is invoked ONLY via `run <name>`, never by bare name, so
a script's OWN name does not need to shadow-check against the full built-in
verb surface the way an alias/macro name does - `run search` and the literal
`search` verb are simply different things reached different ways. The three
names of the script system itself (`run`/`script`/`pause`) are still refused
as script names (`SCRIPT_SELF_NAMES`), not for a shadowing reason but because
`run run`/`script rm script` would be self-referentially confusing.

### Verify-pass findings and fixes (2026-07-14 Fable adversarial review)

Three findings from the independent verify of the Sonnet/Opus build, all
fixed in the same session, each pinned by a test:

1. **CRITICAL - SW queue silently truncated scripts to 6 steps.**
   `service-worker.js`'s `MAX_QUEUE_SEGMENTS` was 5 (sized for `&&` chains),
   and `TS_QUEUE_SET` silently `.slice()`d anything longer - a 20-step script
   queued its 19 remaining steps and the SW kept 5, dropping steps 7..20
   mid-run with no error. Exactly the "partially running a chain the user
   didn't intend" failure `splitChain()`'s reject-don't-truncate rule exists
   to prevent. Raised to 20; `tests/m5_scripts.test.js` §9 now round-trips a
   19-item queue through the REAL SW handlers and structurally pins
   `MAX_QUEUE_SEGMENTS >= SCRIPT_MAX_STEPS - 1`.

2. **MED - two indirection paths resurrected index-addressed steps at run
   time.** `parseScriptBody()` validates the stored TEMPLATE, so (a) a step
   template that is entirely a parameter (`$1`) takes its head word from the
   ARGUMENT - `run s "click 4"` resolved to a bare index click executing with
   no approval card - and (b) a step whose head is a user-defined alias takes
   its real head from the alias's CURRENT expansion (`alias c4 = click 4`).
   Both laundered exactly the snapshot-bound index replay §1 forbids through
   a level of indirection the write-time check cannot see. Fix:
   `validateResolvedStep()` (registry.js) re-validates every step AFTER
   substitution and alias expansion, inside `_handleRunCommand()`'s loop,
   rejecting the whole run before step 1 executes. Also covers nested
   `run`/`script`, games/funpack, and malformed `pause` post-indirection.

3. **LOW - `run`/`script` as a chain segment or macro-body step leaked to the
   page-lane LLM** (no dispatch branch existed), burning a model call and
   popping an unrelated proposal. Fixed with a friendly dispatch-time refusal
   in `_dispatchSegment()`, same posture as the games' fromChain block.

**Accepted residuals (disclosed, not fixed):**

- **Mid-pause alias redefinition.** A parked queue holds already-validated
  step text; a step that is an alias NAME re-expands at dispatch, so a human
  who redefines that alias during their own script's `pause` window changes
  what the resumed step does. Self-inflicted by the same trusted human who
  wrote both the script and the alias; every executor hard block (credential
  guard, click-target guard, occlusion probe on any model proposal) still
  applies to whatever the step becomes. Not re-checked at `continue` time in
  v1.
- **`continue` during an in-flight model call.** `continue` now advances a
  parked queue. In the sub-second window where a chain segment's LLM request
  is in flight (mode `idle`, input not yet locked), a typed `continue` could
  pop the next step early. Requires the human to race their own script;
  outcome is step reordering, not a guard bypass.

### Scope exclusions (v1)

No loops, conditionals, or `wait-for-element` - control flow reintroduces
nondeterminism and erodes "every step is a step a human could approve" (design
doc §8). No record-to-script capture (P3, deferred).

### P2 - script sharing + the verb whitelist (2026-07-14)

`script export`/`import` (P2) serialize scripts to a plain-text `.lflscript`
file and back. An imported file is UNTRUSTED TEXT: `parseScriptFile()` does only
structural splitting, and every `{name, body}` pair is written through the same
`setScript()` path a hand-typed script uses, which re-runs `parseScriptBody()`
(step cap, index-verb rejection, games/funpack/nested-run locks) and the
one-flat-namespace collision checks. A shared file cannot smuggle in a
`click [N]` step or silently overwrite an existing name. Export/import use a
Blob download and an `<input type=file>` respectively - no new permission
(`chrome.downloads` is deliberately not used).

The lfl-lab brainstorm probe (2026-07-14) surfaced that `parseScriptBody()`
alone has no positive verb whitelist - it excludes specific shapes (index
verbs, games/funpack, nested `run`) but would accept a nonsense verb like
`dance now`, or an implicit natural-language line like `book the flight`. That
never granted a new capability (an unknown verb, typed or imported, falls
through at run time to the same gated lanes as any typed command - the model
proposes a fixed primitive, a human approves it, and the plan-preview shows the
step first), but it left the "a script only composes the fixed vocabulary"
claim loose. `setScript()` now enforces a whitelist: a step's leading word must
be a known command (`LFL.commandRegistry.names()`, passed in from terminal.js),
a currently-defined alias, or `ask` (the explicit model-lane prefix). Enforced
at both the typed and the import write path, since both go through
`setScript()`. **Documented residual:** aliases are allowed by NAME (they expand
at dispatch, where `validateResolvedStep()` re-checks the expansion's index/game
shape); an alias whose expansion is itself an unknown verb passes the whitelist
and, at run time, falls through to the gated model lane rather than being
refused - never a new capability, always human-approved, but not refused at
define time.

## M6 - brainstorm lane (2026-07-15)

`teach <goal text> [as <name>]` - the user describes a workflow in plain
words; the local model drafts a script BODY (a composition of the existing
fixed script verbs, never a new primitive, never executed by this feature);
the draft is validated through the same `parseScriptBody()`/`setScript()`
path a hand-typed `script new` body uses; the human approves (or discards)
before anything is saved. Opt-in, OFF by default (`teach on`/`teach off`,
persisted `lflBrainstormEnabled`). Design doc:
`LFL-TERMINAL-BRAINSTORM-LANE-DESIGN.md`.

### A third payload builder - the same isolation proof standard as the nav lane

`background/service-worker.js` gains a THIRD LLM lane
(`BRAINSTORM_LLM_REQUEST` -> `buildBrainstormPayload()`), the narrowest of
the three: `buildBrainstormPayload(msg)` reads exactly ONE field off the
caller's message (`msg.goal`) and nothing else - no element list, no page
title, no origin, no scrollback, no page bytes of any kind. This is the
identical isolation guarantee `buildNavLanePayload()` already holds (M3,
above), proven the identical way: `tests/brainstorm_lane_isolation.test.js`
is a direct clone of `tests/m3_nav_lane_isolation.test.js`'s method - it
loads the REAL, unmodified `service-worker.js` via `vm`, sends a
`BRAINSTORM_LLM_REQUEST` whose message object carries extra
`elementList`/`title`/`origin`/`scrollback`/`pageText` fields (what a
hypothetical caller bug might accidentally attach), captures the exact
fetch body sent to `127.0.0.1:1238`, and asserts none of those fields appear
anywhere in it - the parsed user-message content has exactly the key
`['goal']`, nothing else. A contrast case proves the isolation is specific
to this lane, not a global no-op: the same extra fields sent via the
existing page-lane (`LFL_LLM_REQUEST`) DO appear in its body, and both other
lanes' response-schema shapes (the page-lane's 8-primitive `action` enum,
the nav-lane's `[navigate, abort]` enum) are unchanged. The brainstorm
lane's own schema (`lfl_script_draft`, requiring `script`, optional
`reason`) is structurally different from either - it has no `action` enum
at all, so there is nothing there for the vocabulary-lock test
(`tests/m3_hardening.test.js`) to check beyond confirming `teach` itself
never leaks into the OTHER two lanes' enums (it doesn't - `teach` is a
registered command name for `help`/`man` text only, structurally decoupled
from what either model-facing schema can express).

The system prompt itself is ported VERBATIM from `lfl-lab`'s
`brainstorm/probe.py` (the `SYSTEM_PROMPT` "strict" variant, not
`NAIVE_SYSTEM_PROMPT` - that variant exists in the probe only to
demonstrate a weaker prompt's failure modes). Measured 20/20 against both a
35B and, as of 2026-07-15, the 4B behind this project's own `:1238` - see
design doc §5. The comment above `BRAINSTORM_SYSTEM_PROMPT` in
`service-worker.js` records this provenance and flags it to keep in sync
with the probe; the design doc's own follow-up (§7 item) is to have the
probe read this string directly from the shipped source instead of keeping
a second copy, closing that drift risk for good. One deliberate departure
from the probe's own wire format: the user turn is `JSON.stringify({goal:
...})`, mirroring the nav-lane's `{command}` shape (and the page-lane's
multi-field shape) rather than the probe's plain-text user message - a
consistency choice across all three lanes' transport, not a change to what
the SYSTEM prompt teaches or what was measured.

### "Model writes a malicious script the user rubber-stamps" - authorship, not capability

The steps a draft proposes are shown in full, numbered, before the
approval card ever appears (the same rendering `script show` uses). A saved
draft is, from that point on, an ordinary script: `run <name>` gives it the
exact same plan-preview, per-step approval, and `validateResolvedStep()`
hard blocks as any hand-typed script (see M5, above) - nothing about being
model-drafted grants it a wider trust boundary. The primitives the model
can propose are the same fixed set `script new` already limits an author
to (`go`/`open`/`search`/`scroll`/`fill <label>`/`pause`) - a hostile draft
cannot express anything a hostile human-typed script could not, and both
face identical gates at both save time and run time. The lane adds
authorship, not capability.

### "Page content reaches the drafting model"

Structurally impossible by the same construction as the nav lane (see
above) - `buildBrainstormPayload()` never reads anything but `msg.goal`.
`tests/brainstorm_lane_isolation.test.js`'s poisoned-message test is the
proof; this paragraph is not.

### Validate-without-persisting - `registry.js`'s `validateScriptBody()`

`setScript()` both validates a body AND writes it - but the brainstorm
flow's approval gate must sit BETWEEN "the model proposed this" and "this
is saved", so the draft has to be validated (to render the VALID/INVALID
verdict and the numbered steps) before the human has approved anything to
write. `registry.js` is refactored so `setScript()`'s own rule set - name
validity/self-name/collision checks, `parseScriptBody()`, the verb
whitelist - lives in a new pure `validateScriptBody(name, body)`, with
`setScript()` itself now just "validate, then write if ok". `name` is
optional: when the human didn't type `as <name>`, `teach` validates the
BODY ALONE first (name checks skipped) and only learns - and separately
checks with `checkNameAvailable()` - a name once one is captured on the
input line after approval. There is exactly one definition of "what makes a
script valid" either way; nothing is duplicated. `tests/m5_scripts.test.js`
§9's "validation-path unit" checks pin this directly: a fake drafted body
containing `click 3` is rejected with the index-address reason and never
persisted by either `validateScriptBody()` or `setScript()`; a valid body
validates but stays unpersisted until `setScript()` (the real write path,
called only from the approval flow) actually runs; name collisions with an
existing alias/macro/script are refused the same way `script new` already
refuses them.

### Reachability - `teach` is refused everywhere a human isn't directly typing it

Three locks, mirroring `run`/`script` exactly (§9's "New reserved names"
precedent, extended):

1. `teach` is in `RESERVED_NAMES` - an alias or macro can never be named
   `teach` (same shadowing-footgun rationale as every other built-in).
2. `_dispatchSegment()` refuses `teach` as a chain segment, a macro-body
   step, or an alias expansion - the identical dispatch-time friendly
   refusal `run`/`script` already get (a chain segment/macro body/alias
   expansion is never a human directly typing at the prompt, and the whole
   point of this lane is "only a human typing at the terminal can trigger
   it"). Pinned by a structural source-shape check in
   `tests/m5_scripts.test.js` §9b (this project has no DOM test harness for
   `terminal.js` - see M3's "Test-hook gating"/`event.isTrusted` sections
   above for the same documented limitation and the same static-source-
   shape-check substitute).
3. `teach` is excluded from the script-step verb surface the SAME way as
   `SCRIPT_SELF_NAMES` (`run`/`script`/`pause`) - `parseScriptBody()`
   rejects a `teach ...` step at define time, structurally, BEFORE the
   knownVerbSet whitelist even runs, so this holds regardless of whether
   `teach` happens to be a registered command name (it is, for `help`/`man`
   text). A script can never contain a `teach` step, typed or imported
   (`tests/m5_scripts.test.js` §9 proves both paths); `validateResolvedStep()`
   gets the matching post-indirection block, same as `run`/`script`.

### Opt-in, off by default

`lflBrainstormEnabled` defaults to `false` (unset storage reads as falsy);
`teach <goal>` while off prints one line and returns before the rate-limit
check, before `chrome.runtime.sendMessage`, before any network activity -
pinned by a structural source-shape check confirming the
`_brainstormEnabled` gate in `_handleTeachCommand()` runs (and returns)
strictly before the `BRAINSTORM_LLM_REQUEST` send call in source order
(same documented DOM-harness-limitation posture as the reachability checks
above).

### Rate limit + endpoint - no new surface

A draft costs one LLM-call rate-limit slot, checked/recorded through the
exact same SW-authoritative `RL_CHECK`/`RL_RECORD` messages the page-lane
and nav-lane already use - there is no separate "brainstorm budget" to
reason about. The call goes through the same single `callLocalModelWithPayload()`
fetch sink to the same `http://127.0.0.1:1238` endpoint;
`extension/manifest.json` is byte-unchanged (no new `host_permissions`,
`permissions` still exactly `["storage"]` - pinned directly in
`tests/m5_scripts.test.js` §9b). `callLocalModelWithPayload()` gained an
optional `timeoutMs` parameter (default unchanged at the pre-existing 30s,
so the page-lane and nav-lane are byte-equivalent to their prior behavior);
the brainstorm lane passes 90s, since drafting up to a 20-line script from
a single-slot local model can run longer than either short, few-shot-heavy
prior lane's prompt needs. Both the 512-token cap and the 90s timeout are
asserted directly against the real captured request/AbortController wiring
in `tests/brainstorm_lane_isolation.test.js`.

### Disclosed residual - the goal text is the user's own judgment call

A user can paste hostile text into their own goal (e.g. copy-pasted
instructions from an untrusted source, asking the model to draft something
harmful). This is the same class of risk as a user hand-typing a hostile
script directly into `script new` - the containment is unchanged either
way: the validator (fixed vocabulary, no index addressing, no nested
run/games/funpack/teach), the full-steps-shown approval card, and every
`run`-time hard block (credential guard, click-target guard, occlusion
probe) all still apply. The brainstorm lane does not widen what a user can
ultimately get the terminal to do - only who authors the script text before
those same gates see it.

### Scope exclusions (v1)

No automatic retry on an INVALID verdict - the human re-runs `teach` with a
clearer description, or writes the script by hand with `script new`. Single
endpoint only (v1 hits whatever is behind the one existing `:1238`
endpoint; a separate, second brainstorm-only endpoint was considered and
explicitly deferred - it would need a new `host_permissions` entry, a CWS
re-review, and a config surface the product does not have yet).

**Superseded 2026-07-16:** this section originally also said "no memory -
stateless, single-shot per invocation (terminal-scoped memory across
multiple `teach` turns is its own future design, not built here)". That is
no longer true - see "Terminal memory (M1-M3)" below for the opt-in,
separately-designed memory feature that now feeds a curated, whitelisted
summary into this exact lane on `teach`. The isolation boundary this
section describes for page content is unaffected: memory is never page
content, and the execution lane (the one that ever sees an untrusted page)
still gets none of it, memory or otherwise.

## Popover redesign (2026-07-15, LFL-TERMINAL-POPOVER-REDESIGN.md)

A presentation/placement change only: the overlay now defaults to a
cursor-anchored floating panel (spawned near the pointer, or a deterministic
top-center spot for keyboard/toolbar triggers) instead of a full-width bar
docked to the viewport bottom, plus an opt-in pin/drag mode and an opt-in
middle-click trigger. None of the approval gate, execution guards, isolation
boundaries, or storage/rate-limit machinery documented elsewhere in this file
changed - every hard block still applies exactly as before regardless of
where the panel happens to be drawn on screen.

### New surface, and how it's gated

Three new event listeners were added: a `pointermove` capture (remembers the
last real pointer position, purely to anchor the NEXT open - see design §5),
an `auxclick` handler (the opt-in middle-click trigger, off by default - see
design §6.1), and a titlebar `mousedown` (drag-to-move, only live once the
panel is pinned). All three are gated by the same `isTrustedInputEvent` check
(H1, above) every other input handler in this file uses - a page cannot
dispatch a synthetic pointermove/auxclick/mousedown to pre-seed where the
panel will spawn, drag it somewhere of the page's choosing, or fake the
middle-click trigger itself. Opening the panel (however it's triggered) does
not execute or mutate anything - the approval gate, occlusion probe, and
every executor-level hard block are unchanged and still run at their usual
point, unaffected by which anchor mode drew the box.

### Middle-click's inert-background heuristic - disclosed residual

The opt-in middle-click trigger (`config middleclick on`) only acts when the
click target is not a link/button/form field/`contenteditable`/`summary`/
`label` and there is no active text selection (`_isInertBackgroundTarget()`).
This is a best-effort heuristic, not a security boundary: a page could in
principle style an interactive-looking element to visually resemble
background, or vice versa, biasing where a middle-click "lands" from the
user's perspective. This is the same class of residual the site-level "what
it will not do" disclosure already covers for the model-proposal lane (a page
can try to bias which legitimate action gets proposed) - here the equivalent
statement is "a page can try to bias where inert background appears to be".
The heuristic being wrong in either direction only changes whether the
terminal opens/closes at a given click; it cannot make an unapproved action
execute, and toggling `config middleclick off` (the default) removes this
surface entirely.

### Scope exclusions

No auto-hide/light-dismiss on outside click (the panel keeps its existing
`popover="manual"` semantics - see M2.1, above - explicit close/Esc/toggle
only). No touch/pointer-device-specific gestures beyond the mouse-only
middle-click and drag - a touch-only device falls back to the keyboard/
toolbar triggers and the deterministic anchor. No multi-monitor-aware
placement beyond the single `window.innerWidth/innerHeight` viewport the
panel already lives in.

## Terminal memory (M1-M3, 2026-07-16, LFL-TERMINAL-MEMORY-LANE-DESIGN.md)

A terminal-scoped, opt-in, local-only record of "which VERB ran on which
ORIGIN, how many times", plus (M3) a curated summary of that record fed into
the brainstorm/`teach` lane as trusted background context. This is the one
feature in the whole product designed around a single governing invariant
(design doc §1): **trust of INPUT decides what a model may hold, not model
size, not "it earned it".** Two lanes, permanently separated - the execution
lane (drives pages, sees untrusted page bytes) gets NO personal memory,
ever; the brainstorm/`teach` lane (sees only the user's own typed goal,
never page bytes) MAY carry a small trusted memory, because what it already
sees is already trusted.

### M1/M2 - the deterministic core (no model anywhere)

`chrome.storage.local` key `lflMemory` (`{v:1, origins:{origin:{verb:{n,
lastUsed}}}, prefs:{}, recent:{origin:[verb,...]}}`), a separate opt-in
master switch `lflMemoryEnabled` (default OFF, same posture as `teach`/
`dev`/`autoopen`), and a `memory`/`remember`/`forget` command surface
(`memory show`/`on`/`off`/`quiet`/`loud`/`forget <origin>`/`clear`) that
never touches a model. The one write choke point is `recordVerb(mem,
origin, verb)` in `registry.js`: arity exactly 3, both string inputs
independently re-validated inside the function (never trusted from the
caller) against `normalizeOriginKey()` (strips a URL down to scheme+host,
http(s) only - path/query/fragment are structurally impossible to store)
and `MEMORY_VERB_RE` (a short bare word, letters/digits/-/_ only, starting
with a letter, <=24 chars) - this is what makes "an argument (`search "my
query"`) can never be recorded, even if a caller tried" true by
construction, not by convention: any multi-word, quoted, or otherwise
argument-shaped string simply fails the shape check and is silently
dropped. `recordVerb()` is called from exactly two places in terminal.js's
dispatch path (the resolved deterministic verb, and the fixed literal
string `'ask'` for the model-dispatch branch - never the raw command text),
gated first by the master switch, before any storage access at all. Capped
(200 origins, 64 verbs/origin, 12-entry recent ring, LRU-evicted) so even
this benign data cannot grow unbounded. `formatMemoryDump()` (`memory
show`'s renderer) and `detectRepeat()`/`formatNudge()` (the print-only
repeat detector behind the "you've run X here N times" nudge) are pure,
deterministic, and - like every function in this section except the M3
addition below - contain no reference to `fetch`/`chrome.*`/a model at all
(pinned directly: `tests/memory_lane.test.js` greps their own `.toString()`
for exactly that).

### M3 - buildMemoryContext() and the trusted preface into `teach`

`buildMemoryContext(mem, origin, scriptNames)` (`registry.js`) is the read
side of the same wall: it turns a stored memory object into text a MODEL
will see, and it is the ONLY function anywhere in this codebase that does
that. It reads exactly three whitelisted things - `mem.origins[origin]`
(verb keys re-checked against `MEMORY_VERB_RE`, only the numeric `n` read
off each entry), `mem.recent[origin]` fed through the same `detectRepeat()`
M2 already uses, and an optional array of existing script names (re-checked
against the script-naming `NAME_RE` and a defensive length cap) - and it
never does `JSON.stringify(mem)`, `Object.values(entry)`, or any other
generic serialization of anything read from storage; every line of output
is built by naming one specific field. This is what makes "whatever got
into the store, however it got there, still cannot reach the model as
anything but a verb/count/script-name" true by construction rather than by
review: `tests/memory_lane.test.js`'s adversarial section feeds this
function memory hand-seeded with argument-shaped garbage in every position
it can reach (extra properties on a verb entry, extra top-level keys on the
memory object itself, unrecognized pref keys, a poisoned recent-ring entry,
oversized/space-containing/quoted script names) and asserts none of it
survives into the returned string. Its own arity is 2 (`scriptNames`
defaults to `[]`) - the same "no room for a smuggled extra input" shape
every other memory function in this file holds itself to.

Wiring: `terminal.js`'s `_handleTeachCommand()` builds this string (via the
new `_loadMemorySnapshot()`/`_teachScriptNames()` helpers) and attaches it
to the outgoing `BRAINSTORM_LLM_REQUEST` message as an OPTIONAL
`memoryContext` field, ONLY when memory is on AND something is recorded for
the current origin - never unconditionally. `background/service-worker.js`'s
`buildBrainstormPayload()` accepts that field and, when it is a non-empty
string, folds it into the USER turn's own JSON as a `trusted_context` field
(ordered before `goal`) - `{"trusted_context": "...", "goal": "..."}` - so
the trust boundary between "what the user asked for" and "background the
terminal already knew" stays visible in the wire format as two distinct
JSON keys, not just in prose. When `memoryContext` is absent (memory off, or
nothing recorded yet for this origin), `buildBrainstormPayload()`'s output
is BYTE-IDENTICAL to its pre-M3 shape - no new field - which is what makes
"teach behaves exactly as it always has when memory is off" true by
construction, pinned directly in `tests/memory_lane.test.js` against the
real, unmodified `service-worker.js` source.
The `messages` ARRAY shape itself (`[system, user]`, exactly two entries)
is INVARIANT regardless of memory state - see the 2026-07-17 correction
below; only the user turn's JSON gains a field.

**2026-07-17 correction (message-shape fix):** M3 originally shipped
`memoryContext` as a SECOND `system`-role message inserted between the
fixed brainstorm system prompt and the user's goal turn (`messages =
[system, system, user]` when present). Live wire testing against the fleet
35B `llama-server` build found that its chat template hard-rejects any
non-leading system message: HTTP 400, `Jinja Exception: System message must
be at the beginning`. The cohort 4B build tolerates a second system
message, which is why this was not caught earlier - the M3 verify only ran
shape unit tests against a `vm` sandbox, never a live chat-completions call
against the 35B build. Fixed by making the message array invariant at
exactly `[system, user]` always (the shape now described above) instead of
appending the context to the system message text - message-shape invariance
is immune to chat-template strictness on any server, keeps
`BRAINSTORM_SYSTEM_PROMPT` byte-stable (relevant to both the drift-vs-probe
check and server-side prompt caching), and keeps memory-derived content on
the data channel (a user-turn JSON field) rather than the instruction
channel (a system message) - the same convention the nav lane and execution
lane already use. `BRAINSTORM_SYSTEM_PROMPT` gained one static sentence
describing the optional `trusted_context` field; the prompt is otherwise
unchanged and still never varies per request.

`teach save that` is a fixed magic goal (recognized by an exact,
case-insensitive match on the phrase, never a substring/prefix match) that
skips writing a goal at all: it requires memory to be on, requires
`detectRepeat()` to actually fire for the current origin right now (both
checked, and failed loudly with no network call, BEFORE the rate-limit
check/LLM call - same "fail before spending a slot" posture the
name-availability check above it already uses), and synthesizes the goal
text from `rep.verbs`/`rep.count` ONLY - the identical verbs-only data
`detectRepeat()` was already built on in M2, never a fresh read of anything
argument-shaped. `teach save that as <name>` reuses the SAME `as <name>`
extraction the plain `teach` path already has.

### The execution lane still gets ZERO memory - unchanged, re-proven

`buildPayload()` (the execution/page-driving lane, `LFL_LLM_REQUEST`) is not
touched by this build at all - it still reads exactly
`command`/`elementList`/`origin`/`title` off the caller's message, and does
not read a `memoryContext` field even when a caller's message object
happens to carry one (there is no code path in that function that could -
it was never given one to read). `buildNavLanePayload()` (`NAV_LLM_REQUEST`)
is the same: unmodified, and a `memoryContext` field attached to a nav-lane
message is silently ignored. `tests/memory_lane.test.js`'s M3 section sends
both lanes a poisoned message carrying an obviously-marked `memoryContext`
string and asserts it never appears anywhere in either captured request
body - the isolation is proven against the real, unmodified source, not
assumed from the design.

`background/service-worker.js` itself still never reads
`chrome.storage.local` (memory or any other key) anywhere - `memoryContext`
only ever arrives as a plain string on the `BRAINSTORM_LLM_REQUEST` message
object, already built by the content script, which is where that storage
area actually lives. This is the same structural proof M1/M2 already
established (`tests/memory_lane.test.js`'s "service-worker.js never calls
chrome.storage.local" check, still green, unmodified by M3) - M3 does not
change *where* memory is read from, only adds one new optional field a
caller may (or, for two of the three lanes, may not) attach to a message.

### Threat model additions (design doc §6)

- **Injected memory.** A hostile page cannot write to `lflMemory` at all -
  it lives in the content script's `chrome.storage.local`, which page
  JavaScript has no API to reach; only this extension's own content script
  writes it, and only through the single `recordVerb()` choke point
  described above. Even in the hypothetical where a value somehow arrived
  malformed, `buildMemoryContext()`'s whitelist means the worst case is a
  junk verb name or an inflated count showing up in the "commands the user
  has run on this site" line - never an instruction, never an exfiltration
  channel, because the function structurally cannot emit anything shaped
  like one.
- **Memory as an exfiltration target.** The execution lane never reads
  memory (proven above), so a hostile page cannot cause memory to be
  *retrieved* by manipulating page content either - the only path that ever
  reads `lflMemory` for a model-facing purpose is the trusted brainstorm
  lane, and only when the human directly types `teach`/`teach save that`
  themselves. There is no reachability path from chain/macro/alias
  expansion or any other non-human-typed context into this lane at all (the
  existing `teach` reachability locks - `RESERVED_NAMES`, the
  `_dispatchSegment()` refusal for chain/macro/alias context, the
  script-step verb-whitelist exclusion - are unchanged by M3 and still
  apply; see the brainstorm-lane section above).
- **The drafted script is still just a draft.** Whatever a memory-primed
  `teach` call drafts goes through the exact same `parseScriptBody()`/
  `validateScriptBody()` path and the exact same human approval card as
  every other `teach` draft (see the brainstorm-lane section above) - memory
  can influence *what gets proposed*, never *whether it gets validated or
  who approves it*. A hostile pattern of verbs (however it hypothetically
  got recorded) cannot buy its way past the fixed script-verb vocabulary,
  the no-index-addressing rule, or the approval gate.
- **Disclosed residual: verb-shaped junk is not membership-checked.**
  `recordVerb()`/`MEMORY_VERB_RE` enforce SHAPE (a short bare alphanumeric
  word), not that the verb is a real, currently-registered command - this
  mirrors `registry.js`'s own documented posture elsewhere in this file (the
  M1/M2 section's own comment on this). A verb-shaped-but-fictitious string
  could in principle appear in a `commands the user has run on this site`
  line; given the shape's extreme restriction (no spaces, no quotes, <=24
  chars, letters/digits/-/_ only) this cannot carry an instruction or a
  piece of exfiltrated content, only, at most, a slightly wrong-looking verb
  name - never a wider capability than "the model reads one more short
  token before drafting a script that is validated and approved exactly
  like any other."
- **Honesty in README/PRIVACY.** Both documents state plainly that, with
  memory and `teach` both on, a short summary (verbs/counts/script names
  only) is sent to the user's own local model as part of `teach`'s existing
  loopback request - never anonymized-and-safe-sounding language beyond
  what is actually true, and never a claim that memory is "never sent
  anywhere" once M3 shipped (that claim was accurate for M1/M2 alone and is
  now corrected in both documents).

### Scope exclusions (unchanged from design doc §5)

Not a memory for the execution lane (proven above, not just stated). Not
autonomy growth - approval on every mutating action remains permanent and
structural; a script drafted with memory's help is previewed and
per-step-approved on `run` exactly like a hand-typed one, every time. Not
the advisor - no vault RAG, no `hermes-priv`, no fleet context reachable
from any part of this feature. Not cross-device sync - local to this
browser profile. Not keystroke/argument logging - verbs, origins, and
counts, full stop.
