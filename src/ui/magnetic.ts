// M11 — magnetic buttons. Within `radius` px of the element's edge the element is
// pulled toward the pointer (up to `strength` of the distance), springs back on
// leave, and a press scales it to 0.96 with a gradient shift (CSS `.is-pressed`).
// Not attached on coarse pointers (touch) — the press class still fires there
// so the tactile response exists on mobile.
import { gsap } from 'gsap';

export interface MagneticOptions {
  /** activation distance from the element edge in px (default 24) */
  radius?: number;
  /** fraction of the pointer offset applied as translation (default 0.35) */
  strength?: number;
  onPress?: () => void;
}

interface Entry {
  el: HTMLElement;
  radius: number;
  strength: number;
  xTo: (v: number) => void;
  yTo: (v: number) => void;
  inside: boolean;
}

const registry = new Set<Entry>();
let moveBound = false;
let lastX = 0;
let lastY = 0;
let raf = 0;

function isFinePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches && !window.matchMedia('(pointer: coarse)').matches;
}

function process(): void {
  raf = 0;
  for (const e of registry) {
    if (e.el.hasAttribute('disabled') || e.el.closest('.is-locked')) {
      if (e.inside) release(e);
      continue;
    }
    const r = e.el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = lastX - cx;
    const dy = lastY - cy;
    const ox = Math.max(Math.abs(dx) - r.width / 2, 0);
    const oy = Math.max(Math.abs(dy) - r.height / 2, 0);
    const dist = Math.hypot(ox, oy);
    if (dist <= e.radius) {
      e.inside = true;
      e.el.classList.add('is-magnet');
      const falloff = 1 - dist / (e.radius + 1);
      e.xTo(dx * e.strength * falloff);
      e.yTo(dy * e.strength * falloff);
    } else if (e.inside) {
      release(e);
    }
  }
}

function release(e: Entry): void {
  e.inside = false;
  e.el.classList.remove('is-magnet');
  gsap.to(e.el, { x: 0, y: 0, duration: 1.1, ease: 'elastic.out(1, 0.45)', overwrite: 'auto' });
}

function onMove(ev: PointerEvent): void {
  lastX = ev.clientX;
  lastY = ev.clientY;
  if (!raf) raf = requestAnimationFrame(process);
}

function onLeaveWindow(ev: PointerEvent): void {
  if (ev.relatedTarget === null) {
    for (const e of registry) if (e.inside) release(e);
  }
}

function bindGlobal(): void {
  if (moveBound) return;
  moveBound = true;
  window.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerout', onLeaveWindow);
}

function unbindGlobal(): void {
  if (!moveBound || registry.size > 0) return;
  moveBound = false;
  window.removeEventListener('pointermove', onMove);
  document.removeEventListener('pointerout', onLeaveWindow);
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}

export function attachMagnetic(el: HTMLElement, opts: MagneticOptions = {}): () => void {
  const { radius = 24, strength = 0.35, onPress } = opts;
  const fine = isFinePointer();

  const down = (ev: PointerEvent): void => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    if (el.hasAttribute('disabled')) return;
    el.classList.add('is-pressed');
    gsap.to(el, { scale: 0.96, duration: 0.12, ease: 'power2.out', overwrite: 'auto' });
    onPress?.();
  };
  const up = (): void => {
    if (!el.classList.contains('is-pressed')) return;
    el.classList.remove('is-pressed');
    gsap.to(el, { scale: 1, duration: 0.55, ease: 'back.out(2.2)', overwrite: 'auto' });
  };
  const keyDown = (ev: KeyboardEvent): void => {
    if ((ev.key === 'Enter' || ev.key === ' ') && !ev.repeat) {
      el.classList.add('is-pressed');
      gsap.to(el, { scale: 0.96, duration: 0.12, ease: 'power2.out', overwrite: 'auto' });
      onPress?.();
    }
  };
  const keyUp = (): void => up();

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
  el.addEventListener('keydown', keyDown);
  el.addEventListener('keyup', keyUp);
  el.addEventListener('blur', keyUp);

  let entry: Entry | null = null;
  if (fine) {
    const quick = (prop: 'x' | 'y') =>
      gsap.quickTo(el, prop, { duration: 0.45, ease: 'power3.out' }) as unknown as (v: number) => void;
    entry = { el, radius, strength, xTo: quick('x'), yTo: quick('y'), inside: false };
    registry.add(entry);
    bindGlobal();
  }

  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('pointerleave', up);
    el.removeEventListener('keydown', keyDown);
    el.removeEventListener('keyup', keyUp);
    el.removeEventListener('blur', keyUp);
    if (entry) {
      registry.delete(entry);
      unbindGlobal();
    }
    gsap.killTweensOf(el);
    gsap.set(el, { clearProps: 'transform' });
    el.classList.remove('is-pressed', 'is-magnet');
  };
}
