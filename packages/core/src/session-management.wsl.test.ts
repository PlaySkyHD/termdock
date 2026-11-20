// Archive and delete against real WSL and tmux (issue #57): no tmux session outlives an archived or deleted
// session. Only with TERMDOCK_WSL_TESTS=1 (local, not in CI); own socket `termdock-test-<pid>-<nonce>`.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "@termdock/protocol";
import { runWsl } from "./backend/wsl/processes.js";
import { runCore } from "./bin/run-core.js";
import type { RunCoreResult } from "./bin/run-core.js";
import { connect } from "./ipc/client.js";
import type { CoreClient } from "./ipc/client.js";
import { historyDir } from "./storage/history-store.js";
import { cleanStaleWslTestServers, killWslTestServer, wslTestSocket } from "./test/wsl-socket.js";

// A socket of its own: parallel runs (other worktrees) must not remove our sessions (#147).
const SOCKET = wslTestSocket();
const enabled = process.env.TERMDOCK_WSL_TESTS === "1";

const cores: RunCoreResult[] = [];
const clients: CoreClient[] = [];
const tempDirs: string[] = [];
const distros = new Set<string>();
const usedDistros = new Set<string>();

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

  afterAll(async () => {
    // The socket belongs to this file alone: end its server, then the servers of aborted runs.
    for (const distro of usedDistros) {
      await killWslTestServer(distro, SOCKET).catch(() => {});
      await cleanStaleWslTestServers(distro);
    }
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close();
    for (const core of cores.splice(0)) await core.close?.();
    for (const distro of distros) {
      const sessions = await tmux(distro, ["list-sessions", "-F", "#{session_name}"]);
      for (const name of sessions.stdout.split("\n").filter((line) => line.startsWith("td-"))) {
        await tmux(distro, ["kill-session", "-t", `=${name}`]);
      }
    }
    for (const distro of distros) usedDistros.add(distro);
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

  it("deletes a session with recorded history after a core restart; a third core finds nothing (issue #135)", async () => {
    freshDataDir();
    await startCore();
    const c1 = await client();
    const { session } = (
      await c1.request("session.create", {
        name: "history",
        launch: {
          backend: "wsl",
          cwd: "/tmp",
          command: ["sh", "-c", "echo td-test-history; exec sleep 600"],
        },
      })
    ).result;
    const distro = session.launch.distro!;
    distros.add(distro);
    await waitFor(() => hasSession(distro, session.id), "tmux session");
    const dir = historyDir(dataDir, session.id);
    // The core keeps the session's output; closing it flushes the history to the disk.
    await c1.request("session.attach", { sessionId: session.id });
    await waitFor(
      async () => (await c1.request("history.search", { query: "td-test-history" })).result.hits.length > 0,
      "recorded history",
    );
    await c1.close();
    await cores.pop()!.close?.();
    expect(existsSync(dir)).toBe(true);

    await startCore();
    const c2 = await client();
    expect((await c2.request("session.list", {})).result.sessions[0]?.state).toBe("Detached");
    await c2.request("session.kill", { sessionId: session.id });
    await c2.request("session.delete", { sessionId: session.id });
    expect(existsSync(dir)).toBe(false);
    expect(await hasSession(distro, session.id)).toBe(false);
    await c2.close();
    await cores.pop()!.close?.();

    await startCore();
    const c3 = await client();
    expect((await c3.request("session.list", {})).result.sessions).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  }, 120_000);

  it("keeps an env value of a session out of answers and core.log, also with a missing cwd (issue #135)", async () => {
    freshDataDir();
    const secret = "td-test-secret-0000";
    await startCore();
    const c = await client();
    const { session } = (
      await c.request("session.create", {
        name: "env",
        launch: {
          backend: "wsl",
          cwd: "/td-test-missing-dir",
          command: ["sh", "-c", "exec sleep 600"],
          env: { TD_TEST_VALUE: secret },
        },
      })
    ).result;
    distros.add(session.launch.distro!);
    expect(session.warnings).toEqual([expect.objectContaining({ code: "cwd_missing" })]);
    expect(JSON.stringify(session.warnings)).not.toContain(secret);
    const refused = await c
      .request("session.create", {
        name: "token",
        launch: { backend: "wsl", cwd: "/tmp", env: { TD_TEST_TOKEN: secret } },
      })
      .catch((error: unknown) => error as Error);
    expect(String((refused as Error).message)).toContain("TD_TEST_TOKEN");
    expect(String((refused as Error).message)).not.toContain(secret);
    await c.request("session.kill", { sessionId: session.id });
    await c.close();
    await cores.pop()!.close?.();
    const log = join(dataDir, "logs", "core.log");
    if (existsSync(log)) expect(readFileSync(log, "utf8")).not.toContain(secret);
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
