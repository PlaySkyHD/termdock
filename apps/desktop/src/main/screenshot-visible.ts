// Visibility check for the `capture` helpers of the screenshot mode (#116): a scene that shows an error, a menu or a
// dialog names the selector of that element, and the run fails when the element is missing or lies (partly) outside
// the area that its clipping ancestors and the window leave visible. The rectangle math is pure functions.

import { setTimeout as sleep } from "node:timers/promises";

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** An ancestor with `overflow` other than `visible`: its border box and the size of its content area. */
export interface ClipBox {
  rect: Rect;
  clientLeft: number;
  clientTop: number;
  clientWidth: number;
  clientHeight: number;
}

/** What the page reports for a selector: the element, the clipping ancestors (inner first) and the window. */
export interface VisibilityProbe {
  element: Rect | null;
  clips: ClipBox[];
  viewport: Rect;
}

export interface CaptureOptions {
  /** Selector of the core element of the scene; it must be fully visible, else the run fails. */
  visible?: string;
}

/** Sub-pixel rounding of layout must not fail a scene. */
const TOLERANCE = 0.5;

/** The content area of a clipping ancestor: without border and without scrollbar. */
export function contentBox(clip: ClipBox): Rect {
  const left = clip.rect.left + clip.clientLeft;
  const top = clip.rect.top + clip.clientTop;
  return { top, left, bottom: top + clip.clientHeight, right: left + clip.clientWidth };
}

/** The intersection of rectangles; an empty one (nothing is visible) has no area. */
export function intersectRects(rects: readonly Rect[]): Rect {
  return rects.reduce((a, b) => ({
    top: Math.max(a.top, b.top),
    left: Math.max(a.left, b.left),
    bottom: Math.min(a.bottom, b.bottom),
    right: Math.min(a.right, b.right),
  }));
}

/** The part of the window that the clipping ancestors leave visible. */
export function visibleArea(clips: readonly ClipBox[], viewport: Rect): Rect {
  return intersectRects([viewport, ...clips.map(contentBox)]);
}

/** True when `element` lies completely inside the visible area of its clipping ancestors and the window. */
export function isRectVisible(element: Rect, clips: readonly ClipBox[], viewport: Rect): boolean {
  // An element without area (display: none, collapsed) shows nothing, wherever its rectangle lies.
  if (element.bottom <= element.top || element.right <= element.left) return false;
  const area = visibleArea(clips, viewport);
  return (
    element.top >= area.top - TOLERANCE &&
    element.bottom <= area.bottom + TOLERANCE &&
    element.left >= area.left - TOLERANCE &&
    element.right <= area.right + TOLERANCE
  );
}

/**
 * Page script: finds the element and walks all ancestors up to the root. Every one with `overflow` (x or y) other
 * than `visible` clips. An element with `position: fixed` is not clipped by its ancestors, only by the window.
 */
export function visibilityProbeExpression(selector: string): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    const viewport = { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
    if (!element) return { element: null, clips: [], viewport };
    const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
    const clips = [];
    if (getComputedStyle(element).position !== 'fixed') {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        clips.push({
          rect: rect(ancestor),
          clientLeft: ancestor.clientLeft,
          clientTop: ancestor.clientTop,
          clientWidth: ancestor.clientWidth,
          clientHeight: ancestor.clientHeight,
        });
      }
    }
    return { element: rect(element), clips, viewport };
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
        : isRectVisible(probe.element, probe.clips, probe.viewport)
          ? undefined
          : `is not fully visible (element ${JSON.stringify(probe.element)}, ` +
            `visible area ${JSON.stringify(visibleArea(probe.clips, probe.viewport))})`;
    if (problem === undefined) return;
    if (Date.now() >= deadline) throw new Error(`Scene ${scene}: ${selector} ${problem}`);
    await sleep(100);
  }
}
