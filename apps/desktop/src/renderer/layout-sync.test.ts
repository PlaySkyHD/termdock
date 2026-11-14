import type { LayoutWindow, SessionInfo } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import type { TermdockApi } from "../shared/bridge.js";
import type { LayoutWindowPart } from "../shared/layout-mapping.js";
import { startLayoutSync } from "./layout-sync.js";
import { UiStore } from "./ui-store.js";

class FakeApi implements Pick<TermdockApi, "windowLayout" | "reportLayout"> {
  readonly reports: LayoutWindowPart[] = [];
  private answer: ((window: LayoutWindow) => void) | undefined;
  private fail: ((error: Error) => void) | undefined;
  reportError: Error | undefined;

  windowLayout(): Promise<LayoutWindow> {
    return new Promise((resolve, reject) => {
      this.answer = resolve;
      this.fail = reject;
    });
  }
  async reportLayout(window: LayoutWindowPart): Promise<void> {
    if (this.reportError) throw this.reportError;
    this.reports.push(window);
  }
  resolve(window: LayoutWindow): void {
    this.answer?.(window);
  }
  reject(error: Error): void {
    this.fail?.(error);
  }
}

/** Scheduler the test runs by hand: the delayed report goes out when the test says so. */
class FakeScheduler {
  private pending: (() => void) | undefined;
  scheduled: number[] = [];
  schedule = (run: () => void, ms: number): (() => void) => {
    this.scheduled.push(ms);
    this.pending = run;
    return () => {
      if (this.pending === run) this.pending = undefined;
    };
  };
  get waiting(): boolean {
    return this.pending !== undefined;
  }
  /** The delay is over. */
  fire(): void {
    const run = this.pending;
    this.pending = undefined;
    run?.();
  }
}

const saved: LayoutWindow = {
  id: "w-main",
  bounds: { x: 1, y: 2, width: 900, height: 600 },
  maximized: false,
  sidebarVisible: false,
  activeTabId: "t1",
  tabs: [{ id: "t1", root: { kind: "pane", id: "p1", sessionId: "s1" }, activePaneId: "p1" }],
};

function newStore(): UiStore {
  let next = 0;
  const store = new UiStore({ newId: () => `n${++next}` });
  store.setSessions([{ id: "s1", name: "s1", state: "Detached", createdAt: "x" } as SessionInfo]);
  return store;
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function started(onError: (message: string) => void = () => {}) {
  const api = new FakeApi();
  const store = newStore();
  const scheduler = new FakeScheduler();
  const sync = startLayoutSync(store, api, onError, { schedule: scheduler.schedule, delayMs: 50 });
  api.resolve(saved);
  await sync.ready;
  return { api, store, scheduler, sync };
}

describe("startLayoutSync", () => {
  it("loads the window of the main process into the store before anything is reported", async () => {
    const api = new FakeApi();
    const store = newStore();
    const scheduler = new FakeScheduler();
    const sync = startLayoutSync(store, api, () => {}, { schedule: scheduler.schedule });

    // A change before the answer must neither be reported nor survive: the main process knows the real layout.
    store.openSession("s1");
    expect(scheduler.waiting).toBe(false);
    api.resolve(saved);
    await sync.ready;

    expect(store.getState().window).toEqual(saved);
    expect(api.reports).toEqual([]);
    expect(scheduler.waiting).toBe(false);
  });

  it("reports the part of the window after the delay, without id and geometry", async () => {
    const { api, store, scheduler } = await started();

    store.toggleSidebar();
    await settle();
    expect(api.reports).toEqual([]);
    scheduler.fire();
    await settle();

    expect(scheduler.scheduled).toEqual([50]);
    expect(api.reports).toEqual([{ sidebarVisible: true, activeTabId: "t1", tabs: saved.tabs }]);
    expect(api.reports[0]).not.toHaveProperty("id");
    expect(api.reports[0]).not.toHaveProperty("bounds");
  });

  it("bundles many changes in the delay into one report with the latest state", async () => {
    const { api, store, scheduler } = await started();
    const tab = store.getState().window.tabs[0]!;
    const paneId = tab.activePaneId;
    const split = store.splitPane(tab.id, paneId, "row", "s1")!;
    const root = store.getState().window.tabs[0]!.root;
    if (root.kind !== "split") throw new Error("expected a split");

    // Dragging a divider: one change per mouse move.
    for (let step = 1; step <= 20; step++) store.moveDivider(tab.id, root.id, 0, 0.01);
    expect(split).toBeDefined();
    scheduler.fire();
    await settle();

    expect(scheduler.scheduled).toHaveLength(1);
    expect(api.reports).toHaveLength(1);
    const reported = api.reports[0]!.tabs[0]!.root;
    expect(reported).toEqual(store.getState().window.tabs[0]!.root);
    if (reported.kind !== "split") throw new Error("expected a split");
    expect(reported.sizes[0]).toBeCloseTo(0.7);
  });

  it("starts a new delay for a change after a report", async () => {
    const { api, store, scheduler } = await started();

    store.toggleSidebar();
    scheduler.fire();
    store.toggleSidebar();
    scheduler.fire();
    await settle();

    expect(scheduler.scheduled).toHaveLength(2);
    expect(api.reports.map((report) => report.sidebarVisible)).toEqual([true, false]);
  });

  it("flush sends a waiting report at once, and nothing when there is none", async () => {
    const { api, store, scheduler, sync } = await started();
    sync.flush();
    await settle();
    expect(api.reports).toEqual([]);

    store.toggleSidebar();
    sync.flush();
    await settle();

    expect(api.reports).toHaveLength(1);
    expect(scheduler.waiting).toBe(false);
  });

  it("does not report a state that is back where the main process has it", async () => {
    const { api, store, scheduler } = await started();

    store.toggleSidebar();
    store.focusTab("t1"); // no change
    scheduler.fire();
    await settle();
    expect(api.reports).toHaveLength(1);
  });

  it("does not report changes that are not part of the window, such as sessions", async () => {
    const { api, store, scheduler } = await started();

    store.sessionStateChanged("s1", "Exited", 0);
    store.markCoreClosed();
    await settle();

    expect(scheduler.scheduled).toEqual([]);
    expect(api.reports).toEqual([]);
  });

  it("reports nothing and says why when the main process has no layout for the window", async () => {
    const api = new FakeApi();
    const errors: string[] = [];
    const store = newStore();
    const scheduler = new FakeScheduler();
    const sync = startLayoutSync(store, api, (message) => errors.push(message), {
      schedule: scheduler.schedule,
    });

    api.reject(new Error("[not_found] This window has no layout"));
    await sync.ready;
    store.openSession("s1");
    scheduler.fire();
    await settle();

    // Reporting from an unloaded store could replace the stored layout with an empty one.
    expect(api.reports).toEqual([]);
    expect(errors).toEqual(["[not_found] This window has no layout"]);
  });

  it("names a rejected report", async () => {
    const errors: string[] = [];
    const { api, store, scheduler } = await started((message) => errors.push(message));

    api.reportError = new Error("[bad_request] layout is invalid");
    store.toggleSidebar();
    scheduler.fire();
    await settle();

    expect(errors).toEqual(["[bad_request] layout is invalid"]);
  });

  it("does nothing after dispose, also for an answer that arrives later", async () => {
    const api = new FakeApi();
    const store = newStore();
    const scheduler = new FakeScheduler();
    const sync = startLayoutSync(store, api, () => {}, { schedule: scheduler.schedule });
    sync.dispose();
    api.resolve(saved);
    await sync.ready;

    expect(store.getState().window.id).not.toBe("w-main");
    store.toggleSidebar();
    scheduler.fire();
    await settle();
    expect(api.reports).toEqual([]);
  });

  it("drops a waiting report on dispose", async () => {
    const { api, store, scheduler, sync } = await started();

    store.toggleSidebar();
    sync.dispose();
    scheduler.fire();
    await settle();

    expect(api.reports).toEqual([]);
  });
});
