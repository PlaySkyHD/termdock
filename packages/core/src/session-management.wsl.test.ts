// Archive and delete against real WSL and tmux (issue #57): no tmux session outlives an archived or deleted
// session. Only with TERMDOCK_WSL_TESTS=1 (local, not in CI); socket `termdock-test`.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "@termdock/protocol";
import { runWsl } from "./backend/wsl/processes.js";
import { runCore } from "./bin/run-core.js";
import type { RunCoreResult } from "./bin/run-core.js";
import { connect } from "./ipc/client.js";
import type { CoreClient } from "./ipc/client.js";
import { historyDir } from "./storage/history-store.js";

const SOCKET = "termdock-test";
const enabled = process.env.TERMDOCK_WSL_TESTS === "1";

const cores: RunCoreResult[] = [];
const clients: CoreClient[] = [];
const tempDirs: string[] = [];
const distros = new Set<string>();

async function tmux(distro: string, args: string[]) {
  return runWsl(["-d", distro, "--cd", "~", "--exec", "tmux", "-L", SOCKET, ...args], { timeoutMs: 15_000 });
}

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function hasSession(distro: string, sessionId: string): Promise<boolean> {
  return (await tmux(distro, ["has-session", "-t", `=td-${sessionId}`])).code === 0;
}

describe.skipIf(!enabled)("session management against WSL (issue #57)", () => {
  const pipePath = `\\\\.\\pipe\\termdock-manage-${randomUUID()}`;
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

  async function create(c: CoreClient): Promise<SessionInfo> {
    const { session } = (
      await c.request("session.create", { name: "manage", launch: { backend: "wsl", cwd: "/tmp" } })
    ).result;
    distros.add(session.launch.distro!);
    return session;
  }

  function writeHistory(sessionId: string): string {
    const dir = historyDir(dataDir, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.log"), "output");
    return dir;
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close();
    for (const core of cores.splice(0)) await core.close?.();
    for (const distro of distros) {
      const sessions = await tmux(distro, ["list-sessions", "-F", "#{session_name}"]);
      for (const name of sessions.stdout.split("\n").filter((line) => line.startsWith("td-"))) {
        await tmux(distro, ["kill-session", "-t", `=${name}`]);
      }
    }
    distros.clear();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function freshDataDir(): void {
    dataDir = mkdtempSync(join(tmpdir(), "termdock-manage-"));
    tempDirs.push(dataDir);
  }

  it("archives a running session: tmux session gone, history kept; then deletes it with its history", async () => {
    freshDataDir();
    await startCore();
    const c = await client();
    const session = await create(c);
    const distro = session.launch.distro!;
    await waitFor(() => hasSession(distro, session.id), "tmux session");
    const history = writeHistory(session.id);

    await c.request("session.archive", { sessionId: session.id });

    expect(await hasSession(distro, session.id)).toBe(false);
    expect(existsSync(join(history, "a.log"))).toBe(true);
    expect((await c.request("session.list", {})).result.sessions[0]?.state).toBe("Archived");

    await c.request("session.delete", { sessionId: session.id });

    expect(existsSync(history)).toBe(false);
    expect((await c.request("session.list", {})).result.sessions).toEqual([]);
  }, 120_000);

  it("deletes an Interrupted session and ends the tmux session it left behind", async () => {
    freshDataDir();
    await startCore();
    const c1 = await client();
    const session = await create(c1);
    const distro = session.launch.distro!;
    // The PTY exists before tmux has created the session; closing earlier would take it down with the client.
    await waitFor(() => hasSession(distro, session.id), "tmux session");
    // The core ends without stopping the session; the tmux session is lost from outside.
    await c1.close();
    await cores.pop()!.close?.();
    expect((await tmux(distro, ["kill-session", "-t", `=td-${session.id}`])).code).toBe(0);
    await startCore();
    const c2 = await client();
    expect((await c2.request("session.list", {})).result.sessions[0]?.state).toBe("Interrupted");
    // A tmux session under the same name turns up again (e.g. a late client): delete must not leave it behind.
    expect((await tmux(distro, ["new-session", "-d", "-s", `td-${session.id}`])).code).toBe(0);
    const history = writeHistory(session.id);

    await c2.request("session.delete", { sessionId: session.id });

    expect(await hasSession(distro, session.id)).toBe(false);
    expect(existsSync(history)).toBe(false);
    expect((await c2.request("session.list", {})).result.sessions).toEqual([]);
  }, 120_000);
});
