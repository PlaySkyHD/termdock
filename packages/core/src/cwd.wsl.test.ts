// Current directory of a WSL session from tmux, through the assembled core (issue #199, openspec change
// session-current-cwd). Only with TERMDOCK_WSL_TESTS=1 (local, not in CI). The core runs in-process through runCore.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { runWsl } from "./backend/wsl/processes.js";
import { runCore } from "./bin/run-core.js";
import type { RunCoreResult } from "./bin/run-core.js";
import { connect } from "./ipc/client.js";
import type { CoreClient } from "./ipc/client.js";
import { cleanStaleWslTestServers, killWslTestServer, wslTestSocket } from "./test/wsl-socket.js";

// A socket of its own: parallel runs (other worktrees) must not remove our sessions (#147).
const SOCKET = wslTestSocket();
const enabled = process.env.TERMDOCK_WSL_TESTS === "1";

async function waitFor(predicate: () => boolean, what: string, timeoutMs: number, last: () => string) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}; last: ${last()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!enabled)("current directory of a WSL session (issue #199)", () => {
  const pipePath = `\\\\.\\pipe\\termdock-cwd-${randomUUID()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "termdock-cwd-"));
  let core: RunCoreResult | undefined;
  let client: CoreClient | undefined;
  const distros = new Set<string>();

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await core?.close?.();
    core = undefined;
    for (const distro of distros) {
      const sessions = await runWsl(
        ["-d", distro, "--cd", "~", "--exec", "tmux", "-L", SOCKET, "list-sessions", "-F", "#{session_name}"],
        { timeoutMs: 15_000 },
      );
      for (const name of sessions.stdout.split("\n").filter((line) => line.startsWith("td-"))) {
        await runWsl(
          ["-d", distro, "--cd", "~", "--exec", "tmux", "-L", SOCKET, "kill-session", "-t", `=${name}`],
          {
            timeoutMs: 15_000,
          },
        );
      }
    }
  });

  afterAll(async () => {
    // The socket belongs to this file alone: end its server, then the servers of aborted runs.
    for (const distro of distros) {
      await killWslTestServer(distro, SOCKET).catch(() => {});
      await cleanStaleWslTestServers(distro);
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reports /tmp after `cd /tmp` within 15 s and lists it", async () => {
    core = await runCore({
      pipePath,
      dataDir,
      tmuxSocket: SOCKET,
      installSignalHandlers: false,
      stderr: { write: () => {} },
    });
    expect(core.exitCode).toBe(0);
    client = await connect(pipePath, { requestTimeoutMs: 30_000 });
    await client.request("session.list", {});
    const cwds: string[] = [];
    client.on("session.cwdChanged", ({ currentCwd }) => cwds.push(currentCwd ?? "-"));
    const { session } = (
      await client.request("session.create", { name: "cwd", launch: { backend: "wsl", cwd: "~" } })
    ).result;
    distros.add(session.launch.distro!);
    const { viewId } = (await client.request("session.attach", { sessionId: session.id })).result;
    // The attach asks at once: the shell starts in the home directory.
    await waitFor(
      () => cwds.length > 0,
      "the first directory",
      15_000,
      () => JSON.stringify(cwds),
    );
    expect(cwds[0]).toMatch(/^\/home\/|^\/root$/);

    await client.request("session.input", { viewId }, new TextEncoder().encode("cd /tmp\r"));

    await waitFor(
      () => cwds.at(-1) === "/tmp",
      "/tmp",
      15_000,
      () => JSON.stringify(cwds),
    );
    const { sessions } = (await client.request("session.list", {})).result;
    expect(sessions.find((each) => each.id === session.id)?.currentCwd).toBe("/tmp");

    await client.request("session.kill", { sessionId: session.id });
    await waitFor(
      () => cwds.at(-1) === "-",
      "the removal at the end",
      15_000,
      () => JSON.stringify(cwds),
    );
  }, 90_000);
});
