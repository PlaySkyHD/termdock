// End-to-end test of the assembled core against real WSL and tmux (issue #13, acceptance 09).
// Only with TERMDOCK_WSL_TESTS=1 (local, not in CI). The core runs in-process through runCore.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo, TerminalSize } from "@termdock/protocol";
import { Terminal } from "@xterm/headless";
import { runWsl } from "./backend/wsl/processes.js";
import { runCore } from "./bin/run-core.js";
import type { RunCoreResult } from "./bin/run-core.js";
import { connect, IpcError } from "./ipc/client.js";
import { historySegmentPath, readHistory } from "./storage/history-store.js";
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

/** Screen lines of a terminal emulator (as a view) after writing `parts`, without trailing blanks. */
async function render(size: TerminalSize, parts: readonly Uint8Array[]): Promise<string[]> {
  const terminal = new Terminal({ cols: size.cols, rows: size.rows, allowProposedApi: true });
  try {
    for (const part of parts) await new Promise<void>((resolve) => terminal.write(part, resolve));
    const buffer = terminal.buffer.active;
    return Array.from(
      { length: size.rows },
      // capture-pane drops trailing spaces as well.
      (_, y) =>
        buffer
          .getLine(buffer.baseY + y)
          ?.translateToString(true)
          .trimEnd() ?? "",
    );
  } finally {
    terminal.dispose();
  }
}

/** Input modes of a terminal emulator (as a view) after writing `parts` into a fresh terminal. */
async function modesAfter(size: TerminalSize, parts: readonly Uint8Array[]) {
  const terminal = new Terminal({ cols: size.cols, rows: size.rows, allowProposedApi: true });
  try {
    for (const part of parts) await new Promise<void>((resolve) => terminal.write(part, resolve));
    const {
      applicationCursorKeysMode,
      applicationKeypadMode,
      bracketedPasteMode,
      mouseTrackingMode,
      sendFocusMode,
    } = terminal.modes;
    return {
      applicationCursorKeysMode,
      applicationKeypadMode,
      bracketedPasteMode,
      mouseTrackingMode,
      sendFocusMode,
    };
  } finally {
    terminal.dispose();
  }
}

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

  it("shows exactly the tmux screen in views attached during running output (issue #34)", async () => {
    freshDataDir();
    await startCore();
    const c1 = await client();
    const size = { cols: 80, rows: 24 };
    const { session } = (
      await c1.request("session.create", { name: "e2e", launch: { backend: "wsl", cwd: "/tmp" }, size })
    ).result;
    const distro = session.launch.distro!;
    distros.add(distro);
    const screen = async () =>
      (await tmux(distro, ["capture-pane", "-p", "-t", `=td-${session.id}:`])).stdout;
    const { viewId } = (await c1.request("session.attach", { sessionId: session.id })).result;
    // Appends a number every 20 ms; output a view gets twice or never shifts the rest of the screen. Only shell
    // builtins: tmux redraws the whole screen when the foreground program changes (window name), which would
    // hide the error. The last `read` waits without showing the prompt again.
    const loop =
      'clear; for i in {100..299}; do printf "$i "; read -rt 0.02; done; echo; echo e2e-done; read -r\r';
    await c1.request("session.input", { viewId }, new TextEncoder().encode(loop));

    // Views of further clients (windows) attach at different points of the output.
    const views: Array<{ snapshot: Uint8Array; chunks: readonly Uint8Array[] }> = [];
    for (const marker of ["130 ", "180 ", "230 "]) {
      await waitFor(async () => (await screen()).includes(marker), `output ${marker}`);
      const c = await client();
      const chunks: Uint8Array[] = [];
      c.on("session.output", (_data, payload) => chunks.push(payload));
      const { payload } = await c.request("session.attach", { sessionId: session.id });
      views.push({ snapshot: payload, chunks });
    }
    // Output up to the end of the loop. About a second after the output stops, tmux redraws the whole screen by
    // itself (measured; it re-initialises the terminal first), which would hide the error.
    const untilDone = (chunks: readonly Uint8Array[]): Uint8Array[] | undefined => {
      let text = "";
      for (const [index, chunk] of chunks.entries()) {
        text += decoder.decode(chunk);
        if (text.includes("e2e-done\r\n")) return chunks.slice(0, index + 1);
      }
      return undefined;
    };
    await waitFor(() => views.every((view) => untilDone(view.chunks)), "end of output in every view");

    const expected = (await screen()).replace(/\n$/, "").split("\n");
    while (expected.length < size.rows) expected.push("");
    for (const view of views) {
      expect(await render(size, [view.snapshot, ...untilDone(view.chunks)!])).toEqual(expected);
    }
  }, 120_000);

  it("gives a view attached later the same terminal modes as the first one (issue #42)", async () => {
    freshDataDir();
    await startCore();
    const c1 = await client();
    const size = { cols: 80, rows: 24 };
    const { session } = (
      await c1.request("session.create", { name: "e2e", launch: { backend: "wsl", cwd: "/tmp" }, size })
    ).result;
    const distro = session.launch.distro!;
    distros.add(distro);
    const chunksA: Uint8Array[] = [];
    c1.on("session.output", (_data, payload) => chunksA.push(payload));
    const first = await c1.request("session.attach", { sessionId: session.id });
    const textA = () => chunksA.map((chunk) => decoder.decode(chunk)).join("");

    // `mouse on` for this session only (a session option): `-g` would reach other tests on the shared socket.
    expect(await tmux(distro, ["set-option", "-t", `=td-${session.id}:`, "mouse", "on"])).toMatchObject({
      code: 0,
    });
    await waitFor(() => textA().includes("\x1b[?1002h"), "mouse tracking at the core's client");
    // A TUI that asks the pane for application cursor keys and keypad.
    await c1.request(
      "session.input",
      { viewId: first.result.viewId },
      new TextEncoder().encode("less /etc/passwd\r"),
    );
    await waitFor(
      async () =>
        (
          await tmux(distro, [
            "display-message",
            "-p",
            "-t",
            `=td-${session.id}:`,
            "#{alternate_on} #{keypad_cursor_flag} #{keypad_flag}",
          ])
        ).stdout.trim() === "1 1 1",
      "less with application cursor keys and keypad",
    );

    const c2 = await client();
    const second = await c2.request("session.attach", { sessionId: session.id });

    const modesA = await modesAfter(size, [first.payload, ...chunksA]);
    const modesB = await modesAfter(size, [second.payload]);
    expect(modesB).toEqual(modesA);
    expect(modesB).toEqual({
      applicationCursorKeysMode: true,
      applicationKeypadMode: true,
      bracketedPasteMode: true,
      mouseTrackingMode: "drag",
      sendFocusMode: true,
    });
  }, 120_000);

  it("keeps the focus reports of a late writer view from the program in the pane (issue #42)", async () => {
    freshDataDir();
    await startCore();
    const c1 = await client();
    const { session } = (
      await c1.request("session.create", { name: "e2e", launch: { backend: "wsl", cwd: "/tmp" } })
    ).result;
    const distro = session.launch.distro!;
    distros.add(distro);
    const screen = async () =>
      (await tmux(distro, ["capture-pane", "-p", "-t", `=td-${session.id}:`])).stdout;
    const first = await c1.request("session.attach", { sessionId: session.id });
    // `cat -v` shows every byte it gets, a focus report as `^[[I`.
    await c1.request("session.input", { viewId: first.result.viewId }, new TextEncoder().encode("cat -v\r"));
    await waitFor(
      async () =>
        (
          await tmux(distro, ["display-message", "-p", "-t", `=td-${session.id}:`, "#{pane_current_command}"])
        ).stdout.trim() === "cat",
      "cat in the foreground",
    );

    // The late view gets focus reports switched on (the ConPTY asked for them) and, as writer, sends what
    // xterm.js reports on a focus change.
    const c2 = await client();
    const second = await c2.request("session.attach", { sessionId: session.id });
    expect(decoder.decode(second.payload)).toContain("\x1b[?1004h");
    await c2.request("session.claimWriter", { viewId: second.result.viewId });
    await c2.request(
      "session.input",
      { viewId: second.result.viewId },
      new TextEncoder().encode("focus-a\x1b[I\x1b[Ofocus-b\x1b[I\x1b[O\r"),
    );

    // The ConPTY takes the reports itself; `cat` gets only the text.
    await waitFor(async () => (await screen()).includes("focus-afocus-b\n"), "the echo of cat");
    expect(await screen()).not.toContain("^[[");
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

  it("starts a session from a profile in the directory of its project, command as argument array (issue #58)", async () => {
    freshDataDir();
    await startCore();
    const c = await client();
    const workspace = (await c.request("workspace.create", { name: "e2e" })).result.workspace;
    const project = (
      await c.request("project.create", {
        workspaceId: workspace.id,
        name: "usr",
        path: "/usr",
        backend: "wsl",
      })
    ).result.project;
    const command = ["bash", "-lc", "pwd; exec bash"];
    const fromProject = (
      await c.request("profile.create", {
        name: "pwd",
        launch: { backend: "wsl", cwd: "~", command },
        projectId: project.id,
      })
    ).result.profile;
    const explicit = (
      await c.request("profile.create", { name: "var", launch: { backend: "wsl", cwd: "/var", command } })
    ).result.profile;

    for (const [profile, expected] of [
      [fromProject, "/usr"],
      [explicit, "/var"],
    ] as const) {
      const { session } = (await c.request("session.create", { name: profile.name, profileId: profile.id }))
        .result;
      distros.add(session.launch.distro!);
      expect(session.launch).toMatchObject({ cwd: expected, command });
      await waitFor(async () => {
        const pane = await tmux(session.launch.distro!, ["capture-pane", "-p", "-t", `=td-${session.id}:`]);
        return pane.stdout.split("\n").some((line) => line.trim() === expected);
      }, `pwd ${expected}`);
    }
  }, 120_000);

  it("does not store the repaint when a second view attaches (issue #88)", async () => {
    freshDataDir();
    await startCore();
    const c = await client();
    const { session } = (
      await c.request("session.create", { name: "e2e", launch: { backend: "wsl", cwd: "/tmp" } })
    ).result;
    distros.add(session.launch.distro!);
    const first = collect(c);
    const { viewId } = (await c.request("session.attach", { sessionId: session.id })).result;
    await c.request("session.input", { viewId }, new TextEncoder().encode("echo seen-$((6*7))\r"));
    await waitFor(() => first().includes("seen-42"), "marker output");

    const history = async () => {
      let text = "";
      for await (const entry of readHistory(dataDir, session.id)) text += decoder.decode(entry.data);
      return text;
    };
    // The core writes in the background, and tmux repaints by itself a few seconds after the start.
    const settledHistory = async () => {
      let before: string | undefined;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const now = await history();
        if (now === before) return now;
        before = now;
      }
      throw new Error("history did not settle");
    };
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const stored = await settledHistory();
    expect(stored).toContain("seen-42");

    const second = await client();
    const repaint = collect(second);
    await second.request("session.attach", { sessionId: session.id });
    await waitFor(() => repaint().includes("seen-42"), "repaint in the second view");
    expect(await settledHistory()).toBe(stored);

    await c.request("session.input", { viewId }, new TextEncoder().encode("echo after-$((1+1))\r"));
    await waitFor(() => first().includes("after-2"), "output after the attach");
    expect(await settledHistory()).toContain("after-2");
  }, 60_000);

  it("holds the history limit under 50 MiB of output and keeps the PTY flowing (issue #59)", async () => {
    freshDataDir();
    await startCore();
    const c = await client();
    const { session } = (
      await c.request("session.create", { name: "e2e", launch: { backend: "wsl", cwd: "/tmp" } })
    ).result;
    distros.add(session.launch.distro!);
    // Counts instead of collecting: the program prints about 67 MB.
    let received = 0;
    let tail = "";
    c.on("session.output", (_data, payload) => {
      received += payload.length;
      tail = (tail + decoder.decode(payload)).slice(-200);
    });
    const { viewId } = (await c.request("session.attach", { sessionId: session.id })).result;

    await c.request(
      "session.input",
      { viewId },
      new TextEncoder().encode("head -c 50M /dev/urandom | base64; echo load-done-$((20+22))\r"),
    );
    await waitFor(() => tail.includes("load-done-42"), "end of the load", 110_000);
    // tmux hands the attached client what it draws, not every byte the program prints, so far less arrives.
    expect(received).toBeGreaterThan(0);
    await c.request("session.input", { viewId }, new TextEncoder().encode("echo flows-$((1+1))\r"));
    await waitFor(() => tail.includes("flows-2"), "output after the load");

    // The core writes in the background; wait until the files stop changing.
    const usage = () =>
      ([0, 1] as const).reduce<number>((sum, index) => {
        try {
          return sum + statSync(historySegmentPath(dataDir, session.id, index)).size;
        } catch {
          return sum;
        }
      }, 0);
    let before = -1;
    await waitFor(async () => {
      const now = usage();
      const settled = now === before;
      before = now;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return settled;
    }, "history settled");
    expect(usage()).toBeLessThanOrEqual(10 * 1024 * 1024);
    // At least limit / 2 of recent output is the guarantee of the unit test with 50 MiB through the registry.
    expect(usage()).toBeGreaterThan(0);
    // The newest output (the entries around the last command) is in the history.
    let newest = "";
    for await (const entry of readHistory(dataDir, session.id))
      newest = (newest + decoder.decode(entry.data)).slice(-2000);
    expect(newest).toContain("flows-2");
  }, 180_000);
});
