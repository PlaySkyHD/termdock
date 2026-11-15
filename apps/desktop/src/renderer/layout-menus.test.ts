import type { LayoutPane, LayoutTab, LayoutWindow, PaneNode } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import { paneMenu, sessionPlaceEntries, tabMenu } from "./layout-menus.js";

const pane = (id: string, sessionId = `s-${id}`): LayoutPane => ({ kind: "pane", id, sessionId });
const row = (id: string, ...children: PaneNode[]): PaneNode => ({
  kind: "split",
  id,
  direction: "row",
  children,
  sizes: children.map(() => 1 / children.length),
});
const tab = (id: string, root: PaneNode, activePaneId: string): LayoutTab => ({ id, root, activePaneId });
const win = (tabs: LayoutTab[], activeTabId: string): LayoutWindow => ({ id: "w", tabs, activeTabId });

const SNAP_KEYS = ["snap:columns", "snap:rows", "snap:mainLeft", "snap:mainRight", "snap:grid"];

const enabled = (entries: ReadonlyArray<{ key: string; disabled?: boolean }>): string[] =>
  entries.filter((entry) => !entry.disabled).map((entry) => entry.key);

describe("tabMenu", () => {
  const window = win([tab("A", pane("a"), "a"), tab("B", pane("b"), "b"), tab("C", pane("c"), "c")], "B");

  it("offers moving left and right, the zones of the active pane and closing", () => {
    expect(enabled(tabMenu(window, "A"))).toEqual([
      "right",
      "into:left",
      "into:right",
      "into:top",
      "into:bottom",
      "into:center",
      ...SNAP_KEYS,
      "close",
    ]);
    const left = tabMenu(window, "A").find((entry) => entry.key === "left");
    expect(left).toMatchObject({ disabled: true, hint: "Schon ganz links" });
  });

  it("offers no zones for the active tab itself, and its patterns only with something to arrange", () => {
    expect(enabled(tabMenu(window, "B"))).toEqual(["left", "right", "close"]);
    expect(tabMenu(window, "B").find((entry) => entry.key === "snap:columns")).toMatchObject({
      label: "Anordnen: 2 nebeneinander",
      disabled: true,
      hint: "Ändert nichts",
    });
  });

  it("offers the layout patterns (#78): another tab joins the active one, it goes to the first field", () => {
    const entry = tabMenu(window, "A").find((each) => each.key === "snap:mainLeft")!;
    expect(entry).toMatchObject({ label: "Mit dem aktiven Tab anordnen: 1 + 2" });
    expect(entry.action).toEqual({
      kind: "move",
      source: { kind: "tab", tabId: "A" },
      target: { kind: "snap", pattern: "mainLeft", slot: 0 },
    });
  });

  it("disables the patterns that cannot hold all panes, with the reason", () => {
    const three = win([tab("A", pane("a"), "a"), tab("B", row("r", pane("b1"), pane("b2")), "b1")], "B");
    expect(enabled(tabMenu(three, "A")).filter((key) => key.startsWith("snap:"))).toEqual([
      "snap:mainLeft",
      "snap:mainRight",
      "snap:grid",
    ]);
    expect(tabMenu(three, "A").find((entry) => entry.key === "snap:rows")?.hint).toBe(
      "Zu wenige Felder für alle Panes",
    );
    const five = win(
      [
        tab("A", row("q", pane("a1"), pane("a2")), "a1"),
        tab("B", row("r", pane("b1"), pane("b2"), pane("b3")), "b1"),
      ],
      "B",
    );
    expect(tabMenu(five, "A").find((entry) => entry.key === "snap:grid")?.hint).toBe(
      "Höchstens 4 Panes je Tab",
    );
  });

  it("names the move of each entry", () => {
    const right = tabMenu(window, "A").find((entry) => entry.key === "right")!;
    expect(right.action).toEqual({
      kind: "move",
      source: { kind: "tab", tabId: "A" },
      target: { kind: "tabBar", beforeTabId: "C" },
    });
    const into = tabMenu(window, "A").find((entry) => entry.key === "into:bottom")!;
    expect(into.action).toEqual({
      kind: "move",
      source: { kind: "tab", tabId: "A" },
      target: { kind: "pane", paneId: "b", zone: "bottom" },
    });
  });

  it("disables the edges when the active tab has 4 panes, the center stays", () => {
    const full = win(
      [tab("A", pane("a"), "a"), tab("B", row("r", pane("b1"), pane("b2"), pane("b3"), pane("b4")), "b1")],
      "B",
    );
    const entries = tabMenu(full, "A");
    expect(enabled(entries).filter((key) => key.startsWith("into:"))).toEqual(["into:center"]);
    expect(entries.find((entry) => entry.key === "into:top")?.hint).toBe("Höchstens 4 Panes je Tab");
  });
});

describe("paneMenu", () => {
  it("offers a tab of its own, the directions with a neighbour and closing", () => {
    const window = win([tab("A", row("r", pane("a"), pane("b")), "a")], "A");
    // The pane is in the first field of a row already; the patterns that change something stay.
    expect(enabled(paneMenu(window, "a"))).toEqual([
      "toTab",
      "move:right",
      "snap:rows",
      "snap:mainRight",
      "close",
    ]);
    expect(paneMenu(window, "b").find((entry) => entry.key === "snap:columns")).toMatchObject({
      label: "Anordnen: 2 nebeneinander",
      action: {
        kind: "move",
        source: { kind: "pane", paneId: "b" },
        target: { kind: "snap", pattern: "columns", slot: 0 },
      },
    });
    expect(paneMenu(window, "b").find((entry) => entry.key === "snap:columns")?.disabled).toBeUndefined();
    expect(paneMenu(window, "a").find((entry) => entry.key === "move:right")?.action).toEqual({
      kind: "move",
      source: { kind: "pane", paneId: "a" },
      target: { kind: "swap", paneId: "b" },
    });
  });

  it("disables a tab of its own for the only pane", () => {
    const window = win([tab("A", pane("a"), "a")], "A");
    expect(paneMenu(window, "a").find((entry) => entry.key === "toTab")).toMatchObject({
      disabled: true,
      hint: "Das Pane ist schon ein eigener Tab",
    });
    expect(paneMenu(window, "x")).toEqual([]);
  });
});

describe("sessionPlaceEntries", () => {
  it("opens the session in each zone of the active pane, not in the center of its own", () => {
    const window = win([tab("A", pane("a", "s1"), "a")], "A");
    expect(enabled(sessionPlaceEntries(window, "s2"))).toEqual([
      "place:left",
      "place:right",
      "place:top",
      "place:bottom",
      "place:center",
    ]);
    expect(sessionPlaceEntries(window, "s1").find((entry) => entry.key === "place:center")).toMatchObject({
      disabled: true,
      hint: "Das aktive Pane zeigt diese Session schon",
    });
  });

  it("has no entries without an active tab", () => {
    expect(sessionPlaceEntries({ id: "w", tabs: [] }, "s1")).toEqual([]);
  });
});
