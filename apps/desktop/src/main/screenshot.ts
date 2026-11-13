// Pieces of the screenshot mode (`--screenshot <dir>`, docs/agent-lessons-learned.md section 4) that do not
// need Electron: the argument, the isolated core and waiting until the terminal output has settled.
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
      const match = new RegExp(`^${PROFILE_PREFIX}-(\\d+)$`).exec(name);
      if (!match) return false;
      const pid = Number(match[1]);
      return pid !== ownPid && !isAlive(pid);
    })
    .map((name) => path.win32.join(tempDir, name));
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
