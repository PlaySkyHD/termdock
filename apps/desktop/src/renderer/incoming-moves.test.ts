import { describe, expect, it } from "vitest";
import type { TransferItem, TransferPane } from "../shared/bridge.js";
import { ANSWERED_KEEP_MS, IncomingMoves, isTransferEvent, TransferInbox } from "./incoming-moves.js";
import type { TransferEvent } from "./incoming-moves.js";
import { UiStore } from "./ui-store.js";

const item: TransferItem = {
  kind: "tab",
  tab: {
    id: "A",
    root: {
      kind: "split",
      id: "r",
      direction: "row",
      children: [
        { kind: "pane", id: "a", sessionId: "s1" },
        { kind: "pane", id: "b", sessionId: "s2" },
      ],
      sizes: [0.5, 0.5],
    },
    activePaneId: "a",
  },
  views: [],
};

function setup() {
  let next = 0;
  const store = new UiStore({ newId: () => `id${++next}` });
  store.openSession("s0");
  const answers: Array<[string, TransferPane[] | undefined]> = [];
  const timers: Array<{ run: () => void; ms: number; stopped: boolean }> = [];
  const moves = new IncomingMoves({
    store,
    answer: (id, views) => answers.push([id, views]),
    schedule: (run, ms) => {
      const timer = { run, ms, stopped: false };
      timers.push(timer);
      return () => void (timer.stopped = true);
    },
  });
  /** The new panes of the move by their source pane. */
  const newPanes = (): Record<string, string> => {
    const tab = store.getState().window.tabs.at(-1)!;
    const root = tab.root.kind === "split" ? tab.root.children : [tab.root];
    return Object.fromEntries(root.map((pane, index) => [["a", "b"][index]!, pane.id]));
  };
  const sessions = (): string[] =>
    store
      .getState()
      .window.tabs.flatMap((tab) =>
        tab.root.kind === "split"
          ? tab.root.children.map((pane) => (pane as { sessionId: string }).sessionId)
          : [tab.root.sessionId],
      );
  return { store, moves, answers, timers, newPanes, sessions };
}

describe("IncomingMoves (#68)", () => {
  it("answers with the new view of each source pane once every pane has attached or shows a placeholder", () => {
    const { moves, answers, newPanes, sessions } = setup();
    moves.receive("t1", item, { kind: "tabBar" });
    expect(sessions()).toEqual(["s0", "s1", "s2"]);
    const panes = newPanes();

    moves.settle(panes["a"]!, { viewId: "w1" });
    expect(answers).toEqual([]);
    moves.settle(panes["b"]!, {});

    expect(answers).toEqual([["t1", [{ paneId: "a", viewId: "w1" }, { paneId: "b" }]]]);
  });

  it("answers for a tab whose sessions all ended: every pane a placeholder, none refused (review PR #190)", () => {
    const { moves, answers, newPanes } = setup();
    moves.receive("t1", item, { kind: "tabBar" });
    const panes = newPanes();
    moves.settle(panes["a"]!, {});
    moves.settle(panes["b"]!, {});

    expect(answers).toEqual([["t1", [{ paneId: "a" }, { paneId: "b" }]]]);
  });

  it("refuses at once without a valid target, and changes nothing", () => {
    const { moves, answers, sessions } = setup();
    moves.receive("t1", item, undefined);
    moves.receive("t2", item, { kind: "pane", paneId: "nope", zone: "left" });
    expect(answers).toEqual([
      ["t1", undefined],
      ["t2", undefined],
    ]);
    expect(sessions()).toEqual(["s0"]);
  });

  it("takes the panes out again and refuses when one of them could not attach", () => {
    const { moves, answers, newPanes, sessions } = setup();
    moves.receive("t1", item, { kind: "tabBar" });
    const panes = newPanes();
    moves.settle(panes["a"]!, { viewId: "w1" });
    moves.settle(panes["b"]!, { failed: true });

    expect(answers).toEqual([["t1", undefined]]);
    expect(sessions()).toEqual(["s0"]);
  });

  it("takes the panes out when the main process cancels, before or after the answer", () => {
    const before = setup();
    before.moves.receive("t1", item, { kind: "tabBar" });
    before.moves.cancel("t1");
    expect(before.sessions()).toEqual(["s0"]);

    const after = setup();
    after.moves.receive("t1", item, { kind: "tabBar" });
    const panes = after.newPanes();
    after.moves.settle(panes["a"]!, { viewId: "w1" });
    after.moves.settle(panes["b"]!, { viewId: "w2" });
    after.moves.cancel("t1");
    expect(after.sessions()).toEqual(["s0"]);
    expect(after.timers[0]).toMatchObject({ ms: ANSWERED_KEEP_MS, stopped: true });
  });

  it("forgets an answered move after a while: a late cancel changes nothing", () => {
    const { moves, newPanes, sessions, timers } = setup();
    moves.receive("t1", item, { kind: "tabBar" });
    const panes = newPanes();
    moves.settle(panes["a"]!, { viewId: "w1" });
    moves.settle(panes["b"]!, { viewId: "w2" });
    timers[0]!.run();
    moves.cancel("t1");
    expect(sessions()).toEqual(["s0", "s1", "s2"]);
  });

  it("ignores panes of no move and a second delivery of the same move", () => {
    const { moves, answers, sessions } = setup();
    moves.settle("other", { viewId: "x" });
    moves.receive("t1", item, { kind: "tabBar" });
    moves.receive("t1", item, { kind: "tabBar" });
    expect(answers).toEqual([]);
    expect(sessions()).toEqual(["s0", "s1", "s2"]);
  });
});

describe("TransferInbox (#68)", () => {
  const hover = (x: number): TransferEvent => ({ kind: "transferHover", hover: { item, x, y: 0 } });

  it("holds the events until a handler listens, keeping only the last hover", () => {
    const inbox = new TransferInbox();
    const seen: TransferEvent[] = [];
    inbox.push(hover(1));
    inbox.push({ kind: "transferIn", transferId: "t1", item });
    inbox.push(hover(2));

    const stop = inbox.listen((event) => seen.push(event));
    inbox.push({ kind: "transferCancel", transferId: "t1" });
    stop();
    inbox.push({ kind: "transferOut", source: { kind: "tab", tabId: "A" } });

    expect(seen).toEqual([
      { kind: "transferIn", transferId: "t1", item },
      hover(2),
      { kind: "transferCancel", transferId: "t1" },
    ]);
  });

  it("knows the events of moves", () => {
    expect(isTransferEvent({ kind: "transferIn", transferId: "t", item })).toBe(true);
    expect(isTransferEvent({ kind: "coreRestarted" })).toBe(false);
  });
});
