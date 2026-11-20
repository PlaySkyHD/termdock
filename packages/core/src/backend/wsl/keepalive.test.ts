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

  describe("backoff", () => {
    function backoffSetup() {
      vi.useFakeTimers();
      let time = 0;
      const spawned: FakeProcess[] = [];
      const keepalive = new DistroKeepalive(
        (distro) => {
          const process = new FakeProcess(distro);
          spawned.push(process);
          return process;
        },
        1000,
        { maxDelayMs: 8000, stableMs: 30_000, now: () => time },
      );
      return { keepalive, spawned, advance: (ms: number) => ((time += ms), vi.advanceTimersByTime(ms)) };
    }

    it("doubles the restart delay while the process keeps dying, up to the maximum", () => {
      const { keepalive, spawned, advance } = backoffSetup();
      keepalive.retain("Ubuntu", "td-a");
      for (const delay of [1000, 2000, 4000, 8000, 8000]) {
        spawned.at(-1)!.crash();
        const before = spawned.length;
        advance(delay - 1);
        expect(spawned).toHaveLength(before);
        advance(1);
        expect(spawned).toHaveLength(before + 1);
      }
      keepalive.dispose();
    });

    it("backs off when spawning throws", () => {
      vi.useFakeTimers();
      let attempts = 0;
      const keepalive = new DistroKeepalive(
        () => {
          attempts++;
          throw new Error("wsl.exe missing");
        },
        1000,
        { maxDelayMs: 4000 },
      );
      keepalive.retain("Ubuntu", "td-a");
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(2000);
      expect(attempts).toBe(3);
      vi.advanceTimersByTime(3999);
      expect(attempts).toBe(3);
      vi.advanceTimersByTime(1);
      expect(attempts).toBe(4);
      keepalive.dispose();
    });

    it("resets the delay after the process ran longer than the stable time", () => {
      const { keepalive, spawned, advance } = backoffSetup();
      keepalive.retain("Ubuntu", "td-a");
      for (const delay of [1000, 2000]) {
        spawned.at(-1)!.crash();
        advance(delay);
      }
      advance(30_001);
      spawned.at(-1)!.crash();
      const before = spawned.length;
      advance(1000);
      expect(spawned).toHaveLength(before + 1);
      keepalive.dispose();
    });
  });

  describe("dispose hands the keepalives over (issue #140)", () => {
    it("leaves running processes alive and starts or restarts nothing afterwards", async () => {
      vi.useFakeTimers();
      const { keepalive, spawned, running } = setup(1000);
      keepalive.retain("Ubuntu", "td-a");
      keepalive.retain("Debian", "td-b");
      vi.advanceTimersByTime(1000);
      let done = false;
      void keepalive.dispose().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
      expect(running("Ubuntu")).toHaveLength(1);
      expect(running("Debian")).toHaveLength(1);
      expect(keepalive.isRunning("Ubuntu")).toBe(false);
      // Neither a death after dispose nor a new session starts one.
      spawned[0]!.crash();
      await vi.advanceTimersByTimeAsync(120_000);
      keepalive.retain("Ubuntu", "td-d");
      expect(spawned).toHaveLength(2);
    });

    it("starts a keepalive at once for a distro whose restart is pending (review PR #148)", async () => {
      vi.useFakeTimers();
      const { keepalive, spawned, running } = setup(1000);
      keepalive.retain("Ubuntu", "td-a");
      vi.advanceTimersByTime(5000);
      // Ended at once, e.g. "no server running": the restart waits 1 s, and the core shuts down within it.
      spawned[0]!.crash();
      let done = false;
      void keepalive.dispose().then(() => (done = true));
      expect(spawned).toHaveLength(2);
      expect(running("Ubuntu")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(spawned).toHaveLength(2);
    });

    it("starts a young keepalive that ends during the hand-over once more, then gives up", async () => {
      vi.useFakeTimers();
      const { keepalive, spawned } = setup(1000);
      keepalive.retain("Ubuntu", "td-a");
      let done = false;
      void keepalive.dispose().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(100);
      spawned[0]!.crash();
      await vi.advanceTimersByTimeAsync(0);
      expect(spawned).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(100);
      spawned[1]!.crash();
      await vi.advanceTimersByTimeAsync(0);
      expect(spawned).toHaveLength(3);
      spawned[2]!.crash();
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
      expect(spawned).toHaveLength(3);
    });

    it("defers the start of a retained session until start, but hands one over for it (review PR #148)", async () => {
      vi.useFakeTimers();
      const { keepalive, spawned, running } = setup(1000);
      keepalive.retain("Ubuntu", "td-a", { deferStart: true });
      expect(spawned).toHaveLength(0);
      keepalive.start("Ubuntu");
      expect(running("Ubuntu")).toHaveLength(1);

      keepalive.retain("Debian", "td-b", { deferStart: true });
      let done = false;
      void keepalive.dispose().then(() => (done = true));
      expect(running("Debian")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(done).toBe(true);
      keepalive.start("Debian");
      expect(spawned).toHaveLength(2);
    });

    it("waits for the dispose of a distro without sessions for nothing", async () => {
      const { keepalive, spawned } = setup(1000);
      keepalive.retain("Ubuntu", "td-a");
      keepalive.release("Ubuntu", "td-a");
      await keepalive.dispose();
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.killed).toBe(true);
    });
  });

  describe("take-over of left-behind keepalives (issue #140)", () => {
    function takeOverSetup() {
      const spawned: FakeProcess[] = [];
      const order: string[] = [];
      const pending: { distro: string; finish: (fail?: boolean) => void }[] = [];
      const keepalive = new DistroKeepalive(
        (distro) => {
          order.push(`spawn ${distro}`);
          const process = new FakeProcess(distro);
          spawned.push(process);
          return process;
        },
        1000,
        {
          takeOver: (distro) => {
            order.push(`takeOver ${distro}`);
            return new Promise((resolve, reject) =>
              pending.push({ distro, finish: (fail) => (fail ? reject(new Error("pkill")) : resolve(0)) }),
            );
          },
        },
      );
      return { keepalive, spawned, order, pending };
    }

    it("ends left-behind keepalives once per distro before the first start", async () => {
      vi.useFakeTimers();
      const { keepalive, spawned, order, pending } = takeOverSetup();
      keepalive.retain("Ubuntu", "td-a");
      keepalive.retain("Ubuntu", "td-b");
      expect(spawned).toHaveLength(0);
      expect(keepalive.isRunning("Ubuntu")).toBe(false);
      pending[0]!.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(spawned).toHaveLength(1);
      // A restart and a new start after the last session do not take over again: only this instance's ran.
      spawned[0]!.crash();
      await vi.advanceTimersByTimeAsync(1000);
      keepalive.release("Ubuntu", "td-a");
      keepalive.release("Ubuntu", "td-b");
      keepalive.retain("Ubuntu", "td-c");
      expect(order).toEqual(["takeOver Ubuntu", "spawn Ubuntu", "spawn Ubuntu", "spawn Ubuntu"]);
      keepalive.dispose();
    });

    it("starts anyway when the take-over fails or throws", async () => {
      const { keepalive, spawned, pending } = takeOverSetup();
      keepalive.retain("Ubuntu", "td-a");
      pending[0]!.finish(true);
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(spawned).toHaveLength(1);

      const throwing = new DistroKeepalive(
        (distro) => {
          const process = new FakeProcess(distro);
          spawned.push(process);
          return process;
        },
        1000,
        {
          takeOver: () => {
            throw new Error("no wsl.exe");
          },
        },
      );
      throwing.retain("Debian", "td-b");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(spawned.map((p) => p.distro)).toEqual(["Ubuntu", "Debian"]);
      keepalive.dispose();
      throwing.dispose();
    });

    it("starts nothing when the last session was released during the take-over", async () => {
      const { keepalive, spawned, pending } = takeOverSetup();
      keepalive.retain("Ubuntu", "td-a");
      keepalive.release("Ubuntu", "td-a");
      for (const take of pending) take.finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(spawned).toHaveLength(0);
      await keepalive.dispose();
      expect(spawned).toHaveLength(0);
    });

    it("takes over before handing a keepalive over for a session whose start was deferred", async () => {
      vi.useFakeTimers();
      const { keepalive, order, pending } = takeOverSetup();
      keepalive.retain("Ubuntu", "td-a", { deferStart: true });
      expect(order).toEqual([]);
      void keepalive.dispose();
      expect(order).toEqual(["takeOver Ubuntu"]);
      pending[0]!.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(["takeOver Ubuntu", "spawn Ubuntu"]);
    });

    it("hands over exactly one keepalive when disposed during the take-over (review PR #148)", async () => {
      vi.useFakeTimers();
      const { keepalive, spawned, order, pending } = takeOverSetup();
      keepalive.retain("Debian", "td-b");
      let done = false;
      void keepalive.dispose().then(() => (done = true));
      // The old keepalive may already be gone; the hand-over waits for the take-over, then starts one.
      await vi.advanceTimersByTimeAsync(5000);
      expect(spawned).toHaveLength(0);
      expect(done).toBe(false);
      pending[0]!.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(["takeOver Debian", "spawn Debian"]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(done).toBe(true);
      expect(spawned.filter((p) => !p.killed)).toHaveLength(1);
    });

    it("lets a session retained again during the take-over wait for it, so its keepalive is never ended", async () => {
      const { keepalive, spawned, order, pending } = takeOverSetup();
      keepalive.retain("Ubuntu", "td-a");
      keepalive.release("Ubuntu", "td-a");
      keepalive.retain("Ubuntu", "td-b");
      expect(spawned).toHaveLength(0);
      pending[0]!.finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(order).toEqual(["takeOver Ubuntu", "spawn Ubuntu"]);
      expect(keepalive.isRunning("Ubuntu")).toBe(true);
      keepalive.dispose();
    });
  });
});
