import type { CoreStatusResult, SessionInfo, SessionState } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import type { BridgeEvent, TermdockApi } from "../shared/bridge.js";
import { connectStore } from "./session-sync.js";
import { UiStore } from "./ui-store.js";

function session(id: string, state: SessionState = "Detached"): SessionInfo {
  return {
    id,
    name: id,
    state,
    launch: { backend: "wsl", cwd: "~" },
    size: { cols: 80, rows: 24 },
    loggingEnabled: false,
    createdAt: `2026-11-13T10:00:0${id.length}Z`,
    updatedAt: "2026-11-13T10:00:00Z",
  };
}

/** Bridge double: the test decides when the list and the status are answered and emits events. */
class FakeApi implements Pick<TermdockApi, "onEvent" | "listSessions" | "coreStatus"> {
  private listener: ((event: BridgeEvent) => void) | undefined;
  private answerList: ((sessions: SessionInfo[]) => void) | undefined;
  private failList: ((error: Error) => void) | undefined;
  status: CoreStatusResult | Error = { backendUnavailable: [] };
  subscribed = false;
  listedAfterSubscribe = false;

  onEvent(listener: (event: BridgeEvent) => void): () => void {
    this.listener = listener;
    this.subscribed = true;
    return () => {
      this.listener = undefined;
      this.subscribed = false;
    };
  }
  listSessions(): Promise<SessionInfo[]> {
    this.listedAfterSubscribe = this.subscribed;
    return new Promise((resolve, reject) => {
      this.answerList = resolve;
      this.failList = reject;
    });
  }
  async coreStatus(): Promise<CoreStatusResult> {
    if (this.status instanceof Error) throw this.status;
    return this.status;
  }
  emit(event: BridgeEvent): void {
    this.listener?.(event);
  }
  answer(sessions: SessionInfo[]): void {
    this.answerList?.(sessions);
  }
  fail(error: Error): void {
    this.failList?.(error);
  }
}

const store = (): UiStore =>
  new UiStore({
    newId: (() =>
      (
        (n) => () =>
          `id${++n}`
      )(0))(),
  });
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const states = (s: UiStore): Array<[string, string]> => s.getState().sessions.map((x) => [x.id, x.state]);

describe("connectStore", () => {
  it("subscribes before it lists, so no event can fall between the two", async () => {
    const api = new FakeApi();

    connectStore(store(), api, () => {});
    await settle();

    expect(api.listedAfterSubscribe).toBe(true);
  });

  it("puts the listed sessions and the core status into the store", async () => {
    const api = new FakeApi();
    api.status = { backendUnavailable: ["wsl"] };
    const s = store();

    const connection = connectStore(s, api, () => {});
    api.answer([session("a", "Running"), session("bb")]);
    await connection.ready;

    expect(states(s)).toEqual([
      ["a", "Running"],
      ["bb", "Detached"],
    ]);
    expect(s.getState().coreStatus).toEqual({ backendUnavailable: ["wsl"] });
  });

  it("applies a state change that arrives while the list is on its way", async () => {
    const api = new FakeApi();
    const s = store();
    const connection = connectStore(s, api, () => {});

    api.emit({ kind: "stateChanged", sessionId: "a", state: "Exited", lastExitCode: 0 });
    api.answer([session("a", "Running")]);
    await connection.ready;

    expect(states(s)).toEqual([["a", "Exited"]]);
  });

  it("adds a session created while the list is on its way, unless the list has it", async () => {
    const api = new FakeApi();
    const s = store();
    const connection = connectStore(s, api, () => {});

    api.emit({ kind: "sessionCreated", session: session("new", "Running") });
    api.emit({ kind: "sessionCreated", session: session("a", "Starting") });
    api.answer([session("a", "Running")]);
    await connection.ready;

    expect(states(s).sort()).toEqual([
      ["a", "Running"],
      ["new", "Running"],
    ]);
  });

  it("follows events after the list", async () => {
    const api = new FakeApi();
    const s = store();
    const connection = connectStore(s, api, () => {});
    api.answer([session("a", "Running")]);
    await connection.ready;

    api.emit({ kind: "stateChanged", sessionId: "a", state: "Interrupted" });
    api.emit({ kind: "sessionCreated", session: session("bb") });

    expect(states(s)).toEqual([
      ["a", "Interrupted"],
      ["bb", "Detached"],
    ]);
  });

  it("marks the end of the core connection at once", () => {
    const api = new FakeApi();
    const s = store();
    connectStore(s, api, () => {});

    api.emit({ kind: "coreClosed" });

    expect(s.getState().coreClosed).toBe(true);
  });

  it("ignores output events", async () => {
    const api = new FakeApi();
    const s = store();
    const connection = connectStore(s, api, () => {});
    api.answer([session("a")]);
    await connection.ready;

    api.emit({ kind: "output", sessionId: "a", seq: 1, data: new Uint8Array([65]) });

    expect(states(s)).toEqual([["a", "Detached"]]);
  });

  it("reports a failing list and keeps working with events", async () => {
    const api = new FakeApi();
    const errors: string[] = [];
    const s = store();
    const connection = connectStore(s, api, (message) => errors.push(message));

    api.fail(new Error("[timeout] Request session.list timed out"));
    await connection.ready;
    api.emit({ kind: "sessionCreated", session: session("a") });

    expect(errors).toEqual(["[timeout] Request session.list timed out"]);
    expect(states(s)).toEqual([["a", "Detached"]]);
  });

  it("works without the core status", async () => {
    const api = new FakeApi();
    api.status = new Error("[timeout] core.status");
    const s = store();
    const connection = connectStore(s, api, () => {});
    api.answer([session("a")]);
    await connection.ready;

    expect(s.getState().coreStatus).toBeUndefined();
    expect(states(s)).toEqual([["a", "Detached"]]);
  });

  it("does not write a list that arrives after dispose", async () => {
    const api = new FakeApi();
    const s = store();
    const connection = connectStore(s, api, () => {});

    connection.dispose();
    api.answer([session("old")]);
    await connection.ready;

    expect(s.getState().sessions).toEqual([]);
    expect(s.getState().coreStatus).toBeUndefined();
  });

  it("stops listening on dispose", async () => {
    const api = new FakeApi();
    const connection = connectStore(store(), api, () => {});

    connection.dispose();

    expect(api.subscribed).toBe(false);
  });
});
