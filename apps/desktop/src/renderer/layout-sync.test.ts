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

describe("startLayoutSync", () => {
  it("loads the window of the main process into the store before anything is reported", async () => {
    const api = new FakeApi();
    const store = newStore();
    const sync = startLayoutSync(store, api, () => {});

    // A change before the answer must neither be reported nor survive: the main process knows the real layout.
    store.openSession("s1");
    expect(api.reports).toEqual([]);
    api.resolve(saved);
    await sync.ready;

    expect(store.getState().window).toEqual(saved);
    expect(api.reports).toEqual([]);
  });

  it("reports the part of the window after every change, without id and geometry", async () => {
    const api = new FakeApi();
    const store = newStore();
    const sync = startLayoutSync(store, api, () => {});
    api.resolve(saved);
    await sync.ready;

    store.toggleSidebar();
    store.openSession("s1", { forceNew: true });
    await settle();

    expect(api.reports).toHaveLength(2);
    expect(api.reports[0]).toEqual({ sidebarVisible: true, activeTabId: "t1", tabs: saved.tabs });
    expect(api.reports[1]!.tabs).toHaveLength(2);
    expect(api.reports[1]).not.toHaveProperty("id");
    expect(api.reports[1]).not.toHaveProperty("bounds");
  });

  it("does not report changes that are not part of the window, such as sessions", async () => {
    const api = new FakeApi();
    const store = newStore();
    const sync = startLayoutSync(store, api, () => {});
    api.resolve(saved);
    await sync.ready;

    store.sessionStateChanged("s1", "Exited", 0);
    store.markCoreClosed();
    await settle();

    expect(api.reports).toEqual([]);
  });

  it("reports nothing and says why when the main process has no layout for the window", async () => {
    const api = new FakeApi();
    const errors: string[] = [];
    const store = newStore();
    const sync = startLayoutSync(store, api, (message) => errors.push(message));

    api.reject(new Error("[not_found] This window has no layout"));
    await sync.ready;
    store.openSession("s1");
    await settle();

    // Reporting from an unloaded store could replace the stored layout with an empty one.
    expect(api.reports).toEqual([]);
    expect(errors).toEqual(["[not_found] This window has no layout"]);
  });

  it("names a rejected report", async () => {
    const api = new FakeApi();
    const errors: string[] = [];
    const store = newStore();
    const sync = startLayoutSync(store, api, (message) => errors.push(message));
    api.resolve(saved);
    await sync.ready;

    api.reportError = new Error("[bad_request] layout is invalid");
    store.toggleSidebar();
    await settle();

    expect(errors).toEqual(["[bad_request] layout is invalid"]);
  });

  it("does nothing after dispose, also for an answer that arrives later", async () => {
    const api = new FakeApi();
    const store = newStore();
    const sync = startLayoutSync(store, api, () => {});
    sync.dispose();
    api.resolve(saved);
    await sync.ready;

    expect(store.getState().window.id).not.toBe("w-main");
    store.toggleSidebar();
    await settle();
    expect(api.reports).toEqual([]);
  });

  it("stops reporting on dispose", async () => {
    const api = new FakeApi();
    const store = newStore();
    const sync = startLayoutSync(store, api, () => {});
    api.resolve(saved);
    await sync.ready;

    sync.dispose();
    store.toggleSidebar();
    await settle();

    expect(api.reports).toEqual([]);
  });
});
