// Current directory per session in the renderer (issue #199, openspec change session-current-cwd).
import type { SessionInfo, SessionState } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import { currentCwdOf, relayCwd, withCurrentCwd } from "./session-cwd.js";
import { UiStore } from "./ui-store.js";

function session(id: string, state: SessionState = "Running", currentCwd?: string): SessionInfo {
  return {
    id,
    name: id,
    state,
    launch: { backend: "wsl", cwd: "~" },
    size: { cols: 80, rows: 24 },
    loggingEnabled: false,
    createdAt: "2026-11-26T10:00:00Z",
    updatedAt: "2026-11-26T10:00:00Z",
    ...(currentCwd === undefined ? {} : { currentCwd }),
  };
}

function newStore(sessions: SessionInfo[]): UiStore {
  let next = 0;
  const store = new UiStore({ newId: () => `id${++next}` });
  store.setSessions(sessions);
  return store;
}

describe("withCurrentCwd", () => {
  it("sets, replaces and removes the directory of a running or detached session", () => {
    const running = withCurrentCwd(session("a"), "/tmp");
    expect(running.currentCwd).toBe("/tmp");
    expect(withCurrentCwd(running, "/srv").currentCwd).toBe("/srv");
    const cleared = withCurrentCwd(running, undefined);
    expect("currentCwd" in cleared).toBe(false);
    expect(withCurrentCwd(session("a", "Detached"), "/tmp").currentCwd).toBe("/tmp");
  });

  it("never gives an ended or starting session a directory", () => {
    for (const state of ["Starting", "Exited", "Interrupted", "Archived"] as const) {
      const result = withCurrentCwd(session("a", state, "/old"), "/tmp");
      expect("currentCwd" in result, state).toBe(false);
    }
  });

  it("returns the same object when nothing changes", () => {
    const known = session("a", "Running", "/tmp");
    expect(withCurrentCwd(known, "/tmp")).toBe(known);
    const none = session("a", "Exited");
    expect(withCurrentCwd(none, "/tmp")).toBe(none);
  });
});

describe("currentCwdOf", () => {
  it("reads the directory of a session and undefined for an unknown one", () => {
    const store = newStore([session("a", "Running", "/home/nic"), session("b")]);
    expect(currentCwdOf(store.getState(), "a")).toBe("/home/nic");
    expect(currentCwdOf(store.getState(), "b")).toBeUndefined();
    expect(currentCwdOf(store.getState(), "unbekannt")).toBeUndefined();
  });
});

describe("UiStore current directory", () => {
  it("takes cwdChanged and tells its listeners only on a change", () => {
    const store = newStore([session("a")]);
    let calls = 0;
    store.subscribe(() => (calls += 1));

    store.sessionCwdChanged("a", "/tmp");
    store.sessionCwdChanged("a", "/tmp");
    store.sessionCwdChanged("unbekannt", "/tmp");

    expect(currentCwdOf(store.getState(), "a")).toBe("/tmp");
    expect(calls).toBe(1);
    store.sessionCwdChanged("a", undefined);
    expect(currentCwdOf(store.getState(), "a")).toBeUndefined();
  });

  it("drops the directory once the session leaves Running and Detached, and ignores a late cwdChanged", () => {
    const store = newStore([session("a", "Running", "/tmp")]);
    store.sessionStateChanged("a", "Detached");
    expect(currentCwdOf(store.getState(), "a")).toBe("/tmp");

    store.sessionStateChanged("a", "Exited", 0);
    expect(currentCwdOf(store.getState(), "a")).toBeUndefined();

    store.sessionCwdChanged("a", "/srv");
    expect(currentCwdOf(store.getState(), "a")).toBeUndefined();
  });

  it("keeps the directory through a rename (sessionUpdated)", () => {
    const store = newStore([session("a", "Running", "/tmp")]);
    store.sessionUpdated({ ...session("a"), name: "neu" });
    expect(store.getState().sessions[0]?.name).toBe("neu");
    expect(currentCwdOf(store.getState(), "a")).toBe("/tmp");
  });
});

// Issue #202 (openspec change explorer-panel): the directory of a Windows shell from its view into the store.
describe("relayCwd", () => {
  class FakeSource {
    cwd: string | undefined;
    readonly listeners = new Set<(path: string) => void>();
    currentCwd = (): string | undefined => this.cwd;
    onCwd = (listener: (path: string) => void): (() => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    };
    report(path: string): void {
      this.cwd = path;
      for (const listener of this.listeners) listener(path);
    }
  }

  it("takes the known directory, then each change, until it is stopped", () => {
    const store = newStore([session("w")]);
    store.openSession("w");
    const paneId = store.getState().window.tabs[0]!.activePaneId;
    const source = new FakeSource();
    source.cwd = "C:\\Temp";

    const stop = relayCwd(store, paneId, source);
    expect(currentCwdOf(store.getState(), "w")).toBe("C:\\Temp");
    source.report("C:\\Temp\\sub");
    expect(currentCwdOf(store.getState(), "w")).toBe("C:\\Temp\\sub");

    stop();
    source.report("D:\\");
    expect(currentCwdOf(store.getState(), "w")).toBe("C:\\Temp\\sub");
    expect(source.listeners.size).toBe(0);
  });

  it("changes the store only when a second view reports another path", () => {
    const store = newStore([session("w")]);
    store.openSession("w");
    const paneId = store.getState().window.tabs[0]!.activePaneId;
    const first = new FakeSource();
    const second = new FakeSource();
    relayCwd(store, paneId, first);
    relayCwd(store, paneId, second);
    first.report("C:\\a");
    const before = store.getState();
    second.report("C:\\a");
    expect(store.getState()).toBe(before);
  });

  it("gives a restarted session the last directory of its view again", () => {
    const store = newStore([session("w")]);
    store.openSession("w");
    const paneId = store.getState().window.tabs[0]!.activePaneId;
    const source = new FakeSource();
    const stop = relayCwd(store, paneId, source);
    source.report("C:\\proj");

    // The run ends and starts again; the view stays and its shell reports the same path, which is no change for it.
    store.sessionStateChanged("w", "Exited", 0);
    expect(currentCwdOf(store.getState(), "w")).toBeUndefined();
    store.sessionStateChanged("w", "Starting");
    expect(currentCwdOf(store.getState(), "w")).toBeUndefined();
    store.sessionStateChanged("w", "Running");
    expect(currentCwdOf(store.getState(), "w")).toBe("C:\\proj");

    stop();
    store.sessionStateChanged("w", "Exited", 0);
    store.sessionStateChanged("w", "Running");
    expect(currentCwdOf(store.getState(), "w")).toBeUndefined();
  });

  it("relays nothing for a pane that is not in the window", () => {
    const store = newStore([session("w")]);
    const source = new FakeSource();
    relayCwd(store, "nope", source);
    expect(source.listeners.size).toBe(0);
  });
});
