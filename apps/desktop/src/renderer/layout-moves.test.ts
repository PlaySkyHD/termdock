import { validateLayoutDocument } from "@termdock/protocol";
import type { LayoutPane, LayoutTab, LayoutWindow, PaneNode } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import { applyMove, canMove, paneStepTarget, tabStepTarget } from "./layout-moves.js";
import type { MoveSource, MoveTarget } from "./layout-moves.js";

const pane = (id: string, sessionId = `s-${id}`): LayoutPane => ({ kind: "pane", id, sessionId });
const row = (id: string, ...children: PaneNode[]): PaneNode => ({
  kind: "split",
  id,
  direction: "row",
  children,
  sizes: children.map(() => 1 / children.length),
});
const column = (id: string, ...children: PaneNode[]): PaneNode => ({
  ...(row(id, ...children) as Extract<PaneNode, { kind: "split" }>),
  direction: "column",
});
const tab = (id: string, root: PaneNode, activePaneId = firstId(root)): LayoutTab => ({
  id,
  root,
  activePaneId,
});
const firstId = (node: PaneNode): string => (node.kind === "pane" ? node.id : firstId(node.children[0]!));
const win = (tabs: LayoutTab[], activeTabId = tabs[0]?.id): LayoutWindow => ({
  id: "w",
  sidebarVisible: true,
  tabs,
  ...(activeTabId === undefined ? {} : { activeTabId }),
});

/** Ids the move hands out, in order. */
function ids(): () => string {
  let next = 0;
  return () => `n${++next}`;
}

const move = (window: LayoutWindow, source: MoveSource, target: MoveTarget) =>
  applyMove(window, source, target, ids());
const order = (window: LayoutWindow | undefined): string[] => window?.tabs.map((each) => each.id) ?? [];
const valid = (window: LayoutWindow | undefined): boolean =>
  window !== undefined && validateLayoutDocument({ version: 1, windows: [window] }).ok;

describe("applyMove: reordering tabs", () => {
  const three = win([tab("A", pane("a")), tab("B", pane("b")), tab("C", pane("c"))]);

  it("moves a tab before another one and makes it active", () => {
    const after = move(three, { kind: "tab", tabId: "C" }, { kind: "tabBar", beforeTabId: "A" });
    expect(order(after)).toEqual(["C", "A", "B"]);
    expect(after?.activeTabId).toBe("C");
  });

  it("moves a tab to the end", () => {
    expect(order(move(three, { kind: "tab", tabId: "A" }, { kind: "tabBar" }))).toEqual(["B", "C", "A"]);
  });

  it("refuses a move that leaves the order as it is, and an unknown tab", () => {
    expect(move(three, { kind: "tab", tabId: "A" }, { kind: "tabBar", beforeTabId: "A" })).toBeUndefined();
    expect(move(three, { kind: "tab", tabId: "A" }, { kind: "tabBar", beforeTabId: "B" })).toBeUndefined();
    expect(move(three, { kind: "tab", tabId: "C" }, { kind: "tabBar" })).toBeUndefined();
    expect(move(three, { kind: "tab", tabId: "X" }, { kind: "tabBar" })).toBeUndefined();
    expect(move(three, { kind: "tab", tabId: "A" }, { kind: "tabBar", beforeTabId: "X" })).toBeUndefined();
  });

  it("names the targets of a step to the left and right, none at the edges", () => {
    expect(tabStepTarget(three, "B", -1)).toEqual({ kind: "tabBar", beforeTabId: "A" });
    expect(tabStepTarget(three, "A", 1)).toEqual({ kind: "tabBar", beforeTabId: "C" });
    expect(tabStepTarget(three, "B", 1)).toEqual({ kind: "tabBar" });
    expect(tabStepTarget(three, "A", -1)).toBeUndefined();
    expect(tabStepTarget(three, "C", 1)).toBeUndefined();
    expect(order(move(three, { kind: "tab", tabId: "A" }, tabStepTarget(three, "A", 1)!))).toEqual([
      "B",
      "A",
      "C",
    ]);
  });
});

describe("applyMove: a tab onto a pane", () => {
  const two = win([tab("A", pane("a")), tab("B", pane("b"))], "B");

  it.each([
    ["left", "row", ["a", "b"]],
    ["right", "row", ["b", "a"]],
    ["top", "column", ["a", "b"]],
    ["bottom", "column", ["b", "a"]],
  ] as const)("splits the pane at the %s edge: %s with %j", (zone, direction, children) => {
    const after = move(two, { kind: "tab", tabId: "A" }, { kind: "pane", paneId: "b", zone });
    expect(order(after)).toEqual(["B"]);
    expect(after?.activeTabId).toBe("B");
    const root = after!.tabs[0]!.root;
    expect(root).toMatchObject({ kind: "split", direction, sizes: [0.5, 0.5] });
    expect(root.kind === "split" && root.children.map((child) => child.id)).toEqual(children);
    // The moved view is the active pane, and it is the same pane (same id): no new view.
    expect(after!.tabs[0]!.activePaneId).toBe("a");
    expect(valid(after)).toBe(true);
  });

  it("replaces the view of the pane in the center", () => {
    const window = win([tab("A", pane("a")), tab("B", row("r", pane("b"), pane("c")))], "B");
    const after = move(window, { kind: "tab", tabId: "A" }, { kind: "pane", paneId: "c", zone: "center" });
    expect(after?.tabs).toEqual([tab("B", row("r", pane("b"), pane("a")), "a")]);
  });

  it("moves the whole tree of a tab with several panes and keeps its active pane", () => {
    const window = win([tab("A", column("k", pane("a1"), pane("a2")), "a2"), tab("B", pane("b"))], "B");
    const after = move(window, { kind: "tab", tabId: "A" }, { kind: "pane", paneId: "b", zone: "right" });
    expect(after?.tabs[0]).toEqual(
      tab("B", { ...row("n1", pane("b"), column("k", pane("a1"), pane("a2"))) }, "a2"),
    );
  });

  it("merges a tree of the same direction into the split it lands in", () => {
    const window = win([tab("A", row("k", pane("a1"), pane("a2"))), tab("B", pane("b"))], "B");
    const after = move(window, { kind: "tab", tabId: "A" }, { kind: "pane", paneId: "b", zone: "right" });
    const root = after!.tabs[0]!.root;
    expect(root.kind === "split" && root.children.map((child) => child.id)).toEqual(["b", "a1", "a2"]);
    expect(root.kind === "split" && root.sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it("allows only the center when the edges would give more than 4 panes", () => {
    const full = win(
      [tab("A", pane("a")), tab("B", row("r", pane("b1"), pane("b2"), pane("b3"), pane("b4")))],
      "B",
    );
    for (const zone of ["left", "right", "top", "bottom"] as const)
      expect(canMove(full, { kind: "tab", tabId: "A" }, { kind: "pane", paneId: "b1", zone })).toBe(false);
    const after = move(full, { kind: "tab", tabId: "A" }, { kind: "pane", paneId: "b1", zone: "center" });
    expect(after && after.tabs[0]!.root.kind === "split" && after.tabs[0]!.root.children.length).toBe(4);
    expect(valid(after)).toBe(true);
    // Two panes into three: not even the center (3 - 1 + 2 = 4 is fine, 4 - 1 + 2 is not).
    const pair = win([tab("A", row("k", pane("a1"), pane("a2"))), full.tabs[1]!], "B");
    expect(canMove(pair, { kind: "tab", tabId: "A" }, { kind: "pane", paneId: "b1", zone: "center" })).toBe(
      false,
    );
  });

  it("refuses a tab onto one of its own panes", () => {
    expect(canMove(two, { kind: "tab", tabId: "B" }, { kind: "pane", paneId: "b", zone: "left" })).toBe(
      false,
    );
    expect(canMove(two, { kind: "tab", tabId: "B" }, { kind: "pane", paneId: "b", zone: "center" })).toBe(
      false,
    );
  });
});

describe("applyMove: a pane", () => {
  it("moves a pane within its tab without a new view and makes it active", () => {
    const window = win([tab("A", row("r", pane("a"), pane("b"), pane("c")), "a")]);
    const after = move(window, { kind: "pane", paneId: "c" }, { kind: "pane", paneId: "a", zone: "top" });
    expect(after?.tabs[0]).toEqual(tab("A", row("r", column("n1", pane("c"), pane("a")), pane("b")), "c"));
    expect(valid(after)).toBe(true);
  });

  it("swaps two panes by a step in a direction, none at the edge", () => {
    const window = win([tab("A", row("r", pane("a"), pane("b")))]);
    const target = paneStepTarget(window.tabs[0]!, "b", "left");
    expect(target).toEqual({ kind: "pane", paneId: "a", zone: "left" });
    const after = move(window, { kind: "pane", paneId: "b" }, target!);
    expect(after?.tabs[0]?.root).toMatchObject({ kind: "split", direction: "row" });
    const root = after!.tabs[0]!.root;
    expect(root.kind === "split" && root.children.map((child) => child.id)).toEqual(["b", "a"]);
    expect(paneStepTarget(window.tabs[0]!, "a", "left")).toBeUndefined();
    expect(paneStepTarget(window.tabs[0]!, "a", "up")).toBeUndefined();
  });

  it("replaces another pane of its tab in the center", () => {
    const window = win([tab("A", row("r", pane("a"), pane("b"), pane("c")))]);
    const after = move(window, { kind: "pane", paneId: "c" }, { kind: "pane", paneId: "a", zone: "center" });
    const root = after!.tabs[0]!.root;
    expect(root.kind === "split" && root.children.map((child) => child.id)).toEqual(["c", "b"]);
    expect(root.kind === "split" && root.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1);
  });

  it("refuses a pane onto itself", () => {
    const window = win([tab("A", row("r", pane("a"), pane("b")))]);
    for (const zone of ["left", "center"] as const)
      expect(canMove(window, { kind: "pane", paneId: "a" }, { kind: "pane", paneId: "a", zone })).toBe(false);
  });

  it("pulls a pane out into a tab of its own before a tab, which becomes active", () => {
    const window = win([tab("A", row("r", pane("a"), pane("b")), "b"), tab("B", pane("x"))]);
    const after = move(window, { kind: "pane", paneId: "b" }, { kind: "tabBar", beforeTabId: "B" });
    expect(after?.tabs).toEqual([tab("A", pane("a")), tab("n1", pane("b")), tab("B", pane("x"))]);
    expect(after?.activeTabId).toBe("n1");
    expect(valid(after)).toBe(true);
  });

  it("closes the tab whose last pane is pulled out (a move of the tab)", () => {
    const window = win([tab("A", pane("a")), tab("B", pane("x"))]);
    const after = move(window, { kind: "pane", paneId: "a" }, { kind: "tabBar" });
    expect(after?.tabs).toEqual([tab("B", pane("x")), tab("A", pane("a"))]);
  });

  it("closes the tab whose last pane moves into another tab", () => {
    const window = win([tab("A", pane("a")), tab("B", pane("x"))], "B");
    const after = move(window, { kind: "pane", paneId: "a" }, { kind: "pane", paneId: "x", zone: "left" });
    expect(order(after)).toEqual(["B"]);
    expect(after?.tabs[0]).toEqual(tab("B", row("n1", pane("a"), pane("x")), "a"));
  });

  it("pulls out no pane at the limit of tabs", () => {
    const many = Array.from({ length: 63 }, (_, index) => tab(`T${index}`, pane(`p${index}`)));
    const window = win([tab("A", row("r", pane("a"), pane("b"))), ...many]);
    expect(canMove(window, { kind: "pane", paneId: "b" }, { kind: "tabBar" })).toBe(false);
  });

  it("refuses a pane onto an edge of another full tab, but replaces in its center", () => {
    const full = tab("B", row("r", pane("b1"), pane("b2"), pane("b3"), pane("b4")));
    const window = win([tab("A", row("k", pane("a1"), pane("a2"))), full]);
    expect(
      canMove(window, { kind: "pane", paneId: "a1" }, { kind: "pane", paneId: "b1", zone: "left" }),
    ).toBe(false);
    expect(
      canMove(window, { kind: "pane", paneId: "a1" }, { kind: "pane", paneId: "b1", zone: "center" }),
    ).toBe(true);
  });
});

describe("applyMove: a session of the sidebar onto a pane", () => {
  it("opens a new view in a new, active pane", () => {
    const window = win([tab("A", pane("a", "s1"))]);
    const after = move(
      window,
      { kind: "session", sessionId: "s2" },
      { kind: "pane", paneId: "a", zone: "left" },
    );
    expect(after?.tabs[0]).toEqual(tab("A", row("n2", pane("n1", "s2"), pane("a", "s1")), "n1"));
  });

  it("keeps the writing pane active when the new view shows its own session (it reads)", () => {
    const window = win([tab("A", pane("a", "s1"))]);
    const after = move(
      window,
      { kind: "session", sessionId: "s1" },
      { kind: "pane", paneId: "a", zone: "right" },
    );
    expect(after?.tabs[0]?.activePaneId).toBe("a");
  });

  it("replaces the view in the center, but not with its own session", () => {
    const window = win([tab("A", pane("a", "s1"))]);
    const target = { kind: "pane", paneId: "a", zone: "center" } as const;
    expect(move(window, { kind: "session", sessionId: "s2" }, target)?.tabs[0]).toEqual(
      tab("A", pane("n1", "s2")),
    );
    expect(canMove(window, { kind: "session", sessionId: "s1" }, target)).toBe(false);
  });

  it("splits no full tab and drops nothing on the tab bar", () => {
    const window = win([tab("A", row("r", pane("a"), pane("b"), pane("c"), pane("d")))]);
    expect(
      canMove(window, { kind: "session", sessionId: "s9" }, { kind: "pane", paneId: "a", zone: "top" }),
    ).toBe(false);
    expect(canMove(window, { kind: "session", sessionId: "s9" }, { kind: "tabBar" })).toBe(false);
  });

  it("ignores an unknown pane", () => {
    const window = win([tab("A", pane("a"))]);
    expect(
      canMove(window, { kind: "session", sessionId: "s9" }, { kind: "pane", paneId: "x", zone: "top" }),
    ).toBe(false);
  });
});
