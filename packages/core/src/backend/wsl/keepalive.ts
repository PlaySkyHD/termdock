// Keeps a WSL distro (and its tmux server) running while the backend knows sessions in it (ADR 0003).

/** A running keepalive without PTY (`keepaliveArgs`), detached from the core. */
export interface KeepaliveProcess {
  kill(): void;
  /** Called once when the process ends, also after `kill()`. */
  onExit(listener: () => void): void;
}

export type KeepaliveSpawner = (distro: string) => KeepaliveProcess;

/** Ends keepalives of `distro` that an earlier core left behind (issue #140). Its outcome is not used. */
export type KeepaliveTakeOver = (distro: string) => Promise<unknown>;

interface Entry {
  sessions: Set<string>;
  process: KeepaliveProcess | undefined;
  restartTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set while the left-behind keepalives of the distro are being ended; the first launch waits for it. */
  takingOver: boolean;
  /** Delay before the next restart; doubles per quick death, reset after a stable run. */
  delayMs: number;
  startedAt: number;
}

export interface KeepaliveOptions {
  /** Upper bound of the restart delay. Default 60 s. */
  maxDelayMs?: number;
  /** A process that ran at least this long resets the delay. Default 30 s. */
  stableMs?: number;
  now?: () => number;
  /** Runs once per distro before its first keepalive starts; a rejection does not stop the start. */
  takeOver?: KeepaliveTakeOver;
}

/**
 * One keepalive process per distro with at least one known session; restarted if it dies unexpectedly. Before the
 * first one of a distro starts, `takeOver` ends those an earlier core left behind, so never two run at once.
 */
export class DistroKeepalive {
  private readonly entries = new Map<string, Entry>();
  /** Per distro the take-over of left-behind keepalives this instance started; `done` once it settled. */
  private readonly takeOvers = new Map<string, { done: boolean; promise: Promise<void> }>();
  private disposed = false;

  private readonly maxDelayMs: number;
  private readonly stableMs: number;
  private readonly now: () => number;
  private readonly takeOver: KeepaliveTakeOver | undefined;

  constructor(
    private readonly spawn: KeepaliveSpawner,
    private readonly restartDelayMs = 1000,
    options: KeepaliveOptions = {},
  ) {
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    this.stableMs = options.stableMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.takeOver = options.takeOver;
  }

  /** Marks `session` as known in `distro`; starts the keepalive for the first one. */
  retain(distro: string, session: string): void {
    if (this.disposed) return;
    let entry = this.entries.get(distro);
    if (!entry) {
      entry = {
        sessions: new Set(),
        process: undefined,
        restartTimer: undefined,
        takingOver: false,
        delayMs: this.restartDelayMs,
        startedAt: 0,
      };
      this.entries.set(distro, entry);
    }
    entry.sessions.add(session);
    if (!entry.process && !entry.restartTimer && !entry.takingOver) this.begin(distro, entry);
  }

  /** Forgets `session`; stops the keepalive after the last session of the distro. */
  release(distro: string, session: string): void {
    const entry = this.entries.get(distro);
    if (!entry || !entry.sessions.delete(session) || entry.sessions.size > 0) return;
    this.entries.delete(distro);
    this.stop(entry);
  }

  isRunning(distro: string): boolean {
    return this.entries.get(distro)?.process !== undefined;
  }

  /**
   * Hands the keepalives over (issue #140): running ones keep running, so the tmux sessions survive until the next
   * core takes them over or the tmux server ends; nothing is started or restarted any more.
   */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      if (entry.restartTimer) clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
      entry.process = undefined;
    }
    this.entries.clear();
  }

  /** First launch for `entry`: once per distro, after the left-behind keepalives were ended. */
  private begin(distro: string, entry: Entry): void {
    const takeOver = this.takeOverOnce(distro);
    if (!takeOver) {
      this.launch(distro, entry);
      return;
    }
    entry.takingOver = true;
    void takeOver.then(() => {
      entry.takingOver = false;
      // Released or disposed meanwhile: nothing to start for this entry.
      if (this.disposed || this.entries.get(distro) !== entry || entry.sessions.size === 0) return;
      this.launch(distro, entry);
    });
  }

  /**
   * The take-over of `distro`, started on the first call; undefined once it is done (or without `takeOver`). An
   * entry created while it still runs (release and retain meanwhile) waits for the same one, so the take-over never
   * ends a keepalive of this instance.
   */
  private takeOverOnce(distro: string): Promise<void> | undefined {
    if (!this.takeOver) return undefined;
    const known = this.takeOvers.get(distro);
    if (known) return known.done ? undefined : known.promise;
    let promise: Promise<unknown>;
    try {
      promise = this.takeOver(distro);
    } catch {
      promise = Promise.resolve();
    }
    const state = {
      done: false,
      promise: promise.then(
        () => {},
        () => {},
      ),
    };
    void state.promise.then(() => (state.done = true));
    this.takeOvers.set(distro, state);
    return state.promise;
  }

  private launch(distro: string, entry: Entry): void {
    entry.restartTimer = undefined;
    entry.startedAt = this.now();
    let process: KeepaliveProcess;
    try {
      process = this.spawn(distro);
    } catch {
      this.scheduleRestart(distro, entry);
      return;
    }
    entry.process = process;
    process.onExit(() => {
      if (entry.process !== process) return;
      entry.process = undefined;
      if (this.now() - entry.startedAt >= this.stableMs) entry.delayMs = this.restartDelayMs;
      this.scheduleRestart(distro, entry);
    });
  }

  private scheduleRestart(distro: string, entry: Entry): void {
    if (this.disposed || this.entries.get(distro) !== entry || entry.sessions.size === 0) return;
    const delay = entry.delayMs;
    entry.delayMs = Math.min(delay * 2, this.maxDelayMs);
    entry.restartTimer = setTimeout(() => this.launch(distro, entry), delay);
    entry.restartTimer.unref?.();
  }

  private stop(entry: Entry): void {
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    entry.restartTimer = undefined;
    const process = entry.process;
    entry.process = undefined;
    process?.kill();
  }
}
