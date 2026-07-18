#!/usr/bin/env python3
"""
tests/m6_expect_wait_smoke.py - live-browser smoke check for "recipes that
succeed" (LFL-TERMINAL-RECIPES-THAT-SUCCEED-DESIGN.md): `wait for ...`
succeeding on a delayed-render element, and a failing `expect` halting a
typed `&&` chain (design §9 sign-off D). Reuses the same driving pattern as
tests/popover_smoke.py (Playwright persistent context, real keyboard input,
the data-lfl-state test hook via `dev on`).

DETERMINISTIC-ONLY, same posture as popover_smoke.py: neither `expect` nor
`wait` ever calls a model (design §2.1/§2.2 - no chrome.runtime.sendMessage
to either LLM lane, no rate-limit budget spent), so this script needs NO
local model server running.

Honest note: authored blind (no playwright in the build environment) and
first RUN 2026-07-17 via lfl-lab's harness venv
(harness/.venv/bin/python). The first run exposed a race in this script's
own case-1 predicate (stale `dev on` settle matched an any-settle poll),
fixed by naming the final settle line; the product behaved correctly in
both cases from the start. Run with:
  <lfl-lab>/harness/.venv/bin/python tests/m6_expect_wait_smoke.py
or install playwright + chromium and use plain python3.

Writes screenshots to tests/m6-shots/ and prints PASS/FAIL per case, exiting
nonzero if any case failed.
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
SHOTS_DIR = ROOT / "tests" / "m6-shots"
USER_DATA_DIR = ROOT / "tests" / ".chrome-profile-m6-smoke"

PORT = 8996

ok_all = True


def check(name, cond, detail=""):
    global ok_all
    status = "ok  " if cond else "FAIL"
    print(f"  {status} - {name}" + (f"  ({detail})" if detail else ""))
    if not cond:
        ok_all = False


def port_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def ensure_http_server(port):
    if port_open(port):
        print(f"[setup] :{port} already serving - reusing it")
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


def is_open(page):
    s = read_lfl_state(page)
    return bool(s and s.get("open") is True)


def wait_open_state(page, want_open, timeout_ms=5000):
    page.wait_for_function(
        "(want) => { const h = document.getElementById('lfl-terminal-host'); "
        "if (!h) return false; const s = h.getAttribute('data-lfl-state'); "
        "if (!s) return false; try { return JSON.parse(s).open === want; } catch(e) { return false; } }",
        arg=want_open,
        timeout=timeout_ms,
    )


def toggle_terminal(page):
    """Backtick toggles open/closed - blur first so a focused input doesn't
    just insert a literal backtick character (same fix m3_battery.py's
    open_terminal() documents)."""
    page.evaluate("() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }")
    was_open = is_open(page)
    page.keyboard.press("Backquote")
    wait_open_state(page, not was_open)


def submit_command(page, command, settle_wait_s=0.3):
    """Types + Enters a command. `settle_wait_s` is a floor only - callers
    that need to wait on an async wait/expect result poll
    wait_for_last_result() below instead of trusting this sleep alone."""
    page.keyboard.type(command, delay=8)
    page.keyboard.press("Enter")
    time.sleep(settle_wait_s)


def wait_for_last_result(page, predicate, timeout_s=12, poll_s=0.15):
    """Polls data-lfl-state.lastResult until `predicate(lastResult)` is
    truthy, or times out. Returns the last-seen lastResult (possibly not
    matching, if it timed out) so callers can still assert/print on it.

    This is the sanctioned way to observe a settle without piercing the
    CLOSED shadow root (see terminal.js's own comment on why _lastResult is
    exposed via the dev-hook test attribute at all: "so tests can verify
    hard-block enforcement... without needing to read text out of the
    closed shadow root").
    """
    deadline = time.monotonic() + timeout_s
    last = None
    while time.monotonic() < deadline:
        state = read_lfl_state(page)
        last = state.get("lastResult") if state else None
        if last and predicate(last):
            return last
        time.sleep(poll_s)
    return last


def run():
    SHOTS_DIR.mkdir(parents=True, exist_ok=True)
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)

    proc = ensure_http_server(PORT)
    ok_all_final = False

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
                    "--window-size=1280,900",
                ],
                viewport={"width": 1280, "height": 800},
            )
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(f"http://127.0.0.1:{PORT}/recipes-delayed.html")
            page.wait_for_function(
                "() => document.documentElement.hasAttribute('data-lfl-terminal-injected')",
                timeout=5000,
            )

            # Blind bootstrap (same pattern as popover_smoke.py's own setup):
            # the state hook doesn't exist on a fresh profile yet, so open +
            # type "dev on" without the usual wait_for_function gate, then
            # poll for the attribute to appear.
            page.evaluate("() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }")
            page.keyboard.press("Backquote")
            page.wait_for_timeout(400)
            page.keyboard.type("dev on", delay=8)
            page.keyboard.press("Enter")
            deadline = time.monotonic() + 5
            state = None
            while time.monotonic() < deadline:
                state = read_lfl_state(page)
                if state is not None:
                    break
                time.sleep(0.1)
            check("dev on: data-lfl-state now populated", state is not None)

            # ---- case 1: `wait for heading "Ready" within 5s` succeeds once
            # the fixture's setTimeout rewrites #status from "Loading" to
            # "Ready" (~1.5s after load), chained with a passing `expect` ----
            submit_command(
                page,
                'wait for heading "Ready" within 5s && expect heading "Ready"',
                settle_wait_s=0.3,
            )
            # Predicate must name the FINAL settle: `dev on`'s own settle
            # (ok: True) is still sitting in lastResult while the delayed
            # `wait for` runs, so an any-settle predicate matches the stale
            # value instantly (found on this script's first real run).
            result = wait_for_last_result(
                page,
                lambda r: 'expect heading "Ready"' in (r.get("message") or ""),
                timeout_s=8,
            )
            check(
                "case 1: chain settles true (both `wait for` and the chained `expect` passed)",
                result is not None and result.get("ok") is True,
                detail=str(result),
            )
            check(
                "case 1: final settle message is the `expect heading \"Ready\": OK` line",
                result is not None and "expect heading \"Ready\": OK" in (result.get("message") or ""),
                detail=str(result),
            )
            page.screenshot(path=str(SHOTS_DIR / "01-wait-then-expect-pass.png"))

            # ---- case 2: a failing `expect` halts the rest of a typed &&
            # chain (design §9 sign-off D) - reload fresh so #status starts
            # back at "Loading", then assert on a heading that is NEVER
            # true, chained with a second expect that WOULD pass if reached ----
            page.goto(f"http://127.0.0.1:{PORT}/recipes-delayed.html")
            page.wait_for_function(
                "() => document.documentElement.hasAttribute('data-lfl-terminal-injected')", timeout=5000)
            time.sleep(0.3)
            if not is_open(page):
                page.evaluate("() => document.activeElement && document.activeElement.blur && document.activeElement.blur()")
                page.keyboard.press("Backquote")
                wait_open_state(page, True)

            submit_command(
                page,
                'expect heading "This Heading Does Not Exist" && expect heading "Loading"',
                settle_wait_s=0.3,
            )
            result = wait_for_last_result(page, lambda r: r.get("ok") is False, timeout_s=5)
            check(
                "case 2: chain settles FALSE (the first expect failed)",
                result is not None and result.get("ok") is False,
                detail=str(result),
            )
            check(
                "case 2: settle message is the FIRST expect's FAILED line, not the second's",
                result is not None and 'expect heading "This Heading Does Not Exist": FAILED' in (result.get("message") or ""),
                detail=str(result),
            )
            seq_after_fail = None
            state = read_lfl_state(page)
            if state:
                seq_after_fail = state.get("seq")
            time.sleep(1.5)  # generous - long enough for a second segment to have run, if the halt failed to hold
            state_later = read_lfl_state(page)
            check(
                "case 2: the queue truly halted - no further settle happened (seq unchanged, second expect never ran)",
                state_later is not None and seq_after_fail is not None and state_later.get("seq") == seq_after_fail,
                detail=f"seq_after_fail={seq_after_fail} seq_later={state_later.get('seq') if state_later else None}",
            )
            page.screenshot(path=str(SHOTS_DIR / "02-expect-fail-halts-chain.png"))

            ok_all_final = ok_all
    finally:
        if proc:
            proc.terminate()

    print(f"\n{'PASS' if ok_all_final else 'FAIL'} - m6_expect_wait_smoke")
    return ok_all_final


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
