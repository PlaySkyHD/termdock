import { validateLayoutDocument } from "@termdock/protocol";
import type { LayoutPane, LayoutTab, LayoutWindow, PaneNode } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import { applyMove, canMove } from "./layout-moves.js";
import { panesOf } from "./pane-tree.js";
import {
  applySnap,
  patternRects,
  SNAP_PATTERNS,
  SNAP_REVEAL_PX,
  snapBarStep,
  dwellAnchor,
  SNAP_DWELL_SLOP_PX,
  snapFields,
  visiblePatterns,
} from "./snap-layouts.js";
import type { SnapPatternId } from "./snap-layouts.js";

const pane = (id: string, sessionId = `s-${id}`): LayoutPane => ({ kind: "pane", id, sessionId });
const split = (id: string, direction: "row" | "column", ...children: PaneNode[]): PaneNode => ({
  kind: "split",
  id,
  direction,
  children,
  sizes: children.map(() => 1 / children.length),
});
const tab = (id: string, root: PaneNode, activePaneId: string): LayoutTab => ({ id, root, activePaneId });
const win = (tabs: LayoutTab[], activeTabId: string): LayoutWindow => ({ id: "w", tabs, activeTabId });

function ids(): () => string {
  let next = 0;
  return () => `n${++next}`;
}

/** The tree without split ids and with rounded shares: what a test compares. */
type Shape = string | { d: "row" | "column"; c: Shape[]; s: number[] };
function shape(node: PaneNode): Shape {
  return node.kind === "pane"
    ? node.id
    : { d: node.direction, c: node.children.map(shape), s: node.sizes.map((size) => +size.toFixed(3)) };
}
const half = [0.5, 0.5];

/** A tab "T" with `count` panes p1..pN in a row, p1 active, plus an unrelated tab "O". */
function tabWith(count: number): LayoutWindow {
  const panes = Array.from({ length: count }, (_, index) => pane(`p${index + 1}`));
  const root = count === 1 ? panes[0]! : split("r", "row", ...panes);
  return win([tab("T", root, "p1"), tab("O", pane("o"), "o")], "T");
}

const tabOf = (window: LayoutWindow, id: string): LayoutTab => window.tabs.find((each) => each.id === id)!;
const valid = (window: LayoutWindow): boolean => validateLayoutDocument({ version: 1, windows: [window] }).ok;

describe("SNAP_PATTERNS", () => {
  it("names the five patterns with their fields, none beyond 4 panes", () => {
    expect(SNAP_PATTERNS.map((each) => [each.id, each.label, each.slots])).toEqual([
      ["columns", "2 nebeneinander", 2],
      ["rows", "2 übereinander", 2],
      ["mainLeft", "1 + 2", 3],
      ["mainRight", "2 + 1", 3],
      ["grid", "2 × 2", 4],
    ]);
  });

  it("places the fields of each pattern in reading order", () => {
    expect(patternRects("mainLeft")).toEqual([
      { x: 0, y: 0, width: 0.5, height: 1 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    ]);
    expect(patternRects("grid").map((rect) => [rect.x, rect.y])).toEqual([
      [0, 0],
      [0.5, 0],
      [0, 0.5],
      [0.5, 0.5],
    ]);
  });
});

describe("applySnap: every pattern from a tab of 1 to 4 panes", () => {
  // The last pane is dragged to field 0; the others follow in tree order, empty fields are not created. One pane
  // alone has nothing to arrange, and more panes than fields do not fit: both are refused (undefined).
  const expected: Record<number, Partial<Record<SnapPatternId, Shape>>> = {
    2: {
      columns: { d: "row", c: ["p2", "p1"], s: half },
      rows: { d: "column", c: ["p2", "p1"], s: half },
      mainLeft: { d: "row", c: ["p2", "p1"], s: half },
      mainRight: { d: "column", c: ["p2", "p1"], s: half },
      grid: { d: "row", c: ["p2", "p1"], s: half },
    },
    3: {
      mainLeft: { d: "row", c: ["p3", { d: "column", c: ["p1", "p2"], s: half }], s: half },
      mainRight: { d: "row", c: [{ d: "column", c: ["p3", "p1"], s: half }, "p2"], s: half },
      grid: { d: "column", c: [{ d: "row", c: ["p3", "p1"], s: half }, "p2"], s: half },
    },
    4: {
      grid: {
        d: "column",
        c: [
          { d: "row", c: ["p4", "p1"], s: half },
          { d: "row", c: ["p2", "p3"], s: half },
        ],
        s: half,
      },
    },
  };

  for (const count of [1, 2, 3, 4]) {
    for (const { id } of SNAP_PATTERNS) {
      const want = expected[count]?.[id];
      it(`${count} pane(s) into ${id}: ${want === undefined ? "refused" : "arranged"}`, () => {
        const window = tabWith(count);
        const next = applySnap(window, { kind: "pane", paneId: `p${count}` }, id, 0, ids());
        expect(next && shape(tabOf(next, "T").root)).toEqual(want);
        if (next) {
          expect(tabOf(next, "T").activePaneId).toBe(`p${count}`);
          expect(valid(next)).toBe(true);
        }
      });
    }
  }
});

describe("applySnap", () => {
  it("puts the dragged pane into the chosen field and the others into the rest, in order", () => {
    const window = tabWith(3);
    const next = applySnap(window, { kind: "pane", paneId: "p1" }, "mainLeft", 2, ids())!;
    expect(shape(tabOf(next, "T").root)).toEqual({
      d: "row",
      c: ["p2", { d: "column", c: ["p3", "p1"], s: half }],
      s: half,
    });
    expect(tabOf(next, "T").activePaneId).toBe("p1");
    expect(next.activeTabId).toBe("T");
  });

  it("keeps every pane with its id and session: views, roles and the input lock stay", () => {
    // Two panes of one session (the second one reads) and a third.
    const window = win(
      [tab("T", split("q", "row", pane("wr", "s1"), pane("r", "s1"), pane("x", "s2")), "wr")],
      "T",
    );
    const next = applySnap(window, { kind: "pane", paneId: "r" }, "grid", 3, ids())!;
    const before = panesOf(tabOf(window, "T").root).sort((a, b) => a.id.localeCompare(b.id));
    const after = panesOf(tabOf(next, "T").root).sort((a, b) => a.id.localeCompare(b.id));
    expect(after).toEqual(before);
    expect(valid(next)).toBe(true);
  });

  it("refuses a pattern the tab has already", () => {
    const window = win([tab("T", split("r", "row", pane("a"), pane("b")), "a")], "T");
    expect(applySnap(window, { kind: "pane", paneId: "a" }, "columns", 0, ids())).toBeUndefined();
    // The other field changes places.
    expect(
      shape(tabOf(applySnap(window, { kind: "pane", paneId: "a" }, "columns", 1, ids())!, "T").root),
    ).toEqual({ d: "row", c: ["b", "a"], s: half });
  });

  it("refuses a field that does not exist", () => {
    expect(applySnap(tabWith(2), { kind: "pane", paneId: "p1" }, "columns", 2, ids())).toBeUndefined();
    expect(applySnap(tabWith(2), { kind: "pane", paneId: "p1" }, "columns", -1, ids())).toBeUndefined();
  });

  it("arranges the active tab when it is dragged itself: its active pane goes to the field", () => {
    const window = win([tab("T", split("r", "row", pane("a"), pane("b")), "b")], "T");
    const next = applySnap(window, { kind: "tab", tabId: "T" }, "rows", 0, ids())!;
    expect(shape(tabOf(next, "T").root)).toEqual({ d: "column", c: ["b", "a"], s: half });
  });

  it("brings another tab into the active one: its panes join, it closes, its active pane is placed", () => {
    const window = win(
      [tab("A", split("r", "row", pane("a1"), pane("a2")), "a2"), tab("T", pane("t"), "t")],
      "T",
    );
    const next = applySnap(window, { kind: "tab", tabId: "A" }, "mainLeft", 0, ids())!;
    expect(next.tabs.map((each) => each.id)).toEqual(["T"]);
    expect(shape(tabOf(next, "T").root)).toEqual({
      d: "row",
      c: ["a2", { d: "column", c: ["t", "a1"], s: half }],
      s: half,
    });
    expect(tabOf(next, "T").activePaneId).toBe("a2");
    expect(valid(next)).toBe(true);
  });

  it("respects the limit of 4 panes when tabs join", () => {
    const window = win(
      [
        tab("A", split("r", "row", pane("a1"), pane("a2")), "a1"),
        tab("T", split("q", "row", pane("t1"), pane("t2"), pane("t3")), "t1"),
      ],
      "T",
    );
    for (const { id, slots } of SNAP_PATTERNS)
      for (let slot = 0; slot < slots; slot++)
        expect(applySnap(window, { kind: "tab", tabId: "A" }, id, slot, ids())).toBeUndefined();
  });

  it("refuses a session of the sidebar and a window without an active tab", () => {
    expect(applySnap(tabWith(2), { kind: "session", sessionId: "s9" }, "columns", 0, ids())).toBeUndefined();
    expect(
      applySnap({ id: "w", tabs: [] }, { kind: "tab", tabId: "T" }, "columns", 0, ids()),
    ).toBeUndefined();
  });

  it("is a move of layout-moves, so drop, menu and store agree", () => {
    const window = tabWith(2);
    const target = { kind: "snap", pattern: "rows", slot: 1 } as const;
    expect(canMove(window, { kind: "pane", paneId: "p1" }, target)).toBe(true);
    expect(shape(tabOf(applyMove(window, { kind: "pane", paneId: "p1" }, target, ids())!, "T").root)).toEqual(
      {
        d: "column",
        c: ["p2", "p1"],
        s: half,
      },
    );
  });
});

describe("snapFields", () => {
  it("names the pane of each field, marks the dragged one and leaves the rest empty", () => {
    const fields = snapFields(tabWith(2), { kind: "pane", paneId: "p2" }, "mainRight", 1)!;
    expect(fields.map((field) => [field.pane?.id, field.moved])).toEqual([
      ["p1", false],
      ["p2", true],
      [undefined, false],
    ]);
  });

  it("has no fields for a pattern too small and for a session", () => {
    expect(snapFields(tabWith(3), { kind: "pane", paneId: "p1" }, "columns", 0)).toBeUndefined();
    expect(snapFields(tabWith(2), { kind: "session", sessionId: "s" }, "columns", 0)).toBeUndefined();
  });
});

describe("visiblePatterns", () => {
  it("shows only the patterns with room for all views", () => {
    expect(visiblePatterns(tabWith(3), { kind: "pane", paneId: "p1" })).toEqual([
      "mainLeft",
      "mainRight",
      "grid",
    ]);
    expect(visiblePatterns(tabWith(2), { kind: "pane", paneId: "p1" })).toHaveLength(5);
  });

  it("shows none for a single pane alone and beyond 4 panes", () => {
    expect(visiblePatterns(tabWith(1), { kind: "pane", paneId: "p1" })).toEqual([]);
    const five = win(
      [
        tab("A", split("r", "row", pane("a1"), pane("a2")), "a1"),
        tab("T", split("q", "row", pane("t1"), pane("t2"), pane("t3")), "t1"),
      ],
      "T",
    );
    expect(visiblePatterns(five, { kind: "tab", tabId: "A" })).toEqual([]);
  });
});

describe("snapBarStep", () => {
  const area = { left: 200, top: 40, width: 800, height: 600 };
  const bar = { left: 400, top: 48, width: 400, height: 90 };

  it("waits in the strip at the top edge of the tab area before it opens, and stays open there", () => {
    expect(snapBarStep({ x: 600, y: 41 }, area, bar, false)).toBe("dwell");
    expect(snapBarStep({ x: 600, y: 41 }, area, bar, true)).toBe("open");
    expect(snapBarStep({ x: 600, y: 40 + SNAP_REVEAL_PX + 1 }, area, bar, false)).toBe("close");
  });

  it("stays closed over the tab bar above, beside the area and without the bar's box", () => {
    expect(snapBarStep({ x: 600, y: 30 }, area, bar, false)).toBe("close");
    expect(snapBarStep({ x: 100, y: 45 }, area, bar, false)).toBe("close");
    expect(snapBarStep({ x: 600, y: 41 }, area, undefined, false)).toBe("close");
  });

  it("works only within the bar's width and its margin, also in the strip", () => {
    expect(snapBarStep({ x: 390, y: 41 }, area, bar, false)).toBe("dwell");
    expect(snapBarStep({ x: 380, y: 41 }, area, bar, false)).toBe("close");
    expect(snapBarStep({ x: 380, y: 41 }, area, bar, true)).toBe("close");
    expect(snapBarStep({ x: 815, y: 41 }, area, bar, true)).toBe("open");
    expect(snapBarStep({ x: 820, y: 41 }, area, bar, true)).toBe("close");
  });

  it("stays open over the open bar and its sides, and closes right below it for the zones of the panes", () => {
    expect(snapBarStep({ x: 500, y: 130 }, area, bar, true)).toBe("open");
    expect(snapBarStep({ x: 390, y: 100 }, area, bar, true)).toBe("open");
    expect(snapBarStep({ x: 500, y: 130 }, area, bar, false)).toBe("close");
    expect(snapBarStep({ x: 500, y: 139 }, area, bar, true)).toBe("close");
    expect(snapBarStep({ x: 370, y: 100 }, area, bar, true)).toBe("close");
  });
});

describe("dwellAnchor", () => {
  it("keeps the anchor while the pointer rests within the slop, so the wait goes on", () => {
    const anchor = dwellAnchor(undefined, { x: 500, y: 50 });
    expect(anchor).toEqual({ x: 500, y: 50 });
    expect(dwellAnchor(anchor, { x: 500 + SNAP_DWELL_SLOP_PX, y: 50 })).toBe(anchor);
    expect(dwellAnchor(anchor, { x: 502, y: 52 })).toBe(anchor);
  });

  it("moves the anchor, restarting the wait, as soon as the pointer moves farther", () => {
    const anchor = { x: 500, y: 50 };
    const moved = dwellAnchor(anchor, { x: 500 + SNAP_DWELL_SLOP_PX + 1, y: 50 });
    expect(moved).not.toBe(anchor);
    expect(moved).toEqual({ x: 505, y: 50 });
  });

  it("never rests while the pointer moves through the strip step by step", () => {
    let anchor: { x: number; y: number } | undefined;
    const restarts = [0, 6, 12, 18, 24].map((dx) => {
      const next = dwellAnchor(anchor, { x: 400 + dx, y: 50 });
      const restarted = next !== anchor;
      anchor = next;
      return restarted;
    });
    expect(restarts).toEqual([true, true, true, true, true]);
  });
});
