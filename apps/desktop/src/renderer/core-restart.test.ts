// A restart of the core as one window sees it (#130): store, `connectStore` and one `TerminalController` per pane,
// mounted the way `PaneTree` does (a new generation mounts every view anew, the active pane claims after a
// restart), against a core double that keeps the input lock like the real one (the first view writes).
import type { SessionId, SessionInfo, SessionState, TerminalSize, ViewId } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import type { AttachedView, BridgeEvent, TermdockApi } from "../shared/bridge.js";
import { connectStore } from "./session-sync.js";
import { claimsAfterRestart } from "./pane-layout.js";
import { isAttachable } from "./session-display.js";
import { TerminalController } from "./terminal-controller.js";
import type { TerminalSurface, ViewStatus } from "./terminal-controller.js";
import { panesOf, UiStore } from "./ui-store.js";

function session(id: string, state: SessionState): SessionInfo {
  return {
    id,
    name: id,
    state,
    launch: { backend: "wsl", cwd: "~" },
    size: { cols: 80, rows: 24 },
    loggingEnabled: false,
    createdAt: `2026-11-19T10:00:0${id.length}Z`,
    updatedAt: "2026-11-19T10:00:00Z",
  };
}

/** The core behind the bridge: views per session, the first one writes, `claimWriter` moves the writer. */
class FakeCoreApi implements Pick<
  TermdockApi,
  | "onEvent"
  | "listSessions"
  | "listWorkspaces"
  | "coreStatus"
  | "coreConnection"
  | "attach"
  | "detach"
  | "input"
  | "resize"
  | "claimWriter"
> {
  sessions: SessionInfo[] = [];
  readonly attached: Array<{ viewId: ViewId; sessionId: SessionId }> = [];
  private readonly views = new Map<ViewId, SessionId>();
  private readonly writers = new Map<SessionId, ViewId>();
  private readonly listeners = new Set<(event: BridgeEvent) => void>();
  private next = 0;

  onEvent(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async listSessions(): Promise<SessionInfo[]> {
    return this.sessions;
  }
  async listWorkspaces() {
    return [];
  }
  async coreStatus() {
    return { backendUnavailable: [] };
  }
  async coreConnection() {
    return { closed: false, restarting: false };
  }
  async attach(sessionId: SessionId, size: TerminalSize): Promise<AttachedView> {
    const viewId = `v${++this.next}`;
    this.views.set(viewId, sessionId);
    if (!this.writers.has(sessionId)) this.writers.set(sessionId, viewId);
    this.attached.push({ viewId, sessionId });
    return {
      viewId,
      size,
      writerViewId: this.writers.get(sessionId)!,
      snapshot: new TextEncoder().encode("old output"),
      outputSeq: 0,
    };
  }
  async detach(viewId: ViewId): Promise<void> {
    const sessionId = this.views.get(viewId);
    if (sessionId === undefined) throw new Error("[not_found] unknown view");
    this.views.delete(viewId);
    if (this.writers.get(sessionId) === viewId) {
      this.writers.delete(sessionId);
      this.emit({ kind: "writerChanged", sessionId });
    }
  }
  async input(): Promise<void> {}
  async resize(): Promise<void> {}
  async claimWriter(viewId: ViewId): Promise<void> {
    const sessionId = this.views.get(viewId);
    if (sessionId === undefined) throw new Error("[not_found] unknown view");
    this.writers.set(sessionId, viewId);
    this.emit({ kind: "writerChanged", sessionId, writerViewId: viewId });
  }
  /** The core process ends: its views and writers are gone. */
  crash(): void {
    this.views.clear();
    this.writers.clear();
    this.emit({ kind: "coreClosed", restarting: true });
  }
  emit(event: BridgeEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function surface(): TerminalSurface {
  let cols = 80;
  let rows = 24;
  return {
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },
    write: () => {},
    reset: () => {},
    resize: (c, r) => {
      cols = c;
      rows = r;
    },
    showCursor: () => {},
    proposeSize: () => ({ cols: 100, rows: 30 }),
    setFontSize: () => {},
    measure: () => undefined,
    onData: () => () => {},
    onKey: () => {},
    getSelection: () => "",
    paste: () => {},
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

/** The views of a window as `PaneTree` mounts them: one per pane of an attachable session, anew per generation. */
class Window {
  readonly statuses = new Map<string, ViewStatus>();
  private controllers = new Map<string, TerminalController>();
  /** Like `PaneTree`: the generation each pane was last committed with. */
  private mountedIn = new Map<string, number>();
  private generation = -1;

  constructor(
    private readonly store: UiStore,
    private readonly api: FakeCoreApi,
    private readonly focused: boolean,
  ) {}

  /** What a render does: mounts every pane again when the generation changed, and panes that are new. */
  async render(): Promise<void> {
    const state = this.store.getState();
    if (state.coreGeneration !== this.generation) {
      this.generation = state.coreGeneration;
      for (const controller of this.controllers.values()) await controller.dispose();
      this.controllers.clear();
      this.statuses.clear();
    }
    for (const tab of state.window.tabs) {
      for (const pane of panesOf(tab.root)) {
        if (this.controllers.has(pane.id)) continue;
        const known = state.sessions.find((each) => each.id === pane.sessionId);
        if (!known || !isAttachable(known.state)) continue;
        const active = pane.id === tab.activePaneId && tab.id === state.window.activeTabId;
        const claim = claimsAfterRestart(this.mountedIn.get(pane.id), state.coreGeneration);
        const controller = new TerminalController(
          this.api,
          surface(),
          (status) => this.statuses.set(pane.id, status),
          { scheduleLayout: () => () => {}, claimOnOpen: () => claim && active && this.focused },
        );
        this.controllers.set(pane.id, controller);
        await controller.open(pane.sessionId);
      }
    }
    this.mountedIn = new Map(
      state.window.tabs.flatMap((tab) =>
        panesOf(tab.root).map((pane) => [pane.id, state.coreGeneration] as const),
      ),
    );
  }

  roles(): Record<string, string> {
    return Object.fromEntries([...this.statuses].map(([paneId, status]) => [paneId, status.role]));
  }
}

describe("restart of the core in the renderer (#130)", () => {
  it("attaches every pane again after coreRestarted, with exactly one writer: the active pane", async () => {
    const api = new FakeCoreApi();
    api.sessions = [session("s1", "Detached"), session("lost", "Detached")];
    let n = 0;
    const store = new UiStore({ newId: () => `id${++n}` });
    const connection = connectStore(store, api, () => {});
    await connection.ready;
    const tabId = store.openSession("s1")!;
    const left = store.getState().window.tabs[0]!.activePaneId;
    // Shift+click: the same session reads in a second pane, the left one keeps writing and stays active.
    const right = store.splitPane(tabId, left, "row", "s1")!;
    store.openSession("lost", { forceNew: true });
    store.focusTab(tabId);
    const win = new Window(store, api, true);
    await win.render();
    expect(win.roles()).toEqual({
      [left]: "writer",
      [right]: "reader",
      [panesOf(store.getState().window.tabs[1]!.root)[0]!.id]: "writer",
    });
    // The user made the right pane active (a press, no claim).
    store.focusPane(tabId, right);

    api.crash();
    expect(Object.values(win.roles())).toEqual(["restarting", "restarting", "restarting"]);
    // The new core lost one session in the reconcile.
    api.sessions = [session("s1", "Detached"), session("lost", "Interrupted")];
    const attachedBefore = api.attached.length;
    api.emit({ kind: "coreRestarted" });
    await settle();
    await win.render();
    await settle();

    expect(store.getState().coreGeneration).toBe(1);
    const again = api.attached.slice(attachedBefore);
    // Both panes of s1 attached again; the pane of the lost session shows its placeholder instead.
    expect(again.map((each) => each.sessionId)).toEqual(["s1", "s1"]);
    expect(win.roles()).toEqual({ [left]: "reader", [right]: "writer" });
  });

  it("leaves the writer to the first view when its window has no focus", async () => {
    const api = new FakeCoreApi();
    api.sessions = [session("s1", "Detached")];
    const store = new UiStore({
      newId: (() =>
        (
          (n) => () =>
            `id${++n}`
        )(0))(),
    });
    await connectStore(store, api, () => {}).ready;
    const tabId = store.openSession("s1")!;
    const left = store.getState().window.tabs[0]!.activePaneId;
    const right = store.splitPane(tabId, left, "row", "s1")!;
    store.focusPane(tabId, right);
    const win = new Window(store, api, false);
    await win.render();

    api.crash();
    api.emit({ kind: "coreRestarted" });
    await settle();
    await win.render();
    await settle();

    const roles = Object.values(win.roles());
    expect(roles.filter((role) => role === "writer")).toHaveLength(1);
    expect(win.roles()).toEqual({ [left]: "writer", [right]: "reader" });
  });

  it("lets a pane opened after the restart join as a reader, also when it is active", async () => {
    const api = new FakeCoreApi();
    api.sessions = [session("s1", "Detached")];
    let n = 0;
    const store = new UiStore({ newId: () => `id${++n}` });
    await connectStore(store, api, () => {}).ready;
    const tabId = store.openSession("s1")!;
    const left = store.getState().window.tabs[0]!.activePaneId;
    const win = new Window(store, api, true);
    await win.render();
    api.crash();
    api.emit({ kind: "coreRestarted" });
    await settle();
    await win.render();
    await settle();
    expect(win.roles()).toEqual({ [left]: "writer" });

    // Later the user shows the same session in a second pane and makes it active.
    const right = store.splitPane(tabId, left, "row", "s1")!;
    store.focusPane(tabId, right);
    await win.render();
    await settle();

    expect(win.roles()).toEqual({ [left]: "writer", [right]: "reader" });
  });
});
