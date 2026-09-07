# tools/capture.py - visual QA & deliverable capture

A Python 3.12 + Playwright (sync API, Chromium) script that drives the running Vite dev
server and produces screenshots, frame bursts and demo videos. Every URL it opens carries
`?storage=memory`, so no real Pomodoro records are read or written.

The tool is built so that it **cannot report success for a page that did not boot**: it
checks that the base URL serves this app, waits for a real boot signal from `src/main.ts`,
fails fast on the Vite error overlay / same-origin HTTP errors / uncaught exceptions, and
uses distinct exit codes (see below). It never writes a capture of an error overlay.

## Prerequisites

- The dev server running: `npm run dev`. Its default is `http://127.0.0.1:5173`, **but
  `strictPort` is off in `vite.config.ts`**: when 5173 is busy Vite silently moves to
  5174/5175/... and prints the port it took. Pass that port with `--url`; the tool refuses
  to capture a page that is not this app (title + `#console`, `#btn-start`, `#gl`, `#stage`).
- Python 3.12 with `playwright` and its Chromium build installed (already present on this
  machine; do not `pip install`). If Chromium is missing: `python -m playwright install chromium`.

## Usage

```
python tools/capture.py [global flags] <subcommand> [subcommand flags]
```

Global flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--url` | `http://127.0.0.1:5173` | Base URL of the dev server (use the port Vite printed) |
| `--out` | `<repo>/captures` | Output directory (created) |
| `--headed` | off | Visible Chromium on the real GPU (see caveat below) |
| `--settle` | `6000` | ms to wait after boot before each still screenshot |
| `--load-timeout` | `60000` | ms allowed for page load and the app boot signal |
| `--fps-param` | off | Append `?fps=1` to every URL (in-app fps meter) |
| `--quality` | app default | Force `?quality=high|medium|low` |
| `--allow-fallback` | off | Capture the `#fallback` composition instead of failing when 3D is unavailable |

### Boot signal (what "loaded" means)

After every navigation the tool polls the page (every 100 ms, up to `--load-timeout`) for:

- `ready` - `window.__fs` exists (set at the end of `src/main.ts`) or three.js has written
  the `width`/`height` attributes on `#gl` (`renderer.setSize`); the raw canvas in
  `index.html` has neither, so static markup never counts as booted.
- `fallback` - `#fallback` is shown with `is-nowebgl` / `is-contextlost`. This is an honest
  state but it is not the sculpture: the run fails with exit 2 unless `--allow-fallback`
  (the `is-reduced` notice does not count; the real 3D renders behind it).
- `error` - a `<vite-error-overlay>` is present, a same-origin `document`/`script`/
  `stylesheet` answered >= 400 or failed (e.g. `/src/main.ts` -> 500 when a module is
  missing), or an uncaught exception was thrown: the run aborts with exit 2 and nothing is
  written for that page.

### `shots`

Per-pose stills for desktop (1440x900, DPR 1) and mobile (390x844, DPR 2, touch, mobile UA),
then two frame bursts per device.

```
python tools/capture.py shots
python tools/capture.py --url http://127.0.0.1:5174 shots --device desktop --skip-bursts
python tools/capture.py --settle 9000 shots --complete-every 200
```

Output

- `captures/<device>-<pose>.png` for `idle`, `focus`, `shortBreak`, `longBreak`, `paused`
  (opened as `/?nointro=1&pose=<pose>`; the dev pose param only changes the visual pose).
- `captures/complete/<device>/frame_NNN_MMMMMms.png` - `/?preview=complete`, a frame every
  300 ms for 11 s. The intro plays first (3.0 s + 0.6 s), then the 4.0 s M10 set-piece, so
  **M10 sits at roughly 3.6-7.6 s** of the burst and the RE-CONSTITUTE tail (2.2-4.0 s of
  M10) lands around 5.8-7.6 s; the remaining seconds show the settled break pose. The intro
  doubles as shader warm-up on SwiftShader so the CONVERGE beat is not lost to slow first
  frames. `--complete-nointro` opens the burst with `nointro=1` instead (M10 starts at
  ~0 s; pair it with `--complete-total 6000`). The file name carries the real elapsed ms of
  each frame - trust it over the frame index.
- `captures/intro/<device>/frame_NNN_MMMMMms.png` - `/` every 250 ms for 3.5 s.

Flags: `--device both|desktop|mobile`, `--skip-bursts`, `--complete-every`, `--complete-total`,
`--complete-nointro`, `--intro-every`, `--intro-total` (all ms).

### `video`

Scripted demo recordings via Playwright's `record_video_dir` (video size = viewport).

```
python tools/capture.py video
python tools/capture.py --headed video --device desktop
```

Desktop sequence (~25 s with the defaults): load `/`, wait for the intro (3.5 s), a 3 s
figure-8 pointer sweep over the stage, a 300 px drag of the sculpture and elastic release,
`SHORT` -> `LONG` -> `FOCUS` mode changes (2.5 s each; the discard confirmation is accepted via
`#confirm-yes` whenever it appears - the probe is skipped while the timer is idle, i.e. while
`#btn-start` reads `START`), START, PAUSE, RESUME, then `/?preview=complete&nointro=1` held
for 5 s for the completion set-piece (M10 is 4.0 s). Mobile does the same with taps instead
of hover (two sculpture taps, a shorter drag) and comes in at ~21 s.

Output: `captures/demo-desktop.webm`, `captures/demo-mobile.webm`. The temporary
`captures/_video_tmp/` directory is removed even when a run fails.

Flags: `--device`, `--intro-wait` (3500), `--hover-ms` (3000), `--mode-wait` (2500),
`--complete-wait` (5000) - all ms.

### `fps`

Opens `/?fps=1&nointro=1&pose=<pose>`, prints the WebGL renderer string
(`WEBGL_debug_renderer_info`, so a SwiftShader reading is visible in the evidence, not just
in a warning), waits for warm-up, then reads `window.__fps` (the app's rolling fps number)
several times and prints the samples, their average and `stage.getStats()` (draw calls,
triangles) when the app exposes them via `window.__fs`.

```
python tools/capture.py fps
python tools/capture.py --headed fps --device mobile --pose focus --samples 5
```

If no sample was a number the run exits **3** - nothing was measured and no fps figure may
be claimed from it.

Flags: `--device desktop|mobile`, `--pose`, `--warmup`, `--samples`, `--sample-interval`.

## Console errors & exit codes

Console `error` messages, uncaught page exceptions and same-origin HTTP failures from every
page are collected and printed at the end of the run. Exit codes:

- `0` - success (warnings and non-fatal errors are only printed)
- `1` - Playwright / server problem: dev server unreachable, the base URL serves a different
  app (check the port Vite printed), Chromium failed to launch
- `2` - the app failed to boot (Vite error overlay, same-origin `document`/`script`/
  `stylesheet` >= 400 or failed, uncaught exception, boot timeout), the `#fallback`
  composition was shown without `--allow-fallback`, or an error-level console message
  contains `THREE` or `Uncaught`
- `3` - `fps`: nothing was measured (`window.__fps` never became a number)

## Caveat: headless SwiftShader vs `--headed`

Headless Chromium is launched with `--use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader --ignore-gpu-blocklist --enable-webgl`, which means WebGL runs
on **SwiftShader, a CPU software rasterizer**. It is slow - a 1440x900 frame with
transmission and bloom can take hundreds of milliseconds - so:

- Frame bursts may not hit their nominal interval; trust the elapsed-ms stamp in the file
  name rather than the frame index.
- Videos will look choppy. They are still useful to check choreography and composition.
- `fps` numbers from headless runs are **not representative**; the script prints the
  renderer string and a warning.

Geometry, materials, post-processing and layout are rendered faithfully, so headless
captures are reliable for reviewing shape, shading and typography.

Pass `--headed` to open a visible Chromium window that uses the real GPU: the launch drops
the two SwiftShader flags and keeps `--use-gl=angle --ignore-gpu-blocklist --enable-webgl`,
so ANGLE picks its native backend (D3D11 on Windows). Use it for the final demo videos and
for any performance reading. Do not cover or minimize the window while it records.

## Notes

- Requires the app to honour the dev URL options in `src/config.ts`
  (`nointro`, `pose`, `preview=complete`, `storage`, `fps`, `quality`) and `src/main.ts` to
  expose `window.__fs` / `window.__fps` (boot signal and fps meter).
- Mobile contexts use `is_mobile`, `has_touch`, DPR 2 and an Android user agent so the app
  picks its mobile layout and touch behaviour (`(pointer: coarse)`).
- Output is UTF-8 even on a legacy Windows console code page (the app title has an em dash).
- The `captures/` directory is a build output; it is safe to delete.
