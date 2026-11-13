// Session Registry: identities, lifecycle, views and input lock of all sessions in the Core (ADR 0003, ADR 0005).
import { randomUUID } from "node:crypto";
import type {
  BackendKind,
  LaunchProfileId,
  LaunchSpec,
  SessionId,
  SessionInfo,
  SessionState,
  TerminalSize,
  ViewId,
  WorkspaceId,
} from "@termdock/protocol";
import type { Backend, Disposable, PtyHandle, TerminalSnapshot } from "../backend/types.js";
import type { SessionRepository } from "../storage/session-repository.js";
import { CoreError } from "./errors.js";
import { transition } from "./lifecycle.js";
import { OutputBuffer } from "./output-buffer.js";

/** Raw output kept per session as snapshot fallback (ADR 0003). */
export const OUTPUT_BUFFER_BYTES = 256 * 1024;

export interface SessionRegistryOptions {
  /** One backend per kind; the session's `launch.backend` selects it. */
  backends: readonly Backend[];
  /** Clock for `createdAt`/`updatedAt`; defaults to `new Date()`. */
  now?: () => Date;
  /**
   * Storage of the session metadata (ADR 0004). Every change of a session is saved before it is reported.
   * Without a repository the registry keeps sessions only in memory. Required for `restore()`.
   */
  repository?: SessionRepository;
  /**
   * Called when saving a session change fails. The change still takes effect in memory and is reported;
   * the next successful save of the session stores it. Defaults to `console.error`.
   */
  onPersistError?: (error: unknown, session: SessionInfo) => void;
  /**
   * Waits before each attempt to re-attach after a PTY ended without exit code; the length is the number of
   * attempts. Defaults to `DEFAULT_REATTACH_DELAYS_MS`.
   */
  reattachDelaysMs?: readonly number[];
}

/** Three attempts to re-attach a lost backend client: at once, after 0.5 s and after 2 s. */
export const DEFAULT_REATTACH_DELAYS_MS: readonly number[] = [0, 500, 2000];
/** A re-attached PTY that lives this long gives the session a fresh re-attach budget. */
const REATTACH_STABLE_MS = 30_000;

export interface CreateSessionInput {
  name: string;
  launch: LaunchSpec;
  /** Initial terminal size; defaults to 80×24. */
  size?: TerminalSize;
  workspaceId?: WorkspaceId;
  profileId?: LaunchProfileId;
  loggingEnabled?: boolean;
}

export interface StateChangeEvent {
  sessionId: SessionId;
  from: SessionState;
  to: SessionState;
  session: SessionInfo;
}

export interface WriterChangedEvent {
  sessionId: SessionId;
  /** Undefined when the writer detached and no view has claimed the input since. */
  writerViewId: ViewId | undefined;
  /** All views attached to the session; each of them gets `view.writerChanged`. */
  viewIds: readonly ViewId[];
}

export interface ResizedEvent {
  sessionId: SessionId;
  /** Authoritative size, set by the writer. */
  size: TerminalSize;
  viewIds: readonly ViewId[];
}

export interface OutputEvent {
  sessionId: SessionId;
  data: Uint8Array;
  /** Views attached when the output arrived; each of them gets `session.output`. */
  viewIds: readonly ViewId[];
}

export interface AttachResult {
  session: SessionInfo;
  /** Whether this view became the writer. */
  writer: boolean;
  /** Content to show before live output (ADR 0003). */
  snapshot: TerminalSnapshot;
}

/** How the reconcile changed one stored session. */
export interface ReconciledSession {
  sessionId: SessionId;
  from: SessionState;
  to: SessionState;
}

export interface RestoreResult {
  /** Sessions whose stored state was `Starting`, `Running` or `Detached`, in load order. */
  sessions: ReconciledSession[];
  /** Backends that could not be reached; the Core reports `backend_unavailable` in the status bar (ADR 0005). */
  backendUnavailable: BackendKind[];
}

/** Stored states whose process may still be alive and must be checked on start. */
const LIVE_STATES: ReadonlySet<SessionState> = new Set(["Starting", "Running", "Detached"]);

type Listener<T> = (event: T) => void;

const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

interface SessionEntry {
  info: SessionInfo;
  pty: PtyHandle | undefined;
  ptySubscriptions: Disposable[];
  /** Attached views in attach order. */
  views: Set<ViewId>;
  output: OutputBuffer;
  /** Output collected for views whose backend snapshot is still being taken. */
  attachCollectors: Set<Uint8Array[]>;
  /** Lifecycle operation in progress; further lifecycle calls are rejected meanwhile. */
  busy: "start" | "kill" | "archive" | "reattach" | undefined;
  /** PTY end reported while kill/archive was running; decides the state if that operation fails. */
  endedDuringOp: { exitCode?: number } | undefined;
  /** Re-attach attempts used since the last stable PTY, and when the last re-attached PTY was bound. */
  reattach: { attempts: number; boundAt: number };
}

class ListenerSet<T> {
  private readonly listeners = new Set<Listener<T>>();

  add(listener: Listener<T>): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit(event: T): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<SessionId, SessionEntry>();
  private readonly backends: readonly Backend[];
  private readonly now: () => Date;
  private readonly repository: SessionRepository | undefined;
  private readonly onPersistError: (error: unknown, session: SessionInfo) => void;
  private readonly reattachDelaysMs: readonly number[];
  private restored = false;
  private restoring = false;
  private unavailableAtRestore: BackendKind[] = [];
  private disposed = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly stateListeners = new ListenerSet<StateChangeEvent>();
  private readonly writerListeners = new ListenerSet<WriterChangedEvent>();
  private readonly resizedListeners = new ListenerSet<ResizedEvent>();
  private readonly outputListeners = new ListenerSet<OutputEvent>();

  constructor(options: SessionRegistryOptions) {
    this.backends = options.backends;
    this.now = options.now ?? (() => new Date());
    this.repository = options.repository;
    this.reattachDelaysMs = options.reattachDelaysMs ?? DEFAULT_REATTACH_DELAYS_MS;
    this.onPersistError =
      options.onPersistError ??
      ((error, session) => console.error(`TermDock: could not save session ${session.id}`, error));
  }

  onStateChange(listener: Listener<StateChangeEvent>): Disposable {
    return this.stateListeners.add(listener);
  }

  onWriterChanged(listener: Listener<WriterChangedEvent>): Disposable {
    return this.writerListeners.add(listener);
  }

  onResized(listener: Listener<ResizedEvent>): Disposable {
    return this.resizedListeners.add(listener);
  }

  onOutput(listener: Listener<OutputEvent>): Disposable {
    return this.outputListeners.add(listener);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((entry) => snapshotInfo(entry.info));
  }

  get(sessionId: SessionId): SessionInfo {
    return snapshotInfo(this.entry(sessionId).info);
  }

  /** Backends `restore()` could not reach (empty before restore); the Core reports them via `core.status`. */
  backendUnavailable(): BackendKind[] {
    return [...this.unavailableAtRestore];
  }

  /**
   * Releases all PTYs when the Core ends without stopping the sessions: states stay as they are (also in the
   * repository), so the next Core reconciles them; nothing is reported. Running re-attaches are cancelled.
   * Afterwards `create` and `restart` are rejected with `invalid_state`. Safe to call more than once.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const entry of this.sessions.values()) this.releasePty(entry);
  }

  /** Registers a new session in `Starting` and starts its process. */
  async create(input: CreateSessionInput): Promise<SessionInfo> {
    this.assertNotRestoring();
    if (input.size) assertSize(input.size);
    const timestamp = this.now().toISOString();
    const info: SessionInfo = {
      id: randomUUID(),
      name: input.name,
      state: "Starting",
      launch: input.launch,
      size: { ...(input.size ?? DEFAULT_SIZE) },
      loggingEnabled: input.loggingEnabled ?? true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (input.workspaceId !== undefined) info.workspaceId = input.workspaceId;
    if (input.profileId !== undefined) info.profileId = input.profileId;
    const entry = newEntry(info);
    // Stored before the start, so a Core that dies while starting leaves the session for the reconcile.
    // If that fails, nothing is registered or started: a session the Core cannot store would be lost on restart.
    try {
      this.repository?.save(info);
    } catch (cause) {
      throw new CoreError("internal", `Session ${info.id} could not be saved`, { cause });
    }
    this.sessions.set(info.id, entry);
    await this.launch(entry, { reuseExisting: false, clearOutput: false });
    return snapshotInfo(entry.info);
  }

  /**
   * Loads the stored sessions on Core start and reconciles them with the backends (ADR 0005).
   * Sessions in `Starting`, `Running` or `Detached`: Windows → `Interrupted` (the PTY belonged to the old Core);
   * WSL → re-attached and `Detached` if the backend session exists, otherwise `Interrupted`. An unreachable
   * backend makes its sessions `Interrupted` and is listed in `backendUnavailable`. `Exited`, `Interrupted` and
   * `Archived` stay as stored. New states are saved. Setting the state of a loaded session is not a transition
   * of a running one, so the transition table and `onStateChange` are bypassed; the result reports the changes.
   * A re-attached PTY that ends while restore still runs is handled like any PTY end (state change, event);
   * the result is built at the end from the current states, so it always reports the final state.
   * Needs a repository and runs once, before any session is created; `create` and `restart` are rejected with
   * `invalid_state` while it runs. If loading the stored sessions fails, restore can be called again.
   */
  async restore(): Promise<RestoreResult> {
    const repository = this.repository;
    if (!repository) throw new CoreError("internal", "SessionRegistry.restore needs a repository");
    if (this.restored || this.restoring || this.sessions.size > 0) {
      throw new CoreError("invalid_state", "Sessions can only be restored once, into an empty registry");
    }
    const stored = repository.list();
    this.restored = true;
    this.restoring = true;
    try {
      return await this.reconcileAll(stored);
    } finally {
      this.restoring = false;
    }
  }

  private async reconcileAll(stored: readonly SessionInfo[]): Promise<RestoreResult> {
    const reconciled: Array<{ entry: SessionEntry; from: SessionState }> = [];
    const unavailable = new Set<BackendKind>();
    const availability = new Map<Backend, Promise<boolean>>();
    const isAvailable = (backend: Backend): Promise<boolean> => {
      let available = availability.get(backend);
      if (!available) {
        available = backend.available().catch(() => false);
        availability.set(backend, available);
      }
      return available;
    };
    // One after another, so a slow WSL is not hit with many parallel wsl.exe calls.
    for (const info of stored) {
      const entry = newEntry(info);
      if (LIVE_STATES.has(info.state)) {
        reconciled.push({ entry, from: info.state });
        await this.reconcile(entry, isAvailable, unavailable);
      }
      this.sessions.set(info.id, entry);
    }
    this.unavailableAtRestore = [...unavailable];
    return {
      sessions: reconciled.map(({ entry, from }) => ({
        sessionId: entry.info.id,
        from,
        to: entry.info.state,
      })),
      backendUnavailable: [...unavailable],
    };
  }

  /**
   * Starts an `Exited` or `Interrupted` session again under the same id. Re-attaches when the backend
   * session still exists, so no second process is started. Views and writer stay.
   */
  async restart(sessionId: SessionId): Promise<SessionInfo> {
    this.assertNotRestoring();
    const entry = this.entry(sessionId);
    this.assertIdle(entry);
    this.setState(entry, "Starting");
    // The old output stays until the new PTY is bound, so a failed restart keeps it for the snapshot.
    await this.launch(entry, { reuseExisting: true, clearOutput: true });
    return snapshotInfo(entry.info);
  }

  /** Ends the process of a `Running` or `Detached` session through the backend; the session becomes `Exited`. */
  async kill(sessionId: SessionId): Promise<SessionInfo> {
    const entry = this.entry(sessionId);
    this.assertIdle(entry);
    if (!entry.pty) {
      throw new CoreError(
        "invalid_state",
        `Session ${sessionId} in state ${entry.info.state} has no process to kill`,
      );
    }
    await this.endProcess(entry, "kill", () => this.terminate(entry));
    this.setState(entry, "Exited");
    return snapshotInfo(entry.info);
  }

  /**
   * Archives a session. A running process, or a backend session that survived an interrupted PTY,
   * is ended first (ADR 0005). All views are detached; `Archived` is final.
   */
  async archive(sessionId: SessionId): Promise<SessionInfo> {
    const entry = this.entry(sessionId);
    this.assertIdle(entry);
    // Check before ending anything; the pure function throws invalid_state.
    transition(entry.info.state, "Archived");
    await this.endProcess(entry, "archive", async () => {
      if (entry.pty) {
        await this.terminate(entry);
      } else if (entry.info.state === "Interrupted") {
        const backend = this.backendFor(entry.info.launch);
        if (backend && (await this.backendExists(entry, backend))) {
          await this.killBackend(entry, backend);
        }
      }
    });
    if (entry.info.writerViewId !== undefined) this.setWriter(entry, undefined);
    entry.views.clear();
    entry.output.clear();
    this.setState(entry, "Archived");
    return snapshotInfo(entry.info);
  }

  /**
   * Attaches a view. A view that attaches to a session without other views becomes the writer (ADR 0005).
   * Allowed in every state except `Archived`.
   */
  async attachView(sessionId: SessionId, viewId: ViewId): Promise<AttachResult> {
    const entry = this.entry(sessionId);
    this.assertAttachable(entry, viewId);
    let snapshot: TerminalSnapshot | undefined;
    const pty = entry.pty;
    if (pty) {
      const backend = this.backendFor(entry.info.launch);
      // Output during the wait reaches neither the view nor (reliably) the backend snapshot; collect it.
      const inFlight: Uint8Array[] = [];
      entry.attachCollectors.add(inFlight);
      try {
        snapshot = await backend?.snapshot(entry.info.id, entry.info.launch);
      } catch {
        // Fall back to the Core buffer below; a missing screen must not fail the attach.
        snapshot = undefined;
      } finally {
        entry.attachCollectors.delete(inFlight);
      }
      // The session may have changed while the backend answered.
      this.assertAttachable(entry, viewId);
      if (entry.pty !== pty) snapshot = undefined;
      else if (snapshot && inFlight.length > 0) {
        // The appended output moves the cursor, so the backend's cursor position is no longer valid.
        snapshot = { data: concat([snapshot.data, ...inFlight]) };
      }
    }
    // Copy the buffer in the same synchronous step as the view is registered, so no output falls in between.
    snapshot ??= { data: entry.output.contents() };
    const writer = entry.views.size === 0;
    entry.views.add(viewId);
    if (writer) this.setWriter(entry, viewId);
    if (entry.pty && entry.info.state === "Detached") this.setState(entry, "Running");
    return { session: snapshotInfo(entry.info), writer, snapshot };
  }

  /** Detaches a view. The process keeps running; the writer gets no automatic successor (ADR 0005). */
  detachView(sessionId: SessionId, viewId: ViewId): void {
    const entry = this.entry(sessionId);
    this.assertView(entry, viewId);
    entry.views.delete(viewId);
    if (entry.info.writerViewId === viewId) this.setWriter(entry, undefined);
    if (entry.pty && entry.views.size === 0 && entry.info.state === "Running")
      this.setState(entry, "Detached");
  }

  /** Transfers the input right to `viewId` atomically and reports it to all views. */
  claimWriter(sessionId: SessionId, viewId: ViewId): void {
    const entry = this.entry(sessionId);
    this.assertView(entry, viewId);
    if (entry.info.writerViewId !== viewId) this.setWriter(entry, viewId);
  }

  /** Sends input of the writing view to the session's PTY. */
  input(sessionId: SessionId, viewId: ViewId, data: Uint8Array | string): void {
    const entry = this.entry(sessionId);
    this.assertWriter(entry, viewId);
    if (!entry.pty) throw new CoreError("invalid_state", `Session ${sessionId} has no running process`);
    entry.pty.write(data);
  }

  /** Sets the authoritative terminal size. Only the writer may resize (ADR 0003). */
  resize(sessionId: SessionId, viewId: ViewId, size: TerminalSize): void {
    const entry = this.entry(sessionId);
    this.assertWriter(entry, viewId);
    assertSize(size);
    entry.pty?.resize(size);
    entry.info.size = { cols: size.cols, rows: size.rows };
    entry.info.updatedAt = this.now().toISOString();
    this.persist(entry);
    this.resizedListeners.emit({ sessionId, size: { ...entry.info.size }, viewIds: [...entry.views] });
  }

  private entry(sessionId: SessionId): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new CoreError("not_found", `Unknown session ${sessionId}`);
    return entry;
  }

  private assertNotRestoring(): void {
    if (this.restoring) throw new CoreError("invalid_state", "Sessions are being restored");
    if (this.disposed) throw new CoreError("invalid_state", "The session registry is shut down");
  }

  private assertIdle(entry: SessionEntry): void {
    if (entry.busy) {
      throw new CoreError("invalid_state", `Session ${entry.info.id} is busy (${entry.busy} in progress)`);
    }
  }

  private assertAttachable(entry: SessionEntry, viewId: ViewId): void {
    if (entry.info.state === "Archived")
      throw new CoreError("invalid_state", `Session ${entry.info.id} is archived`);
    if (entry.views.has(viewId)) throw new CoreError("bad_request", `View ${viewId} is already attached`);
  }

  private assertView(entry: SessionEntry, viewId: ViewId): void {
    if (!entry.views.has(viewId)) {
      throw new CoreError("not_found", `View ${viewId} is not attached to session ${entry.info.id}`);
    }
  }

  private assertWriter(entry: SessionEntry, viewId: ViewId): void {
    this.assertView(entry, viewId);
    if (entry.info.writerViewId !== viewId) {
      throw new CoreError("not_writer", `View ${viewId} is not the writer of session ${entry.info.id}`);
    }
  }

  private setWriter(entry: SessionEntry, viewId: ViewId | undefined): void {
    if (viewId === undefined) delete entry.info.writerViewId;
    else entry.info.writerViewId = viewId;
    // Not saved: the writer is runtime state; the new updatedAt goes with the next save.
    entry.info.updatedAt = this.now().toISOString();
    this.writerListeners.emit({ sessionId: entry.info.id, writerViewId: viewId, viewIds: [...entry.views] });
  }

  private backendFor(launch: LaunchSpec): Backend | undefined {
    return this.backends.find((backend) => backend.kind === launch.backend);
  }

  /**
   * Runs `Starting → Running | Detached`, or `Starting → Interrupted` on failure.
   * With `reuseExisting`, a backend session that still exists is re-attached instead of started.
   */
  private async launch(
    entry: SessionEntry,
    options: { reuseExisting: boolean; clearOutput: boolean },
  ): Promise<void> {
    const { info } = entry;
    const backend = this.backendFor(info.launch);
    let pty: PtyHandle;
    entry.busy = "start";
    let startSize: TerminalSize = { ...info.size };
    try {
      if (!backend) throw new Error(`No backend for kind ${info.launch.backend}`);
      if (backend.resolveLaunch) {
        // Stored before the start, so a later Core finds the session even if the backend default changes.
        const resolved = await backend.resolveLaunch(info.launch);
        if (resolved !== info.launch) {
          info.launch = resolved;
          this.persist(entry);
        }
      }
      const reuse = options.reuseExisting && (await backend.exists(info.id, info.launch));
      startSize = { ...info.size };
      pty = reuse
        ? await backend.attach(info.id, info.launch, startSize)
        : await backend.start(info.id, info.launch, startSize);
    } catch (cause) {
      entry.busy = undefined;
      this.setState(entry, "Interrupted");
      throw new CoreError("backend_unavailable", `Session ${info.id} could not be started`, {
        cause,
        sessionId: info.id,
      });
    }
    entry.busy = undefined;
    if (this.disposed) {
      // The Core ended while the backend was starting; the backend session stays for the next reconcile.
      pty.dispose();
      throw new CoreError("invalid_state", `Session ${info.id} started after the registry was shut down`);
    }
    if (options.clearOutput) entry.output.clear();
    this.bindPty(entry, pty);
    // The writer may have resized while the backend was starting.
    if (info.size.cols !== startSize.cols || info.size.rows !== startSize.rows) pty.resize(info.size);
    this.setState(entry, "Running");
    // ADR 0005 has no Starting → Detached; without a view the session passes through Running.
    if (entry.views.size === 0) this.setState(entry, "Detached");
  }

  /**
   * Runs kill/archive work. If it fails after the PTY is already gone, the session must not stay
   * `Running`/`Detached` without a process: it becomes `Exited` (exit code known) or `Interrupted`.
   */
  private async endProcess(
    entry: SessionEntry,
    operation: "kill" | "archive",
    work: () => Promise<void>,
  ): Promise<void> {
    entry.busy = operation;
    entry.endedDuringOp = undefined;
    try {
      await work();
    } catch (error) {
      // Set by the PTY exit handler during `work`; the cast undoes TypeScript's narrowing to undefined.
      const ended = entry.endedDuringOp as SessionEntry["endedDuringOp"];
      entry.busy = undefined;
      entry.endedDuringOp = undefined;
      const { state } = entry.info;
      if (!entry.pty && (state === "Running" || state === "Detached")) {
        this.setState(entry, ended?.exitCode === undefined ? "Interrupted" : "Exited");
      }
      throw error;
    }
    entry.busy = undefined;
    entry.endedDuringOp = undefined;
  }

  private async backendExists(entry: SessionEntry, backend: Backend): Promise<boolean> {
    try {
      return await backend.exists(entry.info.id, entry.info.launch);
    } catch (cause) {
      throw new CoreError("backend_unavailable", `Session ${entry.info.id} could not be checked`, {
        cause,
        sessionId: entry.info.id,
      });
    }
  }

  /** Ends the backend session and releases the PTY. An exit the PTY reports meanwhile only records its code. */
  private async terminate(entry: SessionEntry): Promise<void> {
    const backend = this.backendFor(entry.info.launch);
    if (backend) await this.killBackend(entry, backend);
    this.releasePty(entry);
  }

  private async killBackend(entry: SessionEntry, backend: Backend): Promise<void> {
    try {
      await backend.kill(entry.info.id, entry.info.launch);
    } catch (cause) {
      throw new CoreError("backend_unavailable", `Session ${entry.info.id} could not be ended`, {
        cause,
        sessionId: entry.info.id,
      });
    }
  }

  private bindPty(entry: SessionEntry, pty: PtyHandle): void {
    entry.pty = pty;
    entry.ptySubscriptions = [
      pty.onData((data) => {
        if (entry.pty !== pty) return;
        entry.output.append(data);
        for (const collector of entry.attachCollectors) collector.push(data.slice());
        this.outputListeners.emit({ sessionId: entry.info.id, data, viewIds: [...entry.views] });
      }),
      pty.onExit(({ exitCode }) => {
        if (entry.pty !== pty) return;
        this.releasePty(entry);
        if (exitCode !== undefined) entry.info.lastExitCode = exitCode;
        // kill/archive set the final state themselves; remember the end in case they fail.
        if (entry.busy === "kill" || entry.busy === "archive") {
          entry.endedDuringOp = exitCode === undefined ? {} : { exitCode };
          return;
        }
        // Without an exit code the backend cannot tell what ended (backend/types.ts): if only the client was
        // lost (tmux detach), the session lives on and gets a new PTY.
        if (exitCode === undefined) void this.reattach(entry);
        else this.setState(entry, "Exited");
      }),
    ];
  }

  /**
   * Re-attaches a session whose PTY ended without exit code: `exists` → `attach`, up to one attempt per entry
   * of `reattachDelaysMs`. State, views and writer stay meanwhile; the session is busy. A PTY that is lost
   * again within `REATTACH_STABLE_MS` uses the same attempts. Ends `Interrupted` when the backend session is
   * gone or every attempt failed.
   */
  private async reattach(entry: SessionEntry): Promise<void> {
    const { info } = entry;
    const backend = this.backendFor(info.launch);
    const budget = entry.reattach;
    if (this.now().getTime() - budget.boundAt > REATTACH_STABLE_MS) budget.attempts = 0;
    entry.busy = "reattach";
    let pty: PtyHandle | undefined;
    let size: TerminalSize = { ...info.size };
    while (backend && !pty && budget.attempts < this.reattachDelaysMs.length) {
      const wait = this.reattachDelaysMs[budget.attempts] ?? 0;
      budget.attempts += 1;
      if (wait > 0) await this.delay(wait);
      if (this.disposed) return;
      let exists: boolean;
      try {
        exists = await backend.exists(info.id, info.launch);
      } catch {
        continue;
      }
      if (this.disposed) return;
      if (!exists) break;
      try {
        size = { ...info.size };
        pty = await backend.attach(info.id, info.launch, size);
      } catch {
        continue;
      }
    }
    if (this.disposed) {
      pty?.dispose();
      return;
    }
    entry.busy = undefined;
    if (!pty) {
      this.setState(entry, "Interrupted");
      return;
    }
    budget.boundAt = this.now().getTime();
    this.bindPty(entry, pty);
    // The writer may have resized and views may have come or gone while the client was away.
    if (info.size.cols !== size.cols || info.size.rows !== size.rows) pty.resize(info.size);
    if (entry.views.size > 0 && info.state === "Detached") this.setState(entry, "Running");
    else if (entry.views.size === 0 && info.state === "Running") this.setState(entry, "Detached");
  }

  /** A timer that `dispose()` cancels; the waiting operation then never continues. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
    });
  }

  private releasePty(entry: SessionEntry): void {
    const pty = entry.pty;
    for (const subscription of entry.ptySubscriptions) subscription.dispose();
    entry.ptySubscriptions = [];
    entry.pty = undefined;
    pty?.dispose();
  }

  private setState(entry: SessionEntry, to: SessionState): void {
    const from = entry.info.state;
    entry.info.state = transition(from, to);
    entry.info.updatedAt = this.now().toISOString();
    this.persist(entry);
    this.stateListeners.emit({ sessionId: entry.info.id, from, to, session: snapshotInfo(entry.info) });
  }

  /** Reconciles one loaded live session and stores its new state; see `restore`. */
  private async reconcile(
    entry: SessionEntry,
    isAvailable: (backend: Backend) => Promise<boolean>,
    unavailable: Set<BackendKind>,
  ): Promise<SessionState> {
    const { info } = entry;
    const settle = (state: SessionState): SessionState => {
      info.state = state;
      info.updatedAt = this.now().toISOString();
      this.persist(entry);
      return state;
    };
    // ConPTY shells end with the Core that owned them (ADR 0005).
    if (info.launch.backend === "windows") return settle("Interrupted");
    const backend = this.backendFor(info.launch);
    if (!backend || !(await isAvailable(backend))) {
      unavailable.add(info.launch.backend);
      return settle("Interrupted");
    }
    let exists: boolean;
    try {
      exists = await backend.exists(info.id, info.launch);
    } catch {
      unavailable.add(info.launch.backend);
      return settle("Interrupted");
    }
    if (!exists) return settle("Interrupted");
    let pty: PtyHandle;
    try {
      pty = await backend.attach(info.id, info.launch, { ...info.size });
    } catch {
      return settle("Interrupted");
    }
    if (this.disposed) {
      pty.dispose();
      return info.state;
    }
    // Bound and settled in one synchronous step, so no PTY end falls in between.
    this.bindPty(entry, pty);
    return settle("Detached");
  }

  /** Writes the session through to the repository; the writer is runtime state and not stored. */
  private persist(entry: SessionEntry): void {
    if (!this.repository) return;
    try {
      this.repository.save(entry.info);
    } catch (error) {
      // The in-memory state stays authoritative and is still reported; a throw here would also escape
      // into the backend's event emitter when called from the PTY exit handler.
      this.onPersistError(error, snapshotInfo(entry.info));
    }
  }
}

function newEntry(info: SessionInfo): SessionEntry {
  return {
    info,
    pty: undefined,
    ptySubscriptions: [],
    views: new Set(),
    output: new OutputBuffer(OUTPUT_BUFFER_BYTES),
    attachCollectors: new Set(),
    busy: undefined,
    endedDuringOp: undefined,
    reattach: { attempts: 0, boundAt: Number.NEGATIVE_INFINITY },
  };
}

function assertSize(size: TerminalSize): void {
  const valid = (n: number) => Number.isInteger(n) && n > 0;
  if (!valid(size.cols) || !valid(size.rows)) {
    throw new CoreError("bad_request", `Invalid terminal size ${size.cols}x${size.rows}`);
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function snapshotInfo(info: SessionInfo): SessionInfo {
  return { ...info, size: { ...info.size } };
}
