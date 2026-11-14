import { IpcError } from "@termdock/core";
import type { LayoutDocument, LayoutPane, LayoutTab, LayoutWindow } from "@termdock/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutCoordinator } from "./layout-coordinator.js";
import type { LayoutPort } from "./layout-coordinator.js";

interface Saved {
  layout: LayoutDocument;
  baseRevision: number | undefined;
}

/** Core double for `layout.get` and `layout.save` with the revision rules of the real one. */
class FakeLayoutCore implements LayoutPort {
  stored: LayoutDocument | undefined;
  revision = 0;
  readonly saves: Saved[] = [];
  gets = 0;
  /** Errors thrown by the next calls of `layout.save`, oldest first. */
  saveErrors: Error[] = [];
  getError: Error | undefined;
  /** Runs inside `layout.save` before it answers (a slow save). */
  duringSave: (() => Promise<void>) | undefined;

  request = (async (method: string, params: unknown) => {
    if (method === "layout.get") {
      this.gets += 1;
      if (this.getError) throw this.getError;
      return { result: { ...(this.stored ? { layout: this.stored } : {}), revision: this.revision } };
    }
    const { layout, baseRevision } = params as Saved;
    this.saves.push({ layout, baseRevision });
    await this.duringSave?.();
    const error = this.saveErrors.shift();
    if (error) throw error;
    if (baseRevision !== undefined && baseRevision !== this.revision)
      throw new IpcError("invalid_state", "stale base revision");
    this.stored = layout;
    this.revision += 1;
    return { result: { revision: this.revision } };
  }) as LayoutPort["request"];
}

const pane = (id: string, sessionId = "s1"): LayoutPane => ({ kind: "pane", id, sessionId });
const tab = (id: string, ...panes: LayoutPane[]): LayoutTab => ({
  id,
  root:
    panes.length === 1
      ? panes[0]!
      : {
          kind: "split",
          id: `${id}-split`,
          direction: "row",
          children: panes,
          sizes: panes.map(() => 1 / panes.length),
        },
  activePaneId: panes[0]!.id,
});
const windowWith = (id: string, ...tabs: LayoutTab[]): LayoutWindow => ({
  id,
  tabs,
  ...(tabs[0] ? { activeTabId: tabs[0].id } : {}),
});

function setup(): { core: FakeLayoutCore; coordinator: LayoutCoordinator; log: string[] } {
  const core = new FakeLayoutCore();
  const log: string[] = [];
  const coordinator = new LayoutCoordinator({
    core,
    log: (text) => log.push(text),
    delayMs: 400,
    maxWaitMs: 2_000,
  });
  return { core, coordinator, log };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("LayoutCoordinator load", () => {
  it("returns the windows of the stored layout and remembers its revision", async () => {
    const { core, coordinator } = setup();
    core.stored = { version: 1, windows: [windowWith("w1", tab("t1", pane("p1")))] };
    core.revision = 4;

    const windows = await coordinator.load();

    expect(windows).toEqual(core.stored.windows);
    coordinator.addWindow(1, windows[0]!);
    coordinator.setGeometry(1, { maximized: true });
    await coordinator.flush();
    expect(core.saves[0]?.baseRevision).toBe(4);
  });

  it("returns no windows without a stored layout", async () => {
    const { coordinator } = setup();
    expect(await coordinator.load()).toEqual([]);
  });

  it("starts without windows when the core does not answer, and fetches the revision before it saves", async () => {
    const { core, coordinator, log } = setup();
    core.getError = new IpcError("timeout", "layout.get timed out");
    core.revision = 6;

    expect(await coordinator.load()).toEqual([]);
    expect(log.join("\n")).toContain("layout.get timed out");

    core.getError = undefined;
    coordinator.addWindow(1, windowWith("w1"));
    await coordinator.flush();

    // It did not overwrite blindly: the save names the revision it fetched.
    expect(core.saves.map((save) => save.baseRevision)).toEqual([6]);
  });
});

describe("LayoutCoordinator saving", () => {
  it("saves a window it was given as new, after the delay", async () => {
    const { core, coordinator } = setup();
    coordinator.addWindow(1, windowWith("w1"));

    await vi.advanceTimersByTimeAsync(399);
    expect(core.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);

    expect(core.saves).toHaveLength(1);
    expect(core.saves[0]!.layout).toEqual({ version: 1, windows: [windowWith("w1")] });
  });

  it("does not save a restored window until something changes", async () => {
    const { core, coordinator } = setup();
    coordinator.addWindow(1, windowWith("w1", tab("t1", pane("p1"))), { restored: true });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(core.saves).toHaveLength(0);
  });

  it("bundles changes inside the delay into one save with the last state", async () => {
    const { core, coordinator } = setup();
    coordinator.addWindow(1, windowWith("w1"), { restored: true });

    coordinator.report(1, { tabs: [tab("t1", pane("p1"))], activeTabId: "t1" });
    await vi.advanceTimersByTimeAsync(200);
    coordinator.report(1, { tabs: [tab("t1", pane("p1")), tab("t2", pane("p2"))], activeTabId: "t2" });
    await vi.advanceTimersByTimeAsync(200);
    coordinator.report(1, { tabs: [tab("t2", pane("p2"))], activeTabId: "t2" });
    await vi.advanceTimersByTimeAsync(401);

    expect(core.saves).toHaveLength(1);
    expect(core.saves[0]!.layout.windows[0]!.tabs.map((each) => each.id)).toEqual(["t2"]);
  });

  it("saves at the latest after the maximum wait while changes keep coming", async () => {
    const { core, coordinator } = setup();
    coordinator.addWindow(1, windowWith("w1"), { restored: true });

    for (let step = 0; step < 8; step++) {
      coordinator.report(1, { tabs: [tab(`t${step}`, pane(`p${step}`))], activeTabId: `t${step}` });
      await vi.advanceTimersByTimeAsync(300);
    }

    expect(core.saves.length).toBeGreaterThanOrEqual(1);
    expect(core.saves.length).toBeLessThanOrEqual(2);
  });

  it("puts the geometry of the main process into the document and keeps the part of the renderer", async () => {
    const { core, coordinator } = setup();
    coordinator.addWindow(1, windowWith("w1"), { restored: true });
    coordinator.report(1, { tabs: [tab("t1", pane("p1"))], activeTabId: "t1", sidebarVisible: false });
    coordinator.setGeometry(1, { bounds: { x: 10, y: 20, width: 900, height: 600 }, maximized: true });

    await coordinator.flush();

    expect(core.saves[0]!.layout.windows[0]).toEqual({
      id: "w1",
      bounds: { x: 10, y: 20, width: 900, height: 600 },
      maximized: true,
      sidebarVisible: false,
      tabs: [tab("t1", pane("p1"))],
      activeTabId: "t1",
    });
  });

  it("does not save when the geometry stays the same", async () => {
    const { core, coordinator } = setup();
    const bounds = { x: 1, y: 2, width: 800, height: 500 };
    coordinator.addWindow(1, { ...windowWith("w1"), bounds, maximized: false }, { restored: true });

    coordinator.setGeometry(1, { bounds: { ...bounds }, maximized: false });
    await coordinator.flush();

    expect(core.saves).toHaveLength(0);
  });

  it("bundles two windows into one document in the order they were added", async () => {
    const { core, coordinator } = setup();
    coordinator.addWindow(7, windowWith("wa", tab("ta", pane("pa"))), { restored: true });
    coordinator.addWindow(3, windowWith("wb", tab("tb", pane("pb", "s2"))));

    await coordinator.flush();

    expect(core.saves[0]!.layout.windows.map((window) => window.id)).toEqual(["wa", "wb"]);
  });

  it("flush saves at once, and does nothing when there is nothing to save", async () => {
    const { core, coordinator } = setup();
    await coordinator.flush();
    expect(core.saves).toHaveLength(0);

    coordinator.addWindow(1, windowWith("w1"));
    await coordinator.flush();
    expect(core.saves).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(core.saves).toHaveLength(1);
  });

  it("saves again for a change that arrives while a save is on its way", async () => {
    const { core, coordinator } = setup();
    coordinator.addWindow(1, windowWith("w1"), { restored: true });
    let release: (() => void) | undefined;
    core.duringSave = () => new Promise<void>((resolve) => (release = resolve));
    coordinator.report(1, { tabs: [tab("t1", pane("p1"))], activeTabId: "t1" });
    const first = coordinator.flush();
    await vi.advanceTimersByTimeAsync(0);

    coordinator.report(1, { tabs: [tab("t2", pane("p2"))], activeTabId: "t2" });
    core.duringSave = undefined;
    release?.();
    await first;

    expect(core.saves.map((save) => save.layout.windows[0]!.activeTabId)).toEqual(["t1", "t2"]);
    expect(core.saves.map((save) => save.baseRevision)).toEqual([0, 1]);
  });
});

describe("LayoutCoordinator revision conflict", () => {
  it("reloads the revision and saves its own state again; the last state wins", async () => {
    const { core, coordinator } = setup();
    await coordinator.load();
    // Another client saved meanwhile.
    core.stored = { version: 1, windows: [windowWith("other", tab("to", pane("po")))] };
    core.revision = 7;
    coordinator.addWindow(1, windowWith("w1", tab("t1", pane("p1"))));

    await coordinator.flush();

    expect(core.saves.map((save) => save.baseRevision)).toEqual([0, 7]);
    expect(core.stored.windows.map((window) => window.id)).toEqual(["w1"]);
    expect(core.revision).toBe(8);
    expect(core.gets).toBe(2);
    // Later saves continue from the new revision.
    coordinator.report(1, { tabs: [tab("t2", pane("p2"))], activeTabId: "t2" });
    await coordinator.flush();
    expect(core.saves.at(-1)?.baseRevision).toBe(8);
  });

  it("gives up after a few conflicts and tries again at the next flush", async () => {
    const { core, coordinator, log } = setup();
    await coordinator.load();
    const conflict = (): IpcError => new IpcError("invalid_state", "stale base revision");
    core.saveErrors = [conflict(), conflict(), conflict(), conflict()];
    coordinator.addWindow(1, windowWith("w1"));

    await coordinator.flush();
    expect(core.saves).toHaveLength(3);
    expect(log.join("\n")).toContain("stale base revision");

    await coordinator.flush();
    expect(core.stored?.windows[0]?.id).toBe("w1");
  });

  it("keeps the state for another try after a failure that is not a conflict", async () => {
    const { core, coordinator, log } = setup();
    core.saveErrors = [new IpcError("timeout", "layout.save timed out")];
    coordinator.addWindow(1, windowWith("w1"));

    await coordinator.flush();
    expect(core.stored).toBeUndefined();
    expect(log.join("\n")).toContain("layout.save timed out");

    await coordinator.flush();
    expect(core.stored?.windows[0]?.id).toBe("w1");
  });
});

describe("LayoutCoordinator reports of a renderer", () => {
  it("rejects a tab with five panes with bad_request and keeps the old state", async () => {
    const { core, coordinator } = setup();
    coordinator.addWindow(1, windowWith("w1", tab("t1", pane("p1"))), { restored: true });
    const five = tab("t9", pane("a"), pane("b"), pane("c"), pane("d"), pane("e"));

    expect(() => coordinator.report(1, { tabs: [five], activeTabId: "t9" })).toThrowError(IpcError);
    try {
      coordinator.report(1, { tabs: [five], activeTabId: "t9" });
    } catch (error) {
      expect((error as IpcError).code).toBe("bad_request");
    }

    await coordinator.flush();
    expect(core.saves).toHaveLength(0);
    expect(coordinator.windowOf(1)?.tabs.map((each) => each.id)).toEqual(["t1"]);
  });

  it("rejects an id that another window already uses", () => {
    const { coordinator } = setup();
    coordinator.addWindow(1, windowWith("w1", tab("t1", pane("p1"))), { restored: true });
    coordinator.addWindow(2, windowWith("w2"), { restored: true });

    expect(() => coordinator.report(2, { tabs: [tab("t1", pane("px"))], activeTabId: "t1" })).toThrowError(
      /more than once/,
    );
  });

  it("rejects an unknown key in a tab", () => {
    const { coordinator } = setup();
    coordinator.addWindow(1, windowWith("w1"), { restored: true });
    const odd = { ...tab("t1", pane("p1")), extra: 1 } as LayoutTab;

    expect(() => coordinator.report(1, { tabs: [odd], activeTabId: "t1" })).toThrowError(/extra/);
  });

  it("ignores the report of a window it does not know", () => {
    const { coordinator } = setup();
    expect(() => coordinator.report(9, { tabs: [] })).not.toThrow();
  });
});

describe("LayoutCoordinator closing windows", () => {
  it("removes a window the user closed", async () => {
    const { core, coordinator } = setup();
    coordinator.addWindow(1, windowWith("wa", tab("ta", pane("pa"))), { restored: true });
    coordinator.addWindow(2, windowWith("wb", tab("tb", pane("pb"))), { restored: true });

    coordinator.closeWindow(2, { keep: false });
    await coordinator.flush();

    expect(core.saves[0]!.layout.windows.map((window) => window.id)).toEqual(["wa"]);
    expect(coordinator.windowOf(2)).toBeUndefined();
  });

  it("keeps a window that closes while the app quits, with its last geometry", async () => {
    const { core, coordinator } = setup();
    coordinator.addWindow(1, windowWith("wa", tab("ta", pane("pa"))), { restored: true });
    coordinator.addWindow(2, windowWith("wb", tab("tb", pane("pb"))), { restored: true });

    coordinator.setGeometry(2, { bounds: { x: 5, y: 5, width: 700, height: 500 } });
    coordinator.closeWindow(1, { keep: true });
    coordinator.closeWindow(2, { keep: true });
    await coordinator.flush();

    expect(core.saves.at(-1)!.layout.windows.map((window) => window.id)).toEqual(["wa", "wb"]);
    expect(core.saves.at(-1)!.layout.windows[1]!.bounds).toEqual({ x: 5, y: 5, width: 700, height: 500 });
  });

  it("counts only open windows", () => {
    const { coordinator } = setup();
    coordinator.addWindow(1, windowWith("wa"), { restored: true });
    coordinator.addWindow(2, windowWith("wb"), { restored: true });
    expect(coordinator.openWindows()).toBe(2);

    coordinator.closeWindow(1, { keep: true });
    expect(coordinator.openWindows()).toBe(1);
  });

  it("ignores reports of a window that is closed", async () => {
    const { core, coordinator } = setup();
    coordinator.addWindow(1, windowWith("wa", tab("ta", pane("pa"))), { restored: true });
    coordinator.closeWindow(1, { keep: true });
    await coordinator.flush();
    const before = core.saves.length;

    coordinator.report(1, { tabs: [] });
    await coordinator.flush();

    expect(core.saves).toHaveLength(before);
    expect(core.saves.at(-1)?.layout.windows[0]?.tabs).toHaveLength(1);
  });
});

describe("LayoutCoordinator windowOf", () => {
  it("returns the window with its id for the renderer, or nothing for an unknown window", () => {
    const { coordinator } = setup();
    const window = windowWith("w1", tab("t1", pane("p1")));
    coordinator.addWindow(5, window, { restored: true });

    expect(coordinator.windowOf(5)).toEqual(window);
    expect(coordinator.windowOf(6)).toBeUndefined();
  });
});
