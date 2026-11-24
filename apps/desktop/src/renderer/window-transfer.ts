// Moving a tab or a pane to another window (#68), the pure part of both ends. The source window builds the item it
// hands to the main process (`transferItem`) and later takes it out (`takeOut`); the target window puts it in with
// new ids by the rules of `applyMove` (`applyIncoming`), waits until every pane it put in has attached
// (`settleIncoming`) and takes them out again when the move is cancelled (`withoutIncoming`). The handover of the
// writer is the main process's (`main/window-transfer.ts`). Free of DOM and React.
import type { LayoutTab, LayoutWindow, PaneNode, SessionInfo, ViewId } from "@termdock/protocol";
import type { TransferItem, TransferSource, TransferView } from "../shared/bridge.js";
import type { DragPayload } from "./drag/drag-model.js";
import { dropTarget, PANE_KIND, TAB_KIND } from "./layout-drop.js";
import { applyMove, tabOfPane } from "./layout-moves.js";
import type { MoveSource, MoveTarget } from "./layout-moves.js";
import { findPane, MAX_TABS, panesOf, removePane } from "./pane-tree.js";

/** Payload kind of a tab or pane that another window drags over this one. */
export const INCOMING_KIND = "incoming";

/**
 * The item for a move of `source` to another window, and whether it is the whole window (its only tab, or the only
 * pane of that tab). Only tabs and panes leave a window. `viewOf` names the view attached in a pane.
 */
export function transferItem(
  window: LayoutWindow,
  source: MoveSource,
  viewOf: (paneId: string) => ViewId | undefined,
): { item: TransferItem; whole: boolean } | undefined {
  const viewsIn = (node: PaneNode): TransferView[] =>
    panesOf(node).flatMap((each) => {
      const viewId = viewOf(each.id);
      return viewId === undefined ? [] : [{ paneId: each.id, viewId }];
    });
  const only = window.tabs.length === 1 ? window.tabs[0] : undefined;
  if (source.kind === "tab") {
    const tab = window.tabs.find((each) => each.id === source.tabId);
    if (!tab) return undefined;
    return { item: { kind: "tab", tab, views: viewsIn(tab.root) }, whole: only === tab };
  }
  if (source.kind !== "pane") return undefined;
  const owner = tabOfPane(window, source.paneId);
  const pane = owner && findPane(owner.root, source.paneId);
  if (!owner || !pane) return undefined;
  return {
    item: { kind: "pane", pane, views: viewsIn(pane) },
    whole: only === owner && owner.root.kind === "pane",
  };
}

/**
 * The item a drag of this window takes to another window: a tab of the tab bar or a pane at its grip (payload kinds
 * of `layout-drop.ts`); undefined for everything else, which stays in its window.
 */
export function outgoingItem(
  window: LayoutWindow,
  payload: DragPayload,
  viewOf: (paneId: string) => ViewId | undefined,
): { item: TransferItem; whole: boolean } | undefined {
  if (payload.kind === TAB_KIND) return transferItem(window, { kind: "tab", tabId: payload.id }, viewOf);
  if (payload.kind === PANE_KIND) return transferItem(window, { kind: "pane", paneId: payload.id }, viewOf);
  return undefined;
}

/** The window without the tab. When it was active, its right neighbour becomes active, the left one for the last. */
export function withoutTab(window: LayoutWindow, tabId: string): LayoutWindow {
  const index = window.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return window;
  const tabs = window.tabs.filter((tab) => tab.id !== tabId);
  const { activeTabId: _active, ...rest } = window;
  const activeTabId =
    window.activeTabId === tabId ? (tabs[index] ?? tabs[index - 1])?.id : window.activeTabId;
  return { ...rest, tabs, ...(activeTabId === undefined ? {} : { activeTabId }) };
}

/** The window without one pane; a tab left without panes closes. Unchanged without the pane. */
function withoutPane(window: LayoutWindow, paneId: string): LayoutWindow {
  const owner = tabOfPane(window, paneId);
  if (!owner) return window;
  const rest = removePane(owner, paneId);
  if (!rest) return withoutTab(window, owner.id);
  return { ...window, tabs: window.tabs.map((each) => (each.id === owner.id ? rest : each)) };
}

/** The source window after the move: the tab or the pane is gone, its views go with it. */
export function takeOut(window: LayoutWindow, source: TransferSource): LayoutWindow {
  return source.kind === "tab" ? withoutTab(window, source.tabId) : withoutPane(window, source.paneId);
}

/** The target window without the panes it put in for a move that was cancelled. */
export function withoutIncoming(window: LayoutWindow, paneIds: readonly string[]): LayoutWindow {
  return paneIds.reduce(withoutPane, window);
}

/**
 * Where an incoming item goes: the drop target under the point (`targetId`, valid for the item), or the end of the
 * tab bar for a new window (no point) and for an empty one, which shows no other target. Undefined over no target.
 */
export function incomingTarget(
  window: LayoutWindow,
  hasPoint: boolean,
  targetId: string | undefined,
): MoveTarget | undefined {
  if (!hasPoint || window.tabs.length === 0) return { kind: "tabBar" };
  return targetId === undefined ? undefined : dropTarget(window, targetId);
}

/** The payload of another window's item while it is dragged over this one or dropped here. */
export function incomingPayload(
  item: TransferItem,
  sessions: ReadonlyArray<Pick<SessionInfo, "id" | "name">>,
): DragPayload {
  return {
    kind: INCOMING_KIND,
    id: item.kind === "tab" ? item.tab.id : item.pane.id,
    label: incomingLabel(item, sessions),
  };
}

/** Text of the ghost in the target: the session of the item's active pane, as this window knows it. */
export function incomingLabel(
  item: TransferItem,
  sessions: ReadonlyArray<Pick<SessionInfo, "id" | "name">>,
): string {
  const pane = item.kind === "pane" ? item.pane : findPane(item.tab.root, item.tab.activePaneId);
  return sessions.find((session) => session.id === pane?.sessionId)?.name ?? "Pane";
}

/**
 * The target window with the item at `target`, by the rules of `applyMove`: the tab bar (a tab of its own, at the
 * end without `beforeTabId`) or an edge of a pane. Every tab, pane and split gets a new id, so the layout document
 * keeps unique ids while the item is in both windows. `panes` maps each new pane to its pane in the source.
 * Undefined when the move is not allowed; layout patterns, swaps and the center of a pane are no targets for
 * another window's item.
 */
export function applyIncoming(
  window: LayoutWindow,
  item: TransferItem,
  target: MoveTarget,
  newId: () => string,
): { window: LayoutWindow; panes: Record<string, string> } | undefined {
  // The center would replace a pane of this window before the move is certain; a cancel could not bring it back.
  if (
    target.kind === "snap" ||
    target.kind === "swap" ||
    (target.kind === "pane" && target.zone === "center")
  )
    return undefined;
  const panes: Record<string, string> = {};
  const renamed = (node: PaneNode): PaneNode => {
    const id = newId();
    if (node.kind === "pane") {
      panes[id] = node.id;
      return { ...node, id };
    }
    return { ...node, id, children: node.children.map(renamed) };
  };
  const root = renamed(item.kind === "tab" ? item.tab.root : item.pane);
  const sourceActive = item.kind === "tab" ? item.tab.activePaneId : item.pane.id;
  const activePaneId = Object.keys(panes).find((id) => panes[id] === sourceActive) ?? Object.keys(panes)[0]!;
  const incoming: LayoutTab = {
    ...(item.kind === "tab" && item.tab.title !== undefined ? { title: item.tab.title } : {}),
    id: newId(),
    root,
    activePaneId,
  };

  if (target.kind === "tabBar") {
    const { tabs } = window;
    if (tabs.length >= MAX_TABS) return undefined;
    const index =
      target.beforeTabId === undefined ? tabs.length : tabs.findIndex((tab) => tab.id === target.beforeTabId);
    if (index < 0) return undefined;
    return {
      window: { ...window, tabs: tabs.toSpliced(index, 0, incoming), activeTabId: incoming.id },
      panes,
    };
  }
  // On a pane: the item joins the window as an extra tab for a moment and moves from there like one of its own.
  const joined: LayoutWindow = { ...window, tabs: [...window.tabs, incoming] };
  const source: MoveSource =
    item.kind === "tab" ? { kind: "tab", tabId: incoming.id } : { kind: "pane", paneId: root.id };
  const moved = applyMove(joined, source, target, newId);
  if (!moved || moved.tabs.some((tab) => tab.id === incoming.id)) return undefined;
  return { window: moved, panes };
}

/** How an incoming pane ended: attached with its view, a placeholder without one, or failed to attach. */
export interface PaneOutcome {
  viewId?: ViewId;
  failed?: boolean;
}

/** A move into this window, waiting for its panes (new pane id → source pane id). */
export interface IncomingTransfer {
  readonly transferId: string;
  readonly panes: Readonly<Record<string, string>>;
  readonly settled: Readonly<Record<string, PaneOutcome>>;
}

export function startIncoming(transferId: string, panes: Readonly<Record<string, string>>): IncomingTransfer {
  return { transferId, panes, settled: {} };
}

/**
 * Notes how a pane ended. Once every pane has, `result` is the answer for the main process: the new view of each
 * source pane that has one, or `refused` when a pane could not attach (the main process then hands nothing over).
 */
export function settleIncoming(
  transfer: IncomingTransfer,
  paneId: string,
  outcome: PaneOutcome,
): { transfer: IncomingTransfer; result?: { views: TransferView[] } | "refused" } {
  if (!(paneId in transfer.panes) || paneId in transfer.settled) return { transfer };
  const next: IncomingTransfer = { ...transfer, settled: { ...transfer.settled, [paneId]: outcome } };
  const ids = Object.keys(next.panes);
  if (!ids.every((id) => id in next.settled)) return { transfer: next };
  if (ids.some((id) => next.settled[id]!.failed === true)) return { transfer: next, result: "refused" };
  const views = ids.flatMap((id) => {
    const viewId = next.settled[id]!.viewId;
    return viewId === undefined ? [] : [{ paneId: next.panes[id]!, viewId }];
  });
  return { transfer: next, result: { views } };
}
