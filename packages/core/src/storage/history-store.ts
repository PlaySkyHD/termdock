// Persistent session history as ring buffer of two segment files (ADR 0004, spec history).
// Entry: uint64 BE timestamp ms | uint32 BE length | raw bytes. Writing never blocks the PTY: `append` only queues
// into a bounded buffer; a background flush writes it. When the writer cannot keep up, the oldest queued entries
// are dropped and counted.
import { mkdir, open, rm, stat, truncate, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_HISTORY_LIMIT_BYTES,
  MAX_HISTORY_LIMIT_BYTES,
  MIN_HISTORY_LIMIT_BYTES,
} from "@termdock/protocol";
import type { Settings, SessionId } from "@termdock/protocol";

/** The two segment files of a session; the one with the newest first entry is the active one. */
export const HISTORY_SEGMENT_FILES = ["a.log", "b.log"] as const;
/** Bytes before the data of an entry: 8 timestamp, 4 length. */
export const ENTRY_HEADER_BYTES = 12;
/** Longest data of one entry; longer output is split. Also the plausibility limit of the reader. */
export const MAX_ENTRY_DATA_BYTES = 16 * 1024;
/** Bytes a session may hold in its queue before the oldest queued entries are dropped. */
export const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;
/** Waits this long before writing queued entries, so that bursts become one write. */
export const DEFAULT_FLUSH_DELAY_MS = 25;

const READ_CHUNK_BYTES = 64 * 1024;

export type HistorySettings = Pick<Settings, "historyLimitBytes" | "historyEnabledByDefault">;

/** `<dataDir>/history/<sessionId>`: the directory deleting a session removes (ADR 0004). */
export function historyDir(dataDir: string, sessionId: SessionId): string {
  // Ids come from the registry (UUIDs); refuse anything that could leave the history directory.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Invalid session id for the history path");
  return join(dataDir, "history", sessionId);
}

/** Path of segment `a.log` (index 0) or `b.log` (index 1). */
export function historySegmentPath(dataDir: string, sessionId: SessionId, index: 0 | 1): string {
  return join(historyDir(dataDir, sessionId), HISTORY_SEGMENT_FILES[index]);
}

export interface HistoryEntry {
  /** Milliseconds since the epoch at which the Core received the output. */
  timestamp: number;
  data: Uint8Array;
}

/** Limit of the setting, kept inside the allowed range. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_HISTORY_LIMIT_BYTES;
  return Math.min(MAX_HISTORY_LIMIT_BYTES, Math.max(MIN_HISTORY_LIMIT_BYTES, Math.floor(limit)));
}

/** Size one segment may reach: half the limit, so both together never exceed it. */
export function segmentCapBytes(limitBytes: number): number {
  return Math.floor(clampLimit(limitBytes) / 2);
}

export interface HistoryStats {
  /** Bytes queued and not yet written. */
  pendingBytes: number;
  /** Entries dropped because the queue was full or a write failed. */
  droppedEntries: number;
  droppedBytes: number;
}

export interface HistoryStoreOptions {
  dataDir: string;
  /** Read at every write, so a changed limit applies without restart (at the next segment change). */
  getSettings: () => Pick<Settings, "historyLimitBytes">;
  now?: () => number;
  /** Called when writing fails; the failed entries are dropped. Defaults to `console.error` of the message. */
  onError?: (error: unknown, sessionId: SessionId) => void;
  maxPendingBytes?: number;
  flushDelayMs?: number;
}

interface Queued {
  buffer: Buffer;
}

/** The segment new entries go to, and its size in bytes. */
interface ActiveSegment {
  index: 0 | 1;
  size: number;
  /** Timestamp of the newest entry written or found; later entries never get an earlier one. */
  lastTimestamp: number;
}

interface SessionLog {
  queue: Queued[];
  head: number;
  pendingBytes: number;
  droppedEntries: number;
  droppedBytes: number;
  timer: NodeJS.Timeout | undefined;
  flushing: Promise<void> | undefined;
  /** True while a flush touches the files; readers wait for it to end. */
  writing: boolean;
  /** Readers iterating the files; a flush waits until there are none, the queue keeps filling meanwhile. */
  readers: number;
  /** Resolves when `readers` drops to 0; set while `readers` > 0. */
  readersIdle: { promise: Promise<void>; resolve: () => void } | undefined;
  /** `forget` was called: no flush starts any more. */
  forgotten: boolean;
  /** Cap the segment sizes were last checked against. */
  checkedCap: number | undefined;
  /** Undefined until the first write looked at the files. */
  active: ActiveSegment | undefined;
}

export class HistoryStore {
  private readonly logs = new Map<SessionId, SessionLog>();
  private readonly now: () => number;
  private readonly maxPendingBytes: number;
  private readonly flushDelayMs: number;
  private disposed = false;

  constructor(private readonly options: HistoryStoreOptions) {
    this.now = options.now ?? Date.now;
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
  }

  /**
   * Queues output for writing and returns at once; never throws. Over `maxPendingBytes` the oldest queued entries
   * are dropped. Whether a session logs at all is the caller's decision.
   */
  append(sessionId: SessionId, data: Uint8Array): void {
    if (this.disposed || data.length === 0) return;
    const log = this.log(sessionId);
    const timestamp = this.now();
    for (let offset = 0; offset < data.length; offset += MAX_ENTRY_DATA_BYTES) {
      const part = data.subarray(offset, offset + MAX_ENTRY_DATA_BYTES);
      const buffer = Buffer.allocUnsafe(ENTRY_HEADER_BYTES + part.length);
      buffer.writeBigUInt64BE(BigInt(timestamp), 0);
      buffer.writeUInt32BE(part.length, 8);
      buffer.set(part, ENTRY_HEADER_BYTES);
      this.enqueue(log, buffer);
    }
    this.schedule(sessionId, log);
  }

  /** Writes what is queued (of one session, or of all) and resolves when it is on disk. */
  async flush(sessionId?: SessionId): Promise<void> {
    const targets =
      sessionId === undefined ? [...this.logs] : [[sessionId, this.logs.get(sessionId)] as const];
    for (const [id, log] of targets) {
      if (!log) continue;
      if (log.timer) {
        clearTimeout(log.timer);
        log.timer = undefined;
      }
      for (;;) {
        if (log.flushing) await log.flushing;
        else if (log.head < log.queue.length) await this.startFlush(id, log);
        else break;
      }
    }
  }

  stats(sessionId: SessionId): HistoryStats {
    const log = this.logs.get(sessionId);
    return {
      pendingBytes: log?.pendingBytes ?? 0,
      droppedEntries: log?.droppedEntries ?? 0,
      droppedBytes: log?.droppedBytes ?? 0,
    };
  }

  /** Stops accepting output, writes what is queued and forgets the sessions. Safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.flush();
    this.disposed = true;
    this.logs.clear();
  }

  /**
   * Entries of a session from oldest to newest, see `readHistory`. Coordinated with the writer of this store: while
   * a read is open, no flush and no segment change touches the files (the queue keeps filling up to its limit and
   * drops the oldest entries beyond it), so a rotation never moves bytes under the reader. Iterate to the end or
   * call `return()` (a `for await` with `break` does); an abandoned iterator holds the writer back.
   */
  async *read(sessionId: SessionId): AsyncGenerator<HistoryEntry> {
    const log = this.log(sessionId);
    while (log.writing) await log.flushing;
    log.readers += 1;
    if (log.readers === 1) {
      let resolve!: () => void;
      log.readersIdle = { promise: new Promise<void>((r) => (resolve = r)), resolve };
    }
    try {
      yield* readHistory(this.options.dataDir, sessionId);
    } finally {
      log.readers -= 1;
      if (log.readers === 0) {
        log.readersIdle?.resolve();
        log.readersIdle = undefined;
        // A read of a session that was never written leaves no entry behind.
        if (this.isPristine(log) && this.logs.get(sessionId) === log) this.logs.delete(sessionId);
      }
    }
  }

  /**
   * Drops everything queued for a session, waits for a running flush and forgets the session: its entry leaves
   * the store and no flush creates `history/<id>/` afterwards. Files stay (see `remove`). Call when a session ends
   * for good; output appended afterwards would start a new log.
   */
  async forget(sessionId: SessionId): Promise<void> {
    const log = this.logs.get(sessionId);
    if (!log) return;
    log.forgotten = true;
    if (log.timer) {
      clearTimeout(log.timer);
      log.timer = undefined;
    }
    log.queue = [];
    log.head = 0;
    log.pendingBytes = 0;
    while (log.flushing) await log.flushing;
    if (this.logs.get(sessionId) === log) this.logs.delete(sessionId);
  }

  /** `forget` plus deleting `history/<id>/` with both segments. Idempotent: nothing there is no error. */
  async remove(sessionId: SessionId): Promise<void> {
    const dir = historyDir(this.options.dataDir, sessionId);
    await this.forget(sessionId);
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  private isPristine(log: SessionLog): boolean {
    return (
      log.readers === 0 &&
      log.head >= log.queue.length &&
      !log.timer &&
      !log.flushing &&
      log.active === undefined &&
      log.droppedEntries === 0
    );
  }

  private log(sessionId: SessionId): SessionLog {
    let log = this.logs.get(sessionId);
    if (!log) {
      log = {
        queue: [],
        head: 0,
        pendingBytes: 0,
        droppedEntries: 0,
        droppedBytes: 0,
        timer: undefined,
        flushing: undefined,
        writing: false,
        readers: 0,
        readersIdle: undefined,
        forgotten: false,
        checkedCap: undefined,
        active: undefined,
      };
      this.logs.set(sessionId, log);
    }
    return log;
  }

  private enqueue(log: SessionLog, buffer: Buffer): void {
    if (buffer.length > this.maxPendingBytes) {
      this.drop(log, buffer.length, 1);
      return;
    }
    while (log.pendingBytes + buffer.length > this.maxPendingBytes && log.head < log.queue.length) {
      const oldest = log.queue[log.head++]!;
      log.pendingBytes -= oldest.buffer.length;
      this.drop(log, oldest.buffer.length, 1);
    }
    // Compact once the consumed prefix dominates, so shifting the oldest stays cheap.
    if (log.head > 1024 && log.head * 2 > log.queue.length) {
      log.queue.splice(0, log.head);
      log.head = 0;
    }
    log.queue.push({ buffer });
    log.pendingBytes += buffer.length;
  }

  private drop(log: SessionLog, bytes: number, entries: number): void {
    log.droppedEntries += entries;
    log.droppedBytes += bytes;
  }

  private schedule(sessionId: SessionId, log: SessionLog): void {
    if (log.timer || log.flushing || log.forgotten) return;
    log.timer = setTimeout(() => {
      log.timer = undefined;
      void this.startFlush(sessionId, log);
    }, this.flushDelayMs);
    log.timer.unref();
  }

  private startFlush(sessionId: SessionId, log: SessionLog): Promise<void> {
    if (log.flushing) return log.flushing;
    if (log.forgotten) return Promise.resolve();
    log.flushing = this.waitForReaders(log)
      .then(() => {
        if (log.forgotten) return;
        log.writing = true;
        return this.writeQueued(sessionId, log);
      })
      .finally(() => {
        log.writing = false;
        log.flushing = undefined;
        if (log.head < log.queue.length && !this.disposed) this.schedule(sessionId, log);
      });
    return log.flushing;
  }

  private async waitForReaders(log: SessionLog): Promise<void> {
    while (log.readersIdle) await log.readersIdle.promise;
  }

  private async writeQueued(sessionId: SessionId, log: SessionLog): Promise<void> {
    const batch = log.queue.slice(log.head);
    log.queue = [];
    log.head = 0;
    log.pendingBytes = 0;
    if (batch.length === 0) return;
    try {
      await this.writeBatch(sessionId, log, batch);
    } catch (error) {
      // Resynchronise with the files at the next write.
      log.active = undefined;
      log.checkedCap = undefined;
      for (const entry of batch) this.drop(log, entry.buffer.length, 1);
      try {
        (this.options.onError ?? defaultOnError)(error, sessionId);
      } catch {
        // A failing error handler must not break the writer either.
      }
    }
  }

  private async writeBatch(sessionId: SessionId, log: SessionLog, batch: readonly Queued[]): Promise<void> {
    const cap = segmentCapBytes(this.options.getSettings().historyLimitBytes);
    await mkdir(historyDir(this.options.dataDir, sessionId), { recursive: true });
    let active: ActiveSegment = log.active ?? (await this.findActive(sessionId));
    log.active = active;
    if (log.checkedCap !== cap) {
      active = await this.enforceCap(sessionId, active, cap);
      log.active = active;
      log.checkedCap = cap;
    }
    let chunks: Buffer[] = [];
    const write = async (): Promise<void> => {
      if (chunks.length === 0) return;
      const data = Buffer.concat(chunks);
      chunks = [];
      await appendFile(historySegmentPath(this.options.dataDir, sessionId, active.index), data);
    };
    for (const { buffer } of batch) {
      // Timestamps never go back (clock set back, restart): the segment order depends on them.
      const timestamp = Number(buffer.readBigUInt64BE(0));
      if (timestamp < active.lastTimestamp) buffer.writeBigUInt64BE(BigInt(active.lastTimestamp), 0);
      else active.lastTimestamp = timestamp;
      if (active.size > 0 && active.size + buffer.length > cap) {
        await write();
        // The other segment is emptied and becomes the active one: its oldest output goes first.
        const next = active.index === 0 ? 1 : 0;
        await writeFile(historySegmentPath(this.options.dataDir, sessionId, next), "");
        active = { index: next, size: 0, lastTimestamp: active.lastTimestamp };
        log.active = active;
      }
      chunks.push(buffer);
      active.size += buffer.length;
    }
    await write();
  }

  /** The newest segment, with a trailing incomplete entry (crash) cut off so that new entries stay readable. */
  private async findActive(sessionId: SessionId): Promise<ActiveSegment> {
    const ordered = await orderedSegments(this.options.dataDir, sessionId);
    const newest = ordered.at(-1);
    if (!newest) return { index: 0, size: 0, lastTimestamp: 0 };
    const path = historySegmentPath(this.options.dataDir, sessionId, newest.index);
    const { valid, lastTimestamp } = await scanHeaders(path, newest.size);
    if (valid < newest.size) await truncate(path, valid);
    return { index: newest.index, size: valid, lastTimestamp };
  }

  /**
   * After the limit was lowered a segment may be larger than the new cap: an oversized active segment ends the
   * history (both segments are emptied, the other one becomes active), an oversized inactive one is emptied. The
   * consumption is then within the limit again at once, at the price of the output in the emptied segments.
   */
  private async enforceCap(sessionId: SessionId, active: ActiveSegment, cap: number): Promise<ActiveSegment> {
    const other = active.index === 0 ? 1 : 0;
    const otherPath = historySegmentPath(this.options.dataDir, sessionId, other);
    if (active.size > cap) {
      await writeFile(historySegmentPath(this.options.dataDir, sessionId, active.index), "");
      await writeFile(otherPath, "");
      return { index: other, size: 0, lastTimestamp: active.lastTimestamp };
    }
    try {
      if ((await stat(otherPath)).size > cap) await writeFile(otherPath, "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return active;
  }
}

function defaultOnError(error: unknown, sessionId: SessionId): void {
  console.error(
    `TermDock: could not write history of session ${sessionId}: ${error instanceof Error ? error.message : "unknown"}`,
  );
}

interface SegmentInfo {
  index: 0 | 1;
  size: number;
  firstTimestamp: number;
  mtimeMs: number;
}

/** Non-empty segments from oldest to newest; the older one has the earlier first entry (mtime breaks ties). */
async function orderedSegments(dataDir: string, sessionId: SessionId): Promise<SegmentInfo[]> {
  const found: SegmentInfo[] = [];
  for (const index of [0, 1] as const) {
    const path = historySegmentPath(dataDir, sessionId, index);
    let size: number;
    let mtimeMs: number;
    try {
      const info = await stat(path);
      size = info.size;
      mtimeMs = info.mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (size < ENTRY_HEADER_BYTES) continue;
    const handle = await open(path, "r");
    try {
      const head = Buffer.alloc(8);
      const { bytesRead } = await handle.read(head, 0, 8, 0);
      if (bytesRead < 8) continue;
      found.push({ index, size, firstTimestamp: Number(head.readBigUInt64BE(0)), mtimeMs });
    } finally {
      await handle.close();
    }
  }
  return found.sort(
    (a, b) => a.firstTimestamp - b.firstTimestamp || a.mtimeMs - b.mtimeMs || a.index - b.index,
  );
}

/** Entry of a segment and the offset right after it. */
interface SegmentEntry extends HistoryEntry {
  end: number;
}

/**
 * Entries of one segment file. Stops at an incomplete or implausible entry (a write cut off by a crash, or
 * damage): everything before it is delivered, the rest of the segment is ignored.
 */
async function* readSegment(path: string): AsyncGenerator<SegmentEntry> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let carry: Buffer = Buffer.alloc(0);
    let consumed = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return;
      // Copies: `chunk` is reused by the next read.
      carry =
        carry.length === 0
          ? Buffer.from(chunk.subarray(0, bytesRead))
          : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      let offset = 0;
      while (carry.length - offset >= ENTRY_HEADER_BYTES) {
        const length = carry.readUInt32BE(offset + 8);
        if (length > MAX_ENTRY_DATA_BYTES) return;
        const end = offset + ENTRY_HEADER_BYTES + length;
        if (end > carry.length) break;
        yield {
          timestamp: Number(carry.readBigUInt64BE(offset)),
          data: carry.subarray(offset + ENTRY_HEADER_BYTES, end),
          end: consumed + end,
        };
        offset = end;
      }
      consumed += offset;
      carry = carry.subarray(offset);
    }
  } finally {
    await handle.close();
  }
}

/**
 * End of the last complete entry of a segment and its timestamp, found by walking the headers only (12 bytes per
 * entry, the data is skipped), so a large segment is not read into memory.
 */
async function scanHeaders(path: string, size: number): Promise<{ valid: number; lastTimestamp: number }> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(ENTRY_HEADER_BYTES);
    let offset = 0;
    let lastTimestamp = 0;
    while (offset + ENTRY_HEADER_BYTES <= size) {
      const { bytesRead } = await handle.read(header, 0, ENTRY_HEADER_BYTES, offset);
      if (bytesRead < ENTRY_HEADER_BYTES) break;
      const length = header.readUInt32BE(8);
      const end = offset + ENTRY_HEADER_BYTES + length;
      if (length > MAX_ENTRY_DATA_BYTES || end > size) break;
      lastTimestamp = Number(header.readBigUInt64BE(0));
      offset = end;
    }
    return { valid: offset, lastTimestamp };
  } finally {
    await handle.close();
  }
}

/**
 * All stored entries of a session from oldest to newest (older segment first). A truncated or damaged last entry
 * of a segment ends that segment without an error; a missing history yields nothing. Meant for the search (P3-7).
 * Only safe without a concurrent writer: a segment change during the read can move bytes under it. While a
 * `HistoryStore` is writing, use `HistoryStore.read`, which holds the writer back.
 */
export async function* readHistory(dataDir: string, sessionId: SessionId): AsyncGenerator<HistoryEntry> {
  for (const segment of await orderedSegments(dataDir, sessionId)) {
    for await (const { timestamp, data } of readSegment(
      historySegmentPath(dataDir, sessionId, segment.index),
    )) {
      yield { timestamp, data };
    }
  }
}
