// Keeps a WSL distro (and its tmux server) running while the backend knows sessions in it (ADR 0003).

/** A running `wsl.exe -d <distro> --exec sleep infinity` without PTY. */
export interface KeepaliveProcess {
  kill(): void;
  /** Called once when the process ends, also after `kill()`. */
  onExit(listener: () => void): void;
}

export type KeepaliveSpawner = (distro: string) => KeepaliveProcess;

interface Entry {
  sessions: Set<string>;
  process: KeepaliveProcess | undefined;
  restartTimer: ReturnType<typeof setTimeout> | undefined;
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
}

/** One keepalive process per distro with at least one known session; restarted if it dies unexpectedly. */
export class DistroKeepalive {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  private readonly maxDelayMs: number;
  private readonly stableMs: number;
  private readonly now: () => number;

  constructor(
    private readonly spawn: KeepaliveSpawner,
    private readonly restartDelayMs = 1000,
    options: KeepaliveOptions = {},
  ) {
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    this.stableMs = options.stableMs ?? 30_000;
    this.now = options.now ?? Date.now;
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
        delayMs: this.restartDelayMs,
        startedAt: 0,
      };
      this.entries.set(distro, entry);
    }
    entry.sessions.add(session);
    if (!entry.process && !entry.restartTimer) this.launch(distro, entry);
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

  /** Stops all keepalives (tmux sessions are left alone); later `retain` calls do nothing. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) this.stop(entry);
    this.entries.clear();
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
