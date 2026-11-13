// Connect to the core, start it only when that fails (ADR 0001, ADR 0006). Free of Electron so it runs in tests.
import { IpcError } from "@termdock/core";
import type { Disposable, EventListener, RequestResult } from "@termdock/core";
import type { CoreStatusResult, EventName, Method, MethodMap } from "@termdock/protocol";

/** What the desktop main needs of a core connection; `CoreClient` fits it. */
export interface CorePort {
  request<M extends Method>(
    method: M,
    params: MethodMap[M]["params"],
    payload?: Uint8Array,
  ): Promise<RequestResult<M>>;
  on<E extends EventName>(event: E, listener: EventListener<E>): Disposable;
  onClose(listener: () => void): Disposable;
  close(): Promise<void>;
}

/** Total time from the start of the core until the app gives up connecting (ADR 0001). */
export const START_TIMEOUT_MS = 5_000;
/** Waits between connect attempts after the start; the last value repeats. */
export const BACKOFF_MS: readonly number[] = [50, 100, 200, 400, 800, 1_000];
/** Timeout of the first request after `hello`: it waits for the reconcile of all stored sessions. */
export const READY_TIMEOUT_MS = 60_000;
/** Timeout of every later request. */
export const REQUEST_TIMEOUT_MS = 10_000;

export class CoreStartError extends Error {
  readonly code: "start_failed" | "core_unreachable";

  constructor(code: "start_failed" | "core_unreachable", message: string) {
    super(message);
    this.name = "CoreStartError";
    this.code = code;
  }
}

export interface ConnectOrStartDeps<C extends CorePort> {
  /** One connect attempt including `hello`. The client should use `READY_TIMEOUT_MS` for its requests. */
  connect(): Promise<C>;
  /** Starts a detached core; returns once the process is spawned, not when it is ready. */
  startCore(): void | Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface CoreConnection<C extends CorePort> {
  client: C;
  /** true when this call started the core. */
  started: boolean;
  /** Answer to the first request; set once the core has finished its reconcile. */
  status: CoreStatusResult;
}

export async function connectOrStartCore<C extends CorePort>(
  deps: ConnectOrStartDeps<C>,
): Promise<CoreConnection<C>> {
  let started = false;
  let client: C;
  try {
    client = await deps.connect();
  } catch (error) {
    // Only a missing pipe means "no core"; a mismatch or a refused pipe would not get better with a second core.
    if (!isCoreMissing(error)) throw error;
    started = true;
    try {
      await deps.startCore();
    } catch (error) {
      throw new CoreStartError("start_failed", `Could not start the core: ${messageOf(error)}`);
    }
    client = await connectWithBackoff(deps);
  }
  try {
    const { result } = await client.request("core.status", {});
    return { client, started, status: result };
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function connectWithBackoff<C extends CorePort>(deps: ConnectOrStartDeps<C>): Promise<C> {
  const deadline = deps.now() + START_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    const left = deadline - deps.now();
    if (left <= 0) break;
    await deps.sleep(Math.min(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 1_000, left));
    try {
      return await deps.connect();
    } catch (error) {
      if (!isCoreMissing(error)) throw error;
      lastError = error;
    }
  }
  throw new CoreStartError(
    "core_unreachable",
    `The core did not accept connections within ${START_TIMEOUT_MS} ms: ${messageOf(lastError)}`,
  );
}

/**
 * True when nobody holds the pipe (`ENOENT` from `connect`). The client library reports transport errors as
 * `IpcError("closed")` with the system error in the message.
 */
export function isCoreMissing(error: unknown): boolean {
  return error instanceof IpcError && error.code === "closed" && /\bENOENT\b/.test(error.message);
}

/**
 * Requests that may wait for WSL: creating a session can start the distro, attaching takes a tmux snapshot.
 * With the short timeout the renderer would report an error while the core still creates the session.
 */
export const SLOW_REQUEST_TIMEOUTS_MS: Readonly<Partial<Record<Method, number>>> = {
  "session.create": READY_TIMEOUT_MS,
  "session.attach": READY_TIMEOUT_MS,
};

/**
 * Wraps a port so that every request fails with `timeout` after `timeoutMs` (or its entry in `slow`). The core
 * still answers late; a late `session.attach` has created a view nobody knows, so it is detached at once.
 */
export function withRequestTimeout(
  port: CorePort,
  defaultTimeoutMs: number,
  slow: Readonly<Partial<Record<Method, number>>> = {},
): CorePort {
  return {
    request: (method, params, payload) =>
      new Promise((resolve, reject) => {
        const timeoutMs = slow[method] ?? defaultTimeoutMs;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          reject(new IpcError("timeout", `Request ${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        port.request(method, params, payload).then(
          (value) => {
            clearTimeout(timer);
            if (timedOut && method === "session.attach") {
              const { viewId } = value.result as { viewId: string };
              port.request("session.detach", { viewId }).catch(() => {});
            }
            resolve(value);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }),
    on: (event, listener) => port.on(event, listener),
    onClose: (listener) => port.onClose(listener),
    close: () => port.close(),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
