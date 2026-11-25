import { describe, expect, it } from "vitest";
import type { LayoutWindow, SessionState } from "@termdock/protocol";
import type { BridgeEvent, ClientPoint, TransferItem } from "../shared/bridge.js";
import { holdsOnly, TRANSFER_TIMEOUT_MS, WindowTransfers } from "./window-transfer.js";
import type { ScreenPoint, TransferHost } from "./window-transfer.js";

interface FakeWindow {
  id: number;
  /** Frame on the screen; the client area starts at its top left corner (no frame in the fake). */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Windows side by side on one screen, the views each owns and who writes. Everything the coordinator does goes into
 * `log` in order, so the tests read the order of claim, detach and close.
 */
class FakeHost {
  windows: FakeWindow[] = [
    { id: 1, x: 0, y: 0, width: 500, height: 400 },
    { id: 2, x: 600, y: 0, width: 500, height: 400 },
  ];
  /** View → window that owns it. */
  owners = new Map<string, number>([
    ["v1", 1],
    ["v2", 1],
  ]);
  /** Session → writing view; views of the same session share a key. */
  sessionOf = new Map<string, string>([
    ["v1", "s1"],
    ["v2", "s2"],
  ]);
  writers = new Map<string, string>([["s1", "v1"]]);
  log: string[] = [];
  events: Array<[number, BridgeEvent]> = [];
  timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  claimFails = new Set<string>();
  nextWindow = 10;
  limit = false;
  /** The layouts the windows reported last. */
  layouts = new Map<number, LayoutWindow>();
  /** Session states as the core has them; a session without one is unknown to the core. */
  states = new Map<string, SessionState>();
  stateQueries: string[] = [];

  toScreen(windowId: number, point: ClientPoint): ScreenPoint | undefined {
    const win = this.windows.find((each) => each.id === windowId);
    return win && { x: win.x + point.x, y: win.y + point.y };
  }
  toClient(windowId: number, point: ScreenPoint): ClientPoint | undefined {
    const win = this.windows.find((each) => each.id === windowId);
    return win && { x: point.x - win.x, y: point.y - win.y };
  }
  windowAt(point: ScreenPoint): number | undefined {
    return this.windows.find(
      (win) =>
        point.x >= win.x && point.x < win.x + win.width && point.y >= win.y && point.y < win.y + win.height,
    )?.id;
  }
  openWindowAt(point: ScreenPoint): number | undefined {
    if (this.limit) return undefined;
    const id = this.nextWindow++;
    this.windows.push({ id, x: point.x, y: point.y, width: 500, height: 400 });
    this.log.push(`open ${id} at ${point.x},${point.y}`);
    return id;
  }
  moveWindowTo(windowId: number, point: ScreenPoint): void {
    this.log.push(`move ${windowId} to ${point.x},${point.y}`);
  }
  closeWindow(windowId: number): void {
    this.log.push(`close ${windowId}`);
    this.windows = this.windows.filter((each) => each.id !== windowId);
  }
  send(windowId: number, event: BridgeEvent): boolean {
    this.events.push([windowId, event]);
    if (event.kind !== "transferHover") this.log.push(`${event.kind} → ${windowId}`);
    return this.windows.some((each) => each.id === windowId);
  }
  isWriter(windowId: number, viewId: string): boolean {
    const session = this.sessionOf.get(viewId);
    return (
      this.owners.get(viewId) === windowId && session !== undefined && this.writers.get(session) === viewId
    );
  }
  async claimWriter(windowId: number, viewId: string): Promise<void> {
    await Promise.resolve();
    this.log.push(`claim ${viewId} by ${windowId}`);
    if (this.claimFails.has(viewId) || this.owners.get(viewId) !== windowId) throw new Error("not_found");
    this.writers.set(this.sessionOf.get(viewId)!, viewId);
  }
  schedule(run: () => void, ms: number): () => void {
    const timer = { run, ms, cancelled: false };
    this.timers.push(timer);
    return () => void (timer.cancelled = true);
  }
  newId(): string {
    return "t1";
  }

  /** A new view of the target window for a session. */
  attach(viewId: string, windowId: number, sessionId: string): void {
    this.owners.set(viewId, windowId);
    this.sessionOf.set(viewId, sessionId);
  }
  eventsTo(windowId: number): BridgeEvent[] {
    return this.events.filter(([id]) => id === windowId).map(([, event]) => event);
  }
}

function setup() {
  const host = new FakeHost();
  const transfers = new WindowTransfers(bind(host));
  return { host, transfers };
}

/** The host's methods bound to it, so the coordinator can call them one by one. */
function bind(host: FakeHost): TransferHost {
  return {
    toScreen: (id, point) => host.toScreen(id, point),
    toClient: (id, point) => host.toClient(id, point),
    windowAt: (point) => host.windowAt(point),
    openWindowAt: (point) => host.openWindowAt(point),
    moveWindowTo: (id, point) => host.moveWindowTo(id, point),
    closeWindow: (id) => host.closeWindow(id),
    layoutOf: (id) => host.layouts.get(id),
    send: (id, event) => host.send(id, event),
    sessionOf: (id, viewId) => (host.owners.get(viewId) === id ? host.sessionOf.get(viewId) : undefined),
    sessionState: async (sessionId) => {
      host.stateQueries.push(sessionId);
      return host.states.get(sessionId);
    },
    isWriter: (id, viewId) => host.isWriter(id, viewId),
    claimWriter: (id, viewId) => host.claimWriter(id, viewId),
    schedule: (run, ms) => host.schedule(run, ms),
    newId: () => host.newId(),
    log: () => {},
  };
}

const tabItem: TransferItem = {
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
  views: [
    { paneId: "a", viewId: "v1" },
    { paneId: "b", viewId: "v2" },
  ],
};
const paneItem: TransferItem = {
  kind: "pane",
  pane: { kind: "pane", id: "a", sessionId: "s1" },
  views: [{ paneId: "a", viewId: "v1" }],
};
/** A point over window 2 in client coordinates of window 1 (x 700 on the screen). */
const overTwo: ClientPoint = { x: 700, y: 100 };
const outside: ClientPoint = { x: 1500, y: 300 };

describe("WindowTransfers: hover", () => {
  it("shows the drag in the window under the pointer, in its coordinates, and takes it away when it leaves", () => {
    const { host, transfers } = setup();

    transfers.hover(1, paneItem, overTwo);
    expect(host.eventsTo(2)).toEqual([{ kind: "transferHover", hover: { item: paneItem, x: 100, y: 100 } }]);

    transfers.hover(1, paneItem, outside);
    expect(host.eventsTo(2).at(-1)).toEqual({ kind: "transferHover" });

    transfers.hover(1, paneItem, overTwo);
    transfers.hoverEnd(1);
    expect(host.eventsTo(2).at(-1)).toEqual({ kind: "transferHover" });
    expect(host.eventsTo(1)).toEqual([]);
  });

  it("does not show the drag in its own window (the pointer over its frame)", () => {
    const { host, transfers } = setup();
    transfers.hover(1, paneItem, { x: 10, y: -5 + 10 });
    expect(host.events).toEqual([]);
  });
});

describe("WindowTransfers: handover to another window", () => {
  it("[V1-05] attaches in the target, hands the writer over, then lets the source take the item out", async () => {
    const { host, transfers } = setup();
    transfers.hover(1, paneItem, overTwo);

    transfers.drop(1, paneItem, overTwo, false);

    expect(host.eventsTo(2).at(-2)).toEqual({ kind: "transferHover" });
    expect(host.eventsTo(2).at(-1)).toEqual({
      kind: "transferIn",
      transferId: "t1",
      item: paneItem,
      at: { x: 100, y: 100 },
    });
    // The target attached a new view of s1 for the source pane `a`; it reads while v1 is still there.
    host.attach("w1", 2, "s1");
    await transfers.attached(2, "t1", [{ paneId: "a", viewId: "w1" }]);

    expect(host.writers.get("s1")).toBe("w1");
    expect(host.log).toEqual(["transferIn → 2", "claim w1 by 2", "transferOut → 1"]);
    expect(host.eventsTo(1).at(-1)).toEqual({ kind: "transferOut", source: { kind: "pane", paneId: "a" } });
    expect(host.timers[0]).toMatchObject({ ms: TRANSFER_TIMEOUT_MS, cancelled: true });
  });

  it("[#68] claims nothing for a view that reads", async () => {
    const { host, transfers } = setup();
    const readerItem: TransferItem = {
      kind: "pane",
      pane: { kind: "pane", id: "b", sessionId: "s2" },
      views: [{ paneId: "b", viewId: "v2" }],
    };
    transfers.drop(1, readerItem, overTwo, false);
    host.attach("w2", 2, "s2");
    await transfers.attached(2, "t1", [{ paneId: "b", viewId: "w2" }]);

    expect(host.log).toEqual(["transferIn → 2", "transferOut → 1"]);
  });

  it("[#68] hands over every writer of a tab and closes the source when the tab was all it had", async () => {
    const { host, transfers } = setup();
    host.writers.set("s2", "v2");
    host.layouts.set(1, { id: "w1", tabs: [tabItem.tab] });
    transfers.drop(1, tabItem, overTwo, true);
    host.attach("w1", 2, "s1");
    host.attach("w2", 2, "s2");
    await transfers.attached(2, "t1", [
      { paneId: "a", viewId: "w1" },
      { paneId: "b", viewId: "w2" },
    ]);

    expect(host.log).toEqual(["transferIn → 2", "claim w1 by 2", "claim w2 by 2", "close 1"]);
    expect([host.writers.get("s1"), host.writers.get("s2")]).toEqual(["w1", "w2"]);
  });

  it("keeps the source open when it got another tab while the target attached (review #68)", async () => {
    const { host, transfers } = setup();
    host.layouts.set(1, { id: "w1", tabs: [tabItem.tab] });
    transfers.drop(1, tabItem, overTwo, true);
    const other = { id: "N", root: { kind: "pane" as const, id: "n", sessionId: "s9" }, activePaneId: "n" };
    host.layouts.set(1, { id: "w1", tabs: [tabItem.tab, other] });
    host.attach("w1", 2, "s1");
    host.attach("w2", 2, "s2");
    await transfers.attached(2, "t1", [
      { paneId: "a", viewId: "w1" },
      { paneId: "b", viewId: "w2" },
    ]);

    expect(host.log).toEqual(["transferIn → 2", "claim w1 by 2", "transferOut → 1"]);
  });

  it("knows when a window holds nothing but the item", () => {
    const pane = { kind: "pane" as const, id: "a", sessionId: "s1" };
    const single = { id: "w", tabs: [{ id: "A", root: pane, activePaneId: "a" }] };
    expect(holdsOnly(single, { kind: "tab", tabId: "A" })).toBe(true);
    expect(holdsOnly(single, { kind: "pane", paneId: "a" })).toBe(true);
    expect(holdsOnly({ id: "w", tabs: [tabItem.tab] }, { kind: "pane", paneId: "a" })).toBe(false);
    expect(holdsOnly(single, { kind: "tab", tabId: "B" })).toBe(false);
    expect(holdsOnly(undefined, { kind: "tab", tabId: "A" })).toBe(false);
  });

  it("does nothing more when the target refuses", async () => {
    const { host, transfers } = setup();
    transfers.drop(1, paneItem, overTwo, false);
    await transfers.attached(2, "t1", undefined);

    expect(host.log).toEqual(["transferIn → 2"]);
    expect(host.writers.get("s1")).toBe("v1");
  });

  it("cancels when the target names no pane for a source view, and the source keeps everything", async () => {
    const { host, transfers } = setup();
    transfers.drop(1, paneItem, overTwo, false);
    await transfers.attached(2, "t1", []);

    expect(host.log).toEqual(["transferIn → 2", "transferCancel → 2"]);
    expect(host.writers.get("s1")).toBe("v1");
  });

  it("moves the pane of an ended session, which the target shows as a placeholder, without a claim (review PR #190)", async () => {
    const { host, transfers } = setup();
    host.states.set("s1", "Exited");
    transfers.drop(1, paneItem, outside, false);
    transfers.ready(10);
    await transfers.attached(10, "t1", [{ paneId: "a" }]);

    // The new window stays and the source lets its view go: no process is left that could write.
    expect(host.log).toEqual(["open 10 at 1500,300", "transferIn → 10", "transferOut → 1"]);
    expect(host.stateQueries).toEqual(["s1"]);
  });

  it.each(["Starting", "Interrupted", "Running"] as const)(
    "does not take a placeholder on trust for a writer whose session is %s: cancels, the writer stays (review PR #190)",
    async (state) => {
      const { host, transfers } = setup();
      host.states.set("s1", state);
      transfers.drop(1, paneItem, overTwo, false);
      await transfers.attached(2, "t1", [{ paneId: "a" }]);

      expect(host.log).toEqual(["transferIn → 2", "transferCancel → 2"]);
      expect(host.writers.get("s1")).toBe("v1");
    },
  );

  it("moves a reading view shown as a placeholder without asking the core", async () => {
    const { host, transfers } = setup();
    const readerItem: TransferItem = {
      kind: "pane",
      pane: { kind: "pane", id: "b", sessionId: "s2" },
      views: [{ paneId: "b", viewId: "v2" }],
    };
    transfers.drop(1, readerItem, overTwo, false);
    await transfers.attached(2, "t1", [{ paneId: "b" }]);

    expect(host.log).toEqual(["transferIn → 2", "transferOut → 1"]);
    expect(host.stateQueries).toEqual([]);
  });

  it("cancels when the bridge no longer knows a view of the source, e.g. after a restart of the core (review PR #190)", async () => {
    const { host, transfers } = setup();
    transfers.drop(1, paneItem, overTwo, false);
    host.owners.delete("v1");
    host.attach("w1", 2, "s1");
    await transfers.attached(2, "t1", [{ paneId: "a", viewId: "w1" }]);

    expect(host.log).toEqual(["transferIn → 2", "transferCancel → 2"]);
  });

  it("cancels when the successor shows another session than its source pane (review PR #190)", async () => {
    const { host, transfers } = setup();
    transfers.drop(1, paneItem, overTwo, false);
    host.attach("w9", 2, "s2");
    await transfers.attached(2, "t1", [{ paneId: "a", viewId: "w9" }]);

    expect(host.log).toEqual(["transferIn → 2", "transferCancel → 2"]);
    expect(host.writers.get("s1")).toBe("v1");
  });

  it("stops every move when the core connection ends (review PR #190)", async () => {
    const { host, transfers } = setup();
    transfers.drop(1, paneItem, overTwo, false);
    transfers.coreClosed();
    host.attach("w1", 2, "s1");
    await transfers.attached(2, "t1", [{ paneId: "a", viewId: "w1" }]);

    expect(host.log).toEqual(["transferIn → 2", "transferCancel → 2"]);
  });

  it("gives the writers back when a later claim fails, so the source keeps every role", async () => {
    const { host, transfers } = setup();
    host.writers.set("s2", "v2");
    transfers.drop(1, tabItem, overTwo, false);
    host.attach("w1", 2, "s1");
    host.attach("w2", 2, "s2");
    host.claimFails.add("w2");
    await transfers.attached(2, "t1", [
      { paneId: "a", viewId: "w1" },
      { paneId: "b", viewId: "w2" },
    ]);

    expect(host.log).toEqual([
      "transferIn → 2",
      "claim w1 by 2",
      "claim w2 by 2",
      "claim v1 by 1",
      "transferCancel → 2",
    ]);
    expect([host.writers.get("s1"), host.writers.get("s2")]).toEqual(["v1", "v2"]);
  });

  it("does not claim a view of another window that a target names", async () => {
    const { host, transfers } = setup();
    transfers.drop(1, paneItem, overTwo, false);
    await transfers.attached(2, "t1", [{ paneId: "a", viewId: "v2" }]);

    expect(host.writers.get("s1")).toBe("v1");
    expect(host.log.at(-1)).toBe("transferCancel → 2");
  });

  it("ignores an answer of another window and a second answer", async () => {
    const { host, transfers } = setup();
    transfers.drop(1, paneItem, overTwo, false);
    await transfers.attached(1, "t1", undefined);
    host.attach("w1", 2, "s1");
    await transfers.attached(2, "t1", [{ paneId: "a", viewId: "w1" }]);
    await transfers.attached(2, "t1", [{ paneId: "a", viewId: "w1" }]);

    expect(host.log).toEqual(["transferIn → 2", "claim w1 by 2", "transferOut → 1"]);
  });

  it("cancels after the time limit, and a late answer changes nothing", async () => {
    const { host, transfers } = setup();
    transfers.drop(1, paneItem, overTwo, false);
    host.timers[0]!.run();
    host.attach("w1", 2, "s1");
    await transfers.attached(2, "t1", [{ paneId: "a", viewId: "w1" }]);

    expect(host.log).toEqual(["transferIn → 2", "transferCancel → 2"]);
    expect(host.writers.get("s1")).toBe("v1");
  });

  it("cancels when the target or the source closes", async () => {
    const first = setup();
    first.transfers.drop(1, paneItem, overTwo, false);
    first.transfers.windowGone(2);
    await first.transfers.attached(2, "t1", []);
    expect(first.host.log).toEqual(["transferIn → 2"]);

    const second = setup();
    second.transfers.drop(1, paneItem, overTwo, false);
    second.transfers.windowGone(1);
    expect(second.host.log).toEqual(["transferIn → 2", "transferCancel → 2"]);
  });

  it("takes a second drop of an item in flight for nothing", () => {
    const { host, transfers } = setup();
    transfers.drop(1, paneItem, overTwo, false);
    transfers.drop(1, paneItem, overTwo, false);
    expect(host.log).toEqual(["transferIn → 2"]);
  });
});

describe("WindowTransfers: outside every window", () => {
  it("[#68] opens a window at the pointer and sends the item once its page has loaded its layout", async () => {
    const { host, transfers } = setup();
    transfers.drop(1, paneItem, outside, false);

    expect(host.log).toEqual(["open 10 at 1500,300"]);
    transfers.ready(10);
    expect(host.eventsTo(10)).toEqual([{ kind: "transferIn", transferId: "t1", item: paneItem }]);
    host.attach("w1", 10, "s1");
    await transfers.attached(10, "t1", [{ paneId: "a", viewId: "w1" }]);
    expect(host.log).toEqual(["open 10 at 1500,300", "transferIn → 10", "claim w1 by 10", "transferOut → 1"]);
  });

  it("keeps waiting through the first load of the window it opened (a navigation, too)", () => {
    const { host, transfers } = setup();
    transfers.drop(1, paneItem, outside, false);
    transfers.windowGone(10, true);
    transfers.ready(10);
    expect(host.eventsTo(10)).toEqual([{ kind: "transferIn", transferId: "t1", item: paneItem }]);
  });

  it("closes the window it opened when the move is refused or times out", async () => {
    const refused = setup();
    refused.transfers.drop(1, paneItem, outside, false);
    refused.transfers.ready(10);
    await refused.transfers.attached(10, "t1", undefined);
    expect(refused.host.log.at(-1)).toBe("close 10");

    const late = setup();
    late.transfers.drop(1, paneItem, outside, false);
    late.host.timers[0]!.run();
    // The page never loaded, so it never got the item.
    expect(late.host.log).toEqual(["open 10 at 1500,300", "close 10"]);
  });

  it("[#68] moves the source window there when the item is all it has, without any handover", () => {
    const { host, transfers } = setup();
    transfers.drop(1, paneItem, outside, true);
    expect(host.log).toEqual(["move 1 to 1500,300"]);
    expect(host.timers).toEqual([]);
  });

  it("does nothing over its own window and at the window limit", () => {
    const own = setup();
    own.transfers.drop(1, paneItem, { x: 100, y: 100 }, false);
    expect(own.host.log).toEqual([]);

    const full = setup();
    full.host.limit = true;
    full.transfers.drop(1, paneItem, outside, false);
    expect(full.host.log).toEqual([]);
  });
});
