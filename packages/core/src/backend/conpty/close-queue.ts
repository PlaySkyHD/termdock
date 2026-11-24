// Closing of PTYs one after the other (issue #160, ADR 0008).
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Runs closing steps one after the other, each until it is done. node-pty 1.1.0 crashes now and then when several
 * ConPTY processes end at the same moment: its exit threads remove their entries from one shared list without a lock
 * (`remove_pty_baton`, conpty.cc). A failed step is reported and does not stop the steps after it.
 */
export class CloseQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly onError: (error: unknown) => void = () => {}) {}

  /** Steps queued and not done yet. */
  get size(): number {
    return this.pending;
  }

  /** Queues `step`; resolves once it is done, also when it failed. */
  add(step: () => Promise<void>): Promise<void> {
    this.pending += 1;
    const done = this.tail
      .then(step)
      .catch((error: unknown) => {
        this.onError(error);
      })
      .finally(() => {
        this.pending -= 1;
      });
    this.tail = done;
    return done;
  }

  /**
   * Resolves true once every step is done, also those queued while it waits; false when that takes longer than
   * `timeoutMs` (the steps keep running).
   */
  async idle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tail = this.tail;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return this.pending === 0;
      const abort = new AbortController();
      const done = await Promise.race([
        tail.then(() => true),
        sleep(remaining, false, { signal: abort.signal }).catch(() => false),
      ]);
      abort.abort();
      if (!done) return this.pending === 0;
      if (tail === this.tail) return true;
    }
  }
}

/** Polls `predicate` every `pollMs` until it holds; resolves false after `timeoutMs`. */
export async function waitUntil(predicate: () => boolean, timeoutMs: number, pollMs = 10): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
  return true;
}
