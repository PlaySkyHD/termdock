// node-pty ConPTYs of this process: the shared output reader (ADR 0008), the close queue (#160) and the input pipe
// (#177). Both backends start their PTYs here: WSL its tmux clients, Windows its shells.
import type { TerminalSize } from "@termdock/protocol";
// Type only: the module is loaded on first use, so unit tests never load the native addon.
import type * as NodePty from "node-pty";
import { CloseQueue, waitUntil } from "./close-queue.js";
import { ConoutConnection, ConoutReader, installConoutReader } from "./conout-reader.js";
import type { PtyProcess, PtyProcessExit } from "./pty.js";

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

/**
 * Starts `file <args>` in a ConPTY whose output the shared reader drains (ADR 0008), with node-pty 1.1.0 and the
 * bundled ConPTY (`useConptyDll`). `args` is an argument array; node-pty quotes each one for the command line, no
 * shell reads it. `env` defaults to the environment of the core. Waits for the reader's worker first: node-pty blocks
 * the main thread in `ConnectNamedPipe` until the worker has opened the output pipe. When the worker ends
 * unexpectedly, the PTY is closed (its process ends) and reports its end once, with `lost`; for a tmux client the
 * registry then re-attaches as after a lost client (ADR 0003).
 */
export async function spawnConpty(
  file: string,
  args: readonly string[],
  size: TerminalSize,
  cwd: string,
  env: Readonly<Record<string, string>> = process.env as Record<string, string>,
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
      env: { ...env },
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
  if (connection instanceof ConoutConnection) return endOnLoss(terminal, connection);
  // node-pty with its own worker per PTY: the input pipe is closed at the reported end as well (#177).
  terminal.onExit(() => agentOf(terminal)?._inSocket?.destroy());
  return withQueuedKill(terminal, closerOf(terminal));
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

/** Closes of PTYs queued or running right now. */
export function pendingPtyCloses(): number {
  return closes.size;
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
 * code the ConPTY reported (-1 if it reported none in time) and `lost` when the core closed it for the loss. node-pty
 * reports an end as soon as its output socket closes, which a lost worker does while the process still runs; reported
 * then, the registry would attach a second tmux client while the first still lives.
 */
function endOnLoss(terminal: NodePty.IPty, connection: ConoutConnection): ConptyProcess {
  let ended = false;
  let closing = false;
  const closer = closerOf(terminal);
  const { processEnded } = closer;
  const exitListeners = new Set<(event: PtyProcessExit) => void>();
  const end = (lost: boolean) => {
    if (ended) return;
    ended = true;
    // The input pipe stays open otherwise (#177): with `useConptyDll` node-pty closes it only in its own `kill`, and a
    // PTY that ended by itself is never killed. Its process has ended, no input can reach it any more.
    agentOf(terminal)?._inSocket?.destroy();
    const event: PtyProcessExit = { exitCode: agentOf(terminal)?.exitCode ?? -1 };
    if (lost) event.lost = true;
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
      // A process that ended by itself before the close (`exit 3` at the moment of the loss) keeps its exit code.
      let endedByCore = false;
      try {
        if (!processEnded()) {
          endedByCore = true;
          endProcess(terminal.pid);
        }
        if (!(await waitUntil(processEnded, PTY_END_WAIT_MS))) {
          // The process did not end (e.g. no right to end it): node-pty's `kill` as the last resort.
          try {
            closer.killNative();
          } catch {
            // node-pty may have closed it already.
          }
        }
      } finally {
        // The relay in the worker as well (#177), without relying on `closeWhenDrained`, which waits until the client of
        // `<pipe>-worker` (node-pty or a foreign one) has gone. After a lost worker nothing is left to close.
        connection.close();
        // Once in any case, so the registry does not wait for an end that never comes. It closes the input pipe.
        end(endedByCore);
      }
    });
  };
  terminal.onExit(() => {
    // A close for a lost output runs: it reports the end itself, as lost, once the process is gone.
    if (closing) return;
    if (processEnded()) {
      end(false);
      return;
    }
    // The output socket closed first: wait for the exit code, or close the process if it does not come.
    void (async () => {
      await waitUntil(() => processEnded() || closing, EXIT_CODE_WAIT_MS, 25);
      if (closing) return;
      if (processEnded()) end(false);
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
 * `error` listener. Input that arrives after the process ended but before its exit is reported fails
 * asynchronously with `EAGAIN` and would crash the core as an uncaught exception. The input is lost either
 * way; the exit follows.
 */
function ignoreInputErrors(terminal: NodePty.IPty): void {
  const agent = (
    terminal as unknown as { _agent?: { inSocket?: { on(event: "error", fn: () => void): void } } }
  )._agent;
  agent?.inSocket?.on("error", () => {});
}
