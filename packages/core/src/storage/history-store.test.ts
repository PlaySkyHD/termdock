import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LaunchSpec } from "@termdock/protocol";
import { FakeBackend } from "../backend/fake.js";
import { SessionRegistry } from "../session/registry.js";
import { recordHistory } from "./history-recorder.js";
import type { HistorySource } from "./history-recorder.js";
import {
  ENTRY_HEADER_BYTES,
  HistoryStore,
  MAX_ENTRY_DATA_BYTES,
  historyDir,
  historySegmentPath,
  readHistory,
  segmentCapBytes,
} from "./history-store.js";
import type { HistoryEntry, HistoryStoreOptions } from "./history-store.js";

const KIB = 1024;
const MIB = 1024 * KIB;
const spec: LaunchSpec = { backend: "wsl", cwd: "/home/user" };
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "termdock-history-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Lets a redraw the registry started without awaiting it run to its end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A clock that moves on at every call, so that segment order never depends on the real time. */
function ticking(): () => number {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}

function makeStore(
  dataDir: string,
  options: Partial<HistoryStoreOptions> = {},
  limit = 64 * KIB,
): HistoryStore {
  const store = new HistoryStore({
    dataDir,
    getSettings: () => ({ historyLimitBytes: limit }),
    now: ticking(),
    flushDelayMs: 1,
    ...options,
  });
  cleanups.push(() => store.dispose());
  return store;
}

async function collect(iterator: AsyncIterable<HistoryEntry>): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  for await (const entry of iterator) entries.push({ ...entry, data: Uint8Array.from(entry.data) });
  return entries;
}

/** 1000 bytes that start with the number `n` as text, to check order and completeness. */
function numbered(n: number): Uint8Array {
  const bytes = new Uint8Array(1000).fill(46);
  bytes.set(new TextEncoder().encode(`#${n};`));
  return bytes;
}

function numberOf(entry: HistoryEntry): number {
  return Number(/^#(\d+);/.exec(new TextDecoder().decode(entry.data.subarray(0, 12)))![1]);
}

function diskUsage(dataDir: string, id: string): number {
  return ([0, 1] as const).reduce<number>((sum, index) => {
    try {
      return sum + statSync(historySegmentPath(dataDir, id, index)).size;
    } catch {
      return sum;
    }
  }, 0);
}

describe("HistoryStore: format and layout", () => {
  it("stores entries as timestamp, length and raw bytes in history/<id>/a.log", async () => {
    const dir = tempDir();
    const store = makeStore(dir, { now: () => 1_700_000_000_123 });

    store.append("s1", new Uint8Array([1, 2, 3]));
    await store.flush();

    expect(historyDir(dir, "s1")).toBe(join(dir, "history", "s1"));
    const file = readFileSync(historySegmentPath(dir, "s1", 0));
    expect(file.length).toBe(ENTRY_HEADER_BYTES + 3);
    expect(file.readBigUInt64BE(0)).toBe(1_700_000_000_123n);
    expect(file.readUInt32BE(8)).toBe(3);
    expect([...file.subarray(12)]).toEqual([1, 2, 3]);
  });

  it("refuses a session id that could leave the history directory", () => {
    expect(() => historyDir("/data", "../x")).toThrow();
    expect(() => historyDir("/data", "a/b")).toThrow();
  });

  it("splits large output into entries of at most MAX_ENTRY_DATA_BYTES and reads it back whole", async () => {
    const dir = tempDir();
    const store = makeStore(dir, {}, 10 * MIB);
    const data = new Uint8Array(MAX_ENTRY_DATA_BYTES * 2 + 5).map((_, i) => i % 251);

    store.append("s1", data);
    await store.flush();

    const entries = await collect(store.read("s1"));
    expect(entries.map((e) => e.data.length)).toEqual([MAX_ENTRY_DATA_BYTES, MAX_ENTRY_DATA_BYTES, 5]);
    expect(Buffer.concat(entries.map((e) => e.data))).toEqual(Buffer.from(data));
  });

  it("reads a session without history as empty", async () => {
    expect(await collect(readHistory(tempDir(), "nothing"))).toEqual([]);
  });
});

describe("HistoryStore: ring buffer", () => {
  it("changes segments at limit / 2, never exceeds the limit and keeps at least limit / 2 of the newest output", async () => {
    const dir = tempDir();
    const limit = 64 * KIB;
    const store = makeStore(dir, {}, limit);
    const total = 300;

    for (let n = 0; n < total; n++) {
      store.append("s1", numbered(n));
      if (n % 7 === 0) await store.flush();
    }
    await store.flush();

    for (const index of [0, 1] as const) {
      expect(statSync(historySegmentPath(dir, "s1", index)).size).toBeLessThanOrEqual(segmentCapBytes(limit));
    }
    expect(diskUsage(dir, "s1")).toBeLessThanOrEqual(limit);
    const numbers = (await collect(store.read("s1"))).map(numberOf);
    // Oldest to newest, no gap, ending with the last output.
    expect(numbers.at(-1)).toBe(total - 1);
    numbers.forEach((n, i) => i > 0 && expect(n).toBe(numbers[i - 1]! + 1));
    const kept = numbers.length * (1000 + ENTRY_HEADER_BYTES);
    expect(kept).toBeGreaterThanOrEqual(limit / 2);
    expect(numbers[0]).toBeGreaterThan(0);
  });

  it("alternates between a.log and b.log", async () => {
    const dir = tempDir();
    const store = makeStore(dir, {}, 64 * KIB);
    for (let n = 0; n < 60; n++) store.append("s1", numbered(n));
    await store.flush();
    // 60 entries of 1012 bytes at a segment size of 32 KiB: a.log holds 0..31, b.log the rest.
    expect(statSync(historySegmentPath(dir, "s1", 0)).size).toBeGreaterThan(0);
    expect(statSync(historySegmentPath(dir, "s1", 1)).size).toBeGreaterThan(0);

    for (let n = 60; n < 100; n++) store.append("s1", numbered(n));
    await store.flush();

    const numbers = (await collect(store.read("s1"))).map(numberOf);
    expect(numbers.at(-1)).toBe(99);
    numbers.forEach((n, i) => i > 0 && expect(n).toBe(numbers[i - 1]! + 1));
  });

  it("continues in the newest segment after a restart", async () => {
    const dir = tempDir();
    const first = makeStore(dir, {}, 64 * KIB);
    for (let n = 0; n < 40; n++) first.append("s1", numbered(n));
    await first.dispose();

    const second = makeStore(dir, {}, 64 * KIB);
    for (let n = 40; n < 50; n++) second.append("s1", numbered(n));
    await second.flush();

    const numbers = (await collect(second.read("s1"))).map(numberOf);
    expect(numbers.at(-1)).toBe(49);
    numbers.forEach((n, i) => i > 0 && expect(n).toBe(numbers[i - 1]! + 1));
    expect(diskUsage(dir, "s1")).toBeLessThanOrEqual(64 * KIB);
  });

  it("keeps the order when the clock is set back, also across a restart", async () => {
    const dir = tempDir();
    let t = 1_700_000_000_000;
    const backwards = () => (t -= 1);
    const first = makeStore(dir, { now: backwards }, 64 * KIB);
    for (let n = 0; n < 40; n++) first.append("s1", numbered(n));
    await first.dispose();

    const second = makeStore(dir, { now: backwards }, 64 * KIB);
    for (let n = 40; n < 120; n++) second.append("s1", numbered(n));
    await second.flush();

    const entries = await collect(second.read("s1"));
    const numbers = entries.map(numberOf);
    expect(numbers.at(-1)).toBe(119);
    numbers.forEach((n, i) => i > 0 && expect(n).toBe(numbers[i - 1]! + 1));
    entries.forEach((e, i) => i > 0 && expect(e.timestamp).toBeGreaterThanOrEqual(entries[i - 1]!.timestamp));
  });

  it("keeps the limit inside the allowed range", () => {
    expect(segmentCapBytes(1)).toBe(32 * KIB);
    expect(segmentCapBytes(10 * MIB)).toBe(5 * MIB);
    expect(segmentCapBytes(Number.NaN)).toBe(5 * MIB);
  });
});

describe("HistoryStore: damaged last entry", () => {
  it("skips an entry cut off by a crash and keeps the entries before it", async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    for (let n = 0; n < 3; n++) store.append("s1", numbered(n));
    await store.flush();
    const path = historySegmentPath(dir, "s1", 0);
    const whole = readFileSync(path);
    writeFileSync(path, whole.subarray(0, whole.length - 400));

    expect((await collect(store.read("s1"))).map(numberOf)).toEqual([0, 1]);
  });

  it("skips a header cut off in the middle", async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    store.append("s1", numbered(0));
    await store.flush();
    appendFileSync(historySegmentPath(dir, "s1", 0), Buffer.from([0, 0, 0, 0, 0, 0]));

    expect((await collect(store.read("s1"))).map(numberOf)).toEqual([0]);
  });

  it("stops at an implausible length instead of reading on", async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    store.append("s1", numbered(0));
    await store.flush();
    const bad = Buffer.alloc(ENTRY_HEADER_BYTES + 10);
    bad.writeUInt32BE(0xffffffff, 8);
    appendFileSync(historySegmentPath(dir, "s1", 0), bad);

    expect((await collect(store.read("s1"))).map(numberOf)).toEqual([0]);
  });

  it("cuts the damaged tail when writing again so that new entries stay readable", async () => {
    const dir = tempDir();
    const first = makeStore(dir);
    for (let n = 0; n < 3; n++) first.append("s1", numbered(n));
    await first.dispose();
    const path = historySegmentPath(dir, "s1", 0);
    writeFileSync(path, readFileSync(path).subarray(0, 2 * 1012 + 500));

    const second = makeStore(dir);
    second.append("s1", numbered(3));
    await second.flush();

    expect((await collect(second.read("s1"))).map(numberOf)).toEqual([0, 1, 3]);
  });
});

describe("HistoryStore: writing never blocks the output", () => {
  it("queues without waiting for the disk and drops the oldest queued entries when the queue is full", async () => {
    const dir = tempDir();
    const store = makeStore(dir, { maxPendingBytes: 10 * 1012, flushDelayMs: 10_000 }, 10 * MIB);

    // Nothing has been written yet: the flush is far away, so this is the worst case of a slow disk.
    for (let n = 0; n < 100; n++) store.append("s1", numbered(n));

    const stats = store.stats("s1");
    expect(stats.pendingBytes).toBeLessThanOrEqual(10 * 1012);
    expect(stats.droppedEntries).toBe(90);
    expect(stats.droppedBytes).toBe(90 * 1012);
    await store.flush();
    expect((await collect(store.read("s1"))).map(numberOf)).toEqual(
      Array.from({ length: 10 }, (_, i) => 90 + i),
    );
    expect(store.stats("s1").pendingBytes).toBe(0);
  });

  it("reports a failing write, counts the entries as dropped and does not throw", async () => {
    const dir = tempDir();
    // A file where the history directory should be.
    writeFileSync(join(dir, "history"), "x");
    const errors: unknown[] = [];
    const store = makeStore(dir, { onError: (error) => errors.push(error) });

    expect(() => store.append("s1", numbered(0))).not.toThrow();
    await store.flush();

    expect(errors).toHaveLength(1);
    expect(store.stats("s1").droppedEntries).toBe(1);
  });

  it("ignores output after dispose", async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.dispose();
    store.append("s1", numbered(0));
    await store.flush();
    expect(await collect(readHistory(dir, "s1"))).toEqual([]);
  });
});

/** Registry with a fake backend whose output goes into a history store. */
function recorded(dataDir: string, options: { defaultLogging?: boolean; limit?: number } = {}) {
  const backend = new FakeBackend();
  const registry = new SessionRegistry({
    backends: [backend],
    defaultLoggingEnabled: () => options.defaultLogging ?? true,
  });
  const store = makeStore(dataDir, {}, options.limit ?? 10 * MIB);
  const subscription = recordHistory(registry, store);
  cleanups.push(() => {
    subscription.dispose();
    registry.dispose();
  });
  return { backend, registry, store };
}

describe("recordHistory", () => {
  it("records the output of sessions with logging and not of sessions without", async () => {
    const { backend, registry, store } = recorded(tempDir());
    const logged = await registry.create({ name: "a", launch: spec });
    const silent = await registry.create({ name: "b", launch: spec, loggingEnabled: false });

    backend.pty(logged.id).emitData("hello\r\n");
    backend.pty(silent.id).emitData("secret\r\n");
    await store.flush();

    const text = (await collect(store.read(logged.id))).map((e) => new TextDecoder().decode(e.data)).join("");
    expect(text).toBe("hello\r\n");
    expect(await collect(store.read(silent.id))).toEqual([]);
  });

  it("does not record the redraw when a second view attaches, but output before and after (issue #88)", async () => {
    const { backend, registry, store } = recorded(tempDir());
    const session = await registry.create({ name: "a", launch: spec });
    backend.setSnapshot(session.id, "hello");
    // Like tmux after `refresh-client`: the repaint arrives through the PTY before the call returns.
    backend.onRedraw = (id) => backend.pty(id).emitData("\x1b[Hhello\x1b[K");
    await registry.attachView(session.id, "view-a");
    await settle();
    backend.pty(session.id).emitData("hello\r\n");
    await store.flush();
    const before = await collect(store.read(session.id));

    await registry.attachView(session.id, "view-b");
    await settle();
    await store.flush();
    const afterAttach = await collect(store.read(session.id));
    backend.pty(session.id).emitData("after\r\n");
    await store.flush();

    expect(before.map((e) => new TextDecoder().decode(e.data))).toEqual(["hello\r\n"]);
    expect(afterAttach).toHaveLength(1);
    const text = (await collect(store.read(session.id))).map((e) => new TextDecoder().decode(e.data));
    expect(text).toEqual(["hello\r\n", "after\r\n"]);
  });

  it("skips output marked as redraw (issue #88)", async () => {
    const store = makeStore(tempDir());
    let listener: Parameters<HistorySource["onOutput"]>[0] | undefined;
    const source: HistorySource = {
      onOutput: (l) => {
        listener = l;
        return { dispose: () => (listener = undefined) };
      },
      get: () => ({ loggingEnabled: true }),
    };
    recordHistory(source, store);
    const encode = (text: string) => new TextEncoder().encode(text);

    listener!({ sessionId: "s1", data: encode("real"), fromRedraw: false });
    listener!({ sessionId: "s1", data: encode("repaint"), fromRedraw: true });
    listener!({ sessionId: "s1", data: encode("later"), fromRedraw: false });
    await store.flush();

    const text = (await collect(store.read("s1"))).map((e) => new TextDecoder().decode(e.data));
    expect(text).toEqual(["real", "later"]);
  });

  it("takes the default of a new session from the setting", async () => {
    const { registry } = recorded(tempDir(), { defaultLogging: false });

    const session = await registry.create({ name: "a", launch: spec });
    const explicit = await registry.create({ name: "b", launch: spec, loggingEnabled: true });

    expect(session.loggingEnabled).toBe(false);
    expect(explicit.loggingEnabled).toBe(true);
  });

  it("stops writing when logging is switched off and keeps what is stored", async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    let listener: Parameters<HistorySource["onOutput"]>[0] | undefined;
    let loggingEnabled = true;
    const source: HistorySource = {
      onOutput: (l) => {
        listener = l;
        return { dispose: () => (listener = undefined) };
      },
      get: () => ({ loggingEnabled }),
    };
    recordHistory(source, store);
    const emit = (text: string) =>
      listener!({ sessionId: "s1", data: new TextEncoder().encode(text), fromRedraw: false });

    emit("before");
    await store.flush();
    loggingEnabled = false;
    emit("after");
    await store.flush();
    loggingEnabled = true;
    emit("again");
    await store.flush();

    const text = (await collect(store.read("s1"))).map((e) => new TextDecoder().decode(e.data));
    expect(text).toEqual(["before", "again"]);
  });

  it("holds the limit under 50 MiB of output while the PTY keeps flowing (issue #59)", async () => {
    const dir = tempDir();
    const limit = 10 * MIB;
    const { backend, registry, store } = recorded(dir, { limit });
    const session = await registry.create({ name: "load", launch: spec });
    const pty = backend.pty(session.id);
    const chunkBytes = 64 * KIB;
    const chunks = (50 * MIB) / chunkBytes;
    const chunk = new Uint8Array(chunkBytes);
    const startedAt = Date.now();
    let slowestEmit = 0;

    for (let n = 0; n < chunks; n++) {
      // Every 16 KiB entry of the chunk starts with the number of the chunk.
      for (let offset = 0; offset < chunkBytes; offset += MAX_ENTRY_DATA_BYTES) {
        new DataView(chunk.buffer).setUint32(offset, n);
      }
      const before = performance.now();
      pty.emitData(chunk);
      slowestEmit = Math.max(slowestEmit, performance.now() - before);
      // The disk gets its turn now and then, as in the real Core between PTY reads.
      if (n % 8 === 7) await new Promise((resolve) => setImmediate(resolve));
    }
    await store.flush();

    expect(diskUsage(dir, session.id)).toBeLessThanOrEqual(limit);
    expect(diskUsage(dir, session.id)).toBeGreaterThanOrEqual(limit / 2);
    const numbers: number[] = [];
    for await (const entry of store.read(session.id)) {
      numbers.push(new DataView(entry.data.buffer, entry.data.byteOffset, 4).getUint32(0));
    }
    // Oldest to newest across both segments, ending with the last chunk.
    expect(numbers.at(-1)).toBe(chunks - 1);
    numbers.forEach((n, i) => i > 0 && expect(n).toBeGreaterThanOrEqual(numbers[i - 1]!));
    // Emitting never waited for the disk: one emit takes milliseconds, not seconds.
    expect(slowestEmit).toBeLessThan(1000);
    expect(Date.now() - startedAt).toBeLessThan(60_000);
    expect(store.stats(session.id).pendingBytes).toBe(0);
  }, 90_000);
});

describe("HistoryStore: forget and remove", () => {
  it("drops the queue and never creates the directory afterwards", async () => {
    const dir = tempDir();
    const store = makeStore(dir, { flushDelayMs: 1 });
    store.append("s1", numbered(0));

    await store.forget("s1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await store.flush();

    expect(existsSync(historyDir(dir, "s1"))).toBe(false);
    expect(store.stats("s1")).toEqual({ pendingBytes: 0, droppedEntries: 0, droppedBytes: 0 });
  });

  it("removes the directory during a running flush and leaves nothing behind", async () => {
    const dir = tempDir();
    const store = makeStore(dir, { flushDelayMs: 10_000 });
    store.append("s1", numbered(0));
    const flushing = store.flush("s1");
    store.append("s1", numbered(1));

    await store.remove("s1");
    await flushing;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(existsSync(historyDir(dir, "s1"))).toBe(false);
    expect(store.stats("s1").pendingBytes).toBe(0);
    await store.flush();
    expect(existsSync(historyDir(dir, "s1"))).toBe(false);
    await store.remove("s1");
    expect(existsSync(historyDir(dir, "s1"))).toBe(false);
    await store.remove("s1");
    await store.remove("never");
  });

  it("removes the files of a session that was written before", async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    store.append("s1", numbered(0));
    await store.flush();
    expect(existsSync(historyDir(dir, "s1"))).toBe(true);

    await store.remove("s1");

    expect(existsSync(historyDir(dir, "s1"))).toBe(false);
    // Idempotent, also for a session that never had a history.
    await store.remove("s1");
    await store.remove("never");
  });

  it("waits for an open reader before it deletes the directory", async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    store.append("s1", numbered(0));
    store.append("s1", numbered(1));
    await store.flush();
    const reader = store.read("s1");
    await reader.next();

    let removed = false;
    const removing = store.remove("s1").then(() => void (removed = true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(removed).toBe(false);
    expect(existsSync(historyDir(dir, "s1"))).toBe(true);

    await reader.return(undefined);
    await removing;
    expect(existsSync(historyDir(dir, "s1"))).toBe(false);
  });

  it("starts a fresh log when output arrives after remove", async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    store.append("s1", numbered(0));
    await store.flush();
    await store.remove("s1");

    store.append("s1", numbered(1));
    await store.flush();

    expect((await collect(store.read("s1"))).map(numberOf)).toEqual([1]);
  });

  it("leaves no log behind for a session that was only read or was forgotten", async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    expect(await collect(store.read("s1"))).toEqual([]);
    store.append("s2", numbered(0));
    await store.flush();
    await store.forget("s2");
    await store.flush("s2");

    expect(existsSync(historyDir(dir, "s1"))).toBe(false);
    expect(store.stats("s2").droppedEntries).toBe(0);
  });
});

describe("HistoryStore: reader and writer", () => {
  it("holds a segment change back until the read ends", async () => {
    const dir = tempDir();
    const store = makeStore(dir, {}, 64 * KIB);
    // a.log holds 0..30, b.log 31..59: the next segment change empties a.log.
    for (let n = 0; n < 60; n++) store.append("s1", numbered(n));
    await store.flush();

    const seen: number[] = [];
    let flushed = false;
    let flushing: Promise<void> | undefined;
    for await (const entry of store.read("s1")) {
      seen.push(numberOf(entry));
      if (seen.length === 1) {
        for (let n = 60; n < 70; n++) store.append("s1", numbered(n));
        flushing = store.flush().then(() => void (flushed = true));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(flushed).toBe(false);
      }
    }
    expect(seen).toEqual(Array.from({ length: 60 }, (_, i) => i));

    await flushing;
    expect(flushed).toBe(true);
    const after = (await collect(store.read("s1"))).map(numberOf);
    expect(after.at(-1)).toBe(69);
    expect(after[0]).toBeGreaterThan(0);
  });

  it("lets the writer go on when a reader stops early", async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    store.append("s1", numbered(0));
    store.append("s1", numbered(1));
    await store.flush();

    for await (const entry of store.read("s1")) {
      expect(numberOf(entry)).toBe(0);
      break;
    }
    store.append("s1", numbered(2));
    await store.flush();

    expect((await collect(store.read("s1"))).map(numberOf)).toEqual([0, 1, 2]);
  });
});

describe("HistoryStore: lowered limit", () => {
  const written = async (dir: string, count: number, limit: number) => {
    const store = makeStore(dir, {}, limit);
    for (let n = 0; n < count; n++) store.append("s1", numbered(n));
    await store.dispose();
  };

  it("ends an oversized active segment at the next write", async () => {
    const dir = tempDir();
    await written(dir, 400, MIB);

    const small = makeStore(dir, {}, 64 * KIB);
    small.append("s1", numbered(1000));
    await small.flush();

    expect(diskUsage(dir, "s1")).toBeLessThanOrEqual(64 * KIB);
    expect((await collect(small.read("s1"))).map(numberOf)).toEqual([1000]);
  });

  it("empties an oversized inactive segment at the next write", async () => {
    const dir = tempDir();
    // Cap 128 KiB: a.log holds 0..128, b.log the one after it.
    await written(dir, 130, 256 * KIB);

    const small = makeStore(dir, {}, 64 * KIB);
    small.append("s1", numbered(1000));
    await small.flush();

    expect(diskUsage(dir, "s1")).toBeLessThanOrEqual(64 * KIB);
    const numbers = (await collect(small.read("s1"))).map(numberOf);
    // a.log (0..128) is over the new cap and emptied; b.log (129) stays.
    expect(numbers).toEqual([129, 1000]);
  });
});
