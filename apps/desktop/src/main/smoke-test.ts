// Check mode `--smoke-test` (ADR 0007): proves that a built app starts its core and gets an answer, without a
// window. Modeled on the screenshot mode (ADR 0006): own pipe, own data folder, own tmux socket. Free of Electron.
import path from "node:path";
import type { CoreStatusResult } from "@termdock/protocol";

/** The value of `promise`, or undefined when it rejects or takes longer than `ms`. */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** True when the app was started with `--smoke-test`. */
export function smokeTestRequested(argv: readonly string[]): boolean {
  return argv.includes("--smoke-test");
}

/**
 * The data folder of the check: `TERMDOCK_DATA_DIR`, which the caller points at a temp folder. Without it, or with
 * `%APPDATA%\TermDock` or a folder below it, a second core would open the productive database and reconcile its
 * sessions against the empty tmux socket of the check, so it refuses to run.
 */
export function smokeTestDataDir(env: NodeJS.ProcessEnv): string {
  const dir = env["TERMDOCK_DATA_DIR"];
  if (dir === undefined || dir === "")
    throw new Error("--smoke-test needs TERMDOCK_DATA_DIR pointing at a temporary folder");
  const appData = env["APPDATA"];
  if (appData !== undefined && appData !== "") {
    // Windows paths compare without case; `resolve` also turns `/` into `\` and drops a trailing separator.
    const productive = path.win32.resolve(appData, "TermDock").toLowerCase();
    const chosen = path.win32.resolve(dir).toLowerCase();
    if (chosen === productive || chosen.startsWith(productive + "\\"))
      throw new Error(
        `--smoke-test must not use the productive data folder ${path.win32.resolve(appData, "TermDock")}`,
      );
  }
  return dir;
}

/** How long a check that timed out still waits for a core that starts late, so it can stop that one too. */
export const LATE_START_GRACE_MS = 15_000;

export interface SmokeTestDeps {
  /** Connects to the check's own pipe and starts the core there; resolves after `hello` and `core.status`. */
  connectOrStart(): Promise<{
    client: { close(): Promise<void> };
    started: boolean;
    status: CoreStatusResult;
  }>;
  /** Ends the core this check started (`core.shutdown { stopSessions: true }`, else kill) and waits for it. */
  stopCore(): Promise<"shutdown" | "killed" | "gone">;
  /** True while the started core process still runs. */
  coreAlive(): boolean;
  log(message: string): void;
  /** Upper bound for connecting, starting and the first answer. */
  timeoutMs: number;
}

/**
 * Runs the check and returns the exit code: 0 when the started core answered and ended on shutdown, else 1. Never
 * rejects: an error while closing or stopping also counts as 1, so the caller always gets to exit.
 */
export async function runSmokeTest(deps: SmokeTestDeps): Promise<0 | 1> {
  try {
    return await check(deps);
  } catch (error) {
    deps.log(`smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function check(deps: SmokeTestDeps): Promise<0 | 1> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`no answer within ${deps.timeoutMs} ms`));
    }, deps.timeoutMs);
  });
  const pending = deps.connectOrStart();
  let connection: Awaited<typeof pending>;
  try {
    connection = await Promise.race([pending, timeout]);
  } catch (error) {
    deps.log(`smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
    if (timedOut) {
      // Connecting or starting still runs: a core it starts later would outlive the check, so wait for it a while.
      const late = await settleWithin(pending, LATE_START_GRACE_MS);
      await late?.client.close();
    }
    deps.log(`core: ${await deps.stopCore()}`);
    return 1;
  } finally {
    clearTimeout(timer);
  }

  await connection.client.close();
  if (!connection.started) {
    // The pipe is the check's own; a core that already held it was not started by this app.
    deps.log("smoke test failed: a core this run did not start answered on its pipe");
    return 1;
  }
  const unavailable = connection.status.backendUnavailable;
  deps.log(
    `core answered; unavailable backends: ${unavailable.length > 0 ? unavailable.join(", ") : "none"}`,
  );

  const outcome = await deps.stopCore();
  if (outcome !== "shutdown" || deps.coreAlive()) {
    deps.log(`smoke test failed: the core did not end on core.shutdown (${outcome})`);
    return 1;
  }
  deps.log("smoke test passed");
  return 0;
}
