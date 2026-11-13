import { afterEach, describe, expect, it, vi } from "vitest";
import { DistroKeepalive, type KeepaliveProcess } from "./keepalive.js";

class FakeProcess implements KeepaliveProcess {
  killed = false;
  private exitListener: (() => void) | undefined;
  constructor(readonly distro: string) {}
  kill(): void {
    this.killed = true;
    this.exitListener?.();
  }
  onExit(listener: () => void): void {
    this.exitListener = listener;
  }
  /** Test control: the process dies on its own. */
  crash(): void {
    this.killed = true;
    this.exitListener?.();
  }
}

function setup(restartDelayMs = 1000) {
  const spawned: FakeProcess[] = [];
  const keepalive = new DistroKeepalive((distro) => {
    const process = new FakeProcess(distro);
    spawned.push(process);
    return process;
  }, restartDelayMs);
  const running = (distro: string) => spawned.filter((p) => p.distro === distro && !p.killed);
  return { keepalive, spawned, running };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DistroKeepalive", () => {
  it("starts one process per distro for the first session and stops it after the last", () => {
    const { keepalive, spawned, running } = setup();
    keepalive.retain("Ubuntu", "td-a");
    keepalive.retain("Ubuntu", "td-b");
    keepalive.retain("Ubuntu", "td-a");
    expect(spawned).toHaveLength(1);
    expect(keepalive.isRunning("Ubuntu")).toBe(true);

    keepalive.release("Ubuntu", "td-a");
    expect(running("Ubuntu")).toHaveLength(1);
    keepalive.release("Ubuntu", "td-b");
    expect(running("Ubuntu")).toHaveLength(0);
    expect(keepalive.isRunning("Ubuntu")).toBe(false);
  });

  it("keeps distros apart", () => {
    const { keepalive, running } = setup();
    keepalive.retain("Ubuntu", "td-a");
    keepalive.retain("Debian", "td-a");
    keepalive.release("Ubuntu", "td-a");
    expect(running("Ubuntu")).toHaveLength(0);
    expect(running("Debian")).toHaveLength(1);
  });

  it("ignores releases of unknown sessions", () => {
    const { keepalive, running } = setup();
    keepalive.retain("Ubuntu", "td-a");
    keepalive.release("Ubuntu", "td-x");
    keepalive.release("Debian", "td-a");
    expect(running("Ubuntu")).toHaveLength(1);
  });

  it("restarts a crashed process while sessions are known", () => {
    vi.useFakeTimers();
    const { keepalive, spawned, running } = setup(1000);
    keepalive.retain("Ubuntu", "td-a");
    spawned[0]!.crash();
    expect(keepalive.isRunning("Ubuntu")).toBe(false);
    vi.advanceTimersByTime(999);
    expect(spawned).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(spawned).toHaveLength(2);
    expect(running("Ubuntu")).toHaveLength(1);
    expect(keepalive.isRunning("Ubuntu")).toBe(true);
  });

  it("does not restart after the last session was released during the delay", () => {
    vi.useFakeTimers();
    const { keepalive, spawned } = setup(1000);
    keepalive.retain("Ubuntu", "td-a");
    spawned[0]!.crash();
    keepalive.release("Ubuntu", "td-a");
    vi.advanceTimersByTime(5000);
    expect(spawned).toHaveLength(1);
  });

  it("retries when spawning throws", () => {
    vi.useFakeTimers();
    let fail = true;
    const spawned: FakeProcess[] = [];
    const keepalive = new DistroKeepalive((distro) => {
      if (fail) throw new Error("wsl.exe missing");
      const process = new FakeProcess(distro);
      spawned.push(process);
      return process;
    }, 500);
    keepalive.retain("Ubuntu", "td-a");
    expect(keepalive.isRunning("Ubuntu")).toBe(false);
    fail = false;
    vi.advanceTimersByTime(500);
    expect(spawned).toHaveLength(1);
    keepalive.dispose();
  });

  it("dispose stops every process and prevents restarts", () => {
    vi.useFakeTimers();
    const { keepalive, spawned, running } = setup(1000);
    keepalive.retain("Ubuntu", "td-a");
    keepalive.retain("Debian", "td-b");
    keepalive.dispose();
    expect(running("Ubuntu")).toHaveLength(0);
    expect(running("Debian")).toHaveLength(0);
    vi.advanceTimersByTime(5000);
    keepalive.retain("Ubuntu", "td-c");
    expect(spawned).toHaveLength(2);
  });
});
