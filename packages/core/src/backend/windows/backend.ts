// Windows backend (issue #65, ADR 0003): the PTY runs the shell directly (`pwsh`, `powershell`, `cmd`). No
// persistence: a session lives as long as its PTY in this core, and a new core finds none (ADR 0001, ADR 0005).
import { lstat, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { BackendKind, LaunchSpec, SessionId, SessionWarning, TerminalSize } from "@termdock/protocol";
import { CoreError } from "../../session/errors.js";
import type { Backend, PtyHandle, TerminalSnapshot } from "../types.js";
import { ConptyPty, type PtyProcess } from "../conpty/pty.js";
import { pendingPtyCloses, PTYS_CLOSED_TIMEOUT_MS, ptysClosed, spawnConpty } from "../conpty/spawn.js";
import {
  defaultShell,
  isWindowsShell,
  launchProgram,
  promptHookEnvironment,
  shellEnvironment,
  windowsCwd,
  within,
  type ShellLookup,
} from "./shells.js";

/** Starts `file <args>` in a ConPTY in `cwd` with exactly `env`. */
export type WindowsPtySpawner = (
  file: string,
  args: readonly string[],
  size: TerminalSize,
  cwd: string,
  env: Readonly<Record<string, string>>,
) => Promise<PtyProcess>;

export interface WindowsBackendOptions {
  /** Defaults to `spawnConpty` (shared reader and close queue, ADR 0008). */
  spawnPty?: WindowsPtySpawner;
  /** Environment of the core the shells inherit (without `ELECTRON_RUN_AS_NODE`); defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Home directory for `~`; defaults to `os.homedir()`. */
  home?: string;
  /** Whether a program file is there (lookup of shells and commands); defaults to `fs.promises.stat`/`lstat`. */
  isFile?: (file: string) => Promise<boolean>;
  /** Longest wait for one check of the lookup; a slower one (hung share in `PATH`) counts as absent. */
  lookupTimeoutMs?: number;
  /** Whether a path is a directory (working directory check); defaults to `fs.promises.stat`. */
  isDirectory?: (dir: string) => Promise<boolean>;
  /** Longest wait for the directory check; a slower one counts as missing (a hung share must not hold the PTY). */
  cwdCheckTimeoutMs?: number;
  /** How long `kill` waits, after the PTY closed, for its end to reach the registry. */
  killReportMs?: number;
  /** See `WslBackendOptions.ptysClosed`; defaults to the ConPTY queue. */
  ptysClosed?: () => Promise<boolean>;
  pendingPtyCloses?: () => number;
  log?: (line: string) => void;
}

interface LiveShell {
  process: PtyProcess;
  pty: ConptyPty;
  /** Settles when the process reported its end; the entry is gone from `live` by then. */
  ended: Promise<void>;
}

export class WindowsBackend implements Backend {
  readonly kind: BackendKind = "windows";
  private readonly spawnPty: WindowsPtySpawner;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly home: string;
  private readonly lookup: ShellLookup;
  private readonly isDirectory: (dir: string) => Promise<boolean>;
  private readonly cwdCheckTimeoutMs: number;
  private readonly killReportMs: number;
  private readonly ptysClosed: () => Promise<boolean>;
  private readonly pendingPtyCloses: () => number;
  private readonly log: (line: string) => void;
  /** The shell of every session whose PTY runs; at most one per session. */
  private readonly live = new Map<SessionId, LiveShell>();
  /** Sessions whose PTY is being started; a second start meanwhile is refused. */
  private readonly starting = new Set<SessionId>();
  private disposed = false;

  constructor(options: WindowsBackendOptions = {}) {
    this.spawnPty = options.spawnPty ?? spawnConpty;
    this.env = options.env ?? process.env;
    this.home = options.home ?? homedir();
    this.lookup = {
      env: this.env,
      isFile: options.isFile ?? isFile,
      timeoutMs: options.lookupTimeoutMs ?? 2_000,
    };
    this.isDirectory = options.isDirectory ?? isDirectory;
    this.cwdCheckTimeoutMs = options.cwdCheckTimeoutMs ?? 2_000;
    this.killReportMs = options.killReportMs ?? 1_000;
    this.ptysClosed = options.ptysClosed ?? (() => ptysClosed());
    this.pendingPtyCloses = options.pendingPtyCloses ?? pendingPtyCloses;
    this.log = options.log ?? ((line) => void process.stderr.write(`termdock-core: ${line}\n`));
  }

  /** ConPTY exists on Windows only; which shells are installed decides each start. */
  async available(): Promise<boolean> {
    return process.platform === "win32";
  }

  /** Pins the shell when neither the spec nor the settings named one: PowerShell 7 if installed, else Windows PowerShell. */
  async resolveLaunch(spec: LaunchSpec): Promise<LaunchSpec> {
    if (spec.shell !== undefined) return spec;
    return { ...spec, shell: await defaultShell(this.lookup) };
  }

  /**
   * Starts the shell (or `launch.command`) in a ConPTY. A working directory that is no directory gives the warning
   * `cwd_missing`, and the shell starts in the home directory instead (issue #113 for WSL). A missing shell rejects
   * with a `CoreError` whose message names it; the registry passes that message on.
   */
  async start(id: SessionId, spec: LaunchSpec, size: TerminalSize): Promise<PtyHandle> {
    if (this.disposed) throw new Error("Windows backend is closed");
    if (this.live.has(id) || this.starting.has(id)) throw new Error(`Session ${id} already has a shell`);
    // Before the first await, so a second start meanwhile is refused.
    this.starting.add(id);
    try {
      const shell = spec.shell ?? (await defaultShell(this.lookup));
      if (!isWindowsShell(shell))
        throw new CoreError("bad_request", `Unknown Windows shell ${String(shell)}`);
      const program = await launchProgram(spec, shell, this.lookup);
      if ("error" in program) throw new CoreError("backend_unavailable", program.error);
      const wanted = windowsCwd(spec.cwd, this.home);
      const found = wanted !== undefined && (await this.directoryExists(wanted));
      const warnings: SessionWarning[] = found ? [] : [{ code: "cwd_missing", path: spec.cwd }];
      const cwd = found ? wanted : this.home;
      const env = promptHookEnvironment(shell, spec, shellEnvironment(this.env, spec.env));
      const process = await this.spawnPty(program.file, program.args, size, cwd, env);
      if (this.disposed) {
        process.kill();
        throw new Error("Windows backend is closed");
      }
      // Lost output (ADR 0008) is no exit of the shell: without exit code the registry asks `exists` (false, the
      // shell is gone) and marks the session Interrupted.
      const pty = new ConptyPty(process, async (exit) => (exit.lost ? {} : { exitCode: exit.exitCode }));
      let markEnded: () => void = () => {};
      const shellEntry: LiveShell = { process, pty, ended: new Promise((resolve) => (markEnded = resolve)) };
      this.live.set(id, shellEntry);
      // Synchronous, before `ConptyPty` reports the end (after a promise): `exists` is false once the registry hears.
      process.onExit(() => {
        if (this.live.get(id) === shellEntry) this.live.delete(id);
        markEnded();
      });
      if (warnings.length > 0) pty.warnings = warnings;
      return pty;
    } finally {
      this.starting.delete(id);
    }
  }

  /** A shell does not outlive its PTY; there is nothing to attach to. */
  async attach(id: SessionId): Promise<PtyHandle> {
    throw new Error(`Windows session ${id} has no process to attach to; it ended with its PTY`);
  }

  /** True while the session's shell runs in this core; never after a core restart (ADR 0005). */
  async exists(id: SessionId): Promise<boolean> {
    return this.live.has(id);
  }

  /** The sessions whose shell runs in this core; no backend call. */
  async listLive(sessions: readonly { id: SessionId }[]): Promise<ReadonlySet<SessionId>> {
    return new Set(sessions.filter(({ id }) => this.live.has(id)).map(({ id }) => id));
  }

  /**
   * Ends the shell through the close queue (#160) and waits until it ended and the registry has heard its exit code.
   * The close may see the exit code before node-pty reports the end, so it waits for that report too, at most
   * `killReportMs`. Rejects when the shell still runs afterwards. Also after the registry released the PTY first
   * (`killAll`, `core.shutdown { stopSessions }`): then it only waits for the end.
   */
  async kill(id: SessionId): Promise<void> {
    const shell = this.live.get(id);
    if (!shell) return;
    shell.process.kill();
    await shell.process.closed?.();
    await within(Promise.all([shell.ended, shell.pty.endReported()]), this.killReportMs);
    if (this.live.get(id) === shell) throw new Error(`The shell of session ${id} still runs after kill`);
  }

  /** No screen of its own: the registry's raw buffer (256 KiB) is the snapshot (ADR 0003). */
  async snapshot(): Promise<TerminalSnapshot | undefined> {
    return undefined;
  }

  /**
   * Ends every shell: Windows sessions do not outlive the core (ADR 0001), also on `core.shutdown` without stop.
   * Their states stay as stored; the next core marks them `Interrupted`. Resolves once the closes are done (#160),
   * at most `PTYS_CLOSED_TIMEOUT_MS`; afterwards `start` rejects.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const shell of this.live.values()) shell.process.kill();
    if (await this.ptysClosed()) return;
    this.log(
      `${this.pendingPtyCloses()} PTY close(s) still open after ${PTYS_CLOSED_TIMEOUT_MS} ms; the core ends without them`,
    );
  }

  /** Number of shells running in this core. */
  get running(): number {
    return this.live.size;
  }

  private async directoryExists(dir: string): Promise<boolean> {
    return (
      (await within(
        this.isDirectory(dir).catch(() => false),
        this.cwdCheckTimeoutMs,
      )) === true
    );
  }
}

/**
 * A program file. An App Execution Alias (`%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` of a Store install) is a
 * reparse point that `stat` cannot follow; `lstat` still sees it, and CreateProcess runs it.
 */
async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    try {
      return !(await lstat(file)).isDirectory();
    } catch {
      return false;
    }
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
