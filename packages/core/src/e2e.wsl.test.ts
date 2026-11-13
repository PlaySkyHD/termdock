// End-to-end test of the assembled core against real WSL and tmux (issue #13, acceptance 09).
// Only with TERMDOCK_WSL_TESTS=1 (local, not in CI). The core runs in-process through runCore.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "@termdock/protocol";
import { runWsl } from "./backend/wsl/processes.js";
import { runCore } from "./bin/run-core.js";
import type { RunCoreResult } from "./bin/run-core.js";
import { connect, IpcError } from "./ipc/client.js";
import type { CoreClient } from "./ipc/client.js";

const SOCKET = "termdock-test";
const enabled = process.env.TERMDOCK_WSL_TESTS === "1";
const decoder = new TextDecoder();

const cores: RunCoreResult[] = [];
const clients: CoreClient[] = [];
const tempDirs: string[] = [];
const distros = new Set<string>();

async function tmux(distro: string, args: string[]) {
  return runWsl(["-d", distro, "--cd", "~", "--exec", "tmux", "-L", SOCKET, ...args], { timeoutMs: 15_000 });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const occurrences = (text: string, marker: string) => text.split(marker).length - 1;

describe.skipIf(!enabled)("termdock-core end to end", () => {
  const pipePath = `\\\\.\\pipe\\termdock-e2e-${randomUUID()}`;
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
    // A cold distro start and the reconcile may take several seconds.
    const c = await connect(pipePath, { requestTimeoutMs: 30_000 });
    clients.push(c);
    return c;
  }

  async function list(c: CoreClient): Promise<SessionInfo[]> {
    return (await c.request("session.list", {})).result.sessions;
  }

  function collect(c: CoreClient): () => string {
    let text = "";
    c.on("session.output", (_data, payload) => (text += decoder.decode(payload)));
    return () => text;
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
    dataDir = mkdtempSync(join(tmpdir(), "termdock-e2e-"));
    tempDirs.push(dataDir);
  }

  it("survives a core restart and reports a session killed from outside as Interrupted", async () => {
    freshDataDir();
    await startCore();
    const c1 = await client();
    const { session } = (
      await c1.request("session.create", { name: "e2e", launch: { backend: "wsl", cwd: "/tmp" } })
    ).result;
    const distro = session.launch.distro;
    expect(distro).toBeTypeOf("string");
    distros.add(distro!);
    const output = collect(c1);
    const { viewId } = (await c1.request("session.attach", { sessionId: session.id })).result;
    await c1.request("session.input", { viewId }, new TextEncoder().encode("echo e2e-marker\r"));
    // Once as typed command, once as its output.
    await waitFor(() => occurrences(output(), "e2e-marker") >= 2, "marker output");

    // Core ends without stopping the sessions.
    await c1.close();
    await cores.pop()!.close?.();

    await startCore();
    const c2 = await client();
    expect(await list(c2)).toEqual([
      expect.objectContaining({
        id: session.id,
        state: "Detached",
        launch: expect.objectContaining({ distro }),
      }),
    ]);
    const attached = await c2.request("session.attach", { sessionId: session.id });
    expect(decoder.decode(attached.payload)).toContain("e2e-marker");
    await c2.close();
    await cores.pop()!.close?.();

    const killed = await runWsl(
      ["-d", distro!, "--cd", "~", "--exec", "tmux", "-L", SOCKET, "kill-session", "-t", `=td-${session.id}`],
      { timeoutMs: 15_000 },
    );
    expect(killed.code).toBe(0);

    await startCore();
    const c3 = await client();
    expect((await list(c3)).map((s) => s.state)).toEqual(["Interrupted"]);
  }, 120_000);

  it("ends the attach snapshot with the cursor position of the pane (issue #32)", async () => {
    freshDataDir();
    await startCore();
    const c = await client();
    const { session } = (
      await c.request("session.create", { name: "e2e", launch: { backend: "wsl", cwd: "/tmp" } })
    ).result;
    const distro = session.launch.distro!;
    distros.add(distro);
    const { viewId } = (await c.request("session.attach", { sessionId: session.id })).result;
    // The sleep keeps the shell from redrawing its prompt, which would move the cursor again.
    await c.request("session.input", { viewId }, new TextEncoder().encode("printf '\\e[5;10H'; sleep 600\r"));
    await waitFor(async () => {
      const cursor = await tmux(distro, [
        "display-message",
        "-p",
        "-t",
        `=td-${session.id}:`,
        "#{cursor_y};#{cursor_x}",
      ]);
      return cursor.stdout.trim() === "4;9";
    }, "cursor at row 5, column 10");

    const attached = await c.request("session.attach", { sessionId: session.id });

    // tmux may redraw cursor visibility while the snapshot is taken; that output follows the positioning.
    const tail = decoder.decode(attached.payload).split("\x1b[5;10H").at(-1);
    expect(decoder.decode(attached.payload)).toContain("\x1b[5;10H");
    expect(tail?.replaceAll(/\[\?(12|25)[hl]/g, "").replaceAll("\x1b", "")).toBe("");
  }, 120_000);

  it("re-attaches when the tmux client is detached from outside and keeps delivering output", async () => {
    freshDataDir();
    await startCore();
    const c = await client();
    const { session } = (
      await c.request("session.create", { name: "e2e", launch: { backend: "wsl", cwd: "/tmp" } })
    ).result;
    const distro = session.launch.distro!;
    distros.add(distro);
    const states: string[] = [];
    c.on("session.stateChanged", (data) => states.push(data.state));
    const output = collect(c);
    const { viewId } = (await c.request("session.attach", { sessionId: session.id })).result;
    await c.request("session.input", { viewId }, new TextEncoder().encode("echo before-detach\r"));
    await waitFor(() => occurrences(output(), "before-detach") >= 2, "output before detach");

    const detached = await tmux(distro, ["detach-client", "-s", `=td-${session.id}`]);
    expect(detached.code).toBe(0);

    // Input is refused while the core re-attaches (no PTY); input that still reached the dying client may be
    // lost, so it is repeated until the new client shows its output.
    await waitFor(
      async () => {
        try {
          await c.request("session.input", { viewId }, new TextEncoder().encode("echo after-detach\r"));
        } catch (error) {
          if (error instanceof IpcError && error.code === "invalid_state") return false;
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return occurrences(output(), "after-detach") >= 2;
      },
      "output after re-attach",
      30_000,
    );
    expect((await list(c))[0]).toMatchObject({ id: session.id, state: "Running", writerViewId: viewId });
    expect(states).not.toContain("Interrupted");
  }, 120_000);
});
