// Client library for the core's named pipe (ADR 0002). Used by the desktop main process and by tests.
import { randomUUID } from "node:crypto";
import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import { encodeFrame, FrameDecoder, parseEvent, parseResponse, PROTOCOL_VERSION } from "@termdock/protocol";
import type {
  ErrorCode,
  EventMap,
  EventName,
  Frame,
  Method,
  MethodMap,
  ParsedEvent,
} from "@termdock/protocol";
import type { Disposable } from "../backend/types.js";

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/** Error of a request: the core's error code, or `timeout` / `closed` for transport problems. */
export class IpcError extends Error {
  readonly code: ErrorCode | "timeout" | "closed";

  constructor(code: ErrorCode | "timeout" | "closed", message: string) {
    super(message);
    this.name = "IpcError";
    this.code = code;
  }
}

export interface ConnectOptions {
  clientId?: string;
  clientKind?: string;
  /** Protocol version sent in `hello`; defaults to the library's own. Mainly for tests. */
  protocolVersion?: string;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Receives exceptions thrown by event listeners; defaults to `console.error`. */
  onListenerError?: (error: unknown) => void;
}

export interface RequestResult<M extends Method> {
  result: MethodMap[M]["result"];
  /** Response payload, e.g. the snapshot of `session.attach`. */
  payload: Uint8Array;
}

export type EventListener<E extends EventName> = (data: EventMap[E], payload: Uint8Array) => void;

interface Pending {
  method: Method;
  resolve: (value: RequestResult<Method>) => void;
  reject: (error: IpcError) => void;
  timer: NodeJS.Timeout;
}

export class CoreClient {
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<EventName, Set<EventListener<EventName>>>();
  private readonly closeListeners = new Set<() => void>();
  private nextId = 1;
  private closed = false;
  private readonly closedPromise: Promise<void>;

  private constructor(
    private readonly socket: Socket,
    private readonly requestTimeoutMs: number,
    private readonly onListenerError: (error: unknown) => void,
  ) {
    this.closedPromise = new Promise((resolve) => {
      socket.once("close", () => {
        this.markClosed();
        resolve();
      });
    });
    socket.on("data", (chunk) => this.onData(chunk));
    // The 'close' event follows; errors are reported to pending requests there.
    socket.on("error", () => {});
  }

  /** Connects, performs the `hello` handshake and resolves with a ready client. */
  static async connect(pipePath: string, options: ConnectOptions = {}): Promise<CoreClient> {
    const socket = await openSocket(pipePath, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    const client = new CoreClient(
      socket,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      options.onListenerError ?? ((error) => console.error("termdock client: event listener failed:", error)),
    );
    try {
      await client.request("hello", {
        protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
        clientId: options.clientId ?? randomUUID(),
        clientKind: options.clientKind ?? "client",
      });
    } catch (error) {
      await client.close();
      throw error;
    }
    return client;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<M extends Method>(
    method: M,
    params: MethodMap[M]["params"],
    payload?: Uint8Array,
  ): Promise<RequestResult<M>> {
    if (this.closed) return Promise.reject(new IpcError("closed", "Connection is closed"));
    const id = String(this.nextId++);
    let bytes: Uint8Array;
    try {
      bytes = encodeFrame({ kind: "request", id, method, params }, payload);
    } catch (error) {
      return Promise.reject(new IpcError("bad_request", error instanceof Error ? error.message : "encode"));
    }
    return new Promise<RequestResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new IpcError("timeout", `Request ${method} timed out after ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as Pending["resolve"],
        reject,
        timer,
      });
      this.socket.write(bytes);
    });
  }

  /** Listens to one event kind; the returned handle removes the listener. */
  on<E extends EventName>(event: E, listener: EventListener<E>): Disposable {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as EventListener<EventName>);
    this.listeners.set(event, set);
    return { dispose: () => set.delete(listener as EventListener<EventName>) };
  }

  /** Called once when the connection ends, whether by `close()` or by the core. */
  onClose(listener: () => void): Disposable {
    if (this.closed) {
      queueMicrotask(listener);
      return { dispose: () => {} };
    }
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  /** Destroys the connection, rejects open requests with `closed` and resolves when the socket is gone. */
  async close(): Promise<void> {
    this.socket.destroy();
    await this.closedPromise;
  }

  private onData(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch {
      this.socket.destroy();
      return;
    }
    for (const frame of frames) this.onFrame(frame);
  }

  private onFrame(frame: Frame): void {
    const header = frame.header as { kind?: unknown; id?: unknown };
    if (header.kind === "event") {
      const parsed = parseEvent(frame);
      if (parsed.ok) this.emit(parsed.value);
      return;
    }
    if (typeof header.id !== "string") return;
    const pending = this.pending.get(header.id);
    if (!pending) return; // late answer after a timeout
    this.pending.delete(header.id);
    clearTimeout(pending.timer);
    const parsed = parseResponse(frame, pending.method);
    if (!parsed.ok) pending.reject(new IpcError(parsed.error.code, parsed.error.message));
    else if (!parsed.value.ok)
      pending.reject(new IpcError(parsed.value.error.code, parsed.value.error.message));
    else pending.resolve({ result: parsed.value.result, payload: parsed.value.payload });
  }

  private emit(event: ParsedEvent): void {
    for (const listener of [...(this.listeners.get(event.event) ?? [])]) {
      // A faulty listener must not stop other listeners or the frames behind this one.
      try {
        listener(event.data, event.payload);
      } catch (error) {
        this.reportListenerError(error);
      }
    }
  }

  private reportListenerError(error: unknown): void {
    try {
      this.onListenerError(error);
    } catch {
      // The error handler itself failed; nothing sensible is left to do.
    }
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new IpcError("closed", "Connection closed"));
      this.pending.delete(id);
    }
    for (const listener of [...this.closeListeners]) listener();
    this.closeListeners.clear();
  }
}

function openSocket(pipePath: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(pipePath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new IpcError("closed", `Connecting to ${pipePath} timed out`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new IpcError("closed", `Cannot connect to ${pipePath}: ${error.message}`));
    });
  });
}

export function connect(pipePath: string, options?: ConnectOptions): Promise<CoreClient> {
  return CoreClient.connect(pipePath, options);
}
