// Layout patterns while dragging (#78, Snap Layouts as in Windows 11): a dragged tab or pane is dropped on a field of
// a pattern, and the active tab is arranged after it. Pure; `applyMove` (target `snap`) calls `applySnap`, so drop,
// menus and store agree. Only the tree changes: every pane keeps its id and session, so its view, its role and the
// input lock stay (no detach, no attach). A field without a view is not created, because a pane always shows a
// session (`LayoutPane`); the other fields of the pattern share its room.
import type { LayoutPane, LayoutSplit, LayoutTab, LayoutWindow, PaneNode } from "@termdock/protocol";
import type { Box } from "./drag/drop-zones.js";
import type { MoveSource } from "./layout-moves.js";
import { layoutPanes } from "./pane-layout.js";
import type { ShareRect } from "./pane-layout.js";
import { findPane, firstPane, MAX_PANES, mergeSameDirection, panesOf, removePane } from "./pane-tree.js";

export type SnapPatternId = "columns" | "rows" | "mainLeft" | "mainRight" | "grid";

export interface SnapPattern {
  id: SnapPatternId;
  label: string;
  /** Number of fields. */
  slots: number;
}

/** A field (its number in reading order) or a split of fields with equal shares. */
type Shape = number | { direction: LayoutSplit["direction"]; children: readonly Shape[] };

const SHAPES: Readonly<Record<SnapPatternId, Shape>> = {
  columns: { direction: "row", children: [0, 1] },
  rows: { direction: "column", children: [0, 1] },
  // Big on the left, two on top of each other on the right.
  mainLeft: { direction: "row", children: [0, { direction: "column", children: [1, 2] }] },
  mainRight: { direction: "row", children: [{ direction: "column", children: [0, 1] }, 2] },
  grid: {
    direction: "column",
    children: [
      { direction: "row", children: [0, 1] },
      { direction: "row", children: [2, 3] },
    ],
  },
};

/** The patterns of the bar and the menus, in this order; none has more than `MAX_PANES` fields. */
export const SNAP_PATTERNS: readonly SnapPattern[] = [
  { id: "columns", label: "2 nebeneinander", slots: 2 },
  { id: "rows", label: "2 übereinander", slots: 2 },
  { id: "mainLeft", label: "1 + 2", slots: 3 },
  { id: "mainRight", label: "2 + 1", slots: 3 },
  { id: "grid", label: "2 × 2", slots: 4 },
];

export function snapPattern(id: string): SnapPattern | undefined {
  return SNAP_PATTERNS.find((each) => each.id === id);
}

/** Where each field of the pattern sits, as shares of the pattern's box, in reading order. */
export function patternRects(id: SnapPatternId): ShareRect[] {
  const pattern = snapPattern(id)!;
  const panes = Array.from({ length: pattern.slots }, (_, slot): LayoutPane => ({
    kind: "pane",
    id: String(slot),
    sessionId: String(slot),
  }));
  let next = 0;
  const root = build(SHAPES[id], panes, () => `split${++next}`)!;
  const placed = layoutPanes(root).panes;
  return panes.map((pane) => placed.find((each) => each.paneId === pane.id)!.rect);
}

/** The views a snap arranges: the dragged one, the others in order, and the tabs without what the dragged took. */
interface SnapViews {
  into: LayoutTab;
  moved: LayoutPane;
  others: LayoutPane[];
  tabs: LayoutTab[];
}

/**
 * The active tab is arranged. A pane brings itself (out of its tab, which closes when it is left empty); a tab brings
 * all its panes (it closes), its active pane is the dragged one. The active tab itself, or one of its panes, is only
 * rearranged. A session of the sidebar is not offered.
 */
function snapViews(window: LayoutWindow, source: MoveSource): SnapViews | undefined {
  const { tabs } = window;
  const into = tabs.find((tab) => tab.id === window.activeTabId);
  if (!into || source.kind === "session") return undefined;
  const intoPanes = panesOf(into.root);
  if (source.kind === "tab") {
    const from = tabs.find((tab) => tab.id === source.tabId);
    if (!from) return undefined;
    const moved = findPane(from.root, from.activePaneId) ?? firstPane(from.root);
    if (from.id === into.id)
      return { into, moved, others: intoPanes.filter((pane) => pane.id !== moved.id), tabs: [...tabs] };
    const rest = panesOf(from.root).filter((pane) => pane.id !== moved.id);
    return {
      into,
      moved,
      others: [...intoPanes, ...rest],
      tabs: tabs.filter((tab) => tab.id !== from.id),
    };
  }
  const from = tabs.find((tab) => findPane(tab.root, source.paneId) !== undefined);
  if (!from) return undefined;
  const moved = findPane(from.root, source.paneId)!;
  if (from.id === into.id)
    return { into, moved, others: intoPanes.filter((pane) => pane.id !== moved.id), tabs: [...tabs] };
  const rest = removePane(from, moved.id);
  return {
    into,
    moved,
    others: intoPanes,
    tabs: rest
      ? tabs.map((tab) => (tab.id === from.id ? rest : tab))
      : tabs.filter((tab) => tab.id !== from.id),
  };
}

/** How many views a snap of the source would arrange in the active tab; 0 when it cannot be arranged. */
export function snapViewCount(window: LayoutWindow, source: MoveSource): number {
  const views = snapViews(window, source);
  return views ? views.others.length + 1 : 0;
}

/** What lands in a field: a view (`moved` for the dragged one) or nothing. */
export interface SnapField {
  slot: number;
  pane: LayoutPane | undefined;
  moved: boolean;
}

/**
 * The fields of the pattern when the dragged view lands in `slot`: it there, the others in order in the remaining
 * fields, the rest empty. Undefined when the views do not fit the pattern (or more than `MAX_PANES`) or the source
 * cannot be arranged.
 */
export function snapFields(
  window: LayoutWindow,
  source: MoveSource,
  pattern: SnapPatternId,
  slot: number,
): SnapField[] | undefined {
  return fieldsOf(snapViews(window, source), pattern, slot);
}

function fieldsOf(
  views: SnapViews | undefined,
  pattern: SnapPatternId,
  slot: number,
): SnapField[] | undefined {
  const { slots } = snapPattern(pattern) ?? { slots: 0 };
  if (!views || !Number.isInteger(slot) || slot < 0 || slot >= slots) return undefined;
  const count = views.others.length + 1;
  if (count > slots || count > MAX_PANES) return undefined;
  const rest = [...views.others];
  return Array.from({ length: slots }, (_, index) =>
    index === slot
      ? { slot: index, pane: views.moved, moved: true }
      : { slot: index, pane: rest.shift(), moved: false },
  );
}

/**
 * The window with the active tab arranged after the pattern, the dragged view in `slot`; it becomes the active pane
 * and the active tab stays active. Undefined when the move is not possible or changes nothing.
 */
export function applySnap(
  window: LayoutWindow,
  source: MoveSource,
  pattern: SnapPatternId,
  slot: number,
  newId: () => string,
): LayoutWindow | undefined {
  const views = snapViews(window, source);
  const fields = fieldsOf(views, pattern, slot);
  if (!fields || !views) return undefined;
  const root = mergeSameDirection(
    build(
      SHAPES[pattern],
      fields.map((field) => field.pane),
      newId,
    )!,
  );
  const { into, moved } = views;
  const merged =
    views.tabs.length !== window.tabs.length || panesOf(root).length !== panesOf(into.root).length;
  if (!merged && into.activePaneId === moved.id && sameTree(root, into.root)) return undefined;
  const tab: LayoutTab = { ...into, root, activePaneId: moved.id };
  return {
    ...window,
    tabs: views.tabs.map((each) => (each.id === into.id ? tab : each)),
    activeTabId: into.id,
  };
}

/** The patterns that have room for all views of the move, with at least one field that changes something. */
export function visiblePatterns(window: LayoutWindow, source: MoveSource): SnapPatternId[] {
  const probe = (): string => "probe";
  return SNAP_PATTERNS.filter(({ id, slots }) =>
    Array.from({ length: slots }, (_, slot) => slot).some(
      (slot) => applySnap(window, source, id, slot, probe) !== undefined,
    ),
  ).map((each) => each.id);
}

/** The tree of the shape with the panes in its fields; an empty field is left out, a split of one gives way. */
function build(
  shape: Shape,
  panes: ReadonlyArray<LayoutPane | undefined>,
  newId: () => string,
): PaneNode | undefined {
  if (typeof shape === "number") return panes[shape];
  const children = shape.children.flatMap((child) => build(child, panes, newId) ?? []);
  if (children.length <= 1) return children[0];
  return {
    kind: "split",
    id: newId(),
    direction: shape.direction,
    children,
    sizes: children.map(() => 1 / children.length),
  };
}

/** Same panes in the same places with the same shares; the ids of splits do not count. */
function sameTree(a: PaneNode, b: PaneNode): boolean {
  if (a.kind === "pane" || b.kind === "pane") return a.kind === b.kind && a.id === b.id;
  return (
    a.direction === b.direction &&
    a.children.length === b.children.length &&
    a.children.every((child, index) => sameTree(child, b.children[index]!)) &&
    a.sizes.every((size, index) => Math.abs(size - b.sizes[index]!) < 1e-6)
  );
}

// --- The bar ---------------------------------------------------------------------------------------------------

/** Pixels below the top edge of the tab area where the pointer opens the bar. */
export const SNAP_REVEAL_PX = 32;
/** How long the pointer has to rest in that strip before the bar opens. */
export const SNAP_DWELL_MS = 250;
/** Margin left and right of the open bar that keeps it open. */
export const SNAP_KEEP_PX = 16;

/**
 * What the bar does for the pointer. `dwell`: the pointer is in the strip at the top edge of the tab area (not above
 * it, over the tab bar); the bar opens when it stays there for `SNAP_DWELL_MS`, so a tab dragged from the tab bar
 * down to a pane only crosses the strip. `open`: the bar is open and the pointer is in the strip or over the bar
 * (with a margin at its sides, none below, so the zones of the panes under it come back right away). `close`:
 * anywhere else.
 */
export function snapBarStep(
  point: { x: number; y: number },
  area: Box,
  bar: Box | undefined,
  open: boolean,
): "open" | "dwell" | "close" {
  const { x, y } = point;
  if (x < area.left || x > area.left + area.width) return "close";
  if (y >= area.top && y < area.top + SNAP_REVEAL_PX) return open ? "open" : "dwell";
  if (!open || !bar) return "close";
  const over =
    x >= bar.left - SNAP_KEEP_PX &&
    x <= bar.left + bar.width + SNAP_KEEP_PX &&
    y >= area.top &&
    y <= bar.top + bar.height;
  return over ? "open" : "close";
}
