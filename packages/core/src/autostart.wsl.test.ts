// Autostart against real WSL and tmux with a Core restart (issue #61): an autostart profile gets one tmux
// session, and a restarted Core re-attaches it instead of starting a second. Only with TERMDOCK_WSL_TESTS=1
// (local, not in CI); socket `termdock-test`.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWsl } from "./backend/wsl/processes.js";
import { runCore } from "./bin/run-core.js";
import type { RunCoreResult } from "./bin/run-core.js";
import { connect } from "./ipc/client.js";
import type { CoreClient } from "./ipc/client.js";

const SOCKET = "termdock-test";
const enabled = process.env.TERMDOCK_WSL_TESTS === "1";

const cores: RunCoreResult[] = [];
const clients: CoreClient[] = [];
const tempDirs: string[] = [];
const distros = new Set<string>();

async function tmux(distro: string, args: string[]) {
  return runWsl(["-d", distro, "--cd", "~", "--exec", "tmux", "-L", SOCKET, ...args], { timeoutMs: 15_000 });
}

async function tdSessions(distro: string): Promise<string[]> {
  const listed = await tmux(distro, ["list-sessions", "-F", "#{session_name}"]);
  return listed.stdout.split("\n").filter((line) => line.startsWith("td-"));
}

describe.skipIf(!enabled)("autostart against WSL (issue #61)", () => {
  const pipePath = `\\\\.\\pipe\\termdock-autostart-${randomUUID()}`;
  let dataDir = "";

  async function startCore(): Promise<RunCoreResult> {
    const core = await runCore({
      pipePath,
      dataDir,
      tmuxSocket: SOCKET,
      installSignalHandlers: false,
      stderr: { write: () => {} },
    });
    expect(core.exitCode).toBe(0);
    cores.push(core);
    return core;
  }

  async function client(): Promise<CoreClient> {
    const c = await connect(pipePath, { requestTimeoutMs: 30_000 });
    clients.push(c);
    return c;
  }

  /** Closes the clients and the core without stopping the sessions. */
  async function closeAll(): Promise<void> {
    for (const c of clients.splice(0)) await c.close();
    for (const core of cores.splice(0)) await core.close?.();
  }

  afterEach(async () => {
    await closeAll();
    for (const distro of distros) {
      for (const name of await tdSessions(distro)) await tmux(distro, ["kill-session", "-t", `=${name}`]);
    }
    distros.clear();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("starts an autostart profile once and re-attaches it after a Core restart", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "termdock-autostart-"));
    tempDirs.push(dataDir);
    await startCore();
    const setup = await client();
    const { profile } = (
      await setup.request("profile.create", {
        name: "auto",
        launch: { backend: "wsl", cwd: "/tmp" },
        autostart: true,
      })
    ).result;
    await setup.request("profile.create", { name: "manual", launch: { backend: "wsl", cwd: "/tmp" } });
    expect((await setup.request("session.list", {})).result.sessions).toEqual([]);
    await closeAll();

    const second = await startCore();
    await second.autostart?.started;
    const c2 = await client();
    const [session] = (await c2.request("session.list", {})).result.sessions;
    expect(session).toMatchObject({ name: "auto", profileId: profile.id, state: "Detached" });
    const distro = session!.launch.distro!;
    distros.add(distro);
    expect(await tdSessions(distro)).toContain(`td-${session!.id}`);
    await closeAll();

    const third = await startCore();
    await third.autostart?.started;
    const c3 = await client();
    const after = (await c3.request("session.list", {})).result.sessions;
    expect(after.map((s) => [s.id, s.state])).toEqual([[session!.id, "Detached"]]);
    expect(third.autostart?.sessions).toEqual([]);
    expect((await tdSessions(distro)).filter((name) => name === `td-${session!.id}`)).toHaveLength(1);
  });
});
