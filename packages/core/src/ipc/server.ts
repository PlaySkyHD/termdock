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
  EventMap,
  EventName,
  Frame,
  ParsedRequest,
  SessionId,
  ViewId,
} from "@termdock/protocol";
import type { Disposable } from "../backend/types.js";
import { CoreError } from "../session/errors.js";
import type { CreateSessionInput, SessionRegistry } from "../session/registry.js";
import { defaultPipeName } from "./pipe-name.js";

/** Not-yet-written bytes per client above which the client is disconnected (16 MiB). */
export const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
/** How long a closing connection may take to flush before it is destroyed. */
const CLOSE_GRACE_MS = 1000;

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
  /** Pipe path; defaults to `\\.\pipe\termdock-core-<user>`. Tests pass a unique name. */
  pipePath?: string;
  /** Per-client limit for output the client has not read yet; defaults to 16 MiB. */
  maxBufferedBytes?: number;
  /** Called once after `core.shutdown` has closed the server. The entry point ends the process here. */
  onShutdown?: () => void;
  /** Receives the cause of every error that is answered with `internal`. */
  onInternalError?: (error: unknown) => void;
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
}

interface ViewRecord {
  readonly sessionId: SessionId;
  readonly conn: Connection;
  /** Events held back until the attach response is written; undefined once the view is ready. */
  queue: Uint8Array[] | undefined;
}

interface Outcome {
  result: unknown;
  payload?: Uint8Array;
  /** Runs after the response is written. */
  after?: () => void;
}

const EMPTY_RESULT: Outcome = { result: {} };

export class CoreServer {
  readonly pipePath: string;
  private readonly registry: SessionRegistry;
  private readonly maxBufferedBytes: number;
  private readonly onShutdown: (() => void) | undefined;
  private readonly onInternalError: (error: unknown) => void;
  private readonly netServer: Server;
  private readonly connections = new Set<Connection>();
  private readonly views = new Map<ViewId, ViewRecord>();
  private subscriptions: Disposable[] = [];
  private closePromise: Promise<void> | undefined;
  private stopWork: Promise<void> | undefined;

  private constructor(options: CoreServerOptions) {
    this.registry = options.registry;
    this.pipePath = options.pipePath ?? defaultPipeName();
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.onShutdown = options.onShutdown;
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
      this.registry.onOutput(({ sessionId, data, viewIds }) => {
        for (let offset = 0; offset < data.length; offset += MAX_PAYLOAD_BYTES) {
          const chunk = data.subarray(offset, offset + MAX_PAYLOAD_BYTES);
          this.route(viewIds, [], eventFrame("session.output", { sessionId }, chunk));
        }
      }),
      this.registry.onResized(({ sessionId, size, viewIds }) => {
        this.route(viewIds, [], eventFrame("session.resized", { sessionId, size }));
      }),
      this.registry.onWriterChanged(({ sessionId, writerViewId, viewIds }) => {
        const data = writerViewId === undefined ? { sessionId } : { sessionId, writerViewId };
        this.route(viewIds, [], eventFrame("view.writerChanged", data));
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
    const targets = new Map<Connection, ViewRecord | undefined>();
    for (const viewId of viewIds) {
      const view = this.views.get(viewId);
      if (!view) continue;
      const current = targets.get(view.conn);
      // A view still waiting for its attach response holds the event back for the whole connection.
      if (!targets.has(view.conn) || (view.queue && !current?.queue)) targets.set(view.conn, view);
    }
    for (const conn of extra) if (!targets.has(conn)) targets.set(conn, undefined);
    for (const [conn, view] of targets) {
      if (view?.queue) view.queue.push(bytes);
      else this.write(conn, bytes);
    }
  }

  private accept(socket: Socket): void {
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
    };
    this.connections.add(conn);
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
      this.write(
        conn,
        encodeFrame({ kind: "response", id: request.id, result: outcome.result }, outcome.payload),
      );
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
    this.write(conn, encodeFrame({ kind: "response", id: request.id, result: negotiated.value }));
  }

  private async dispatch(conn: Connection, request: ParsedRequest): Promise<Outcome> {
    const { registry } = this;
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
      case "core.shutdown": {
        const stopSessions = request.params.stopSessions === true;
        // Concurrent requests share one stop run; a later request with stopSessions still stops the sessions.
        if (stopSessions) {
          this.stopWork ??= this.stopSessions();
          await this.stopWork;
        }
        return {
          result: {},
          after: () => {
            void this.close().then(() => this.onShutdown?.());
          },
        };
      }
    }
  }

  private async attach(conn: Connection, sessionId: SessionId): Promise<Outcome> {
    const viewId = randomUUID();
    this.views.set(viewId, { sessionId, conn, queue: [] });
    conn.views.add(viewId);
    let attached;
    try {
      attached = await this.registry.attachView(sessionId, viewId);
    } catch (error) {
      this.forgetView(viewId);
      throw error;
    }
    if (conn.closed) {
      // The client left while the registry was working; nobody could use this view.
      this.releaseView(viewId);
      throw new CoreError("invalid_state", "Connection closed during attach");
    }
    const { session, snapshot } = attached;
    // A snapshot over the frame limit keeps its newest bytes, so the visible end of the screen survives.
    const data =
      snapshot.data.length > MAX_PAYLOAD_BYTES
        ? snapshot.data.subarray(snapshot.data.length - MAX_PAYLOAD_BYTES)
        : snapshot.data;
    const result: { viewId: ViewId; size: typeof session.size; writerViewId?: ViewId } = {
      viewId,
      size: session.size,
    };
    if (session.writerViewId !== undefined) result.writerViewId = session.writerViewId;
    return {
      result,
      payload: data,
      after: () => {
        const view = this.views.get(viewId);
        const queued = view?.queue ?? [];
        if (view) view.queue = undefined;
        for (const bytes of queued) this.write(conn, bytes);
      },
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

  private async stopSessions(): Promise<void> {
    const running = this.registry.list().filter((s) => s.state === "Running" || s.state === "Detached");
    const results = await Promise.allSettled(running.map((s) => this.registry.kill(s.id)));
    for (const result of results) if (result.status === "rejected") this.onInternalError(result.reason);
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
