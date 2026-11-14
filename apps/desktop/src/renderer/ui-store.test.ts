import { MAX_PANES_PER_TAB, MAX_TABS_PER_WINDOW, validateLayoutDocument } from "@termdock/protocol";
import type { LayoutTab, SessionInfo, SessionState } from "@termdock/protocol";
import { describe, expect, it, vi } from "vitest";
import { activeTab, MAX_PANES, MAX_TABS, paneCount, tabSessionId, UiStore } from "./ui-store.js";

function session(
  id: string,
  state: SessionState = "Detached",
  createdAt = "2026-11-13T10:00:00Z",
): SessionInfo {
  return {
    id,
    name: `Session ${id}`,
    state,
    launch: { backend: "wsl", cwd: "~" },
    size: { cols: 80, rows: 24 },
    loggingEnabled: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function newStore(): UiStore {
  let next = 0;
  return new UiStore({ newId: () => `id${++next}` });
}

const tabIds = (store: UiStore): string[] => store.getState().window.tabs.map((tab) => tab.id);
const sessionsOfTabs = (store: UiStore): Array<string | undefined> =>
  store.getState().window.tabs.map((tab) => tabSessionId(tab));

describe("UiStore tabs", () => {
  it("starts without tabs, with a visible sidebar", () => {
    const { window } = newStore().getState();

    expect(window.tabs).toEqual([]);
    expect(window.activeTabId).toBeUndefined();
    expect(window.sidebarVisible).toBe(true);
  });

  it("opens a session as an active tab with one pane", () => {
    const store = newStore();

    const tabId = store.openSession("s1");

    const { window } = store.getState();
    expect(window.activeTabId).toBe(tabId);
    expect(window.tabs).toHaveLength(1);
    const tab = window.tabs[0];
    expect(tab?.root).toMatchObject({ kind: "pane", sessionId: "s1" });
    expect(tab?.activePaneId).toBe(tab?.root.id);
  });

  it("focuses the tab that already shows the session instead of opening a second one", () => {
    const store = newStore();
    const first = store.openSession("s1");
    store.openSession("s2");

    const again = store.openSession("s1");

    expect(again).toBe(first);
    expect(sessionsOfTabs(store)).toEqual(["s1", "s2"]);
    expect(store.getState().window.activeTabId).toBe(first);
  });

  it("opens a second tab for the same session when asked to", () => {
    const store = newStore();
    const first = store.openSession("s1");

    const second = store.openSession("s1", { forceNew: true });

    expect(second).not.toBe(first);
    expect(sessionsOfTabs(store)).toEqual(["s1", "s1"]);
    expect(store.getState().window.activeTabId).toBe(second);
  });

  it("focuses another tab and ignores an unknown one", () => {
    const store = newStore();
    const first = store.openSession("s1");
    store.openSession("s2");

    store.focusTab(first!);
    expect(store.getState().window.activeTabId).toBe(first);

    store.focusTab("nope");
    expect(store.getState().window.activeTabId).toBe(first);
  });

  it("makes the right neighbour active when the active tab closes", () => {
    const store = newStore();
    const [a, b, c] = [store.openSession("s1")!, store.openSession("s2")!, store.openSession("s3")!];
    store.focusTab(b);

    store.closeTab(b);

    expect(tabIds(store)).toEqual([a, c]);
    expect(store.getState().window.activeTabId).toBe(c);
  });

  it("makes the left neighbour active when the last tab closes", () => {
    const store = newStore();
    const [a, b] = [store.openSession("s1")!, store.openSession("s2")!];

    store.closeTab(b);

    expect(tabIds(store)).toEqual([a]);
    expect(store.getState().window.activeTabId).toBe(a);
  });

  it("keeps the active tab when another one closes", () => {
    const store = newStore();
    const [a, b, c] = [store.openSession("s1")!, store.openSession("s2")!, store.openSession("s3")!];

    store.closeTab(a);

    expect(tabIds(store)).toEqual([b, c]);
    expect(store.getState().window.activeTabId).toBe(c);
  });

  it("has no active tab once the last tab is closed", () => {
    const store = newStore();
    const a = store.openSession("s1")!;

    store.closeTab(a);

    expect(store.getState().window.tabs).toEqual([]);
    expect("activeTabId" in store.getState().window).toBe(false);
    expect(activeTab(store.getState())).toBeUndefined();
  });

  it("ignores closing an unknown tab", () => {
    const store = newStore();
    store.openSession("s1");
    const listener = vi.fn();
    store.subscribe(listener);

    store.closeTab("nope");

    expect(listener).not.toHaveBeenCalled();
    expect(store.getState().window.tabs).toHaveLength(1);
  });

  it("opens no tab beyond the limit of the layout format", () => {
    const store = newStore();
    for (let i = 0; i < MAX_TABS; i++) store.openSession(`s${i}`);

    const refused = store.openSession("one-too-many");

    expect(refused).toBeUndefined();
    expect(store.getState().window.tabs).toHaveLength(MAX_TABS);
    expect(MAX_TABS).toBe(MAX_TABS_PER_WINDOW);
  });

  it("still focuses an existing tab at the limit", () => {
    const store = newStore();
    const first = store.openSession("s0")!;
    for (let i = 1; i < MAX_TABS; i++) store.openSession(`s${i}`);

    expect(store.openSession("s0")).toBe(first);
    expect(store.getState().window.activeTabId).toBe(first);
  });

  it("produces a window that the layout validation of the core accepts", () => {
    const store = newStore();
    store.openSession("s1");
    store.openSession("s2");
    store.toggleSidebar();

    const result = validateLayoutDocument({ version: 1, windows: [store.getState().window] });

    expect(result.ok).toBe(true);
  });

  it("produces an empty window that the layout validation accepts", () => {
    const store = newStore();
    const tab = store.openSession("s1")!;
    store.closeTab(tab);

    expect(validateLayoutDocument({ version: 1, windows: [store.getState().window] }).ok).toBe(true);
  });
});

/** The tab with the given id; fails the test when it is missing. */
function tabOf(store: UiStore, tabId: string): LayoutTab {
  const tab = store.getState().window.tabs.find((each) => each.id === tabId);
  if (!tab) throw new Error(`no tab ${tabId}`);
  return tab;
}

const validWindow = (store: UiStore): boolean =>
  validateLayoutDocument({ version: 1, windows: [store.getState().window] }).ok;

describe("UiStore split panes", () => {
  it("keeps the split pane active when the new pane shows the same session (the new view only reads)", () => {
    const store = newStore();
    const tabId = store.openSession("s1")!;
    const first = tabOf(store, tabId).root.id;

    const added = store.splitPane(tabId, first, "row", "s1");

    const tab = tabOf(store, tabId);
    expect(tab.root).toMatchObject({
      kind: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { kind: "pane", id: first, sessionId: "s1" },
        { kind: "pane", id: added, sessionId: "s1" },
      ],
    });
    expect(tab.activePaneId).toBe(first);
    expect(validWindow(store)).toBe(true);
  });

  it("makes the new pane active when it shows another session", () => {
    const store = newStore();
    const tabId = store.openSession("s1")!;

    const added = store.splitPane(tabId, tabOf(store, tabId).root.id, "row", "s2");

    expect(tabOf(store, tabId).activePaneId).toBe(added);
  });

  it("merges the remaining child into a parent split of the same direction when a pane closes", () => {
    const store = newStore();
    const tabId = store.openSession("s1")!;
    const a = tabOf(store, tabId).root.id;
    const b = store.splitPane(tabId, a, "row", "s2")!; // row[a, b]
    const c = store.splitPane(tabId, b, "column", "s3")!; // row[a, column[b, c]]
    const d = store.splitPane(tabId, c, "row", "s4")!; // row[a, column[b, row[c, d]]]

    store.closePane(tabId, b);

    const { root } = tabOf(store, tabId);
    expect(root.kind === "split" && root.direction).toBe("row");
    expect(root.kind === "split" && root.children.map((child) => child.id)).toEqual([a, c, d]);
    expect(root.kind === "split" && root.sizes).toEqual([0.5, 0.25, 0.25]);
    expect(validWindow(store)).toBe(true);
  });

  it("adds a sibling when the pane already sits in a split of the same direction, halving its share", () => {
    const store = newStore();
    const tabId = store.openSession("s1")!;
    const left = tabOf(store, tabId).root.id;
    const right = store.splitPane(tabId, left, "row", "s2")!;

    const third = store.splitPane(tabId, right, "row", "s3");

    const { root } = tabOf(store, tabId);
    expect(root.kind === "split" && root.children.map((child) => child.id)).toEqual([left, right, third]);
    expect(root.kind === "split" && root.sizes).toEqual([0.5, 0.25, 0.25]);
    expect(validWindow(store)).toBe(true);
  });

  it("nests a split of the other direction inside a split", () => {
    const store = newStore();
    const tabId = store.openSession("s1")!;
    const left = tabOf(store, tabId).root.id;
    const right = store.splitPane(tabId, left, "row", "s2")!;

    const below = store.splitPane(tabId, right, "column", "s3");

    expect(tabOf(store, tabId).root).toMatchObject({
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { id: left },
        { kind: "split", direction: "column", sizes: [0.5, 0.5], children: [{ id: right }, { id: below }] },
      ],
    });
  });

  it("refuses a fifth pane and leaves the tab unchanged", () => {
    const store = newStore();
    const tabId = store.openSession("s1")!;
    let pane = tabOf(store, tabId).root.id;
    for (const direction of ["row", "column", "row"] as const)
      pane = store.splitPane(tabId, pane, direction, "s1")!;
    expect(paneCount(tabOf(store, tabId))).toBe(MAX_PANES_PER_TAB);
    expect(MAX_PANES).toBe(MAX_PANES_PER_TAB);
    const before = tabOf(store, tabId);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.splitPane(tabId, pane, "column", "s1")).toBeUndefined();

    expect(tabOf(store, tabId)).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(validWindow(store)).toBe(true);
  });

  it("closes a pane: the split with one child left gives way to it, which becomes active", () => {
    const store = newStore();
    const tabId = store.openSession("s1")!;
    const left = tabOf(store, tabId).root.id;
    const right = store.splitPane(tabId, left, "row", "s2")!;

    store.closePane(tabId, right);

    const tab = tabOf(store, tabId);
    expect(tab.root).toEqual({ kind: "pane", id: left, sessionId: "s1" });
    expect(tab.activePaneId).toBe(left);
    expect(validWindow(store)).toBe(true);
  });

  it("closes a pane of three and spreads its share over the others", () => {
    const store = newStore();
    const tabId = store.openSession("s1")!;
    const a = tabOf(store, tabId).root.id;
    const b = store.splitPane(tabId, a, "row", "s2")!;
    const c = store.splitPane(tabId, b, "row", "s3")!; // sizes 0.5, 0.25, 0.25
    store.focusPane(tabId, a);

    store.closePane(tabId, b);

    const tab = tabOf(store, tabId);
    expect(tab.root.kind === "split" && tab.root.children.map((child) => child.id)).toEqual([a, c]);
    expect(tab.root.kind === "split" && tab.root.sizes).toEqual([2 / 3, 1 / 3]);
    expect(tab.activePaneId).toBe(a);
    expect(validWindow(store)).toBe(true);
  });

  it("lifts a nested split into its parent's place when its sibling pane closes", () => {
    const store = newStore();
    const tabId = store.openSession("s1")!;
    const left = tabOf(store, tabId).root.id;
    const right = store.splitPane(tabId, left, "row", "s2")!;
    const below = store.splitPane(tabId, right, "column", "s3")!;
    store.focusPane(tabId, left);

    store.closePane(tabId, left);

    const tab = tabOf(store, tabId);
    expect(tab.root).toMatchObject({
      kind: "split",
      direction: "column",
      children: [{ id: right }, { id: below }],
    });
    expect(tab.activePaneId).toBe(right);
    expect(validWindow(store)).toBe(true);
  });

  it("closes the tab with its last pane", () => {
    const store = newStore();
    const tabId = store.openSession("s1")!;

    store.closePane(tabId, tabOf(store, tabId).root.id);

    expect(store.getState().window.tabs).toEqual([]);
  });

  it("focuses a pane of the tab and ignores an unknown one", () => {
    const store = newStore();
    const tabId = store.openSession("s1")!;
    const left = tabOf(store, tabId).root.id;
    store.splitPane(tabId, left, "row", "s2");

    store.focusPane(tabId, left);
    expect(tabOf(store, tabId).activePaneId).toBe(left);
    expect(tabSessionId(tabOf(store, tabId))).toBe("s1");

    store.focusPane(tabId, "nope");
    expect(tabOf(store, tabId).activePaneId).toBe(left);
  });

  it("moves a divider between two children and keeps the sum of the shares", () => {
    const store = newStore();
    const tabId = store.openSession("s1")!;
    const a = tabOf(store, tabId).root.id;
    const b = store.splitPane(tabId, a, "row", "s2")!;
    store.splitPane(tabId, b, "row", "s3"); // 0.5, 0.25, 0.25
    const splitId = tabOf(store, tabId).root.id;

    store.moveDivider(tabId, splitId, 1, 0.1);

    const { root } = tabOf(store, tabId);
    const sizes = root.kind === "split" ? root.sizes : [];
    expect(sizes[0]).toBe(0.5);
    expect(sizes[1]).toBeCloseTo(0.35);
    expect(sizes[2]).toBeCloseTo(0.15);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 10);
    expect(validWindow(store)).toBe(true);
  });

  it("stops a divider at the minimum share of the smaller side", () => {
    const store = newStore();
    const tabId = store.openSession("s1")!;
    store.splitPane(tabId, tabOf(store, tabId).root.id, "column", "s2");
    const splitId = tabOf(store, tabId).root.id;

    store.moveDivider(tabId, splitId, 0, 0.9, 0.1);
    const { root: down } = tabOf(store, tabId);
    expect(down.kind === "split" && down.sizes).toEqual([0.9, 0.1]);

    store.moveDivider(tabId, splitId, 0, -5, 0.2);
    const { root: up } = tabOf(store, tabId);
    expect(up.kind === "split" && up.sizes).toEqual([0.2, 0.8]);
    expect(validWindow(store)).toBe(true);
  });

  it("ignores a divider that does not exist", () => {
    const store = newStore();
    const tabId = store.openSession("s1")!;
    store.splitPane(tabId, tabOf(store, tabId).root.id, "row", "s2");
    const splitId = tabOf(store, tabId).root.id;
    const before = tabOf(store, tabId);

    store.moveDivider(tabId, splitId, 1, 0.1);
    store.moveDivider(tabId, "nope", 0, 0.1);

    expect(tabOf(store, tabId)).toBe(before);
  });

  it("focuses the tab and the pane that show a session clicked in the sidebar", () => {
    const store = newStore();
    const tabId = store.openSession("s1")!;
    const left = tabOf(store, tabId).root.id;
    const right = store.splitPane(tabId, left, "row", "s2")!;
    store.focusPane(tabId, left);
    store.openSession("s3");

    expect(store.openSession("s2")).toBe(tabId);

    expect(store.getState().window.activeTabId).toBe(tabId);
    expect(tabOf(store, tabId).activePaneId).toBe(right);
  });
});

describe("UiStore sidebar", () => {
  it("toggles the sidebar", () => {
    const store = newStore();

    store.toggleSidebar();
    expect(store.getState().window.sidebarVisible).toBe(false);

    store.toggleSidebar();
    expect(store.getState().window.sidebarVisible).toBe(true);
  });
});

describe("UiStore sessions", () => {
  it("lists the sessions of the core ordered by creation", () => {
    const store = newStore();

    store.setSessions([session("b", "Running", "2026-11-13T12:00:00Z"), session("a", "Detached")]);

    expect(store.getState().sessions.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("adds a created session", () => {
    const store = newStore();
    store.setSessions([session("a")]);

    store.sessionCreated(session("b", "Starting", "2026-11-13T11:00:00Z"));

    expect(store.getState().sessions.map((s) => [s.id, s.state])).toEqual([
      ["a", "Detached"],
      ["b", "Starting"],
    ]);
  });

  it("keeps the newer state of a session it already has when the older create answer arrives", () => {
    const store = newStore();
    store.sessionCreated(session("b", "Running", "2026-11-13T11:00:00Z"));
    store.sessionStateChanged("b", "Exited", 0);

    store.sessionCreated(session("b", "Running", "2026-11-13T11:00:00Z"));

    expect(store.getState().sessions.map((s) => [s.id, s.state])).toEqual([["b", "Exited"]]);
  });

  it("follows state changes, with the exit code", () => {
    const store = newStore();
    store.setSessions([session("a", "Running")]);

    store.sessionStateChanged("a", "Exited", 3);

    expect(store.getState().sessions[0]).toMatchObject({ state: "Exited", lastExitCode: 3 });
  });

  it("drops a stale exit code when the session runs again", () => {
    const store = newStore();
    store.setSessions([{ ...session("a", "Exited"), lastExitCode: 1 }]);

    store.sessionStateChanged("a", "Starting");

    const [a] = store.getState().sessions;
    expect(a?.state).toBe("Starting");
    expect(a && "lastExitCode" in a).toBe(false);
  });

  it("ignores the state of a session it does not know", () => {
    const store = newStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.sessionStateChanged("ghost", "Exited");

    expect(listener).not.toHaveBeenCalled();
    expect(store.getState().sessions).toEqual([]);
  });

  it("keeps the tab of a session that is gone from the list", () => {
    const store = newStore();
    store.setSessions([session("a")]);
    store.openSession("a");

    store.setSessions([]);

    expect(sessionsOfTabs(store)).toEqual(["a"]);
  });
});

describe("UiStore core", () => {
  it("keeps the core status and the end of the connection", () => {
    const store = newStore();

    store.setCoreStatus({ backendUnavailable: ["wsl"] });
    store.markCoreClosed();

    expect(store.getState().coreStatus).toEqual({ backendUnavailable: ["wsl"] });
    expect(store.getState().coreClosed).toBe(true);
  });
});

describe("UiStore loadWindow and sessionsLoaded (#29)", () => {
  it("takes over the window of the main process with its id, tabs and sidebar", () => {
    const store = newStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const window = {
      id: "w-main",
      sidebarVisible: false,
      activeTabId: "t1",
      tabs: [
        {
          id: "t1",
          root: { kind: "pane" as const, id: "p1", sessionId: "s1" },
          activePaneId: "p1",
        },
      ],
    };

    store.loadWindow(window);

    expect(store.getState().window).toEqual(window);
    expect(listener).toHaveBeenCalledTimes(1);
    // The loaded tabs work like any others.
    store.focusPane("t1", "p1");
    expect(store.splitPane("t1", "p1", "row", "s2")).toBeDefined();
  });

  it("knows the sessions only after the first list", () => {
    const store = newStore();
    expect(store.getState().sessionsLoaded).toBe(false);

    store.sessionCreated(session("s1"));
    expect(store.getState().sessionsLoaded).toBe(false);

    store.setSessions([session("s1")]);
    expect(store.getState().sessionsLoaded).toBe(true);
  });

  it("keeps the sessions unknown for a list that could not be fetched", () => {
    const store = newStore();
    store.setSessions([], false);
    expect(store.getState().sessionsLoaded).toBe(false);
  });
});

describe("UiStore subscription", () => {
  it("notifies on a change, not for a focus that changes nothing, and stops after unsubscribe", () => {
    const store = newStore();
    const listener = vi.fn();
    const tab = store.openSession("s1")!;
    const off = store.subscribe(listener);

    store.focusTab(tab);
    expect(listener).not.toHaveBeenCalled();

    store.openSession("s2");
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    store.openSession("s3");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
