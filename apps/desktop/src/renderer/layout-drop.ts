// What the drag and drop ids of tabs and panes mean (#67): payload kinds and target ids of the tab bar and the
// panes, translated into the moves of `layout-moves.ts`. Pure; the sidebar's targets (workspaces, archive) are
// none of these, so the two areas of the window never claim the same drop.
import type { LayoutWindow } from "@termdock/protocol";
import type { DragPayload } from "./drag/drag-model.js";
import { parseZoneTarget } from "./drag/drop-zones.js";
import type { MoveSource, MoveTarget } from "./layout-moves.js";
import { PANE_ZONES } from "./pane-tree.js";
import type { PaneZone } from "./pane-tree.js";
import { SESSION_KIND } from "./sidebar-model.js";

export const TAB_KIND = "tab";
export const PANE_KIND = "pane";
/** The free part of the tab bar right of the last tab: a drop there goes to the end. */
export const TAB_BAR_END = "tabbar";

/** Base of a pane's zone targets (`pane:<id>:<zone>`, `data-drop-zones="pane"`). */
export const paneTarget = (paneId: string): string => `pane:${paneId}`;
/** Base of a tab's half targets (`tab:<id>:before|after`, `data-drop-zones="sides"`). */
export const tabTarget = (tabId: string): string => `tab:${tabId}`;

export function dropSource(payload: DragPayload): MoveSource | undefined {
  switch (payload.kind) {
    case TAB_KIND:
      return { kind: "tab", tabId: payload.id };
    case PANE_KIND:
      return { kind: "pane", paneId: payload.id };
    case SESSION_KIND:
      return { kind: "session", sessionId: payload.id };
    default:
      return undefined;
  }
}

/** The move target of a drop target id; undefined for an id that is not the tab bar's or a pane's. */
export function dropTarget(window: LayoutWindow, targetId: string): MoveTarget | undefined {
  if (targetId === TAB_BAR_END) return { kind: "tabBar" };
  const parsed = parseZoneTarget(targetId);
  if (!parsed) return undefined;
  if (parsed.base.startsWith("pane:") && (PANE_ZONES as readonly string[]).includes(parsed.zone))
    return { kind: "pane", paneId: parsed.base.slice("pane:".length), zone: parsed.zone as PaneZone };
  if (parsed.base.startsWith("tab:") && (parsed.zone === "before" || parsed.zone === "after")) {
    const tabId = parsed.base.slice("tab:".length);
    const index = window.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return undefined;
    if (parsed.zone === "before") return { kind: "tabBar", beforeTabId: tabId };
    const next = window.tabs[index + 1];
    return next ? { kind: "tabBar", beforeTabId: next.id } : { kind: "tabBar" };
  }
  return undefined;
}
