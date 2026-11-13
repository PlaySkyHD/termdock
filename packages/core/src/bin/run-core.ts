// Start logic of the `termdock-core` process, separate from `process.exit` so that tests can run it.
// Order (ADR 0001, design assemble-core): take the pipe, open the database, reconcile, then serve requests.
import type { SessionInfo } from "@termdock/protocol";
import type { Backend } from "../backend/types.js";
import { DEFAULT_TMUX_SOCKET, WslBackend } from "../backend/wsl/backend.js";
import { AlreadyRunningError, CoreServer } from "../ipc/server.js";
import { CoreError } from "../session/errors.js";
import { SessionRegistry } from "../session/registry.js";
import type { RestoreResult } from "../session/registry.js";
import { openStorage } from "../storage/database.js";
import type { Storage } from "../storage/database.js";
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
  /** Called when the core ends on purpose (shutdown request, signal). The entry point maps it to `process.exit`. */
  onExit?: (exitCode: number) => void;
}

export interface RunCoreResult {
  exitCode: number;
  errorCode?: "already_running" | "start_failed";
  /** Set when the core runs. */
  server?: CoreServer;
  /** Outcome of the reconcile on start; set when the core runs. */
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

export async function runCore(options: RunCoreOptions = {}): Promise<RunCoreResult> {
  const stderr = options.stderr ?? process.stderr;
  // Only messages: stack traces stay out of logs, as they stay out of IPC answers.
  const log = (text: string): void => void stderr.write(`termdock-core: ${text}\n`);
  const ownBackends: WslBackend[] = options.backends
    ? []
    : [new WslBackend({ socket: options.tmuxSocket ?? DEFAULT_TMUX_SOCKET })];
  const repository = new StorageRepository();
  const registry = new SessionRegistry({
    backends: options.backends ?? ownBackends,
    repository,
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
  const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
  let closing: Promise<void> | undefined;
  close = () => {
    closing ??= (async () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
      await server.close();
      registry.dispose();
      for (const backend of ownBackends) backend.dispose();
      storage?.dispose();
    })();
    return closing;
  };

  let restore: RestoreResult;
  try {
    storage = openStorage(options.dataDir === undefined ? {} : { dataDir: options.dataDir });
    repository.target = storage.sessions;
    restore = await registry.restore();
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
  markReady();

  if (options.installSignalHandlers !== false) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = (): void => void close().then(() => options.onExit?.(0));
      signalHandlers.push([signal, handler]);
      process.once(signal, handler);
    }
  }
  return { exitCode: 0, server, restore, close };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
