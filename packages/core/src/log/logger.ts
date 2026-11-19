// Diagnostic log file with rotation (spec diagnostics). Writing is asynchronous and queued: a log call returns at
// once and never throws, so a full disk or a locked file cannot stop IPC or a PTY.
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { redact } from "./redact.js";

export type LogLevel = "info" | "warn" | "error";

export const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;
export const DEFAULT_LOG_FILES = 2;
/** Lines waiting for the disk; more are dropped and counted (a hot error path must not fill the heap). */
export const MAX_PENDING_LINES = 1000;

export interface LoggerOptions {
  /** Path of the active file, e.g. `<dataDir>/logs/core.log`. Without it nothing is written to disk. */
  file?: string;
  /** Rotates when a line would take the active file above this size. Defaults to 1 MiB. */
  maxBytes?: number;
  /** Files kept including the active one: `core.log`, `core.1.log`, … Defaults to 2. */
  files?: number;
  /** Name of the emitting part in each line, e.g. `core`; `withSource` derives loggers for parts. */
  source?: string;
  /** Receives every redacted line (without newline), e.g. stderr output; errors in it are ignored. */
  mirror?: (line: string, level: LogLevel, source: string, text: string) => void;
  /** Called when writing the file fails (once per failure); the logger keeps running. Defaults to nothing. */
  onWriteError?: (error: unknown) => void;
  now?: () => Date;
  /** Env whose secret values are searched in lines; defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface Logger {
  info(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  /** A logger for another source that writes to the same file in the same queue. */
  withSource(source: string): Logger;
  /** Resolves when everything logged so far is written (or has failed). Never rejects. */
  flush(): Promise<void>;
}

/** Folder of the diagnostic logs below the data directory (spec diagnostics). */
export function logDir(dataDir: string): string {
  return path.join(dataDir, "logs");
}

/** Name of the n-th rotated file: `core.log` -> `core.1.log`. */
export function rotatedPath(file: string, index: number): string {
  const parsed = path.parse(file);
  return index === 0 ? file : path.join(parsed.dir, `${parsed.name}.${index}${parsed.ext}`);
}

/** `<time> <level> <source> <text>`; further lines of the text are indented so that each entry starts at a time. */
export function formatLine(time: Date, level: LogLevel, source: string, text: string): string {
  return `${time.toISOString()} ${level} ${source} ${text.replace(/\r?\n/g, "\n  ")}`;
}

class FileWriter {
  private queue: Promise<void> = Promise.resolve();
  private size: number | undefined;
  private dirReady = false;
  private pending = 0;
  private dropped = 0;

  constructor(
    private readonly file: string,
    private readonly maxBytes: number,
    private readonly files: number,
    private readonly onWriteError: (error: unknown) => void,
  ) {}

  write(line: string): void {
    // A slow or blocked disk must not let the queue grow without limit: the excess is counted and dropped.
    if (this.pending >= MAX_PENDING_LINES) {
      this.dropped += 1;
      return;
    }
    this.pending += 1;
    this.queue = this.queue
      .then(() => this.append(line))
      .catch((error: unknown) => this.fail(error))
      .finally(() => (this.pending -= 1));
  }

  flush(): Promise<void> {
    return this.queue;
  }

  private fail(error: unknown): void {
    // The state of the file is unknown now: look again at the next write.
    this.size = undefined;
    this.dirReady = false;
    this.reportError(error);
  }

  private async append(line: string): Promise<void> {
    if (!this.dirReady) {
      await mkdir(path.dirname(this.file), { recursive: true });
      this.dirReady = true;
    }
    this.size ??= await currentSize(this.file);
    if (this.dropped > 0) {
      const note = `${new Date().toISOString()} warn log ${this.dropped} lines dropped while the log file was not writable\n`;
      this.dropped = 0;
      line = note + line;
    }
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.maxBytes) {
      try {
        await this.rotate();
        this.size = 0;
      } catch (error) {
        // A locked file (an editor holding it) must not silence the log: report it and keep writing to the
        // active file, up to twice the limit.
        this.reportError(error);
        if (this.size + bytes > this.maxBytes * 2) return;
      }
    }
    await appendFile(this.file, line);
    this.size += bytes;
  }

  private reportError(error: unknown): void {
    try {
      this.onWriteError(error);
    } catch {
      // A failing error handler must not stop the queue.
    }
  }

  /** Drops the oldest file, shifts the others up (`core.1.log` -> `core.2.log`) and moves the active file. */
  private async rotate(): Promise<void> {
    await rm(rotatedPath(this.file, this.files - 1), { force: true });
    for (let index = this.files - 2; index >= 0; index -= 1) {
      try {
        await rename(rotatedPath(this.file, index), rotatedPath(this.file, index + 1));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

async function currentSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/** A logger writing redacted lines to `file`, rotating at `maxBytes` and keeping `files` files. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const files = Math.max(1, Math.floor(options.files ?? DEFAULT_LOG_FILES));
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_LOG_MAX_BYTES));
  const writer =
    options.file === undefined
      ? undefined
      : new FileWriter(options.file, maxBytes, files, options.onWriteError ?? (() => {}));
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const mirror = options.mirror;

  const make = (source: string): Logger => {
    const emit = (level: LogLevel, text: string): void => {
      try {
        const clean = redact(String(text), env);
        const line = formatLine(now(), level, source, clean);
        writer?.write(`${line}\n`);
        mirror?.(line, level, source, clean);
      } catch {
        // Logging never throws into the caller.
      }
    };
    // With files = 1 the active file is cleared on rotation; `rotate` then only removes it.
    return {
      info: (text) => emit("info", text),
      warn: (text) => emit("warn", text),
      error: (text) => emit("error", text),
      withSource: (name) => make(name),
      flush: () => writer?.flush() ?? Promise.resolve(),
    };
  };
  return make(options.source ?? "app");
}
