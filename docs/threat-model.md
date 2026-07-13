# lfl-terminal threat model — M1 seed, M2 hardening applied, M3 command browser

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
behind it — see README.md's "2026-07-12 M2 security hardening" section for
the run output (unit counts, egress, adversarial-test proof, battery
numbers).

**2026-07-12 M3 build (persistent command browser, design doc
`AI-BROWSER-TERMINAL-M3-DESIGN.md`):** `go`/aliases/macros/`&&` chains/
scrollback+open-state persistence and a SECOND, narrower LLM lane (nav-lane)
used only by `go`'s NL fallback. See the "M3 — persistent command browser"
section near the end of this file for the full trust-split writeup, the
nav-lane isolation rationale, queue/alias/typosquat residuals, and the H1/H2
hardening notes. Unit-verified (Node, `tests/m3_*.test.js`, 139 assertions
total across all seven suites including the pre-existing M1/M2 ones — see
README.md for the exact per-file counts); the Playwright battery proof of
the live browser flows is a separate, subsequent verification pass, not
part of this build.

## The 13 design requirements

1. **UI isolation.** The overlay must be rendered in a boundary resistant to
   page CSS/JS interference and clickjacking-style occlusion tricks.
   **M2.1: DONE.** The closed-shadow-root architecture from M1 is unchanged
   (still stops page stylesheets bleeding in, still hides overlay internals
   from `el.shadowRoot` introspection), but the host element
   (`#lfl-terminal-host`) now also carries `popover="manual"` and is shown/
   hidden via `showPopover()`/`hidePopover()` (`extension/content/
   terminal.js`) — this promotes the WHOLE overlay (terminal panel AND the
   approval card, both descendants of the popover host) into the browser
   **top layer**, so ordinary page CSS/z-index/position tricks structurally
   cannot render over or reposition it. The approval card additionally gets
   an explicit focus trap (Tab cycles only between its own Approve/Reject
   buttons — see `_onGlobalKeydown`'s `awaiting-approval` branch) so
   keyboard focus can never land on a page element while a proposal is
   pending.
   **Honest scope limit:** top-layer positioning bounds page CSS, but two
   top-layer elements still have a paint/stacking order *between themselves*
   — a page that ALSO reaches the top layer (its own `popover`/`<dialog>`)
   could in principle race to render above ours. That is exactly why #11
   (execution-time occlusion re-check) exists as an independent backstop,
   not a redundant belt-and-suspenders check — see
   `tests/fixtures/occlusion-attack.html` for the adversarial case this is
   built against, and `tests/m2_adversarial.py` for the live proof it's
   caught. Browsers without Popover API support (documented as extremely
   unlikely given this project's Chrome ≥144 floor — Popover shipped Chrome
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
   (`= fetch`, `fetch]`) — the original pattern would have missed all of
   those. Re-verified PASS on the current (clean) tree.

3. **Multi-frame/iframe support.** The element indexer and executor should
   work inside iframes, not just the top document. **M2.4: DONE, scoped.**
   `extension/content/axtree.js`'s `build()` now recursively walks
   SAME-ORIGIN iframes (via `iframe.contentDocument`, bounded to
   `MAX_FRAME_DEPTH = 3` nesting levels) and OPEN shadow roots
   (`el.shadowRoot`), so interactive elements inside them are indexed,
   offered to the model, and clickable/fillable exactly like top-document
   elements. The click/fill/select guards (guards.js) are re-run against
   the element's OWN document/window context (`axtree.frameOptsFor(el)` —
   the iframe's own `baseURI`/origin, not the top page's), not just its own
   node identity, per the "re-run the guard in its own document context"
   requirement — see `tests/m2_security.test.js` Part 4 for the unit proof
   that a supplied per-frame origin is actually load-bearing (not silently
   ignored in favor of the ambient top-page origin).
   **HARD RULE, unchanged from the M1 scope note this replaces, now
   actually enforced by code rather than by absence of iframe support at
   all:** CROSS-ORIGIN iframes are never entered — `iframe.contentDocument`
   is `null` for them by the same-origin policy, which the extractor
   detects and turns into an informational-only marker line
   (`(cross-origin iframe present, not inspectable: <origin>)`) appended to
   the element list, never an indexed/actionable entry. CLOSED shadow roots
   are never entered either — `el.shadowRoot` is `null` from outside a
   closed root (including from this extension's own top-frame content
   script, which never attached them), so there is structurally nothing to
   walk into; no special-case "skip" logic was needed because the platform
   already enforces it.
   **Honest scope limit:** the M2.2 runtime navigation watcher (#7 below)
   only observes the TOP-LEVEL browsing context's navigations — a
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
   proposed `fill [1] <input> role=textbox name="frame search box"`, and —
   after approval — the value was actually written into the IFRAME's own
   `contentDocument`'s input (confirmed by reading it directly:
   `contentDocument.getElementById('frame-input').value === 'hello'`), not
   just accepted-and-discarded. This is real cross-document DOM mutation
   working end to end, not just index bookkeeping.

4. **Constrained, fixed action vocabulary.** The model's output must be
   limited to a small fixed set of actions via a schema, with the extension
   defensive against malformed/adversarial output. **M1: PARTIAL.** Ships as
   `response_format: json_schema` with an enum-constrained `action` field —
   verified working against the pinned llama.cpp build. Empirically hardened
   once already: the schema originally required only `action`, and the 4B
   model was observed to sometimes silently omit `element` even when it had
   clearly identified the right target (`{"action":"fill","value":"..."}`
   with no index at all); making `element` required fixed it. Gaps: `select`
   only supports native `<select>` elements (no custom combobox/listbox
   widgets), and there's no retry-on-malformed-JSON — a single bad response
   just surfaces as an error rather than being retried once.

5. **Deterministic engine for common patterns.** Routine navigation/search
   should never need the model. **M1: CRUDE.** Regex-based command parsing;
   `search` uses a fixed heuristic selector list plus a `name`/`id`/
   `placeholder`/`aria-label` substring match; `open` does case-insensitive
   substring/prefix matching against visible link text with no fuzzy
   matching or synonym handling; `extract table` only looks at the first
   `<table>` on the page. English-only phrasing throughout. **2026-07-12:**
   `search`'s auto-submit now checks the target form's resolved `action`
   origin before calling `requestSubmit()`/`submit()` — cross-origin forms
   are filled but not auto-submitted, printed instead (same posture `open`
   already had for cross-origin links; previously `search` had no such
   check at all).

6. **Safe cross-origin confirmation UX.** **Still NOT DONE — M2 did not
   change this.** The deterministic `open` command still has the crude
   `open!` re-type-to-confirm for cross-origin links; the LLM-proposed
   `navigate` action, and `click` when it resolves (statically) to a
   cross-origin target, still don't get a cross-origin confirmation path —
   both remain hard-blocked outright (see #9) rather than offered a
   confirm flow. **What M2.2 DID add is a different, narrower thing:**
   runtime interception of the specific M1 residual where a click's
   destination has NO static target at all (a page onclick handler
   navigating programmatically) — see the new item below. That closes a
   detection/blocking gap; it is not the same as adding a cross-origin
   confirmation UX for the cases that were already statically classified
   and hard-blocked. Same-origin only remains the policy for everything
   this extension will actually follow.

   **M2.2 — runtime navigation interception (new, closes the M1 onclick
   residual).** `extension/content/nav-watch.js` arms a short-lived
   (1500ms) watcher around every extension-executed `click`
   (`extension/content/executor.js`'s click branch), using the Navigation
   API (`window.navigation`, Chrome ≥102 — well within this project's
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
   via `tests/m2_adversarial.py` — approving the click leaves the tab on
   the original page; it never reaches the cross-origin target.
   **Precise, honest scope — read before treating this as a general
   guarantee:**
   - `beforeunload` is also armed as a fallback, but ONLY as a detect-and-
     log signal, never to `preventDefault()` on its own — that event
     structurally cannot see the destination URL (deliberate browser
     privacy design), so blocking indiscriminately on it would pop the
     native "leave site?" confirmation on every ordinary APPROVED
     navigation too, which would be a UX regression, not a security win.
   - `window.open()` to a new tab, and an `<a target="_blank">` click, are
     **NOT observable at all** by this watcher — `window.navigation`
     belongs to the browsing context it's created in, and a new tab is a
     different one. Seeing it would require the `tabs` or `webNavigation`
     permission, which this project deliberately does NOT request (plan §5
     item 13, minimal permissions) — this residual is accepted and
     documented, not silently swallowed.
   - The watcher only covers the TOP-LEVEL browsing context's own
     navigations. A same-origin iframe's own onclick navigating THAT
     iframe (not the top document) is outside this watcher's scope — see
     the iframe honest-limit note under #3 above.
   - Only armed around `click`, per the task spec ("and only then — not
     user-initiated page clicks") — `fill`/`select`/`navigate` don't get
     this treatment; `navigate` is already fully statically classified
     before it ever runs, so there's no ambiguity to watch for.
   - **The 1500ms watch window itself is a real, exploitable escape,
     disclosed here 2026-07-12 in response to an independent M2 verify.**
     The watcher's `dispose()` unarms both listeners (Navigation API and the
     `beforeunload` fallback) `windowMs` after the click, via a plain
     `setTimeout`. A page whose click handler DEFERS the actual navigation
     past that window — e.g. `el.addEventListener('click', () => {
     setTimeout(() => { location.href = 'https://evil.example'; }, 1600); })`
     — navigates completely unobserved: by the time the `navigate` event
     would fire, this extension's listener has already been torn down.
     This is not a corner case; it is trivial for any page to construct on
     purpose specifically to defeat this control, and previously went
     undisclosed alongside the window.open/new-tab/cross-origin-frame/
     beforeunload residuals below. **A `<meta http-equiv="refresh"
     content="0;url=https://evil.example">` tag is a second, independent
     escape of the same shape** — a meta-refresh navigation is scheduled by
     the page's markup, not by any click handler this extension observed at
     all, so it is never inside the watch window in the first place (a page
     could inject such a tag from an onclick handler timed to fire after an
     approved click, or have one present from load and simply wait out
     whatever `windowMs` happens to be). Both are BLIND SPOTS of the
     `nav-watch.js` mechanism, not merely "detected but unblockable" like
     `beforeunload` above — no event fires for either case within the armed
     window, so there is nothing to classify or log; the click simply
     resolves and the tab silently ends up elsewhere sometime later. Not
     hardened as of this pass (see the "Still not done" note this item's
     entry now carries) — disclosed here in the interest of the standing
     "no `DONE`/`verified` claim ships without an accompanying honest
     residual" rule this project holds itself to (see the 2026-07-12
     honesty-correction note near the end of this file).

7. **Resource/DoS limits on LLM calls.** **M2.3: DONE, made genuinely
   per-tab-session-persistent 2026-07-12 (independent M2 verify finding —
   see below).** `extension/content/ratelimit.js` implements the
   deterministic (never model-controlled), time-injectable rolling-window
   algorithm: `LFL.rateLimiter.DEFAULTS` caps LLM proposal calls at 20 per
   rolling 60s window and EXECUTED (approved) mutating actions at 10 per
   rolling 60s window. Exceeding EITHER budget latches the limiter into a
   "paused" state (not a silent per-window reset) that blocks every
   subsequent call/action until the human types `continue` — a
   burst-then-immediately-auto-resume design would not meaningfully differ
   from no limit at all. Read-only auto-run actions (`extract`/`answer`/
   `scroll`/`abort`) are not rate-limited, only actually-executed mutations
   count against the action budget.
   **2026-07-12 fix — WHERE this state lives, not just the algorithm:** an
   independent M2 verify found that the counters and the paused latch
   previously lived only inside the per-page `Terminal` instance
   (`extension/content/terminal.js`), which is destroyed and rebuilt from
   scratch on every top-frame navigation or `location.reload()` (the
   content script re-injects). That silently reset the budget to full AND
   cleared an active pause with no `continue` ever typed — a page (or the
   human) could trivially defeat the whole control just by reloading. The
   AUTHORITATIVE state now lives in `extension/background/service-worker.js`
   (which is not destroyed by page navigation), keyed per TAB id, backed by
   `chrome.storage.session` — cleared on `chrome.tabs.onRemoved` (tab close)
   and never written to disk, matching the earlier "session" framing but now
   actually true: the budget and the pause latch persist across navigation
   and reload WITHIN the browser session, per tab, for as long as that tab
   stays open, and are gone when the tab (or the browser) closes. The
   content script talks to this authority over four message types
   (`RL_CHECK`/`RL_RECORD`/`RL_RESUME`/`RL_BUDGET`, see
   `background/service-worker.js`'s header comment) rather than holding its
   own live limiter instance; the decision ALGORITHM is not duplicated
   between the two — the service worker `importScripts()`s the same,
   unmodified `content/ratelimit.js` a classic (non-module) service worker
   can load that way, so there is exactly one copy of the rolling-window/
   latch logic, not a content-script copy and a service-worker copy that
   could silently drift apart. `canCallLlm()`/`recordLlmCall()` are called
   (via `RL_CHECK`/`RL_RECORD`) in `terminal.js`'s `_runLlm()` before the
   model is even asked anything; `canExecuteAction()`/`recordAction()` are
   called in `_approveProposal()` — the occlusion re-check (#11) is
   deliberately run FIRST, synchronously, with the (now async, SW-round-trip)
   rate-limit check after it, so the occlusion probe's timing-sensitive
   adversarial fixture isn't made more racy by an added await before it; both
   checks must still pass before `executor.execute()` runs regardless of
   which is evaluated first. Only actually-executed mutations count against
   the action budget, same as before. Remaining budget is always visible in
   the terminal's titlebar and via the `budget` command — both now reflect
   an async fetch of the SW-authoritative numbers (cached locally between
   fetches for synchronous rendering), not a locally computed value.
   Cleared on `chrome.tabs.onRemoved`, which fires without needing the
   `tabs` permission — only reading a `Tab` object's `url`/`title`/
   `favIconUrl` needs that permission or a matching host permission, and
   `onRemoved`'s callback never receives a `Tab` object at all (just
   `tabId`/`removeInfo`) — no permission was added for this;
   `manifest.json`'s `permissions`/`host_permissions` are unchanged from
   before this fix.
   **Fail-closed messaging posture:** if the content script's message to the
   service worker fails for any reason (SW unreachable, extension context
   invalidated), the check is treated as NOT allowed / paused, never as
   silently permitted — same "can't check isn't the same as passed" posture
   as the #11 occlusion probe.
   Unit-proven two ways: `tests/m2_security.test.js` Part 3 (a fake,
   time-injected clock, no real sleeps) proves the algorithm itself — burst
   trips the limit, the pause survives the window rolling over (no silent
   auto-recovery), `continue` clears it, LLM-call and executed-action
   budgets are independently enforced; `tests/sw_ratelimit_persistence.test.js`
   (new, 2026-07-12) proves the PERSISTENCE claim directly against the real,
   unmodified `background/service-worker.js` source (loaded via Node's `vm`
   module, browser-only APIs faked, clock and `chrome.storage.session`
   injectable) — a completely independent, freshly constructed "service
   worker instance" sharing only the same backing storage (simulating a
   real content-script re-injection / SW eviction-and-restart) still sees an
   already-tripped pause and its exact reason, per-tab isolation holds, and
   `chrome.tabs.onRemoved` clears the right tab's key. Live-verified against
   the real unpacked extension too (real Chrome, real `chrome.storage.session`,
   real `chrome.tabs.query`-resolved tab id): a pause forced into storage for
   a real tab, followed by a real page reload (fresh content-script
   re-injection), shows the pause and its reason in the titlebar/`budget`
   command immediately, blocks a subsequent `ask` before the model is even
   called, and `continue` clears it — the exact failure mode this fix
   closes, proven end to end, not just at the unit level.

8. **Human-in-the-loop approval gate.** No state-changing action executes
   without an explicit human Enter. **M1: DONE.** `click`/`fill`/`select`/
   `navigate` render a proposal card and require Enter (Esc rejects);
   `answer`/`extract`/`scroll`/`abort` are read-only and auto-run. The
   card's text is template-rendered from the raw action JSON and the real
   target element's live attributes — never from the model's own prose.
   **2026-07-12:** the `click` gloss now also shows the resolved navigation
   destination and whether it's same-origin or would be blocked (MUST-FIX
   #2 — previously the card showed role/name but never the href, so a human
   approving a click was approving blind about where it would actually go).
   Built the same way as everything else in the card: from the live element
   via `guards.js`, never from the model's reasoning text.

9. **Hard blocks that approval cannot bypass.** **M1: DONE** (was
   PARTIAL until 2026-07-12 — see below). In `extension/content/executor.js`
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
     `autocomplete` hint is not detectable by any of this — there's no
     reliable DOM signal for it.
   - **Never click a resolved non-`http(s)`-scheme or cross-origin target**
     — added 2026-07-12 (MUST-FIX #1 from the security review; previously
     `click` called `el.click()` with zero checks while `navigate` was
     hard-blocked, so a click on a `javascript:` anchor or a cross-origin
     anchor reproduced exactly what the navigate block prevents, via a
     different verb). Covers `<a href>` on the clicked element or an
     ancestor (event bubbling), and `formaction` on `<button>`/`<input>`;
     re-resolves from the live DOM at execution time, closing the TOCTOU
     where a page swaps an href between proposal and approval.
     **2026-07-12, same-day verifier follow-up:** the above list was still
     incomplete — a click on a submit control (`<button>` with no `type`
     attribute or `type=submit`, or `<input type=submit|image>`) inside
     `<form action="https://evil.com">` reached `el.click()` unchecked,
     because only `formaction` was resolved, never the *enclosing form's*
     `action`; `<area href>` and SVG `<a xlink:href>` had the same gap. All
     three are now resolved the same way — live, at execution time, through
     the identical scheme/origin check — before `el.click()` runs. A
     same-origin (or action-less, which resolves to the current document URL
     per spec) form submit is correctly **allowed**; only a resolved
     cross-origin or non-`http(s)` (e.g. `javascript:`) form action, area
     href, or svg-anchor href blocks.
   - Never navigate to a non-`http(s)` scheme; never navigate cross-origin
     (M1 same-origin only).
   - Always re-resolve and re-verify the target element (attached +
     visible) immediately before executing, aborting on staleness.

   Verified three ways: end-to-end in the browser battery (saucedemo login
   commands, and — 2026-07-12 — three dedicated click-guard entries against a
   local fixture page proving the `javascript:` case is blocked live with
   the destination shown, and the same-origin case is allowed); with a
   direct unit-level test (`tests/executor_credential.test.js`, 31
   assertions as of the same-day form-action/area/svg follow-up, `node
   tests/executor_credential.test.js`) that loads the real
   `guards.js`/`executor.js` source via Node's `vm` module and calls
   `execute()` directly with synthetic malicious `fill`/`select`/`click`
   actions — including a TOCTOU probe, an ancestor-bubbling click probe, and
   (the follow-up) a same-origin-form-submit ALLOW case alongside the
   cross-origin-form/area/svg-anchor/`javascript:`-form-action BLOCK
   cases — bypassing the model and the UI entirely; and manually via the
   saucedemo login flow. This test did not exist before 2026-07-12 despite
   both documents previously claiming it did — see the residual-risk note at
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
    execution) — NOT a warning, an ABORT: a detected occlusion cancels the
    action outright and surfaces "approval UI was covered — action
    cancelled for safety" in the terminal. Two samples, both against the
    approve button's on-screen center point:
    - `document.elementsFromPoint()` from OUTSIDE the closed shadow root
      (retargets to the popover host for closed-shadow content) — must
      resolve to the extension's own host element, not a page element.
    - `this.shadow.elementsFromPoint()`, using the direct `ShadowRoot`
      reference this script itself holds (closed mode only blocks
      *external* access via `el.shadowRoot`, not our own captured
      reference) — must resolve to the approve button itself (or a
      descendant of it), not some other part of our own panel.
    - Followed by a confirmatory pointer-events probe: temporarily exclude
      the whole overlay from hit-testing (`pointerEvents = 'none'` on the
      host) and resample — a genuinely un-occluded reading must change
      (reveal page content or a competing overlay underneath); if it
      doesn't, the check fails closed rather than trusting a possibly-stale
      first reading.
    The pure comparison logic (`guards.classifyOcclusionProbe()`) is
    separated from the impure DOM sampling specifically so it's unit-
    testable with plain fake objects (`tests/m2_security.test.js` Part 1:
    un-occluded/occluded/malformed-input cases). The DOM sampling itself is
    proven end-to-end by `tests/m2_adversarial.py` against
    `tests/fixtures/occlusion-attack.html` (a page that races its own
    top-layer popover over the approval card) — approving the click there
    is ABORTED with the occlusion message, not executed.
    **Fail-closed, by design:** if `document.elementsFromPoint` is
    unavailable in the running browser at all (documented as an extremely
    unlikely path given this project's Chrome ≥144 floor), or the approve
    control has no visible geometry, the probe reports occluded rather than
    assuming safety — "the check couldn't run" is never treated as
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

\#1 (top-layer + focus trap, completing the M1-partial state — occlusion
race between two top-layer surfaces remains the honest residual, backstopped
by #11), #3 (same-origin iframes + open shadow roots, cross-origin
frames/closed shadow roots structurally excluded), #7's runtime-navigation
half (M2.2 — narrower than full item #6, see #6's entry for the
distinction), #7 (M2.3 rate limits/action budget), #11 (execution-time
occlusion re-check, fail-closed).

## Still not done — out of M2's scope

\#6 (safe cross-origin confirmation UX — same-origin-only hard block
remains the policy), #12 (broader deterministic engine coverage), #13
(rollback/undo affordance). None of these were in plan §13's M2 item list;
they remain open for a future milestone.

## Residual risk

**Prompt injection resistance is probabilistic, not absolute.** The system
prompt frames the page's element list, title, and origin as untrusted data to
read rather than instructions to follow, and the few-shot examples reinforce
that framing — but a sufficiently adversarial page could still bias which
*legitimate* action the model reaches for (e.g. nudging it toward clicking a
malicious-but-visible button when the user's command was vague). This is why
the hard blocks in #9 exist as an independent backstop rather than relying on
prompt hygiene alone: a fully compromised model output cannot fill a
password field, or use `click`/`navigate` to leave the origin or resolve to a
non-`http(s)` scheme — that check runs in code the model never touches, after
approval, not before it. As of 2026-07-12 this covers `<a href>` (self or
ancestor), `formaction`, the enclosing `<form>`'s `action`, `<area href>`,
and SVG `<a xlink:href>` — every *statically resolvable* navigation/submission
target reachable from a `click` action. **This is not an absolute "a
compromised model can never leave the origin via a click" guarantee,** and
should not be described as one: a plain `<button>` (or any element) whose own
page-supplied `onclick`/event-listener code runs `location.href =
'https://evil.com'` (or `fetch()`/`form.submit()` some other element
programmatically) has no static `href`/`action`/`formaction` for
`resolveClickNavTarget()` to resolve *before* the click fires — `hasTarget`
is correctly `false` for such an element, and `el.click()` still executes
(that part is unchanged and, per the M1 note below, structurally cannot be
avoided without refusing to click anything with an unpredictable handler at
all — which would break the product). **2026-07-12 (M2.2) update:** what
*can* now be caught is the RESULT — `extension/content/nav-watch.js` arms a
runtime watcher around every extension-executed click that classifies and
(where the platform allows) silently cancels any cross-origin/non-http(s)
navigation the click's handler triggers, using the Navigation API's
`navigate` event (see item #7/M2.2 above for the full mechanism and its own
honest limits — `window.open`/new-tab navigation and other-browsing-context
navigation remain genuinely unobservable, not merely unblocked). This
converts what was a pure "documented but unmitigated" residual into a
"detected-and-usually-blocked, with named exceptions" one — still not an
absolute guarantee, but no longer a hole with zero backstop.
It belongs in the honest residual-risk list, not in the guarantee.

**"Named exceptions," disclosed in full as of 2026-07-12 (an independent M2
verify found the two below were true but undisclosed — same standing rule
as the honesty-correction note further down this file):** beyond
`window.open`/new-tab and other-browsing-context navigation (already
disclosed above), the watcher's own `windowMs` (1500ms by default) is a
genuine TIMING escape — a click handler that defers its navigation past
that window (`setTimeout(() => location.href = '...', 1600)`) navigates
with the watcher already torn down and nothing armed to see it, and a
`<meta http-equiv="refresh">` navigation is never inside the watch window
in the first place (it isn't triggered by the click handler this extension
observed at all). Neither produces a `navigate` event within the armed
window, so neither is even DETECTED, let alone blocked — a strictly weaker
posture than the `window.open`/new-tab case, which is at least honestly
named as "not observable" right where the mechanism is described. See item
#7/M2.2's own entry above for the full, precise wording now covering these.
Not hardened in this pass — see that item's note on why (mechanism is fine;
the gap was that these two were true and unmentioned, which is the honesty
problem this update fixes, not necessarily the security problem, though
narrowing this residual remains open future work).

**2026-07-12:** the system prompt gained an explicit rule — "if no element on
the page satisfies the command, you MUST emit `abort`... never click a
merely-plausible or barely-related element as a guess" — plus a few-shot
example, in response to a verified gate-battery failure (the model reasoned
"no astronomy link exists" and then clicked an unrelated link anyway instead
of aborting). This is a prompt-hygiene mitigation, not a hard guarantee: it
measurably reduces one specific class of "wrong but legitimate-looking same-
origin click," but there is no code-level backstop for it the way there is
for credentials/scheme/origin — a same-origin click on the *wrong* element is
still something only the human approval gate and this prompt rule guard
against, not the executor. Re-running the exact regression case wasn't part
of this verification pass (no held-out negative-control page was crafted);
the fix is a targeted response to the documented failure mode, applied with
"do not overfit" as an explicit constraint, and its effect should be watched
in future battery runs rather than assumed.

**Honesty correction, 2026-07-12:** this document and README.md previously
claimed "a direct unit-level test that force-feeds a malicious fill-the-
password action straight into execute()" existed. It did not — no such file
was in the repo, and the gate battery never exercised the password block
either (the model aborted before reaching it in every observed run, so the
hard block itself was never actually proven to fire). Both claims have been
corrected to describe what's actually true now:
`tests/executor_credential.test.js` exists, passes 23/23 assertions, and
does exactly what was claimed — see README.md's "2026-07-12 security fix
round" section for the run output. Treat any "DONE"/"verified" claim in this
project's docs as suspect until you've re-run the thing it cites; this
incident is the reason why.

**The closed shadow root, by itself, was never a security boundary against a
determined page** — it raises the bar against casual interference (CSS
bleed-through, trivial DOM queries) but a page script still shares the same
document and input event stream. **2026-07-12 (M2.1) update:** this is now
addressed two ways, not one: top-layer rendering (Popover API) removes
ordinary page CSS/z-index as a vector entirely, and the execution-time
occlusion re-check (#11) independently catches the narrower remaining case
of another top-layer surface racing to cover the approval card — see
`tests/fixtures/occlusion-attack.html` for the adversarial page this is
proven against. The shadow root itself still isn't "a security boundary" in
isolation; the combination of top-layer + occlusion re-check is what closes
the gap, and the occlusion re-check is deliberately NOT redundant — it's
what protects the (documented, unlikely) case where top-layer isn't
available or is itself contested.

**What you approve is truthful about the target, not about the model's
stated reasoning.** The proposal card's gloss and detail lines are built
entirely from the action's `element`/`value` fields resolved against the
*real* live element (tag, role, accessible name) — never from the model's
`reason` string, which is unvalidated model prose and should be read as a
hint, not a guarantee. A human approving "fill [2] `<input>` role=searchbox
name=\"Search Wikipedia\" with \"intel arc\"" is trusting the DOM
introspection, not the model's explanation of why it chose that.

**CPU latency (2–8s per LLM call observed on this box) was incidentally
self-limiting** against rapid-fire approval fatigue in M1, but that was a
side effect of hardware, not a designed rate limit. **2026-07-12 (M2.3)
update:** this is now closed by an actual, deterministic, hardware-
independent limiter (`extension/content/ratelimit.js`, see #7 above) —
GPU-backed deployments (this box's current default is GPU, sub-2s p50) no
longer lose their only protection against burst/rubber-stamping abuse.

**M2 additions, consolidated honest-limits summary (see the individual
items above for full detail):** the M2.2 navigation watcher cannot see
`window.open()`/new-tab navigation or navigation of a browsing context
other than the one the click ran in (deliberately not requesting the
`tabs`/`webNavigation` permission this would need), and — disclosed
2026-07-12 — cannot see a navigation a click handler defers past its
1500ms watch window, or a `<meta http-equiv="refresh">` navigation (neither
produces an event inside the armed window at all); the M2.4 extractor
structurally cannot and does not enter cross-origin iframes or closed
shadow roots (both are platform-enforced, not extension policy choices);
the M2.1 occlusion re-check fails closed (treats "can't check" as
"occluded") rather than assuming safety if `elementsFromPoint` is ever
unavailable; the M2.3 rate limiter's constants (20 LLM calls/60s, 10
executed actions/60s) are judgment calls about "sane defaults" for an
interactive, human-approved terminal, not a formally derived bound — they
may need tuning as real usage patterns emerge.

## M3 — persistent command browser (2026-07-12, design doc)

M3 turns the terminal into a command-line BROWSER: `go` navigates anywhere
(not just same-origin link clicks), state survives the content-script
re-injection every navigation causes, aliases/macros formalize a small DSL,
and `&&` chains a handful of steps together. This section covers the new
trust boundary M3 introduces and its honest residuals; items #1-#13 above
are otherwise unchanged by M3 (M3 is not a security-hardening pass over
M1/M2's existing controls — the page-lane's same-origin hard block, the
credential guard, the occlusion re-check, the rate limiter, and nav-watch.js
are all UNTOUCHED, byte-for-byte in the case of every M1/M2 hard-block
predicate in `guards.js`/`executor.js`).

### The trust split (normative — everything else in this section derives from it)

Two channels, never mixed, and — this is the important part — **provenance
is carried by WHICH CODE PATH produced an action, never by a flag on the
action object itself.** There is no `trusted: true` field anywhere in this
codebase; a boolean flag can be forged, defaulted wrong, or silently
dropped by a future refactor in a way a code-path distinction cannot be.

- **TRUSTED: user-typed terminal input.** Keystrokes a human physically
  types into the closed-shadow input (gated by isTrusted — see H1 below).
  Address-bar-equivalent authority: `go` may navigate cross-origin, unlike
  everything the LLM lanes can propose. The `&&` chain queue (design §5)
  only ever holds STRINGS THAT WERE ONCE TYPED THIS WAY — a macro's stored
  body is itself only ever writable by a typed `macro` command (see the
  alias-poisoning analysis below), so even a queued/replayed segment traces
  back to a keystroke, not to page or model output, by construction.
- **UNTRUSTED: everything read from a page** — element lists, titles,
  extracted text, and (critically, unchanged from M1/M2) any model output
  produced from a prompt that contained page data. Untrusted-derived actions
  stay same-origin-scoped and approval-gated exactly as before; page-lane's
  `navigate`/click cross-origin hard block is BYTE-FOR-BYTE UNCHANGED by
  this build (`extension/content/guards.js`'s `safeSameOriginHttpUrl`/
  `checkClickTarget`/`resolveClickNavTarget` were not edited at all except
  for the new, additive `isTrustedInputEvent` export at the bottom of the
  file — see `git diff` on that file for confirmation).

### Why a second LLM lane exists, and why isolation is proven by a payload test, not by prompting

`go`'s resolution ladder (design §2) is fully deterministic for steps 1-2
(literal URL/domain, alias lookup) — the model is never consulted for those.
Step 3 (an NL destination like `go the arch linux wiki`) needs a model call,
but routing that through the EXISTING page-lane prompt (which carries the
element list/title/origin) would mean a hostile page could, in principle,
try to bias that call the same way it can try to bias page-lane's action
choice today — even though `go`'s own cross-origin allowance means the
consequence would be worse than page-lane's (page-lane's own worst case is
still same-origin-hard-blocked).

The fix is not "tell the model harder not to listen to the page" (that is
prompt-level separation — the model as a security boundary, a scope-lock
violation per the plan). The fix is that **the nav-lane prompt structurally
cannot contain page data at all** — `service-worker.js`'s
`buildNavLanePayload(msg)` reads exactly one field off its input
(`msg.command`) and nothing else, regardless of what other fields the
caller's message object happens to carry. Because there is no code path by
which an element list, title, origin, or scrollback line could ever reach
this function's output, a hostile page has *nothing to inject into* — not
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
asserted to have EXACTLY the key `command` — nothing else. A contrasting
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
still passes untouched — no new network sink was added, only a second
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
the check) — the isolation removes the page-injection vector, it does not
exempt the model's own output from the http(s)-only scheme floor everything
else in this extension is held to.

### Queue risks (design §5's `&&` chaining)

The queue (SW-backed, per tab, `chrome.storage.session`, mirrors the RL_*
persistence pattern via `termstate:<tabId>`) only ever holds strings that
were typed or expanded from a typed alias/macro — see the trust-split
section above. The two residuals that follow from a persisted, cross-
navigation command queue, both accepted and mitigated as described:

1. **A compromised/redirecting destination could otherwise run the next
   queued command on an attacker's page.** This is exactly what the
   arrival check (`nav.js`'s `checkArrival()`, consulted by
   `terminal.js`'s `_advanceQueue()` on every continuation, including the
   first thing a freshly re-injected `Terminal` does) exists to stop:
   `location.origin` at continuation time must EXACTLY equal the origin
   recorded at enqueue/navigate time, or the queue halts with an explicit
   `arrived at X, expected Y — queue halted` message and requires the human
   to re-issue by hand. This is fail-closed by construction (a null/
   unparseable current origin with an expected origin recorded also halts —
   see `tests/m3_go_resolution.test.js`'s "current origin unknown" case) —
   not a best-effort heuristic. **Residual:** the arrival check only
   verifies ORIGIN, not the full URL/path — a same-origin open redirect
   that lands the tab on a different PAGE within the expected origin is not
   caught by this check (same posture the M1/M2 nav-watch honest-limits
   section already documents for a narrower case: origin-level checks
   cannot see intra-origin manipulation). This is an accepted scope limit,
   not an oversight — a same-origin redirect is not new attacker leverage
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
   navigation that never actually happens — the canonical case is the
   formless-`search` synthetic-Enter path against a JS search box that
   filters in place instead of navigating. The queue then stays pending:
   it is cleared/overwritten the moment the user types anything
   (`_runChain()`'s lone-command `TS_QUEUE_CLEAR`), but if the user instead
   navigates manually first, a later same-origin arrival re-runs the stale
   queued segment (visibly — echoed in the terminal; cross-origin arrivals
   halt as usual). Display-only worst case; mutating segments still hit the
   approval gate + budgets wherever they run. A queue TTL would close it;
   deferred as not worth the machinery at this severity.
2. **Any error/block/rejection/Esc clears the whole queue** (`terminal.js`'s
   `_afterSettle(ok)` is the single choke point enforcing this — every
   CHAIN-PARTICIPATING dispatch path calls it exactly once per settle.
   **Correction (fix round, independent security verify):** the original
   wording of this note said "every dispatch path in the file," which
   over-generalizes — the meta-command handlers (`_handleAliasCommand`/
   `_handleMacroCommand`/`_handleUnaliasCommand`/`_handleUnmacroCommand`/
   `_handleDevCommand`/`_handleOrigins`, plus the inline `continue`/`budget`
   branches) settle via `_settle()` directly, WITHOUT ever calling
   `_afterSettle()`. That is not a gap in the guarantee above: all eight are
   intercepted by `_submitCommand`'s own regex dispatch BEFORE `_runChain`
   (and therefore before any `&&` splitting) is even attempted, and
   `_dispatchSegment()` — the one function a queued/chain segment is ever
   run through, whether it's the first segment of a freshly-typed chain or a
   later one popped off the SW-backed queue after a navigation — never
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
   etc. — unmodified by this build) don't have a structured success/failure
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
  on RAW TYPED TEXT (`/^alias(\s|$)/i`/`/^macro(\s|$)/i`) — never from
  `_dispatchSegment` (the path a page-lane/nav-lane action or a queued
  chain segment goes through), never from `executor.js`'s action vocabulary
  (there is no `alias`/`macro`-defining action in either LLM lane's fixed
  vocabulary — see the registry-cannot-extend-model-vocabulary test below),
  and never from any chrome.storage write outside this one file. A page has
  no channel to `chrome.storage.local` at all (content scripts don't expose
  their storage bindings to page JS, and this extension never bridges one).
- **Backing store is `chrome.storage.local`, not `session`, and is NOT
  sandboxed per-tab or per-site** — an alias/macro defined on one site is
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
  `search`, or any other built-in) every time it was typed thereafter — a
  real footgun, not a cosmetic naming clash, since the entire `go`
  resolution ladder (including its confirm-on-first-visit/model-resolved
  friction) would simply stop being reachable by its own name. Closed by a
  `RESERVED_NAMES` set in `registry.js`'s `setAlias`/`setMacro`, checked at
  write time — see `tests/m3_chain_and_alias_macro.test.js`'s "an alias
  named 'go'" / "a macro named 'go'" cases. This is a build-time-found
  correctness fix disclosed here per this project's standing rule of
  surfacing what was actually found, not just what the design doc asked
  for.
- **Depth-1 lock (macros cannot reference macros)** is enforced at
  DEFINITION time in `setMacro` — a macro body's segments are checked
  against the currently-defined macro names before being accepted, not
  merely "not expanded recursively" at run time. This closes a subtler
  poisoning shape: without a definition-time check, a human could define
  `macro a = go x && b`, then separately (and confusingly, at a later,
  unrelated moment) define `macro b = a`, and now invoking `a` again would
  silently no longer do what its own definition says (since `expandMacro`
  only ever performs one substitution — it would just run the literal text
  `b`, not `a`'s original chain). Rejecting the SECOND definition at write
  time (`"b" cannot reference macro "a"` — wait, in this concrete case it's
  `a` that already exists and referencing `a` from a NEW macro is what gets
  rejected) keeps the invariant "what a macro's stored body says is exactly
  what running it will do" intact, rather than relying on run-time
  non-recursion alone to make an already-confusing edit merely inert
  instead of also disallowed.

### Typosquat residual (nav-lane / model-resolved destinations)

`go the arch linux wiki` resolving to a plausible-but-wrong domain (a
typosquat, a similarly-named unofficial mirror, or simply the model's best
guess being wrong) is a real, NOT eliminated residual — this build's
mitigation is procedural (a human reads the destination before it fires),
not cryptographic or allowlist-based:

- **Every model-resolved (nav-lane) destination ALWAYS requires
  confirmation, regardless of whether the origin was already visited this
  tab session** — unlike a deterministic `go` hit (literal/alias), which
  only confirms on first visit to a new origin. This is deliberate friction
  asymmetry (design §2's decided friction tiers, plan §13 item 1): a
  human-typed literal domain is address-bar-equivalent trust; a
  model-guessed one is not, no matter how many times it's been approved
  before, because a DIFFERENT wrong guess is a fresh risk each time, not a
  repeat of a previously-vetted one.
- The confirmation card explicitly labels the destination `NAVIGATION: go
  to <full URL>` plus `(model-resolved destination — read it before
  approving)` in the detail line (`terminal.js`'s `_confirmOrNavigate`) —
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
  above) — extended here to a cross-origin destination specifically because
  `go` is the first M3 mechanism able to reach one at all via a model call.

### Test-hook gating (H2)

`terminal.js`'s `data-lfl-state` attribute (pending-proposal contents,
rate-limit budget, mode, last result) is set on `#lfl-terminal-host`, which
lives in the PAGE'S OWN LIGHT DOM (the closed shadow root only hides the
overlay's internal contents — this host-level attribute is readable by any
page script via a plain `getAttribute`/`MutationObserver`, same as any
other DOM attribute). Pre-M3 this was emitted unconditionally — fine for a
private spike, wrong default for a public product: a page could observe
the approval flow's timing, contents, and rate-limit state on every load.

M3 gates it behind a `lflDevHooks` flag in `chrome.storage.local`
(`terminal.js`'s `_updateTestHook()` — see the H2 comment right above the
gating `if`), **OFF by default**, toggled only by a typed `dev on`/`dev
off` command (`_handleDevCommand`, itself only reachable from
`_submitCommand`'s typed-text regex dispatch, same write-path posture as
alias/macro). When off, any previously-set attribute is actively removed
(`removeAttribute`), not merely left un-updated — a page cannot read a
stale-but-still-present value from before the flag was toggled off.

**What the Playwright battery agent needs to know:** the battery must
either type `dev on` before relying on `data-lfl-state`, or pre-seed
`chrome.storage.local.set({lflDevHooks: true})` before the content script
injects (the flag is read once, async, at `Terminal` construction — see
`_loadDevHooksFlag()`). Without one of those, `host.getAttribute('data-lfl-
state')` will be `null` and any battery logic that polls it will need a
different signal (or the battery should simply always seed the flag at
profile setup, since the battery agent's own trust level is far higher than
an arbitrary page's).

### `event.isTrusted` gating (H1)

Every one of `terminal.js`'s four input-reactive handlers —
`_onGlobalKeydown`, `_onInputKeydown`, the Approve button's click listener,
the Reject button's click listener — now calls
`guards.isTrustedInputEvent(e)` as its first statement and returns early on
`false`. The concrete threat: our overlay host element lives in the page's
light DOM (events from inside the closed shadow root are retargeted to it —
see `_onGlobalKeydown`'s own comment), so a page can dispatch a SYNTHETIC
`KeyboardEvent`/`MouseEvent` at it (`el.dispatchEvent(new
KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`) with
`event.isTrusted === false`. Pre-M3 the practical impact of that was
narrow (a synthetic Escape could reject a pending proposal — a
harmless-direction DoS, not a mutation hole, since REJECT is always the
safe direction). M3 leans much harder on "terminal input is trusted because
a human typed it" (the whole `go`/alias/macro/queue trust model above), so
this is made an explicit, tested invariant rather than an implicit
side-effect of REJECT-only being reachable.

**Honest test-coverage limitation:** `guards.isTrustedInputEvent()` itself
is a pure predicate, fully unit-tested (`tests/m3_hardening.test.js` Part
1) — trivial logic, but load-bearing. The actual DOM WIRING (that each of
the four handlers really does call it, and really does return early)
is proven only by a STATIC SOURCE-SHAPE check in the same test file, not a
full behavioral DOM test with real vs. synthetic events — `terminal.js` has
never had a direct Node unit-test harness in this project (it needs
`attachShadow`/`popover`/`elementsFromPoint`/a real event-dispatch pipeline,
a much heavier DOM surface than `guards.js`/`executor.js`/`ratelimit.js`
need, which is why those three have been the ones directly `vm`-loaded
since M1/M2). This is disclosed as a real, documented gap: the source-shape
test fails if the guard call is ever textually removed from one of the four
sites, but it cannot catch a change that keeps the call present while
subtly breaking its effect (e.g. an `||` typo inverting the condition). The
Playwright battery, which DOES drive a real browser, is the place a
behavioral proof of this control belongs — a fixture page that dispatches a
synthetic Escape/click at the overlay host and asserts no state change
occurred would close this gap; it was not in this build's required test
list (design §11 lists it as a unit-test item, and a unit test is what was
built) and is flagged here as follow-up work for the battery agent or a
future pass, not silently omitted.

### H3 — TS_* responses are data, not code

Every `TS_*` handler in `service-worker.js` returns plain JSON-serializable
data (strings/booleans/arrays of strings) — see the comment directly above
`handleTerminalStateMessage`. On the content-script side, restored
scrollback lines are rendered via `_appendLineDom`'s `.textContent`
assignment (never `innerHTML`, never a template that could be reinterpreted
as markup); a popped queue segment is a plain string handed to the SAME
`_dispatchSegment` path ordinary typed input already goes through — it is
never `eval`'d, and it was never anything other than previously-typed text
to begin with (see the trust-split section above). There is no code path in
this build that constructs a DOM subtree, a `Function`, or a dynamic
`import()` from a TS_* response field.
