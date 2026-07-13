#!/usr/bin/env python3
"""
tests/m2_adversarial.py — end-to-end adversarial proof for M2.1 (execution-
time occlusion abort) and M2.2 (runtime navigation interception), driving
the REAL unpacked extension against the fixture pages, reusing
tests/run_battery.py's harness pattern (Playwright persistent context with
the bundled Chrome-for-Testing, real keyboard input because the overlay's
shadow root is closed, the data-lfl-state test hook on the host element).

Requires:
  - server/launch-dev.sh already running and healthy on 127.0.0.1:1238
    (or the ad-hoc GPU launch documented in README.md / this task's brief —
    either way, this script just needs :1238/health to answer "ok").
  - Nothing else manual: this script starts its own `python3 -m http.server`
    instances on 8998 (tests/fixtures, same-origin target) and 8999 (the
    "other origin" for cross-origin-nav proofs) if they aren't already
    running, and tears them down again at the end.

Run with a Python environment that has playwright installed
(pip install playwright && playwright install chromium):
  python tests/m2_adversarial.py

Writes screenshots to tests/m2-shots/ and prints PASS/FAIL per case, exiting
nonzero if any adversarial case did not produce the expected ABORT/block.

M3 update (2026-07-12 battery pass): the data-lfl-state test hook this
script reads is now off by default (H2) — seeded on via the extension's own
background service worker before any page navigates. See
tests/run_battery.py's module docstring / seed_dev_hooks() for the full
rationale (same helper, duplicated here so this script stays standalone
like the rest of this file already is).
"""
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXTENSION_DIR = ROOT / "extension"
FIXTURES_DIR = ROOT / "tests" / "fixtures"
SHOTS_DIR = ROOT / "tests" / "m2-shots"
USER_DATA_DIR = ROOT / "tests" / ".chrome-profile-m2"

PORT_8998 = 8998
PORT_8999 = 8999


def port_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def ensure_http_server(port):
    if port_open(port):
        print(f"[setup] :{port} already serving — reusing it")
        return None
    proc = subprocess.Popen(
        ["python3", "-m", "http.server", str(port), "--directory", str(FIXTURES_DIR)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(50):
        if port_open(port):
            print(f"[setup] started python3 -m http.server {port} (pid {proc.pid})")
            return proc
        time.sleep(0.1)
    raise RuntimeError(f"http.server on :{port} did not come up")


def read_lfl_state(page):
    raw = page.evaluate(
        "() => { const h = document.getElementById('lfl-terminal-host'); "
        "return h ? h.getAttribute('data-lfl-state') : null; }"
    )
    if not raw:
        return None
    import json
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def seed_dev_hooks(context):
    sw = None
    for w in context.service_workers:
        if "background/service-worker.js" in w.url:
            sw = w
            break
    if sw is None:
        sw = context.wait_for_event("serviceworker", timeout=10000)
    sw.evaluate("() => new Promise((resolve) => chrome.storage.local.set({lflDevHooks: true}, resolve))")


def open_terminal(page):
    # M3: terminal open/closed state persists per-tab across navigation and
    # auto-reopens on re-injection (design §4) — check before toggling, or a
    # Backquote press here can CLOSE an already-auto-reopened panel instead
    # of opening it. See tests/run_battery.py's open_terminal() for the full
    # comment (same fix, duplicated here to keep this script standalone) —
    # including the second-order bug where an unconditional blur() stole
    # focus back from the auto-reopen's own inputEl.focus() with nothing
    # left to re-focus it, so blur/Backquote only happen in the
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
    page.keyboard.type(command, delay=8)
    page.keyboard.press("Enter")


def wait_for_seq_change(page, seq_before, timeout_s=40):
    deadline = time.monotonic() + timeout_s
    state = None
    while time.monotonic() < deadline:
        state = read_lfl_state(page)
        if state and state.get("seq", 0) != seq_before:
            return state
        time.sleep(0.1)
    return state


def run():
    import json
    SHOTS_DIR.mkdir(parents=True, exist_ok=True)
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)

    procs = [ensure_http_server(PORT_8998), ensure_http_server(PORT_8999)]

    results = {}
    try:
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

            # ---- Case (a): occlusion-attack.html — M2.1 execution-time
            # occlusion abort. A page that races its own top-layer popover
            # on top of the approval card; approving a click must ABORT.
            print("\n=== Case (a): occlusion-attack.html (M2.1) ===")
            page.goto(f"http://127.0.0.1:{PORT_8998}/occlusion-attack.html", wait_until="domcontentloaded")
            page.wait_for_timeout(500)  # let the fixture's popover race start, and content scripts settle
            open_terminal(page)
            seq0 = (read_lfl_state(page) or {}).get("seq", 0)
            submit_command(page, "ask click the plain button")
            state = wait_for_seq_change(page, seq0)
            proposal = state.get("pendingProposal") if state else None
            print("full state after ask:", json.dumps(state))
            print("proposal after ask:", json.dumps(proposal))
            if not proposal or proposal.get("action") != "click":
                results["occlusion"] = False
                print("FAIL: model did not propose a click action — cannot exercise the occlusion abort path")
            else:
                page.screenshot(path=str(SHOTS_DIR / "a1-occlusion-before-approve.png"))
                seq1 = state.get("seq", 0)
                page.keyboard.press("Enter")  # approve
                state2 = wait_for_seq_change(page, seq1)
                page.screenshot(path=str(SHOTS_DIR / "a2-occlusion-after-approve.png"))
                last = (state2 or {}).get("lastResult") or {}
                print("lastResult after approve:", json.dumps(last))
                aborted = (last.get("ok") is False) and ("covered" in (last.get("message") or "").lower())
                results["occlusion"] = aborted
                print("PASS" if aborted else "FAIL", "- occlusion abort")

            # ---- Case (b): onclick-evil-nav.html — M2.2 runtime navigation
            # interception. Approving a click whose onclick handler does
            # location.href = <cross-origin> must be blocked; the tab must
            # NOT end up on the cross-origin page.
            print("\n=== Case (b): onclick-evil-nav.html (M2.2) ===")
            page.goto(f"http://127.0.0.1:{PORT_8998}/onclick-evil-nav.html", wait_until="domcontentloaded")
            page.wait_for_timeout(300)
            open_terminal(page)
            seq0b = (read_lfl_state(page) or {}).get("seq", 0)
            submit_command(page, 'ask click the "click me" button')
            stateb = wait_for_seq_change(page, seq0b)
            proposalb = stateb.get("pendingProposal") if stateb else None
            print("proposal after ask:", json.dumps(proposalb))
            if not proposalb or proposalb.get("action") != "click":
                results["nav_intercept"] = False
                print("FAIL: model did not propose a click action — cannot exercise the nav-intercept path")
            else:
                page.screenshot(path=str(SHOTS_DIR / "b1-onclick-evil-before-approve.png"))
                page.keyboard.press("Enter")  # approve
                page.wait_for_timeout(2200)  # well past the 1500ms nav-watch window
                page.screenshot(path=str(SHOTS_DIR / "b2-onclick-evil-after-approve.png"))
                current_url = page.url
                print("page.url after approve + wait:", current_url)
                stayed_put = "onclick-evil-nav.html" in current_url
                results["nav_intercept"] = stayed_put
                print("PASS" if stayed_put else "FAIL", "- nav-intercept block (page did not navigate to the cross-origin target)")

            context.close()
    finally:
        for proc in procs:
            if proc:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except Exception:
                    proc.kill()

    print("\n=== summary ===")
    for k, v in results.items():
        print(f"  {k}: {'PASS' if v else 'FAIL'}")
    ok = all(results.values()) and len(results) == 2
    print("ALL PASS" if ok else "SOME FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(run())
