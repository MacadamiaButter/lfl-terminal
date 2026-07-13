#!/usr/bin/env python3
"""
tests/run_battery.py — drives the unpacked lfl-terminal extension against the
battery in tests/battery.json using a real Chrome instance (Playwright
persistent context, channel="chrome"), and writes tests/results.json plus a
summary table to stdout.

Run with a Python environment that has playwright installed
(pip install playwright && playwright install chromium):
  python tests/run_battery.py

Requires: server/launch-dev.sh already running and healthy on 127.0.0.1:1238.

Browser note (deviation from the original spec): channel="chrome" (the real
/usr/bin/google-chrome, "Google Chrome 150") REFUSES both --load-extension and
--disable-extensions-except on the command line ("... is not allowed in Google
Chrome, ignoring." — verified empirically). That lockdown is specific to the
Google-branded stable build; it is not present in Playwright's own bundled
Chromium (a "Google Chrome for Testing" build), which this script uses
instead via a plain launch_persistent_context() with no `channel=` argument.
It also needs --no-sandbox in this container (no working setuid/userns
sandbox here) — verified as the actual failure mode via --enable-logging.

Latency note: this box runs the local model on CPU (-ngl 0) for this spike, per
spec. CPU latency will very likely miss any <3s gate; this script MEASURES AND
REPORTS latency honestly — it does not tune or hide the gate. A GPU run is a
follow-up, not part of this script.

M3 update (2026-07-12 battery pass): the `data-lfl-state` test hook this
whole harness reads is now OFF by default (design doc §8 H2 — see
terminal.js's `_updateTestHook()`/`_loadDevHooksFlag()`). Seeding it from
page-context JS isn't possible (storage.local isn't reachable from a content
script's page world the way this harness drives pages), and driving it via a
typed `dev on` command has a chicken-and-egg problem: open_terminal() itself
polls the SAME attribute to know the panel opened. See seed_dev_hooks()
below — it sets `lflDevHooks` directly through the extension's own
background service worker (Playwright's `context.service_workers`), before
any page in this run ever navigates. The default-off behavior itself (H2
gating) is separately, explicitly proven in tests/m3_battery.py, which
starts from a clean profile and asserts the attribute is ABSENT before
enabling it — this file only needs the hook ON to do its job.
"""
import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXTENSION_DIR = ROOT / "extension"
BATTERY_PATH = ROOT / "tests" / "battery.json"
RESULTS_PATH = ROOT / "tests" / "results.json"
USER_DATA_DIR = ROOT / "tests" / ".chrome-profile"

COMMAND_SUBMIT_TIMEOUT_MS = 40000  # local CPU inference can take several seconds
POLL_INTERVAL_S = 0.1


def seed_dev_hooks(context):
    """M3 H2: turn on the data-lfl-state test hook via the extension's own
    background service worker (chrome.storage.local), before any page in
    this context navigates. See module docstring."""
    sw = None
    for w in context.service_workers:
        if "background/service-worker.js" in w.url:
            sw = w
            break
    if sw is None:
        sw = context.wait_for_event("serviceworker", timeout=10000)
    sw.evaluate("() => new Promise((resolve) => chrome.storage.local.set({lflDevHooks: true}, resolve))")


class Navigated(Exception):
    """Raised by read_lfl_state when the page navigated out from under us —
    which for this extension is a real, valid outcome: a deterministic
    `search`/`open` command or an approved click/navigate proposal is
    SUPPOSED to navigate the page. It just means the poll loop's execution
    context died and there is nothing more to read on the old document."""


def read_lfl_state(page):
    """Read the data-lfl-state attribute off the overlay host (outside the
    closed shadow root — this is the test hook the spec asks for)."""
    try:
        raw = page.evaluate(
            "() => { const h = document.getElementById('lfl-terminal-host'); "
            "return h ? h.getAttribute('data-lfl-state') : null; }"
        )
    except Exception as e:  # noqa: BLE001
        if "context was destroyed" in str(e).lower() or "navigation" in str(e).lower():
            raise Navigated(str(e)) from None
        raise
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def open_terminal(page):
    # The overlay's shadow root is CLOSED by design (spec: limit page CSS/JS
    # interference), which also means page.evaluate cannot reach `.shadowRoot`
    # or query/dispatch synthetic events into it from outside — that property
    # is hidden by the browser regardless of extension privilege. Real
    # `page.keyboard` input, however, is delivered by Chrome's Input domain to
    # whatever element actually has focus, independent of shadow-root
    # visibility/closedness — so keyboard-only driving is what this script
    # uses throughout instead of DOM piercing.
    #
    # M3 update: terminal open/closed state now persists per-tab across
    # navigation and auto-reopens on content-script re-injection if it was
    # open before (design §4). Since this harness reuses the SAME tab across
    # every battery entry, the panel may already be open by the time this
    # runs (auto-reopened) — blindly pressing Backquote in that case would
    # TOGGLE IT CLOSED instead of opening it, which is exactly what caused
    # every other entry to time out waiting for open:true before this fix.
    # Check first; only press Backquote if it's actually closed.
    #
    # Second-order bug found while fixing the first one: the pre-existing
    # blur() call (to clear any accidental page-field focus before Backquote
    # so the global keydown handler's `inEditable` check doesn't swallow it)
    # must NOT run when the panel is already auto-reopened — the SW-driven
    # auto-reopen path (_restoreTerminalState() -> open() -> inputEl.focus())
    # runs asynchronously and had usually already focused the terminal input
    # by the time this function runs; blurring unconditionally stole that
    # focus right back with nothing left to re-focus it (Backquote is
    # skipped in this branch), so every typed command after the very first
    # one on a page silently went nowhere and every entry timed out at
    # COMMAND_SUBMIT_TIMEOUT_MS. Only blur/press Backquote in the
    # actually-closed branch now.
    already_open = page.evaluate(
        "() => { const h = document.getElementById('lfl-terminal-host'); "
        "if (!h) return false; const s = h.getAttribute('data-lfl-state'); "
        "if (!s) return false; try { return JSON.parse(s).open === true; } catch(e) { return false; } }"
    )
    if not already_open:
        page.evaluate("() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }")
        page.keyboard.press("Backquote")
    page.wait_for_function(
        "() => { const h = document.getElementById('lfl-terminal-host'); "
        "if (!h) return false; const s = h.getAttribute('data-lfl-state'); "
        "if (!s) return false; try { return JSON.parse(s).open === true; } catch(e) { return false; } }",
        timeout=5000,
    )


def submit_command(page, command):
    """Type the command into the (really-focused) terminal input and press
    Enter, via real keyboard events — see the note in open_terminal()."""
    page.keyboard.type(command, delay=8)
    page.keyboard.press("Enter")


def main():
    battery = json.loads(BATTERY_PATH.read_text())
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)

    results = []
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(USER_DATA_DIR),
            headless=False,
            args=[
                f"--disable-extensions-except={EXTENSION_DIR}",
                f"--load-extension={EXTENSION_DIR}",
                "--no-first-run",
                "--no-sandbox",
            ],
        )
        seed_dev_hooks(context)
        page = context.pages[0] if context.pages else context.new_page()

        for i, entry in enumerate(battery):
            site = entry["site"]
            command = entry["command"]
            expect = entry["expect"]
            row = {"index": i, "site": site, "command": command, "expect": expect}
            try:
                page.goto(site, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(600)  # let document_idle content scripts settle

                open_terminal(page)
                seq_before = (read_lfl_state(page) or {}).get("seq", 0)

                t0 = time.monotonic()
                submit_command(page, command)

                # terminal.js bumps a monotonic `seq` counter at every command
                # "settle" point (deterministic result printed, proposal
                # rendered awaiting approval, or LLM error surfaced) and
                # exposes it on data-lfl-state. Poll for that instead of a
                # fixed sleep, so latency is measured as real submit->settle
                # time for BOTH deterministic and LLM-path commands.
                state = None
                navigated = False
                deadline = time.monotonic() + (COMMAND_SUBMIT_TIMEOUT_MS / 1000)
                while time.monotonic() < deadline:
                    try:
                        state = read_lfl_state(page)
                    except Navigated:
                        navigated = True
                        break
                    if state and state.get("seq", 0) != seq_before:
                        break
                    time.sleep(POLL_INTERVAL_S)
                latency_ms = round((time.monotonic() - t0) * 1000)
                if navigated:
                    page.wait_for_load_state("domcontentloaded", timeout=10000)
                    row["navigated"] = True
                proposal = state.get("pendingProposal") if state else None

                row["latency_ms"] = latency_ms
                row["proposal"] = proposal
                row["required_approval"] = proposal is not None

                if proposal:
                    action = proposal.get("action")
                    row["observed_action"] = action
                    must_not = expect.get("must_not", [])
                    approval_needed = action in ("click", "fill", "select", "navigate")
                    if approval_needed:
                        seq_before_verdict = state.get("seq", 0)
                        # Approve everything requires_approval_if allows (including the
                        # deliberate fill-password-field regression probes, so we can
                        # confirm the executor's hard block — not just approval-gating —
                        # actually refuses it); reject anything else to avoid mutating
                        # the page unexpectedly.
                        approve = ("fill-password-field" in must_not) or (action in expect.get("requires_approval_if", []))
                        page.keyboard.press("Enter" if approve else "Escape")
                        row["verdict"] = "approved" if approve else "rejected"
                        vdeadline = time.monotonic() + 5
                        while time.monotonic() < vdeadline:
                            try:
                                s2 = read_lfl_state(page)
                            except Navigated:
                                # approving click/navigate is expected to leave the page —
                                # that IS the successful outcome for those two actions.
                                row["navigated"] = True
                                page.wait_for_load_state("domcontentloaded", timeout=10000)
                                state = None
                                break
                            if s2 and s2.get("seq", 0) != seq_before_verdict:
                                state = s2
                                break
                            time.sleep(POLL_INTERVAL_S)
                    row["last_result"] = state.get("lastResult") if state else None
                    if "fill-password-field" in must_not and action == "fill":
                        lr = row["last_result"] or {}
                        row["hard_block_enforced"] = (lr.get("ok") is False)
                else:
                    row["observed_action"] = expect["valid_actions"][0] if expect.get("type") == "deterministic" else None
                    row["last_result"] = state.get("lastResult") if state else None

                row["ok"] = True
            except Exception as e:  # noqa: BLE001 — battery must keep going on a single bad entry
                row["ok"] = False
                row["error"] = str(e)
            results.append(row)
            print(f"[{i+1:02d}/{len(battery)}] {site.split('//')[1].split('/')[0]:24s} "
                  f"{command[:40]:40s} -> "
                  f"{'ERROR: ' + row.get('error','') if not row['ok'] else row.get('observed_action') or expect.get('valid_actions')} "
                  f"({row.get('latency_ms','?')}ms)")

        context.close()

    RESULTS_PATH.write_text(json.dumps(results, indent=2))

    print("\n=== summary ===")
    n = len(results)
    n_ok = sum(1 for r in results if r.get("ok"))
    llm_rows = [r for r in results if r["expect"].get("type") == "llm" and r.get("ok")]
    latencies = [r["latency_ms"] for r in llm_rows if r.get("latency_ms") is not None]
    print(f"entries run: {n}, no-exception: {n_ok}")
    if latencies:
        latencies.sort()
        p50 = latencies[len(latencies)//2]
        print(f"LLM-path latency (submit->proposal-or-timeout), n={len(latencies)}: "
              f"min={min(latencies)}ms p50={p50}ms max={max(latencies)}ms")
    print(f"results written to {RESULTS_PATH}")


if __name__ == "__main__":
    main()
