// Autostart against real WSL and tmux with a Core restart (issue #61): an autostart profile gets one tmux
// session, a restarted Core re-attaches it instead of starting a second, and a lost tmux session is started
// again under the same session id. Only with TERMDOCK_WSL_TESTS=1 (local, not in CI); own socket
// `termdock-test-autostart-<nonce>`.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
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

// A socket of its own below `termdock-test`, like the screenshot runs: other worktrees running the WSL tests at
// the same time clean up every `td-*` session on `termdock-test`, which would end ours between two Cores.
const SOCKET = `termdock-test-autostart-${randomUUID().slice(0, 8)}`;
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
  if (listed.code !== 0 && !/no server running|error connecting/.test(listed.stderr)) {
    throw new Error(`tmux list-sessions failed (${listed.code}): ${listed.stderr.trim()}`);
  }
  return listed.stdout.split("\n").filter((line) => line.startsWith("td-"));
}

/**
 * Waits for the tmux session: the backend binds the PTY of `tmux new-session` before tmux has created the
 * session, so `Detached` can come first (as in session-management.wsl.test.ts).
 */
async function waitForSession(distro: string, sessionId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await tdSessions(distro)).includes(`td-${sessionId}`)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for tmux session td-${sessionId}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

  // Between two Cores no wsl.exe of the Core runs; WSL would stop the idle distro together with the tmux server
  // (docs/agent-lessons-learned.md, section 2). The test keeps the default distro awake for its whole run.
  let keepalive: ChildProcess | undefined;

  afterEach(async () => {
    keepalive?.kill();
    keepalive = undefined;
    await closeAll();
    for (const distro of distros) {
      for (const name of await tdSessions(distro)) await tmux(distro, ["kill-session", "-t", `=${name}`]);
      // The socket belongs to this file alone.
      await tmux(distro, ["kill-server"]);
    }
    // A run that failed before it learned the distro still leaves the server of the default distro behind.
    if (distros.size === 0) {
      await runWsl(["--cd", "~", "--exec", "tmux", "-L", SOCKET, "kill-server"], { timeoutMs: 15_000 });
    }
    distros.clear();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("starts an autostart profile once and re-attaches it after a Core restart", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "termdock-autostart-"));
    tempDirs.push(dataDir);
    keepalive = spawn("wsl.exe", ["--cd", "~", "--exec", "sleep", "infinity"], {
      stdio: "ignore",
      windowsHide: true,
    });
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
    await waitForSession(distro, session!.id);
    await closeAll();

    const third = await startCore();
    await third.autostart?.started;
    const c3 = await client();
    const after = (await c3.request("session.list", {})).result.sessions;
    expect(after.map((s) => [s.id, s.state])).toEqual([[session!.id, "Detached"]]);
    expect(third.autostart?.sessions).toEqual([]);
    expect((await tdSessions(distro)).filter((name) => name === `td-${session!.id}`)).toHaveLength(1);
    await closeAll();

    // As after a Windows restart: the tmux session is gone, the reconcile makes the session Interrupted, and
    // the autostart starts it again under the same id instead of adding a new one.
    await tmux(distro, ["kill-session", "-t", `=td-${session!.id}`]);
    const fourth = await startCore();
    await fourth.autostart?.started;
    const c4 = await client();
    const restarted = (await c4.request("session.list", {})).result.sessions;
    expect(restarted.map((s) => [s.id, s.state])).toEqual([[session!.id, "Detached"]]);
    expect(fourth.autostart?.restarted.map((s) => s.id)).toEqual([session!.id]);
    await waitForSession(distro, session!.id);
  });
});
