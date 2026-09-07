#!/usr/bin/env python3
"""Focus Sanctuary - visual QA & deliverable capture (Playwright, sync API).

Subcommands
  shots   still screenshots per pose (desktop + mobile) and frame bursts of the intro
          and the M10 completion set-piece
  video   scripted demo recordings (desktop + mobile) -> captures/demo-*.webm
  fps     read the app's rolling fps meter (window.__fps) after a warm-up

Every URL carries ``storage=memory`` so no real records are touched.

The tool never reports success for a page that did not actually boot: every navigation
waits for a real boot signal (``window.__fs`` set by src/main.ts, the three.js canvas
sized, or the honest #fallback plate), fails on the Vite error overlay, on same-origin
script/document HTTP errors and on uncaught exceptions, and checks that the base URL
serves *this* app (Vite moves to another port when 5173 is busy - strictPort is off).

Exit codes: 0 ok / 1 Playwright or server problem / 2 app failed to boot or fatal console
errors / 3 fps measured nothing.

Headless Chromium renders WebGL through SwiftShader (software). It is slow but the
geometry, materials and composition are faithful. Pass ``--headed`` to use the real GPU.
"""
from __future__ import annotations

import argparse
import math
import shutil
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from playwright.sync_api import (
    Browser,
    BrowserContext,
    ConsoleMessage,
    Error as PlaywrightError,
    Page,
    Playwright,
    Request,
    Response,
    sync_playwright,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_URL = "http://127.0.0.1:5173"
DEFAULT_OUT = PROJECT_ROOT / "captures"

EXIT_OK = 0
EXIT_PLAYWRIGHT = 1  # server not reachable / wrong app / browser problem
EXIT_APP_FAILED = 2  # app did not boot, fatal console errors, fallback composition
EXIT_NO_MEASUREMENT = 3  # fps: nothing was measured

# Headless: force ANGLE on SwiftShader so WebGL2 is always available (software rasterizer).
CHROMIUM_ARGS_HEADLESS = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--enable-webgl",
    "--autoplay-policy=no-user-gesture-required",
]
# Headed (--headed): the real GPU through ANGLE's default backend (D3D11 on Windows);
# the swiftshader flags are deliberately absent, otherwise the window would still be software-rendered.
CHROMIUM_ARGS_HEADED = [
    "--use-gl=angle",
    "--ignore-gpu-blocklist",
    "--enable-webgl",
    "--autoplay-policy=no-user-gesture-required",
]

DESKTOP = {"name": "desktop", "width": 1440, "height": 900}
MOBILE = {"name": "mobile", "width": 390, "height": 844}

POSES = ["idle", "focus", "shortBreak", "longBreak", "paused"]

# Console/page errors containing any of these substrings make the run fail (exit 2).
FATAL_ERROR_MARKERS = ("THREE", "Uncaught", "HTTP ", "BOOT ", "APP FALLBACK")

# Same-origin resources of these types must load; a >= 400 answer means the app is broken
# (a missing module makes Vite answer 500 for /src/main.ts and show its error overlay).
CRITICAL_RESOURCE_TYPES = {"document", "script", "stylesheet"}

# Identity of *this* app: title fragment + DOM ids that only index.html of this project has.
APP_TITLE_FRAGMENT = "Focus Sanctuary"
APP_IDENTITY_SELECTORS = ("#console", "#btn-start", "#gl", "#stage")

# Evaluated in the page: what state has the app reached? (null = still booting)
#   'error'    Vite error overlay is up (module failed to load / compile)
#   'ready'    src/main.ts ran to its end (window.__fs) or three.js sized the canvas
#   'fallback' the honest #fallback composition is shown (WebGL unavailable / context lost)
BOOT_STATE_JS = """() => {
  if (document.querySelector('vite-error-overlay')) return 'error';
  const fb = document.querySelector('#fallback');
  const fbShown = !!fb && !fb.hidden;
  if (fbShown) {
    const cls = fb.className || '';
    // 'reduced' is a notice only; the real 3D keeps rendering behind it
    if (!cls.includes('is-reduced')) return 'fallback';
  }
  if (window.__fs) return 'ready';
  const gl = document.querySelector('#gl');
  if (gl && gl.hasAttribute('width') && gl.hasAttribute('height')) return 'ready';
  return null;
}"""

FALLBACK_INFO_JS = """() => {
  const fb = document.querySelector('#fallback');
  const k = document.querySelector('#fallback-kicker');
  const t = document.querySelector('#fallback-text');
  return {
    cls: fb ? fb.className : '',
    kicker: k ? k.textContent.trim() : '',
    text: t ? t.textContent.trim() : '',
  };
}"""

IDENTITY_JS = """(selectors) => ({
  title: document.title,
  lang: document.documentElement.lang,
  missing: selectors.filter((s) => !document.querySelector(s)),
})"""

WEBGL_RENDERER_JS = """() => {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 'no WebGL context';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const version = gl.getParameter(gl.VERSION);
    if (!ext) return String(version) + ' (renderer string not exposed)';
    return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) + ' / ' + String(version);
  } catch (e) {
    return 'renderer query failed: ' + String(e);
  }
}"""

STAGE_STATS_JS = """() => {
  try {
    const fs = window.__fs;
    if (!fs || !fs.stage || typeof fs.stage.getStats !== 'function') return null;
    const s = fs.stage.getStats();
    return { drawCalls: s.drawCalls, triangles: s.triangles, fps: s.fps };
  } catch (e) {
    return null;
  }
}"""


class CaptureError(Exception):
    """A failure with a specific process exit code; printed without a traceback."""

    def __init__(self, code: int, message: str, hint: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.hint = hint


# --------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------


def log(msg: str) -> None:
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        # Windows consoles with a legacy code page (cp932 etc.) cannot print every character of
        # the app title; never let a log line take the run down.
        enc = sys.stdout.encoding or "ascii"
        print(msg.encode(enc, errors="replace").decode(enc, errors="replace"), flush=True)


def wrote(path: Path) -> None:
    log(f"  wrote {path}")


def build_url(base: str, path: str, **params: object) -> str:
    """Join base + path, then merge query params. ``storage=memory`` is always present."""
    if "?" in path:
        path_part, query_part = path.split("?", 1)
    else:
        path_part, query_part = path, ""
    parts = urlsplit(base)  # the base may carry its own path and query (e.g. a sub-path deploy)
    joined_path = parts.path.rstrip("/") + "/" + path_part.lstrip("/")
    query: dict[str, str] = dict(parse_qsl(parts.query, keep_blank_values=True))
    query.update(dict(parse_qsl(query_part, keep_blank_values=True)))
    for key, value in params.items():
        if value is None or value is False:
            continue
        query[key] = "1" if value is True else str(value)
    query.setdefault("storage", "memory")
    return urlunsplit((parts.scheme, parts.netloc, joined_path, urlencode(query), ""))


def origin_of(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower()


def sleep_ms(ms: float) -> None:
    if ms > 0:
        time.sleep(ms / 1000.0)


# --------------------------------------------------------------------------------------
# Console + network collection
# --------------------------------------------------------------------------------------


@dataclass
class ConsoleLog:
    base_origin: str
    allow_fallback: bool = False
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # same-origin critical resources that answered >= 400 or failed; cleared per navigation check
    http_failures: list[str] = field(default_factory=list)

    def attach(self, page: Page, label: str) -> None:
        def on_console(msg: ConsoleMessage) -> None:
            text = msg.text
            if msg.type == "error":
                self.errors.append(f"[{label}] {text}")
            elif msg.type == "warning":
                self.warnings.append(f"[{label}] {text}")

        def on_page_error(exc: Exception) -> None:
            self.errors.append(f"[{label}] Uncaught {exc}")

        def on_response(res: Response) -> None:
            if res.status < 400 or origin_of(res.url) != self.base_origin:
                return
            req = res.request
            entry = f"[{label}] HTTP {res.status} {req.resource_type} {res.url}"
            if req.resource_type in CRITICAL_RESOURCE_TYPES:
                self.errors.append(entry)
                self.http_failures.append(entry)
            elif not res.url.lower().endswith("/favicon.ico"):
                self.warnings.append(entry)

        def on_request_failed(req: Request) -> None:
            if origin_of(req.url) != self.base_origin:
                return
            failure = req.failure or "request failed"
            entry = f"[{label}] HTTP FAIL {req.resource_type} {req.url} ({failure})"
            if req.resource_type in CRITICAL_RESOURCE_TYPES:
                self.errors.append(entry)
                self.http_failures.append(entry)
            else:
                self.warnings.append(entry)

        page.on("console", on_console)
        page.on("pageerror", on_page_error)
        page.on("response", on_response)
        page.on("requestfailed", on_request_failed)

    def add_error(self, label: str, text: str) -> None:
        self.errors.append(f"[{label}] {text}")

    def fatal(self) -> list[str]:
        return [e for e in self.errors if any(marker in e for marker in FATAL_ERROR_MARKERS)]

    def report(self) -> int:
        """Print the summary; return the process exit code."""
        log("")
        log("Console summary")
        if self.warnings:
            log(f"  {len(self.warnings)} warning(s):")
            for w in self.warnings[:40]:
                log(f"    warn  {w}")
            if len(self.warnings) > 40:
                log(f"    ... {len(self.warnings) - 40} more")
        if not self.errors:
            log("  no console errors")
            return EXIT_OK
        log(f"  {len(self.errors)} error(s):")
        for e in self.errors:
            log(f"    error {e}")
        fatal = self.fatal()
        if fatal:
            log(f"  FAIL: {len(fatal)} fatal error(s) (THREE / Uncaught / HTTP / BOOT / APP FALLBACK)")
            return EXIT_APP_FAILED
        return EXIT_OK


# --------------------------------------------------------------------------------------
# Browser session
# --------------------------------------------------------------------------------------


@dataclass
class Settings:
    url: str
    out: Path
    headed: bool
    settle_ms: int
    load_timeout_ms: int
    fps_param: bool
    quality: str | None
    allow_fallback: bool


class Session:
    def __init__(self, pw: Playwright, settings: Settings, console: ConsoleLog) -> None:
        self.settings = settings
        self.console = console
        self.identity_checked = False
        launch_args = CHROMIUM_ARGS_HEADED if settings.headed else CHROMIUM_ARGS_HEADLESS
        self.browser: Browser = pw.chromium.launch(headless=not settings.headed, args=launch_args)

    def close(self) -> None:
        self.browser.close()

    def context(self, device: dict, record_video_dir: Path | None = None) -> BrowserContext:
        opts: dict = {
            "viewport": {"width": device["width"], "height": device["height"]},
            "color_scheme": "dark",
            "reduced_motion": "no-preference",
        }
        if device["name"] == "mobile":
            opts.update(
                {
                    "is_mobile": True,
                    "has_touch": True,
                    "device_scale_factor": 2,
                    "user_agent": (
                        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"
                    ),
                }
            )
        else:
            opts["device_scale_factor"] = 1
        if record_video_dir is not None:
            record_video_dir.mkdir(parents=True, exist_ok=True)
            opts["record_video_dir"] = str(record_video_dir)
            opts["record_video_size"] = {"width": device["width"], "height": device["height"]}
        return self.browser.new_context(**opts)

    # -- navigation -------------------------------------------------------------------

    def _url(self, path: str, params: dict[str, object]) -> str:
        if self.settings.fps_param:
            params.setdefault("fps", True)
        if self.settings.quality:
            params.setdefault("quality", self.settings.quality)
        return build_url(self.settings.url, path, **params)

    def open(self, ctx: BrowserContext, path: str, label: str, **params: object) -> Page:
        """New page, navigate, wait until the app has really booted. Returns the page."""
        url = self._url(path, params)
        page = ctx.new_page()
        self.console.attach(page, label)
        log(f"  open {url}")
        self._goto(page, url, label)
        return page

    def navigate(self, page: Page, path: str, label: str = "navigate", **params: object) -> None:
        url = self._url(path, params)
        log(f"  goto {url}")
        self._goto(page, url, label)

    def _goto(self, page: Page, url: str, label: str) -> None:
        self.console.http_failures.clear()
        t0 = time.monotonic()
        # domcontentloaded is enough: identity is static markup and wait_for_boot polls the rest.
        # (A foreign page that never fires 'load' would otherwise hide the identity diagnosis.)
        page.goto(url, wait_until="domcontentloaded", timeout=self.settings.load_timeout_ms)
        if not self.identity_checked:
            self.check_identity(page)
            self.identity_checked = True
        state = self.wait_for_boot(page, label)
        elapsed = int((time.monotonic() - t0) * 1000)
        log(f"  booted ({state}) after {elapsed} ms")

    # -- readiness ----------------------------------------------------------------------

    def check_identity(self, page: Page) -> None:
        """Make sure the base URL serves *this* app and not whatever else took the port."""
        info = page.evaluate(IDENTITY_JS, list(APP_IDENTITY_SELECTORS))
        title = str(info.get("title", ""))
        missing = list(info.get("missing", []))
        if APP_TITLE_FRAGMENT in title and not missing:
            log(f"  app identity ok: title '{title}'")
            return
        raise CaptureError(
            EXIT_PLAYWRIGHT,
            f"base URL {self.settings.url} serves a different app "
            f"(title='{title}', lang='{info.get('lang', '')}', missing={missing or 'none'})",
            hint=(
                "Check the port Vite printed when you ran `npm run dev` - strictPort is off, so it "
                "silently moves to 5174/5175/... when 5173 is busy - and pass it with --url."
            ),
        )

    def wait_for_boot(self, page: Page, label: str) -> str:
        """Poll until src/main.ts has run (or the app honestly fell back). Fail fast on errors."""
        deadline = time.monotonic() + self.settings.load_timeout_ms / 1000.0
        errors_before = len(self.console.errors)
        while True:
            state = page.evaluate(BOOT_STATE_JS)
            if state == "error":
                self._fail_boot(label, "BOOT failed: the Vite error overlay is shown (a module failed to load or compile)")
            if self.console.http_failures:
                self._fail_boot(label, f"BOOT failed: {self.console.http_failures[-1].split('] ', 1)[-1]}")
            new_errors = self.console.errors[errors_before:]
            uncaught = [e for e in new_errors if "Uncaught" in e]
            if uncaught:
                self._fail_boot(label, f"BOOT failed: {uncaught[-1].split('] ', 1)[-1]}")
            if state == "fallback":
                info = page.evaluate(FALLBACK_INFO_JS)
                msg = f"APP FALLBACK shown: {info.get('kicker', '')} - {info.get('text', '')} (class '{info.get('cls', '')}')"
                if self.settings.allow_fallback:
                    log(f"  WARNING: {msg}")
                    self.console.warnings.append(f"[{label}] {msg}")
                    return "fallback"
                self.console.add_error(label, msg)
                raise CaptureError(
                    EXIT_APP_FAILED,
                    f"the app booted into its fallback composition, not the 3D scene: {info.get('kicker', '')}",
                    hint="Captures of the fallback are not captures of the sculpture. Pass --allow-fallback to record them anyway.",
                )
            if state == "ready":
                return "ready"
            if time.monotonic() > deadline:
                self._fail_boot(
                    label,
                    f"BOOT timeout: no boot signal within {self.settings.load_timeout_ms} ms "
                    "(window.__fs unset, #gl never sized by three.js, #fallback hidden)",
                )
            sleep_ms(100)

    def _fail_boot(self, label: str, message: str) -> None:
        self.console.add_error(label, message)
        raise CaptureError(
            EXIT_APP_FAILED,
            message,
            hint="Open the URL in a browser and read the Vite error overlay / console; the console summary below lists what the page reported.",
        )


# --------------------------------------------------------------------------------------
# Interaction helpers
# --------------------------------------------------------------------------------------


def timer_is_idle(page: Page) -> bool:
    """The console START button reads 'START' only while the timer is idle (PAUSE/RESUME otherwise)."""
    try:
        text = page.evaluate("() => { const b = document.querySelector('#btn-start'); return b ? b.textContent.trim().toUpperCase() : ''; }")
    except PlaywrightError:
        return False
    return text == "START"


def accept_confirm_if_shown(page: Page, wait_ms: int = 600) -> bool:
    """If the discard-confirmation plate (#confirm) appears, press #confirm-yes."""
    try:
        page.wait_for_selector("#confirm:not([hidden])", state="visible", timeout=wait_ms)
    except PlaywrightError:
        return False
    log("  confirm dialog shown -> #confirm-yes")
    page.click("#confirm-yes")
    try:
        page.wait_for_selector("#confirm", state="hidden", timeout=2000)
    except PlaywrightError:
        pass
    return True


def click(page: Page, selector: str, touch: bool = False) -> None:
    log(f"  {'tap' if touch else 'click'} {selector}")
    if touch:
        page.tap(selector)
    else:
        page.click(selector)


def set_mode(page: Page, mode: str, touch: bool = False, settle_ms: int = 0) -> None:
    # The discard confirmation only exists while a session is running; skip the probe when idle.
    idle = timer_is_idle(page)
    click(page, f'[data-mode="{mode}"]', touch)
    if not idle:
        accept_confirm_if_shown(page)
    sleep_ms(settle_ms)


def stage_box(page: Page) -> tuple[float, float, float, float]:
    box = page.locator("#stage").bounding_box()
    if box is None:
        vp = page.viewport_size or {"width": 1440, "height": 900}
        return 0.0, 0.0, float(vp["width"]), float(vp["height"])
    return box["x"], box["y"], box["width"], box["height"]


def sculpture_point(page: Page, device: dict) -> tuple[float, float]:
    """Approximate screen position of the sculpture (right ~55% on desktop, upper 55% on mobile)."""
    x, y, w, h = stage_box(page)
    if device["name"] == "mobile":
        return x + w * 0.5, y + h * 0.3
    return x + w * 0.66, y + h * 0.5


def figure_eight(page: Page, duration_ms: int, steps: int = 80) -> None:
    """Slow Lissajous figure-8 over the stage (pointer parallax / hover response)."""
    x, y, w, h = stage_box(page)
    cx, cy = x + w / 2, y + h / 2
    ax, ay = w * 0.35, h * 0.28
    log(f"  figure-8 pointer sweep over the stage for {duration_ms} ms")
    dt = duration_ms / max(steps, 1)
    t0 = time.monotonic()
    for i in range(steps + 1):
        t = i / steps * 2 * math.pi
        page.mouse.move(cx + ax * math.sin(t), cy + ay * math.sin(2 * t))
        target = t0 + (i + 1) * dt / 1000.0
        remaining = target - time.monotonic()
        if remaining > 0:
            time.sleep(remaining)


def drag_sculpture(page: Page, device: dict, dx: float = 300, dy: float = 0, duration_ms: int = 900) -> None:
    sx, sy = sculpture_point(page, device)
    steps = 30
    log(f"  drag sculpture by ({dx:.0f}, {dy:.0f}) px from ({sx:.0f}, {sy:.0f})")
    page.mouse.move(sx, sy)
    page.mouse.down()
    per_step = duration_ms / steps
    for i in range(1, steps + 1):
        page.mouse.move(sx + dx * i / steps, sy + dy * i / steps)
        sleep_ms(per_step)
    page.mouse.up()


def burst(page: Page, out_dir: Path, every_ms: int, total_ms: int, prefix: str = "frame") -> list[Path]:
    """Screenshot every ``every_ms`` for ``total_ms``; file names carry the actual elapsed ms.

    On SwiftShader a screenshot can take longer than the interval; frames are then taken
    as fast as possible and the time stamp in the name is the truth.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    t0 = time.monotonic()
    index = 0
    while True:
        target = index * every_ms / 1000.0
        now = time.monotonic() - t0
        if target > total_ms / 1000.0:
            break
        if now < target:
            time.sleep(target - now)
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        path = out_dir / f"{prefix}_{index:03d}_{elapsed_ms:05d}ms.png"
        page.screenshot(path=str(path))
        wrote(path)
        written.append(path)
        index += 1
    return written


def shot(page: Page, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(path))
    wrote(path)


# --------------------------------------------------------------------------------------
# Subcommand: shots
# --------------------------------------------------------------------------------------


def cmd_shots(session: Session, args: argparse.Namespace) -> None:
    s = session.settings
    devices = [DESKTOP, MOBILE]
    if args.device != "both":
        devices = [d for d in devices if d["name"] == args.device]

    for device in devices:
        log(f"\n== shots: {device['name']} {device['width']}x{device['height']}")
        ctx = session.context(device)
        try:
            for pose in POSES:
                page = session.open(ctx, "/", f"shots/{device['name']}/{pose}", nointro=True, pose=pose)
                sleep_ms(s.settle_ms)
                shot(page, s.out / f"{device['name']}-{pose}.png")
                page.close()

            if not args.skip_bursts:
                # M10 preview. Default: the intro plays first (3.0 s + 0.6 s), then the 4.0 s
                # set-piece, so M10 occupies roughly 3.6-7.6 s of the burst; the intro doubles as a
                # SwiftShader shader warm-up so the CONVERGE beat is not lost to the first slow frames.
                # --complete-nointro starts M10 at ~0 s instead.
                page = session.open(
                    ctx,
                    "/",
                    f"shots/{device['name']}/complete",
                    preview="complete",
                    nointro=bool(args.complete_nointro),
                )
                log(
                    "  M10 window in this burst: "
                    + ("~0.0-4.0 s (nointro)" if args.complete_nointro else "~3.6-7.6 s (after the intro)")
                )
                burst(
                    page,
                    s.out / "complete" / device["name"],
                    every_ms=args.complete_every,
                    total_ms=args.complete_total,
                )
                page.close()

                # Intro burst.
                page = session.open(ctx, "/", f"shots/{device['name']}/intro")
                burst(
                    page,
                    s.out / "intro" / device["name"],
                    every_ms=args.intro_every,
                    total_ms=args.intro_total,
                )
                page.close()
        finally:
            ctx.close()


# --------------------------------------------------------------------------------------
# Subcommand: video
# --------------------------------------------------------------------------------------


def _finish_video(ctx: BrowserContext, page: Page | None, target: Path) -> None:
    video = page.video if page is not None else None
    ctx.close()  # flushes the .webm
    if video is None:
        log("  WARNING: no video was recorded for this context")
        return
    src = video.path()
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()
    shutil.move(str(src), str(target))
    wrote(target)


def video_desktop(session: Session, args: argparse.Namespace) -> None:
    s = session.settings
    device = DESKTOP
    log(f"\n== video: desktop {device['width']}x{device['height']}")
    tmp_dir = s.out / "_video_tmp" / "desktop"
    ctx = session.context(device, record_video_dir=tmp_dir)
    page: Page | None = None
    try:
        page = session.open(ctx, "/", "video/desktop")
        sleep_ms(args.intro_wait)  # intro (3.0 s choreography)
        figure_eight(page, args.hover_ms)
        drag_sculpture(page, device, dx=300)
        sleep_ms(1200)  # elastic release
        set_mode(page, "short", settle_ms=args.mode_wait)
        set_mode(page, "long", settle_ms=args.mode_wait)
        set_mode(page, "focus", settle_ms=800)
        click(page, "#btn-start")  # start
        sleep_ms(2000)
        click(page, "#btn-start")  # pause
        sleep_ms(2000)
        click(page, "#btn-start")  # resume
        sleep_ms(1000)
        session.navigate(page, "/", "video/desktop/complete", preview="complete", nointro=True)
        sleep_ms(args.complete_wait)
    finally:
        _finish_video(ctx, page, s.out / "demo-desktop.webm")


def video_mobile(session: Session, args: argparse.Namespace) -> None:
    s = session.settings
    device = MOBILE
    log(f"\n== video: mobile {device['width']}x{device['height']}")
    tmp_dir = s.out / "_video_tmp" / "mobile"
    ctx = session.context(device, record_video_dir=tmp_dir)
    page: Page | None = None
    try:
        page = session.open(ctx, "/", "video/mobile")
        sleep_ms(args.intro_wait)  # intro
        # Tap the sculpture (M11 stand-in for hover on touch) twice.
        sx, sy = sculpture_point(page, device)
        log(f"  tap sculpture at ({sx:.0f}, {sy:.0f})")
        page.touchscreen.tap(sx, sy)
        sleep_ms(900)
        page.touchscreen.tap(sx + 30, sy - 20)
        sleep_ms(900)
        drag_sculpture(page, device, dx=180, duration_ms=700)
        sleep_ms(1200)
        set_mode(page, "short", touch=True, settle_ms=max(args.mode_wait - 800, 1200))
        set_mode(page, "long", touch=True, settle_ms=max(args.mode_wait - 800, 1200))
        set_mode(page, "focus", touch=True, settle_ms=600)
        click(page, "#btn-start", touch=True)  # start
        sleep_ms(1500)
        click(page, "#btn-start", touch=True)  # pause
        sleep_ms(1500)
        click(page, "#btn-start", touch=True)  # resume
        sleep_ms(800)
        session.navigate(page, "/", "video/mobile/complete", preview="complete", nointro=True)
        sleep_ms(args.complete_wait)
    finally:
        _finish_video(ctx, page, s.out / "demo-mobile.webm")


def cmd_video(session: Session, args: argparse.Namespace) -> None:
    tmp = session.settings.out / "_video_tmp"
    try:
        if args.device in ("both", "desktop"):
            video_desktop(session, args)
        if args.device in ("both", "mobile"):
            video_mobile(session, args)
    finally:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)


# --------------------------------------------------------------------------------------
# Subcommand: fps
# --------------------------------------------------------------------------------------


def cmd_fps(session: Session, args: argparse.Namespace) -> None:
    s = session.settings
    device = DESKTOP if args.device != "mobile" else MOBILE
    log(f"\n== fps: {device['name']} {device['width']}x{device['height']}")
    ctx = session.context(device)
    try:
        page = session.open(ctx, "/", "fps", fps=True, nointro=True, pose=args.pose)
        renderer = page.evaluate(WEBGL_RENDERER_JS)
        log(f"  WebGL renderer: {renderer}")
        sleep_ms(args.warmup)
        samples: list[float] = []
        misses = 0
        for _ in range(max(args.samples, 1)):
            value = page.evaluate("() => (typeof window.__fps === 'number' ? window.__fps : null)")
            if isinstance(value, (int, float)):
                samples.append(float(value))
            else:
                misses += 1
            sleep_ms(args.sample_interval)
        stats = page.evaluate(STAGE_STATS_JS)
        if not samples:
            raise CaptureError(
                EXIT_NO_MEASUREMENT,
                "window.__fps is not a number - nothing was measured (the frame loop in src/main.ts "
                "did not run or the fps meter is not exposed)",
                hint="No fps figure may be claimed from this run.",
            )
        avg = sum(samples) / len(samples)
        log(f"  fps samples ({len(samples)}): {', '.join(f'{v:.1f}' for v in samples)}" + (f"  ({misses} missed)" if misses else ""))
        log(f"  fps average: {avg:.1f}  (min {min(samples):.1f}, max {max(samples):.1f})")
        if isinstance(stats, dict):
            log(
                f"  stage stats: {stats.get('drawCalls')} draw calls, "
                f"{stats.get('triangles')} triangles, stage fps {stats.get('fps')}"
            )
        log(f"  measured on: {renderer}  [{'headed, real GPU' if s.headed else 'headless SwiftShader'}]")
        if not s.headed or "swiftshader" in str(renderer).lower():
            log(
                "  WARNING: this is a software-GL (SwiftShader) reading. It is NOT representative of "
                "real GPU performance; rerun with --headed for a number you can quote."
            )
    finally:
        ctx.close()


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="capture.py",
        description="Focus Sanctuary visual QA capture (Playwright + Chromium).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--url", default=DEFAULT_URL, help="base URL of the running vite dev server (use the port Vite printed)")
    p.add_argument("--out", default=str(DEFAULT_OUT), help="output directory (created)")
    p.add_argument("--headed", action="store_true", help="run a visible Chromium on the real GPU (default: headless SwiftShader)")
    p.add_argument("--settle", type=int, default=6000, help="ms to wait after boot before a still screenshot")
    p.add_argument("--load-timeout", type=int, default=60000, help="ms allowed for page load and the app boot signal")
    p.add_argument("--fps-param", action="store_true", help="append ?fps=1 to every URL (shows the in-app fps meter)")
    p.add_argument("--quality", choices=["high", "medium", "low"], default=None, help="force ?quality= on every URL")
    p.add_argument("--allow-fallback", action="store_true", help="capture the #fallback composition instead of failing when 3D is unavailable")

    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("shots", help="still screenshots per pose + intro/complete frame bursts", formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    sp.add_argument("--device", choices=["both", "desktop", "mobile"], default="both")
    sp.add_argument("--skip-bursts", action="store_true", help="only the per-pose stills")
    sp.add_argument("--complete-every", type=int, default=300, help="ms between frames of the ?preview=complete burst")
    sp.add_argument("--complete-total", type=int, default=11000, help="ms of ?preview=complete burst (intro 3.6 s + M10 4 s + settle)")
    sp.add_argument("--complete-nointro", action="store_true", help="open the complete burst with nointro=1 (M10 starts at ~0 s; use --complete-total ~6000)")
    sp.add_argument("--intro-every", type=int, default=250, help="ms between frames of the intro burst")
    sp.add_argument("--intro-total", type=int, default=3500, help="ms of intro burst")
    sp.set_defaults(func=cmd_shots)

    vp = sub.add_parser("video", help="scripted demo recordings -> demo-desktop.webm / demo-mobile.webm", formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    vp.add_argument("--device", choices=["both", "desktop", "mobile"], default="both")
    vp.add_argument("--intro-wait", type=int, default=3500, help="ms to wait for the intro after boot")
    vp.add_argument("--hover-ms", type=int, default=3000, help="ms of figure-8 pointer sweep (desktop)")
    vp.add_argument("--mode-wait", type=int, default=2500, help="ms to hold each break mode")
    vp.add_argument("--complete-wait", type=int, default=5000, help="ms to hold ?preview=complete&nointro=1 at the end (M10 is 4 s)")
    vp.set_defaults(func=cmd_video)

    fp = sub.add_parser("fps", help="read window.__fps after warm-up (exit 3 when nothing was measured)", formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    fp.add_argument("--device", choices=["desktop", "mobile"], default="desktop")
    fp.add_argument("--pose", choices=POSES, default="idle", help="visual pose while measuring")
    fp.add_argument("--warmup", type=int, default=8000, help="ms to wait before the first sample")
    fp.add_argument("--samples", type=int, default=3, help="number of readings")
    fp.add_argument("--sample-interval", type=int, default=1000, help="ms between readings")
    fp.set_defaults(func=cmd_fps)
    return p


def main(argv: list[str] | None = None) -> int:
    try:  # print UTF-8 (the app title has an em dash) even on legacy Windows code pages
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass
    args = build_parser().parse_args(argv)
    settings = Settings(
        url=args.url,
        out=Path(args.out).resolve(),
        headed=args.headed,
        settle_ms=args.settle,
        load_timeout_ms=args.load_timeout,
        fps_param=args.fps_param,
        quality=args.quality,
        allow_fallback=args.allow_fallback,
    )
    settings.out.mkdir(parents=True, exist_ok=True)
    log(f"Focus Sanctuary capture - {args.command}")
    log(f"  base url : {settings.url}")
    log(f"  output   : {settings.out}")
    log(f"  renderer : {'real GPU (headed)' if settings.headed else 'headless SwiftShader (software GL)'}")

    console = ConsoleLog(base_origin=origin_of(settings.url), allow_fallback=settings.allow_fallback)
    func: Callable[[Session, argparse.Namespace], None] = args.func
    exit_code = EXIT_OK
    with sync_playwright() as pw:
        session: Session | None = None
        try:
            session = Session(pw, settings, console)
            func(session, args)
        except CaptureError as exc:
            log(f"\nFAILED (exit {exc.code}): {exc}")
            if exc.hint:
                log(f"  {exc.hint}")
            exit_code = exc.code
        except PlaywrightError as exc:
            log(f"\nPlaywright error: {exc}")
            log("Is the vite dev server running at the base url? (npm run dev; use --url with the port Vite printed)")
            log("If Chromium itself failed to launch: `python -m playwright install chromium`.")
            exit_code = EXIT_PLAYWRIGHT
        finally:
            if session is not None:
                session.close()
    report_code = console.report()
    if exit_code:
        log(f"\nexit {exit_code}")
        return exit_code
    if report_code:
        log(f"\nexit {report_code}")
    return report_code


if __name__ == "__main__":
    sys.exit(main())
