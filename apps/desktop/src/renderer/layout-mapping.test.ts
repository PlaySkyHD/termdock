import { validateLayoutDocument } from "@termdock/protocol";
import type { LayoutDocument, LayoutWindow, SessionInfo } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import { toLayoutDocument, windowPart, windowsFromDocument, withPart } from "../shared/layout-mapping.js";
import { UiStore } from "./ui-store.js";

function session(id: string): SessionInfo {
  return {
    id,
    name: id,
    state: "Running",
    createdAt: "2026-11-14T10:00:00.000Z",
    launch: { backend: "wsl", cwd: "/" },
  } as SessionInfo;
}

function newStore(prefix: string): UiStore {
  let counter = 0;
  const store = new UiStore({ newId: () => `${prefix}${++counter}` });
  store.setSessions(["s1", "s2", "s3"].map(session));
  return store;
}

/** Window with two tabs; the first has a column split with a row split inside (3 panes). */
function busyStore(prefix: string): UiStore {
  const store = newStore(prefix);
  const first = store.openSession("s1")!;
  const tab = store.getState().window.tabs.find((each) => each.id === first)!;
  const second = store.splitPane(first, tab.activePaneId, "column", "s2")!;
  store.splitPane(first, second, "row", "s3");
  const split = store.getState().window.tabs.find((each) => each.id === first)!.root;
  store.moveDivider(first, split.id, 0, 0.2);
  store.openSession("s2", { forceNew: true });
  store.focusTab(first);
  return store;
}

describe("toLayoutDocument", () => {
  it("wraps windows into a valid version 1 document", () => {
    const window = busyStore("a").getState().window;
    const document = toLayoutDocument([
      { ...window, bounds: { x: 10, y: 20, width: 900, height: 600 }, maximized: false },
    ]);
    expect(document.version).toBe(1);
    expect(document.windows).toHaveLength(1);
    expect(validateLayoutDocument(document).ok).toBe(true);
  });

  it("keeps the order of the windows", () => {
    const a = busyStore("a").getState().window;
    const b = busyStore("b").getState().window;
    expect(toLayoutDocument([b, a]).windows.map((window) => window.id)).toEqual([b.id, a.id]);
  });
});

describe("store to document and back", () => {
  it("restores tabs, pane tree, shares and active ids of the store", () => {
    const store = busyStore("a");
    const { window } = store.getState();
    const document = toLayoutDocument([window]);
    // The document survives JSON like the stored one does.
    const stored = JSON.parse(JSON.stringify(document)) as LayoutDocument;
    const [restored] = windowsFromDocument(stored);
    expect(restored).toEqual(window);

    const fresh = newStore("z");
    fresh.loadWindow(restored!);
    expect(fresh.getState().window).toEqual(window);
    expect(toLayoutDocument([fresh.getState().window])).toEqual(document);
  });

  it("restores two windows with their own tabs", () => {
    const a = busyStore("a").getState().window;
    const b = newStore("b");
    b.openSession("s3");
    const document = toLayoutDocument([a, b.getState().window]);
    const restored = windowsFromDocument(document);
    expect(restored.map((window) => window.tabs.length)).toEqual([2, 1]);
    expect(restored[1]!.tabs[0]!.root).toMatchObject({ kind: "pane", sessionId: "s3" });
  });
});

describe("document to store and back", () => {
  const document: LayoutDocument = {
    version: 1,
    windows: [
      {
        id: "w1",
        bounds: { x: -1200, y: 40, width: 1000, height: 700 },
        maximized: true,
        sidebarVisible: false,
        sidebarWidth: 280,
        activeTabId: "t2",
        tabs: [
          { id: "t1", title: "Build", root: { kind: "pane", id: "p1", sessionId: "s1" }, activePaneId: "p1" },
          {
            id: "t2",
            root: {
              kind: "split",
              id: "x1",
              direction: "row",
              sizes: [0.3, 0.7],
              children: [
                { kind: "pane", id: "p2", sessionId: "s2" },
                { kind: "pane", id: "p3", sessionId: "gone" },
              ],
            },
            activePaneId: "p3",
          },
        ],
      },
      { id: "w2", tabs: [] },
    ],
  };

  it("loads a window into the store and writes the same window out again", () => {
    const [first, second] = windowsFromDocument(document);
    const store = newStore("n");
    store.loadWindow(first!);
    const loaded = store.getState().window;
    expect(loaded.activeTabId).toBe("t2");
    expect(loaded.sidebarVisible).toBe(false);
    // Geometry belongs to the main process; the store keeps what it was given and passes it back.
    expect(toLayoutDocument([loaded, second!])).toEqual(document);
  });

  it("separates the part the renderer reports from id and geometry", () => {
    const [first] = windowsFromDocument(document);
    const part = windowPart(first!);
    expect(part).not.toHaveProperty("id");
    expect(part).not.toHaveProperty("bounds");
    expect(part).not.toHaveProperty("maximized");
    expect(part.tabs).toEqual(first!.tabs);
    expect(withPart(first!, part)).toEqual(first);
  });

  it("drops fields of the old part that the new part omits", () => {
    const [first] = windowsFromDocument(document);
    const emptied = withPart(first!, { tabs: [] });
    expect(emptied).toEqual({
      id: "w1",
      bounds: first!.bounds,
      maximized: true,
      tabs: [],
    });
  });

  it("keeps id and geometry of the window whatever the part of a renderer says", () => {
    const [first] = windowsFromDocument(document);
    const hostile = { tabs: [], id: "other", bounds: { x: 0, y: 0, width: 1, height: 1 }, maximized: false };
    expect(withPart(first!, hostile as never)).toEqual({
      id: "w1",
      bounds: first!.bounds,
      maximized: true,
      tabs: [],
    });
  });

  it("returns no windows without a document", () => {
    expect(windowsFromDocument(undefined)).toEqual([]);
  });

  it("does not share objects with the document it was made from", () => {
    const [first] = windowsFromDocument(document);
    expect(first).not.toBe(document.windows[0]);
    expect(first!.tabs[0]).not.toBe(document.windows[0]!.tabs[0]);
  });

  it("repairs an active tab and pane that do not exist", () => {
    const broken = {
      version: 1,
      windows: [
        {
          id: "w1",
          activeTabId: "nope",
          tabs: [{ id: "t1", root: { kind: "pane", id: "p1", sessionId: "s1" }, activePaneId: "nope" }],
        },
      ],
    } as LayoutDocument;
    const [window] = windowsFromDocument(broken);
    expect(window!.activeTabId).toBe("t1");
    expect(window!.tabs[0]!.activePaneId).toBe("p1");
  });

  it("gives a window with tabs an active tab and one without none", () => {
    const [window] = windowsFromDocument({
      version: 1,
      windows: [{ id: "w1", tabs: [] } as LayoutWindow],
    });
    expect(window).not.toHaveProperty("activeTabId");
  });
});
