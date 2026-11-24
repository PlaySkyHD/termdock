// Windows sessions through the whole core (issue #65): the core's own backends with a real `cmd.exe`, a real database
// and the pipe. The WSL backend of these cores gets a runner that never calls wsl.exe, so the tests need no WSL and
// run on the Windows CI runner too.
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { LaunchSpec, SessionInfo } from "@termdock/protocol";
import { spawnConpty } from "../backend/conpty/spawn.js";
import { WindowsBackend } from "../backend/windows/backend.js";
import { WslBackend } from "../backend/wsl/backend.js";
import { connect } from "../ipc/client.js";
import type { CoreClient } from "../ipc/client.js";
import { readHistory } from "../storage/history-store.js";
import { runCore } from "./run-core.js";
import type { RunCoreResult } from "./run-core.js";

const onWindows = process.platform === "win32";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "termdock-core-win-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A core with its own backends; the PIDs of the shells it starts land in `pids`. */
async function startCore(
  dataDir: string,
  pipePath: string,
  pids: number[],
): Promise<RunCoreResult & { exited: Promise<number> }> {
  let markExited: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => (markExited = resolve));
  const result = await runCore({
    pipePath,
    dataDir,
    installSignalHandlers: false,
    stderr: { write: () => {} },
    onExit: markExited,
    // No wsl.exe in these tests: no WSL session is stored, and a call would fail at once.
    createWslBackend: (options) =>
      new WslBackend({
        ...options,
        run: async () => ({ code: 1, stdout: "", stderr: "no WSL in this test" }),
      }),
    createWindowsBackend: (options) =>
      new WindowsBackend({
        ...options,
        spawnPty: async (...args) => {
          const pty = await spawnConpty(...args);
          pids.push(pty.pid);
          return pty;
        },
      }),
  });
  cleanups.push(() => result.close?.());
  return { ...result, exited };
}

async function client(pipePath: string): Promise<CoreClient> {
  const c = await connect(pipePath, { requestTimeoutMs: 15_000 });
  cleanups.push(() => c.close());
  return c;
}

const pipe = () => `\\\\.\\pipe\\termdock-test-${randomUUID()}`;

describe.runIf(onWindows)("core with Windows sessions (issue #65)", { timeout: 90_000 }, () => {
  it("[V1-15] ends the shells on core.shutdown without stop; the next core finds the session Interrupted and restarts it", async () => {
    const dataDir = tempDir();
    const pipePath = pipe();
    const pids: number[] = [];
    const launch: LaunchSpec = { backend: "windows", shell: "cmd", cwd: tempDir() };

    const first = await startCore(dataDir, pipePath, pids);
    const c1 = await client(pipePath);
    const { session } = (await c1.request("session.create", { name: "cmd", launch })).result;
    expect(session.state).toBe("Detached");
    const output: string[] = [];
    c1.on("session.output", (_data, payload) => output.push(decoder.decode(payload)));
    const { viewId } = (await c1.request("session.attach", { sessionId: session.id })).result;
    await c1.request("session.input", { viewId }, encoder.encode("echo kep^t-65\r"));
    await waitFor(() => output.join("").includes("kept-65"), "the output of the shell");
    expect(alive(pids[0]!)).toBe(true);

    // Keep the sessions: the core ends anyway, and its shells with it (ADR 0001).
    await c1.request("core.shutdown", { stopSessions: false });
    expect(await first.exited).toBe(0);
    await first.close?.();
    expect(alive(pids[0]!)).toBe(false);

    const second = await startCore(dataDir, pipePath, pids);
    expect(second.restore?.sessions).toEqual([{ sessionId: session.id, from: "Running", to: "Interrupted" }]);
    const c2 = await client(pipePath);
    const { sessions } = (await c2.request("session.list", {})).result;
    expect(sessions).toEqual([expect.objectContaining({ id: session.id, state: "Interrupted" })]);

    const states: string[] = [];
    c2.on("session.stateChanged", (data) => states.push(data.state));
    await c2.request("session.restart", { sessionId: session.id });
    await waitFor(() => states.includes("Detached"), "the restarted session");
    expect(pids).toHaveLength(2);
    expect(alive(pids[1]!)).toBe(true);

    // The history kept the output of the first run and goes on with the separator of the second (ADR 0004).
    await c2.close();
    await second.close?.();
    const history: string[] = [];
    for await (const entry of readHistory(dataDir, session.id)) history.push(decoder.decode(entry.data));
    expect(history.join("")).toMatch(/kept-65[\s\S]*--- Neu gestartet /);
    expect(alive(pids[1]!)).toBe(false);
  });

  it("[V1-15] starts a Windows autostart profile once after the core start, and stops it with core.shutdown { stopSessions }", async () => {
    const dataDir = tempDir();
    const pipePath = pipe();
    const pids: number[] = [];
    const first = await startCore(dataDir, pipePath, pids);
    const c1 = await client(pipePath);
    const { profile } = (
      await c1.request("profile.create", {
        name: "Windows",
        launch: { backend: "windows", shell: "cmd", cwd: "~" },
        autostart: true,
        loggingEnabled: false,
      })
    ).result;
    await c1.close();
    await first.close?.();
    expect(pids).toEqual([]);

    const second = await startCore(dataDir, pipePath, pids);
    expect(second.autostart?.sessions).toEqual([
      expect.objectContaining({ name: "Windows", profileId: profile.id, state: "Starting" }),
    ]);
    await second.autostart?.started;
    expect(pids).toHaveLength(1);
    const c2 = await client(pipePath);
    const listed = (await c2.request("session.list", {})).result.sessions as SessionInfo[];
    expect(listed.map((each) => each.state)).toEqual(["Detached"]);

    await c2.request("core.shutdown", { stopSessions: true });
    await second.exited;
    expect(alive(pids[0]!)).toBe(false);
  });
});
