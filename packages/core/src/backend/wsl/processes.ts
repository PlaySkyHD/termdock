// Real wsl.exe processes: calls without PTY, keepalive and the tmux client in a ConPTY (ADR 0003, Phase 0). The
// ConPTY itself (shared reader, close queue) lives in `../conpty/spawn.ts`, shared with the Windows backend.
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import type { TerminalSize } from "@termdock/protocol";
import { spawnConpty } from "../conpty/spawn.js";
import type { PtyProcess } from "../conpty/pty.js";
import type { RunResult, TmuxTarget } from "./commands.js";
import { keepaliveArgs } from "./commands.js";
import type { KeepaliveProcess } from "./keepalive.js";

const WSL = "wsl.exe";
/** wsl.exe prints its own messages (e.g. `-l -v`) as UTF-16 without this. */
const wslEnv = (): NodeJS.ProcessEnv => ({ ...process.env, WSL_UTF8: "1" });

/** `wsl.exe <args>` without PTY; resolves with exit code and output, never rejects. */
export function runWsl(args: readonly string[], options: { timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      WSL,
      [...args],
      {
        env: wslEnv(),
        timeout: options.timeoutMs,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const failure = error as NodeJS.ErrnoException & {
          killed?: boolean;
          code?: number | string;
          signal?: string | null;
        };
        resolve({
          code: typeof failure.code === "number" ? failure.code : null,
          stdout,
          stderr: stderr || failureText(failure),
          timedOut: failure.killed === true,
        });
      },
    );
  });
}

/** Prefix of the text `runWsl` puts into an empty stderr; `parseCwdCheck` knows it. */
export const WSL_FAILURE_PREFIX = "wsl.exe failed: ";

/**
 * Exit code, signal or start error code only. Never `failure.message`: Node builds it as "Command failed: <the whole
 * command line>", and the arguments may carry values the user has not released for logs and error responses.
 */
export function failureText(failure: { code?: number | string; signal?: string | null }): string {
  if (typeof failure.code === "number") return `${WSL_FAILURE_PREFIX}exit code ${failure.code}`;
  if (failure.signal) return `${WSL_FAILURE_PREFIX}ended by signal ${failure.signal}`;
  return `${WSL_FAILURE_PREFIX}${typeof failure.code === "string" ? failure.code : "could not run"}`;
}

/**
 * The keepalive (`keepaliveArgs`) without PTY, detached from the core (issue #140): libuv puts every child that is
 * not detached into the core's job object, which ends it together with the core (update, uninstall, Task
 * Manager). Detached, it keeps the distro and its tmux sessions alive until the next core takes it over or the
 * tmux server ends. `unref` lets the core (and tests) end while it runs.
 */
export function spawnKeepalive(target: TmuxTarget): KeepaliveProcess {
  const child = spawn(WSL, keepaliveArgs(target), {
    env: wslEnv(),
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  });
  child.unref();
  let exited = false;
  const listeners: (() => void)[] = [];
  const onEnd = () => {
    if (exited) return;
    exited = true;
    for (const listener of listeners) listener();
  };
  child.once("exit", onEnd);
  child.once("error", onEnd);
  return {
    kill: () => {
      if (!exited) child.kill();
    },
    onExit: (listener) => {
      if (exited) listener();
      else listeners.push(listener);
    },
  };
}

/** The tmux client `wsl.exe <args>` in a ConPTY (`spawnConpty`); loaded on first use. */
export function spawnPty(args: readonly string[], size: TerminalSize): Promise<PtyProcess> {
  // A Windows directory wsl.exe can translate; the Linux directory comes from --cd.
  return spawnConpty(WSL, args, size, homedir());
}
