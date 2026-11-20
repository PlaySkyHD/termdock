// Failure scenario "the tmux server dies" against real WSL and tmux (issue #133). Only with TERMDOCK_WSL_TESTS=1
// (local, not in CI). The server is ended with `kill-server` on the socket of this file alone (`wslTestSocket()`),
// never on `termdock`; WSL itself keeps running.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { LaunchSpec, SessionId, SessionState } from "@termdock/protocol";
import { WslBackend } from "./backend/wsl/backend.js";
import { runWsl } from "./backend/wsl/processes.js";
import { runCore } from "./bin/run-core.js";
import type { RunCoreResult } from "./bin/run-core.js";
import { connect, IpcError } from "./ipc/client.js";
import type { CoreClient } from "./ipc/client.js";
import { SessionRegistry } from "./session/registry.js";
import { cleanStaleWslTestServers, killWslTestServer, wslTestSocket } from "./test/wsl-socket.js";

const SOCKET = wslTestSocket();
const enabled = process.env.TERMDOCK_WSL_TESTS === "1";
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const execFileAsync = promisify(execFile);

const cores: RunCoreResult[] = [];
const clients: CoreClient[] = [];
const registries: SessionRegistry[] = [];
const backends: WslBackend[] = [];
const tempDirs: string[] = [];
const usedDistros = new Set<string>();

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}

/** Linux processes whose command line names the socket of this file: tmux clients, keepalives, the server. */
async function linuxProcessesOnSocket(distro: string): Promise<string[]> {
  const result = await runWsl(
    ["-d", distro, "--cd", "~", "--exec", "pgrep", "-a", "-f", "--", `-L ${SOCKET}`],
    {
      timeoutMs: 15_000,
    },
  );
  return result.stdout.split("\n").filter((line) => line.trim() !== "");
}

/** Windows `wsl.exe` processes whose command line names the socket: the PTYs and keepalives of the core. */
async function windowsProcessesOnSocket(): Promise<string[]> {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='wsl.exe'\" | ForEach-Object { $_.CommandLine }";
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      timeout: 30_000,
      windowsHide: true,
    },
  );
  return stdout.split(/\r?\n/).filter((line) => line.includes(SOCKET));
}

describe.skipIf(!enabled)("the tmux server dies while sessions run (issue #133)", () => {
  afterAll(async () => {
    for (const distro of usedDistros) {
      await killWslTestServer(distro, SOCKET).catch(() => {});
      await cleanStaleWslTestServers(distro);
    }
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close();
    for (const core of cores.splice(0)) await core.close?.();
    for (const registry of registries.splice(0)) registry.dispose();
    for (const backend of backends.splice(0)) await backend.dispose();
    for (const distro of usedDistros) await killWslTestServer(distro, SOCKET).catch(() => {});
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it("[V1-09] makes every session Interrupted, tells the attached views and leaves no PTY behind", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "termdock-failure-"));
    tempDirs.push(dataDir);
    const pipePath = `\\\\.\\pipe\\termdock-failure-${randomUUID()}`;
    const core = await runCore({
      pipePath,
      dataDir,
      tmuxSocket: SOCKET,
      installSignalHandlers: false,
      stderr: { write: () => {} },
    });
    expect(core.exitCode).toBe(0);
    cores.push(core);
    const c = await connect(pipePath, { requestTimeoutMs: 30_000 });
    clients.push(c);
    const states = new Map<SessionId, SessionState>();
    c.on("session.stateChanged", (event) => states.set(event.sessionId, event.state));
    await c.request("session.list", {});

    const ids: SessionId[] = [];
    const views: string[] = [];
    let distro = "";
    for (const name of ["first", "second"]) {
      const { session } = (
        await c.request("session.create", { name, launch: { backend: "wsl", cwd: "/tmp" } })
      ).result;
      distro = session.launch.distro!;
      usedDistros.add(distro);
      ids.push(session.id);
      views.push((await c.request("session.attach", { sessionId: session.id })).result.viewId);
    }
    let output = "";
    c.on("session.output", (_event, payload) => (output += decoder.decode(payload)));
    await c.request("session.input", { viewId: views[0]! }, encoder.encode("echo alive-$((6*7))\r"));
    await waitFor(() => output.includes("alive-42"), "output of the first session");
    expect(await windowsProcessesOnSocket()).not.toEqual([]);

    await killWslTestServer(distro, SOCKET);

    await waitFor(
      () => ids.every((id) => states.get(id) === "Interrupted"),
      `both sessions Interrupted (now ${JSON.stringify([...states])})`,
    );
    const listed = (await c.request("session.list", {})).result.sessions;
    expect(listed.map((session) => session.state)).toEqual(["Interrupted", "Interrupted"]);
    // The views stay attached but have no process to write to.
    const refused = await c
      .request("session.input", { viewId: views[0]! }, encoder.encode("echo lost\r"))
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(IpcError);
    expect((refused as IpcError).code).toBe("invalid_state");
    // No tmux client, keepalive or server on the socket, and no wsl.exe of a PTY or keepalive on Windows.
    await waitFor(
      async () => (await linuxProcessesOnSocket(distro)).length === 0,
      "no process on the socket",
    );
    await waitFor(async () => (await windowsProcessesOnSocket()).length === 0, "no wsl.exe on the socket");
    // Stays so: no keepalive is restarted for the lost sessions.
    await sleep(3_000);
    expect(await windowsProcessesOnSocket()).toEqual([]);
  }, 120_000);

  it("[V1-09] starts an Interrupted session again after the server died, with its view as writer", async () => {
    const backend = new WslBackend({ socket: SOCKET });
    backends.push(backend);
    // The redraw after the attach may still run when the server dies; its failure is expected here.
    const registry = new SessionRegistry({ backends: [backend], onRedrawError: () => {} });
    registries.push(registry);
    const launch: LaunchSpec = { backend: "wsl", cwd: "/tmp" };
    const session = await registry.create({ name: "phoenix", launch });
    const distro = session.launch.distro!;
    usedDistros.add(distro);
    let output = "";
    registry.onOutput(({ data }) => (output += decoder.decode(data)));
    await registry.attachView(session.id, "view-1");

    await killWslTestServer(distro, SOCKET);
    await waitFor(() => registry.get(session.id).state === "Interrupted", "Interrupted");
    expect(registry.get(session.id).writerViewId).toBe("view-1");

    const restarted = await registry.restart(session.id);
    expect(restarted.state).toBe("Running");
    expect(restarted.writerViewId).toBe("view-1");
    registry.input(session.id, "view-1", "echo back-$((6*8))\r");
    await waitFor(() => output.includes("back-48"), "output after the restart");
    const has = await runWsl(
      ["-d", distro, "--cd", "~", "--exec", "tmux", "-L", SOCKET, "has-session", "-t", `=td-${session.id}`],
      { timeoutMs: 15_000 },
    );
    expect(has.code).toBe(0);
  }, 120_000);
});
