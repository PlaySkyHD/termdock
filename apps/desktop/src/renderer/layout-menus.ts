// Context menus for arranging tabs and panes (#67): the keyboard way to every drag and drop move. Pure; each entry
// is a move of `layout-moves.ts`, disabled exactly when `canMove` refuses it, so menu and mouse agree.
import type { LayoutWindow, SessionId } from "@termdock/protocol";
import { canMove, paneStepTarget, tabOfPane, tabStepTarget } from "./layout-moves.js";
import type { MoveSource, MoveTarget } from "./layout-moves.js";
import type { FocusDirection } from "./pane-focus.js";
import { findPane, MAX_PANES, MAX_TABS, PANE_ZONES } from "./pane-tree.js";
import type { PaneZone } from "./pane-tree.js";
import type { MenuEntry } from "./sidebar-model.js";

export type LayoutAction =
  | { kind: "move"; source: MoveSource; target: MoveTarget }
  | { kind: "closeTab"; tabId: string }
  | { kind: "closePane"; paneId: string };

const FULL = `Höchstens ${MAX_PANES} Panes je Tab`;

/** Where in the active pane, as the entries of the tab and session menus name it. */
const ZONE_WORDS: Readonly<Record<PaneZone, string>> = {
  left: "links",
  right: "rechts",
  top: "oben",
  bottom: "unten",
  center: "Mitte (ersetzen)",
};

export const SESSION_PLACE_LABELS: Readonly<Record<PaneZone, string>> = {
  left: "Links vom aktiven Pane öffnen",
  right: "Rechts vom aktiven Pane öffnen",
  top: "Über dem aktiven Pane öffnen",
  bottom: "Unter dem aktiven Pane öffnen",
  center: "Im aktiven Pane öffnen",
};

const DIRECTIONS: ReadonlyArray<[FocusDirection, string]> = [
  ["left", "Mit dem Pane links tauschen"],
  ["right", "Mit dem Pane rechts tauschen"],
  ["up", "Mit dem Pane oben tauschen"],
  ["down", "Mit dem Pane unten tauschen"],
];

/** The zone target in the active pane of the active tab, or undefined without an active tab. */
function activeZone(window: LayoutWindow, zone: PaneZone): MoveTarget | undefined {
  const active = window.tabs.find((tab) => tab.id === window.activeTabId);
  return active ? { kind: "pane", paneId: active.activePaneId, zone } : undefined;
}

function moveEntry(
  window: LayoutWindow,
  key: string,
  label: string,
  source: MoveSource,
  target: MoveTarget | undefined,
  hint: string,
): MenuEntry<LayoutAction> {
  const allowed = target !== undefined && canMove(window, source, target);
  return {
    key,
    label,
    // A disabled entry is never chosen; its target only has to be some target.
    action: { kind: "move", source, target: target ?? { kind: "tabBar" } },
    ...(allowed ? {} : { disabled: true, hint }),
  };
}

/** Menu of a tab: move left and right, into the active tab (for another tab), close. */
export function tabMenu(window: LayoutWindow, tabId: string): MenuEntry<LayoutAction>[] {
  const source: MoveSource = { kind: "tab", tabId };
  const entries = [
    moveEntry(
      window,
      "left",
      "Nach links verschieben",
      source,
      tabStepTarget(window, tabId, -1),
      "Schon ganz links",
    ),
    moveEntry(
      window,
      "right",
      "Nach rechts verschieben",
      source,
      tabStepTarget(window, tabId, 1),
      "Schon ganz rechts",
    ),
  ];
  if (window.activeTabId !== undefined && window.activeTabId !== tabId)
    PANE_ZONES.forEach((zone, index) =>
      entries.push({
        ...moveEntry(
          window,
          `into:${zone}`,
          `In den aktiven Tab: ${ZONE_WORDS[zone]}`,
          source,
          activeZone(window, zone),
          FULL,
        ),
        ...(index === 0 ? { separator: true } : {}),
      }),
    );
  entries.push({
    key: "close",
    label: "Tab schließen",
    action: { kind: "closeTab", tabId },
    separator: true,
  });
  return entries;
}

/** Menu of a pane (its grip): a tab of its own, a step in each direction, close. */
export function paneMenu(window: LayoutWindow, paneId: string): MenuEntry<LayoutAction>[] {
  const tab = tabOfPane(window, paneId);
  if (!tab) return [];
  const source: MoveSource = { kind: "pane", paneId };
  const alone = tab.root.kind === "pane";
  const entries: MenuEntry<LayoutAction>[] = [
    moveEntry(
      window,
      "toTab",
      "In eigenen Tab verschieben",
      source,
      alone ? undefined : { kind: "tabBar" },
      alone ? "Das Pane ist schon ein eigener Tab" : `Höchstens ${MAX_TABS} Tabs je Fenster`,
    ),
  ];
  DIRECTIONS.forEach(([direction, label], index) =>
    entries.push({
      ...moveEntry(
        window,
        `move:${direction}`,
        label,
        source,
        paneStepTarget(tab, paneId, direction),
        "Kein Pane in dieser Richtung",
      ),
      ...(index === 0 ? { separator: true } : {}),
    }),
  );
  entries.push({
    key: "close",
    label: "Pane schließen",
    action: { kind: "closePane", paneId },
    separator: true,
  });
  return entries;
}

/**
 * Entries of a session's menu in the sidebar that open it in a zone of the active pane; none without an active
 * tab. The center is refused for the session the pane shows already.
 */
export function sessionPlaceEntries(window: LayoutWindow, sessionId: SessionId): MenuEntry<PaneZone>[] {
  const active = window.tabs.find((tab) => tab.id === window.activeTabId);
  if (!active) return [];
  const shown = findPane(active.root, active.activePaneId)?.sessionId === sessionId;
  return PANE_ZONES.map((zone) => {
    const allowed = canMove(window, { kind: "session", sessionId }, activeZone(window, zone)!);
    const hint = zone === "center" && shown ? "Das aktive Pane zeigt diese Session schon" : FULL;
    return {
      key: `place:${zone}`,
      label: SESSION_PLACE_LABELS[zone],
      action: zone,
      ...(allowed ? {} : { disabled: true, hint }),
    };
  });
}
