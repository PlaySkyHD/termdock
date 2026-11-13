// WSL backend: sessions are tmux sessions on an own socket, driven through wsl.exe (ADR 0003).
import type { BackendKind, LaunchSpec, SessionId, TerminalSize } from "@termdock/protocol";
import type { Backend, PtyHandle, TerminalSnapshot } from "../types.js";
import {
  attachArgs,
  hasSessionArgs,
  isMissingSession,
  killSessionArgs,
  listClientsArgs,
  listDistrosArgs,
  parseClientTtys,
  parseDistroList,
  parsePaneStatus,
  parseSnapshot,
  paneStatusArgs,
  refreshClientArgs,
  sessionName,
  snapshotArgs,
  startArgs,
  versionArgs,
  type PaneStatus,
  type RunResult,
  type TmuxTarget,
} from "./commands.js";
import { DistroKeepalive, type KeepaliveSpawner } from "./keepalive.js";
import { WslPty, type PtyProcess } from "./pty.js";
import { runWsl, spawnKeepalive, spawnPty } from "./processes.js";

/** Runs `wsl.exe <args>` without PTY (with `WSL_UTF8=1`); never rejects. */
export type WslRunner = (args: readonly string[], options: { timeoutMs: number }) => Promise<RunResult>;

/** Starts `wsl.exe <args>` in a PTY. */
export type PtySpawner = (args: readonly string[], size: TerminalSize) => PtyProcess | Promise<PtyProcess>;

export interface WslBackendOptions {
  /** tmux socket (`tmux -L`); production `termdock`, tests `termdock-test`. */
  socket?: string;
  /** Distro for specs without `distro`; defaults to the WSL default distro. */
  distro?: string;
  /** Timeout of each wsl.exe call without PTY; covers a cold distro start (about 4 s). */
  commandTimeoutMs?: number;
  /** How long `kill` waits for the session to disappear. */
  killTimeoutMs?: number;
  /** Delay before a dead keepalive is restarted. */
  keepaliveRestartDelayMs?: number;
  run?: WslRunner;
  spawnPty?: PtySpawner;
  spawnKeepalive?: KeepaliveSpawner;
}

export const DEFAULT_TMUX_SOCKET = "termdock";
const KILL_POLL_MS = 100;

type SessionStatus = PaneStatus | "missing";

export class WslBackend implements Backend {
  readonly kind: BackendKind = "wsl";
  private readonly socket: string;
  private readonly distro: string | undefined;
  private readonly commandTimeoutMs: number;
  private readonly killTimeoutMs: number;
  private readonly run: WslRunner;
  private readonly spawnPty: PtySpawner;
  private readonly keepalive: DistroKeepalive;
  private defaultDistro: Promise<string> | undefined;

  constructor(options: WslBackendOptions = {}) {
    this.socket = options.socket ?? DEFAULT_TMUX_SOCKET;
    this.distro = options.distro;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
    this.killTimeoutMs = options.killTimeoutMs ?? 5_000;
    this.run = options.run ?? runWsl;
    this.spawnPty = options.spawnPty ?? spawnPty;
    this.keepalive = new DistroKeepalive(
      options.spawnKeepalive ?? spawnKeepalive,
      options.keepaliveRestartDelayMs ?? 1_000,
    );
  }

  /** Distros known to WSL and the default one (`wsl.exe -l -v`). */
  async distros(): Promise<{ names: string[]; defaultDistro: string | undefined }> {
    const result = await this.exec(listDistrosArgs());
    if (result.code !== 0) throw wslError("wsl.exe -l -v", result);
    return parseDistroList(result.stdout);
  }

  async available(): Promise<boolean> {
    try {
      const distro = await this.resolveDistro(undefined);
      const result = await this.exec(versionArgs(distro));
      return result.code === 0 && /^tmux /.test(result.stdout);
    } catch {
      return false;
    }
  }

  /** Pins the distro: configured, else the WSL default. Rejects when WSL lists no distro. */
  async resolveLaunch(spec: LaunchSpec): Promise<LaunchSpec> {
    if (spec.distro !== undefined) return spec;
    return { ...spec, distro: await this.resolveDistro(undefined) };
  }

  async start(id: SessionId, spec: LaunchSpec, size: TerminalSize): Promise<PtyHandle> {
    const target = await this.target(spec);
    const args = startArgs(target, id, spec);
    const before = await this.status(target, id);
    // `new-session -A` would join a leftover whose program already ended (remain-on-exit).
    if (before !== "missing" && before.dead) await this.exec(killSessionArgs(target, id));
    const alive = before !== "missing" && !before.dead;
    return this.open(target, id, args, size, !alive);
  }

  async attach(id: SessionId, spec: LaunchSpec, size: TerminalSize): Promise<PtyHandle> {
    const target = await this.target(spec);
    return this.open(target, id, attachArgs(target, id), size, false);
  }

  async exists(id: SessionId, spec: LaunchSpec): Promise<boolean> {
    const target = await this.target(spec);
    const status = await this.status(target, id);
    const alive = status !== "missing" && !status.dead;
    if (alive) this.keepalive.retain(target.distro, sessionName(id));
    else this.keepalive.release(target.distro, sessionName(id));
    return alive;
  }

  async kill(id: SessionId, spec: LaunchSpec): Promise<void> {
    const target = await this.target(spec);
    const result = await this.exec(killSessionArgs(target, id));
    if (result.code !== 0 && !isMissingSession(result)) throw wslError("tmux kill-session", result);
    const deadline = Date.now() + this.killTimeoutMs;
    for (;;) {
      const check = await this.exec(hasSessionArgs(target, id));
      if (isMissingSession(check)) break;
      if (check.code !== 0) throw wslError("tmux has-session", check);
      if (Date.now() >= deadline) throw new Error(`tmux session ${sessionName(id)} still exists after kill`);
      await delay(KILL_POLL_MS);
    }
    this.keepalive.release(target.distro, sessionName(id));
  }

  async snapshot(id: SessionId, spec: LaunchSpec): Promise<TerminalSnapshot | undefined> {
    const target = await this.target(spec);
    const result = await this.exec(snapshotArgs(target, id));
    // No tmux screen left; the Registry falls back to its own buffer.
    if (isMissingSession(result)) return undefined;
    if (result.code !== 0) throw wslError("tmux capture-pane", result);
    return parseSnapshot(result.stdout);
  }

  /** Lets every tmux client of the session paint its whole screen again (issue #34). */
  async redraw(id: SessionId, spec: LaunchSpec): Promise<void> {
    const target = await this.target(spec);
    const clients = await this.exec(listClientsArgs(target, id));
    if (clients.code !== 0) throw wslError("tmux list-clients", clients);
    for (const tty of parseClientTtys(clients.stdout)) {
      const result = await this.exec(refreshClientArgs(target, tty));
      if (result.code !== 0) throw wslError("tmux refresh-client", result);
    }
  }

  /** Stops all keepalive processes; tmux sessions keep running (until WSL stops the distro). */
  dispose(): void {
    this.keepalive.dispose();
  }

  private async open(
    target: TmuxTarget,
    id: SessionId,
    args: string[],
    size: TerminalSize,
    releaseOnFailure: boolean,
  ): Promise<PtyHandle> {
    const name = sessionName(id);
    this.keepalive.retain(target.distro, name);
    let process: PtyProcess;
    try {
      process = await this.spawnPty(args, size);
    } catch (error) {
      if (releaseOnFailure) this.keepalive.release(target.distro, name);
      throw error;
    }
    return new WslPty(process, () => this.resolveEnd(target, id));
  }

  /**
   * Decides what the end of a tmux client means: dead pane → program ended (exit code, session removed);
   * missing session → ended without known code; live pane or unknown → only the client was lost.
   */
  private async resolveEnd(target: TmuxTarget, id: SessionId): Promise<{ exitCode?: number }> {
    const name = sessionName(id);
    let status: SessionStatus;
    try {
      status = await this.status(target, id);
    } catch (error) {
      // State unknown: the session stays, but this client no longer justifies a keepalive that restarts forever.
      this.keepalive.release(target.distro, name);
      throw error;
    }
    if (status === "missing") {
      this.keepalive.release(target.distro, name);
      return {};
    }
    if (!status.dead) return {};
    await this.exec(killSessionArgs(target, id));
    this.keepalive.release(target.distro, name);
    return status.exitCode === undefined ? {} : { exitCode: status.exitCode };
  }

  private async status(target: TmuxTarget, id: SessionId): Promise<SessionStatus> {
    const result = await this.exec(paneStatusArgs(target, id));
    if (isMissingSession(result)) return "missing";
    if (result.code !== 0) throw wslError("tmux display-message", result);
    return parsePaneStatus(result.stdout);
  }

  private async target(spec: LaunchSpec): Promise<TmuxTarget> {
    return { distro: await this.resolveDistro(spec.distro), socket: this.socket };
  }

  private resolveDistro(distro: string | undefined): Promise<string> {
    const chosen = distro ?? this.distro;
    if (chosen !== undefined) return Promise.resolve(chosen);
    if (this.defaultDistro) return this.defaultDistro;
    const lookup = this.distros().then(({ defaultDistro }) => {
      if (defaultDistro === undefined) throw new Error("WSL has no distribution installed");
      return defaultDistro;
    });
    this.defaultDistro = lookup;
    // A failed lookup is retried on the next call.
    lookup.catch(() => {
      if (this.defaultDistro === lookup) this.defaultDistro = undefined;
    });
    return lookup;
  }

  private exec(args: readonly string[]): Promise<RunResult> {
    return this.run(args, { timeoutMs: this.commandTimeoutMs });
  }
}

function wslError(what: string, result: RunResult): Error {
  const reason = result.timedOut ? "timed out" : `exit ${result.code ?? "?"}`;
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(`${what} failed (${reason})${detail ? `: ${detail}` : ""}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
