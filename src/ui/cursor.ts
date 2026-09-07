// Custom cursor: dot + ring + label. Only on (pointer: fine). The ring lags the
// dot with damping and stretches along the velocity vector; the label reads
// DRAG over the stage and PRESS over buttons / inputs. Hidden when the pointer
// leaves the window and on touch devices.

export interface CursorOptions {
  /** the element that receives sculpture drags (label DRAG) */
  stage: HTMLElement;
  /** selector for elements that read PRESS */
  pressSelector?: string;
}

export interface CursorController {
  readonly enabled: boolean;
  /** force a label (null = automatic) — e.g. 'HOLD' during a drag */
  setLabel(text: string | null): void;
  dispose(): void;
}

const damp = (a: number, b: number, lambda: number, dt: number): number => a + (b - a) * (1 - Math.exp(-lambda * dt));

export function createCursor(root: HTMLElement, opts: CursorOptions): CursorController {
  const fine =
    typeof window !== 'undefined' &&
    window.matchMedia('(pointer: fine)').matches &&
    !window.matchMedia('(pointer: coarse)').matches;

  const dot = root.querySelector<HTMLElement>('.cursor-dot');
  const ring = root.querySelector<HTMLElement>('.cursor-ring');
  const labelEl = root.querySelector<HTMLElement>('.cursor-label');
  if (!fine || !dot || !ring || !labelEl) {
    root.hidden = true;
    return { enabled: false, setLabel: () => undefined, dispose: () => undefined };
  }

  const pressSelector = opts.pressSelector ?? 'button, input, a, [role="button"], label';
  const textSelector = 'input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], textarea, [contenteditable=""], [contenteditable="true"]';
  document.documentElement.classList.add('has-cursor');

  let px = window.innerWidth / 2;
  let py = window.innerHeight / 2;
  let rx = px;
  let ry = py;
  let vx = 0;
  let vy = 0;
  let visible = false;
  let raf = 0;
  let lastT = 0;
  let forcedLabel: string | null = null;
  let autoLabel = '';
  let hot = false;
  let overStage = false;
  let pressed = false;

  const setLabelText = (t: string): void => {
    if (labelEl.textContent !== t) labelEl.textContent = t;
    root.classList.toggle('has-label', t.length > 0);
  };

  const classify = (target: EventTarget | null): void => {
    const el = target instanceof Element ? target : null;
    // text fields get an I-beam (the OS cursor is suppressed globally while the custom one is on)
    const text = !!el?.closest(textSelector);
    hot = !text && !!el?.closest(pressSelector);
    overStage = !hot && !text && !!el?.closest('.stage');
    autoLabel = hot ? 'PRESS' : overStage ? 'DRAG' : '';
    root.classList.toggle('is-text', text);
    root.classList.toggle('is-hot', hot);
    root.classList.toggle('is-drag', overStage);
    setLabelText(forcedLabel ?? autoLabel);
  };

  const frame = (t: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = lastT ? Math.min((t - lastT) / 1000, 0.05) : 1 / 60;
    lastT = t;
    const nrx = damp(rx, px, 18, dt);
    const nry = damp(ry, py, 18, dt);
    vx = damp(vx, (nrx - rx) / Math.max(dt, 1e-4), 12, dt);
    vy = damp(vy, (nry - ry) / Math.max(dt, 1e-4), 12, dt);
    rx = nrx;
    ry = nry;
    const speed = Math.hypot(vx, vy);
    const stretch = 1 + Math.min(speed / 2600, 0.55);
    const angle = speed > 30 ? Math.atan2(vy, vx) : 0;
    dot.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0) translate(-50%, -50%)`;
    ring.style.transform =
      `translate3d(${rx.toFixed(1)}px, ${ry.toFixed(1)}px, 0) translate(-50%, -50%) ` +
      `rotate(${angle.toFixed(3)}rad) scale(${stretch.toFixed(3)}, ${(1 / Math.sqrt(stretch)).toFixed(3)})`;
    labelEl.style.transform = `translate3d(${(rx + 22).toFixed(1)}px, ${(ry - 6).toFixed(1)}px, 0)`;
    // stop the loop when idle and settled
    if (!visible && Math.abs(rx - px) < 0.2 && Math.abs(ry - py) < 0.2) {
      cancelAnimationFrame(raf);
      raf = 0;
      lastT = 0;
    }
  };
  const ensureLoop = (): void => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const show = (): void => {
    if (visible) return;
    visible = true;
    root.classList.add('is-visible');
  };
  const hide = (): void => {
    if (!visible) return;
    visible = false;
    root.classList.remove('is-visible');
  };

  const onMove = (ev: PointerEvent): void => {
    if (ev.pointerType && ev.pointerType !== 'mouse' && ev.pointerType !== 'pen') {
      hide();
      return;
    }
    px = ev.clientX;
    py = ev.clientY;
    if (!visible) {
      rx = px;
      ry = py;
    }
    show();
    classify(ev.target);
    ensureLoop();
  };
  const onOut = (ev: PointerEvent): void => {
    if (ev.relatedTarget === null) hide();
  };
  const onDown = (ev: PointerEvent): void => {
    if (ev.pointerType && ev.pointerType !== 'mouse' && ev.pointerType !== 'pen') return;
    pressed = true;
    root.classList.add('is-press');
  };
  const onUp = (): void => {
    if (!pressed) return;
    pressed = false;
    root.classList.remove('is-press');
  };
  const onBlur = (): void => hide();
  const onVis = (): void => {
    if (document.hidden) hide();
  };

  window.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerout', onOut);
  window.addEventListener('pointerdown', onDown, { passive: true });
  window.addEventListener('pointerup', onUp, { passive: true });
  window.addEventListener('pointercancel', onUp, { passive: true });
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVis);

  return {
    enabled: true,
    setLabel(text) {
      forcedLabel = text;
      setLabelText(forcedLabel ?? autoLabel);
    },
    dispose() {
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerout', onOut);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVis);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      root.classList.remove('is-visible', 'is-hot', 'is-drag', 'is-text', 'is-press', 'has-label');
      document.documentElement.classList.remove('has-cursor');
    },
  };
}
