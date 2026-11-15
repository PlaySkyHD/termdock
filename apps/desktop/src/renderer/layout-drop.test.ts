import type { LayoutWindow } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import { dropSource, dropTarget, snapTarget } from "./layout-drop.js";

const window: LayoutWindow = {
  id: "w",
  tabs: [
    { id: "A", root: { kind: "pane", id: "a", sessionId: "s1" }, activePaneId: "a" },
    { id: "B", root: { kind: "pane", id: "b", sessionId: "s2" }, activePaneId: "b" },
  ],
  activeTabId: "A",
};

describe("dropSource", () => {
  it("translates the payloads of tabs, panes and sidebar sessions", () => {
    expect(dropSource({ kind: "tab", id: "A" })).toEqual({ kind: "tab", tabId: "A" });
    expect(dropSource({ kind: "pane", id: "a" })).toEqual({ kind: "pane", paneId: "a" });
    expect(dropSource({ kind: "session", id: "s1" })).toEqual({ kind: "session", sessionId: "s1" });
    expect(dropSource({ kind: "other", id: "x" })).toBeUndefined();
  });
});

describe("dropTarget", () => {
  it("translates a zone of a pane", () => {
    expect(dropTarget(window, "pane:a:left")).toEqual({ kind: "pane", paneId: "a", zone: "left" });
    expect(dropTarget(window, "pane:a:middle")).toBeUndefined();
  });

  it("translates the halves of a tab into the place before it or before its right neighbour", () => {
    expect(dropTarget(window, "tab:B:before")).toEqual({ kind: "tabBar", beforeTabId: "B" });
    expect(dropTarget(window, "tab:A:after")).toEqual({ kind: "tabBar", beforeTabId: "B" });
    expect(dropTarget(window, "tab:B:after")).toEqual({ kind: "tabBar" });
    expect(dropTarget(window, "tab:X:after")).toBeUndefined();
  });

  it("translates a field of a layout pattern (#78) and refuses unknown patterns and fields", () => {
    expect(snapTarget("mainLeft", 2)).toBe("snap:mainLeft:2");
    expect(dropTarget(window, "snap:mainLeft:2")).toEqual({ kind: "snap", pattern: "mainLeft", slot: 2 });
    expect(dropTarget(window, "snap:columns:2")).toBeUndefined();
    expect(dropTarget(window, "snap:columns:x")).toBeUndefined();
    expect(dropTarget(window, "snap:circle:0")).toBeUndefined();
  });

  it("translates the free tab bar into the end and ignores the sidebar's targets", () => {
    expect(dropTarget(window, "tabbar")).toEqual({ kind: "tabBar" });
    expect(dropTarget(window, "workspace:w1")).toBeUndefined();
    expect(dropTarget(window, "archive")).toBeUndefined();
  });
});
