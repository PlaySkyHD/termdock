// Start logic of the `termdock-core` process, separate from `process.exit` so that tests can run it.
// Order (ADR 0001, design assemble-core): take the pipe, open the database, reconcile, then serve requests.
import { DEFAULT_SETTINGS } from "@termdock/protocol";
import type { LayoutDocument, SessionInfo } from "@termdock/protocol";
import type { Backend } from "../backend/types.js";
import { DEFAULT_TMUX_SOCKET, WslBackend } from "../backend/wsl/backend.js";
import { AlreadyRunningError, CoreServer } from "../ipc/server.js";
import { CoreError } from "../session/errors.js";
import { SessionRegistry } from "../session/registry.js";
import type { RestoreResult } from "../session/registry.js";
import { openStorage, resolveDataDir } from "../storage/database.js";
import { recordHistory } from "../storage/history-recorder.js";
import { HistoryStore } from "../storage/history-store.js";
import type { HistorySettings } from "../storage/history-store.js";
import type { Storage } from "../storage/database.js";
import type { LayoutRepository, StoredLayout } from "../storage/layout-repository.js";
import type { SessionRepository } from "../storage/session-repository.js";

/** Exit code of a second core that finds the pipe taken (ADR 0001). */
export const ALREADY_RUNNING_EXIT_CODE = 10;

export interface RunCoreOptions {
  /** Defaults to the per-user pipe name. */
  pipePath?: string;
  /** Directory of `termdock.db`; defaults to `TERMDOCK_DATA_DIR`, else `%APPDATA%\TermDock`. */
  dataDir?: string;
  /** tmux socket of the WSL backend; defaults to `termdock`. Tests use `termdock-test`. */
  tmuxSocket?: string;
  /** Replaces the default backends (a `WslBackend`); the caller then owns and disposes them. */
  backends?: readonly Backend[];
  stderr?: { write(text: string): unknown };
  /** Close on SIGINT/SIGTERM. Default true; tests turn it off. */
  installSignalHandlers?: boolean;
  /** Where SIGINT/SIGTERM handlers are installed; defaults to `process`. Tests pass their own source. */
  signals?: SignalSource;
  /** Called when the core ends on purpose (shutdown request, signal). The entry point maps it to `process.exit`. */
  onExit?: (exitCode: number) => void;
}

/** The part of `process` the core uses for its signal handlers. */
export interface SignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface RunCoreResult {
  exitCode: number;
  errorCode?: "already_running" | "start_failed";
  /** Set when the core runs. */
  server?: CoreServer;
  /** Outcome of the reconcile on start; set when the core runs, unset when it was closed during the reconcile. */
  restore?: RestoreResult;
  /**
   * Set when the core runs. Closes the pipe, releases all PTYs without changing session states, disposes the
   * backends the core created (WSL: keepalives end, tmux sessions stay) and closes the database. Idempotent.
   */
  close?: () => Promise<void>;
}

/**
 * Forwards to the session repository of the storage, which is opened only after the pipe is taken. The server
 * holds every request until the reconcile is done, so nothing reaches the registry before the target is set.
 */
class StorageRepository implements SessionRepository {
  target: SessionRepository | undefined;

  list(): SessionInfo[] {
    return this.open().list();
  }

  save(session: SessionInfo): void {
    this.open().save(session);
  }

  private open(): SessionRepository {
    if (!this.target) throw new Error("The database is not open yet");
    return this.target;
  }
}

/** Same forwarding for the layout: requests wait for the reconcile, so the target is set before the first use. */
class StorageLayoutRepository implements LayoutRepository {
  target: LayoutRepository | undefined;

  get(): StoredLayout {
    return this.open().get();
  }

  save(layout: LayoutDocument, baseRevision?: number): number {
    return this.open().save(layout, baseRevision);
  }

  private open(): LayoutRepository {
    if (!this.target) throw new Error("The database is not open yet");
    return this.target;
  }
}

export async function runCore(options: RunCoreOptions = {}): Promise<RunCoreResult> {
  const stderr = options.stderr ?? process.stderr;
  // Only messages: stack traces stay out of logs, as they stay out of IPC answers.
  const log = (text: string): void => void stderr.write(`termdock-core: ${text}\n`);
  const ownBackends: WslBackend[] = options.backends
    ? []
    : [new WslBackend({ socket: options.tmuxSocket ?? DEFAULT_TMUX_SOCKET })];
  const repository = new StorageRepository();
  const layouts = new StorageLayoutRepository();
  // TODO(#60): wird mit dem Settings-Repository (#60) verdrahtet; bis dahin gelten die Standardwerte.
  const getSettings = (): HistorySettings => DEFAULT_SETTINGS;
  const registry = new SessionRegistry({
    backends: options.backends ?? ownBackends,
    repository,
    defaultLoggingEnabled: () => getSettings().historyEnabledByDefault,
    onPersistError: (error, session) => log(`could not save session ${session.id}: ${messageOf(error)}`),
  });
  let markReady: () => void = () => {};
  let markFailed: (error: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    markFailed = reject;
  });

  let close: () => Promise<void> = async () => {};
  let server: CoreServer;
  try {
    server = await CoreServer.start({
      registry,
      layouts,
      ready,
      ...(options.pipePath === undefined ? {} : { pipePath: options.pipePath }),
      onShutdown: () => void close().then(() => options.onExit?.(0)),
      onInternalError: (error) => log(`internal error: ${messageOf(error)}`),
    });
  } catch (error) {
    for (const backend of ownBackends) backend.dispose();
    if (error instanceof AlreadyRunningError) {
      log(`already_running: ${error.message}`);
      return { exitCode: ALREADY_RUNNING_EXIT_CODE, errorCode: "already_running" };
    }
    log(`start failed: ${messageOf(error)}`);
    return { exitCode: 1, errorCode: "start_failed" };
  }

  let storage: Storage | undefined;
  let history: HistoryStore | undefined;
  const signals = options.signals ?? process;
  const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
  let isReady = false;
  let closing: Promise<void> | undefined;
  let markClosed: () => void = () => {};
  const closed = new Promise<"closed">((resolve) => (markClosed = () => resolve("closed")));
  close = () => {
    closing ??= (async () => {
      markClosed();
      for (const [signal, handler] of signalHandlers) signals.off(signal, handler);
      if (!isReady) {
        // Closed during the reconcile: waiting requests get an answer before the connections end.
        markFailed(new CoreError("internal", "Core is shutting down"));
        await new Promise((resolve) => setImmediate(resolve));
      }
      await server.close();
      // Also stops a reconcile still running: it changes and saves nothing more and releases late PTYs.
      registry.dispose();
      for (const backend of ownBackends) backend.dispose();
      // Queued output is written before the process may end.
      await history?.dispose();
      storage?.dispose();
    })();
    return closing;
  };

  // Right after the pipe is taken, so a signal during a slow reconcile still tears everything down.
  if (options.installSignalHandlers !== false) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = (): void => void close().then(() => options.onExit?.(0));
      signalHandlers.push([signal, handler]);
      signals.once(signal, handler);
    }
  }

  let restore: RestoreResult;
  try {
    const dataDir = options.dataDir ?? resolveDataDir();
    storage = openStorage({ dataDir, onLayoutInvalid: log });
    history = new HistoryStore({
      dataDir,
      getSettings,
      onError: (error, sessionId) =>
        log(`could not write history of session ${sessionId}: ${messageOf(error)}`),
    });
    // The subscription lives as long as the registry; it ends with `registry.dispose()`.
    recordHistory(registry, history);
    repository.target = storage.sessions;
    layouts.target = storage.layouts;
    const restoring = registry.restore();
    // After a close nothing waits for the reconcile any more; its outcome no longer matters.
    restoring.catch(() => {});
    const outcome = await Promise.race([restoring, closed]);
    if (outcome === "closed") {
      await close();
      return { exitCode: 0, server, close };
    }
    restore = outcome;
  } catch (error) {
    markFailed(new CoreError("internal", "Core failed to start"));
    log(`start failed: ${messageOf(error)}`);
    // Let the waiting requests write their answers before the connections end.
    await new Promise((resolve) => setImmediate(resolve));
    await close();
    return { exitCode: 1, errorCode: "start_failed" };
  }
  for (const kind of restore.backendUnavailable) {
    log(`backend_unavailable: ${kind} could not be reached, its sessions are Interrupted`);
  }
  isReady = true;
  markReady();
  return { exitCode: 0, server, restore, close };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
