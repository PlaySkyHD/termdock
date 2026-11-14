// Pane focus by direction (#28, Alt+arrow keys): which pane lies next to the active one, from the geometry of
// the pane tree (`layoutPanes`), not from the tree's structure, so it is what the user sees.
import type { PaneNode } from "@termdock/protocol";
import { layoutPanes } from "./pane-layout.js";
import type { ShareRect } from "./pane-layout.js";

export type FocusDirection = "left" | "right" | "up" | "down";

/** Shares are sums of products of fractions; absorb rounding error when comparing edges. */
const EPSILON = 1e-9;

/**
 * The pane next to `paneId` in `direction`: among the panes that lie entirely on that side and share a stretch of
 * the border, the nearest one, then the one with the longest shared stretch, then the first in tree order.
 * Undefined at the edge, in a single pane and for an unknown pane.
 */
export function neighborPane(root: PaneNode, paneId: string, direction: FocusDirection): string | undefined {
  const { panes } = layoutPanes(root);
  const from = panes.find((pane) => pane.paneId === paneId)?.rect;
  if (!from) return undefined;
  const horizontal = direction === "left" || direction === "right";
  let best: { paneId: string; gap: number; overlap: number } | undefined;
  for (const pane of panes) {
    if (pane.paneId === paneId) continue;
    const gap = distance(from, pane.rect, direction);
    const overlap = horizontal
      ? span(from.y, from.height, pane.rect.y, pane.rect.height)
      : span(from.x, from.width, pane.rect.x, pane.rect.width);
    if (gap < -EPSILON || overlap <= EPSILON) continue;
    if (
      !best ||
      gap < best.gap - EPSILON ||
      (Math.abs(gap - best.gap) <= EPSILON && overlap > best.overlap + EPSILON)
    )
      best = { paneId: pane.paneId, gap, overlap };
  }
  return best?.paneId;
}

/** Space between the edge of `from` that faces `direction` and the near edge of `to`; negative when `to` is behind. */
function distance(from: ShareRect, to: ShareRect, direction: FocusDirection): number {
  switch (direction) {
    case "left":
      return from.x - (to.x + to.width);
    case "right":
      return to.x - (from.x + from.width);
    case "up":
      return from.y - (to.y + to.height);
    case "down":
      return to.y - (from.y + from.height);
  }
}

/** Length of the stretch two intervals share (0 when they only touch). */
function span(startA: number, lengthA: number, startB: number, lengthB: number): number {
  return Math.min(startA + lengthA, startB + lengthB) - Math.max(startA, startB);
}
