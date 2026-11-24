import { IpcError } from "@termdock/core";
import type { EventListener } from "@termdock/core";
import { DEFAULT_SETTINGS } from "@termdock/protocol";
import type { EventMap, EventName, LaunchProfile, Method, SessionInfo } from "@termdock/protocol";
import { describe, expect, it, vi } from "vitest";
import type { BridgeEvent } from "../shared/bridge.js";
import { DesktopBridge } from "./bridge.js";
import type { CorePort } from "./core-connection.js";

interface SentRequest {
  method: Method;
  params: unknown;
  payload: Uint8Array | undefined;
}

type Answer = { result: unknown; payload?: Uint8Array } | IpcError;

/** Core double: records requests, answers from a script per method and emits events on demand. */
class FakeCore implements CorePort {
  readonly requests: SentRequest[] = [];
  readonly answers = new Map<Method, Answer>();
  private readonly listeners = new Map<EventName, Set<(data: never, payload: Uint8Array) => void>>();
  private readonly closeListeners = new Set<() => void>();
  /** When set, `request` calls it after answering, in the same turn (events right behind a response). */
  afterAnswer: (() => void) | undefined;

  request = (async (method: Method, params: unknown, payload?: Uint8Array) => {
    this.requests.push({ method, params, payload });
    const answer = this.answers.get(method) ?? { result: {} };
    if (answer instanceof IpcError) throw answer;
    const value = { result: answer.result, payload: answer.payload ?? new Uint8Array() };
    const after = this.afterAnswer;
    this.afterAnswer = undefined;
    // Like the client: the response resolves, and the event frame behind it is handled synchronously.
    queueMicrotask(() => after?.());
    return value;
  }) as CorePort["request"];

  on<E extends EventName>(event: E, listener: EventListener<E>): { dispose: () => void } {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (data: never, payload: Uint8Array) => void);
    this.listeners.set(event, set);
    return { dispose: () => set.delete(listener as (data: never, payload: Uint8Array) => void) };
  }

  onClose(listener: () => void): { dispose: () => void } {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  async close(): Promise<void> {
    for (const listener of this.closeListeners) listener();
  }

  emit<E extends EventName>(event: E, data: EventMap[E], payload: Uint8Array = new Uint8Array()): void {
    for (const listener of this.listeners.get(event) ?? []) listener(data as never, payload);
  }

  sent(method: Method): SentRequest[] {
    return this.requests.filter((r) => r.method === method);
  }
}

class FakeWindow {
  readonly events: BridgeEvent[] = [];
  constructor(readonly id: number) {}
  send(event: BridgeEvent): void {
    this.events.push(event);
  }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(): { core: FakeCore; bridge: DesktopBridge; a: FakeWindow; b: FakeWindow } {
  const core = new FakeCore();
  const bridge = new DesktopBridge(core);
  const a = new FakeWindow(1);
  const b = new FakeWindow(2);
  bridge.addWindow(a);
  bridge.addWindow(b);
  return { core, bridge, a, b };
}

async function attach(
  core: FakeCore,
  bridge: DesktopBridge,
  win: FakeWindow,
  sessionId: string,
  viewId: string,
) {
  core.answers.set("session.attach", {
    result: { viewId, size: { cols: 80, rows: 24 }, writerViewId: viewId },
    payload: bytes(`snapshot of ${sessionId}`),
  });
  return bridge.call(win.id, { method: "attach", sessionId, size: { cols: 100, rows: 30 } });
}

describe("DesktopBridge calls", () => {
  it("lists sessions through the core", async () => {
    const { core, bridge, a } = setup();
    const sessions = [{ id: "s1" }] as SessionInfo[];
    core.answers.set("session.list", { result: { sessions } });

    const result = await bridge.call(a.id, { method: "listSessions" });

    expect(result).toEqual({ ok: true, value: sessions });
  });

  it("rejects a call outside the list without contacting the core", async () => {
    const { core, bridge, a } = setup();

    const result = await bridge.call(a.id, { method: "core.shutdown", params: { stopSessions: true } });

    expect(result).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(core.requests).toEqual([]);
  });

  it.each([
    ["no object", "listSessions"],
    ["attach without size", { method: "attach", sessionId: "s1" }],
    ["resize with a fraction", { method: "resize", viewId: "v1", size: { cols: 80.5, rows: 24 } }],
    ["input that is no string", { method: "input", viewId: "v1", data: [1, 2] }],
    ["createSession without launch", { method: "createSession", params: { name: "x" } }],
  ])("rejects malformed arguments (%s) with bad_request", async (_name, call) => {
    const { core, bridge, a } = setup();

    const result = await bridge.call(a.id, call);

    expect(result).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(core.requests).toEqual([]);
  });

  it("passes the core's error code to the renderer", async () => {
    const { core, bridge, a } = setup();
    core.answers.set("session.attach", new IpcError("not_found", "Unknown session s9"));

    const result = await bridge.call(a.id, {
      method: "attach",
      sessionId: "s9",
      size: { cols: 80, rows: 24 },
    });

    expect(result).toEqual({ ok: false, error: { code: "not_found", message: "Unknown session s9" } });
  });

  it("creates a session with the given parameters", async () => {
    const { core, bridge, a } = setup();
    const session = { id: "s1" } as SessionInfo;
    core.answers.set("session.create", { result: { session } });
    const params = { name: "WSL", launch: { backend: "wsl" as const, cwd: "~" } };

    const result = await bridge.call(a.id, { method: "createSession", params });

    expect(result).toEqual({ ok: true, value: session });
    expect(core.sent("session.create")[0]?.params).toEqual(params);
  });

  it("passes the core's session.created to every window (issue #46)", () => {
    const { core, a, b } = setup();
    const session = { id: "s1" } as SessionInfo;

    core.emit("session.created", { session });

    expect(a.events).toEqual([{ kind: "sessionCreated", session }]);
    expect(b.events).toEqual([{ kind: "sessionCreated", session }]);
  });

  it("passes the core's error when it refuses session.create", async () => {
    const { core, bridge, a, b } = setup();
    core.answers.set("session.create", new IpcError("backend_unavailable", "WSL is down"));

    const result = await bridge.call(a.id, {
      method: "createSession",
      params: { name: "WSL", launch: { backend: "wsl", cwd: "~" } },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "backend_unavailable" } });
    expect(a.events).toEqual([]);
    expect(b.events).toEqual([]);
  });

  it("makes no announcement of its own after session.create", async () => {
    const { core, bridge, a, b } = setup();
    const session = { id: "s1" } as SessionInfo;
    core.answers.set("session.create", { result: { session } });

    await bridge.call(a.id, {
      method: "createSession",
      params: { name: "WSL", launch: { backend: "wsl", cwd: "~" } },
    });

    expect(a.events).toEqual([]);
    expect(b.events).toEqual([]);
  });

  it("returns the core status", async () => {
    const { core, bridge, a } = setup();
    core.answers.set("core.status", { result: { backendUnavailable: ["wsl"] } });

    const result = await bridge.call(a.id, { method: "coreStatus" });

    expect(result).toEqual({ ok: true, value: { backendUnavailable: ["wsl"] } });
    expect(core.sent("core.status")).toHaveLength(1);
  });

  it("attaches a view and returns the snapshot bytes", async () => {
    const { core, bridge, a } = setup();

    const result = await attach(core, bridge, a, "s1", "v1");

    expect(result).toEqual({
      ok: true,
      value: {
        viewId: "v1",
        size: { cols: 80, rows: 24 },
        writerViewId: "v1",
        snapshot: bytes("snapshot of s1"),
        outputSeq: 0,
      },
    });
    expect(core.sent("session.attach")[0]?.params).toEqual({
      sessionId: "s1",
      size: { cols: 100, rows: 30 },
    });
  });

  it("sends input of an own view as UTF-8 bytes and skips empty input", async () => {
    const { core, bridge, a } = setup();
    await attach(core, bridge, a, "s1", "v1");

    await bridge.call(a.id, { method: "input", viewId: "v1", data: "ls --color\r" });
    await bridge.call(a.id, { method: "input", viewId: "v1", data: "" });

    expect(core.sent("session.input")).toEqual([
      { method: "session.input", params: { viewId: "v1" }, payload: bytes("ls --color\r") },
    ]);
  });

  it("forwards resize and claimWriter of an own view", async () => {
    const { core, bridge, a } = setup();
    await attach(core, bridge, a, "s1", "v1");

    await bridge.call(a.id, { method: "resize", viewId: "v1", size: { cols: 120, rows: 40 } });
    await bridge.call(a.id, { method: "claimWriter", viewId: "v1" });

    expect(core.sent("session.resize")[0]?.params).toEqual({ viewId: "v1", size: { cols: 120, rows: 40 } });
    expect(core.sent("session.claimWriter")[0]?.params).toEqual({ viewId: "v1" });
  });
});

describe("DesktopBridge view ownership", () => {
  it.each([
    ["input", { method: "input", viewId: "v1", data: "x" }],
    ["resize", { method: "resize", viewId: "v1", size: { cols: 80, rows: 24 } }],
    ["claimWriter", { method: "claimWriter", viewId: "v1" }],
    ["detach", { method: "detach", viewId: "v1" }],
  ])("refuses %s for a view of another window with not_found", async (_name, call) => {
    const { core, bridge, a, b } = setup();
    await attach(core, bridge, a, "s1", "v1");
    const before = core.requests.length;

    const result = await bridge.call(b.id, call);

    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(core.requests.length).toBe(before);
  });

  it("detaches the views of a closed window and keeps the session", async () => {
    const { core, bridge, a } = setup();
    await attach(core, bridge, a, "s1", "v1");
    await attach(core, bridge, a, "s2", "v2");

    await bridge.removeWindow(a.id);

    expect(core.sent("session.detach").map((r) => r.params)).toEqual([{ viewId: "v1" }, { viewId: "v2" }]);
    expect(core.sent("session.kill")).toEqual([]);
    expect(bridge.viewsOf(a.id)).toEqual([]);
  });

  it("detaches the views of a reloaded or crashed renderer and keeps serving the window", async () => {
    const { core, bridge, a } = setup();
    await attach(core, bridge, a, "s1", "v1");

    await bridge.resetWindow(a.id);
    await attach(core, bridge, a, "s1", "v2");
    core.emit("session.output", { sessionId: "s1" }, bytes("x"));

    expect(core.sent("session.detach").map((r) => r.params)).toEqual([{ viewId: "v1" }]);
    expect(bridge.viewsOf(a.id)).toEqual(["v2"]);
    expect(a.events).toEqual([{ kind: "output", sessionId: "s1", seq: 1, data: bytes("x") }]);
  });

  it("gives back a view whose attach was sent by the renderer before its reload", async () => {
    const { core, bridge, a } = setup();
    let answer: (() => void) | undefined;
    const inner = core.request;
    core.request = ((method: Method, params: never, payload?: Uint8Array) =>
      method === "session.attach"
        ? new Promise((resolve) => {
            answer = () =>
              resolve({ result: { viewId: "old", size: { cols: 80, rows: 24 } }, payload: new Uint8Array() });
          })
        : inner(method, params, payload)) as CorePort["request"];

    const pending = bridge.call(a.id, { method: "attach", sessionId: "s1", size: { cols: 80, rows: 24 } });
    await bridge.resetWindow(a.id);
    answer?.();

    expect(await pending).toMatchObject({ ok: false, error: { code: "closed" } });
    expect(core.sent("session.detach").map((r) => r.params)).toEqual([{ viewId: "old" }]);
    expect(bridge.viewsOf(a.id)).toEqual([]);
  });

  it("forgets a view after detach", async () => {
    const { core, bridge, a } = setup();
    await attach(core, bridge, a, "s1", "v1");

    await bridge.call(a.id, { method: "detach", viewId: "v1" });
    const again = await bridge.call(a.id, { method: "input", viewId: "v1", data: "x" });

    expect(again).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("DesktopBridge events", () => {
  it("sends output of a session only to windows with a view of it, once per window", async () => {
    const { core, bridge, a, b } = setup();
    await attach(core, bridge, a, "s1", "v1");
    await attach(core, bridge, a, "s1", "v1b");
    await attach(core, bridge, b, "s2", "v2");

    core.emit("session.output", { sessionId: "s1" }, bytes("hello"));

    expect(a.events).toEqual([{ kind: "output", sessionId: "s1", seq: 1, data: bytes("hello") }]);
    expect(b.events).toEqual([]);
  });

  it("numbers the output of each session on its own", async () => {
    const { core, bridge, a } = setup();
    await attach(core, bridge, a, "s1", "v1");
    await attach(core, bridge, a, "s2", "v2");

    core.emit("session.output", { sessionId: "s1" }, bytes("a"));
    core.emit("session.output", { sessionId: "s2" }, bytes("b"));
    core.emit("session.output", { sessionId: "s1" }, bytes("c"));

    expect(a.events.map((e) => (e.kind === "output" ? `${e.sessionId}:${e.seq}` : e.kind))).toEqual([
      "s1:1",
      "s2:1",
      "s1:2",
    ]);
  });

  it("marks in the attach answer up to which output the snapshot reaches", async () => {
    const { core, bridge, a } = setup();
    await attach(core, bridge, a, "s1", "v1");
    core.emit("session.output", { sessionId: "s1" }, bytes("before"));
    // Held by the core during the attach and sent right behind the answer; the snapshot already has it.
    core.afterAnswer = () => core.emit("session.output", { sessionId: "s1" }, bytes("held"));

    const second = await attach(core, bridge, a, "s1", "v1b");
    await flush();
    core.emit("session.output", { sessionId: "s1" }, bytes("live"));

    expect(second).toMatchObject({ ok: true, value: { outputSeq: 2 } });
    expect(a.events.map((e) => (e.kind === "output" ? e.seq : 0))).toEqual([1, 2, 3]);
  });

  it("takes number and mark from the core, also for held output read after the answer (issue #34)", async () => {
    const { core, bridge, a } = setup();
    await attach(core, bridge, a, "s1", "v1");
    core.emit("session.output", { sessionId: "s1", seq: 4 }, bytes("before"));
    core.answers.set("session.attach", {
      result: { viewId: "v1b", size: { cols: 80, rows: 24 }, writerViewId: "v1", outputSeq: 5 },
    });

    const second = await bridge.call(a.id, {
      method: "attach",
      sessionId: "s1",
      size: { cols: 100, rows: 30 },
    });
    await flush();
    // Held by the core during the attach, but read by the main only after it handled the answer.
    core.emit("session.output", { sessionId: "s1", seq: 5 }, bytes("held"));
    core.emit("session.output", { sessionId: "s1", seq: 6 }, bytes("live"));

    expect(second).toMatchObject({ ok: true, value: { outputSeq: 5 } });
    expect(a.events.map((e) => (e.kind === "output" ? e.seq : 0))).toEqual([4, 5, 6]);
  });

  it("delivers output that arrives right behind the attach response", async () => {
    const { core, bridge, a } = setup();
    core.afterAnswer = () => core.emit("session.output", { sessionId: "s1" }, bytes("early"));

    await attach(core, bridge, a, "s1", "v1");
    await flush();

    expect(a.events).toEqual([{ kind: "output", sessionId: "s1", seq: 1, data: bytes("early") }]);
  });

  it("routes resize and writer changes to the windows of the session", async () => {
    const { core, bridge, a, b } = setup();
    await attach(core, bridge, a, "s1", "v1");

    core.emit("session.resized", { sessionId: "s1", size: { cols: 90, rows: 20 } });
    core.emit("view.writerChanged", { sessionId: "s1", writerViewId: "v9" });

    expect(a.events).toEqual([
      { kind: "resized", sessionId: "s1", size: { cols: 90, rows: 20 } },
      { kind: "writerChanged", sessionId: "s1", writerViewId: "v9" },
    ]);
    expect(b.events).toEqual([]);
  });

  it("sends state changes to every window", async () => {
    const { core, a, b } = setup();

    core.emit("session.stateChanged", { sessionId: "s1", state: "Exited", lastExitCode: 0 });

    const expected = { kind: "stateChanged", sessionId: "s1", state: "Exited", lastExitCode: 0 };
    expect(a.events).toEqual([expected]);
    expect(b.events).toEqual([expected]);
  });

  it("passes the warnings of a state change on to every window (issue #113)", async () => {
    const { core, a, b } = setup();
    const warnings = [{ code: "cwd_missing", path: "/srv/api", distro: "Ubuntu" }];

    core.emit("session.stateChanged", { sessionId: "s1", state: "Running", warnings });

    const expected = { kind: "stateChanged", sessionId: "s1", state: "Running", warnings };
    expect(a.events).toEqual([expected]);
    expect(b.events).toEqual([expected]);
  });

  it("stops sending to a removed window and tells the others when the core connection ends", async () => {
    const { core, bridge, a, b } = setup();
    await bridge.removeWindow(a.id);

    await core.close();

    expect(a.events).toEqual([]);
    expect(b.events).toEqual([{ kind: "coreClosed", restarting: false }]);
  });
});

describe("DesktopBridge core restart (#130)", () => {
  function withRestarts(restarting: boolean, disconnected = false) {
    const core = new FakeCore();
    const restarts = { restarting: () => restarting, disconnected: () => disconnected, restart: vi.fn() };
    const bridge = new DesktopBridge(core, undefined, undefined, restarts);
    const a = new FakeWindow(1);
    const b = new FakeWindow(2);
    bridge.addWindow(a);
    bridge.addWindow(b);
    return { core, bridge, restarts, a, b };
  }

  it("tells every window whether the core is restarted when the connection ends", async () => {
    const { core, a, b } = withRestarts(true);

    await core.close();

    expect(a.events).toEqual([{ kind: "coreClosed", restarting: true }]);
    expect(b.events).toEqual([{ kind: "coreClosed", restarting: true }]);
  });

  it("forgets the views of the old core: their later calls do not reach the new one", async () => {
    const { core, bridge, a } = withRestarts(true);
    await attach(core, bridge, a, "s1", "v1");

    await core.close();
    core.requests.length = 0;
    const detached = await bridge.call(a.id, { method: "detach", viewId: "v1" });
    const typed = await bridge.call(a.id, { method: "input", viewId: "v1", data: "ls\r" });

    expect(bridge.viewsOf(a.id)).toEqual([]);
    expect(detached).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(typed).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(core.requests).toEqual([]);
  });

  it("sends output of the new core only to windows that attach again", async () => {
    const { core, bridge, a, b } = withRestarts(true);
    await attach(core, bridge, a, "s1", "v1");
    await attach(core, bridge, b, "s1", "v2");
    await core.close();
    a.events.length = 0;
    b.events.length = 0;

    await attach(core, bridge, a, "s1", "v3");
    core.emit("session.output", { sessionId: "s1", seq: 1 }, bytes("after"));

    expect(a.events).toEqual([{ kind: "output", sessionId: "s1", seq: 1, data: bytes("after") }]);
    expect(b.events).toEqual([]);
  });

  it("announces a restarted core and a given-up restart to every window", () => {
    const { bridge, a, b } = withRestarts(false);

    bridge.coreRestarted();
    bridge.coreRestartFailed();
    bridge.coreRestarting();

    const expected = [
      { kind: "coreRestarted" },
      { kind: "coreClosed", restarting: false },
      { kind: "coreClosed", restarting: true },
    ];
    expect(a.events).toEqual(expected);
    expect(b.events).toEqual(expected);
  });

  it("answers a page that asks for the connection, without asking the core", async () => {
    const gone = withRestarts(false, true);
    const back = withRestarts(false, false);
    const restarting = withRestarts(true, true);

    expect(await gone.bridge.call(1, { method: "coreConnection" })).toEqual({
      ok: true,
      value: { closed: true, restarting: false },
    });
    expect(await back.bridge.call(1, { method: "coreConnection" })).toEqual({
      ok: true,
      value: { closed: false, restarting: false },
    });
    expect(await restarting.bridge.call(1, { method: "coreConnection" })).toEqual({
      ok: true,
      value: { closed: true, restarting: true },
    });
    expect(gone.core.requests).toEqual([]);
  });

  it("restarts the core on the button without sending anything to the core", async () => {
    const { core, bridge, restarts, a } = withRestarts(false);

    const result = await bridge.call(a.id, { method: "restartCore" });

    expect(result).toEqual({ ok: true, value: null });
    expect(restarts.restart).toHaveBeenCalledTimes(1);
    expect(core.requests).toEqual([]);
  });
});

describe("DesktopBridge layout calls (#29)", () => {
  const part = {
    sidebarVisible: false,
    tabs: [{ id: "t1", root: { kind: "pane", id: "p1", sessionId: "s1" }, activePaneId: "p1" }],
    activeTabId: "t1",
  };

  /** Stand-in for the coordinator: one window per window id, the report is recorded or rejected. */
  function withLayouts() {
    const { core, a, b } = setup();
    const reports: Array<[number, unknown]> = [];
    const layouts = {
      windowOf: (windowId: number) => (windowId === a.id ? { id: "w-a", tabs: [] } : undefined),
      report: (windowId: number, reported: unknown) => {
        if (JSON.stringify(reported).includes("bad")) throw new IpcError("bad_request", "layout is invalid");
        reports.push([windowId, reported]);
      },
    };
    const bridge = new DesktopBridge(core, layouts);
    bridge.addWindow(a);
    bridge.addWindow(b);
    return { core, bridge, a, b, reports };
  }

  it("gives a window the layout the main process holds for it, without asking the core", async () => {
    const { core, bridge, a } = withLayouts();

    const result = await bridge.call(a.id, { method: "windowLayout" });

    expect(result).toEqual({ ok: true, value: { id: "w-a", tabs: [] } });
    expect(core.requests).toEqual([]);
  });

  it("answers not_found for a window without layout", async () => {
    const { bridge, b } = withLayouts();
    expect(await bridge.call(b.id, { method: "windowLayout" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("hands a reported part to the main process under the id of the calling window", async () => {
    const { bridge, a, reports } = withLayouts();

    const result = await bridge.call(a.id, { method: "reportLayout", window: part });

    expect(result).toEqual({ ok: true, value: null });
    expect(reports).toEqual([[a.id, part]]);
  });

  it("passes the rejection of an invalid layout on as bad_request", async () => {
    const { bridge, a, reports } = withLayouts();

    const result = await bridge.call(a.id, {
      method: "reportLayout",
      window: { ...part, tabs: [{ id: "bad" }] },
    });

    expect(result).toEqual({ ok: false, error: { code: "bad_request", message: "layout is invalid" } });
    expect(reports).toEqual([]);
  });

  it.each([
    ["a missing window", { method: "reportLayout" }],
    ["a window that is not an object", { method: "reportLayout", window: "x" }],
    ["tabs that are not an array", { method: "reportLayout", window: { tabs: 3 } }],
    ["an id of the window", { method: "reportLayout", window: { id: "other", tabs: [] } }],
    ["bounds of the window", { method: "reportLayout", window: { tabs: [], bounds: {} } }],
    ["maximized", { method: "reportLayout", window: { tabs: [], maximized: true } }],
    ["an unknown key", { method: "reportLayout", window: { tabs: [], extra: 1 } }],
  ])("refuses %s with bad_request", async (_name, call) => {
    const { bridge, a, reports } = withLayouts();

    expect(await bridge.call(a.id, call)).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(reports).toEqual([]);
  });

  it("refuses the layout calls of a bridge without layouts", async () => {
    const { bridge, a } = setup();
    expect(await bridge.call(a.id, { method: "windowLayout" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("DesktopBridge quit answers (#60)", () => {
  function withQuit() {
    const { core, a, b } = setup();
    const answers: Array<[number, string, unknown]> = [];
    const shown: Array<[number, string]> = [];
    const quit = {
      answer: (windowId: number, requestId: string, answer: unknown) => {
        if (requestId !== "q1") throw new IpcError("not_found", "no open quit question");
        answers.push([windowId, requestId, answer]);
      },
      ack: (windowId: number, requestId: string) => {
        if (requestId !== "q1") throw new IpcError("not_found", "no open quit question");
        shown.push([windowId, requestId]);
      },
    };
    const bridge = new DesktopBridge(core, undefined, quit);
    bridge.addWindow(a);
    return { core, bridge, a, b, answers, shown };
  }

  it("passes the confirmation that the dialog is shown on, and refuses a foreign id", async () => {
    const { core, bridge, a, shown } = withQuit();
    expect(await bridge.call(a.id, { method: "quitShown", requestId: "q1" })).toEqual({
      ok: true,
      value: null,
    });
    expect(shown).toEqual([[a.id, "q1"]]);
    expect(await bridge.call(a.id, { method: "quitShown", requestId: "x" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await bridge.call(a.id, { method: "quitShown", requestId: "" })).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    expect(core.requests).toEqual([]);
  });

  it("passes the answer of the calling window on, without asking the core", async () => {
    const { core, bridge, a, answers } = withQuit();
    const result = await bridge.call(a.id, {
      method: "answerQuit",
      requestId: "q1",
      choice: "stopSessions",
      remember: true,
    });
    expect(result).toEqual({ ok: true, value: null });
    expect(answers).toEqual([[a.id, "q1", { choice: "stopSessions", remember: true }]]);
    expect(core.requests).toEqual([]);
  });

  it("answers not_found for an id that was not asked", async () => {
    const { bridge, a } = withQuit();
    expect(
      await bridge.call(a.id, { method: "answerQuit", requestId: "x", choice: "cancel", remember: false }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it.each([
    ["an unknown choice", { method: "answerQuit", requestId: "q1", choice: "reboot", remember: false }],
    ["a missing choice", { method: "answerQuit", requestId: "q1", remember: false }],
    [
      "a remember that is no boolean",
      { method: "answerQuit", requestId: "q1", choice: "cancel", remember: 1 },
    ],
    ["an empty request id", { method: "answerQuit", requestId: "", choice: "cancel", remember: false }],
  ])("refuses %s with bad_request", async (_name, call) => {
    const { bridge, a, answers } = withQuit();
    expect(await bridge.call(a.id, call)).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(answers).toEqual([]);
  });
});

describe("DesktopBridge workspaces and session management (#63)", () => {
  it("lists the workspaces of the core", async () => {
    const { core, bridge, a } = setup();
    const workspaces = [{ id: "w1", name: "Web", projects: [] }];
    core.answers.set("workspace.list", { result: { workspaces } });

    expect(await bridge.call(a.id, { method: "listWorkspaces" })).toEqual({ ok: true, value: workspaces });
  });

  it.each([
    [{ method: "createWorkspace", name: "Web" }, "workspace.create", { name: "Web" }],
    [
      { method: "updateWorkspace", workspaceId: "w1", name: "Web 2" },
      "workspace.update",
      { workspaceId: "w1", name: "Web 2" },
    ],
    [{ method: "deleteWorkspace", workspaceId: "w1" }, "workspace.delete", { workspaceId: "w1" }],
    [
      { method: "createProject", workspaceId: "w1", name: "api", path: "/srv/api", backend: "wsl" },
      "project.create",
      { workspaceId: "w1", name: "api", path: "/srv/api", backend: "wsl" },
    ],
    [
      { method: "updateProject", projectId: "p1", name: "api2" },
      "project.update",
      { projectId: "p1", name: "api2" },
    ],
    [{ method: "deleteProject", projectId: "p1" }, "project.delete", { projectId: "p1" }],
    [{ method: "archiveSession", sessionId: "s1" }, "session.archive", { sessionId: "s1" }],
    [{ method: "deleteSession", sessionId: "s1" }, "session.delete", { sessionId: "s1" }],
    // Issue #156: the window learns the new states from the core's events.
    [{ method: "restartSession", sessionId: "s1" }, "session.restart", { sessionId: "s1" }],
  ])("passes %j to the core as %s", async (call, method, params) => {
    const { core, bridge, a } = setup();

    expect(await bridge.call(a.id, call)).toEqual({ ok: true, value: null });
    expect(core.requests.map((r) => [r.method, r.params])).toEqual([[method, params]]);
  });

  it("moves a session out of its workspace with workspaceId null and returns the session", async () => {
    const { core, bridge, a } = setup();
    const session = { id: "s1", name: "x" } as SessionInfo;
    core.answers.set("session.update", { result: { session } });

    const result = await bridge.call(a.id, {
      method: "updateSession",
      sessionId: "s1",
      workspaceId: null,
      name: undefined,
    });

    expect(result).toEqual({ ok: true, value: session });
    expect(core.sent("session.update")[0]?.params).toEqual({ sessionId: "s1", workspaceId: null });
  });

  it("renames a session without touching its workspace", async () => {
    const { core, bridge, a } = setup();
    core.answers.set("session.update", { result: { session: { id: "s1" } } });

    await bridge.call(a.id, { method: "updateSession", sessionId: "s1", name: "neu" });

    expect(core.sent("session.update")[0]?.params).toEqual({ sessionId: "s1", name: "neu" });
  });

  it.each([
    ["updateSession without a change", { method: "updateSession", sessionId: "s1" }],
    ["updateSession with an empty name", { method: "updateSession", sessionId: "s1", name: "" }],
    [
      "updateSession with a number as workspace",
      { method: "updateSession", sessionId: "s1", workspaceId: 3 },
    ],
    ["createWorkspace without a name", { method: "createWorkspace" }],
    ["createWorkspace with a non-string name", { method: "createWorkspace", name: 4 }],
    [
      "createProject with an unknown backend",
      { method: "createProject", workspaceId: "w1", name: "a", path: "/a", backend: "docker" },
    ],
    [
      "createProject without a path",
      { method: "createProject", workspaceId: "w1", name: "a", backend: "wsl" },
    ],
    ["updateWorkspace without an id", { method: "updateWorkspace", name: "a" }],
    ["deleteSession without an id", { method: "deleteSession" }],
    ["archiveSession with an empty id", { method: "archiveSession", sessionId: "" }],
    ["restartSession without an id", { method: "restartSession" }],
    ["restartSession with an empty id", { method: "restartSession", sessionId: "" }],
    ["deleteProject without an id", { method: "deleteProject" }],
  ])("refuses %s with bad_request and no core request", async (_name, call) => {
    const { core, bridge, a } = setup();

    expect(await bridge.call(a.id, call)).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(core.requests).toEqual([]);
  });

  it("passes the core's refusal of a delete with its code", async () => {
    const { core, bridge, a } = setup();
    core.answers.set("session.delete", new IpcError("invalid_state", "Session s1 is running"));

    expect(await bridge.call(a.id, { method: "deleteSession", sessionId: "s1" })).toEqual({
      ok: false,
      error: { code: "invalid_state", message: "Session s1 is running" },
    });
  });

  it("passes session.updated, session.removed and workspace.changed of any client to every window", () => {
    const { core, a, b } = setup();
    const session = { id: "s1" } as SessionInfo;
    const workspaces = [{ id: "w1", name: "Web", projects: [] }];

    core.emit("session.updated", { session });
    core.emit("session.removed", { sessionId: "s1" });
    core.emit("workspace.changed", { workspaces });

    const expected = [
      { kind: "sessionUpdated", session },
      { kind: "sessionRemoved", sessionId: "s1" },
      { kind: "workspaceChanged", workspaces },
    ];
    expect(a.events).toEqual(expected);
    expect(b.events).toEqual(expected);
  });

  it("forgets the views of a removed session, so the window's input for them is refused locally", async () => {
    const { core, bridge, a } = setup();
    await attach(core, bridge, a, "s1", "v1");
    await attach(core, bridge, a, "s2", "v2");

    core.emit("session.removed", { sessionId: "s1" });

    expect(bridge.viewsOf(a.id)).toEqual(["v2"]);
    const before = core.requests.length;
    expect(await bridge.call(a.id, { method: "input", viewId: "v1", data: "x" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(core.requests.length).toBe(before);
  });

  it("forgets the views of an archived session, and only of that one", async () => {
    const { core, bridge, a } = setup();
    await attach(core, bridge, a, "s1", "v1");
    await attach(core, bridge, a, "s2", "v2");

    core.emit("session.stateChanged", { sessionId: "s2", state: "Exited", lastExitCode: 0 });
    expect(bridge.viewsOf(a.id)).toEqual(["v1", "v2"]);

    core.emit("session.stateChanged", { sessionId: "s1", state: "Archived" });

    expect(bridge.viewsOf(a.id)).toEqual(["v2"]);
    expect(a.events.at(-1)).toEqual({ kind: "stateChanged", sessionId: "s1", state: "Archived" });
    expect(await bridge.call(a.id, { method: "input", viewId: "v1", data: "x" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("numbers the output of a removed session from 1 again (a 1.0 core without seq)", async () => {
    const { core, bridge, a } = setup();
    await attach(core, bridge, a, "s1", "v1");
    core.emit("session.output", { sessionId: "s1" }, bytes("a"));
    core.emit("session.output", { sessionId: "s1" }, bytes("b"));
    core.emit("session.removed", { sessionId: "s1" });
    // The view is gone with the session; a new session may reuse nothing of the old counter.
    await attach(core, bridge, a, "s1", "v2");
    core.emit("session.output", { sessionId: "s1" }, bytes("c"));

    expect(
      a.events.filter((event) => event.kind === "output").map((event) => (event as { seq: number }).seq),
    ).toEqual([1, 2, 1]);
  });
});

describe("DesktopBridge history search (#62)", () => {
  it("searches all sessions: no session ids go to the core, and its answer comes back", async () => {
    const { core, bridge, a } = setup();
    const answer = {
      hits: [{ sessionId: "s1", timestamp: 1, line: "an error", offset: 3 }],
      truncated: false,
    };
    core.answers.set("history.search", { result: answer });

    const result = await bridge.call(a.id, { method: "searchHistory", query: "error", limit: 50 });

    expect(result).toEqual({ ok: true, value: answer });
    expect(core.requests).toEqual([
      { method: "history.search", params: { query: "error", limit: 50 }, payload: undefined },
    ]);
    await bridge.call(a.id, { method: "searchHistory", query: "x" });
    expect(core.requests[1]?.params).toEqual({ query: "x" });
  });

  it.each([
    [{ method: "searchHistory" }],
    [{ method: "searchHistory", query: "" }],
    [{ method: "searchHistory", query: 5 }],
    [{ method: "searchHistory", query: "q".repeat(257) }],
    [{ method: "searchHistory", query: "x", limit: 0 }],
    [{ method: "searchHistory", query: "x", limit: 201 }],
    [{ method: "searchHistory", query: "x", limit: 1.5 }],
    [{ method: "searchHistory", query: "x", limit: "5" }],
  ])("refuses %j without contacting the core", async (call) => {
    const { core, bridge, a } = setup();

    expect(await bridge.call(a.id, call)).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(core.requests).toEqual([]);
  });

  it("passes an error of the core on with its code", async () => {
    const { core, bridge, a } = setup();
    core.answers.set("history.search", new IpcError("internal", "disk gone"));

    expect(await bridge.call(a.id, { method: "searchHistory", query: "x" })).toEqual({
      ok: false,
      error: { code: "internal", message: "disk gone" },
    });
  });
});

describe("DesktopBridge settings and profiles (#64)", () => {
  const settings = { ...DEFAULT_SETTINGS, defaultDistro: "Debian" };
  const profile: LaunchProfile = {
    id: "p1",
    name: "Claude",
    launch: { backend: "wsl", cwd: "/srv", command: ["claude"] },
    autostart: false,
    loggingEnabled: true,
  };

  it("passes settings, profiles and distros to the core and returns their answers", async () => {
    const { core, bridge, a } = setup();
    core.answers.set("settings.get", { result: { settings } });
    core.answers.set("settings.set", { result: { settings } });
    core.answers.set("profile.list", { result: { profiles: [profile] } });
    core.answers.set("profile.create", { result: { profile } });
    core.answers.set("profile.update", { result: { profile: { ...profile, autostart: true } } });
    const distros = { distros: ["Ubuntu", "Debian"], defaultDistro: "Ubuntu" };
    core.answers.set("wsl.distros", { result: distros });

    expect(await bridge.call(a.id, { method: "getSettings" })).toEqual({ ok: true, value: settings });
    expect(await bridge.call(a.id, { method: "updateSettings", settings: { defaultDistro: null } })).toEqual({
      ok: true,
      value: settings,
    });
    // The update switch (#136) passes as a key of the settings.
    expect(
      (await bridge.call(a.id, { method: "updateSettings", settings: { checkForUpdates: false } })).ok,
    ).toBe(true);
    expect(await bridge.call(a.id, { method: "listProfiles" })).toEqual({ ok: true, value: [profile] });
    const create = { name: "Claude", launch: profile.launch, autostart: true };
    expect(await bridge.call(a.id, { method: "createProfile", profile: create })).toEqual({
      ok: true,
      value: profile,
    });
    expect(
      await bridge.call(a.id, { method: "updateProfile", profileId: "p1", change: { autostart: true } }),
    ).toEqual({ ok: true, value: { ...profile, autostart: true } });
    expect(await bridge.call(a.id, { method: "deleteProfile", profileId: "p1" })).toEqual({
      ok: true,
      value: null,
    });
    expect(await bridge.call(a.id, { method: "listDistros" })).toEqual({ ok: true, value: distros });

    expect(core.requests.map((request) => [request.method, request.params])).toEqual([
      ["settings.get", {}],
      ["settings.set", { settings: { defaultDistro: null } }],
      ["settings.set", { settings: { checkForUpdates: false } }],
      ["profile.list", {}],
      ["profile.create", create],
      ["profile.update", { profileId: "p1", autostart: true }],
      ["profile.delete", { profileId: "p1" }],
      ["wsl.distros", {}],
    ]);
  });

  it("refuses malformed calls with bad_request and sends nothing to the core", async () => {
    const { core, bridge, a } = setup();
    const bad = [
      { method: "updateSettings", settings: {} },
      { method: "updateSettings", settings: { farbe: "blau" } },
      { method: "updateSettings", settings: "x" },
      { method: "createProfile", profile: { launch: profile.launch } },
      { method: "createProfile", profile: { name: "x" } },
      { method: "createProfile", profile: { name: "x", launch: profile.launch, extra: 1 } },
      { method: "updateProfile", profileId: "p1", change: {} },
      { method: "updateProfile", profileId: "p1", change: { profileId: "p2" } },
      { method: "updateProfile", profileId: "", change: { name: "x" } },
      { method: "deleteProfile" },
    ];
    for (const call of bad) {
      const result = await bridge.call(a.id, call);
      expect(result.ok, JSON.stringify(call)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("bad_request");
    }
    expect(core.requests).toEqual([]);
  });

  it("passes the core's refusal of a profile with its code and message", async () => {
    const { core, bridge, a } = setup();
    core.answers.set(
      "profile.create",
      new IpcError("bad_request", 'launch.env key "API_TOKEN" looks like a secret'),
    );
    const result = await bridge.call(a.id, {
      method: "createProfile",
      profile: { name: "x", launch: { ...profile.launch, env: { API_TOKEN: "1" } } },
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "bad_request", message: 'launch.env key "API_TOKEN" looks like a secret' },
    });
  });

  it("passes settings.changed and profile.changed of any client to every window", () => {
    const { core, a, b } = setup();
    core.emit("settings.changed", { settings });
    core.emit("profile.changed", { profiles: [profile] });
    for (const win of [a, b]) {
      expect(win.events).toEqual([
        { kind: "settingsChanged", settings },
        { kind: "profilesChanged", profiles: [profile] },
      ]);
    }
  });
});

describe("DesktopBridge updates (#136)", () => {
  function withUpdates() {
    const core = new FakeCore();
    const answers: string[] = [];
    let version: string | undefined = "0.2.0";
    const updates = {
      state: () => (version === undefined ? {} : { version }),
      answer: (choice: "install" | "later") => {
        if (version === undefined) throw new IpcError("not_found", "There is no update to answer");
        answers.push(choice);
        version = undefined;
      },
    };
    const bridge = new DesktopBridge(core, undefined, undefined, undefined, updates);
    return { core, bridge, answers };
  }

  it("gives the offered update and passes the answer, without the core", async () => {
    const { core, bridge, answers } = withUpdates();
    expect(await bridge.call(1, { method: "updateState" })).toEqual({
      ok: true,
      value: { version: "0.2.0" },
    });
    expect(await bridge.call(1, { method: "answerUpdate", choice: "later" })).toEqual({
      ok: true,
      value: null,
    });
    expect(answers).toEqual(["later"]);
    expect(await bridge.call(1, { method: "updateState" })).toEqual({ ok: true, value: {} });
    const late = await bridge.call(1, { method: "answerUpdate", choice: "install" });
    expect(!late.ok && late.error.code).toBe("not_found");
    expect(core.requests).toEqual([]);
  });

  it("refuses an unknown choice with bad_request", async () => {
    const { bridge, answers } = withUpdates();
    for (const call of [
      { method: "answerUpdate" },
      { method: "answerUpdate", choice: "now" },
      { method: "answerUpdate", choice: 1 },
    ]) {
      const result = await bridge.call(1, call);
      expect(!result.ok && result.error.code, JSON.stringify(call)).toBe("bad_request");
    }
    expect(answers).toEqual([]);
  });

  it("offers nothing without an update service (repo app)", async () => {
    const { bridge } = setup();
    expect(await bridge.call(1, { method: "updateState" })).toEqual({ ok: true, value: {} });
    const answer = await bridge.call(1, { method: "answerUpdate", choice: "install" });
    expect(!answer.ok && answer.error.code).toBe("not_found");
  });

  it("sends updateChanged to every window", () => {
    const { bridge, a, b } = setup();
    bridge.broadcast({ kind: "updateChanged", version: "0.2.0" });
    for (const win of [a, b]) expect(win.events).toEqual([{ kind: "updateChanged", version: "0.2.0" }]);
  });
});
