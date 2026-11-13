import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isolatedCore,
  QuietWatch,
  screenshotDir,
  screenshotProfileDir,
  stopIsolatedCore,
} from "./screenshot.js";

describe("screenshotDir", () => {
  it("reads the directory after --screenshot", () => {
    expect(screenshotDir(["electron.exe", ".", "--screenshot", "P:/shots"])).toBe("P:/shots");
  });

  it("is undefined without the flag and fails without a directory", () => {
    expect(screenshotDir(["electron.exe", "."])).toBeUndefined();
    expect(() => screenshotDir(["electron.exe", ".", "--screenshot"])).toThrow(/directory/);
    expect(() => screenshotDir(["electron.exe", ".", "--screenshot", "--other"])).toThrow(/directory/);
  });
});

describe("isolatedCore", () => {
  it("uses its own pipe, the given data directory and the tmux test socket", () => {
    const core = isolatedCore("C:\\Temp\\td-shot-1", 4242, "ab12");

    expect(core.pipePath).toBe("\\\\.\\pipe\\termdock-core-shot-4242-ab12");
    expect(core.env).toEqual({
      TERMDOCK_PIPE: "\\\\.\\pipe\\termdock-core-shot-4242-ab12",
      TERMDOCK_DATA_DIR: "C:\\Temp\\td-shot-1",
      TERMDOCK_TMUX_SOCKET: "termdock-test",
    });
  });

  it("keeps the Electron profile of screenshot runs in one fixed temp folder", () => {
    expect(screenshotProfileDir("C:\\Temp")).toBe("C:\\Temp\\termdock-screenshot-profile");
  });
});

describe("stopIsolatedCore", () => {
  /** A core process that ends `exitAfterMs` after a shutdown request or a kill. */
  function fakeProcess() {
    const state = { alive: true, time: 0, shutdowns: [] as unknown[], killed: [] as number[] };
    const deps = {
      kill: (pid: number) => {
        state.killed.push(pid);
        state.alive = false;
      },
      isAlive: () => state.alive,
      sleep: async (ms: number) => {
        state.time += ms;
      },
    };
    return { state, deps };
  }

  it("ends the core with core.shutdown and its sessions, then waits until the process is gone", async () => {
    const { state, deps } = fakeProcess();
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => ({
      request: async (_method: string, params: unknown) => {
        state.shutdowns.push(params);
        state.alive = false;
        return { result: {}, payload: new Uint8Array() };
      },
      close,
    }));

    const outcome = await stopIsolatedCore(4711, { ...deps, connect });

    expect(outcome).toBe("shutdown");
    expect(state.shutdowns).toEqual([{ stopSessions: true }]);
    expect(close).toHaveBeenCalled();
    expect(state.killed).toEqual([]);
  });

  it("kills the process by pid when the core does not answer", async () => {
    const { state, deps } = fakeProcess();
    const connect = vi.fn(async () => {
      throw new Error("Cannot connect: ENOENT");
    });

    const outcome = await stopIsolatedCore(4711, { ...deps, connect });

    expect(outcome).toBe("killed");
    expect(state.killed).toEqual([4711]);
  });

  it("does nothing more when no core was started and none answers", async () => {
    const { state, deps } = fakeProcess();
    const connect = vi.fn(async () => {
      throw new Error("Cannot connect: ENOENT");
    });

    expect(await stopIsolatedCore(undefined, { ...deps, connect })).toBe("gone");
    expect(state.killed).toEqual([]);
  });
});

describe("QuietWatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves once output has been quiet for the given time after the first output", async () => {
    vi.useFakeTimers();
    const watch = new QuietWatch();
    let done = false;
    const waiting = watch.quiet(800, 10_000).then(() => (done = true));

    await vi.advanceTimersByTimeAsync(2_000);
    expect(done).toBe(false); // nothing seen yet: a shell that has not started is not quiet
    watch.saw();
    await vi.advanceTimersByTimeAsync(500);
    watch.saw();
    await vi.advanceTimersByTimeAsync(700);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await waiting;
    expect(done).toBe(true);
  });

  it("fails after the timeout", async () => {
    vi.useFakeTimers();
    const watch = new QuietWatch();
    const waiting = watch.quiet(800, 3_000).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(3_000);

    expect(await waiting).toBeInstanceOf(Error);
  });
});
