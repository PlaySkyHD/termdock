// The WSL keepalive survives a killed core and is taken over by the next one (issue #140). Only with
// TERMDOCK_WSL_TESTS=1 (local, not in CI). Each core runs as its own process from `dist/bin/termdock-core.js` (built
// by `npm run typecheck`, like the desktop app runs it) on its own pipe, data directory and tmux socket
// (`wslTestSocket()`, #147); the test kills it by its process id like the installer or the Task Manager.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWsl } from "./backend/wsl/processes.js";
import { connect } from "./ipc/client.js";
import type { CoreClient } from "./ipc/client.js";
import { cleanStaleWslTestServers, killWslTestServer, wslTestSocket } from "./test/wsl-socket.js";

const enabled = process.env.TERMDOCK_WSL_TESTS === "1";
const SOCKET = wslTestSocket();
const ENTRY = fileURLToPath(new URL("../dist/bin/termdock-core.js", import.meta.url));
const KEEPALIVE = `tmux -L ${SOCKET} wait-for termdock-keepalive`;

describe.skipIf(!enabled)("WSL keepalive after the end of the core (issue #140)", () => {
  const pipePath = `\\\\.\\pipe\\termdock-keepalive-test-${randomUUID()}`;
  let dataDir = "";
  const cores: ChildProcess[] = [];
  const clients: CoreClient[] = [];
  let distro: string | undefined;

  const wsl = (args: string[]) => runWsl(["--cd", "~", "--exec", ...args], { timeoutMs: 15_000 });
  const tmux = (args: string[]) =>
    runWsl(["-d", distro!, "--cd", "~", "--exec", "tmux", "-L", SOCKET, ...args], { timeoutMs: 15_000 });
  /** Linux process ids of the keepalives of this socket; the wsl.exe of each ends with it. */
  const keepalivePids = async (): Promise<string[]> => {
    const result = await runWsl(["-d", distro!, "--cd", "~", "--exec", "pgrep", "-x", "-f", KEEPALIVE], {
      timeoutMs: 15_000,
    });
    return result.stdout.split("\n").filter((line) => line.trim() !== "");
  };
  const keepalives = async (): Promise<number> => (await keepalivePids()).length;

  async function startCore(): Promise<CoreClient> {
    const core = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        TERMDOCK_PIPE: pipePath,
        TERMDOCK_DATA_DIR: dataDir,
        TERMDOCK_TMUX_SOCKET: SOCKET,
      },
      stdio: "ignore",
      windowsHide: true,
    });
    cores.push(core);
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const client = await connect(pipePath, { clientKind: "cli", requestTimeoutMs: 60_000 });
        clients.push(client);
        // Waits for the reconcile: every request but `hello` is held until it is done.
        await client.request("session.list", {});
        return client;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await sleep(200);
      }
    }
  }

  /** Ends the core like the installer or the Task Manager: TerminateProcess, no shutdown request. */
  async function killCore(): Promise<void> {
    const core = cores.at(-1)!;
    const exited = new Promise((resolve) => core.once("exit", resolve));
    core.kill();
    await exited;
    for (const client of clients.splice(0)) client.close();
  }

  async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(250);
    }
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "termdock-keepalive-"));
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const core of cores.splice(0)) if (core.exitCode === null && core.signalCode === null) core.kill();
    // The socket belongs to this file alone; its server ends together with every keepalive waiting on it.
    if (distro) {
      await killWslTestServer(distro, SOCKET);
      await cleanStaleWslTestServers(distro);
    } else {
      // A run that failed before it learned the distro still leaves the server of the default distro behind.
      await wsl(["tmux", "-L", SOCKET, "kill-server"]);
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("keeps the session alive after a kill, and N restarts leave exactly one keepalive", async () => {
    expect(existsSync(ENTRY), `${ENTRY} missing: run npm run typecheck first`).toBe(true);
    const first = await startCore();
    const { session } = (
      await first.request("session.create", { name: "keepalive", launch: { backend: "wsl", cwd: "/tmp" } })
    ).result;
    distro = session.launch.distro!;
    const name = `=td-${session.id}`;
    await waitFor(async () => (await tmux(["has-session", "-t", name])).code === 0, "the tmux session");
    await waitFor(async () => (await keepalives()) === 1, "the first keepalive");

    // A keepalive started before `new-session` created the server ends at once and is restarted after 1 s.
    await sleep(3_000);
    const firstPids = await keepalivePids();
    expect(firstPids).toHaveLength(1);
    let [previous] = firstPids;
    await killCore();
    // Other wsl.exe processes (the user's core) may keep the distro running anyway; the keepalive that is still
    // the same process shows that the core's own one survived.
    await sleep(30_000);
    expect(await keepalivePids()).toEqual([previous]);
    expect((await tmux(["has-session", "-t", name])).code).toBe(0);

    for (let restart = 1; restart <= 3; restart++) {
      const client = await startCore();
      const [found] = (await client.request("session.list", {})).result.sessions;
      expect(found).toMatchObject({ id: session.id, state: "Detached" });
      // The reconcile found the session; the new core ends the old keepalive, then starts its own.
      await waitFor(
        async () => {
          const pids = await keepalivePids();
          return pids.length === 1 && pids[0] !== previous;
        },
        `the keepalive of core ${restart + 1}`,
      );
      await sleep(2_000);
      const pids = await keepalivePids();
      expect(pids).toHaveLength(1);
      previous = pids[0];
      await killCore();
    }
    expect(await keepalivePids()).toEqual([previous]);

    // A clean shutdown without stop hands its keepalive over as well.
    const clean = await startCore();
    await waitFor(async () => {
      const pids = await keepalivePids();
      return pids.length === 1 && pids[0] !== previous;
    }, "the keepalive of the clean core");
    [previous] = await keepalivePids();
    const ended = new Promise((resolve) => cores.at(-1)!.once("exit", resolve));
    await clean.request("core.shutdown", {});
    await ended;
    await sleep(2_000);
    expect(await keepalivePids()).toEqual([previous]);
    expect((await tmux(["has-session", "-t", name])).code).toBe(0);
    for (const client of clients.splice(0)) client.close();

    // A clean shutdown that stops the sessions leaves no keepalive behind.
    const last = await startCore();
    await last.request("core.shutdown", { stopSessions: true });
    await waitFor(async () => (await keepalives()) === 0, "no keepalive after stopSessions");
    expect((await tmux(["has-session", "-t", name])).code).not.toBe(0);
  }, 180_000);

  it("ends a left-behind keepalive together with the tmux server (review PR #148)", async () => {
    expect(existsSync(ENTRY), `${ENTRY} missing: run npm run typecheck first`).toBe(true);
    const client = await startCore();
    const { session } = (
      await client.request("session.create", { name: "orphan", launch: { backend: "wsl", cwd: "/tmp" } })
    ).result;
    distro = session.launch.distro!;
    const name = `=td-${session.id}`;
    await waitFor(async () => (await tmux(["has-session", "-t", name])).code === 0, "the tmux session");
    await waitFor(async () => (await keepalives()) === 1, "the keepalive");
    await killCore();
    expect(await keepalives()).toBe(1);

    // The only session of the socket ends without a core: the server exits and wakes its waiting clients first.
    expect((await tmux(["kill-session", "-t", name])).code).toBe(0);
    await waitFor(
      async () => (await keepalives()) === 0,
      "the keepalive to end with the tmux server",
      15_000,
    );
  }, 120_000);
});
