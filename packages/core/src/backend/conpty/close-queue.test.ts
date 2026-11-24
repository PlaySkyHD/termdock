// The queue that closes PTYs one after the other (issue #160).
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { CloseQueue, waitUntil } from "./close-queue.js";

describe("CloseQueue", () => {
  it("starts a step only after the one before it is done", async () => {
    const queue = new CloseQueue();
    const events: string[] = [];
    const step = (name: string, ms: number) => async () => {
      events.push(`start ${name}`);
      await sleep(ms);
      events.push(`end ${name}`);
    };
    const done = [queue.add(step("a", 30)), queue.add(step("b", 1)), queue.add(step("c", 10))];
    expect(queue.size).toBe(3);
    await Promise.all(done);
    expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(queue.size).toBe(0);
  });

  it("reports a failed step and runs the steps after it", async () => {
    const errors: unknown[] = [];
    const queue = new CloseQueue((error) => errors.push(error));
    let ran = false;
    const failed = queue.add(async () => {
      throw new Error("boom");
    });
    const after = queue.add(async () => {
      ran = true;
    });
    await expect(failed).resolves.toBeUndefined();
    await after;
    expect(ran).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it("idle waits for steps queued while it waits", async () => {
    const queue = new CloseQueue();
    let second = false;
    void queue.add(async () => {
      await sleep(20);
      void queue.add(async () => {
        await sleep(20);
        second = true;
      });
    });
    await expect(queue.idle(5_000)).resolves.toBe(true);
    expect(second).toBe(true);
  });

  it("idle gives up after its timeout while a step hangs; the steps keep running", async () => {
    const queue = new CloseQueue();
    let release: () => void = () => {};
    void queue.add(() => new Promise<void>((resolve) => (release = resolve)));
    const started = Date.now();
    await expect(queue.idle(50)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    release();
    await expect(queue.idle(1_000)).resolves.toBe(true);
  });

  it("an empty queue is idle at once", async () => {
    await expect(new CloseQueue().idle(0)).resolves.toBe(true);
  });
});

describe("waitUntil", () => {
  it("resolves true once the predicate holds and false after the timeout", async () => {
    let flag = false;
    setTimeout(() => (flag = true), 20);
    await expect(waitUntil(() => flag, 2_000, 5)).resolves.toBe(true);
    await expect(waitUntil(() => false, 30, 5)).resolves.toBe(false);
  });
});
