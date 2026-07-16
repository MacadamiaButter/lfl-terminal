#!/usr/bin/env python3
"""
tests/popover_smoke.py - live-browser smoke check for the popover redesign
(LFL-TERMINAL-POPOVER-REDESIGN.md, 2026-07-15): cursor-anchored floating
panel vs the legacy docked-bottom mode, pin/unpin persistence, and the
opt-in middle-click trigger's inert-background targeting. Reuses the same
driving pattern as tests/m3_battery.py/m4_smoke.py (Playwright persistent
context, real keyboard/mouse input, the data-lfl-state test hook - now
carrying anchorMode/pinned/middleClickOpen/middleClickModifier, see
terminal.js's _updateTestHook()).

Unlike m3_battery.py/m4_smoke.py, this script needs NO local model server -
every command it drives (config/pin/unpin, the `dev on` test-hook toggle)
is a deterministic meta-command that never touches the LLM lane.

Run with a Python environment that has playwright installed:
  python tests/popover_smoke.py

Writes screenshots to tests/popover-shots/ and prints PASS/FAIL per case,
exiting nonzero if any case failed.
"""
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXTENSION_DIR = ROOT / "extension"
FIXTURES_DIR = ROOT / "tests" / "fixtures"
SHOTS_DIR = ROOT / "tests" / "popover-shots"
USER_DATA_DIR = ROOT / "tests" / ".chrome-profile-popover-smoke"

PORT = 8997

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
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def host_rect(page):
    return page.evaluate(
        "() => { const h = document.getElementById('lfl-terminal-host'); "
        "if (!h) return null; const r = h.getBoundingClientRect(); "
        "return {left: r.left, top: r.top, hasDock: h.classList.contains('lfl-dock'), "
        "inlineLeft: h.style.left, inlineTop: h.style.top}; }"
    )


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


def submit_command(page, command):
    page.keyboard.type(command, delay=8)
    page.keyboard.press("Enter")
    time.sleep(0.3)  # every command here is a synchronous/storage-only meta-command, no LLM round trip to poll for


def run():
    SHOTS_DIR.mkdir(parents=True, exist_ok=True)
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)

    proc = ensure_http_server(PORT)

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
            page.goto(f"http://127.0.0.1:{PORT}/safe-target.html")
            page.wait_for_function(
                "() => document.documentElement.hasAttribute('data-lfl-terminal-injected')",
                timeout=5000,
            )

            # Turn on the test hook so data-lfl-state carries anchorMode/pinned -
            # a real user-typed command, same as every other script in this
            # suite. Blind bootstrap (same pattern as m3_battery.py's
            # case_h2_gating()): the state hook doesn't exist yet on a fresh
            # profile, so toggle_terminal()/wait_open_state() (which poll
            # THAT attribute) can't be used for this very first open - open
            # + type without the usual wait_for_function gate, then poll for
            # the attribute to appear.
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

            # ---- case 1: default cursor mode spawns near a clicked point ----
            toggle_terminal(page)  # close
            page.mouse.move(300, 500)
            toggle_terminal(page)  # reopen - keyboard trigger, so this uses the
            # deterministic keyboard-fallback anchor (top-center), NOT the mouse
            # position above - see design §5/§6. Confirms cursor mode is active
            # (no .lfl-dock) and the panel is placed somewhere on-screen.
            rect = host_rect(page)
            state = read_lfl_state(page)
            check("cursor mode is the default (state.anchorMode)", state and state.get("anchorMode") == "cursor")
            check("cursor mode: host has no .lfl-dock class", rect and rect["hasDock"] is False)
            check("cursor mode: host carries an inline position (not dock/inset)", rect and rect["inlineLeft"] != "" and rect["inlineTop"] != "")
            check(
                "cursor mode: panel is placed within the viewport (not clipped off-screen)",
                rect and 0 <= rect["left"] <= 1280 and 0 <= rect["top"] <= 800,
                detail=str(rect),
            )
            page.screenshot(path=str(SHOTS_DIR / "01-cursor-mode-open.png"))

            # ---- case 2: config anchor dock -> legacy full-width bottom bar ----
            submit_command(page, "config anchor dock")
            toggle_terminal(page)  # close
            toggle_terminal(page)  # reopen in dock mode
            rect = host_rect(page)
            state = read_lfl_state(page)
            check("config anchor dock: state.anchorMode updated", state and state.get("anchorMode") == "dock")
            check("dock mode: host gains .lfl-dock class on reopen", rect and rect["hasDock"] is True)
            check("dock mode: inline left/top cleared (dock's own inset rule governs position)", rect and rect["inlineLeft"] == "" and rect["inlineTop"] == "")
            page.screenshot(path=str(SHOTS_DIR / "02-dock-mode-open.png"))

            # ---- case 3: back to cursor mode ----
            submit_command(page, "config anchor cursor")
            toggle_terminal(page)  # close
            toggle_terminal(page)  # reopen in cursor mode
            rect = host_rect(page)
            check("back to cursor mode: .lfl-dock removed, inline position restored", rect and rect["hasDock"] is False and rect["inlineLeft"] != "")

            # ---- case 4: pin freezes position across a close/reopen at a different anchor ----
            submit_command(page, "pin")
            state = read_lfl_state(page)
            check("pin: state.pinned is true", state and state.get("pinned") is True)
            pinned_rect = host_rect(page)
            toggle_terminal(page)  # close
            page.mouse.move(1000, 100)  # move the pointer somewhere very different
            toggle_terminal(page)  # reopen - pinned, so should land at the SAME spot regardless
            reopened_rect = host_rect(page)
            check(
                "pin: reopening lands at the SAME position, ignoring the new pointer location",
                reopened_rect and pinned_rect and abs(reopened_rect["left"] - pinned_rect["left"]) < 1 and abs(reopened_rect["top"] - pinned_rect["top"]) < 1,
                detail=f"pinned={pinned_rect} reopened={reopened_rect}",
            )

            # ---- case 5: unpin restores re-anchoring on every open ----
            submit_command(page, "unpin")
            state = read_lfl_state(page)
            check("unpin: state.pinned is false", state and state.get("pinned") is False)

            # ---- case 6: middle-click - default OFF, then opt-in via config,
            # then the actual gesture on inert page background ----
            state = read_lfl_state(page)
            check("middle-click open is OFF by default", state and state.get("middleClickOpen") is False)

            # Terminal is still open from case 5 - type the config command
            # while it's focused, THEN close for the actual click test (a
            # closed panel is what middle-click is supposed to open).
            submit_command(page, "config middleclick on")
            state = read_lfl_state(page)
            check("config middleclick on: state.middleClickOpen is now true", state and state.get("middleClickOpen") is True)
            if is_open(page):
                toggle_terminal(page)  # close
            check("terminal is closed before the middle-click gesture", not is_open(page))

            # Middle-click on inert page background (well below the h1/p
            # text, over plain <body>) - not a link/button/field/selection,
            # so _isInertBackgroundTarget() should allow it and the terminal
            # should open, anchored at the click point.
            page.mouse.click(640, 700, button="middle")
            wait_open_state(page, True)
            rect = host_rect(page)
            check("middle-click on inert background: terminal is now open", is_open(page))
            # Placement math may flip the panel ABOVE the click point if it
            # can't fit below (see registry.placePanel) - don't assert a
            # specific position, just that the click actually drove
            # placement (no .lfl-dock, and the result is fully on-screen),
            # same style as case 1's viewport-boundedness check.
            check(
                "middle-click: panel is placed within the viewport, cursor-anchored (not dock)",
                rect and rect["hasDock"] is False and 0 <= rect["left"] <= 1280 and 0 <= rect["top"] <= 800,
                detail=str(rect),
            )
            page.screenshot(path=str(SHOTS_DIR / "03-middleclick-open.png"))

            # A second middle-click on inert background, with the panel now
            # open, should CLOSE it (toggle semantics) - clicking somewhere
            # that is not itself the panel (the panel floats near the bottom
            # here; click up near the top of the page instead).
            page.mouse.click(200, 50, button="middle")
            wait_open_state(page, False)
            check("second middle-click on inert background closes the (now open) terminal", not is_open(page))

            # Disable it again and confirm the gesture goes back to being a
            # no-op (native autoscroll behavior is out of this script's
            # reach to assert directly, but "the terminal does not open" is
            # the one thing we CAN assert without it).
            toggle_terminal(page)  # reopen via keyboard to type the config command
            submit_command(page, "config middleclick off")
            toggle_terminal(page)  # close
            page.mouse.click(640, 700, button="middle")
            time.sleep(0.3)
            check("middle-click open OFF: the same gesture no longer opens the terminal", not is_open(page))

            ok_all_final = ok_all
    finally:
        if proc:
            proc.terminate()

    print(f"\n{'PASS' if ok_all_final else 'FAIL'} - popover_smoke")
    return ok_all_final


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
