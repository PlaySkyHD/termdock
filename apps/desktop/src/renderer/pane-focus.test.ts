import type { PaneNode } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import { neighborPane } from "./pane-focus.js";

const pane = (id: string): PaneNode => ({ kind: "pane", id, sessionId: `s-${id}` });
const split = (id: string, direction: "row" | "column", ...children: PaneNode[]): PaneNode => ({
  kind: "split",
  id,
  direction,
  children,
  sizes: children.map(() => 1 / children.length),
});

describe("neighborPane", () => {
  it("moves between two panes side by side", () => {
    const root = split("s", "row", pane("a"), pane("b"));

    expect(neighborPane(root, "a", "right")).toBe("b");
    expect(neighborPane(root, "b", "left")).toBe("a");
  });

  it("stays put at the edge and in a single pane", () => {
    const root = split("s", "row", pane("a"), pane("b"));

    expect(neighborPane(root, "a", "left")).toBeUndefined();
    expect(neighborPane(root, "a", "up")).toBeUndefined();
    expect(neighborPane(pane("only"), "only", "right")).toBeUndefined();
  });

  it("moves between panes above and below", () => {
    const root = split("s", "column", pane("a"), pane("b"));

    expect(neighborPane(root, "a", "down")).toBe("b");
    expect(neighborPane(root, "b", "up")).toBe("a");
    expect(neighborPane(root, "a", "right")).toBeUndefined();
  });

  it("walks through three columns one pane at a time", () => {
    const root = split("s", "row", pane("a"), pane("b"), pane("c"));

    expect(neighborPane(root, "a", "right")).toBe("b");
    expect(neighborPane(root, "b", "right")).toBe("c");
    expect(neighborPane(root, "c", "left")).toBe("b");
  });

  it("picks the first of two equally close neighbours, and from the small side the one that faces it", () => {
    // a | (b over c): both face a equally, the first in tree order wins.
    const root = split("s", "row", pane("a"), split("t", "column", pane("b"), pane("c")));

    expect(neighborPane(root, "b", "left")).toBe("a");
    expect(neighborPane(root, "c", "left")).toBe("a");
    expect(neighborPane(root, "a", "right")).toBe("b");
  });

  it("remembers nothing but geometry: 2x2 grid", () => {
    const root = split(
      "s",
      "column",
      split("top", "row", pane("a"), pane("b")),
      split("bottom", "row", pane("c"), pane("d")),
    );

    expect(neighborPane(root, "a", "down")).toBe("c");
    expect(neighborPane(root, "d", "up")).toBe("b");
    expect(neighborPane(root, "d", "left")).toBe("c");
    expect(neighborPane(root, "b", "right")).toBeUndefined();
  });

  it("returns undefined for an unknown pane", () => {
    expect(neighborPane(pane("a"), "x", "left")).toBeUndefined();
  });
});
