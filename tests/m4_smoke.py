#!/usr/bin/env python3
"""
tests/m4_smoke.py — small, standalone live-browser smoke check for the M4a
"friction trio" (ls + numbered actions, read/find, here), on top of a real
Wikipedia page. OPTIONAL, per the M4a build task's own note ("add a small
m4 live smoke ... only if the harness makes it cheap") — this reuses
tests/m3_battery.py's existing driving helpers (real Playwright keyboard
input, the data-lfl-state test hook, the same settle-detection pattern)
rather than duplicating them, so it stays cheap. It is NOT part of the
required unit-test/battery gate (tests/m4_friction.test.js is); this is
extra, live-browser confidence on top of that.

Requires the same things tests/m3_battery.py does: a healthy model server
on 127.0.0.1:1238, and a Python env with playwright installed
(tests/m3_battery.py's own header documents the install step).

Run: python tests/m4_smoke.py
"""
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from m3_battery import (  # noqa: E402 — see sys.path insert above
    EXTENSION_DIR, USER_DATA_DIR, cur_seq, open_terminal, read_lfl_state,
    submit_command, wait_for_seq_change,
)

ok_all = True


def check(name, cond, detail=""):
    global ok_all
    status = "ok  " if cond else "FAIL"
    print(f"  {status} - {name}" + (f"  ({detail})" if detail else ""))
    if not cond:
        ok_all = False


def run():
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
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
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("https://en.wikipedia.org/wiki/Main_Page", wait_until="domcontentloaded")
        page.wait_for_timeout(800)
        open_terminal(page)

        # dev on — needed to read data-lfl-state (off by default, H2).
        seq0 = cur_seq(page)
        submit_command(page, "dev on")
        wait_for_seq_change(page, seq0)

        print("\n=== m4 smoke: ls -> open 1 ; find ; here (live Wikipedia) ===")

        # ---- ls ----
        seq0 = cur_seq(page)
        submit_command(page, "ls")
        state, navigated = wait_for_seq_change(page, seq0)
        ls_ok = (not navigated) and state and state.get("lastResult") and state["lastResult"].get("ok") is True
        ls_msg = (state or {}).get("lastResult", {}).get("message", "")
        check("`ls` settles ok and lists sections", bool(ls_ok), ls_msg.splitlines()[0] if ls_msg else "(no message)")
        check("`ls` output mentions links/buttons/fields sections", all(s in ls_msg for s in ["links (", "buttons (", "fields ("]))

        # ---- open 1 (whatever [1] is — a real Wikipedia page always has
        # at least one visible link near the top) ----
        seq0 = cur_seq(page)
        submit_command(page, "open 1")
        state, navigated = wait_for_seq_change(page, seq0)
        msg = (state or {}).get("lastResult", {}).get("message", "") if state else ""
        # A same-origin `open <N>` sets navInitiated and calls location.href
        # synchronously — the settle-detection poll can observe the settled
        # seq/message a beat BEFORE the navigation actually tears down the
        # execution context (a real race, not a product bug: same
        # non-instant-unload timing docs/threat-model.md's "Queue risks"
        # section already documents for `back`/same-origin `open`/`search`).
        # Treat either signal (the Navigated exception, OR the "opening ["
        # message text) as "a navigation is in flight" and settle the page
        # back onto Main_Page before issuing the next command.
        looks_like_nav = navigated or msg.startswith("opening [")
        if looks_like_nav:
            try:
                page.wait_for_load_state("domcontentloaded", timeout=10000)
            except Exception:
                pass
            check("`open 1` navigated (same-origin branch)", True, msg or f"now at {page.url}")
            page.goto("https://en.wikipedia.org/wiki/Main_Page", wait_until="domcontentloaded")
            page.wait_for_timeout(800)
            open_terminal(page)
            seq0 = cur_seq(page)
            submit_command(page, "dev on")
            wait_for_seq_change(page, seq0)
            seq0 = cur_seq(page)
            submit_command(page, "ls")
            wait_for_seq_change(page, seq0)
        else:
            # [1] might legitimately be a non-link (e.g. a button) on some
            # renders — either a real cross-origin-pending message or a
            # "not a link" hint is still proof the numbered-action path ran
            # end to end without crashing.
            check(
                "`open 1` produced a recognizable numbered-action result (navigated, cross-origin-pending, or not-a-link)",
                ("type \"open!\"" in msg) or ("not a link" in msg),
                msg,
            )

        # ---- find ----
        seq0 = cur_seq(page)
        submit_command(page, 'find Wikipedia')
        state, navigated = wait_for_seq_change(page, seq0)
        find_msg = (state or {}).get("lastResult", {}).get("message", "") if not navigated else ""
        check("`find Wikipedia` reports a match (Wikipedia's own name appears on its Main Page)", find_msg.startswith("match "), find_msg)

        # ---- here ----
        seq0 = cur_seq(page)
        submit_command(page, "here")
        state, navigated = wait_for_seq_change(page, seq0)
        here_msg = (state or {}).get("lastResult", {}).get("message", "") if not navigated else ""
        check("`here` reports origin + a `try:` suggestion line", ("origin: https://en.wikipedia.org" in here_msg) and ("try:" in here_msg), here_msg.splitlines()[0] if here_msg else "")

        context.close()

    print("\nALL PASS" if ok_all else "SOME FAILED")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(run())
