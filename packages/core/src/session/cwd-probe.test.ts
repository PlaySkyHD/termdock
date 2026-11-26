// Throttled directory queries of one session (issue #199, openspec change session-current-cwd).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CWD_MAX_INTERVAL_MS, CWD_MIN_INTERVAL_MS, CWD_QUIET_MS, CwdProbe } from "./cwd-probe.js";

interface Harness {
  probe: CwdProbe;
  /** Start time (fake clock) of every query. */
  starts: number[];
  results: string[];
  /** Queries that have not answered; `answer` settles the oldest. */
  pending: Array<(cwd: string | undefined) => void>;
  answer(cwd: string | undefined): Promise<void>;
}

function harness(): Harness {
  const starts: number[] = [];
  const results: string[] = [];
  const pending: Array<(cwd: string | undefined) => void> = [];
  const probe = new CwdProbe({
    query: () =>
      new Promise((resolve) => {
        starts.push(Date.now());
        pending.push(resolve);
      }),
    onResult: (cwd) => results.push(cwd),
    now: () => Date.now(),
  });
  return {
    probe,
    starts,
    results,
    pending,
    answer: async (cwd) => {
      pending.shift()?.(cwd);
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

describe("CwdProbe", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 10_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queries once the output has paused for CWD_QUIET_MS", async () => {
    const h = harness();
    h.probe.activity();
    await vi.advanceTimersByTimeAsync(CWD_QUIET_MS - 1);
    expect(h.starts).toEqual([]);
    h.probe.activity();
    await vi.advanceTimersByTimeAsync(CWD_QUIET_MS - 1);
    expect(h.starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.starts).toHaveLength(1);
    await h.answer("/tmp");
    expect(h.results).toEqual(["/tmp"]);
  });

  it("queries at once on poke", async () => {
    const h = harness();
    h.probe.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.starts).toHaveLength(1);
  });

  it("does not let steady output put off a poke", async () => {
    const h = harness();
    h.probe.poke();
    h.probe.activity();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.starts).toHaveLength(1);
  });

  it("keeps CWD_MIN_INTERVAL_MS between the start of two queries", async () => {
    const h = harness();
    h.probe.poke();
    await vi.advanceTimersByTimeAsync(0);
    await h.answer("/a");
    h.probe.poke();
    h.probe.activity();
    await vi.advanceTimersByTimeAsync(CWD_MIN_INTERVAL_MS - 1);
    expect(h.starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.starts).toHaveLength(2);
    expect(h.starts[1]! - h.starts[0]!).toBe(CWD_MIN_INTERVAL_MS);
  });

  it("runs one query at a time and plans exactly one more for output meanwhile", async () => {
    const h = harness();
    h.probe.poke();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i += 1) h.probe.activity();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.starts).toHaveLength(1);
    await h.answer("/a");
    await vi.advanceTimersByTimeAsync(CWD_MIN_INTERVAL_MS);
    expect(h.starts).toHaveLength(2);
    await h.answer("/b");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.starts).toHaveLength(2);
    expect(h.results).toEqual(["/a", "/b"]);
  });

  it("backs off after answers that bring nothing new, up to CWD_MAX_INTERVAL_MS; input and a new answer reset it", async () => {
    const h = harness();
    /** Answers the running query, prints at once and checks that the next query starts after exactly `gap`. */
    const nextAfter = async (answer: string | undefined, gap: number): Promise<void> => {
      const count = h.starts.length;
      await h.answer(answer);
      h.probe.activity();
      await vi.advanceTimersByTimeAsync(gap - 1);
      expect(h.starts, `before ${gap} ms`).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.starts, `after ${gap} ms`).toHaveLength(count + 1);
    };
    h.probe.poke();
    await vi.advanceTimersByTimeAsync(0);
    await nextAfter("/a", CWD_MIN_INTERVAL_MS);
    await nextAfter("/a", 2_000);
    await nextAfter(undefined, 4_000);
    await nextAfter("/a", CWD_MAX_INTERVAL_MS);
    await nextAfter("/a", CWD_MAX_INTERVAL_MS);
    // Someone typed: the interval is back at its start.
    await h.answer("/a");
    h.probe.input();
    h.probe.activity();
    await vi.advanceTimersByTimeAsync(CWD_MIN_INTERVAL_MS);
    expect(h.starts).toHaveLength(7);
    // A new directory resets it as well.
    await nextAfter("/b", CWD_MIN_INTERVAL_MS);
  });

  it("asks only after the last output of a stream with short gaps, never more than once a second", async () => {
    const h = harness();
    for (let t = 0; t < 3_000; t += 100) {
      h.probe.activity();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(h.starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(CWD_QUIET_MS);
    expect(h.starts).toHaveLength(1);
  });

  it("drops an empty answer and a failing query", async () => {
    const results: string[] = [];
    let calls = 0;
    const probe = new CwdProbe({
      query: async () => {
        calls += 1;
        if (calls === 1) return undefined;
        throw new Error("wsl.exe failed");
      },
      onResult: (cwd) => results.push(cwd),
      now: () => Date.now(),
    });
    probe.poke();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CWD_MIN_INTERVAL_MS);
    probe.poke();
    await vi.advanceTimersByTimeAsync(CWD_MIN_INTERVAL_MS);
    expect(calls).toBe(2);
    expect(results).toEqual([]);
    probe.dispose();
  });

  it("idle cancels the planned query and the follow-up", async () => {
    const h = harness();
    h.probe.activity();
    h.probe.idle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.starts).toEqual([]);
    h.probe.poke();
    await vi.advanceTimersByTimeAsync(0);
    h.probe.activity();
    h.probe.idle();
    await h.answer("/a");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.starts).toHaveLength(1);
    expect(h.results).toEqual(["/a"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose clears its timer, drops a pending answer and plans nothing more", async () => {
    const h = harness();
    h.probe.poke();
    await vi.advanceTimersByTimeAsync(0);
    h.probe.activity();
    h.probe.dispose();
    await h.answer("/late");
    h.probe.activity();
    h.probe.poke();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.results).toEqual([]);
    expect(h.starts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
