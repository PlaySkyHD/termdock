// Session Registry: identities, lifecycle, views and input lock of all sessions in the Core (ADR 0003, ADR 0005).
import { randomUUID } from "node:crypto";
import type {
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
}

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
  busy: "start" | "kill" | "archive" | undefined;
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
  private readonly stateListeners = new ListenerSet<StateChangeEvent>();
  private readonly writerListeners = new ListenerSet<WriterChangedEvent>();
  private readonly resizedListeners = new ListenerSet<ResizedEvent>();
  private readonly outputListeners = new ListenerSet<OutputEvent>();

  constructor(options: SessionRegistryOptions) {
    this.backends = options.backends;
    this.now = options.now ?? (() => new Date());
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

  /** Registers a new session in `Starting` and starts its process. */
  async create(input: CreateSessionInput): Promise<SessionInfo> {
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
    const entry: SessionEntry = {
      info,
      pty: undefined,
      ptySubscriptions: [],
      views: new Set(),
      output: new OutputBuffer(OUTPUT_BUFFER_BYTES),
      attachCollectors: new Set(),
      busy: undefined,
    };
    this.sessions.set(info.id, entry);
    await this.launch(entry, false);
    return snapshotInfo(entry.info);
  }

  /**
   * Starts an `Exited` or `Interrupted` session again under the same id. Re-attaches when the backend
   * session still exists, so no second process is started. Views and writer stay.
   */
  async restart(sessionId: SessionId): Promise<SessionInfo> {
    const entry = this.entry(sessionId);
    this.assertIdle(entry);
    this.setState(entry, "Starting");
    entry.output.clear();
    await this.launch(entry, true);
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
    entry.busy = "kill";
    try {
      await this.terminate(entry);
    } finally {
      entry.busy = undefined;
    }
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
    entry.busy = "archive";
    try {
      if (entry.pty) {
        await this.terminate(entry);
      } else if (entry.info.state === "Interrupted") {
        const backend = this.backendFor(entry.info.launch);
        if (backend && (await backend.exists(entry.info.id, entry.info.launch))) {
          await this.killBackend(entry, backend);
        }
      }
    } finally {
      entry.busy = undefined;
    }
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
      } finally {
        entry.attachCollectors.delete(inFlight);
      }
      // The session may have changed while the backend answered.
      this.assertAttachable(entry, viewId);
      if (entry.pty !== pty) snapshot = undefined;
      else if (snapshot) snapshot = { ...snapshot, data: concat([snapshot.data, ...inFlight]) };
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
    this.resizedListeners.emit({ sessionId, size: { ...entry.info.size }, viewIds: [...entry.views] });
  }

  private entry(sessionId: SessionId): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new CoreError("not_found", `Unknown session ${sessionId}`);
    return entry;
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
  private async launch(entry: SessionEntry, reuseExisting: boolean): Promise<void> {
    const { info } = entry;
    const backend = this.backendFor(info.launch);
    let pty: PtyHandle;
    entry.busy = "start";
    try {
      if (!backend) throw new Error(`No backend for kind ${info.launch.backend}`);
      const reuse = reuseExisting && (await backend.exists(info.id, info.launch));
      pty = reuse
        ? await backend.attach(info.id, info.launch, info.size)
        : await backend.start(info.id, info.launch, info.size);
    } catch (cause) {
      entry.busy = undefined;
      this.setState(entry, "Interrupted");
      throw new CoreError("backend_unavailable", `Session ${info.id} could not be started`, { cause });
    }
    entry.busy = undefined;
    this.bindPty(entry, pty);
    this.setState(entry, "Running");
    // ADR 0005 has no Starting → Detached; without a view the session passes through Running.
    if (entry.views.size === 0) this.setState(entry, "Detached");
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
      throw new CoreError("backend_unavailable", `Session ${entry.info.id} could not be ended`, { cause });
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
        // kill/archive set the final state themselves.
        if (entry.busy === "kill" || entry.busy === "archive") return;
        // Without an exit code the process or tmux client was lost unexpectedly (backend/types.ts).
        this.setState(entry, exitCode === undefined ? "Interrupted" : "Exited");
      }),
    ];
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
    this.stateListeners.emit({ sessionId: entry.info.id, from, to, session: snapshotInfo(entry.info) });
  }
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
