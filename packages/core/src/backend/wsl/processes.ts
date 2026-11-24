// Real wsl.exe processes: calls without PTY, keepalive and the node-pty PTY (ADR 0003, Phase 0).
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import type { TerminalSize } from "@termdock/protocol";
// Type only: the module is loaded on first use, so unit tests never load the native addon.
import type * as NodePty from "node-pty";
import type { RunResult, TmuxTarget } from "./commands.js";
import { keepaliveArgs } from "./commands.js";
import { CloseQueue, waitUntil } from "./close-queue.js";
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
  /** False until the first output; node-pty defers `kill`, `resize` and `write` until then. */
  _isReady?: boolean;
  _agent?: {
    /** The connection node-pty created for this PTY (the replaced `ConoutConnection`). */
    _conoutSocketWorker?: unknown;
    /** Set once the ConPTY reported the end of the process. */
    exitCode?: number;
    /** node-pty's socket to the relay pipe `<pipe>-worker`; it has no `error` listener until it connected. */
    _outSocket?: { on(event: "error", listener: (error: Error) => void): unknown };
    /** node-pty's socket to the ConPTY input pipe. */
    _inSocket?: { destroy(): void };
  };
}

const agentOf = (terminal: NodePty.IPty) => (terminal as unknown as WindowsTerminalInternals)._agent;
/**
 * Whether node-pty runs `kill` at once: until the first output it queues it (`_deferNoArgs`, windowsTerminal.js).
 * Without the field (another layout) it counts as ready.
 */
const isReady = (terminal: NodePty.IPty) =>
  (terminal as unknown as WindowsTerminalInternals)._isReady !== false;

/**
 * A PTY of `spawnConpty`; `pid` is the process it runs. `kill` only queues the close: the PTYs of this process are
 * closed one after the other, each until its process ended (#160).
 */
export type ConptyProcess = PtyProcess & { readonly pid: number; closed(): Promise<void> };

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
  return connection instanceof ConoutConnection
    ? endOnLoss(terminal, connection)
    : withQueuedKill(terminal, closerOf(terminal));
}

/** Longest wait, after a PTY was closed, for its process to end before the next PTY is closed (#160). */
const PTY_END_WAIT_MS = 2_000;
/** Longest further wait after `process.kill`, when the process outlived the close. */
const PTY_KILL_WAIT_MS = 500;
/**
 * Longest wait of `ptysClosed` for all closes. A core that ends waits for its PTYs, so a hanging PTY or a great many
 * of them delay its end by at most this much.
 */
export const PTYS_CLOSED_TIMEOUT_MS = 15_000;
/**
 * Longest wait, after node-pty reported an end without exit code, for the ConPTY to report the exit code. Its output
 * socket may close before the process exit is reported; without exit code after this the process counts as alive
 * and is closed.
 */
const EXIT_CODE_WAIT_MS = 1_000;
/**
 * Every close of a ConPTY of this process, one after the other, each until its process ended (at most
 * `PTY_END_WAIT_MS` plus `PTY_KILL_WAIT_MS`). Several ConPTY processes ending at the same moment crash node-pty 1.1.0
 * now and then (#160): its exit threads remove their entries from one shared list without a lock (conpty.cc).
 */
const closes = new CloseQueue((error) =>
  process.stderr.write(
    `termdock-core: closing a PTY failed: ${error instanceof Error ? error.message : String(error)}\n`,
  ),
);

/**
 * Resolves true once every PTY of this process whose close has started has ended, or its wait gave up; false after
 * `timeoutMs`. The core waits for it before it ends: an exit of the process in the middle of the closes would end the
 * rest at once.
 */
export function ptysClosed(timeoutMs = PTYS_CLOSED_TIMEOUT_MS): Promise<boolean> {
  return closes.idle(timeoutMs);
}

function endProcess(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
}

/** The close of one ConPTY through `closes`. */
interface Closer {
  /** Queues the close; once only. */
  kill(): void;
  /** node-pty's own `kill`, at most once and only before the exit code. */
  killNative(): void;
  /** After `kill`: resolves once the process ended or the wait for it gave up; at once without `kill`. */
  closed(): Promise<void>;
  processEnded(): boolean;
}

function closerOf(terminal: NodePty.IPty): Closer {
  const processEnded = () => agentOf(terminal)?.exitCode !== undefined;
  let nativeKilled = false;
  let closing: Promise<void> | undefined;
  const killNative = () => {
    // Once only: a second `kill` would close the same ConPTY again (`PtyKill` has no guard). Not after the exit code
    // either: node-pty's exit thread has released the native handle by then.
    if (nativeKilled || processEnded()) return;
    nativeKilled = true;
    terminal.kill();
  };
  return {
    processEnded,
    killNative,
    kill: () => {
      closing ??= closes.add(async () => {
        if (processEnded()) return;
        // Before the first output node-pty defers its own `kill` and would run it later, maybe while the exit thread
        // releases the native handle (see `close` in `endOnLoss`): then the process alone.
        if (isReady(terminal)) {
          try {
            killNative();
          } catch (error) {
            void process.stderr.write(
              `termdock-core: kill of a PTY failed: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
          if (await waitUntil(processEnded, PTY_END_WAIT_MS)) return;
        }
        // Not ready, the kill failed or the ConPTY did not end its process: the process itself, so it does not outlive
        // the core, and the input pipe, which with `useConptyDll` only node-pty's own `kill` closes. The next close
        // must not wait for it any longer.
        endProcess(terminal.pid);
        agentOf(terminal)?._inSocket?.destroy();
        await waitUntil(processEnded, PTY_KILL_WAIT_MS);
      });
    },
    closed: () => closing ?? Promise.resolve(),
  };
}

/** `terminal` with its `kill` through `closes` (node-pty without the shared reader). */
function withQueuedKill(terminal: NodePty.IPty, closer: Closer): ConptyProcess {
  return {
    get pid() {
      return terminal.pid;
    },
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    kill: closer.kill,
    closed: closer.closed,
    onData: (listener) => terminal.onData(listener),
    onExit: (listener) => terminal.onExit(listener),
  };
}

/**
 * `terminal`, closed when its output is lost. Its end is reported once, only when its process has ended, with the exit
 * code the ConPTY reported (-1 if it reported none in time). node-pty reports an end as soon as its output socket
 * closes, which a lost worker does while the process still runs; reported then, the registry would attach a second
 * tmux client while the first still lives.
 */
function endOnLoss(terminal: NodePty.IPty, connection: ConoutConnection): ConptyProcess {
  let ended = false;
  let closing = false;
  const closer = closerOf(terminal);
  const { processEnded } = closer;
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  const end = () => {
    if (ended) return;
    ended = true;
    const event = { exitCode: agentOf(terminal)?.exitCode ?? -1 };
    for (const listener of [...exitListeners]) listener(event);
  };
  const close = () => {
    if (closing || ended) return;
    closing = true;
    // Through the same queue as every other close (#160); a lost worker closes every PTY at once.
    void closes.add(async () => {
      // Only while no exit code is known. node-pty's exit thread closes the process handle (`CloseHandle(hShell)`,
      // conpty.cc) just before it reports the exit code, so in that short window the PID may already be free and,
      // in theory, reused; accepted, the window is a few milliseconds. The process alone, not node-pty's `kill`:
      // that runs `ClosePseudoConsole` on the native handle while the exit thread, woken by this very end of the
      // process, releases it (crashed the test process), and node-pty defers it until the first output, which may
      // never come without the worker. The ConPTY ends with its process (node-pty released it after the start).
      try {
        if (!processEnded()) endProcess(terminal.pid);
        if (!(await waitUntil(processEnded, PTY_END_WAIT_MS))) {
          // The process did not end (e.g. no right to end it): node-pty's `kill` as the last resort.
          try {
            closer.killNative();
          } catch {
            // node-pty may have closed it already.
          }
        }
        // The input pipe stays open otherwise: with `useConptyDll` node-pty cleans up only on its own `kill`.
        agentOf(terminal)?._inSocket?.destroy();
      } finally {
        // Once in any case, so the registry does not wait for an end that never comes.
        end();
      }
    });
  };
  terminal.onExit(() => {
    if (processEnded()) {
      end();
      return;
    }
    // The output socket closed first: wait for the exit code, or close the process if it does not come.
    void (async () => {
      await waitUntil(() => processEnded() || closing, EXIT_CODE_WAIT_MS, 25);
      if (processEnded()) end();
      else close();
    })();
  });
  connection.onLost(close);
  // A failed relay connection (e.g. another local client took `<pipe>-worker` first, so node-pty's connect ends in
  // ERROR_PIPE_BUSY/ETIMEDOUT) is a lost output too. Without a listener the `error` would crash the core; with it,
  // node-pty's own listener (added after connect) also no longer rethrows.
  agentOf(terminal)?._outSocket?.on("error", (error) => {
    void process.stderr.write(`termdock-core: conout reader: output of a PTY failed: ${error.message}\n`);
    close();
  });
  return {
    get pid() {
      return terminal.pid;
    },
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    kill: closer.kill,
    closed: closer.closed,
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
