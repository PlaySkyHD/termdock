import { IpcError } from "@termdock/core";
import type { Method, MethodMap } from "@termdock/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectOrStartCore,
  CoreStartError,
  SLOW_REQUEST_TIMEOUTS_MS,
  withRequestTimeout,
} from "./core-connection.js";
import type { CorePort } from "./core-connection.js";

/** A connected core: answers `core.status` (after an optional delay) and records every request. */
function fakeCore(statusDelayMs = 0, clock?: FakeClock): CorePort & { requests: Method[]; closed: boolean } {
  const core = {
    requests: [] as Method[],
    closed: false,
    request: (async (method: Method) => {
      core.requests.push(method);
      if (method === "core.status") {
        if (statusDelayMs > 0) await clock?.sleep(statusDelayMs);
        return { result: { backendUnavailable: [] }, payload: new Uint8Array() };
      }
      return { result: {}, payload: new Uint8Array() };
    }) as CorePort["request"],
    on: () => ({ dispose: () => {} }),
    onClose: () => ({ dispose: () => {} }),
    close: async () => {
      core.closed = true;
    },
  };
  return core;
}

/** Virtual time: `sleep` advances `now` at once, so retries and their timing are exact. */
class FakeClock {
  time = 0;
  sleeps: number[] = [];
  now = (): number => this.time;
  sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.time += ms;
  };
}

const refused = (): IpcError => new IpcError("closed", "Cannot connect: ENOENT");

describe("connectOrStartCore", () => {
  it("connects to a running core without starting one", async () => {
    const clock = new FakeClock();
    const core = fakeCore();
    const startCore = vi.fn();
    const connect = vi.fn(async () => core);

    const result = await connectOrStartCore({ connect, startCore, sleep: clock.sleep, now: clock.now });

    expect(result.started).toBe(false);
    expect(result.client).toBe(core);
    expect(startCore).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("starts the core once when nobody holds the pipe and connects as soon as it is up", async () => {
    const clock = new FakeClock();
    const core = fakeCore();
    let startedAt: number | undefined;
    const startCore = vi.fn(() => {
      startedAt = clock.time;
    });
    // The core takes the pipe 300 ms after its start.
    const connect = vi.fn(async () => {
      if (startedAt === undefined || clock.time < startedAt + 300) throw refused();
      return core;
    });

    const result = await connectOrStartCore({ connect, startCore, sleep: clock.sleep, now: clock.now });

    expect(result.started).toBe(true);
    expect(startCore).toHaveBeenCalledTimes(1);
    // Growing waits: 50 + 100 + 200 = 350 ms is the first try after the core is up.
    expect(clock.sleeps).toEqual([50, 100, 200]);
    expect(result.client).toBe(core);
  });

  it("gives up 5 s after the start with the last connect error and starts no second core", async () => {
    const clock = new FakeClock();
    const startCore = vi.fn();
    const connect = vi.fn(async () => {
      throw refused();
    });

    const error = await connectOrStartCore({ connect, startCore, sleep: clock.sleep, now: clock.now }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(CoreStartError);
    expect((error as CoreStartError).code).toBe("core_unreachable");
    expect((error as CoreStartError).message).toContain("ENOENT");
    expect(startCore).toHaveBeenCalledTimes(1);
    expect(clock.time).toBe(5000);
    expect(clock.sleeps.every((ms) => ms <= 1000)).toBe(true);
  });

  it.each([
    ["a protocol mismatch", new IpcError("protocol_mismatch", "Core speaks 2.0")],
    ["a refused pipe", new IpcError("closed", "Cannot connect to \\\\.\\pipe\\x: connect EACCES")],
  ])("passes %s on the first connect through without starting a core", async (_name, cause) => {
    const clock = new FakeClock();
    const startCore = vi.fn();

    const error = await connectOrStartCore({
      connect: async () => {
        throw cause;
      },
      startCore,
      sleep: clock.sleep,
      now: clock.now,
    }).catch((e: unknown) => e);

    expect(error).toBe(cause);
    expect(startCore).not.toHaveBeenCalled();
  });

  it("stops waiting for the started core at the first error that is not a missing pipe", async () => {
    const clock = new FakeClock();
    const mismatch = new IpcError("protocol_mismatch", "Core speaks 2.0");
    const connect = vi
      .fn<() => Promise<CorePort>>()
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(refused())
      .mockRejectedValue(mismatch);

    const error = await connectOrStartCore({
      connect,
      startCore: () => {},
      sleep: clock.sleep,
      now: clock.now,
    }).catch((e: unknown) => e);

    expect(error).toBe(mismatch);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("reports a failed start without retrying", async () => {
    const clock = new FakeClock();
    const connect = vi.fn(async () => {
      throw refused();
    });
    const startCore = vi.fn(() => {
      throw new Error("spawn EACCES");
    });

    const error = await connectOrStartCore({ connect, startCore, sleep: clock.sleep, now: clock.now }).catch(
      (e: unknown) => e,
    );

    expect((error as CoreStartError).code).toBe("start_failed");
    expect((error as CoreStartError).message).toContain("EACCES");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("waits for the reconcile with core.status as the first request after hello", async () => {
    const clock = new FakeClock();
    const core = fakeCore(20_000, clock);

    const result = await connectOrStartCore({
      connect: async () => core,
      startCore: () => {},
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(core.requests).toEqual(["core.status"]);
    expect(result.status).toEqual({ backendUnavailable: [] });
  });

  it("closes the connection when the core fails while it reconciles", async () => {
    const clock = new FakeClock();
    const core = fakeCore();
    core.request = (async () => {
      throw new IpcError("internal", "Core failed to start");
    }) as CorePort["request"];

    const error = await connectOrStartCore({
      connect: async () => core,
      startCore: () => {},
      sleep: clock.sleep,
      now: clock.now,
    }).catch((e: unknown) => e);

    expect((error as IpcError).code).toBe("internal");
    expect(core.closed).toBe(true);
  });
});

describe("withRequestTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a request the core does not answer in time with code timeout", async () => {
    vi.useFakeTimers();
    const core = fakeCore();
    core.request = (() => new Promise(() => {})) as CorePort["request"];
    const port = withRequestTimeout(core, 10_000);

    const pending = port.request("session.list", {}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(((await pending) as IpcError).code).toBe("timeout");
  });

  it("gives back a view whose attach answer comes after the timeout", async () => {
    vi.useFakeTimers();
    const core = fakeCore();
    const inner = core.request;
    let answerAttach: (() => void) | undefined;
    core.request = ((method: Method, params: never) => {
      if (method !== "session.attach") return inner(method, params);
      core.requests.push(method);
      return new Promise((resolve) => {
        answerAttach = () =>
          resolve({
            result: { viewId: "late-view", size: { cols: 80, rows: 24 } },
            payload: new Uint8Array(),
          });
      });
    }) as CorePort["request"];
    const port = withRequestTimeout(core, 10_000);

    const pending = port.request("session.attach", { sessionId: "s1" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    answerAttach?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(((await pending) as IpcError).code).toBe("timeout");
    expect(core.requests).toEqual(["session.attach", "session.detach"]);
  });

  it("gives session.create and session.attach the long timeout of a cold WSL start", async () => {
    vi.useFakeTimers();
    const core = fakeCore();
    const inner = core.request;
    core.request = ((method: Method, params: never) =>
      method === "session.create" || method === "session.attach"
        ? new Promise((resolve) => setTimeout(() => resolve(inner(method, params) as never), 30_000))
        : new Promise(() => {})) as CorePort["request"];
    const port = withRequestTimeout(core, 10_000, SLOW_REQUEST_TIMEOUTS_MS);

    const created = port.request("session.create", { name: "WSL", launch: { backend: "wsl", cwd: "~" } });
    const attached = port.request("session.attach", { sessionId: "s1" });
    const listed = port.request("session.list", {}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(created).resolves.toMatchObject({ result: {} });
    await expect(attached).resolves.toMatchObject({ result: {} });
    expect(((await listed) as IpcError).code).toBe("timeout");
  });

  it("passes answers through", async () => {
    vi.useFakeTimers();
    const port = withRequestTimeout(fakeCore(), 10_000);

    const answer = await port.request("session.list", {} as MethodMap["session.list"]["params"]);

    expect(answer.result).toEqual({});
    // The timer of an answered request is gone, nothing fires later.
    expect(vi.getTimerCount()).toBe(0);
  });
});
