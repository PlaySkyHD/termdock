// Geometry of a tab's pane tree (#27): where each pane and each divider sits, as shares of the tab's area. The
// window draws all panes of a tab as one flat list of positioned elements, so a pane keeps its element (and its
// view in the core) however the tree around it changes.
import type { PaneNode, SessionId } from "@termdock/protocol";

/** A rectangle in shares of the tab's area (0 to 1). */
export interface ShareRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedPane {
  paneId: string;
  sessionId: SessionId;
  rect: ShareRect;
}

/** The border between child `index` and `index + 1` of a split. */
export interface PlacedDivider {
  splitId: string;
  index: number;
  direction: "row" | "column";
  /** Left edge (row) or top edge (column) of child `index + 1`, as a share of the tab. */
  position: number;
  /** Area of the whole split; a drag converts pixels into a share of it. */
  split: ShareRect;
}

export interface PaneLayout {
  /** Left to right and top to bottom, in tree order. */
  panes: PlacedPane[];
  dividers: PlacedDivider[];
}

/** Farther than this between press and release, the pointer dragged (to select text), it did not click. */
const CLICK_SLOP_PX = 4;

/**
 * Whether a release in a pane ends a real click: pressed in the pane, hardly moved, a single click and no
 * selection in the terminal. Only such a click takes the writer; selecting text in a reader does not.
 */
export function isClick(
  down: { x: number; y: number } | undefined,
  up: { x: number; y: number; detail: number; selecting: boolean },
): boolean {
  if (!down || up.detail > 1 || up.selecting) return false;
  return Math.abs(up.x - down.x) <= CLICK_SLOP_PX && Math.abs(up.y - down.y) <= CLICK_SLOP_PX;
}

export function layoutPanes(root: PaneNode): PaneLayout {
  const layout: PaneLayout = { panes: [], dividers: [] };
  place(root, { x: 0, y: 0, width: 1, height: 1 }, layout);
  return layout;
}

function place(node: PaneNode, rect: ShareRect, layout: PaneLayout): void {
  if (node.kind === "pane") {
    layout.panes.push({ paneId: node.id, sessionId: node.sessionId, rect });
    return;
  }
  const row = node.direction === "row";
  let offset = row ? rect.x : rect.y;
  node.children.forEach((child, index) => {
    const length = node.sizes[index]! * (row ? rect.width : rect.height);
    if (index > 0) {
      layout.dividers.push({
        splitId: node.id,
        index: index - 1,
        direction: node.direction,
        position: offset,
        split: rect,
      });
    }
    place(
      child,
      row ? { ...rect, x: offset, width: length } : { ...rect, y: offset, height: length },
      layout,
    );
    offset += length;
  });
}
