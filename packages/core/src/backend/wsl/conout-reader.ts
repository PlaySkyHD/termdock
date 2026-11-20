// One worker thread drains the ConPTY output pipes of all PTYs (issue #153, ADR 0008).
//
// node-pty 1.1.0 starts one worker thread per PTY (`ConoutConnection`, lib/windowsConoutConnection.js): a V8
// isolate of its own, 8 to 12 MiB each. The worker only relays the ConPTY output pipe to a second pipe
// (`<pipe>-worker`) the main thread reads; it exists so the output drains while the main thread waits in
// `ClosePseudoConsole`. This module replaces that class with one that hands every pipe to a single shared worker.
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { Disposable } from "../types.js";

/** The only node-pty version whose internal `ConoutConnection` this module replaces. */
export const SUPPORTED_NODE_PTY_VERSION = "1.1.0";
/** node-pty waits this long for trailing output after `kill` before it ends a pipe (`FLUSH_DATA_INTERVAL`). */
const FLUSH_DATA_INTERVAL_MS = 1_000;
/** A worker that has not started after this long counts as failed; the start of the PTY fails instead of hanging. */
const WORKER_START_TIMEOUT_MS = 10_000;

/**
 * Source of the worker (CommonJS, run with `eval`), so packaging needs no extra file (ADR 0007). Per PTY the same
 * relay as node-pty's worker/conoutSocketWorker.js. A pipe is closed when the main thread removes it, or when the
 * ConPTY closed its output and the main thread's connection has ended.
 */
export const CONOUT_WORKER_SOURCE = `"use strict";
const { parentPort } = require("node:worker_threads");
const net = require("node:net");
const connections = new Map();

function close(id) {
  const entry = connections.get(id);
  if (!entry) return;
  connections.delete(id);
  entry.conout.destroy();
  for (const socket of entry.accepted) socket.destroy();
  if (entry.server) entry.server.close();
  parentPort.postMessage({ type: "closed", id });
}

function closeWhenDrained(id) {
  const entry = connections.get(id);
  if (entry && entry.conoutClosed && entry.connected && entry.accepted.size === 0) close(id);
}

function add(id, pipe) {
  const conout = new net.Socket();
  conout.setEncoding("utf8");
  const entry = { conout, server: undefined, accepted: new Set(), conoutClosed: false, connected: false };
  connections.set(id, entry);
  conout.on("error", () => {});
  conout.on("close", () => {
    entry.conoutClosed = true;
    closeWhenDrained(id);
  });
  conout.connect(pipe, () => {
    const server = net.createServer((socket) => {
      entry.connected = true;
      entry.accepted.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        entry.accepted.delete(socket);
        closeWhenDrained(id);
      });
      conout.pipe(socket);
    });
    server.on("error", () => close(id));
    entry.server = server;
    server.listen(pipe + "-worker");
    parentPort.postMessage({ type: "ready", id });
  });
}

parentPort.on("message", (message) => {
  if (message.type === "add") add(message.id, message.pipe);
  else if (message.type === "remove") close(message.id);
});
parentPort.postMessage({ type: "started" });
`;

type WorkerMessage = { type: "started" } | { type: "ready"; id: number } | { type: "closed"; id: number };

/** The socket node-pty connects to the relay (`net.Socket`). */
interface ConnectableSocket {
  connect(path: string): unknown;
}

/** One PTY's output pipe, with the interface node-pty 1.1.0's `WindowsPtyAgent` uses of `ConoutConnection`. */
export class ConoutConnection {
  private readonly readyListeners = new Set<() => void>();
  private readonly lostListeners = new Set<() => void>();
  private drain: NodeJS.Timeout | undefined;
  private ended = false;

  constructor(
    readonly id: number,
    private readonly pipe: string,
    private readonly remove: (id: number) => void,
  ) {}

  /** node-pty connects its output socket once this fires. */
  onReady(listener: () => void): Disposable {
    this.readyListeners.add(listener);
    return { dispose: () => this.readyListeners.delete(listener) };
  }

  /** Fires once when the worker ended unexpectedly: this PTY gets no more output. */
  onLost(listener: () => void): Disposable {
    this.lostListeners.add(listener);
    return { dispose: () => this.lostListeners.delete(listener) };
  }

  connectSocket(socket: ConnectableSocket): void {
    socket.connect(`${this.pipe}-worker`);
  }

  /** As in node-pty: ends the relay after trailing output had 1 s to arrive; each call restarts the wait. */
  dispose(): void {
    if (this.ended) return;
    clearTimeout(this.drain);
    this.drain = setTimeout(() => this.end(), FLUSH_DATA_INTERVAL_MS);
    this.drain.unref();
  }

  /** Ends the relay at once, without waiting for trailing output (a `spawn` that failed after creating it). */
  close(): void {
    clearTimeout(this.drain);
    this.end();
  }

  /** @internal Called by the reader. */
  fireReady(): void {
    for (const listener of [...this.readyListeners]) listener();
  }

  /** @internal Called by the reader when the worker is gone. */
  fireLost(): void {
    this.ended = true;
    clearTimeout(this.drain);
    for (const listener of [...this.lostListeners]) listener();
    this.lostListeners.clear();
  }

  /** @internal Called by the reader when the worker closed the pipe on its own. */
  closed(): void {
    this.ended = true;
    clearTimeout(this.drain);
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.remove(this.id);
  }
}

export interface ConoutReaderOptions {
  /** One line per event that changes how output is read (worker lost, version not supported). */
  log?: (line: string) => void;
  /** Worker source; tests pass a broken one. */
  workerSource?: string;
  startTimeoutMs?: number;
}

/** The single worker thread and the output pipes it relays. */
export class ConoutReader {
  private worker: Worker | undefined;
  private starting: Promise<void> | undefined;
  private running = false;
  private disposed = false;
  private nextId = 1;
  private readonly connections = new Map<number, ConoutConnection>();
  private lastCreated: ConoutConnection | undefined;
  private readonly log: (line: string) => void;
  private readonly workerSource: string;
  private readonly startTimeoutMs: number;

  constructor(options: ConoutReaderOptions = {}) {
    this.log = options.log ?? (() => {});
    this.workerSource = options.workerSource ?? CONOUT_WORKER_SOURCE;
    this.startTimeoutMs = options.startTimeoutMs ?? WORKER_START_TIMEOUT_MS;
  }

  /** Output pipes the worker relays right now. */
  get activeConnections(): number {
    return this.connections.size;
  }

  /** Thread id of the running worker; undefined without one. */
  get workerThreadId(): number | undefined {
    return this.running ? this.worker?.threadId : undefined;
  }

  /**
   * Resolves once a worker runs; starts one when there is none (first use, or after the last one ended). A PTY must
   * start only after this: node-pty waits synchronously in `ConnectNamedPipe` until the worker opened the pipe.
   */
  ready(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("conout reader disposed"));
    if (this.running) return Promise.resolve();
    this.starting ??= this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  /**
   * Creates the connection for a new PTY; called by node-pty through the replaced `ConoutConnection` during
   * `spawn`. Throws without a running worker, so the start fails instead of blocking the core in `ConnectNamedPipe`.
   */
  connect(pipe: string): ConoutConnection {
    const worker = this.worker;
    if (!this.running || worker === undefined) throw new Error("conout reader: no worker running");
    const id = this.nextId++;
    const connection = new ConoutConnection(id, pipe, (ended) => this.remove(ended));
    this.connections.set(id, connection);
    this.lastCreated = connection;
    worker.postMessage({ type: "add", id, pipe });
    return connection;
  }

  /** The connection the last `connect` created, once; `spawnConpty` closes it when `spawn` failed after creating it. */
  takeLastConnection(): ConoutConnection | undefined {
    const connection = this.lastCreated;
    this.lastCreated = undefined;
    return connection;
  }

  /**
   * @internal Tests only: ends the worker as if it had crashed; every connection is lost, the next `ready` starts a
   * new one. Never called by the core.
   */
  async crashWorker(): Promise<void> {
    await this.worker?.terminate();
  }

  /** Ends the worker without reporting lost connections. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const worker = this.worker;
    this.worker = undefined;
    this.running = false;
    this.connections.clear();
    await worker?.terminate();
  }

  private start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const worker = new Worker(this.workerSource, { eval: true, name: "termdock-conout" });
      // The worker must not keep the core alive; its output only matters while PTYs run.
      worker.unref();
      this.worker = worker;
      const timer = setTimeout(() => {
        fail(new Error(`conout reader: worker did not start within ${this.startTimeoutMs} ms`));
        void worker.terminate();
      }, this.startTimeoutMs);
      timer.unref();
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      worker.on("message", (message: WorkerMessage) => {
        if (message.type === "started") {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.running = true;
          resolve();
        } else if (message.type === "ready") this.connections.get(message.id)?.fireReady();
        else {
          const connection = this.connections.get(message.id);
          this.connections.delete(message.id);
          connection?.closed();
        }
      });
      worker.on("error", (error) => this.log(`conout reader: worker failed: ${error.message}`));
      worker.on("exit", (code) => {
        fail(new Error(`conout reader: worker ended (code ${code}) before it started`));
        if (this.worker === worker) this.lost(code);
      });
    });
  }

  private lost(code: number): void {
    this.worker = undefined;
    this.running = false;
    if (this.disposed) return;
    const lost = [...this.connections.values()];
    this.connections.clear();
    this.log(
      `conout reader: worker ended (code ${code}); ${lost.length} PTY(s) lost their output and are closed, the next start runs a new worker`,
    );
    for (const connection of lost) connection.fireLost();
  }

  private remove(id: number): void {
    if (!this.connections.delete(id)) return;
    this.worker?.postMessage({ type: "remove", id });
  }
}

/** node-pty's version as its package.json reports it. */
export function nodePtyVersion(load: (id: string) => unknown = createRequire(import.meta.url)): string {
  return (load("node-pty/package.json") as { version: string }).version;
}

/**
 * Makes node-pty create its output connections through `reader`. Only for node-pty 1.1.0 on Windows: for any other
 * version it logs one line and leaves node-pty as it is (one worker per PTY). Returns whether it replaced the class.
 */
export function installConoutReader(
  reader: ConoutReader,
  options: { log: (line: string) => void; load?: (id: string) => unknown },
): boolean {
  const load = options.load ?? createRequire(import.meta.url);
  const version = nodePtyVersion(load);
  if (version !== SUPPORTED_NODE_PTY_VERSION) {
    options.log(
      `conout reader: node-pty ${version} is not ${SUPPORTED_NODE_PTY_VERSION}; every PTY keeps its own worker thread (ADR 0008)`,
    );
    return false;
  }
  const internal = load("node-pty/lib/windowsConoutConnection.js") as { ConoutConnection?: unknown };
  if (typeof internal.ConoutConnection !== "function") {
    options.log(
      "conout reader: node-pty has no ConoutConnection to replace; every PTY keeps its own worker thread",
    );
    return false;
  }
  // `new ConoutConnection(pipe, useConptyDll)` in WindowsPtyAgent returns the object this function returns.
  internal.ConoutConnection = function SharedConoutConnection(pipe: string): ConoutConnection {
    return reader.connect(pipe);
  };
  return true;
}
