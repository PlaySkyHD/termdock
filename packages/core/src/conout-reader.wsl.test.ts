// The shared ConPTY reader crashes while WSL sessions run (issue #153, ADR 0008). Only with TERMDOCK_WSL_TESTS=1
// (local, not in CI). Own tmux socket (`wslTestSocket()`), never `termdock`.
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { LaunchSpec, SessionId } from "@termdock/protocol";
import { WslBackend } from "./backend/wsl/backend.js";
import { conoutReader } from "./backend/conpty/spawn.js";
import { runWsl } from "./backend/wsl/processes.js";
import { SessionRegistry } from "./session/registry.js";
import { cleanStaleWslTestServers, killWslTestServer, wslTestSocket } from "./test/wsl-socket.js";

const SOCKET = wslTestSocket();
const enabled = process.env.TERMDOCK_WSL_TESTS === "1";
const decoder = new TextDecoder();
const execFileAsync = promisify(execFile);

const registries: SessionRegistry[] = [];
const backends: WslBackend[] = [];
const usedDistros = new Set<string>();

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}

/** The tmux clients of a session by pid: a new client may get the tty of one that just ended. */
async function clients(distro: string, id: SessionId): Promise<string[]> {
  const result = await runWsl(
    [
      "-d",
      distro,
      "--cd",
      "~",
      "--exec",
      "tmux",
      "-L",
      SOCKET,
      "list-clients",
      "-t",
      `=td-${id}`,
      "-F",
      "#{client_pid}",
    ],
    { timeoutMs: 15_000 },
  );
  return result.stdout.split("\n").filter((line) => line.trim() !== "");
}

/** Windows `wsl.exe` processes of tmux clients on the socket (PTYs), without the keepalive. */
async function ptyProcessesOnSocket(): Promise<string[]> {
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
  return stdout.split(/\r?\n/).filter((line) => line.includes(SOCKET) && !line.includes("wait-for"));
}

describe.skipIf(!enabled)("the shared ConPTY reader crashes while WSL sessions run (issue #153)", () => {
  afterAll(async () => {
    for (const distro of usedDistros) {
      await killWslTestServer(distro, SOCKET).catch(() => {});
      await cleanStaleWslTestServers(distro);
    }
  });

  afterEach(async () => {
    for (const registry of registries.splice(0)) {
      // Each session ends on its own first: `dispose` would close every PTY in one go, which crashes node-pty 1.1.0
      // now and then (#160, seen here in 1 of 8 runs).
      for (const session of registry.list()) {
        if (session.state === "Running" || session.state === "Detached") {
          await registry.kill(session.id).catch(() => {});
        }
      }
      registry.dispose();
    }
    for (const backend of backends.splice(0)) await backend.dispose();
    for (const distro of usedDistros) await killWslTestServer(distro, SOCKET).catch(() => {});
  });

  it("re-attaches every session once: same state and writer, one tmux client and one PTY each", async () => {
    const backend = new WslBackend({ socket: SOCKET });
    backends.push(backend);
    const registry = new SessionRegistry({ backends: [backend], onRedrawError: () => {} });
    registries.push(registry);
    const launch: LaunchSpec = { backend: "wsl", cwd: "/tmp" };
    const output = new Map<SessionId, string>();
    registry.onOutput(({ sessionId, data }) =>
      output.set(sessionId, (output.get(sessionId) ?? "") + decoder.decode(data)),
    );
    const ids: SessionId[] = [];
    let distro = "";
    for (const name of ["one", "two"]) {
      const session = await registry.create({ name, launch });
      distro = session.launch.distro!;
      usedDistros.add(distro);
      ids.push(session.id);
      await registry.attachView(session.id, `view-${name}`);
      registry.input(session.id, `view-${name}`, `echo up-$((6*7))-${name}\r`);
      await waitFor(() => (output.get(session.id) ?? "").includes(`up-42-${name}`), `output of ${name}`);
    }
    const before = await Promise.all(ids.map((id) => clients(distro, id)));
    expect(before.map((list) => list.length)).toEqual([1, 1]);
    // wsl.exe may run as more than one Windows process per PTY; the number must stay the same.
    const processesBefore = (await ptyProcessesOnSocket()).length;
    expect(processesBefore).toBeGreaterThanOrEqual(2);
    const reader = (await conoutReader())!;
    expect(reader).toBeDefined();
    const states: string[] = [];
    registry.onStateChange(({ to }) => states.push(to));

    await reader.crashWorker();

    // Each session gets a new tmux client in place of the old one, which ended with its PTY.
    for (const [index, id] of ids.entries()) {
      await waitFor(async () => {
        const now = await clients(distro, id);
        return now.length === 1 && now[0] !== before[index]![0];
      }, `a new client for session ${index}`);
    }
    for (const [index, name] of ["one", "two"].entries()) {
      const id = ids[index]!;
      await waitFor(async () => {
        try {
          registry.input(id, `view-${name}`, `echo back-$((6*8))-${name}\r`);
        } catch {
          // Between the lost and the new client the session has no PTY.
        }
        await sleep(500);
        return (output.get(id) ?? "").includes(`back-48-${name}`);
      }, `output of ${name} after the crash`);
    }
    // Stays so: no second client, no second PTY, no lifecycle change.
    await sleep(2_000);
    expect((await Promise.all(ids.map((id) => clients(distro, id)))).map((list) => list.length)).toEqual([
      1, 1,
    ]);
    expect(await ptyProcessesOnSocket()).toHaveLength(processesBefore);
    expect(ids.map((id) => registry.get(id).state)).toEqual(["Running", "Running"]);
    expect(ids.map((id) => registry.get(id).writerViewId)).toEqual(["view-one", "view-two"]);
    expect(states).toEqual([]);
  }, 180_000);
});
