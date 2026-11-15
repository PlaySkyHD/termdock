// Visibility check for the `capture` helpers of the screenshot mode (#116): a scene that shows an error, a menu or a
// dialog names the selector of that element, and the run fails when the element is missing or lies (partly) outside
// the visible part of its scrolling ancestor or the window. The rectangle comparison is a pure function.

import { setTimeout as sleep } from "node:timers/promises";

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** What the page reports for a selector: the element, its nearest scrollable ancestor (if any) and the window. */
export interface VisibilityProbe {
  element: Rect | null;
  container: Rect | null;
  viewport: Rect;
}

export interface CaptureOptions {
  /** Selector of the core element of the scene; it must be fully visible, else the run fails. */
  visible?: string;
}

/** Sub-pixel rounding of layout must not fail a scene. */
const TOLERANCE = 0.5;

function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.top >= outer.top - TOLERANCE &&
    inner.bottom <= outer.bottom + TOLERANCE &&
    inner.left >= outer.left - TOLERANCE &&
    inner.right <= outer.right + TOLERANCE
  );
}

/** True when `element` lies completely inside `viewport` and, if there is one, inside the scrolling `container`. */
export function isRectVisible(element: Rect, container: Rect | null, viewport: Rect): boolean {
  // An element without area (display: none, collapsed) shows nothing, wherever its rectangle lies.
  if (element.bottom <= element.top || element.right <= element.left) return false;
  return inside(element, viewport) && (container === null || inside(element, container));
}

/** Page script: finds the element and its nearest ancestor that scrolls (overflow auto or scroll). */
export function visibilityProbeExpression(selector: string): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { element: null, container: null, viewport: { top: 0, left: 0, bottom: innerHeight, right: innerWidth } };
    const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
    // A fixed element (menu, dialog) is not clipped by the scrolling ancestors in the DOM, only by the window.
    let ancestor = getComputedStyle(element).position === 'fixed' ? null : element.parentElement;
    while (ancestor && !/(auto|scroll)/.test(getComputedStyle(ancestor).overflowY + getComputedStyle(ancestor).overflowX)) {
      ancestor = ancestor.parentElement;
    }
    return {
      element: rect(element),
      container: ancestor ? rect(ancestor) : null,
      viewport: { top: 0, left: 0, bottom: innerHeight, right: innerWidth },
    };
  })()`;
}

/** Throws (the run ends with code 1) when the core element of the scene is missing or not fully visible. */
export async function assertVisible(
  evaluate: <T>(expression: string) => Promise<T>,
  scene: string,
  selector: string,
  timeoutMs = 5_000,
): Promise<void> {
  // Layout and scrolling may settle after the scene's last step: poll until the deadline, then fail.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = await evaluate<VisibilityProbe>(visibilityProbeExpression(selector));
    const problem =
      probe.element === null
        ? "does not exist"
        : isRectVisible(probe.element, probe.container, probe.viewport)
          ? undefined
          : `is not fully visible (element ${JSON.stringify(probe.element)}, ` +
            `container ${JSON.stringify(probe.container)}, window ${JSON.stringify(probe.viewport)})`;
    if (problem === undefined) return;
    if (Date.now() >= deadline) throw new Error(`Scene ${scene}: ${selector} ${problem}`);
    await sleep(100);
  }
}
