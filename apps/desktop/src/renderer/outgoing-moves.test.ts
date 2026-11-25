import type { LayoutWindow } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import type { ClientPoint, TransferItem } from "../shared/bridge.js";
import { OutgoingMoves } from "./outgoing-moves.js";

const window: LayoutWindow = {
  id: "w",
  tabs: [
    { id: "A", root: { kind: "pane", id: "a", sessionId: "s1" }, activePaneId: "a" },
    { id: "B", root: { kind: "pane", id: "b", sessionId: "s2" }, activePaneId: "b" },
  ],
  activeTabId: "A",
};

function setup() {
  const calls: unknown[][] = [];
  const frames: Array<() => void> = [];
  let builds = 0;
  const moves = new OutgoingMoves({
    window: () => {
      builds += 1;
      return window;
    },
    viewOf: (paneId) => `v-${paneId}`,
    api: {
      transferHover: async (item: TransferItem, at: ClientPoint) => void calls.push(["hover", item.kind, at]),
      transferHoverEnd: async () => void calls.push(["end"]),
      transferDrop: async (item: TransferItem, at: ClientPoint, whole: boolean) =>
        void calls.push(["drop", item.kind, at, whole]),
    },
    frame: (run) => {
      frames.push(run);
      return () => frames.splice(frames.indexOf(run), 1);
    },
  });
  return { moves, calls, frames, builds: () => builds };
}

describe("OutgoingMoves (#68)", () => {
  const tab = { kind: "tab", id: "A", label: "Build" };

  it("lets tabs and panes leave the window, nothing else", () => {
    const { moves } = setup();
    expect(moves.leaves(tab)).toBe(true);
    expect(moves.leaves({ kind: "pane", id: "b" })).toBe(true);
    expect(moves.leaves({ kind: "session", id: "s1" })).toBe(false);
    expect(moves.leaves({ kind: "tab", id: "X" })).toBe(false);
  });

  it("sends at most one hover per frame, with the latest point, and builds the item once per drag", () => {
    const { moves, calls, frames, builds } = setup();
    moves.leaves(tab);
    moves.hover(tab, -10, 5);
    moves.hover(tab, -20, 6);
    moves.hover(tab, -30, 7);
    expect(calls).toEqual([]);
    frames.shift()!();

    expect(calls).toEqual([["hover", "tab", { x: -30, y: 7 }]]);
    expect(builds()).toBe(1);
  });

  it("drops a waiting hover when the drag comes back or ends, and hands the drop over with `whole`", () => {
    const { moves, calls, frames } = setup();
    moves.hover(tab, -10, 5);
    moves.end();
    moves.drop(tab, -40, 8);

    expect(frames).toEqual([]);
    expect(calls).toEqual([["end"], ["drop", "tab", { x: -40, y: 8 }, false]]);
  });

  it("builds the item anew for the next drag", () => {
    const { moves, builds } = setup();
    moves.leaves(tab);
    moves.drop(tab, 0, 0);
    moves.leaves({ ...tab });
    expect(builds()).toBe(2);
  });
});
