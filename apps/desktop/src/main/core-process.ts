// Starting the core as a detached child of Electron (ADR 0001): Electron runs it as plain Node.
import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

export interface SpawnedProcess {
  readonly pid?: number | undefined;
  unref(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;

export interface StartCoreOptions {
  /** `process.execPath` of Electron. */
  execPath: string;
  /** Path of `termdock-core.js`. */
  entry: string;
  /** Environment of the core; `ELECTRON_RUN_AS_NODE=1` is added. */
  env: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  /** A spawn error arrives asynchronously; without a listener it would end the main process. */
  onError?: (error: Error) => void;
}

/**
 * Spawns the core and lets it outlive the app: own process group, no console, no pipes to the app. Returns the
 * process id (undefined when the spawn failed at once).
 */
export function startDetachedCore(options: StartCoreOptions): number | undefined {
  const spawn = options.spawn ?? nodeSpawn;
  const child = spawn(options.execPath, [options.entry], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.on("error", (error) => options.onError?.(error));
  child.unref();
  return child.pid;
}

/** `packages/core/dist/bin/termdock-core.js`, found through the package entry of `@termdock/core`. */
export function coreEntryPath(): string {
  const main = createRequire(import.meta.url).resolve("@termdock/core");
  return path.join(path.dirname(main), "bin", "termdock-core.js");
}
