// WSL backend: sessions are tmux sessions on an own socket, driven through wsl.exe (ADR 0003).
import { MAX_NAME_LENGTH } from "@termdock/protocol";
import type { BackendKind, LaunchSpec, SessionId, SessionWarning, TerminalSize } from "@termdock/protocol";
import type { Backend, PtyHandle, TerminalSnapshot } from "../types.js";
import {
  attachArgs,
  checksCwd,
  currentCwdArgs,
  cwdCheckArgs,
  endKeepalivesArgs,
  hasSessionArgs,
  isGoneAfterKill,
  isMissingSession,
  killSessionArgs,
  listClientsArgs,
  listDistrosArgs,
  listSessionsArgs,
  parseClientTtys,
  parseCurrentCwd,
  parseCwdCheck,
  parseDistroList,
  parseLiveSessions,
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
import { ConptyPty, type PtyProcess } from "../conpty/pty.js";
import { pendingPtyCloses, PTYS_CLOSED_TIMEOUT_MS, ptysClosed } from "../conpty/spawn.js";
import { DistroKeepalive, type KeepaliveSpawner } from "./keepalive.js";
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
  /** Longest wait for the check of the working directory at the start; a slower check gives no warning. */
  cwdCheckTimeoutMs?: number;
  /** How long the start still waits for that check once its status call is done (issue #113); then no warning. */
  cwdCheckGraceMs?: number;
  /** Longest wait for `currentCwd` (issue #199); a slower answer counts as unknown. Defaults to 5 s. */
  cwdQueryTimeoutMs?: number;
  run?: WslRunner;
  spawnPty?: PtySpawner;
  spawnKeepalive?: KeepaliveSpawner;
  /**
   * Resolves true once the closes of all PTYs are done, false when its wait gave up (#160); `dispose` waits for it.
   * Defaults to the ConPTY queue (`ptysClosed` in processes.ts, at most `PTYS_CLOSED_TIMEOUT_MS`).
   */
  ptysClosed?: () => Promise<boolean>;
  /** Closes still open, for the log line when `ptysClosed` gave up. Defaults to the ConPTY queue. */
  pendingPtyCloses?: () => number;
  /** One line per event worth a log entry; defaults to stderr. */
  log?: (line: string) => void;
}

export const DEFAULT_TMUX_SOCKET = "termdock";
const KILL_POLL_MS = 100;
/** Directory queries (`wsl.exe` processes) at the same time over all sessions of a backend (issue #199). */
export const MAX_CWD_QUERIES = 4;

type SessionStatus = PaneStatus | "missing";

export class WslBackend implements Backend {
  readonly kind: BackendKind = "wsl";
  private readonly socket: string;
  private readonly distro: string | undefined;
  private readonly commandTimeoutMs: number;
  private readonly killTimeoutMs: number;
  private readonly cwdCheckTimeoutMs: number;
  private readonly cwdCheckGraceMs: number;
  private readonly cwdQueryTimeoutMs: number;
  private readonly run: WslRunner;
  private readonly spawnPty: PtySpawner;
  private readonly keepalive: DistroKeepalive;
  private readonly ptysClosed: () => Promise<boolean>;
  private readonly pendingPtyCloses: () => number;
  private readonly log: (line: string) => void;
  private defaultDistro: Promise<string> | undefined;
  private disposed = false;
  /** Directory queries running now, and those waiting for a slot (`currentCwd`). */
  private cwdQueries = 0;
  private readonly cwdWaiting: (() => void)[] = [];

  constructor(options: WslBackendOptions = {}) {
    this.socket = options.socket ?? DEFAULT_TMUX_SOCKET;
    this.distro = options.distro;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
    this.killTimeoutMs = options.killTimeoutMs ?? 5_000;
    this.cwdCheckTimeoutMs = options.cwdCheckTimeoutMs ?? 5_000;
    this.cwdCheckGraceMs = options.cwdCheckGraceMs ?? 1_000;
    this.cwdQueryTimeoutMs = options.cwdQueryTimeoutMs ?? 5_000;
    this.run = options.run ?? runWsl;
    this.spawnPty = options.spawnPty ?? spawnPty;
    this.ptysClosed = options.ptysClosed ?? (() => ptysClosed());
    this.pendingPtyCloses = options.pendingPtyCloses ?? pendingPtyCloses;
    this.log = options.log ?? ((line) => void process.stderr.write(`termdock-core: ${line}\n`));
    const socket = this.socket;
    this.keepalive = new DistroKeepalive(
      options.spawnKeepalive ?? ((distro) => spawnKeepalive({ distro, socket })),
      options.keepaliveRestartDelayMs ?? 1_000,
      // A keepalive survives its core (issue #140); the next one ends it before starting its own.
      { takeOver: (distro) => this.exec(endKeepalivesArgs({ distro, socket })) },
    );
  }

  /**
   * Distros known to WSL and the default one (`wsl.exe -l -v`). `timeoutMs` replaces the command timeout, e.g. for
   * a client that waits for the answer (`wsl.distros`, #64). Rejects with the reason when the call fails.
   */
  async distros(
    options: { timeoutMs?: number } = {},
  ): Promise<{ names: string[]; defaultDistro: string | undefined }> {
    const result = await this.run(listDistrosArgs(), {
      timeoutMs: options.timeoutMs ?? this.commandTimeoutMs,
    });
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
    // The directory check runs alongside the status call the start needs anyway, so it costs no extra round trip.
    // `cwdWarnings` never rejects, so it may be left running.
    const check = this.cwdWarnings(target.distro, spec.cwd);
    const before = await this.status(target, id);
    // `new-session -A` would join a leftover whose program already ended (remain-on-exit).
    if (before !== "missing" && before.dead) await this.exec(killSessionArgs(target, id));
    const alive = before !== "missing" && !before.dead;
    // Joining a session that still runs uses its directory, not `cwd`: no need to wait for the check.
    // After the status call the check gets at most `cwdCheckGraceMs` more (a hung mount under /mnt must not hold
    // the start for the whole check timeout); later it gives no warning.
    const warnings = alive ? [] : await withinGrace(check, this.cwdCheckGraceMs);
    const pty = await this.open(target, id, args, size, !alive);
    if (warnings.length > 0) pty.warnings = warnings;
    return pty;
  }

  /**
   * `cwd_missing` when `cwd` is an absolute path that is no directory in `distro` (issue #113). wsl.exe then
   * reports `chdir(...) failed` and runs the program in `/`. Never rejects: a failed or slow check (WSL not
   * reachable) gives no warning, and the start goes on as before.
   */
  private async cwdWarnings(distro: string, cwd: string): Promise<SessionWarning[]> {
    if (!checksCwd(cwd)) return [];
    try {
      const result = await this.run(cwdCheckArgs(distro, cwd), { timeoutMs: this.cwdCheckTimeoutMs });
      if (parseCwdCheck(result) !== false) return [];
    } catch {
      return [];
    }
    const warning: SessionWarning = { code: "cwd_missing", path: cwd };
    if (isDistroName(distro)) warning.distro = distro;
    return [warning];
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

  /**
   * One `tmux list-sessions` per distro instead of one `exists` per session (issue #134). Keeps the keepalive
   * bookkeeping of `exists`: every session found alive is retained, every other one released; the take-over still
   * runs once per distro. Undefined, without touching the keepalive, when a distro cannot be resolved or a call
   * fails (WSL error, timeout): the caller then asks `exists` per session.
   */
  async listLive(
    sessions: readonly { id: SessionId; spec: LaunchSpec }[],
  ): Promise<ReadonlySet<SessionId> | undefined> {
    const groups = new Map<string, { target: TmuxTarget; members: { id: SessionId; name: string }[] }>();
    try {
      for (const { id, spec } of sessions) {
        const target = await this.target(spec);
        const group = groups.get(target.distro) ?? { target, members: [] };
        group.members.push({ id, name: sessionName(id) });
        groups.set(target.distro, group);
      }
    } catch {
      return undefined;
    }
    const listed = await Promise.all(
      [...groups.values()].map(async (group) => {
        const result = await this.exec(listSessionsArgs(group.target));
        // No server on the socket: no session of the distro is left.
        if (isMissingSession(result)) return { group, names: new Set<string>() };
        if (result.code !== 0) return undefined;
        return { group, names: parseLiveSessions(result.stdout) };
      }),
    );
    if (listed.some((entry) => entry === undefined)) return undefined;
    const live = new Set<SessionId>();
    for (const entry of listed) {
      if (!entry) continue;
      const { group, names } = entry;
      for (const { id, name } of group.members) {
        if (names.has(name)) {
          live.add(id);
          this.keepalive.retain(group.target.distro, name);
        } else {
          this.keepalive.release(group.target.distro, name);
        }
      }
    }
    return live;
  }

  async kill(id: SessionId, spec: LaunchSpec): Promise<void> {
    const target = await this.target(spec);
    const result = await this.exec(killSessionArgs(target, id));
    // `isGoneAfterKill`: a server without sessions that still waits for connected clients counts as gone (#199).
    if (result.code !== 0 && !isGoneAfterKill(result)) throw wslError("tmux kill-session", result);
    const deadline = Date.now() + this.killTimeoutMs;
    for (;;) {
      const check = await this.exec(hasSessionArgs(target, id));
      if (isGoneAfterKill(check)) break;
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

  /**
   * Lets every tmux client of the session paint its whole screen again (issue #34). Each client on its own: one
   * that left after `list-clients` does not keep the others (the Core's own) from it. Rejects when listing fails
   * or no client could be redrawn.
   */
  async redraw(id: SessionId, spec: LaunchSpec): Promise<void> {
    const target = await this.target(spec);
    const clients = await this.exec(listClientsArgs(target, id));
    if (clients.code !== 0) throw wslError("tmux list-clients", clients);
    const results = await Promise.all(
      parseClientTtys(clients.stdout).map((tty) => this.exec(refreshClientArgs(target, tty))),
    );
    const failed = results.find((result) => result.code !== 0);
    if (failed && results.every((result) => result.code !== 0)) throw wslError("tmux refresh-client", failed);
  }

  /**
   * The directory of the session's pane from tmux (issue #199), at most `cwdQueryTimeoutMs`. Never rejects: a failed
   * or slow call, a missing session and an unusable answer give undefined, a removed directory `null`
   * (`parseCurrentCwd`). At most `MAX_CWD_QUERIES` run at once over all sessions; the others wait for a slot.
   */
  async currentCwd(id: SessionId, spec: LaunchSpec): Promise<string | null | undefined> {
    await this.cwdSlot();
    try {
      const target = await this.target(spec);
      return parseCurrentCwd(
        await this.run(currentCwdArgs(target, id), { timeoutMs: this.cwdQueryTimeoutMs }),
      );
    } catch {
      return undefined;
    } finally {
      this.releaseCwdSlot();
    }
  }

  /** Waits until fewer than `MAX_CWD_QUERIES` directory queries run, then takes a slot. */
  private cwdSlot(): Promise<void> {
    if (this.cwdQueries < MAX_CWD_QUERIES) {
      this.cwdQueries += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.cwdWaiting.push(resolve));
  }

  /** Hands the slot to the next waiting query, or frees it. */
  private releaseCwdSlot(): void {
    const next = this.cwdWaiting.shift();
    if (next) next();
    else this.cwdQueries -= 1;
  }

  /**
   * Hands the keepalives over (issue #140): every distro with known sessions keeps one running after the core ends,
   * until the next core takes it over or the tmux server ends; none is started afterwards, and `start`/`attach` fail
   * before their PTY. Resolves once that is done: usually within about 3 s, at the latest after a running take-over
   * (`commandTimeoutMs`, 15 s) plus 3 s; the core exits only then. Meanwhile it waits for the PTYs the registry
   * released to end one after the other (#160, at most `PTYS_CLOSED_TIMEOUT_MS`, 15 s).
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([this.keepalive.dispose(), this.waitForPtys()]);
  }

  private async waitForPtys(): Promise<void> {
    if (await this.ptysClosed()) return;
    this.log(
      `${this.pendingPtyCloses()} PTY close(s) still open after ${PTYS_CLOSED_TIMEOUT_MS} ms; the core ends without them`,
    );
  }

  private async open(
    target: TmuxTarget,
    id: SessionId,
    args: string[],
    size: TerminalSize,
    releaseOnFailure: boolean,
  ): Promise<ConptyPty> {
    const name = sessionName(id);
    // A closed backend starts no tmux client any more: no keepalive would follow it (review PR #148).
    if (this.disposed) throw new Error("WSL backend is closed");
    // Known at once, so a `dispose` during `spawnPty` hands a keepalive over for it; started only after the PTY (its
    // wsl.exe keeps the distro awake meanwhile), because the keepalive is a tmux client and ends at once while
    // `new-session` has not created the server yet.
    this.keepalive.retain(target.distro, name, { deferStart: true });
    let process: PtyProcess;
    try {
      process = await this.spawnPty(args, size);
    } catch (error) {
      if (releaseOnFailure) this.keepalive.release(target.distro, name);
      else this.keepalive.start(target.distro);
      throw error;
    }
    this.keepalive.start(target.distro);
    // The exit code of the tmux client says nothing about the program in the pane; tmux decides.
    return new ConptyPty(process, () => this.resolveEnd(target, id));
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
  // wsl.exe without WSL ignores WSL_UTF8 and writes UTF-16: the NUL bytes would end up in logs and answers.
  const detail = (result.stderr.trim() || result.stdout.trim()).replace(/\0/g, "");
  return new Error(`${what} failed (${reason})${detail ? `: ${detail}` : ""}`);
}

/** A distro name the protocol accepts in a warning (like other names: 1 to 128 characters, not only spaces). */
function isDistroName(distro: string): boolean {
  return distro.trim() !== "" && distro.length <= MAX_NAME_LENGTH;
}

/** The warnings of `check`, or none when it takes longer than `ms`; the timer does not outlive the race. */
async function withinGrace(check: Promise<SessionWarning[]>, ms: number): Promise<SessionWarning[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<SessionWarning[]>((resolve) => {
    timer = setTimeout(() => resolve([]), ms);
  });
  try {
    return await Promise.race([check, late]);
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
