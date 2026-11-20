// Keeps the desktop main connected to the core (#130): when the connection ends while the app runs, it connects or
// starts the core again, at most RESTART_LIMIT times within RESTART_WINDOW_MS. Its `port` stays the same object
// across restarts, so bridge, layout coordinator and quit flow keep theirs. Free of Electron so it runs in tests.
import { IpcError } from "@termdock/core";
import type { Disposable, EventListener } from "@termdock/core";
import type { EventName } from "@termdock/protocol";
import type { CorePort } from "./core-connection.js";

/** At most this many restarts (failed ones included) within `RESTART_WINDOW_MS`; then the app stays disconnected. */
export const RESTART_LIMIT = 3;
export const RESTART_WINDOW_MS = 120_000;
/** Wait after a restart that could not connect, before the next try. */
export const RESTART_RETRY_MS = 1_000;
/** Longest wait of `close` for a restart that is still connecting. */
export const CLOSE_WAIT_MS = 5_000;

/**
 * `connecting` before the first connection, `restarting` while a lost connection is replaced, `failed` when the
 * limit is reached (the button `restart()` leaves it), `stopped` once the app quits (final).
 */
export type SupervisorState = "connecting" | "connected" | "restarting" | "failed" | "stopped";

export interface SupervisorDeps<C extends CorePort> {
  /** Connects or starts the core like the app start (`connectOrStartCore`); resolves once the core is ready. */
  connect(): Promise<C>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Every change of the state, after `port.onClose` listeners have run for a lost connection. */
  onState?(state: SupervisorState): void;
  log(text: string): void;
}

interface Subscription {
  event: EventName;
  listener: EventListener<EventName>;
  current: Disposable | undefined;
}

export class CoreSupervisor<C extends CorePort> {
  private stateNow: SupervisorState = "connecting";
  private client: C | undefined;
  /** Times of the restarts within the window. */
  private restarts: number[] = [];
  private readonly subscriptions = new Set<Subscription>();
  private readonly closeListeners = new Set<() => void>();
  /** The restart in progress, if any. */
  private recovering: Promise<void> | undefined;
  /** The quit wants the sessions ended; a core that comes back after it is shut down as well. */
  private shutdownLate = false;

  /** The core connection as one object for the whole life of the app; requests fail with `closed` without one. */
  readonly port: CorePort = {
    request: (method, params, payload) =>
      this.client
        ? this.client.request(method, params, payload)
        : Promise.reject(new IpcError("closed", "The core is not connected")),
    on: <E extends EventName>(event: E, listener: EventListener<E>): Disposable => {
      const subscription: Subscription = {
        event,
        listener: listener as EventListener<EventName>,
        current: this.client?.on(event, listener),
      };
      this.subscriptions.add(subscription);
      return {
        dispose: () => {
          this.subscriptions.delete(subscription);
          subscription.current?.dispose();
          subscription.current = undefined;
        },
      };
    },
    onClose: (listener) => {
      this.closeListeners.add(listener);
      return { dispose: () => void this.closeListeners.delete(listener) };
    },
    close: () => this.close(),
  };

  constructor(private readonly deps: SupervisorDeps<C>) {}

  get state(): SupervisorState {
    return this.stateNow;
  }

  /** The current connection, undefined while there is none. */
  get current(): C | undefined {
    return this.client;
  }

  /** True while a lost connection is being replaced (the bridge tells the windows). */
  restarting(): boolean {
    return this.stateNow === "restarting";
  }

  /** The first connection. Throws like `connectOrStartCore`; a failed start is not retried. */
  async start(): Promise<C> {
    try {
      const client = await this.deps.connect();
      await this.bind(client);
      return client;
    } catch (error) {
      this.setState("failed");
      throw error;
    }
  }

  /** The button "Core neu starten": only from `failed`, with a fresh count. */
  restart(): void {
    if (this.stateNow !== "failed") return;
    this.restarts = [];
    this.recover();
  }

  /**
   * No restart from now on (the app quits); the connection stays until `close`. `stopSessions`: the quit ends the
   * sessions, so a core that a running restart brings back afterwards gets `core.shutdown { stopSessions }` too.
   */
  stop(options: { stopSessions?: boolean } = {}): void {
    if (options.stopSessions) this.shutdownLate = true;
    this.setState("stopped");
  }

  /**
   * Stops and ends the connection. A restart that is still connecting gets up to `CLOSE_WAIT_MS` to finish, so the
   * core it started is shut down (with `stopSessions`) or at least not left behind half connected.
   */
  async close(): Promise<void> {
    this.stop();
    if (this.recovering)
      await Promise.race([this.recovering, this.deps.sleep(CLOSE_WAIT_MS)]).catch(() => {});
    await this.client?.close();
  }

  /** True while there is no connection because the core is restarting or the restarts gave up. */
  disconnected(): boolean {
    return this.stateNow === "restarting" || this.stateNow === "failed";
  }

  /** Takes the connection; after `stop` it ends it instead (the returned promise, which `close` waits for). */
  private async bind(client: C): Promise<void> {
    if (this.stateNow === "stopped") {
      // The app quits while the core came back: nobody wants this connection, and a quit that ends the sessions
      // ends them on this core as well.
      if (this.shutdownLate)
        await client
          .request("core.shutdown", { stopSessions: true })
          .catch((error: unknown) => this.deps.log(`core.shutdown after the restart: ${messageOf(error)}`));
      await client.close().catch(() => {});
      return;
    }
    this.client = client;
    for (const subscription of this.subscriptions)
      subscription.current = client.on(subscription.event, subscription.listener);
    client.onClose(() => this.lost(client));
    this.setState("connected");
  }

  private lost(client: C): void {
    if (this.client !== client) return;
    this.client = undefined;
    for (const subscription of this.subscriptions) subscription.current = undefined;
    const restart = this.stateNow !== "stopped";
    // The listeners of the port read the new state (the bridge tells the windows whether a restart follows).
    if (restart) this.stateNow = this.allowed() ? "restarting" : "failed";
    for (const listener of [...this.closeListeners]) listener();
    if (!restart) return;
    this.deps.log(
      this.stateNow === "restarting"
        ? "core connection lost, restarting the core"
        : `core connection lost, no restart: ${RESTART_LIMIT} restarts within ${RESTART_WINDOW_MS / 1_000} s`,
    );
    this.deps.onState?.(this.stateNow);
    if (this.stateNow === "restarting") this.recover();
  }

  /** Whether one more restart fits into the window. */
  private allowed(): boolean {
    const since = this.deps.now() - RESTART_WINDOW_MS;
    this.restarts = this.restarts.filter((time) => time > since);
    return this.restarts.length < RESTART_LIMIT;
  }

  private recover(): void {
    const run = this.recoverLoop().finally(() => {
      if (this.recovering === run) this.recovering = undefined;
    });
    this.recovering = run;
  }

  private async recoverLoop(): Promise<void> {
    this.setState("restarting");
    for (;;) {
      if (!this.allowed()) {
        this.setState("failed");
        return;
      }
      this.restarts.push(this.deps.now());
      try {
        const client = await this.deps.connect();
        await this.bind(client);
        return;
      } catch (error) {
        this.deps.log(`core restart failed: ${messageOf(error)}`);
      }
      if (this.stopped()) return;
      if (!this.allowed()) {
        this.setState("failed");
        return;
      }
      await this.deps.sleep(RESTART_RETRY_MS);
      if (this.stopped()) return;
    }
  }

  /** A method, so the state is read anew after an await (`stop` may come meanwhile). */
  private stopped(): boolean {
    return this.stateNow === "stopped";
  }

  private setState(state: SupervisorState): void {
    // `stopped` is final.
    if (this.stateNow === state || this.stateNow === "stopped") return;
    this.stateNow = state;
    this.deps.onState?.(state);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
