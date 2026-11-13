import { MAX_TABS_PER_WINDOW, validateLayoutDocument } from "@termdock/protocol";
import type { SessionInfo, SessionState } from "@termdock/protocol";
import { describe, expect, it, vi } from "vitest";
import { activeTab, MAX_TABS, tabSessionId, UiStore } from "./ui-store.js";

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
