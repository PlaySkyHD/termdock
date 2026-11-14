// Named-pipe server of the core (ADR 0001, ADR 0002): handshake, dispatch to the SessionRegistry,
// views per connection, event routing, backpressure and shutdown. Design: openspec core-ipc.
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import {
  encodeFrame,
  FrameDecoder,
  MAX_PAYLOAD_BYTES,
  negotiateHello,
  parseRequest,
} from "@termdock/protocol";
import type {
  ErrorBody,
  ErrorCode,
  EventMap,
  EventName,
  Frame,
  ParsedRequest,
  SessionAttachResult,
  SessionId,
  ViewId,
} from "@termdock/protocol";
import type { Disposable } from "../backend/types.js";
import { CoreError } from "../session/errors.js";
import type { CreateSessionInput, SessionRegistry } from "../session/registry.js";
import type { LayoutRepository } from "../storage/layout-repository.js";
import { defaultPipeName } from "./pipe-name.js";

/** Not-yet-written bytes per client above which the client is disconnected (16 MiB). */
export const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
/** How long a closing connection may take to flush before it is destroyed. */
const CLOSE_GRACE_MS = 1000;
export const DEFAULT_SHUTDOWN_START_TIMEOUT_MS = 5000;
/** After the last shutdown answer the server waits this long for further shutdown requests before it closes. */
const SHUTDOWN_SETTLE_MS = 100;
/** A connection that has not completed `hello` after this long is destroyed (spec core-ipc, pipe security). */
export const DEFAULT_HELLO_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_PENDING_HANDSHAKES = 32;

/** Another core already holds the pipe (ADR 0001). Not an IPC error code: no client sees it over the wire. */
export class AlreadyRunningError extends Error {
  readonly code = "already_running" as const;

  constructor(readonly pipePath: string) {
    super(`Another core is already running on ${pipePath}`);
    this.name = "AlreadyRunningError";
  }
}

export interface CoreServerOptions {
  registry: SessionRegistry;
  /** Stored layout behind `layout.get` and `layout.save`. */
  layouts: LayoutRepository;
  /** Pipe path; defaults to `\\.\pipe\termdock-core-<user>`. Tests pass a unique name. */
  pipePath?: string;
  /** Per-client limit for output the client has not read yet; defaults to 16 MiB. */
  maxBufferedBytes?: number;
  /** How long `core.shutdown { stopSessions }` waits for sessions in `Starting`; defaults to 5 s. */
  shutdownStartTimeoutMs?: number;
  /** Called once after `core.shutdown` has closed the server. The entry point ends the process here. */
  onShutdown?: () => void;
  /** Receives the cause of every error that is answered with `internal`. */
  onInternalError?: (error: unknown) => void;
  /** How long a new connection may stay without a completed `hello`; defaults to 5 s. */
  helloTimeoutMs?: number;
  /** Connections without completed `hello` allowed at the same time; further ones are destroyed. Defaults to 32. */
  maxPendingHandshakes?: number;
  /**
   * Requests other than `hello` wait for this before they reach the registry; the core resolves it after the
   * reconcile, so no client sees the state before it. A rejection is answered like any error of the request.
   */
  ready?: Promise<void>;
}

interface Connection {
  readonly socket: Socket;
  readonly decoder: FrameDecoder;
  readonly views: Set<ViewId>;
  greeted: boolean;
  closed: boolean;
  closing: boolean;
  /** Has used `session.list`: receives `session.stateChanged` of all sessions. */
  listSubscriber: boolean;
  /** Requests of one connection run one after the other. */
  chain: Promise<void>;
  closeTimer: NodeJS.Timeout | undefined;
  /** Destroys the connection when `hello` does not arrive in time; cleared on `hello` and on close. */
  helloTimer: NodeJS.Timeout | undefined;
  /** `session.attach` requests in progress. While > 0, events for this connection wait in `held`. */
  pendingAttaches: number;
  held: Uint8Array[];
}

interface ViewRecord {
  readonly sessionId: SessionId;
  readonly conn: Connection;
}

interface Outcome {
  result: unknown;
  payload?: Uint8Array;
  /** Answers with this error instead of `result`. */
  error?: ErrorBody;
  /** Runs after the response is written. */
  after?: () => void;
}

const EMPTY_RESULT: Outcome = { result: {} };

export class CoreServer {
  readonly pipePath: string;
  private readonly registry: SessionRegistry;
  private readonly layouts: LayoutRepository;
  private readonly maxBufferedBytes: number;
  private readonly onShutdown: (() => void) | undefined;
  private readonly helloTimeoutMs: number;
  private readonly maxPendingHandshakes: number;
  /** Connections that have not completed `hello` yet. */
  private pendingHandshakes = 0;
  private readonly onInternalError: (error: unknown) => void;
  private readonly netServer: Server;
  private readonly connections = new Set<Connection>();
  private readonly views = new Map<ViewId, ViewRecord>();
  private subscriptions: Disposable[] = [];
  private closePromise: Promise<void> | undefined;
  private readonly startWaitMs: number;
  private stopWork: Promise<{ failed: SessionId[]; code: ErrorCode }> | undefined;
  private shuttingDown = false;
  private pendingShutdownReplies = 0;
  private settleTimer: NodeJS.Timeout | undefined;
  private readonly ready: Promise<void>;

  private constructor(options: CoreServerOptions) {
    this.registry = options.registry;
    this.layouts = options.layouts;
    this.ready = options.ready ?? Promise.resolve();
    // Waiting requests observe a rejection; this keeps it from counting as unhandled before one arrives.
    this.ready.catch(() => {});
    this.pipePath = options.pipePath ?? defaultPipeName();
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.startWaitMs = options.shutdownStartTimeoutMs ?? DEFAULT_SHUTDOWN_START_TIMEOUT_MS;
    this.onShutdown = options.onShutdown;
    this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    // No "off" value: a timeout that is not a positive finite number would silently disable the protection.
    if (!Number.isFinite(this.helloTimeoutMs) || this.helloTimeoutMs <= 0) {
      throw new RangeError(`helloTimeoutMs must be a positive finite number, got ${this.helloTimeoutMs}`);
    }
    this.maxPendingHandshakes = options.maxPendingHandshakes ?? DEFAULT_MAX_PENDING_HANDSHAKES;
    if (!Number.isInteger(this.maxPendingHandshakes) || this.maxPendingHandshakes < 1) {
      throw new RangeError(`maxPendingHandshakes must be an integer >= 1, got ${this.maxPendingHandshakes}`);
    }
    this.onInternalError = options.onInternalError ?? (() => {});
    this.netServer = createServer((socket) => this.accept(socket));
  }

  /** Occupies the pipe and starts serving. Rejects with `AlreadyRunningError` when the pipe is taken. */
  static async start(options: CoreServerOptions): Promise<CoreServer> {
    const server = new CoreServer(options);
    await server.listen();
    server.subscribe();
    return server;
  }

  /** Stops listening, flushes and ends all connections. Safe to call more than once. */
  close(): Promise<void> {
    this.closePromise ??= this.shutdownServer();
    return this.closePromise;
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        reject(error.code === "EADDRINUSE" ? new AlreadyRunningError(this.pipePath) : error);
      };
      this.netServer.once("error", onError);
      this.netServer.listen(this.pipePath, () => {
        this.netServer.off("error", onError);
        this.netServer.on("error", (error) => this.onInternalError(error));
        resolve();
      });
    });
  }

  private subscribe(): void {
    this.subscriptions = [
      this.registry.onOutput(({ sessionId, seq, data, viewIds }) => {
        // All parts of split output carry its number; the attach mark always lies between two outputs.
        for (let offset = 0; offset < data.length; offset += MAX_PAYLOAD_BYTES) {
          const chunk = data.subarray(offset, offset + MAX_PAYLOAD_BYTES);
          this.route(viewIds, [], eventFrame("session.output", { sessionId, seq }, chunk));
        }
      }),
      this.registry.onResized(({ sessionId, size, viewIds }) => {
        this.route(viewIds, [], eventFrame("session.resized", { sessionId, size }));
      }),
      this.registry.onWriterChanged(({ sessionId, writerViewId, viewIds }) => {
        const data = writerViewId === undefined ? { sessionId } : { sessionId, writerViewId };
        this.route(viewIds, [], eventFrame("view.writerChanged", data));
      }),
      this.registry.onCreated(({ session }) => {
        // Like `session.stateChanged`: clients that list sessions. One that never lists would see the session
        // in `Starting` for ever. Older clients drop events they do not know.
        const listers = [...this.connections].filter((conn) => conn.listSubscriber);
        this.route([], listers, eventFrame("session.created", { session }));
      }),
      this.registry.onStateChange(({ sessionId, session }) => {
        const viewIds = [...this.views].filter(([, view]) => view.sessionId === sessionId).map(([id]) => id);
        const listers = [...this.connections].filter((conn) => conn.listSubscriber);
        const data: EventMap["session.stateChanged"] = { sessionId, state: session.state };
        if (session.lastExitCode !== undefined) data.lastExitCode = session.lastExitCode;
        this.route(viewIds, listers, eventFrame("session.stateChanged", data));
      }),
    ];
  }

  /** Sends one event to each connection that owns one of the views or is in `extra`, at most once. */
  private route(viewIds: readonly ViewId[], extra: readonly Connection[], bytes: Uint8Array): void {
    const targets = new Set<Connection>(extra);
    for (const viewId of viewIds) {
      const view = this.views.get(viewId);
      if (view) targets.add(view.conn);
    }
    for (const conn of targets) {
      // While an attach of this connection runs, its response must come first; the order of events stays.
      if (conn.pendingAttaches > 0) conn.held.push(bytes);
      else this.write(conn, bytes);
    }
  }

  /** Ends one attach of the connection; the last one releases the held events, also after a failure. */
  private endAttach(conn: Connection): void {
    conn.pendingAttaches -= 1;
    if (conn.pendingAttaches > 0) return;
    const held = conn.held.splice(0);
    for (const bytes of held) this.write(conn, bytes);
  }

  private accept(socket: Socket): void {
    if (this.pendingHandshakes >= this.maxPendingHandshakes) {
      socket.on("error", () => {});
      socket.destroy();
      return;
    }
    this.pendingHandshakes += 1;
    const conn: Connection = {
      socket,
      decoder: new FrameDecoder(),
      views: new Set(),
      greeted: false,
      closed: false,
      closing: false,
      listSubscriber: false,
      chain: Promise.resolve(),
      closeTimer: undefined,
      helloTimer: undefined,
      pendingAttaches: 0,
      held: [],
    };
    this.connections.add(conn);
    conn.helloTimer = setTimeout(() => socket.destroy(), this.helloTimeoutMs);
    // 'close' always follows an error and cleans up.
    socket.on("error", () => {});
    socket.on("data", (chunk) => this.onData(conn, chunk));
    socket.on("close", () => this.onClose(conn));
  }

  private onData(conn: Connection, chunk: Buffer): void {
    if (conn.closed || conn.closing) return;
    let frames: Frame[];
    try {
      frames = conn.decoder.push(chunk);
    } catch {
      conn.socket.destroy();
      return;
    }
    for (const frame of frames) conn.chain = conn.chain.then(() => this.handleFrame(conn, frame));
  }

  private onClose(conn: Connection): void {
    conn.closed = true;
    clearTimeout(conn.closeTimer);
    clearTimeout(conn.helloTimer);
    if (!conn.greeted) this.pendingHandshakes -= 1;
    this.connections.delete(conn);
    for (const viewId of [...conn.views]) this.releaseView(viewId);
  }

  private async handleFrame(conn: Connection, frame: Frame): Promise<void> {
    if (conn.closed || conn.closing) return;
    const parsed = parseRequest(frame);
    if (!parsed.ok) {
      if (parsed.id !== undefined) this.sendError(conn, parsed.id, parsed.error);
      if (!conn.greeted) this.endConnection(conn);
      return;
    }
    const request = parsed.value;
    if (!conn.greeted) {
      this.greet(conn, request);
      return;
    }
    try {
      const outcome = await this.dispatch(conn, request);
      if (outcome.error) this.sendError(conn, request.id, outcome.error);
      else {
        this.write(
          conn,
          encodeFrame({ kind: "response", id: request.id, result: outcome.result }, outcome.payload),
        );
      }
      outcome.after?.();
    } catch (error) {
      this.sendError(conn, request.id, this.toErrorBody(error));
    }
  }

  private greet(conn: Connection, request: ParsedRequest): void {
    if (request.method !== "hello") {
      this.sendError(conn, request.id, { code: "bad_request", message: "First message must be hello" });
      this.endConnection(conn);
      return;
    }
    const negotiated = negotiateHello(request.params);
    if (!negotiated.ok) {
      this.sendError(conn, request.id, negotiated.error);
      this.endConnection(conn);
      return;
    }
    conn.greeted = true;
    this.pendingHandshakes -= 1;
    clearTimeout(conn.helloTimer);
    this.write(conn, encodeFrame({ kind: "response", id: request.id, result: negotiated.value }));
  }

  private async dispatch(conn: Connection, request: ParsedRequest): Promise<Outcome> {
    const { registry } = this;
    await this.ready;
    if (this.shuttingDown && request.method !== "core.shutdown") {
      throw new CoreError("invalid_state", "Core is shutting down");
    }
    switch (request.method) {
      case "hello":
        throw new CoreError("bad_request", "hello was already sent");
      case "session.create": {
        const { name, launch, size, workspaceId, profileId, loggingEnabled } = request.params;
        const input: CreateSessionInput = { name, launch };
        if (size !== undefined) input.size = size;
        if (workspaceId !== undefined) input.workspaceId = workspaceId;
        if (profileId !== undefined) input.profileId = profileId;
        if (loggingEnabled !== undefined) input.loggingEnabled = loggingEnabled;
        return { result: { session: await registry.create(input) } };
      }
      case "session.list":
        conn.listSubscriber = true;
        return { result: { sessions: registry.list() } };
      case "session.attach":
        return this.attach(conn, request.params.sessionId);
      case "session.detach": {
        const { viewId } = request.params;
        const view = this.ownView(conn, viewId);
        try {
          registry.detachView(view.sessionId, viewId);
        } finally {
          this.forgetView(viewId);
        }
        return EMPTY_RESULT;
      }
      case "session.input": {
        const { viewId } = request.params;
        registry.input(this.ownView(conn, viewId).sessionId, viewId, request.payload);
        return EMPTY_RESULT;
      }
      case "session.resize": {
        const { viewId, size } = request.params;
        registry.resize(this.ownView(conn, viewId).sessionId, viewId, size);
        return EMPTY_RESULT;
      }
      case "session.claimWriter": {
        const { viewId } = request.params;
        registry.claimWriter(this.ownView(conn, viewId).sessionId, viewId);
        return EMPTY_RESULT;
      }
      case "session.kill":
        await registry.kill(request.params.sessionId);
        return EMPTY_RESULT;
      case "core.status":
        return { result: { backendUnavailable: registry.backendUnavailable() } };
      case "layout.get":
        return { result: this.layouts.get() };
      case "layout.save":
        return {
          result: { revision: this.layouts.save(request.params.layout, request.params.baseRevision) },
        };
      case "core.shutdown":
        return this.shutdown(request.params.stopSessions === true);
    }
  }

  private async attach(conn: Connection, sessionId: SessionId): Promise<Outcome> {
    const viewId = randomUUID();
    this.views.set(viewId, { sessionId, conn });
    conn.views.add(viewId);
    conn.pendingAttaches += 1;
    let attached;
    try {
      attached = await this.registry.attachView(sessionId, viewId);
    } catch (error) {
      this.forgetView(viewId);
      this.endAttach(conn);
      throw error;
    }
    if (conn.closed) {
      // The client left while the registry was working; nobody could use this view.
      this.releaseView(viewId);
      this.endAttach(conn);
      throw new CoreError("invalid_state", "Connection closed during attach");
    }
    const { session, snapshot, outputSeq } = attached;
    // A snapshot over the frame limit keeps its newest bytes, so the visible end of the screen survives.
    const data =
      snapshot.data.length > MAX_PAYLOAD_BYTES
        ? snapshot.data.subarray(snapshot.data.length - MAX_PAYLOAD_BYTES)
        : snapshot.data;
    const result: SessionAttachResult = { viewId, size: session.size, outputSeq };
    if (session.writerViewId !== undefined) result.writerViewId = session.writerViewId;
    return {
      result,
      payload: data,
      after: () => this.endAttach(conn),
    };
  }

  private ownView(conn: Connection, viewId: ViewId): ViewRecord {
    const view = this.views.get(viewId);
    if (!view || view.conn !== conn) throw new CoreError("not_found", `Unknown view ${viewId}`);
    return view;
  }

  private forgetView(viewId: ViewId): void {
    this.views.get(viewId)?.conn.views.delete(viewId);
    this.views.delete(viewId);
  }

  /** Detaches a view in the registry (a session that is gone or archived is fine) and forgets it. */
  private releaseView(viewId: ViewId): void {
    const view = this.views.get(viewId);
    this.forgetView(viewId);
    if (!view) return;
    try {
      this.registry.detachView(view.sessionId, viewId);
    } catch {
      // Not attached (anymore): nothing to release.
    }
  }

  /**
   * Handles one `core.shutdown`. From the first request on, all other requests are refused. Requests that
   * arrive while another one is running or shortly after its answer are merged: stopSessions of any of them
   * applies (OR), each one is answered, and the server closes only after the last answer plus a settle time.
   */
  private async shutdown(stopSessions: boolean): Promise<Outcome> {
    this.shuttingDown = true;
    this.pendingShutdownReplies += 1;
    clearTimeout(this.settleTimer);
    const after = (): void => {
      this.pendingShutdownReplies -= 1;
      if (this.pendingShutdownReplies > 0) return;
      this.settleTimer = setTimeout(() => {
        void this.close().then(() => this.onShutdown?.());
      }, SHUTDOWN_SETTLE_MS);
    };
    if (stopSessions) this.stopWork ??= this.stopAllSessions();
    const stopped = this.stopWork ? await this.stopWork : undefined;
    if (stopped && stopped.failed.length > 0) {
      return {
        result: {},
        error: { code: stopped.code, message: `Could not stop sessions: ${stopped.failed.join(", ")}` },
        after,
      };
    }
    return { result: {}, after };
  }

  /**
   * Ends all sessions that run or are still starting. Sessions in `Starting` are awaited for up to
   * `startWaitMs` first; those still starting after that count as not stopped.
   */
  private async stopAllSessions(): Promise<{ failed: SessionId[]; code: ErrorCode }> {
    const deadline = Date.now() + this.startWaitMs;
    while (this.registry.list().some((s) => s.state === "Starting") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const targets = this.registry
      .list()
      .filter((s) => s.state === "Starting" || s.state === "Running" || s.state === "Detached");
    const results = await Promise.allSettled(targets.map((s) => this.registry.kill(s.id)));
    const failed: SessionId[] = [];
    let code: ErrorCode = "internal";
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      failed.push(targets[index]!.id);
      if (failed.length === 1 && result.reason instanceof CoreError) code = result.reason.code;
      else if (!(result.reason instanceof CoreError)) this.onInternalError(result.reason);
    });
    return { failed, code };
  }

  private toErrorBody(error: unknown): ErrorBody {
    if (error instanceof CoreError) return { code: error.code, message: error.message };
    this.onInternalError(error);
    return { code: "internal", message: "Internal error" };
  }

  private sendError(conn: Connection, id: string, error: ErrorBody): void {
    this.write(conn, encodeFrame({ kind: "response", id, error }));
  }

  /** Writes and enforces the buffer limit: a client that does not read is disconnected. */
  private write(conn: Connection, bytes: Uint8Array): void {
    if (conn.closed || conn.socket.destroyed) return;
    conn.socket.write(bytes);
    if (conn.socket.writableLength > this.maxBufferedBytes) conn.socket.destroy();
  }

  /** Ends after pending writes are flushed; destroys the socket if the peer does not follow. */
  private endConnection(conn: Connection): void {
    if (conn.closed || conn.closing) return;
    conn.closing = true;
    conn.socket.end();
    conn.closeTimer = setTimeout(() => conn.socket.destroy(), CLOSE_GRACE_MS);
  }

  private async shutdownServer(): Promise<void> {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
    const stopped = new Promise<void>((resolve) => this.netServer.close(() => resolve()));
    for (const conn of [...this.connections]) this.endConnection(conn);
    await stopped;
  }
}

function eventFrame<E extends EventName>(event: E, data: EventMap[E], payload?: Uint8Array): Uint8Array {
  return encodeFrame({ kind: "event", event, data }, payload);
}
