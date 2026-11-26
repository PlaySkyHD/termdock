// Current directory per session in the renderer (issue #199, openspec change session-current-cwd).
import type { SessionInfo, SessionState } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import { currentCwdOf, withCurrentCwd } from "./session-cwd.js";
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
