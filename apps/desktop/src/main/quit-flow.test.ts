import { describe, expect, it } from "vitest";
import { decideQuit, QuitFlow } from "./quit-flow.js";
import type { DecideDeps, QuitDecision, QuitFlowDeps } from "./quit-flow.js";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A promise that is settled from outside. */
function gate<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function decideSetup(over: Partial<DecideDeps> = {}) {
  const calls: string[] = [];
  const saved: unknown[] = [];
  const deps: DecideDeps = {
    listSessions: async () => [{ state: "Running" }, { state: "Exited" }],
    getSettings: async () => ({ confirmQuitWhileRunning: true }),
    saveSettings: async (patch) => void saved.push(patch),
    ask: async (count) => {
      calls.push(`ask ${count}`);
      return { choice: "keepSessions", remember: false };
    },
    log: (text) => calls.push(`log ${text}`),
    ...over,
  };
  return { deps, calls, saved };
}

describe("decideQuit", () => {
  it("asks with the number of running sessions and keeps them on that choice", async () => {
    const { deps, calls } = decideSetup();
    expect(await decideQuit(deps, "user")).toEqual({ stopSessions: false });
    expect(calls).toEqual(["ask 1"]);
  });

  it("does not ask without a running session", async () => {
    const { deps, calls } = decideSetup({ listSessions: async () => [{ state: "Exited" }] });
    expect(await decideQuit(deps, "user")).toEqual({ stopSessions: false });
    expect(calls).toEqual([]);
  });

  it("returns undefined on Abbrechen and stores nothing, also with the checkbox", async () => {
    const { deps, saved } = decideSetup({ ask: async () => ({ choice: "cancel", remember: true }) });
    expect(await decideQuit(deps, "user")).toBeUndefined();
    expect(saved).toEqual([]);
  });

  it("stores the choice with the checkbox before it returns", async () => {
    const { deps, saved } = decideSetup({ ask: async () => ({ choice: "stopSessions", remember: true }) });
    expect(await decideQuit(deps, "user")).toEqual({ stopSessions: true });
    expect(saved).toEqual([{ confirmQuitWhileRunning: false, quitAction: "stopSessions" }]);
  });

  it("goes on with the choice when storing it fails", async () => {
    const { deps, calls } = decideSetup({
      ask: async () => ({ choice: "stopSessions", remember: true }),
      saveSettings: async () => {
        throw new Error("core gone");
      },
    });
    expect(await decideQuit(deps, "user")).toEqual({ stopSessions: true });
    expect(calls).toEqual(["log settings.set: core gone"]);
  });

  it("applies the stored choice without asking", async () => {
    const { deps, calls } = decideSetup({
      getSettings: async () => ({ confirmQuitWhileRunning: false, quitAction: "stopSessions" }),
    });
    expect(await decideQuit(deps, "user")).toEqual({ stopSessions: true });
    expect(calls).toEqual([]);
  });

  it("keeps the sessions and does not ask when the core does not list them", async () => {
    const { deps, calls } = decideSetup({ listSessions: async () => undefined });
    expect(await decideQuit(deps, "user")).toEqual({ stopSessions: false });
    expect(calls).toEqual([]);
  });

  it("asks like the defaults when the core has no settings", async () => {
    const { deps, calls } = decideSetup({ getSettings: async () => undefined });
    await decideQuit(deps, "user");
    expect(calls).toEqual(["ask 1"]);
  });

  it("keeps the sessions when there is no window to ask in", async () => {
    const { deps } = decideSetup({ ask: async () => undefined });
    expect(await decideQuit(deps, "user")).toEqual({ stopSessions: false });
  });
});

function flowSetup(decide: () => Promise<QuitDecision> = async () => ({ stopSessions: false })) {
  const events: string[] = [];
  const deps: QuitFlowDeps = {
    decide: async (reason) => {
      events.push(`decide ${reason}`);
      return decide();
    },
    retainAll: () => events.push("retainAll"),
    flush: async () => void events.push("flush"),
    shutdownCore: async () => void events.push("shutdownCore"),
    closeClient: async () => void events.push("closeClient"),
    quit: () => events.push("quit"),
    log: (text) => events.push(`log ${text}`),
  };
  return { flow: new QuitFlow(deps), events, deps };
}

describe("QuitFlow", () => {
  it("holds the first before-quit back, then saves, closes and quits in that order", async () => {
    const { flow, events } = flowSetup();
    let prevented = 0;
    flow.beforeQuit(() => (prevented += 1));
    expect(prevented).toBe(1);
    await flush();
    expect(events).toEqual(["decide user", "retainAll", "flush", "closeClient", "quit"]);
    expect(flow.quitReady).toBe(true);
    // The quit goes through now.
    flow.beforeQuit(() => (prevented += 1));
    expect(prevented).toBe(1);
  });

  it("sends core.shutdown only after the layout is saved and before the connection closes", async () => {
    const saved = gate<void>();
    const { flow, events, deps } = flowSetup(async () => ({ stopSessions: true }));
    deps.flush = async () => {
      events.push("flush start");
      await saved.promise;
      events.push("flush end");
    };
    flow.beforeQuit(() => {});
    await flush();
    expect(events).toEqual(["decide user", "retainAll", "flush start"]);
    saved.resolve();
    await flush();
    expect(events.slice(3)).toEqual(["flush end", "shutdownCore", "closeClient", "quit"]);
  });

  it("does nothing on Abbrechen and can quit again afterwards", async () => {
    const answers: QuitDecision[] = [undefined, { stopSessions: false }];
    const { flow, events } = flowSetup(async () => answers.shift());
    flow.beforeQuit(() => {});
    await flush();
    expect(events).toEqual(["decide user"]);
    expect(flow.quitReady).toBe(false);
    expect(flow.interceptClose(true)).toBe(true);
    await flush();
    expect(events).toEqual(["decide user", "decide user", "retainAll", "flush", "closeClient", "quit"]);
  });

  it("asks once for a second quit while the dialog is open", async () => {
    const answer = gate<QuitDecision>();
    const { flow, events } = flowSetup(() => answer.promise);
    flow.beforeQuit(() => {});
    flow.beforeQuit(() => {});
    expect(flow.interceptClose(true)).toBe(true);
    expect(events.filter((event) => event.startsWith("decide"))).toHaveLength(1);
    answer.resolve({ stopSessions: false });
    await flush();
    expect(events.filter((event) => event === "quit")).toHaveLength(1);
  });

  it("does not decide again while the save and the shutdown of a decided quit still run", async () => {
    const saved = gate<void>();
    const { flow, events, deps } = flowSetup(async () => ({ stopSessions: true }));
    deps.flush = () => saved.promise;
    flow.beforeQuit(() => {});
    await flush();
    flow.beforeQuit(() => {}); // Ctrl+Q again during the save
    expect(flow.interceptClose(true)).toBe(false); // the windows are retained: closing goes on
    await flush();
    expect(events.filter((event) => event.startsWith("decide"))).toHaveLength(1);
    saved.resolve();
    await flush();
    expect(events.filter((event) => event === "shutdownCore")).toHaveLength(1);
  });

  it("lets other windows close without a decision and holds back only the last one", () => {
    const { flow, events } = flowSetup();
    expect(flow.interceptClose(false)).toBe(false);
    expect(events).toEqual([]);
    expect(flow.interceptClose(true)).toBe(true);
  });

  it("quits with the sessions kept when the decision fails, and logs why", async () => {
    const { flow, events } = flowSetup(async () => {
      throw new Error("pipe broke");
    });
    flow.beforeQuit(() => {});
    await flush();
    expect(events).toEqual([
      "decide user",
      "log quit decision: pipe broke",
      "retainAll",
      "flush",
      "closeClient",
      "quit",
    ]);
  });

  it("still closes the connection and quits when the save or the shutdown fails", async () => {
    const { flow, events, deps } = flowSetup(async () => ({ stopSessions: true }));
    deps.flush = async () => {
      throw new Error("save failed");
    };
    deps.shutdownCore = async () => {
      throw new Error("shutdown failed");
    };
    flow.beforeQuit(() => {});
    await flush();
    expect(events).toContain("log layout.save: save failed");
    expect(events).toContain("log core.shutdown: shutdown failed");
    expect(events.slice(-2)).toEqual(["closeClient", "quit"]);
  });

  it("ends the Windows session without a question, keeps the sessions and does not quit the app", async () => {
    const { flow, events } = flowSetup(async () => ({ stopSessions: true }));
    flow.sessionEnd();
    await flush();
    expect(events).toEqual(["retainAll", "flush", "closeClient"]);
  });

  it("honors a stopSessions that comes while the layout is still being saved", async () => {
    const saved = gate<void>();
    const { flow, events, deps } = flowSetup(async () => ({ stopSessions: true }));
    deps.flush = () => saved.promise;
    flow.sessionEnd(); // the first call wants to keep the sessions and starts the save
    await flush();
    flow.beforeQuit(() => {}); // the user's choice follows: stop
    await flush();
    saved.resolve();
    await flush();
    expect(events).toContain("shutdownCore");
    expect(events.indexOf("shutdownCore")).toBeLessThan(events.indexOf("closeClient"));
  });

  it("logs a stopSessions that comes after the connection closed instead of losing it silently", async () => {
    const { flow, events } = flowSetup(async () => ({ stopSessions: true }));
    flow.windowsClosed(); // keeps the sessions; save and close run to the end
    await flush();
    await flow.request(); // the user's choice comes too late: the connection is closed
    await flush();
    expect(events.filter((event) => event === "shutdownCore")).toHaveLength(0);
    expect(events.some((event) => event.startsWith("log stopSessions came too late"))).toBe(true);
  });

  it("keeps the sessions for a window that went away without a decision", async () => {
    const { flow, events } = flowSetup();
    flow.windowsClosed();
    await flush();
    expect(events).toEqual(["flush", "closeClient", "quit"]);
  });
});
