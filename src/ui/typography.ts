// Kinetic typography helpers (M12). Used by the Director for word reveals,
// swaps, digit assembly and the M10 band wipe. Every function returns a GSAP
// timeline so the caller can nest / position it.
//
// Split structure (idempotent):
//   <el> <span class="ch"><span class="ch-in">F</span></span> ... </el>
// `.ch` is the overflow-hidden mask, `.ch-in` the moving glyph. Spaces become
// a `.ch.ch-space` holding a non-breaking space so the word keeps its metrics.
import { gsap } from 'gsap';

const NBSP = ' ';

function isSplit(el: HTMLElement): boolean {
  return el.dataset.split === '1' && el.querySelector(':scope > .ch') !== null;
}

function makeChar(ch: string): HTMLElement {
  const outer = document.createElement('span');
  outer.className = ch === ' ' || ch === NBSP ? 'ch ch-space' : 'ch';
  const inner = document.createElement('span');
  inner.className = 'ch-in';
  inner.textContent = ch === ' ' ? NBSP : ch;
  outer.appendChild(inner);
  return outer;
}

function chars(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(':scope > .ch'));
}

function inners(el: HTMLElement): HTMLElement[] {
  return chars(el).map((c) => c.firstElementChild as HTMLElement);
}

function currentText(el: HTMLElement): string {
  if (isSplit(el)) {
    return inners(el)
      .map((s) => (s.textContent === NBSP ? ' ' : s.textContent ?? ''))
      .join('');
  }
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Wraps each character in a mask span. Idempotent. Returns the `.ch-in` spans. */
export function splitWord(el: HTMLElement): HTMLElement[] {
  if (isSplit(el)) return inners(el);
  const text = currentText(el);
  if (!el.dataset.text) el.dataset.text = text;
  el.textContent = '';
  const frag = document.createDocumentFragment();
  for (const ch of Array.from(text)) frag.appendChild(makeChar(ch));
  el.appendChild(frag);
  el.dataset.split = '1';
  el.setAttribute('aria-label', text);
  return inners(el);
}

/** Instant text replacement that keeps the split structure (spans reused / padded / trimmed). */
export function setWordText(el: HTMLElement, text: string): void {
  if (!isSplit(el)) {
    if (el.textContent !== text) el.textContent = text;
    return;
  }
  const glyphs = Array.from(text);
  const existing = chars(el);
  const n = Math.max(glyphs.length, existing.length);
  for (let i = 0; i < n; i++) {
    const g = glyphs[i];
    const node = existing[i];
    if (g === undefined) {
      node?.remove();
      continue;
    }
    if (!node) {
      el.appendChild(makeChar(g));
      continue;
    }
    const inner = node.firstElementChild as HTMLElement;
    const want = g === ' ' ? NBSP : g;
    if (inner.textContent !== want) inner.textContent = want;
    node.classList.toggle('ch-space', g === ' ');
  }
  el.dataset.text = text;
  el.setAttribute('aria-label', text);
}

export function revealWord(
  el: HTMLElement,
  opts: { stagger?: number; skew?: number; from?: 'bottom' | 'top'; duration?: number } = {},
): gsap.core.Timeline {
  const { stagger = 0.045, skew = 6, from = 'bottom', duration = 0.9 } = opts;
  const spans = splitWord(el);
  const tl = gsap.timeline();
  el.classList.remove('is-word-hidden');
  tl.fromTo(
    spans,
    { yPercent: from === 'bottom' ? 120 : -120, skewY: from === 'bottom' ? skew : -skew, opacity: 1 },
    { yPercent: 0, skewY: 0, duration, ease: 'expo.out', stagger, overwrite: 'auto' },
    0,
  );
  return tl;
}

export function hideWord(
  el: HTMLElement,
  opts: { stagger?: number; to?: 'bottom' | 'top'; duration?: number } = {},
): gsap.core.Timeline {
  const { stagger = 0.03, to = 'top', duration = 0.55 } = opts;
  const spans = splitWord(el);
  const tl = gsap.timeline();
  tl.to(
    spans,
    { yPercent: to === 'bottom' ? 120 : -120, skewY: to === 'bottom' ? 4 : -4, duration, ease: 'power3.in', stagger, overwrite: 'auto' },
    0,
  );
  tl.add(() => el.classList.add('is-word-hidden'));
  return tl;
}

/** Per-letter mask out / in. Pads or removes spans so both words fit the same structure. */
export function swapWord(
  el: HTMLElement,
  next: string,
  opts: { stagger?: number; duration?: number } = {},
): gsap.core.Timeline {
  const { stagger = 0.03, duration = 0.5 } = opts;
  splitWord(el);
  const current = currentText(el);
  const nextGlyphs = Array.from(next);
  // pad with empty masks so incoming letters already have a span (invisible while empty)
  while (chars(el).length < nextGlyphs.length) el.appendChild(makeChar(NBSP));
  const outSpans = inners(el);
  const inSpans = outSpans.slice(0, nextGlyphs.length);

  const tl = gsap.timeline();
  if (current !== next) {
    tl.to(outSpans, { yPercent: -120, skewY: -4, duration, ease: 'power3.in', stagger, overwrite: 'auto' }, 0);
  }
  const swapAt = current !== next ? duration + stagger * Math.max(outSpans.length - 1, 0) : 0;
  tl.call(() => setWordText(el, next), [], swapAt);
  tl.set(inSpans, { yPercent: 120, skewY: 6 }, swapAt);
  tl.to(inSpans, { yPercent: 0, skewY: 0, duration: duration * 1.4, ease: 'expo.out', stagger, overwrite: 'auto' }, swapAt + 0.02);
  tl.add(() => el.classList.remove('is-word-hidden'), swapAt);
  return tl;
}

/** Digits rise from 120% with blur into place (30 ms stagger). */
export function assembleDigits(el: HTMLElement, opts: { stagger?: number } = {}): gsap.core.Timeline {
  const { stagger = 0.03 } = opts;
  const spans = splitWord(el);
  const tl = gsap.timeline();
  el.classList.remove('is-word-hidden');
  tl.fromTo(
    spans,
    { yPercent: 120, opacity: 0, filter: 'blur(14px)' },
    { yPercent: 0, opacity: 1, filter: 'blur(0px)', duration: 0.8, ease: 'expo.out', stagger, overwrite: 'auto', clearProps: 'filter' },
    0,
  );
  return tl;
}

/**
 * M10: the word splits into horizontal bands that slide out (or in) in alternating
 * directions. Band clones are removed when the timeline completes.
 */
export function bandWipe(
  el: HTMLElement,
  opts: { bands?: number; direction?: 'out' | 'in' } = {},
): gsap.core.Timeline {
  const { bands = 3, direction = 'out' } = opts;
  const spans = splitWord(el);
  // remove leftovers from an interrupted previous wipe
  el.querySelectorAll(':scope > .band').forEach((b) => b.remove());

  const bandEls: HTMLElement[] = [];
  for (let i = 0; i < bands; i++) {
    const band = document.createElement('span');
    band.className = 'band';
    const top = (i / bands) * 100;
    const bottom = 100 - ((i + 1) / bands) * 100;
    band.style.clipPath = `inset(${top.toFixed(3)}% -5% ${bottom.toFixed(3)}% -5%)`;
    const inner = document.createElement('span');
    inner.className = 'band-in';
    for (const s of spans) {
      const c = document.createElement('span');
      c.className = 'ch';
      const ci = document.createElement('span');
      ci.className = 'ch-in';
      ci.textContent = s.textContent;
      c.appendChild(ci);
      inner.appendChild(c);
    }
    band.appendChild(inner);
    el.appendChild(band);
    bandEls.push(band);
  }

  el.classList.add('is-banding');
  // the real letters are hidden while the bands play, so the clean-up has to run
  // whether the timeline completes or is killed mid-way (Director.killLive / dispose):
  // either way the word lands in the direction's end state
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    bandEls.forEach((b) => b.remove());
    if (direction === 'out') {
      gsap.set(spans, { yPercent: 120, skewY: 0 });
      el.classList.add('is-word-hidden');
    } else {
      gsap.set(spans, { yPercent: 0, skewY: 0, opacity: 1 });
      el.classList.remove('is-word-hidden');
    }
    el.classList.remove('is-banding');
  };
  const tl = gsap.timeline({ onComplete: settle, onInterrupt: settle });

  if (direction === 'out') {
    gsap.set(spans, { yPercent: 0, skewY: 0, opacity: 1 });
    bandEls.forEach((b, i) => {
      tl.to(b, { xPercent: i % 2 === 0 ? -112 : 112, duration: 0.9, ease: 'expo.inOut' }, i * 0.07);
    });
  } else {
    el.classList.remove('is-word-hidden');
    bandEls.forEach((b, i) => {
      tl.fromTo(b, { xPercent: i % 2 === 0 ? -112 : 112 }, { xPercent: 0, duration: 1.0, ease: 'expo.out' }, i * 0.07);
    });
  }
  return tl;
}
