// Focus trap of a modal dialog (#60): Tab and Shift+Tab cycle through the dialog, and a focus that lands outside
// (a terminal behind the backdrop) is taken back. The index logic is pure; the DOM part is small.

/**
 * Index of the element that gets the focus after Tab (or Shift+Tab with `backwards`) in a trap of `count`
 * elements. `current` is the index of the focused element, -1 when the focus is outside the trap. -1 for an empty trap.
 */
export function nextFocusIndex(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Keeps the focus inside `root` until the returned function is called. `fallback` gets the focus when it escapes
 * and nothing inside had it before.
 */
export function trapFocus(root: HTMLElement, fallback: () => HTMLElement | null): () => void {
  const focusables = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const list = focusables();
    const index = nextFocusIndex(
      list.length,
      list.indexOf(document.activeElement as HTMLElement),
      event.shiftKey,
    );
    list[index]?.focus();
  };
  const onFocusIn = (event: FocusEvent): void => {
    if (event.target instanceof Node && root.contains(event.target)) return;
    (fallback() ?? focusables()[0])?.focus();
  };
  window.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("focusin", onFocusIn);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("focusin", onFocusIn);
  };
}
