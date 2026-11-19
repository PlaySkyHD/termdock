import type { PaneNode } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import { claimsAfterRestart, layoutPanes, layoutWindow, takesInput } from "./pane-layout.js";

describe("claimsAfterRestart (#130)", () => {
  it("lets only a pane that existed before the restart take the writer", () => {
    expect(claimsAfterRestart(0, 1)).toBe(true);
    expect(claimsAfterRestart(2, 3)).toBe(true);
  });

  it("does not let a pane created after the restart, or the first start, take it", () => {
    expect(claimsAfterRestart(undefined, 1)).toBe(false);
    expect(claimsAfterRestart(1, 1)).toBe(false);
    expect(claimsAfterRestart(undefined, 0)).toBe(false);
  });
});

describe("takesInput (#66: the input moves only on request)", () => {
  const down = { x: 100, y: 50 };

  it("does not take the input on a single click into a reading pane: it only becomes active", () => {
    expect(takesInput("reader", down, { x: 102, y: 49, detail: 1 })).toBe(false);
  });

  it("takes the input on a double click into a reading pane, although it selects a word", () => {
    expect(takesInput("reader", down, { x: 101, y: 50, detail: 2 })).toBe(true);
  });

  it("never claims for a pane that writes, connects or lost the core", () => {
    for (const role of ["writer", "connecting", "closed", "error", undefined] as const)
      expect(takesInput(role, down, { x: 100, y: 50, detail: 2 }), String(role)).toBe(false);
  });

  it("does not take the input after dragging to select text or without a press in the pane", () => {
    expect(takesInput("reader", down, { x: 160, y: 50, detail: 2 })).toBe(false);
    expect(takesInput("reader", undefined, { x: 100, y: 50, detail: 2 })).toBe(false);
  });

  it("does not take the input again on a triple click", () => {
    expect(takesInput("reader", down, { x: 100, y: 50, detail: 3 })).toBe(false);
  });
});

const pane = (id: string): PaneNode => ({ kind: "pane", id, sessionId: `s-${id}` });

describe("layoutPanes", () => {
  it("gives a single pane the whole tab", () => {
    expect(layoutPanes(pane("a"))).toEqual({
      panes: [{ paneId: "a", sessionId: "s-a", rect: { x: 0, y: 0, width: 1, height: 1 } }],
      dividers: [],
    });
  });

  it("places the children of a row side by side with a divider at each inner border", () => {
    const root: PaneNode = {
      kind: "split",
      id: "r",
      direction: "row",
      children: [pane("a"), pane("b"), pane("c")],
      sizes: [0.5, 0.25, 0.25],
    };

    const { panes, dividers } = layoutPanes(root);

    expect(panes.map((each) => [each.paneId, each.rect])).toEqual([
      ["a", { x: 0, y: 0, width: 0.5, height: 1 }],
      ["b", { x: 0.5, y: 0, width: 0.25, height: 1 }],
      ["c", { x: 0.75, y: 0, width: 0.25, height: 1 }],
    ]);
    expect(dividers).toEqual([
      { splitId: "r", index: 0, direction: "row", position: 0.5, split: { x: 0, y: 0, width: 1, height: 1 } },
      {
        splitId: "r",
        index: 1,
        direction: "row",
        position: 0.75,
        split: { x: 0, y: 0, width: 1, height: 1 },
      },
    ]);
  });

  it("nests a column inside a row", () => {
    const root: PaneNode = {
      kind: "split",
      id: "r",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        pane("a"),
        {
          kind: "split",
          id: "c",
          direction: "column",
          sizes: [0.25, 0.75],
          children: [pane("b"), pane("d")],
        },
      ],
    };

    const { panes, dividers } = layoutPanes(root);

    expect(panes.map((each) => [each.paneId, each.rect])).toEqual([
      ["a", { x: 0, y: 0, width: 0.5, height: 1 }],
      ["b", { x: 0.5, y: 0, width: 0.5, height: 0.25 }],
      ["d", { x: 0.5, y: 0.25, width: 0.5, height: 0.75 }],
    ]);
    expect(dividers[1]).toEqual({
      splitId: "c",
      index: 0,
      direction: "column",
      position: 0.25,
      split: { x: 0.5, y: 0, width: 0.5, height: 1 },
    });
  });
});

describe("layoutWindow (#67: one flat list for all tabs)", () => {
  const split: PaneNode = {
    kind: "split",
    id: "r",
    direction: "row",
    children: [
      { kind: "pane", id: "b1", sessionId: "s2" },
      { kind: "pane", id: "b2", sessionId: "s3" },
    ],
    sizes: [0.5, 0.5],
  };
  const tabs = [
    { id: "A", root: { kind: "pane", id: "a", sessionId: "s1" } as PaneNode, activePaneId: "a" },
    { id: "B", root: split, activePaneId: "b1" },
  ];

  it("lists the panes of every tab, tabs in order and each in tree order, with their tab", () => {
    const { panes } = layoutWindow(tabs, "B");

    expect(panes.map((pane) => [pane.paneId, pane.tabId, pane.tabActive])).toEqual([
      ["a", "A", false],
      ["b1", "B", true],
      ["b2", "B", true],
    ]);
    expect(panes[0]!.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(panes[2]!.rect).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
  });

  it("lists the dividers with their tab", () => {
    expect(layoutWindow(tabs, "A").dividers).toMatchObject([{ splitId: "r", tabId: "B", tabActive: false }]);
  });
});
