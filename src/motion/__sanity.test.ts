// Motion module sanity spec: pure-logic checks of the MotionDirector against the ARCHITECTURE §4 contract.
// Runs in node with fake DOM elements (typography is mocked); GSAP is driven manually via updateRoot.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { gsap } from 'gsap';

vi.mock('../ui/typography', () => {
  const tl = () => gsap.timeline().to({}, { duration: 0.5 });
  return {
    splitWord: vi.fn(() => []),
    revealWord: vi.fn(tl),
    hideWord: vi.fn(tl),
    swapWord: vi.fn(tl),
    assembleDigits: vi.fn(tl),
    bandWipe: vi.fn(tl),
    setWordText: vi.fn(),
  };
});

import { MotionDirector } from './Director';
import * as typo from '../ui/typography';
import type { UI } from '../ui/types';
import { FORM_POSES, CAMERA_POSES, PAUSE_OVERLAY } from '../shared/params';

let now = 0;
function step(director: MotionDirector, seconds: number, dt = 1 / 60): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    now += dt;
    gsap.updateRoot(now);
    director.update(dt);
  }
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function fakeEl(): HTMLElement {
  const classes = new Set<string>();
  const classList = {
    add: (...c: string[]) => c.forEach((x) => classes.add(x)),
    remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
    contains: (c: string) => classes.has(c),
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !classes.has(c);
      if (on) classes.add(c); else classes.delete(c);
      return on;
    },
  };
  return { children: [] as unknown as HTMLCollection, style: {}, classList } as unknown as HTMLElement;
}
function makeUI() {
  const consoleEl = fakeEl();
  const calls = { lock: [] as boolean[], pulse: 0 };
  const el = {
    root: fakeEl(), stage: fakeEl(), canvas: fakeEl(), typeBack: fakeEl(), typeFront: fakeEl(),
    wordFocus: fakeEl(), wordSanctuary: fakeEl(), tagline: fakeEl(), timerFloat: fakeEl(), timerFloatDigits: fakeEl(),
    timerExact: fakeEl(), consoleEl, btnStart: fakeEl(), btnReset: fakeEl(), btnReplay: fakeEl(), modeButtons: [],
    taskInput: fakeEl(), todayCount: fakeEl(), todayMinutes: fakeEl(), sessionLabel: fakeEl(), statusLine: fakeEl(),
    storageNote: fakeEl(), completeBanner: fakeEl(), completeLines: [fakeEl(), fakeEl()], fallback: fakeEl(), cursor: fakeEl(), micro: [],
  };
  const ui = {
    el,
    setSnapshot: vi.fn(), confirm: vi.fn(async () => true), showStorageNote: vi.fn(), showFallback: vi.fn(),
    setInteractionLock: (l: boolean) => calls.lock.push(l),
    setTimerAnchor: vi.fn(), pulseRecord: () => { calls.pulse++; }, setLayout: vi.fn(), setMicro: vi.fn(), dispose: vi.fn(),
  } as unknown as UI;
  return { ui, calls };
}
function make(reduced = false) {
  const { ui, calls } = makeUI();
  const d = new MotionDirector({ ui, layout: () => 'desktop', reducedMotion: reduced, quality: () => 'high' });
  return { d, calls };
}

beforeAll(() => {
  gsap.ticker.remove(gsap.updateRoot);
  gsap.updateRoot(0);
  // fake elements have no CSS: GSAP warns about opacity/visibility (no CSSPlugin target) - noise only
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('MotionDirector', () => {
  it('boots in the idle pose and damps pointer / press pulse', () => {
    const { d } = make();
    expect(d.pose).toBe('idle');
    expect(d.params.camDolly).toBe(CAMERA_POSES.desktop.idle.camDolly);
    d.setPointer(1, -1);
    step(d, 1.5);
    expect(d.input.pointerX).toBeGreaterThan(0.99);
    expect(d.input.pointerY).toBeLessThan(-0.99);
    expect(d.params.envRotation).toBeGreaterThan(0.09); // 6deg nudge + drift
    d.setPointer(null, null);
    step(d, 1.5);
    expect(Math.abs(d.input.pointerX)).toBeLessThan(0.01);
    d.onPress();
    expect(d.input.pressPulse).toBe(1);
    step(d, 1);
    expect(d.input.pressPulse).toBe(0);
    d.dispose();
  });

  it('drag accumulates (clamped) and springs back with an overshoot', () => {
    const { d } = make();
    for (let i = 0; i < 40; i++) { d.dragBy(10, 4); step(d, 1 / 60); }
    expect(d.input.dragYaw).toBeGreaterThan(30);
    expect(d.input.dragYaw).toBeLessThanOrEqual(40);
    expect(d.input.dragPitch).toBeLessThanOrEqual(15);
    d.endDrag();
    let minYaw = Infinity;
    for (let i = 0; i < 120; i++) { step(d, 1 / 60); minYaw = Math.min(minYaw, d.input.dragYaw); }
    expect(minYaw).toBeLessThan(0); // overshoot past zero
    expect(Math.abs(d.input.dragYaw)).toBeLessThan(0.5); // settled after 2 s
    d.dispose();
  });

  it('toPose morphs to the pose (form + camera) and swaps the word', () => {
    const { d } = make();
    d.toPose('shortBreak');
    step(d, 0.5);
    expect(d.params.shellOpen).toBeGreaterThan(0.22);
    expect(d.params.shellOpen).toBeLessThan(0.55);
    step(d, 1.2);
    expect(d.params.shellOpen).toBeCloseTo(FORM_POSES.shortBreak.shellOpen!, 3);
    expect(d.params.camYaw).toBeCloseTo(CAMERA_POSES.desktop.shortBreak.camYaw, 3);
    expect(typo.swapWord).toHaveBeenCalledWith(expect.anything(), 'BREATHE', expect.anything());
    d.toPose('longBreak', { immediate: true });
    expect(d.params.camDolly).toBe(7.0);
    expect(typo.setWordText).toHaveBeenLastCalledWith(expect.anything(), 'RELEASE');
    d.dispose();
  });

  it('focus derives twist / core scale from smoothed progress once the morph lands', () => {
    const { d } = make();
    d.onStart();
    d.setProgress(0.5);
    step(d, 1.5);
    expect(d.params.coreGlow).toBeCloseTo(1.5, 2);
    expect(d.params.orbitTilt).toBeCloseTo(1, 2);
    step(d, 2);
    expect(d.params.progress).toBeCloseTo(0.5, 2);
    expect(d.params.shellTwist).toBeCloseTo(0.65, 2);
    expect(d.params.coreScale).toBeCloseTo(0.975, 2);
    d.dispose();
  });

  it('pause overlay freezes time and resume restores the pose values', () => {
    const { d } = make();
    d.toPose('focus', { immediate: true });
    d.onPause();
    step(d, 1.6);
    expect(d.params.timeScale).toBeCloseTo(0, 3);
    expect(d.params.desaturate).toBeCloseTo(PAUSE_OVERLAY.desaturate!, 3);
    expect(d.params.camDolly).toBeLessThan(4.4);
    d.onResume();
    step(d, 1.2);
    expect(d.params.timeScale).toBeCloseTo(1, 3);
    expect(d.params.desaturate).toBeCloseTo(0, 3);
    expect(d.params.camDolly).toBeCloseTo(4.4, 3);
    d.dispose();
  });

  it('intro locks, queues a pose change, resolves at ~3 s, then applies the queue', async () => {
    const { d, calls } = make();
    let done = false;
    const pr = d.playIntro('idle').then(() => { done = true; });
    expect(d.locked).toBe(true);
    expect(d.params.camDolly).toBe(1.15);
    d.toPose('focus'); // queued
    step(d, 2.0);
    expect(done).toBe(false);
    expect(d.pose).toBe('idle');
    step(d, 1.2);
    await pr;
    expect(done).toBe(true);
    expect(d.locked).toBe(false);
    expect(calls.lock).toEqual([true, false]);
    expect(d.pose).toBe('focus'); // queued pose applied
    expect(d.params.orbitReveal).toBe(1);
    expect(d.params.pointerWeight).toBeCloseTo(1, 3);
    expect(typo.revealWord).toHaveBeenCalled();
    expect(typo.assembleDigits).toHaveBeenCalled();
    step(d, 1.5);
    expect(d.params.camYaw).toBeCloseTo(24, 2);
    d.dispose();
  });

  it('complete runs 4 s, ends in the next pose, pulses the record unless preview', async () => {
    const { d, calls } = make();
    d.toPose('focus', { immediate: true });
    d.setProgress(1);
    step(d, 3);
    let done = false;
    const pr = d.playComplete('shortBreak').then(() => { done = true; });
    step(d, 0.6);
    expect(d.params.shellOpen).toBeCloseTo(0, 2);
    expect(d.params.attract).toBeCloseTo(1, 2);
    step(d, 0.9);
    expect(d.params.shellOpen).toBeGreaterThan(1.0);
    expect(d.params.shellTwist).toBeLessThan(0);
    step(d, 2.6);
    await pr;
    expect(done).toBe(true);
    expect(d.pose).toBe('shortBreak');
    expect(d.locked).toBe(false);
    expect(calls.pulse).toBe(1);
    expect(typo.bandWipe).toHaveBeenCalledTimes(2);
    step(d, 1);
    expect(d.params.shellOpen).toBeCloseTo(0.55, 2);
    expect(d.params.camDolly).toBeCloseTo(5.6, 2);
    expect(d.params.attract).toBeCloseTo(0, 3);
    expect(d.params.shockwave).toBe(0);

    const { d: d2, calls: c2 } = make();
    const p2 = d2.playComplete('longBreak', { preview: true });
    step(d2, 4.2);
    await p2;
    expect(c2.pulse).toBe(0);
    expect(d2.pose).toBe('longBreak');
    d.dispose();
    d2.dispose();
  });

  it('reduced motion: intro/complete are short and toPose is 0.4 s', async () => {
    const { d } = make(true);
    const pr = d.playIntro('idle');
    step(d, 0.4);
    await pr;
    expect(d.locked).toBe(false);
    expect(d.params.timeScale).toBe(0.15);
    d.toPose('longBreak');
    step(d, 0.45);
    expect(d.params.shellOpen).toBeCloseTo(1, 3);
    const pc = d.playComplete('shortBreak');
    step(d, 2.2);
    await pc;
    expect(d.pose).toBe('shortBreak');
    d.dispose();
  });

  it('takes the lock synchronously and chains a second set-piece with the lock held', async () => {
    const { d, calls } = make();
    const order: string[] = [];
    const a = d.playIntro('idle').then(() => order.push('intro'));
    expect(d.locked).toBe(true);
    const b = d.replay('idle').then(() => order.push('replay'));
    d.toPose('shortBreak'); // queued behind both
    step(d, 3.2);
    await a;
    expect(order).toEqual(['intro']);
    expect(d.locked).toBe(true); // replay started right away, lock never released in between
    expect(d.pose).toBe('idle');
    step(d, 3.8);
    await b;
    expect(order).toEqual(['intro', 'replay']);
    expect(d.locked).toBe(false);
    expect(calls.lock).toEqual([true, false]);
    expect(d.pose).toBe('shortBreak');
    step(d, 1.6);
    expect(d.params.shellOpen).toBeCloseTo(FORM_POSES.shortBreak.shellOpen!, 3);
    d.dispose();
  });

  it('shows the banner via the is-open class during complete and hides it after', async () => {
    const { ui } = makeUI();
    const d = new MotionDirector({ ui, layout: () => 'desktop', reducedMotion: false, quality: () => 'high' });
    const banner = ui.el.completeBanner;
    d.toPose('focus', { immediate: true });
    const pr = d.playComplete('shortBreak');
    step(d, 1.5);
    expect(banner.classList.contains('is-open')).toBe(true);
    step(d, 2.6);
    await pr;
    expect(banner.classList.contains('is-open')).toBe(false);
    d.dispose();
  });

  it('relayout re-applies the camera for the new layout and env base stays bounded', () => {
    let layout: 'desktop' | 'mobile' = 'desktop';
    const { ui } = makeUI();
    const d = new MotionDirector({ ui, layout: () => layout, reducedMotion: false, quality: () => 'high' });
    layout = 'mobile';
    d.relayout();
    step(d, 0.7);
    expect(d.params.camDolly).toBeCloseTo(CAMERA_POSES.mobile.idle.camDolly, 3);
    expect(d.input.layout).toBe('mobile');
    for (let i = 0; i < 40; i++) { d.toPose(i % 2 ? 'longBreak' : 'idle', { duration: 0.2 }); step(d, 0.3); }
    expect(Math.abs(d.params.envRotation)).toBeLessThan(2 * Math.PI * 2);
    d.dispose();
  });

  it('dispose resolves pending set-pieces and stops writing', async () => {
    const { d } = make();
    const pr = d.playIntro('idle');
    d.dispose();
    await pr;
    const snap = { ...d.params };
    step(d, 1);
    expect(d.params).toEqual(snap);
    await flush();
  });
});
