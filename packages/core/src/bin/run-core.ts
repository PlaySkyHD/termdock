// Start logic of the `termdock-core` process, separate from `process.exit` so that tests can run it.
// Order (ADR 0001, design assemble-core): take the pipe, open the database, reconcile, register the autostart
// sessions (issue #61), then serve requests.
import path from "node:path";
import { DEFAULT_SETTINGS } from "@termdock/protocol";
import type {
  LaunchProfile,
  LayoutDocument,
  SessionId,
  SessionInfo,
  Settings,
  SettingsPatch,
  Workspace,
} from "@termdock/protocol";
import type { Backend } from "../backend/types.js";
import { DEFAULT_TMUX_SOCKET, WslBackend } from "../backend/wsl/backend.js";
import type { WslBackendOptions } from "../backend/wsl/backend.js";
import { AlreadyRunningError, CoreServer } from "../ipc/server.js";
import { createLogger, logDir } from "../log/index.js";
import { runAutostart } from "../session/autostart.js";
import type { AutostartResult } from "../session/autostart.js";
import { CoreError } from "../session/errors.js";
import { SessionRegistry } from "../session/registry.js";
import type { RestoreResult } from "../session/registry.js";
import { openStorage, resolveDataDir } from "../storage/database.js";
import { recordHistory } from "../storage/history-recorder.js";
import { searchHistory, storeSource } from "../storage/history-search.js";
import { HistoryStore } from "../storage/history-store.js";
import type { HistorySettings } from "../storage/history-store.js";
import type { Storage } from "../storage/database.js";
import type { LayoutRepository, StoredLayout } from "../storage/layout-repository.js";
import type { ProfileRepository } from "../storage/profile-repository.js";
import type { SettingsRepository } from "../storage/settings-repository.js";
import type { SessionRepository } from "../storage/session-repository.js";
import type { WorkspaceRepository } from "../storage/workspace-repository.js";
import { ProfileService } from "../workspace/profile-service.js";
import { WorkspaceService } from "../workspace/service.js";

/** Name of the core's log file in `<dataDir>/logs/` (spec diagnostics). */
export const CORE_LOG_FILE = "core.log";
/** Exit code of a second core that finds the pipe taken (ADR 0001). */
export const ALREADY_RUNNING_EXIT_CODE = 10;
/** `wsl.distros` waits at most this long for `wsl.exe -l -v`; a desktop request waits 10 s (spec wsl-backend). */
const DISTRO_LIST_TIMEOUT_MS = 5_000;

export interface RunCoreOptions {
  /** Defaults to the per-user pipe name. */
  pipePath?: string;
  /** Directory of `termdock.db` and `logs/`; defaults to `TERMDOCK_DATA_DIR`, else `%APPDATA%\TermDock`. */
  dataDir?: string;
  /** tmux socket of the WSL backend; defaults to `termdock`. Tests use `termdock-test`. */
  tmuxSocket?: string;
  /** Replaces the default backends (a `WslBackend`); the caller then owns and disposes them. */
  backends?: readonly Backend[];
  /** Creates the core's own `WslBackend` when `backends` is unset; the core owns and disposes it. Tests use it. */
  createWslBackend?: (options: WslBackendOptions) => WslBackend;
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
  /** Outcome of the autostart after the reconcile; set when the core runs, unset when it was closed before. */
  autostart?: AutostartResult;
  /**
   * Set when the core runs. Closes the pipe, releases all PTYs without changing session states, disposes the
   * backends the core created (WSL: keepalives and tmux sessions stay, issue #140) and closes the database. Idempotent.
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

  delete(sessionId: SessionId): void {
    this.open().delete(sessionId);
  }

  clearWorkspace(workspaceId: string, updatedAt: string): void {
    this.open().clearWorkspace(workspaceId, updatedAt);
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

/** Same forwarding for the settings. */
class StorageSettingsRepository implements SettingsRepository {
  target: SettingsRepository | undefined;

  get(): Settings {
    return this.open().get();
  }

  set(patch: SettingsPatch): Settings {
    return this.open().set(patch);
  }

  private open(): SettingsRepository {
    if (!this.target) throw new Error("The database is not open yet");
    return this.target;
  }
}

/** Same forwarding for workspaces and projects. */
class StorageWorkspaceRepository implements WorkspaceRepository {
  target: WorkspaceRepository | undefined;

  list(): Workspace[] {
    return this.open().list();
  }

  save(workspace: Workspace): void {
    this.open().save(workspace);
  }

  delete(workspaceId: string, alsoInTransaction?: () => void): boolean {
    return this.open().delete(workspaceId, alsoInTransaction);
  }

  private open(): WorkspaceRepository {
    if (!this.target) throw new Error("The database is not open yet");
    return this.target;
  }
}

/** Same forwarding for launch profiles. */
class StorageProfileRepository implements ProfileRepository {
  target: ProfileRepository | undefined;

  list(): LaunchProfile[] {
    return this.open().list();
  }

  save(profile: LaunchProfile): void {
    this.open().save(profile);
  }

  delete(profileId: string): boolean {
    return this.open().delete(profileId);
  }

  private open(): ProfileRepository {
    if (!this.target) throw new Error("The database is not open yet");
    return this.target;
  }
}

export async function runCore(options: RunCoreOptions = {}): Promise<RunCoreResult> {
  const stderr = options.stderr ?? process.stderr;
  // The log folder lies in the data directory; if that cannot be found, the core still logs to stderr and
  // then fails to start below with the same reason.
  let dataDir: string | undefined;
  let dataDirError: unknown;
  try {
    dataDir = options.dataDir ?? resolveDataDir();
  } catch (error) {
    dataDirError = error;
  }
  let logWriteFailed = false;
  const logger = createLogger({
    ...(dataDir === undefined ? {} : { file: path.join(logDir(dataDir), CORE_LOG_FILE) }),
    source: "core",
    // stderr stays as before, for tests and development.
    mirror: (_line, _level, _source, text) => void stderr.write(`termdock-core: ${text}\n`),
    // Once: a log file that cannot be written would otherwise stay unnoticed.
    onWriteError: (error) => {
      if (logWriteFailed) return;
      logWriteFailed = true;
      void stderr.write(`termdock-core: log file not writable: ${messageOf(error)}\n`);
    },
  });
  // Messages only in the IPC answers and on stderr; a stack trace of an unexpected error goes into the file too.
  const log = (text: string): void => logger.error(text);
  const warn = (text: string): void => logger.warn(text);
  const createWslBackend = options.createWslBackend ?? ((wslOptions) => new WslBackend(wslOptions));
  const ownBackends: WslBackend[] = options.backends
    ? []
    : [createWslBackend({ socket: options.tmuxSocket ?? DEFAULT_TMUX_SOCKET })];
  const wslBackend = (options.backends ?? ownBackends).find(
    (backend): backend is WslBackend => backend instanceof WslBackend,
  );
  const repository = new StorageRepository();
  const layouts = new StorageLayoutRepository();
  const settings = new StorageSettingsRepository();
  // History limit and logging default come from the stored settings, read at each use (spec history, settings);
  // before the database is open the defaults apply.
  const getSettings = (): HistorySettings => settings.target?.get() ?? DEFAULT_SETTINGS;
  const workspaces = new StorageWorkspaceRepository();
  const profiles = new StorageProfileRepository();
  // Opened with the storage below; requests wait for the reconcile, so a delete always finds it.
  let history: HistoryStore | undefined;
  const registry = new SessionRegistry({
    backends: options.backends ?? ownBackends,
    repository,
    defaultLoggingEnabled: () => getSettings().historyEnabledByDefault,
    onPersistError: (error, session) => log(`could not save session ${session.id}: ${messageOf(error)}`),
    onRedrawError: (error, session) => log(`could not redraw session ${session.id}: ${messageOf(error)}`),
    onListenerError: (error) => log(`registry listener failed: ${detailOf(error)}`),
    // Forgets the session in the store and deletes `history/<id>/` (path check in `historyDir`, ADR 0004).
    removeHistory: async (sessionId) => {
      if (!history) throw new Error("The history store is not open yet");
      await history.remove(sessionId);
    },
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
      settings,
      workspaces,
      profiles,
      // Only sessions the registry knows: a history left behind without a session is not searched.
      searchHistory: async ({ query, sessionIds, limit }) => {
        if (!history) throw new Error("The history store is not open yet");
        const known = new Set(registry.list().map((session) => session.id));
        return searchHistory(storeSource(history), {
          query,
          ...(sessionIds === undefined ? {} : { sessionIds }),
          ...(limit === undefined ? {} : { limit }),
          isKnownSession: (id) => known.has(id),
        });
      },
      // The distros for the settings dialog (#64), from the core's own or a given WSL backend.
      ...(wslBackend === undefined
        ? {}
        : { listDistros: () => wslBackend.distros({ timeoutMs: DISTRO_LIST_TIMEOUT_MS }) }),
      ready,
      ...(options.pipePath === undefined ? {} : { pipePath: options.pipePath }),
      onShutdown: () => void close().then(() => options.onExit?.(0)),
      onInternalError: (error) => log(`internal error: ${detailOf(error)}`),
    });
  } catch (error) {
    // No session is known yet, so there is nothing to hand over.
    for (const backend of ownBackends) void backend.dispose();
    if (error instanceof AlreadyRunningError) {
      // Only on stderr: a second core must not create or touch the data directory (ADR 0001), and the log
      // file belongs to the core that runs.
      void stderr.write(`termdock-core: already_running: ${error.message}\n`);
      return { exitCode: ALREADY_RUNNING_EXIT_CODE, errorCode: "already_running" };
    }
    log(`start failed: ${detailOf(error)}`);
    await logger.flush();
    return { exitCode: 1, errorCode: "start_failed" };
  }

  let storage: Storage | undefined;
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
      // Hands the WSL keepalives over (issue #140); the process must not exit before a keepalive runs.
      await Promise.all(ownBackends.map((backend) => backend.dispose()));
      // Queued output is written before the process may end.
      await history?.dispose();
      storage?.dispose();
      // The process may end right after: what was logged is written first.
      await logger.flush();
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
    if (dataDir === undefined) throw dataDirError;
    storage = openStorage({ dataDir, onLayoutInvalid: log, onProfileInvalid: log });
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
    settings.target = storage.settings;
    workspaces.target = storage.workspaces;
    profiles.target = storage.profiles;
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
    log(`start failed: ${detailOf(error)}`);
    // Let the waiting requests write their answers before the connections end.
    await new Promise((resolve) => setImmediate(resolve));
    await close();
    return { exitCode: 1, errorCode: "start_failed" };
  }
  for (const kind of restore.backendUnavailable) {
    warn(`backend_unavailable: ${kind} could not be reached, its sessions are Interrupted`);
  }
  // Autostart (issue #61): once per start, after the reconcile and before requests are let through, so every
  // client sees the autostart sessions in its first `session.list` and no request (profile change, shutdown)
  // runs alongside it. It waits for the sessions to be registered, not for their start. It never rejects.
  const autostarting = runAutostart({
    registry,
    profiles: new ProfileService(profiles, new WorkspaceService(workspaces)),
    settings: () => settings.get(),
    backends: options.backends ?? ownBackends,
    knownUnavailable: restore.backendUnavailable,
    knownAvailable: restore.backendAvailable,
    cancelled: () => closing !== undefined,
    report: log,
  });
  const autostart = await Promise.race([autostarting, closed]);
  if (autostart === "closed") {
    await close();
    return { exitCode: 0, server, restore, close };
  }
  isReady = true;
  markReady();
  return { exitCode: 0, server, restore, autostart, close };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

/** Message and stack for the log file; the IPC answers never carry it. */
function detailOf(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : "unknown";
}
