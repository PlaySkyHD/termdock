// Restart of a real core against WSL and tmux (#130). Only with TERMDOCK_WSL_TESTS=1 (local, not in CI). The core
// runs as its own detached process (`startDetachedCore`, Node instead of Electron) on its own pipe, data directory
// and tmux socket, so neither the user's core nor the socket of other tests is touched. The test ends the core by
// its process id like a crash; the supervisor starts it again.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { connect } from "@termdock/core";
import type { CoreClient } from "@termdock/core";
import { afterEach, describe, expect, it } from "vitest";
import { connectOrStartCore } from "./core-connection.js";
import { coreEntryPath, startDetachedCore } from "./core-process.js";
import { CoreSupervisor } from "./core-supervisor.js";
import type { SupervisorState } from "./core-supervisor.js";

const enabled = process.env.TERMDOCK_WSL_TESTS === "1";
const decoder = new TextDecoder();

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!enabled)("CoreSupervisor against a real core (#130)", () => {
  const pipePath = `\\\\.\\pipe\\termdock-restart-test-${randomUUID()}`;
  // The pattern of the screenshot runs: a run that dies midway leaves a socket their cleanup removes.
  const tmuxSocket = `termdock-test-${process.pid}-${randomBytes(4).toString("hex")}`;
  const dataDir = mkdtempSync(join(tmpdir(), "termdock-restart-"));
  const pids: number[] = [];
  let supervisor: CoreSupervisor<CoreClient> | undefined;

  afterEach(async () => {
    supervisor?.stop();
    // Ends the sessions on the test's own socket and the core; a core that does not answer is ended by its pid.
    await supervisor?.port.request("core.shutdown", { stopSessions: true }).catch(() => {});
    await supervisor?.close().catch(() => {});
    for (const pid of pids) {
      for (let i = 0; i < 50 && isAlive(pid); i++) await sleep(100);
      if (isAlive(pid)) process.kill(pid);
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("starts the core again after a kill, and the session comes back with its old output", async () => {
    const states: SupervisorState[] = [];
    supervisor = new CoreSupervisor<CoreClient>({
      connect: async () =>
        (
          await connectOrStartCore({
            connect: () => connect(pipePath, { clientKind: "desktop", requestTimeoutMs: 60_000 }),
            startCore: () => {
              const pid = startDetachedCore({
                execPath: process.execPath,
                entry: coreEntryPath({ packaged: false, resourcesPath: "" }),
                env: {
                  ...process.env,
                  TERMDOCK_PIPE: pipePath,
                  TERMDOCK_DATA_DIR: dataDir,
                  TERMDOCK_TMUX_SOCKET: tmuxSocket,
                },
              });
              if (pid !== undefined) pids.push(pid);
            },
            sleep: (ms) => sleep(ms),
            now: () => Date.now(),
          })
        ).client,
      now: () => Date.now(),
      sleep: (ms) => sleep(ms),
      onState: (state) => states.push(state),
      log: () => {},
    });
    const port = supervisor.port;
    await supervisor.start();
    expect(pids).toHaveLength(1);

    const { session } = (
      await port.request("session.create", { name: "phoenix", launch: { backend: "wsl", cwd: "/tmp" } })
    ).result;
    let output = "";
    port.on("session.output", (_data, payload) => (output += decoder.decode(payload)));
    const { viewId } = (await port.request("session.attach", { sessionId: session.id })).result;
    await port.request("session.input", { viewId }, new TextEncoder().encode("echo phoenix-$((6*7))\r"));
    await waitFor(() => output.includes("phoenix-42"), "the marker output");

    // Like a crash: no shutdown, the process just ends.
    process.kill(pids[0]!);
    await waitFor(() => states.at(-1) === "connected" && states.includes("restarting"), "the restart");

    expect(pids).toHaveLength(2);
    const listed = (await port.request("session.list", {})).result.sessions;
    expect(listed).toEqual([expect.objectContaining({ id: session.id, state: "Detached" })]);
    const attached = await port.request("session.attach", { sessionId: session.id });
    expect(decoder.decode(attached.payload)).toContain("phoenix-42");
    const after = (await port.request("session.list", {})).result.sessions;
    expect(after).toEqual([expect.objectContaining({ id: session.id, state: "Running" })]);
  }, 180_000);
});
