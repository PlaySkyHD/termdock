// In-memory Backend for tests (ADR 0003). Exported so that other packages can use it too.
import type { BackendKind, LaunchSpec, SessionId, TerminalSize } from "@termdock/protocol";
import type { Backend, Disposable, PtyHandle, TerminalSnapshot } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : data;
}

/** PTY whose output and end are driven by the test. */
export class FakePty implements PtyHandle {
  readonly writes: Uint8Array[] = [];
  readonly resizes: TerminalSize[] = [];
  size: TerminalSize;
  disposed = false;
  ended = false;
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(event: { exitCode?: number }) => void>();

  constructor(
    readonly sessionId: SessionId,
    size: TerminalSize,
    private readonly onEnd: () => void = () => {},
  ) {
    this.size = size;
  }

  /** Everything written to the PTY, decoded as UTF-8. */
  get input(): string {
    return this.writes.map((chunk) => decoder.decode(chunk)).join("");
  }

  write(data: Uint8Array | string): void {
    if (this.ended || this.disposed) throw new Error("FakePty: write after end");
    this.writes.push(toBytes(data));
  }

  resize(size: TerminalSize): void {
    if (this.ended || this.disposed) throw new Error("FakePty: resize after end");
    this.size = size;
    this.resizes.push(size);
  }

  onData(listener: (data: Uint8Array) => void): Disposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode?: number }) => void): Disposable {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  dispose(): void {
    this.disposed = true;
    this.dataListeners.clear();
    this.exitListeners.clear();
  }

  /** Test control: the process prints `data`. */
  emitData(data: Uint8Array | string): void {
    const bytes = toBytes(data);
    for (const listener of [...this.dataListeners]) listener(bytes);
  }

  /** Test control: the PTY ends. Without `exitCode` the end counts as unexpected (lost process or tmux client). */
  emitExit(exitCode?: number): void {
    if (this.ended) return;
    this.ended = true;
    this.onEnd();
    const event = exitCode === undefined ? {} : { exitCode };
    for (const listener of [...this.exitListeners]) listener(event);
  }
}

export interface FakeBackendCall {
  id: SessionId;
  spec: LaunchSpec;
  size: TerminalSize;
}

export interface FakeBackendOptions {
  kind?: BackendKind;
  /** Exit code the PTY reports when the session is killed; undefined by default. */
  killExitCode?: number;
}

export class FakeBackend implements Backend {
  readonly kind: BackendKind;
  isAvailable = true;
  /** When set, the next `start` or `attach` rejects with this error. */
  failNextStart: Error | undefined;
  readonly starts: FakeBackendCall[] = [];
  readonly attaches: FakeBackendCall[] = [];
  readonly kills: SessionId[] = [];
  private readonly ptys = new Map<SessionId, FakePty[]>();
  private readonly alive = new Set<SessionId>();
  private readonly existsOverride = new Map<SessionId, boolean>();
  private readonly snapshots = new Map<SessionId, TerminalSnapshot>();
  private readonly killExitCode: number | undefined;

  constructor(options: FakeBackendOptions = {}) {
    this.kind = options.kind ?? "wsl";
    this.killExitCode = options.killExitCode;
  }

  /** Latest PTY of a session. Throws when none was created. */
  pty(id: SessionId): FakePty {
    const pty = this.ptys.get(id)?.at(-1);
    if (!pty) throw new Error(`FakeBackend: no PTY for session ${id}`);
    return pty;
  }

  /** All PTYs ever created for a session, oldest first. */
  allPtys(id: SessionId): readonly FakePty[] {
    return this.ptys.get(id) ?? [];
  }

  /** Test control: overrides what `exists` reports for a session. */
  setExists(id: SessionId, exists: boolean): void {
    this.existsOverride.set(id, exists);
  }

  /** Test control: screen content `snapshot` returns for a session. */
  setSnapshot(id: SessionId, snapshot: TerminalSnapshot | string): void {
    this.snapshots.set(id, typeof snapshot === "string" ? { data: encoder.encode(snapshot) } : snapshot);
  }

  async available(): Promise<boolean> {
    return this.isAvailable;
  }

  async start(id: SessionId, spec: LaunchSpec, size: TerminalSize): Promise<PtyHandle> {
    this.starts.push({ id, spec, size });
    return this.open(id, size);
  }

  async attach(id: SessionId, spec: LaunchSpec, size: TerminalSize): Promise<PtyHandle> {
    this.attaches.push({ id, spec, size });
    return this.open(id, size);
  }

  async exists(id: SessionId, _spec: LaunchSpec): Promise<boolean> {
    return this.existsOverride.get(id) ?? this.alive.has(id);
  }

  async kill(id: SessionId, _spec: LaunchSpec): Promise<void> {
    this.kills.push(id);
    this.existsOverride.delete(id);
    const pty = this.ptys.get(id)?.at(-1);
    if (pty && !pty.ended && !pty.disposed) pty.emitExit(this.killExitCode);
    this.alive.delete(id);
  }

  async snapshot(id: SessionId, _spec: LaunchSpec): Promise<TerminalSnapshot | undefined> {
    return this.snapshots.get(id);
  }

  private open(id: SessionId, size: TerminalSize): FakePty {
    const error = this.failNextStart;
    if (error) {
      this.failNextStart = undefined;
      throw error;
    }
    const pty = new FakePty(id, size, () => this.alive.delete(id));
    const list = this.ptys.get(id) ?? [];
    list.push(pty);
    this.ptys.set(id, list);
    this.alive.add(id);
    this.existsOverride.delete(id);
    return pty;
  }
}
