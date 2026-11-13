// Start logic of the `termdock-core` process, separate from `process.exit` so that tests can run it.
import type { Backend } from "../backend/types.js";
import { AlreadyRunningError, CoreServer } from "../ipc/server.js";
import { SessionRegistry } from "../session/registry.js";

/** Exit code of a second core that finds the pipe taken (ADR 0001). */
export const ALREADY_RUNNING_EXIT_CODE = 10;

export interface RunCoreOptions {
  /** Defaults to the per-user pipe name. */
  pipePath?: string;
  /** Backends for the registry. Phase 1 ships none yet: `session.create` answers `backend_unavailable`. */
  backends?: readonly Backend[];
  stderr?: { write(text: string): unknown };
  /** Close on SIGINT/SIGTERM. Default true; tests turn it off. */
  installSignalHandlers?: boolean;
  /** Called when the core ends on purpose (shutdown request, signal). The entry point maps it to `process.exit`. */
  onExit?: (exitCode: number) => void;
}

export interface RunCoreResult {
  exitCode: number;
  errorCode?: "already_running" | "start_failed";
  /** Set when the core runs. */
  server?: CoreServer;
}

export async function runCore(options: RunCoreOptions = {}): Promise<RunCoreResult> {
  const stderr = options.stderr ?? process.stderr;
  const registry = new SessionRegistry({ backends: options.backends ?? [] });
  try {
    const server = await CoreServer.start({
      registry,
      ...(options.pipePath === undefined ? {} : { pipePath: options.pipePath }),
      onShutdown: () => options.onExit?.(0),
      // Only the message: stack traces stay out of logs, as they stay out of IPC answers.
      onInternalError: (error) =>
        stderr.write(
          `termdock-core: internal error: ${error instanceof Error ? error.message : "unknown"}\n`,
        ),
    });
    if (options.installSignalHandlers !== false) {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => void server.close().then(() => options.onExit?.(0)));
      }
    }
    return { exitCode: 0, server };
  } catch (error) {
    if (error instanceof AlreadyRunningError) {
      stderr.write(`termdock-core: already_running: ${error.message}\n`);
      return { exitCode: ALREADY_RUNNING_EXIT_CODE, errorCode: "already_running" };
    }
    stderr.write(`termdock-core: start failed: ${error instanceof Error ? error.message : "unknown"}\n`);
    return { exitCode: 1, errorCode: "start_failed" };
  }
}
