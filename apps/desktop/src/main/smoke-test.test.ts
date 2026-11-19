import { describe, expect, it, vi } from "vitest";
import { LATE_START_GRACE_MS, runSmokeTest, smokeTestDataDir, smokeTestRequested } from "./smoke-test.js";
import type { SmokeTestDeps } from "./smoke-test.js";

function deps(overrides: Partial<SmokeTestDeps> = {}): SmokeTestDeps & { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => {});
  return {
    close,
    connectOrStart: async () => ({
      client: { close },
      started: true,
      status: { backendUnavailable: ["wsl"] },
    }),
    stopCore: vi.fn(async () => "shutdown" as const),
    coreAlive: () => false,
    log: () => {},
    timeoutMs: 1_000,
    ...overrides,
  };
}

describe("smokeTestRequested", () => {
  it("is true only with the flag", () => {
    expect(smokeTestRequested(["TermDock.exe", "--smoke-test"])).toBe(true);
    expect(smokeTestRequested(["TermDock.exe"])).toBe(false);
    expect(smokeTestRequested(["TermDock.exe", "--screenshot", "C:\\shots"])).toBe(false);
  });
});

describe("smokeTestDataDir", () => {
  it("takes TERMDOCK_DATA_DIR", () => {
    expect(smokeTestDataDir({ TERMDOCK_DATA_DIR: "C:\\Temp\\smoke" })).toBe("C:\\Temp\\smoke");
  });

  it("refuses to run without TERMDOCK_DATA_DIR, which would mean the productive data folder", () => {
    expect(() => smokeTestDataDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" })).toThrow(
      /TERMDOCK_DATA_DIR/,
    );
    expect(() => smokeTestDataDir({ TERMDOCK_DATA_DIR: "" })).toThrow(/TERMDOCK_DATA_DIR/);
  });

  it("refuses TERMDOCK_DATA_DIR pointing at the productive data folder or below it", () => {
    const APPDATA = "C:\\Users\\u\\AppData\\Roaming";
    // A second core on the productive database would reconcile its sessions against an empty test socket.
    for (const dir of [
      "C:\\Users\\u\\AppData\\Roaming\\TermDock",
      "c:\\users\\u\\appdata\\roaming\\termdock\\",
      "C:/Users/u/AppData/Roaming/TermDock/smoke",
    ])
      expect(() => smokeTestDataDir({ APPDATA, TERMDOCK_DATA_DIR: dir })).toThrow(/productive/);

    expect(
      smokeTestDataDir({ APPDATA, TERMDOCK_DATA_DIR: "C:\\Users\\u\\AppData\\Roaming\\TermDockSmoke" }),
    ).toBe("C:\\Users\\u\\AppData\\Roaming\\TermDockSmoke");
  });
});

describe("runSmokeTest", () => {
  it("passes when the started core answers and ends on shutdown", async () => {
    const log = vi.fn();
    const d = deps({ log });

    await expect(runSmokeTest(d)).resolves.toBe(0);

    expect(d.close).toHaveBeenCalled();
    expect(d.stopCore).toHaveBeenCalledTimes(1);
    // Without WSL on the runner the backend is unavailable; that is expected and only reported.
    expect(log).toHaveBeenCalledWith(expect.stringContaining("wsl"));
  });

  it("fails when the core cannot be started or does not answer, and still stops it", async () => {
    const d = deps({ connectOrStart: () => Promise.reject(new Error("core_unreachable")) });

    await expect(runSmokeTest(d)).resolves.toBe(1);
    expect(d.stopCore).toHaveBeenCalledTimes(1);
  });

  it("fails when another core answered on the pipe, and leaves that core alone", async () => {
    const d = deps({
      connectOrStart: async () => ({
        client: { close: d.close },
        started: false,
        status: { backendUnavailable: [] },
      }),
    });

    await expect(runSmokeTest(d)).resolves.toBe(1);
    expect(d.close).toHaveBeenCalled();
    expect(d.stopCore).not.toHaveBeenCalled();
  });

  it("fails instead of rejecting when closing or stopping throws", async () => {
    const failing = vi.fn(async () => {
      throw new Error("pipe broke");
    });

    await expect(runSmokeTest(deps({ stopCore: failing }))).resolves.toBe(1);
    await expect(
      runSmokeTest(
        deps({
          connectOrStart: async () => ({
            client: { close: failing },
            started: true,
            status: { backendUnavailable: [] },
          }),
        }),
      ),
    ).resolves.toBe(1);
  });

  it("fails when the core had to be killed or is still running", async () => {
    await expect(runSmokeTest(deps({ stopCore: async () => "killed" }))).resolves.toBe(1);
    await expect(runSmokeTest(deps({ coreAlive: () => true }))).resolves.toBe(1);
  });

  it("fails after its timeout and stops the core", async () => {
    vi.useFakeTimers();
    try {
      const d = deps({ connectOrStart: () => new Promise(() => {}), timeoutMs: 500 });

      const result = runSmokeTest(d);
      await vi.advanceTimersByTimeAsync(500 + LATE_START_GRACE_MS);

      await expect(result).resolves.toBe(1);
      expect(d.stopCore).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a connection that opens after the timeout and stops the core only then", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const close = vi.fn(async () => void order.push("close"));
      const d = deps({
        // Starts its core shortly after the timeout; stopping before that would miss the process.
        connectOrStart: () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ client: { close }, started: true, status: { backendUnavailable: [] } }),
              800,
            ),
          ),
        stopCore: vi.fn(async () => {
          order.push("stop");
          return "shutdown" as const;
        }),
        timeoutMs: 500,
      });

      const result = runSmokeTest(d);
      await vi.advanceTimersByTimeAsync(800);

      await expect(result).resolves.toBe(1);
      expect(order).toEqual(["close", "stop"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
