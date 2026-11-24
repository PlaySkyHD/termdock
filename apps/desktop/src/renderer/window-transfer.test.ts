import { validateLayoutDocument } from "@termdock/protocol";
import type { LayoutPane, LayoutTab, LayoutWindow, PaneNode } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import type { TransferItem } from "../shared/bridge.js";
import { panesOf } from "./pane-tree.js";
import {
  applyIncoming,
  INCOMING_KIND,
  incomingLabel,
  incomingPayload,
  incomingTarget,
  outgoingItem,
  settleIncoming,
  startIncoming,
  takeOut,
  transferItem,
  withoutIncoming,
  withoutTab,
} from "./window-transfer.js";

const pane = (id: string, sessionId = `s-${id}`): LayoutPane => ({ kind: "pane", id, sessionId });
const row = (id: string, ...children: PaneNode[]): PaneNode => ({
  kind: "split",
  id,
  direction: "row",
  children,
  sizes: children.map(() => 1 / children.length),
});
const tab = (id: string, root: PaneNode, activePaneId = panesOf(root)[0]!.id): LayoutTab => ({
  id,
  root,
  activePaneId,
});
const win = (tabs: LayoutTab[], activeTabId = tabs[0]?.id): LayoutWindow => ({
  id: "w",
  sidebarVisible: true,
  tabs,
  ...(activeTabId === undefined ? {} : { activeTabId }),
});
function ids(): () => string {
  let next = 0;
  return () => `n${++next}`;
}
const valid = (window: LayoutWindow): boolean => validateLayoutDocument({ version: 1, windows: [window] }).ok;
const views: Record<string, string> = { a: "v-a", b: "v-b", c: "v-c" };
const viewOf = (paneId: string): string | undefined => views[paneId];

describe("transferItem", () => {
  const source = win([tab("A", row("r", pane("a"), pane("b")), "b"), tab("C", pane("c"))], "A");

  it("takes a tab with its tree and the views of its panes", () => {
    const taken = transferItem(source, { kind: "tab", tabId: "A" }, viewOf);
    expect(taken).toEqual({
      item: {
        kind: "tab",
        tab: source.tabs[0],
        views: [
          { paneId: "a", viewId: "v-a" },
          { paneId: "b", viewId: "v-b" },
        ],
      },
      whole: false,
    });
  });

  it("takes a pane with its view and leaves out panes without one", () => {
    expect(transferItem(source, { kind: "pane", paneId: "c" }, viewOf)?.item).toEqual({
      kind: "pane",
      pane: pane("c"),
      views: [{ paneId: "c", viewId: "v-c" }],
    });
    expect(transferItem(source, { kind: "pane", paneId: "a" }, () => undefined)?.item.views).toEqual([]);
  });

  it("calls the item the whole window when it is its only tab, or the only pane of it", () => {
    const one = win([tab("C", pane("c"))]);
    expect(transferItem(one, { kind: "tab", tabId: "C" }, viewOf)?.whole).toBe(true);
    expect(transferItem(one, { kind: "pane", paneId: "c" }, viewOf)?.whole).toBe(true);
    const split = win([tab("A", row("r", pane("a"), pane("b")))]);
    expect(transferItem(split, { kind: "pane", paneId: "a" }, viewOf)?.whole).toBe(false);
  });

  it("takes the item of a dragged tab or pane; a session of the sidebar stays in its window", () => {
    expect(outgoingItem(source, { kind: "tab", id: "C" }, viewOf)?.item).toMatchObject({ kind: "tab" });
    expect(outgoingItem(source, { kind: "pane", id: "a" }, viewOf)?.item).toMatchObject({ kind: "pane" });
    expect(outgoingItem(source, { kind: "session", id: "s-a" }, viewOf)).toBeUndefined();
    expect(outgoingItem(source, { kind: INCOMING_KIND, id: "A" }, viewOf)).toBeUndefined();
  });

  it("knows neither an unknown tab or pane nor a session of the sidebar", () => {
    expect(transferItem(source, { kind: "tab", tabId: "X" }, viewOf)).toBeUndefined();
    expect(transferItem(source, { kind: "pane", paneId: "x" }, viewOf)).toBeUndefined();
    expect(transferItem(source, { kind: "session", sessionId: "s-a" }, viewOf)).toBeUndefined();
  });
});

describe("takeOut", () => {
  const source = win(
    [tab("A", row("r", pane("a"), pane("b"))), tab("B", pane("c")), tab("C", pane("d"))],
    "B",
  );

  it("removes the tab; its right neighbour becomes active", () => {
    const after = takeOut(source, { kind: "tab", tabId: "B" });
    expect(after.tabs.map((each) => each.id)).toEqual(["A", "C"]);
    expect(after.activeTabId).toBe("C");
  });

  it("removes a pane from its split and closes a tab left empty", () => {
    const fromSplit = takeOut(source, { kind: "pane", paneId: "a" });
    expect(fromSplit.tabs[0]!.root).toEqual(pane("b"));
    const last = takeOut(source, { kind: "pane", paneId: "c" });
    expect(last.tabs.map((each) => each.id)).toEqual(["A", "C"]);
  });

  it("leaves a window without the item as it is", () => {
    expect(takeOut(source, { kind: "tab", tabId: "X" })).toBe(source);
    expect(takeOut(source, { kind: "pane", paneId: "x" })).toBe(source);
  });

  it("closes the last tab to an empty window without an active tab", () => {
    expect(withoutTab(win([tab("A", pane("a"))]), "A")).toEqual({ id: "w", sidebarVisible: true, tabs: [] });
  });
});

describe("applyIncoming", () => {
  const target = win([
    tab("T", pane("t")),
    tab("U", row("u", pane("u1"), pane("u2"), pane("u3"), pane("u4"))),
  ]);
  const tabItem: TransferItem = {
    kind: "tab",
    tab: tab("A", row("r", pane("a"), pane("b")), "b"),
    views: [],
  };
  const paneItem: TransferItem = { kind: "pane", pane: pane("c"), views: [] };

  it("puts a tab at the end of the tab bar with new ids and makes it active", () => {
    const result = applyIncoming(target, tabItem, { kind: "tabBar" }, ids())!;
    const added = result.window.tabs.at(-1)!;
    expect(result.window.tabs).toHaveLength(3);
    expect(result.window.activeTabId).toBe(added.id);
    expect(panesOf(added.root).map((each) => each.sessionId)).toEqual(["s-a", "s-b"]);
    // New ids everywhere, the active pane follows its source pane.
    expect(panesOf(added.root).some((each) => ["a", "b"].includes(each.id))).toBe(false);
    expect(added.root.id).not.toBe("r");
    expect(result.panes[added.activePaneId]).toBe("b");
    expect(Object.values(result.panes).sort()).toEqual(["a", "b"]);
    expect(valid(result.window)).toBe(true);
  });

  it("puts a tab or a pane before a tab of the bar", () => {
    const before = applyIncoming(target, paneItem, { kind: "tabBar", beforeTabId: "T" }, ids())!;
    expect(before.window.tabs.map((each) => each.id)).toEqual(["n2", "T", "U"]);
    expect(before.window.tabs[0]!.root).toEqual({ kind: "pane", id: "n1", sessionId: "s-c" });
    expect(before.panes).toEqual({ n1: "c" });
  });

  it("splits a pane at an edge and makes the incoming view active", () => {
    const result = applyIncoming(target, paneItem, { kind: "pane", paneId: "t", zone: "right" }, ids())!;
    const into = result.window.tabs[0]!;
    expect(into.root).toMatchObject({ kind: "split", direction: "row" });
    expect(panesOf(into.root).map((each) => each.sessionId)).toEqual(["s-t", "s-c"]);
    expect(result.panes[into.activePaneId]).toBe("c");
    expect(result.window.activeTabId).toBe("T");
    expect(result.window.tabs).toHaveLength(2);
    expect(valid(result.window)).toBe(true);
  });

  it("puts a whole tab into a pane at an edge", () => {
    const edge = applyIncoming(target, tabItem, { kind: "pane", paneId: "t", zone: "bottom" }, ids())!;
    expect(panesOf(edge.window.tabs[0]!.root).map((each) => each.sessionId)).toEqual(["s-t", "s-a", "s-b"]);
  });

  it("never replaces a pane of the target: a cancelled move could not bring it back (review #68)", () => {
    expect(
      applyIncoming(target, paneItem, { kind: "pane", paneId: "t", zone: "center" }, ids()),
    ).toBeUndefined();
    expect(
      applyIncoming(target, tabItem, { kind: "pane", paneId: "u1", zone: "center" }, ids()),
    ).toBeUndefined();
  });

  it("refuses an edge of a full tab, a full tab bar, unknown targets and layout patterns", () => {
    expect(
      applyIncoming(target, paneItem, { kind: "pane", paneId: "u1", zone: "left" }, ids()),
    ).toBeUndefined();
    const full = win(Array.from({ length: 64 }, (_, index) => tab(`T${index}`, pane(`p${index}`))));
    expect(applyIncoming(full, tabItem, { kind: "tabBar" }, ids())).toBeUndefined();
    expect(applyIncoming(full, paneItem, { kind: "pane", paneId: "p0", zone: "right" }, ids())).toBeDefined();
    expect(
      applyIncoming(target, paneItem, { kind: "pane", paneId: "x", zone: "left" }, ids()),
    ).toBeUndefined();
    expect(applyIncoming(target, paneItem, { kind: "tabBar", beforeTabId: "X" }, ids())).toBeUndefined();
    expect(
      applyIncoming(target, paneItem, { kind: "snap", pattern: "columns", slot: 0 }, ids()),
    ).toBeUndefined();
    expect(applyIncoming(target, paneItem, { kind: "swap", paneId: "t" }, ids())).toBeUndefined();
  });

  it("opens the item as the only tab of an empty window", () => {
    const result = applyIncoming(win([]), tabItem, { kind: "tabBar" }, ids())!;
    expect(result.window.tabs).toHaveLength(1);
    expect(result.window.activeTabId).toBe(result.window.tabs[0]!.id);
  });

  it("takes the incoming panes out again, closing tabs they leave empty", () => {
    const split = applyIncoming(target, paneItem, { kind: "pane", paneId: "t", zone: "right" }, ids())!;
    expect(withoutIncoming(split.window, Object.keys(split.panes)).tabs[0]!.root).toEqual(pane("t"));
    const own = applyIncoming(target, tabItem, { kind: "tabBar" }, ids())!;
    const back = withoutIncoming(own.window, Object.keys(own.panes));
    expect(back.tabs.map((each) => each.id)).toEqual(["T", "U"]);
  });

  it("finds the target of a drop: the target under the point, the tab bar of a new or empty window", () => {
    expect(incomingTarget(target, true, "pane:t:right")).toEqual({
      kind: "pane",
      paneId: "t",
      zone: "right",
    });
    expect(incomingTarget(target, true, "tabbar")).toEqual({ kind: "tabBar" });
    expect(incomingTarget(target, true, undefined)).toBeUndefined();
    expect(incomingTarget(target, false, undefined)).toEqual({ kind: "tabBar" });
    expect(incomingTarget(win([]), true, undefined)).toEqual({ kind: "tabBar" });
  });

  it("labels the ghost after the session of the active pane", () => {
    const sessions = [{ id: "s-b", name: "Build" }];
    expect(incomingLabel(tabItem, sessions)).toBe("Build");
    expect(incomingLabel(paneItem, sessions)).toBe("Pane");
    expect(incomingPayload(tabItem, sessions)).toEqual({ kind: INCOMING_KIND, id: "A", label: "Build" });
  });
});

describe("settleIncoming", () => {
  const start = startIncoming("x1", { n1: "a", n2: "b", n3: "c" });

  it("waits for every pane, then names the new view of each source pane", () => {
    let step = settleIncoming(start, "n1", { viewId: "w-a" });
    expect(step.result).toBeUndefined();
    step = settleIncoming(step.transfer, "n2", {});
    expect(step.result).toBeUndefined();
    step = settleIncoming(step.transfer, "n3", { viewId: "w-c" });
    expect(step.result).toEqual({
      views: [
        { paneId: "a", viewId: "w-a" },
        { paneId: "c", viewId: "w-c" },
      ],
    });
  });

  it("refuses once a pane could not attach", () => {
    let step = settleIncoming(start, "n1", { viewId: "w-a" });
    step = settleIncoming(step.transfer, "n2", { failed: true });
    step = settleIncoming(step.transfer, "n3", { viewId: "w-c" });
    expect(step.result).toBe("refused");
  });

  it("ignores panes of other transfers and a second report of a pane", () => {
    const other = settleIncoming(start, "zz", { viewId: "w-z" });
    expect(other.transfer).toBe(start);
    const once = settleIncoming(start, "n1", { viewId: "w-a" }).transfer;
    expect(settleIncoming(once, "n1", { failed: true }).transfer).toBe(once);
  });
});
