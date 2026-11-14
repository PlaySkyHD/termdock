// Pieces of the screenshot mode (`--screenshot <dir>`, docs/agent-lessons-learned.md section 4) that do not
// need Electron: the argument, the isolated core and waiting until the terminal output has settled.
import { execFile } from "node:child_process";
import path from "node:path";

/** Directory after `--screenshot`, or undefined without the flag. */
export function screenshotDir(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--screenshot");
  if (index < 0) return undefined;
  const dir = argv[index + 1];
  if (dir === undefined || dir.startsWith("--")) throw new Error("--screenshot needs a directory");
  return dir;
}

export interface IsolatedCore {
  pipePath: string;
  /** Environment for the started core; nothing of it reaches the productive core or socket `termdock`. */
  env: { TERMDOCK_PIPE: string; TERMDOCK_DATA_DIR: string; TERMDOCK_TMUX_SOCKET: string };
}

/**
 * Own pipe, the database in `dataDir` (a fresh temp directory) and a tmux socket of this run
 * (`termdock-test-<pid>-<nonce>`), so parallel runs and the WSL tests on `termdock-test` do not meet.
 */
export function isolatedCore(dataDir: string, pid: number, nonce: string): IsolatedCore {
  const pipePath = `\\\\.\\pipe\\termdock-core-shot-${pid}-${nonce}`;
  return {
    pipePath,
    env: {
      TERMDOCK_PIPE: pipePath,
      TERMDOCK_DATA_DIR: dataDir,
      TERMDOCK_TMUX_SOCKET: `termdock-test-${pid}-${nonce}`,
    },
  };
}

/**
 * Electron profile (`userData`) of a screenshot run: a folder of its process below the temp directory. It keeps
 * the run apart from a running app (own single-instance lock) and from parallel runs. The run cannot remove it
 * itself, because Electron holds its files open until the process has ended; a later run does (`staleProfileDirs`).
 */
export function screenshotProfileDir(tempDir: string, pid: number): string {
  return path.win32.join(tempDir, `${PROFILE_PREFIX}-${pid}`);
}

const PROFILE_PREFIX = "termdock-screenshot-profile";
const PROFILE_PID = new RegExp(`^${PROFILE_PREFIX}-(\\d+)$`);

/**
 * Profiles of earlier screenshot runs in `entries` (names in `tempDir`) whose process has ended, including the
 * fixed folder of older versions. The profile of `ownPid` and of live processes stays.
 */
export function staleProfileDirs(
  tempDir: string,
  entries: readonly string[],
  ownPid: number,
  isAlive: (pid: number) => boolean,
): string[] {
  return entries
    .filter((name) => {
      if (name === PROFILE_PREFIX) return true;
      const match = PROFILE_PID.exec(name);
      if (!match) return false;
      const pid = Number(match[1]);
      return pid !== ownPid && !isAlive(pid);
    })
    .map((name) => path.win32.join(tempDir, name));
}

/**
 * Socket file of a screenshot run in the tmux socket directory of WSL (`/tmp/tmux-<uid>/`), exactly as
 * `isolatedCore` names the socket; `termdock` and `termdock-test` do not match.
 */
const SOCKET_PATH = /^\/tmp\/tmux-\d+\/(termdock-test-(\d+)-[0-9a-f]+)$/;

/** Parses a socket path: the socket name and the pid of its run, or undefined for any other path. */
export function parseSocketPath(socketPath: string): { name: string; pid: number } | undefined {
  const match = SOCKET_PATH.exec(socketPath);
  return match ? { name: match[1]!, pid: Number(match[2]) } : undefined;
}

/**
 * Socket paths in `paths` of earlier screenshot runs whose process has ended. The socket of `ownPid`, of live
 * processes and every other path stays.
 */
export function staleSockets(
  paths: readonly string[],
  ownPid: number,
  isAlive: (pid: number) => boolean,
): string[] {
  return paths.filter((socketPath) => {
    const parsed = parseSocketPath(socketPath);
    return parsed !== undefined && parsed.pid !== ownPid && !isAlive(parsed.pid);
  });
}

export interface StaleSocketDeps {
  /** Full paths of the sockets in the tmux socket directories of WSL. */
  listSockets(): Promise<string[]>;
  /** `tmux -L <name> kill-server` for the socket at `socketPath`; removes the file when no server is left. */
  killServer(socketPath: string): Promise<void>;
  isAlive(pid: number): boolean;
  log(message: string): void;
}

/**
 * Ends the tmux servers that aborted screenshot runs left behind. Never rejects: errors are logged and the
 * remaining sockets are still tried, so a broken WSL cannot stop the run.
 */
export async function cleanStaleSockets(ownPid: number, deps: StaleSocketDeps): Promise<string[]> {
  const killed: string[] = [];
  let paths: string[];
  try {
    paths = staleSockets(await deps.listSockets(), ownPid, deps.isAlive);
  } catch (error) {
    deps.log(`stale tmux sockets: ${error instanceof Error ? error.message : String(error)}`);
    return killed;
  }
  for (const socketPath of paths) {
    try {
      await deps.killServer(socketPath);
      killed.push(socketPath);
    } catch (error) {
      deps.log(`stale tmux socket ${socketPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return killed;
}

/** Waits for `promise` (never rejects here; an `undefined` one is done) for at most `ms`. */
export async function settleWithin(promise: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (promise === undefined) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const WSL_CALL_TIMEOUT_MS = 20_000;

/** The part of `execFile` that is used, so tests can replace it. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean },
  callback: (error: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void,
) => unknown;

/**
 * The WSL side of `cleanStaleSockets`: argument arrays for `wsl.exe --exec`, no shell string. Without `-d`
 * wsl.exe uses the default distro, like the core's WSL backend does for sessions without a distro.
 */
export function wslSocketDeps(
  execFileFn: ExecFileFn = execFile as ExecFileFn,
): Pick<StaleSocketDeps, "listSockets" | "killServer"> {
  /** `okCodes`: exit codes that still count as success (`find` exits 1 for unreadable folders but lists the rest). */
  const wslExec = (args: readonly string[], okCodes: readonly number[] = []): Promise<string> =>
    new Promise((resolve, reject) => {
      execFileFn(
        "wsl.exe",
        ["--cd", "~", "--exec", ...args],
        { env: { ...process.env, WSL_UTF8: "1" }, timeout: WSL_CALL_TIMEOUT_MS, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && !(typeof error.code === "number" && okCodes.includes(error.code)))
            reject(
              new Error(
                `${error.message}
${stderr}`.trim(),
              ),
            );
          else resolve(stdout);
        },
      );
    });
  return {
    // Sockets live in `/tmp/tmux-<uid>/`; `find` matches the directory without knowing the uid.
    async listSockets() {
      const out = await wslExec(
        [
          "find",
          "/tmp",
          "-maxdepth",
          "2",
          "-path",
          "/tmp/tmux-*/termdock-test-*",
          "-type",
          "s",
          "-printf",
          "%p\\n",
        ],
        [1],
      );
      return out.split("\n").filter((line) => line !== "");
    },
    async killServer(socketPath) {
      const parsed = parseSocketPath(socketPath);
      if (!parsed) throw new Error(`not a screenshot socket: ${socketPath}`);
      try {
        await wslExec(["tmux", "-L", parsed.name, "kill-server"]);
      } catch (error) {
        // A socket file whose server is already gone (killed hard) needs no kill, only the removal below.
        if (!/no server running|error connecting/.test(error instanceof Error ? error.message : ""))
          throw error;
      }
      // tmux leaves the socket file behind after `kill-server`; remove it, so later runs skip it.
      await wslExec(["rm", "-f", "--", socketPath]);
    },
  };
}

export interface StopCoreDeps {
  /** Connects to the isolated core (own pipe), with a short timeout. */
  connect(): Promise<{
    request(method: "core.shutdown", params: { stopSessions: boolean }): Promise<unknown>;
    close(): Promise<void>;
  }>;
  kill(pid: number): void;
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

/** How long the run waits for its core process to end after shutdown or kill. */
const CORE_EXIT_WAIT_MS = 5_000;

/**
 * Ends the core of a screenshot run that failed before or right after it connected: first by
 * `core.shutdown { stopSessions: true }` (also ends its tmux sessions on the run's socket), otherwise by killing
 * the process. Waits until the process is gone, so its database can be removed afterwards.
 */
export async function stopIsolatedCore(
  pid: number | undefined,
  deps: StopCoreDeps,
): Promise<"shutdown" | "killed" | "gone"> {
  let outcome: "shutdown" | "killed" | "gone" = "gone";
  try {
    const client = await deps.connect();
    try {
      await client.request("core.shutdown", { stopSessions: true });
      outcome = "shutdown";
    } finally {
      await client.close();
    }
  } catch {
    if (pid !== undefined && deps.isAlive(pid)) {
      deps.kill(pid);
      outcome = "killed";
    }
  }
  if (pid !== undefined) {
    for (let waited = 0; deps.isAlive(pid) && waited < CORE_EXIT_WAIT_MS; waited += 100)
      await deps.sleep(100);
  }
  return outcome;
}

/** Tracks terminal output and waits until it has paused, so the screen shows a finished prompt. */
export class QuietWatch {
  private lastOutput: number | undefined;
  private readonly waiters = new Set<() => void>();

  /** Call on every chunk of output. */
  saw(): void {
    this.lastOutput = Date.now();
    for (const wake of this.waiters) wake();
  }

  /** Resolves when output was seen and then nothing for `quietMs`; rejects after `timeoutMs`. */
  quiet(quietMs: number, timeoutMs: number): Promise<void> {
    const since = Date.now();
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        clearTimeout(deadline);
        this.waiters.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const check = (): void => {
        clearTimeout(timer);
        if (this.lastOutput === undefined || this.lastOutput < since) return;
        const left = this.lastOutput + quietMs - Date.now();
        if (left <= 0) finish();
        else timer = setTimeout(check, left);
      };
      const deadline = setTimeout(
        () => finish(new Error(`Terminal output did not settle within ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.waiters.add(check);
      check();
    });
  }
}
