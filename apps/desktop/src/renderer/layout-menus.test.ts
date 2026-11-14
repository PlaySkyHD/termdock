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
      "close",
    ]);
    const left = tabMenu(window, "A").find((entry) => entry.key === "left");
    expect(left).toMatchObject({ disabled: true, hint: "Schon ganz links" });
  });

  it("offers no zones for the active tab itself", () => {
    expect(enabled(tabMenu(window, "B"))).toEqual(["left", "right", "close"]);
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
    expect(enabled(paneMenu(window, "a"))).toEqual(["toTab", "move:right", "close"]);
    expect(paneMenu(window, "a").find((entry) => entry.key === "move:right")?.action).toEqual({
      kind: "move",
      source: { kind: "pane", paneId: "a" },
      target: { kind: "pane", paneId: "b", zone: "right" },
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
