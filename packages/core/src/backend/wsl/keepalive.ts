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
}

/** One keepalive process per distro with at least one known session; restarted if it dies unexpectedly. */
export class DistroKeepalive {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor(
    private readonly spawn: KeepaliveSpawner,
    private readonly restartDelayMs = 1000,
  ) {}

  /** Marks `session` as known in `distro`; starts the keepalive for the first one. */
  retain(distro: string, session: string): void {
    if (this.disposed) return;
    let entry = this.entries.get(distro);
    if (!entry) {
      entry = { sessions: new Set(), process: undefined, restartTimer: undefined };
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
      this.scheduleRestart(distro, entry);
    });
  }

  private scheduleRestart(distro: string, entry: Entry): void {
    if (this.disposed || this.entries.get(distro) !== entry || entry.sessions.size === 0) return;
    entry.restartTimer = setTimeout(() => this.launch(distro, entry), this.restartDelayMs);
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
