// Mapping between the windows of the app and the `LayoutDocument` of the core (#29, ADR 0006). Pure: no Electron,
// no DOM. Main and renderer both use it, so what is stored is what the store holds.
// The renderer imports only types of the protocol, so the version is the literal `LAYOUT_VERSION` (1).
import type { LayoutDocument, LayoutPane, LayoutTab, LayoutWindow, PaneNode } from "@termdock/protocol";

/**
 * What a renderer reports of its window: everything but the id and the geometry. Id and `bounds`/`maximized`
 * belong to the main process, which owns the `BrowserWindow`.
 */
export type LayoutWindowPart = Omit<LayoutWindow, "id" | "bounds" | "maximized">;

/** The part of the window that its renderer reports. Optional fields stay absent when absent. */
export function windowPart(window: LayoutWindow): LayoutWindowPart {
  const { id: _id, bounds: _bounds, maximized: _maximized, ...part } = window;
  return part;
}

/**
 * The window with the part of its renderer replaced; id and geometry stay, whatever the part says. Fields the
 * part omits are gone.
 */
export function withPart(window: LayoutWindow, part: LayoutWindowPart): LayoutWindow {
  return {
    id: window.id,
    ...(window.bounds === undefined ? {} : { bounds: window.bounds }),
    ...(window.maximized === undefined ? {} : { maximized: window.maximized }),
    ...(part.sidebarVisible === undefined ? {} : { sidebarVisible: part.sidebarVisible }),
    ...(part.sidebarWidth === undefined ? {} : { sidebarWidth: part.sidebarWidth }),
    tabs: part.tabs,
    ...(part.activeTabId === undefined ? {} : { activeTabId: part.activeTabId }),
  };
}

/** The document of version 1 for these windows, in this order. */
export function toLayoutDocument(windows: readonly LayoutWindow[]): LayoutDocument {
  return { version: 1, windows: [...windows] };
}

/**
 * The windows of a stored document, as copies the store may keep. The core has checked the document, but its
 * active tab and pane are repaired anyway: a window that cannot show its active tab would show nothing.
 */
export function windowsFromDocument(layout: LayoutDocument | undefined): LayoutWindow[] {
  return (layout?.windows ?? []).map((window) => normalizeWindow(structuredClone(window)));
}

function normalizeWindow(window: LayoutWindow): LayoutWindow {
  const tabs = window.tabs.map(normalizeTab);
  const { activeTabId: _active, ...rest } = window;
  const activeTabId = tabs.some((tab) => tab.id === window.activeTabId) ? window.activeTabId : tabs[0]?.id;
  return { ...rest, tabs, ...(activeTabId === undefined ? {} : { activeTabId }) };
}

function normalizeTab(tab: LayoutTab): LayoutTab {
  const panes = panesOf(tab.root);
  const activePaneId = panes.some((pane) => pane.id === tab.activePaneId) ? tab.activePaneId : panes[0]!.id;
  return { ...tab, activePaneId };
}

function panesOf(node: PaneNode): LayoutPane[] {
  return node.kind === "pane" ? [node] : node.children.flatMap(panesOf);
}
