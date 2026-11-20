// A tmux socket of its own for each WSL integration test file (#147). Tests on the shared socket `termdock-test`
// removed every `td-*` session there after each test, so two worktrees running the WSL tests at the same time
// ended each other's sessions. The name has the form of the screenshot runs, `termdock-test-<pid>-<nonce>`, so the
// screenshot cleanup of aborted runs (`cleanStaleSockets` in the desktop app) removes leftovers as well.
import { randomBytes } from "node:crypto";
import { runWsl } from "../backend/wsl/processes.js";

/** Socket names of this form belong to a run (test file or screenshot run) of the process `<pid>`. */
const RUN_SOCKET = /^termdock-test-(\d+)-[0-9a-f]+$/;

/** A new socket name for one test file; unique per process and call. Never `termdock` or `termdock-test`. */
export function wslTestSocket(pid: number = process.pid): string {
  return `termdock-test-${pid}-${randomBytes(4).toString("hex")}`;
}

/** The pid in a run socket name, or undefined for any other name (`termdock`, `termdock-test`, other sockets). */
export function socketRunPid(name: string): number | undefined {
  const match = RUN_SOCKET.exec(name);
  return match ? Number(match[1]) : undefined;
}

/** Names in `names` of run sockets whose process has ended; the socket of `ownPid` and of live processes stays. */
export function staleWslTestSockets(
  names: readonly string[],
  ownPid: number,
  isAlive: (pid: number) => boolean,
): string[] {
  return names.filter((name) => {
    const pid = socketRunPid(name);
    return pid !== undefined && pid !== ownPid && !isAlive(pid);
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user or runs elevated.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const TMUX_TIMEOUT_MS = 15_000;
const NO_SERVER = /no server running|error connecting/;

/**
 * Ends the tmux server on `socket` (and with it the sessions) in `distro`. Only for run sockets: any other name,
 * above all `termdock` and `termdock-test`, is refused. A socket without a server is fine.
 */
export async function killWslTestServer(distro: string, socket: string): Promise<void> {
  if (socketRunPid(socket) === undefined) throw new Error(`not a WSL test socket: ${socket}`);
  const result = await runWsl(["-d", distro, "--cd", "~", "--exec", "tmux", "-L", socket, "kill-server"], {
    timeoutMs: TMUX_TIMEOUT_MS,
  });
  if (result.code !== 0 && !NO_SERVER.test(result.stderr)) {
    throw new Error(`tmux kill-server on ${socket} failed (${result.code}): ${result.stderr.trim()}`);
  }
}

/**
 * Ends the tmux servers that aborted runs left behind: sockets `termdock-test-<pid>-<nonce>` of ended processes.
 * Best effort, never rejects. Returns the sockets it ended.
 */
export async function cleanStaleWslTestServers(
  distro: string,
  ownPid: number = process.pid,
  isAlive: (pid: number) => boolean = processAlive,
): Promise<string[]> {
  const ended: string[] = [];
  try {
    // Sockets live in `/tmp/tmux-<uid>/`; `find` matches the directory without knowing the uid. It exits 1 for
    // unreadable folders but still lists the rest.
    const listed = await runWsl(
      [
        "-d",
        distro,
        "--cd",
        "~",
        "--exec",
        "find",
        "/tmp",
        "-maxdepth",
        "2",
        "-path",
        "/tmp/tmux-*/termdock-test-*",
        "-type",
        "s",
        "-printf",
        "%f\\n",
      ],
      { timeoutMs: TMUX_TIMEOUT_MS },
    );
    const names = listed.stdout.split("\n").filter((line) => line !== "");
    for (const socket of staleWslTestSockets(names, ownPid, isAlive)) {
      try {
        await killWslTestServer(distro, socket);
        ended.push(socket);
      } catch {
        // Best effort; the next run tries again.
      }
    }
  } catch {
    // WSL does not answer: nothing to clean.
  }
  return ended;
}
