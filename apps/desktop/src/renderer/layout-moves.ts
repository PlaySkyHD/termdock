// Arranging tabs and panes (#67): which moves of a tab, a pane or a session of the sidebar the window allows,
// and what the window looks like afterwards. Pure; drag and drop (valid targets, the drop), the key bindings and
// the context menus all ask `applyMove`, so mouse and keyboard cannot disagree. Only views move, never sessions:
// a moved pane keeps its id, and the window keeps its element and its view in the core (ADR 0006).
import type { LayoutPane, LayoutTab, LayoutWindow, PaneNode, SessionId } from "@termdock/protocol";
import { neighborPane } from "./pane-focus.js";
import type { FocusDirection } from "./pane-focus.js";
import { findPane, insertAt, MAX_PANES, MAX_TABS, paneCount, removePane } from "./pane-tree.js";
import type { PaneZone } from "./pane-tree.js";
import { applySnap } from "./snap-layouts.js";
import type { SnapPatternId } from "./snap-layouts.js";

/** What is moved: a whole tab (its pane tree), one pane (its view) or a session (a new view of it). */
export type MoveSource =
  | { kind: "tab"; tabId: string }
  | { kind: "pane"; paneId: string }
  | { kind: "session"; sessionId: SessionId };

/** Where it goes: a zone of a pane, or the tab bar before a tab (at the end without one). */
export type MoveTarget =
  | { kind: "pane"; paneId: string; zone: PaneZone }
  | { kind: "tabBar"; beforeTabId?: string }
  /** Change places with another pane of the same tab (the menu's step in a direction). */
  | { kind: "swap"; paneId: string }
  /** A field of a layout pattern (#78): the active tab is arranged after it (`snap-layouts.ts`). */
  | { kind: "snap"; pattern: SnapPatternId; slot: number };

/**
 * The window after the move, or undefined when the move is not allowed or changes nothing. The tab that gets the
 * moved view becomes active, and the view its active pane; a tab left without panes closes. `newId` names new
 * tabs, panes and splits.
 */
export function applyMove(
  window: LayoutWindow,
  source: MoveSource,
  target: MoveTarget,
  newId: () => string,
): LayoutWindow | undefined {
  if (target.kind === "swap") return swap(window, source, target.paneId);
  if (target.kind === "snap") return applySnap(window, source, target.pattern, target.slot, newId);
  return target.kind === "tabBar"
    ? toTabBar(window, source, target.beforeTabId, newId)
    : toPane(window, source, target, newId);
}

/** Two panes of one tab change places; the moved one becomes active. Only for a pane as the source. */
function swap(window: LayoutWindow, source: MoveSource, otherId: string): LayoutWindow | undefined {
  if (source.kind !== "pane" || source.paneId === otherId) return undefined;
  const tab = tabOfPane(window, source.paneId);
  const moved = tab && findPane(tab.root, source.paneId);
  const other = tab && findPane(tab.root, otherId);
  if (!tab || !moved || !other) return undefined;
  // Both places at once: replacing one after the other would leave two nodes with the same id in between.
  const exchange = (node: PaneNode): PaneNode =>
    node.kind === "pane"
      ? node.id === moved.id
        ? other
        : node.id === otherId
          ? moved
          : node
      : { ...node, children: node.children.map(exchange) };
  const root = exchange(tab.root);
  return {
    ...window,
    tabs: window.tabs.map((each) => (each.id === tab.id ? { ...tab, root, activePaneId: moved.id } : each)),
    activeTabId: tab.id,
  };
}

/** Whether `applyMove` would do something; changes nothing. */
export function canMove(window: LayoutWindow, source: MoveSource, target: MoveTarget): boolean {
  return applyMove(window, source, target, () => "probe") !== undefined;
}

/** The tab bar target that moves the tab one place to the left (-1) or right (1); undefined at the edge. */
export function tabStepTarget(window: LayoutWindow, tabId: string, step: -1 | 1): MoveTarget | undefined {
  const { tabs } = window;
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return undefined;
  if (step === -1) return index > 0 ? { kind: "tabBar", beforeTabId: tabs[index - 1]!.id } : undefined;
  if (index >= tabs.length - 1) return undefined;
  const after = tabs[index + 2];
  return after ? { kind: "tabBar", beforeTabId: after.id } : { kind: "tabBar" };
}

/**
 * The target that moves the pane one step in `direction`: it changes places with its neighbour there (the one
 * `Alt+arrow` would focus), and the tree keeps its shape. Undefined at the edge of the tab.
 */
export function paneStepTarget(
  tab: LayoutTab,
  paneId: string,
  direction: FocusDirection,
): MoveTarget | undefined {
  const neighbor = neighborPane(tab.root, paneId, direction);
  return neighbor === undefined ? undefined : { kind: "swap", paneId: neighbor };
}

/** The tab that holds the pane. */
export function tabOfPane(window: LayoutWindow, paneId: string): LayoutTab | undefined {
  return window.tabs.find((tab) => findPane(tab.root, paneId) !== undefined);
}

function toTabBar(
  window: LayoutWindow,
  source: MoveSource,
  beforeTabId: string | undefined,
  newId: () => string,
): LayoutWindow | undefined {
  const { tabs } = window;
  if (beforeTabId !== undefined && !tabs.some((tab) => tab.id === beforeTabId)) return undefined;
  if (source.kind === "tab") return reorder(window, source.tabId, beforeTabId);
  // A session opens in a tab by a click in the sidebar; dropping it on the tab bar is not offered.
  if (source.kind === "session") return undefined;
  const from = tabOfPane(window, source.paneId);
  if (!from) return undefined;
  // The only pane of its tab: moving it to the tab bar moves its tab.
  if (from.root.kind === "pane") return reorder(window, from.id, beforeTabId);
  if (tabs.length >= MAX_TABS) return undefined;
  const pane = findPane(from.root, source.paneId)!;
  const rest = removePane(from, pane.id)!;
  const tab: LayoutTab = { id: newId(), root: pane, activePaneId: pane.id };
  const kept = tabs.map((each) => (each.id === from.id ? rest : each));
  return { ...window, tabs: insertBefore(kept, tab, beforeTabId), activeTabId: tab.id };
}

function reorder(
  window: LayoutWindow,
  tabId: string,
  beforeTabId: string | undefined,
): LayoutWindow | undefined {
  const { tabs } = window;
  const tab = tabs.find((each) => each.id === tabId);
  if (!tab || beforeTabId === tabId) return undefined;
  const next = insertBefore(
    tabs.filter((each) => each !== tab),
    tab,
    beforeTabId,
  );
  if (next.every((each, index) => each === tabs[index])) return undefined;
  return { ...window, tabs: next, activeTabId: tab.id };
}

function insertBefore(
  tabs: readonly LayoutTab[],
  tab: LayoutTab,
  beforeTabId: string | undefined,
): LayoutTab[] {
  const index = beforeTabId === undefined ? tabs.length : tabs.findIndex((each) => each.id === beforeTabId);
  return tabs.toSpliced(index < 0 ? tabs.length : index, 0, tab);
}

function toPane(
  window: LayoutWindow,
  source: MoveSource,
  target: Extract<MoveTarget, { kind: "pane" }>,
  newId: () => string,
): LayoutWindow | undefined {
  const { tabs } = window;
  const into = tabOfPane(window, target.paneId);
  if (!into) return undefined;
  const { zone } = target;
  const center = zone === "center";
  const targetPane = findPane(into.root, target.paneId)!;
  const count = paneCount(into);
  let node: PaneNode;
  let activePaneId: string;
  let base = into;
  let others: readonly LayoutTab[] = tabs;

  switch (source.kind) {
    case "session": {
      // The pane shows the session already: replacing its view with another one of the same changes nothing.
      if (center && targetPane.sessionId === source.sessionId) return undefined;
      if (!center && count >= MAX_PANES) return undefined;
      const pane: LayoutPane = { kind: "pane", id: newId(), sessionId: source.sessionId };
      node = pane;
      // A second view of the same session reads; the writing pane keeps the focus (as `splitPane`).
      activePaneId = !center && targetPane.sessionId === source.sessionId ? targetPane.id : pane.id;
      break;
    }
    case "tab": {
      const from = tabs.find((each) => each.id === source.tabId);
      if (!from || from.id === into.id) return undefined;
      if (count + paneCount(from) - (center ? 1 : 0) > MAX_PANES) return undefined;
      node = from.root;
      activePaneId = from.activePaneId;
      others = tabs.filter((each) => each.id !== from.id);
      break;
    }
    case "pane": {
      if (source.paneId === target.paneId) return undefined;
      const from = tabOfPane(window, source.paneId);
      if (!from) return undefined;
      const pane = findPane(from.root, source.paneId)!;
      if (from.id === into.id) {
        // Within the tab: out of its place first; the target is another pane, so the tab keeps one.
        base = removePane(into, pane.id)!;
      } else {
        if (!center && count >= MAX_PANES) return undefined;
        const rest = removePane(from, pane.id);
        others = rest
          ? tabs.map((each) => (each.id === from.id ? rest : each))
          : tabs.filter((each) => each.id !== from.id);
      }
      node = pane;
      activePaneId = pane.id;
      break;
    }
  }

  const tab: LayoutTab = {
    ...base,
    root: insertAt(base.root, target.paneId, zone, node, newId),
    activePaneId,
  };
  return { ...window, tabs: others.map((each) => (each.id === into.id ? tab : each)), activeTabId: into.id };
}
