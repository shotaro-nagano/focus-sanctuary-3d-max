"""Functional checks F01-F06 driven through the real UI with Playwright (headed, real GPU).

Usage:  python tools/functional_check.py [--url http://127.0.0.1:5173] [--headless]

Every scenario uses the TEST CLOCK (?speed=N): elapsed real time is multiplied, the production
durations (25 / 5 / 15 min) are untouched. Records are written to sessionStorage (?storage=session)
so the real localStorage of the browser profile is never touched. Prints PASS / FAIL per check and
exits 1 on any failure.
"""
from __future__ import annotations

import argparse
import re
import sys
import time

from playwright.sync_api import sync_playwright

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


def mmss_to_s(text: str) -> int:
    m = re.search(r"(\d{1,2}):(\d{2})", text)
    if not m:
        return -1
    return int(m.group(1)) * 60 + int(m.group(2))


class App:
    def __init__(self, page, base: str):
        self.page = page
        self.base = base

    def open(self, query: str, wait: int = 2500):
        # logic checks do not need the full-quality render: the low preset keeps SwiftShader (headless) responsive
        self.page.goto(f"{self.base}/?{query}&quality=low", wait_until="load")
        self.page.wait_for_timeout(wait)

    def snap(self) -> dict:
        return self.page.evaluate("() => window.__fs.engine.getSnapshot()")

    def exact(self) -> str:
        return self.page.locator("#timer-exact").inner_text()

    def status(self) -> str:
        return self.page.locator("#status-line").inner_text()

    def count(self) -> int:
        return int(self.page.locator("#today-count").inner_text() or "0")

    def minutes(self) -> int:
        return int(self.page.locator("#today-minutes").inner_text() or "0")

    def click(self, sel: str):
        self.page.click(sel)

    def confirm_visible(self) -> bool:
        return self.page.evaluate("() => { const c = document.getElementById('confirm'); return !!c && !c.hidden && getComputedStyle(c).visibility !== 'hidden'; }")


def run(base: str, headless: bool) -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless, args=["--ignore-gpu-blocklist", "--enable-webgl", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] if headless else ["--ignore-gpu-blocklist", "--enable-webgl"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)[:200]))
        app = App(page, base)

        # ------------------------------------------------------------- F01 start / pause / resume (x60)
        app.open("nointro=1&storage=session&speed=60")
        s0 = app.snap()
        check("F01 fresh boot 25:00 focus idle", s0["mode"] == "focus" and s0["status"] == "idle" and s0["remainingMs"] == 25 * 60_000 and app.exact().strip() == "25:00", app.exact())
        app.click("#btn-start")
        page.wait_for_timeout(3000)  # 3 s real = 3 min timer
        s1 = app.snap()
        rem1 = s1["remainingMs"]
        check("F01 running: ~3 min elapsed after 3 s at x60", s1["status"] == "running" and 21 * 60_000 <= rem1 <= 22.5 * 60_000, f"remaining {rem1/60000:.2f} min, readout {app.exact()}")
        app.click("#btn-start")  # pause
        page.wait_for_timeout(300)
        s2 = app.snap()
        rem2 = s2["remainingMs"]
        page.wait_for_timeout(2000)
        s3 = app.snap()
        check("F01 paused keeps remaining", s2["status"] == "paused" and s3["status"] == "paused" and abs(s3["remainingMs"] - rem2) < 1000 and "PAUSED" in app.status().upper(), f"{rem2} -> {s3['remainingMs']} ({app.status()})")
        app.click("#btn-start")  # resume
        page.wait_for_timeout(2000)
        s4 = app.snap()
        check("F01 resume continues from the paused value", s4["status"] == "running" and rem2 - 2.6 * 60_000 <= s4["remainingMs"] <= rem2 - 1.5 * 60_000, f"{rem2/60000:.2f} -> {s4['remainingMs']/60000:.2f} min")

        # ------------------------------------------------------------- F02 reset / mode change confirmations
        app.click("#btn-reset")
        page.wait_for_timeout(400)
        check("F02 reset while running asks for confirmation", app.confirm_visible())
        app.click("#confirm-no")
        page.wait_for_timeout(400)
        s5 = app.snap()
        check("F02 KEEP keeps the session running", s5["status"] == "running" and s5["sessionId"] == s4["sessionId"])
        page.click("[data-mode='short']")
        page.wait_for_timeout(400)
        check("F02 mode change while running asks for confirmation", app.confirm_visible())
        app.click("#confirm-yes")
        page.wait_for_timeout(600)
        s6 = app.snap()
        check("F02 discard -> short break idle 05:00, nothing recorded", s6["mode"] == "short" and s6["status"] == "idle" and s6["remainingMs"] == 5 * 60_000 and app.count() == 0 and s6["today"]["count"] == 0)
        page.click("[data-mode='focus']")
        page.wait_for_timeout(400)
        s7 = app.snap()
        check("F02 mode change while idle needs no confirmation", not app.confirm_visible() and s7["mode"] == "focus" and s7["remainingMs"] == 25 * 60_000)

        # ------------------------------------------------------------- F03 completion cycle (x600: 25 min = 2.5 s; stays inside one calendar day)
        app.open("nointro=1&storage=session&speed=600")
        page.evaluate("() => sessionStorage.clear()")
        app.open("nointro=1&storage=session&speed=600")
        sids = []
        modes_after = []
        for i in range(4):
            s = app.snap()
            check(f"F03 cycle {i+1}: focus idle before start", s["mode"] == "focus" and s["status"] == "idle")
            app.click("#btn-start")
            page.wait_for_timeout(300)
            sids.append(app.snap()["sessionId"])
            page.wait_for_timeout(2600)  # > 25 min at x600
            page.wait_for_timeout(4600)  # let the M10 set-piece finish (4 s) so the console is unlocked
            s = app.snap()
            modes_after.append(s["mode"])
            check(f"F03 cycle {i+1}: recorded once, next mode idle", s["status"] == "idle" and s["today"]["count"] == i + 1 and s["completedFocusCount"] == i + 1 and app.count() == i + 1 and app.minutes() == 25 * (i + 1), f"mode {s['mode']}, count {s['today']['count']}, min {app.minutes()}")
            # run the break to completion (5 min = 0.5 s / 15 min = 1.5 s at x600)
            app.click("#btn-start")
            page.wait_for_timeout(3000)
            s = app.snap()
            check(f"F03 cycle {i+1}: break completes -> focus idle, breaks not recorded", s["mode"] == "focus" and s["status"] == "idle" and s["today"]["count"] == i + 1)
        check("F03 4th completed focus -> long break", modes_after == ["short", "short", "short", "long"], str(modes_after))
        check("F03 session ids unique", len(set(sids)) == 4)

        # ------------------------------------------------------------- F04 reload restore + completion while away
        app.open("nointro=1&storage=session&speed=60")
        page.evaluate("() => sessionStorage.clear()")
        app.open("nointro=1&storage=session&speed=60")
        app.click("#btn-start")
        page.wait_for_timeout(2000)
        before = app.snap()
        app.open("nointro=1&storage=session&speed=60", wait=1500)
        after = app.snap()
        check("F04 reload restores the running session", after["status"] == "running" and after["sessionId"] == before["sessionId"] and after["remainingMs"] < before["remainingMs"] and after["remainingMs"] > before["remainingMs"] - 4 * 60_000, f"{before['remainingMs']/60000:.2f} -> {after['remainingMs']/60000:.2f} min")
        app.click("#btn-start")  # pause
        page.wait_for_timeout(300)
        paused = app.snap()
        app.open("nointro=1&storage=session&speed=60", wait=1500)
        restored = app.snap()
        check("F04 reload restores a paused session with its remaining time", restored["status"] == "paused" and abs(restored["remainingMs"] - paused["remainingMs"]) < 1000 and "PAUSED" in app.status().upper())
        # completion while away: start at x1800, reload after the end time has passed
        app.open("nointro=1&storage=session&speed=1800")
        page.evaluate("() => sessionStorage.clear()")
        app.open("nointro=1&storage=session&speed=1800")
        app.click("#btn-start")
        page.wait_for_timeout(200)
        page.goto("about:blank")
        page.wait_for_timeout(1500)  # > 25 min at x1800 while away
        app.open("nointro=1&storage=session&speed=1800", wait=1500)
        s = app.snap()
        check("F04 session that ended while away is completed exactly once on boot", s["status"] == "idle" and s["mode"] == "short" and s["today"]["count"] == 1 and s["completedFocusCount"] == 1, f"mode {s['mode']} count {s['today']['count']}")
        app.open("nointro=1&storage=session&speed=1800", wait=1500)
        s = app.snap()
        check("F04 a second reload does not count it again", s["today"]["count"] == 1 and s["completedFocusCount"] == 1)

        # ------------------------------------------------------------- F05 task text is data, storage failure is survivable
        app.open("nointro=1&storage=session")
        page.evaluate("() => sessionStorage.clear()")
        app.open("nointro=1&storage=session")
        page.fill("#task-input", "<b>bold</b> & \"quotes\" <img src=x onerror=alert(1)>")
        page.wait_for_timeout(700)
        s = app.snap()
        injected = page.evaluate("() => !!document.querySelector('#console img') || document.getElementById('task-input').value !== '<b>bold</b> & \"quotes\" <img src=x onerror=alert(1)>'")
        check("F05 task stored raw and never rendered as HTML", s["task"].startswith("<b>bold</b>") and not injected, s["task"][:40])
        blocked = ctx.new_page()
        blocked.add_init_script("Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } });")
        blocked.goto(f"{base}/?nointro=1&storage=local&speed=60", wait_until="load")
        blocked.wait_for_timeout(2500)
        note = blocked.evaluate("() => { const n = document.getElementById('storage-note'); return n && !n.hidden ? n.textContent : ''; }")
        blocked.click("#btn-start")
        blocked.wait_for_timeout(1500)
        sb = blocked.evaluate("() => window.__fs.engine.getSnapshot()")
        check("F05 blocked storage: note shown, timer still runs in memory", bool(note) and sb["status"] == "running" and sb["storageOk"] is False, note[:60])
        blocked.close()

        # ------------------------------------------------------------- F06 REPLAY and completion preview never touch the timer
        app.open("nointro=1&storage=session&speed=60")
        page.evaluate("() => sessionStorage.clear()")
        app.open("nointro=1&storage=session&speed=60")
        app.click("#btn-start")
        page.wait_for_timeout(1500)
        r0 = app.snap()
        t0 = time.time()
        app.click("#btn-replay")
        page.wait_for_timeout(4200)
        r1 = app.snap()
        elapsed_timer = (r0["remainingMs"] - r1["remainingMs"]) / 60_000
        elapsed_real = time.time() - t0
        check("F06 REPLAY keeps the timer running normally", r1["status"] == "running" and r1["sessionId"] == r0["sessionId"] and abs(elapsed_timer - elapsed_real) < 0.6, f"timer advanced {elapsed_timer:.2f} min in {elapsed_real:.2f} s (x60)")
        check("F06 REPLAY does not record anything", r1["today"]["count"] == r0["today"]["count"])
        page.evaluate("() => sessionStorage.clear()")
        app.open("nointro=1&storage=session&preview=complete", wait=6500)
        s = app.snap()
        check("F06 ?preview=complete plays M10 without writing a record", s["today"]["count"] == 0 and s["completedFocusCount"] == 0 and s["status"] == "idle" and app.count() == 0)

        check("no uncaught page errors during the run", len(errors) == 0, "; ".join(errors[:3]))
        browser.close()

    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)} / {len(RESULTS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:5173")
    ap.add_argument("--headless", action="store_true")
    a = ap.parse_args()
    sys.exit(run(a.url.rstrip("/"), a.headless))
