// Operations on the pane tree of a tab (#27, #67): find, replace, insert next to a pane, take a pane out. Pure;
// `UiStore` (splitting, closing) and `layout-moves.ts` (drag and drop) build on the same functions, so a tree
// changed either way has the same shape.
import type { LayoutPane, LayoutSplit, LayoutTab, PaneNode } from "@termdock/protocol";

/** `MAX_TABS_PER_WINDOW` of the protocol; a test keeps them equal (the renderer imports only types). */
export const MAX_TABS = 64;

/** `MAX_PANES_PER_TAB` of the protocol; a test keeps them equal. */
export const MAX_PANES = 4;

/** Where a node goes relative to a pane: one of its four edges (a split) or its place (`center`). */
export type PaneZone = "left" | "right" | "top" | "bottom" | "center";

export const PANE_ZONES: readonly PaneZone[] = ["left", "right", "top", "bottom", "center"];

export function firstPane(node: PaneNode): LayoutPane {
  return node.kind === "pane" ? node : firstPane(node.children[0]!);
}

/** Number of panes of the tab (1 to `MAX_PANES`). */
export function paneCount(tab: LayoutTab): number {
  return panesOf(tab.root).length;
}

/** The panes of the tree, left to right and top to bottom. */
export function panesOf(node: PaneNode): LayoutPane[] {
  return node.kind === "pane" ? [node] : node.children.flatMap(panesOf);
}

/** The split that has the node `id` as a direct child; undefined for the root. */
export function parentOf(node: PaneNode, id: string): LayoutSplit | undefined {
  if (node.kind === "pane") return undefined;
  if (node.children.some((child) => child.id === id)) return node;
  for (const child of node.children) {
    const found = parentOf(child, id);
    if (found) return found;
  }
  return undefined;
}

export function findNode(node: PaneNode, id: string): PaneNode | undefined {
  if (node.id === id) return node;
  if (node.kind === "pane") return undefined;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

export function findPane(node: PaneNode, paneId: string): LayoutPane | undefined {
  const found = findNode(node, paneId);
  return found?.kind === "pane" ? found : undefined;
}

/** The tree with the node `id` replaced by `replace(node)`; untouched branches keep their identity. */
export function replaceNode(node: PaneNode, id: string, replace: (node: PaneNode) => PaneNode): PaneNode {
  if (node.id === id) return replace(node);
  if (node.kind === "pane") return node;
  const children = node.children.map((child) => replaceNode(child, id, replace));
  return children.every((child, index) => child === node.children[index]) ? node : { ...node, children };
}

/**
 * The tree without a split directly inside a split of the same direction: the inner children take its place,
 * each with its share of the inner split times the inner split's share. Unchanged branches keep their identity.
 */
export function mergeSameDirection(node: PaneNode): PaneNode {
  if (node.kind === "pane") return node;
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  let changed = false;
  node.children.forEach((original, index) => {
    const child = mergeSameDirection(original);
    const share = node.sizes[index]!;
    if (child !== original) changed = true;
    if (child.kind === "split" && child.direction === node.direction) {
      changed = true;
      children.push(...child.children);
      sizes.push(...child.sizes.map((size) => size * share));
    } else {
      children.push(child);
      sizes.push(share);
    }
  });
  return changed ? { ...node, children, sizes } : node;
}

/**
 * The tab without the pane. Its siblings share its space; a split left with one child gives way to that child.
 * When the pane was active, the pane that moves into its place becomes active. Undefined when the tab had only
 * this pane; the tab unchanged when it has no such pane.
 */
export function removePane(tab: LayoutTab, paneId: string): LayoutTab | undefined {
  if (!findPane(tab.root, paneId)) return tab;
  if (tab.root.kind === "pane") return undefined;
  const parent = parentOf(tab.root, paneId)!;
  const index = parent.children.findIndex((child) => child.id === paneId);
  const children = parent.children.toSpliced(index, 1);
  const rest = parent.sizes.toSpliced(index, 1);
  const total = rest.reduce((sum, size) => sum + size, 0);
  const replacement: PaneNode =
    children.length === 1 ? children[0]! : { ...parent, children, sizes: rest.map((size) => size / total) };
  // A split that gives way to its last child can leave a row inside a row; merge it into its parent.
  const root = mergeSameDirection(replaceNode(tab.root, parent.id, () => replacement));
  const successor = children[index] ?? children[index - 1]!;
  const activePaneId = tab.activePaneId === paneId ? firstPane(successor).id : tab.activePaneId;
  return { ...tab, root, activePaneId };
}

/**
 * The tree with `node` at `zone` of the pane `paneId`: `center` takes the pane's place, an edge splits it (`row`
 * for left and right, `column` for top and bottom). In a split of that direction already, `node` becomes a sibling
 * and gets half the pane's share (three columns, not a column inside a column). Splits of the same direction merge.
 * The tree unchanged for an unknown pane.
 */
export function insertAt(
  root: PaneNode,
  paneId: string,
  zone: PaneZone,
  node: PaneNode,
  newId: () => string,
): PaneNode {
  if (!findPane(root, paneId)) return root;
  if (zone === "center") return mergeSameDirection(replaceNode(root, paneId, () => node));
  const direction: LayoutSplit["direction"] = zone === "left" || zone === "right" ? "row" : "column";
  const before = zone === "left" || zone === "top";
  const parent = parentOf(root, paneId);
  const changed =
    parent?.direction === direction
      ? replaceNode(root, parent.id, () => {
          const index = parent.children.findIndex((child) => child.id === paneId);
          const half = parent.sizes[index]! / 2;
          return {
            ...parent,
            children: parent.children.toSpliced(before ? index : index + 1, 0, node),
            sizes: parent.sizes.toSpliced(index, 1, half, half),
          };
        })
      : replaceNode(root, paneId, (pane) => ({
          kind: "split",
          id: newId(),
          direction,
          children: before ? [node, pane] : [pane, node],
          sizes: [0.5, 0.5],
        }));
  return mergeSameDirection(changed);
}
