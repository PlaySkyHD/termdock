// Real wsl.exe processes: calls without PTY, keepalive and the node-pty PTY (ADR 0003, Phase 0).
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { TerminalSize } from "@termdock/protocol";
// Type only: the module is loaded on first use, so unit tests never load the native addon.
import type * as NodePty from "node-pty";
import type { RunResult, TmuxTarget } from "./commands.js";
import { keepaliveArgs } from "./commands.js";
import { ConoutConnection, ConoutReader, installConoutReader } from "./conout-reader.js";
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

let nodePty: Promise<typeof NodePty> | undefined;
let reader: Promise<ConoutReader | undefined> | undefined;

/**
 * The reader shared by every PTY of this process (ADR 0008), installed into node-pty on first use; undefined when
 * node-pty is not the supported version (logged once) or the platform has no ConPTY.
 */
export function conoutReader(): Promise<ConoutReader | undefined> {
  reader ??= (async () => {
    if (process.platform !== "win32") return undefined;
    const log = (line: string) => void process.stderr.write(`termdock-core: ${line}\n`);
    const shared = new ConoutReader({ log });
    try {
      return installConoutReader(shared, { log }) ? shared : undefined;
    } catch (error) {
      // A node-pty layout without the expected files: PTYs keep node-pty's own workers rather than failing.
      log(`conout reader: not installed (${error instanceof Error ? error.message : String(error)})`);
      return undefined;
    }
  })();
  return reader;
}

/** The internal parts of a node-pty 1.1.0 `WindowsTerminal` this module reads. */
interface WindowsTerminalInternals {
  _agent?: {
    /** The connection node-pty created for this PTY (the replaced `ConoutConnection`). */
    _conoutSocketWorker?: unknown;
    /** Set once the ConPTY reported the end of the process; node-pty holds the process handle until then. */
    exitCode?: number;
  };
}

const agentOf = (terminal: NodePty.IPty) => (terminal as unknown as WindowsTerminalInternals)._agent;

/** A PTY of `spawnConpty`; `pid` is the process it runs. */
export type ConptyProcess = PtyProcess & { readonly pid: number };

/** node-pty 1.1.0 with the bundled ConPTY (`useConptyDll`) running `wsl.exe <args>`; loaded on first use. */
export function spawnPty(args: readonly string[], size: TerminalSize): Promise<PtyProcess> {
  // A Windows directory wsl.exe can translate; the Linux directory comes from --cd.
  return spawnConpty(WSL, args, size, homedir());
}

/**
 * Starts `file <args>` in a ConPTY whose output the shared reader drains (ADR 0008). Waits for the reader's worker
 * first: node-pty blocks the main thread in `ConnectNamedPipe` until the worker has opened the output pipe. When the
 * worker ends unexpectedly, the PTY is closed (its process ends) and reports its end once, without exit code; for a
 * tmux client the registry then re-attaches as after a lost client (ADR 0003).
 */
export async function spawnConpty(
  file: string,
  args: readonly string[],
  size: TerminalSize,
  cwd: string,
): Promise<ConptyProcess> {
  nodePty ??= import("node-pty");
  const pty = await nodePty;
  const shared = await conoutReader();
  await shared?.ready();
  shared?.takeLastConnection();
  let terminal: NodePty.IPty;
  try {
    terminal = pty.spawn(file, [...args], {
      name: "xterm-256color",
      cols: size.cols,
      rows: size.rows,
      cwd,
      env: process.env as Record<string, string>,
      useConptyDll: true,
    });
  } catch (error) {
    // node-pty may have created the connection before it failed; nothing else would ever close its pipe.
    shared?.takeLastConnection()?.close();
    throw error;
  }
  shared?.takeLastConnection();
  ignoreInputErrors(terminal);
  const connection = agentOf(terminal)?._conoutSocketWorker;
  return connection instanceof ConoutConnection ? endOnLoss(terminal, connection) : terminal;
}

/** Longest wait for the process of a lost PTY to end before the next one is closed. */
const LOST_KILL_WAIT_MS = 2_000;
/** Closing of PTYs whose worker was lost, one after the other. */
let lostKills: Promise<void> = Promise.resolve();

/** `terminal`, ended when `connection` is lost; its exit is reported once, from node-pty or from the loss. */
function endOnLoss(terminal: NodePty.IPty, connection: ConoutConnection): ConptyProcess {
  let ended = false;
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  const end = (event: { exitCode: number }) => {
    if (ended) return;
    ended = true;
    for (const listener of [...exitListeners]) listener(event);
  };
  let killed = false;
  terminal.onExit(({ exitCode }) => end({ exitCode }));
  const processEnded = () => agentOf(terminal)?.exitCode !== undefined;
  connection.onLost(() => {
    // One PTY after the other, each until its process ended: several kills in a row crash node-pty 1.1.0 now and
    // then (#160), and a lost worker closes every PTY at once.
    lostKills = lostKills
      .then(async () => {
        // node-pty may already have reported an end only because its output socket closed with the worker; the
        // process is gone only once the ConPTY reported its exit code. Until then node-pty holds the process handle,
        // so the PID cannot belong to another process yet. The process first: `kill` waits for the PTY's first
        // output, which may never come without the worker.
        // Also after our own `kill`: node-pty defers it until the first output.
        if (!processEnded()) {
          try {
            process.kill(terminal.pid);
          } catch {
            // Already gone.
          }
        }
        // Once only: a second `kill` would close the same ConPTY again.
        if (!killed) {
          killed = true;
          try {
            terminal.kill();
          } catch {
            // node-pty may have closed it already.
          }
        }
        const deadline = Date.now() + LOST_KILL_WAIT_MS;
        while (!processEnded() && Date.now() < deadline) await sleep(25);
        // node-pty's code for a process it could not follow; the WSL backend asks tmux how the session ended.
        end({ exitCode: -1 });
      })
      .catch((error: unknown) => {
        // One failed step must not stop the closing of the PTYs after it.
        void process.stderr.write(
          `termdock-core: conout reader: closing a lost PTY failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
  });
  return {
    get pid() {
      return terminal.pid;
    },
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    kill: () => {
      killed = true;
      terminal.kill();
    },
    onData: (listener) => terminal.onData(listener),
    onExit: (listener) => {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
  };
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
