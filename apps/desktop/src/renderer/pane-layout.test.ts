import type { PaneNode } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import { isClick, layoutPanes } from "./pane-layout.js";

describe("isClick", () => {
  const down = { x: 100, y: 50 };

  it("is a click when the pointer stays put and nothing is selected", () => {
    expect(isClick(down, { x: 102, y: 49, detail: 1, selecting: false })).toBe(true);
  });

  it("is no click after dragging to select text", () => {
    expect(isClick(down, { x: 160, y: 50, detail: 1, selecting: false })).toBe(false);
  });

  it("is no click when the terminal has a selection (double click selects a word)", () => {
    expect(isClick(down, { x: 100, y: 50, detail: 2, selecting: false })).toBe(false);
    expect(isClick(down, { x: 100, y: 50, detail: 1, selecting: true })).toBe(false);
  });

  it("is no click without a press in the pane", () => {
    expect(isClick(undefined, { x: 100, y: 50, detail: 1, selecting: false })).toBe(false);
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
