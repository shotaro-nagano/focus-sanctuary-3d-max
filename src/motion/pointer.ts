// ---------------------------------------------------------------------------
// PointerController - raw pointer / drag / touch gestures for the stage.
//
// Emits normalized pointer coordinates (-1..1, x right, y up, relative to the
// stage element rect), drag deltas in CSS px while a sculpture drag is active,
// and mobile gestures (tap / long-press). It never touches SceneParams: the
// MotionDirector smooths and springs everything it receives from here.
// ---------------------------------------------------------------------------

export interface PointerControllerOptions {
  /** the stage element (canvas parent) */
  element: HTMLElement;
  /** normalized -1..1 pointer (x right, y up); null when the pointer left the page */
  onPointer(x: number | null, y: number | null): void;
  /** raw drag delta in CSS px while dragging */
  onDrag(dx: number, dy: number): void;
  onDragEnd(): void;
  /** touch tap on the sculpture (mobile flare); normalized coordinates */
  onTap?(x: number, y: number): void;
  /** 500 ms hold (mobile macro dolly): true on hold, false on release */
  onLongPress?(active: boolean): void;
  /** elements/ancestors matching this selector never start a drag */
  ignoreSelector: string;
}

const TAP_MAX_MS = 250;
const TAP_MAX_PX = 8;
const LONG_PRESS_MS = 500;
/** touch drags start only after this much travel (so a tap / long-press is not a 0px drag) */
const TOUCH_DRAG_START_PX = 8;

interface ActivePointer {
  id: number;
  type: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startTime: number;
  /** drag deltas are being forwarded */
  dragging: boolean;
  /** long-press fired (touch only) */
  longPressed: boolean;
  /** pointer capture was acquired on the element */
  captured: boolean;
  /** touch moved vertically first: the gesture belongs to the page (scroll), not the sculpture */
  abandoned: boolean;
}

export class PointerController {
  private readonly el: HTMLElement;
  private readonly opts: PointerControllerOptions;
  private rect: DOMRect;
  private active: ActivePointer | null = null;
  /** number of touch contacts currently down on the element (multi-touch guard) */
  private touchCount = 0;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly prevTouchAction: string | null;
  private disposed = false;

  constructor(opts: PointerControllerOptions) {
    this.opts = opts;
    this.el = opts.element;
    this.rect = this.el.getBoundingClientRect();
    // The stylesheet may constrain touch-action itself (mobile: `pan-y` so the page still scrolls).
    // Only when it leaves the default do we take the whole gesture surface for the sculpture.
    let computed = 'auto';
    try {
      computed = getComputedStyle(this.el).touchAction || 'auto';
    } catch {
      /* non-browser environment */
    }
    if (computed === 'auto') {
      this.prevTouchAction = this.el.style.touchAction;
      this.el.style.touchAction = 'none';
    } else {
      this.prevTouchAction = null;
    }

    window.addEventListener('pointermove', this.onMove, { passive: true });
    window.addEventListener('pointerup', this.onUp, { passive: true });
    window.addEventListener('pointercancel', this.onCancel, { passive: true });
    window.addEventListener('resize', this.onResize, { passive: true });
    window.addEventListener('scroll', this.onResize, { passive: true });
    window.addEventListener('blur', this.onBlur);
    document.documentElement.addEventListener('pointerleave', this.onLeave);
    this.el.addEventListener('pointerdown', this.onDown);
    // The only non-passive listener: block scroll/zoom gestures while a touch drag is live.
    this.el.addEventListener('touchmove', this.onTouchMove, { passive: false });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearLongPress();
    if (this.active) {
      this.releaseCapture(this.active);
      if (this.active.dragging) this.opts.onDragEnd();
      if (this.active.longPressed) this.opts.onLongPress?.(false);
      this.active = null;
    }
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onCancel);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('scroll', this.onResize);
    window.removeEventListener('blur', this.onBlur);
    document.documentElement.removeEventListener('pointerleave', this.onLeave);
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('touchmove', this.onTouchMove);
    if (this.prevTouchAction !== null) this.el.style.touchAction = this.prevTouchAction;
  }

  // ---- helpers ------------------------------------------------------------

  private refreshRect(): void {
    this.rect = this.el.getBoundingClientRect();
  }

  /** client px -> normalized -1..1 (x right, y up), clamped to the unit square */
  private normalize(clientX: number, clientY: number): [number, number] {
    const w = this.rect.width || 1;
    const h = this.rect.height || 1;
    let nx = ((clientX - this.rect.left) / w) * 2 - 1;
    let ny = -(((clientY - this.rect.top) / h) * 2 - 1);
    nx = nx < -1 ? -1 : nx > 1 ? 1 : nx;
    ny = ny < -1 ? -1 : ny > 1 ? 1 : ny;
    return [nx, ny];
  }

  private isIgnored(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return target.closest(this.opts.ignoreSelector) !== null;
  }

  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private releaseCapture(p: ActivePointer): void {
    if (!p.captured) return;
    p.captured = false;
    try {
      if (this.el.hasPointerCapture(p.id)) this.el.releasePointerCapture(p.id);
    } catch {
      /* capture may already be gone */
    }
  }

  private finishPointer(p: ActivePointer, cancelled: boolean): void {
    this.clearLongPress();
    this.releaseCapture(p);
    const isTouch = p.type === 'touch';

    if (p.dragging) {
      this.opts.onDragEnd();
    } else if (p.longPressed) {
      this.opts.onLongPress?.(false);
    } else if (isTouch && !cancelled && !p.abandoned) {
      const dx = p.lastX - p.startX;
      const dy = p.lastY - p.startY;
      const dist = Math.hypot(dx, dy);
      const elapsed = performance.now() - p.startTime;
      if (elapsed < TAP_MAX_MS && dist < TAP_MAX_PX) {
        const [nx, ny] = this.normalize(p.lastX, p.lastY);
        this.opts.onTap?.(nx, ny);
      }
    }

    if (isTouch) {
      // no hover on touch: the pointer is gone once the finger lifts
      this.opts.onPointer(null, null);
    }
  }

  // ---- listeners ----------------------------------------------------------

  private readonly onResize = (): void => {
    this.refreshRect();
  };

  /** abandon the in-flight gesture as cancelled (no pointerup will ever arrive for it) */
  private abortActive(): void {
    const p = this.active;
    if (!p) return;
    this.active = null;
    this.finishPointer(p, true);
  }

  /**
   * The pointer left the document. A captured gesture keeps receiving events outside the window
   * (and capture suppresses boundary events), so only an uncaptured one is stranded here.
   */
  private readonly onLeave = (): void => {
    if (this.disposed) return;
    if (this.active && !this.active.captured) this.abortActive();
    this.opts.onPointer(null, null);
  };

  /** the OS / another window took focus mid-gesture: no pointerup will follow, release everything */
  private readonly onBlur = (): void => {
    if (this.disposed) return;
    this.abortActive();
    this.touchCount = 0;
    this.opts.onPointer(null, null);
  };

  private readonly onDown = (e: PointerEvent): void => {
    if (this.disposed) return;
    const isTouch = e.pointerType === 'touch';

    if (isTouch) {
      this.touchCount += 1;
      if (this.touchCount > 1) {
        // multi-touch (pinch / two fingers): abandon any single-finger gesture, ignore the rest
        if (this.active) {
          const p = this.active;
          this.active = null;
          this.clearLongPress();
          this.releaseCapture(p);
          if (p.dragging) this.opts.onDragEnd();
          if (p.longPressed) this.opts.onLongPress?.(false);
        }
        return;
      }
    } else if (e.button !== 0) {
      return; // only the primary button orbits
    }

    if (this.active) return; // a gesture is already in flight
    if (this.isIgnored(e.target)) return;

    this.refreshRect();
    const p: ActivePointer = {
      id: e.pointerId,
      type: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      startTime: performance.now(),
      dragging: !isTouch, // mouse / pen: orbit from the first move
      longPressed: false,
      captured: false,
      abandoned: false,
    };
    try {
      this.el.setPointerCapture(e.pointerId);
      p.captured = true;
    } catch {
      /* capture is best effort */
    }
    this.active = p;

    if (isTouch) {
      const [nx, ny] = this.normalize(e.clientX, e.clientY);
      this.opts.onPointer(nx, ny);
      this.clearLongPress();
      this.longPressTimer = setTimeout(() => {
        this.longPressTimer = null;
        const cur = this.active;
        if (!cur || cur.id !== p.id || cur.dragging) return;
        cur.longPressed = true;
        this.opts.onLongPress?.(true);
      }, LONG_PRESS_MS);
    }
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (this.disposed) return;
    const p = this.active;

    if (e.pointerType !== 'touch') {
      const [nx, ny] = this.normalize(e.clientX, e.clientY);
      this.opts.onPointer(nx, ny);
    }

    if (!p || p.id !== e.pointerId) return;

    if (p.type !== 'touch' && e.buttons === 0) {
      // the button was released while we could not see it (focus loss, modal, OS gesture): end the orbit
      this.abortActive();
      return;
    }

    const dx = e.clientX - p.lastX;
    const dy = e.clientY - p.lastY;
    p.lastX = e.clientX;
    p.lastY = e.clientY;

    if (p.type === 'touch') {
      if (p.abandoned) return; // the page owns this gesture (vertical scroll)
      const [nx, ny] = this.normalize(e.clientX, e.clientY);
      this.opts.onPointer(nx, ny);
      if (p.longPressed) return; // holding the macro: no orbit
      if (!p.dragging) {
        const tx = e.clientX - p.startX;
        const ty = e.clientY - p.startY;
        const travel = Math.hypot(tx, ty);
        if (travel < TOUCH_DRAG_START_PX) return;
        this.clearLongPress();
        if (Math.abs(ty) > Math.abs(tx)) {
          // vertical intent: never capture a page scroll (the browser usually pointercancels anyway)
          p.abandoned = true;
          this.releaseCapture(p);
          return;
        }
        p.dragging = true;
        // forward the accumulated travel so the orbit does not pop at the threshold
        this.opts.onDrag(tx, ty);
        return;
      }
    }

    if (p.dragging && (dx !== 0 || dy !== 0)) this.opts.onDrag(dx, dy);
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (this.disposed) return;
    if (e.pointerType === 'touch' && this.touchCount > 0) this.touchCount -= 1;
    const p = this.active;
    if (!p || p.id !== e.pointerId) return;
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    this.active = null;
    this.finishPointer(p, false);
  };

  private readonly onCancel = (e: PointerEvent): void => {
    if (this.disposed) return;
    if (e.pointerType === 'touch' && this.touchCount > 0) this.touchCount -= 1;
    const p = this.active;
    if (!p || p.id !== e.pointerId) return;
    this.active = null;
    this.finishPointer(p, true);
  };

  private readonly onTouchMove = (e: TouchEvent): void => {
    const p = this.active;
    if (p && p.type === 'touch' && (p.dragging || p.longPressed) && e.cancelable) e.preventDefault();
  };
}
