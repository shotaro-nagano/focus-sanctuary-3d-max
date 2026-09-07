// Confirmation plate (destructive actions). Styled as a small chrome plate over a
// blurred backdrop. Focus is trapped on the two buttons; ESC / KEEP / backdrop
// click resolve false. Only one confirm is open at a time: a new request
// resolves the previous one with false.

export interface ConfirmController {
  confirm(text: string): Promise<boolean>;
  readonly open: boolean;
  dispose(): void;
}

export function createConfirm(root: HTMLElement): ConfirmController {
  const textEl = root.querySelector<HTMLElement>('#confirm-text');
  const yes = root.querySelector<HTMLButtonElement>('#confirm-yes');
  const no = root.querySelector<HTMLButtonElement>('#confirm-no');
  const panel = root.querySelector<HTMLElement>('.confirm-panel');
  if (!textEl || !yes || !no || !panel) throw new Error('[ui/confirm] #confirm markup incomplete');

  let resolver: ((v: boolean) => void) | null = null;
  let previousFocus: HTMLElement | null = null;
  let closeTimer = 0;

  const finish = (value: boolean): void => {
    const r = resolver;
    resolver = null;
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      if (!resolver) root.hidden = true;
    }, 260);
    const pf = previousFocus;
    previousFocus = null;
    if (pf && document.contains(pf)) pf.focus({ preventScroll: true });
    r?.(value);
  };

  const onYes = (): void => finish(true);
  const onNo = (): void => finish(false);
  const onBackdrop = (ev: MouseEvent): void => {
    if (ev.target === root) finish(false);
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (!resolver) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      finish(false);
      return;
    }
    if (ev.key === 'Tab') {
      // trap between the two buttons
      ev.preventDefault();
      const active = document.activeElement;
      const next = ev.shiftKey ? (active === yes ? no : yes) : active === no ? yes : no;
      next.focus();
      return;
    }
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      (document.activeElement === no ? yes : no).focus();
    }
  };

  yes.addEventListener('click', onYes);
  no.addEventListener('click', onNo);
  root.addEventListener('mousedown', onBackdrop);
  document.addEventListener('keydown', onKey, true);

  return {
    get open() {
      return resolver !== null;
    },
    confirm(text: string): Promise<boolean> {
      if (resolver) finish(false);
      window.clearTimeout(closeTimer);
      textEl.textContent = text;
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      root.hidden = false;
      root.setAttribute('aria-hidden', 'false');
      // two frames so the transition from the hidden state runs
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('is-open')));
      return new Promise<boolean>((resolve) => {
        resolver = resolve;
        // KEEP is the safe default focus
        no.focus({ preventScroll: true });
      });
    },
    dispose() {
      if (resolver) finish(false);
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      root.removeEventListener('mousedown', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      window.clearTimeout(closeTimer);
    },
  };
}
