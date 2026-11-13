// Real wsl.exe processes: calls without PTY, keepalive and the node-pty PTY (ADR 0003, Phase 0).
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import type { TerminalSize } from "@termdock/protocol";
// Type only: the module is loaded on first use, so unit tests never load the native addon.
import type * as NodePty from "node-pty";
import type { RunResult } from "./commands.js";
import { keepaliveArgs } from "./commands.js";
import type { KeepaliveProcess } from "./keepalive.js";
import type { PtyProcess } from "./pty.js";

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
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        resolve({
          code: typeof failure.code === "number" ? failure.code : null,
          stdout,
          stderr: stderr || failure.message,
          timedOut: failure.killed === true,
        });
      },
    );
  });
}

/** `wsl.exe -d <distro> --exec sleep infinity` without PTY. */
export function spawnKeepalive(distro: string): KeepaliveProcess {
  const child = spawn(WSL, keepaliveArgs(distro), { env: wslEnv(), stdio: "ignore", windowsHide: true });
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

let nodePty: Promise<typeof NodePty> | undefined;

/** node-pty 1.1.0 with the bundled ConPTY (`useConptyDll`); loaded on first use. */
export async function spawnPty(args: readonly string[], size: TerminalSize): Promise<PtyProcess> {
  nodePty ??= import("node-pty");
  const pty = await nodePty;
  const terminal = pty.spawn(WSL, [...args], {
    name: "xterm-256color",
    cols: size.cols,
    rows: size.rows,
    // A Windows directory wsl.exe can translate; the Linux directory comes from --cd.
    cwd: homedir(),
    env: process.env as Record<string, string>,
    useConptyDll: true,
  });
  ignoreInputErrors(terminal);
  return terminal;
}

/**
 * node-pty 1.1.0 writes input to the ConPTY input pipe (`_agent.inSocket`, windowsPtyAgent.js) without an
 * `error` listener. Input that arrives after the tmux client ended but before its exit is reported fails
 * asynchronously with `EAGAIN` and would crash the core as an uncaught exception. The input is lost either
 * way; the exit follows and the registry re-attaches.
 */
function ignoreInputErrors(terminal: NodePty.IPty): void {
  const agent = (
    terminal as unknown as { _agent?: { inSocket?: { on(event: "error", fn: () => void): void } } }
  )._agent;
  agent?.inSocket?.on("error", () => {});
}
