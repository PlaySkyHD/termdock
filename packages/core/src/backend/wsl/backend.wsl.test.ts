// Integration tests against a real WSL distro with tmux. Only with TERMDOCK_WSL_TESTS=1 (local, not in CI).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { LaunchSpec } from "@termdock/protocol";
import type { PtyHandle } from "../types.js";
import { WslBackend } from "./backend.js";
import { cleanStaleWslTestServers, killWslTestServer, wslTestSocket } from "../../test/wsl-socket.js";
import { runWsl } from "./processes.js";

// A socket of its own: parallel runs (other worktrees) must not remove our sessions (#147).
const SOCKET = wslTestSocket();
const enabled = process.env.TERMDOCK_WSL_TESTS === "1";
const decoder = new TextDecoder();

interface Opened {
  pty: PtyHandle;
  output: () => string;
  exit: Promise<{ exitCode?: number }>;
}

let backend: WslBackend;
let distro: string;
const opened: PtyHandle[] = [];
let counter = 0;
const nextId = () => `it-${process.pid}-${++counter}`;

function track(pty: PtyHandle): Opened {
  opened.push(pty);
  let text = "";
  pty.onData((data) => (text += decoder.decode(data)));
  const exit = new Promise<{ exitCode?: number }>((resolve) => pty.onExit(resolve));
  return { pty, output: () => text, exit };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function screen(id: string, spec: LaunchSpec): Promise<string> {
  const snapshot = await backend.snapshot(id, spec);
  return snapshot ? decoder.decode(snapshot.data) : "";
}

async function tmux(args: string[]) {
  return runWsl(["-d", distro, "--cd", "~", "--exec", "tmux", "-L", SOCKET, ...args], { timeoutMs: 15_000 });
}

describe.skipIf(!enabled)("WslBackend against WSL", () => {
  beforeAll(async () => {
    const probe = new WslBackend({ socket: SOCKET });
    distro = process.env.TERMDOCK_WSL_DISTRO ?? (await probe.distros()).defaultDistro ?? "Ubuntu";
    probe.dispose();
  });

  afterAll(async () => {
    // The socket belongs to this file alone: end its server, then the servers of aborted runs.
    if (distro === undefined) return;
    await killWslTestServer(distro, SOCKET).catch(() => {});
    await cleanStaleWslTestServers(distro);
  });

  afterEach(async () => {
    for (const pty of opened.splice(0)) pty.dispose();
    const list = await tmux(["list-sessions", "-F", "#{session_name}"]);
    for (const name of list.stdout.split("\n").filter((line) => line.startsWith("td-"))) {
      await tmux(["kill-session", "-t", `=${name}`]);
    }
    backend?.dispose();
  });

  const spec = (extra: Partial<LaunchSpec> = {}): LaunchSpec => ({
    backend: "wsl",
    distro,
    cwd: "/tmp",
    ...extra,
  });
  const size = { cols: 80, rows: 24 };

  it("lists the distros for the settings dialog (issue #64)", async () => {
    backend = new WslBackend({ socket: SOCKET });
    const { names, defaultDistro } = await backend.distros({ timeoutMs: 5_000 });
    expect(names).toContain(distro);
    expect(defaultDistro === undefined || names.includes(defaultDistro)).toBe(true);
    for (const name of names) expect(name).not.toMatch(/[\0\s]/);
  });

  it("is available", async () => {
    backend = new WslBackend({ socket: SOCKET, distro });
    expect(await backend.available()).toBe(true);
    const missing = new WslBackend({ socket: SOCKET, distro: "termdock-no-such-distro" });
    expect(await missing.available()).toBe(false);
    missing.dispose();
  });

  // Issue #113: wsl.exe cannot chdir and runs tmux in `/`; the start warns instead of failing.
  it("starts in / with a cwd_missing warning when the directory does not exist", async () => {
    backend = new WslBackend({ socket: SOCKET });
    const id = nextId();
    const missing = spec({ cwd: `/tmp/termdock-missing-${process.pid}` });
    const session = track(await backend.start(id, missing, size));
    expect(session.pty.warnings).toEqual([{ code: "cwd_missing", path: missing.cwd, distro }]);
    session.pty.write("printf 'cwd=%s\\n' \"$PWD\"\r");
    await waitFor(async () => /^cwd=\/$/m.test(await screen(id, missing)));

    const other = nextId();
    expect(track(await backend.start(other, spec(), size)).pty.warnings).toBeUndefined();
  }, 30_000);

  it("[V1-02] starts in the requested directory within 3 s, echoes input and follows resizes", async () => {
    backend = new WslBackend({ socket: SOCKET });
    const id = nextId();
    const session = track(await backend.start(id, spec(), size));
    // Measured from the PTY spawn; a cold distro start (about 4 s) happens in the status check before.
    const started = Date.now();
    // Typed right away, before ConPTY's DA1 query; without the backend's answer output is held for 3 s.
    session.pty.write("echo ready-$((5+5))\r");
    await waitFor(() => session.output().includes("ready-10"), 10_000);
    expect(Date.now() - started).toBeLessThan(3_000);

    session.pty.write("printf 'cwd=%s\\n' \"$PWD\"\r");
    await waitFor(async () => /^cwd=\/tmp$/m.test(await screen(id, spec())));

    session.pty.write("echo marker-$((6*7))\r");
    await waitFor(() => session.output().includes("marker-42"));

    session.pty.resize({ cols: 100, rows: 30 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    session.pty.write("echo size=$(stty size)\r");
    await waitFor(async () => /^size=30 100$/m.test(await screen(id, spec())));
  }, 30_000);

  it("passes command arguments verbatim and reports the exit code", async () => {
    backend = new WslBackend({ socket: SOCKET });
    const id = nextId();
    const session = track(
      await backend.start(
        id,
        spec({ command: ["sh", "-c", 'printf "arg=[%s]\\n" "$1"; exit 7', "sh", "$HOME a;b"] }),
        size,
      ),
    );
    expect(await session.exit).toEqual({ exitCode: 7 });
    expect(session.output()).toContain("arg=[$HOME a;b]");
    expect(await backend.exists(id, spec())).toBe(false);
  }, 30_000);

  it("passes arguments and environment values ending in ; literally without running tmux commands", async () => {
    backend = new WslBackend({ socket: SOCKET });
    const bystander = nextId();
    track(await backend.start(bystander, spec({ command: ["sleep", "300"] }), size));
    const id = nextId();
    const args = ["a\\;", ";", "b;", "c;;", "kill-server", ";"];
    const session = track(
      await backend.start(
        id,
        spec({
          env: { TD_X: "a;" },
          command: ["sh", "-c", 'printf "<%s>\\n" "$TD_X" "$@"; exit 3', "sh", ...args],
        }),
        size,
      ),
    );
    expect(await session.exit).toEqual({ exitCode: 3 });
    const expected = ["a;", ...args].map((arg) => `<${arg}>`).join("\r\n");
    expect(session.output()).toContain(expected);
    // An injected kill-server would have taken the bystander down.
    expect(await backend.exists(bystander, spec())).toBe(true);
  }, 30_000);

  it("reports the exit code of a program that ends immediately", async () => {
    backend = new WslBackend({ socket: SOCKET });
    const id = nextId();
    const session = track(await backend.start(id, spec({ command: ["false"] }), size));
    expect(await session.exit).toEqual({ exitCode: 1 });
    expect(await backend.exists(id, spec())).toBe(false);
  }, 30_000);

  it("survives dispose, shows the marker in the snapshot and re-attaches", async () => {
    backend = new WslBackend({ socket: SOCKET });
    const id = nextId();
    const first = track(await backend.start(id, spec(), size));
    first.pty.write("echo detach-$((2*21))\r");
    await waitFor(() => first.output().includes("detach-42"));
    first.pty.dispose();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(await backend.exists(id, spec())).toBe(true);
    const snapshot = await backend.snapshot(id, spec());
    expect(decoder.decode(snapshot?.data)).toMatch(/^detach-42$/m);
    expect(snapshot?.cursor).toBeDefined();

    const attachedAt = Date.now();
    const second = track(await backend.attach(id, spec(), size));
    second.pty.write("echo again-$((1+1))\r");
    await waitFor(() => second.output().includes("again-2"));
    expect(Date.now() - attachedAt).toBeLessThan(3_000);
  }, 30_000);

  it("repaints the whole screen through the PTY on redraw (issue #34)", async () => {
    backend = new WslBackend({ socket: SOCKET });
    const id = nextId();
    const session = track(await backend.start(id, spec(), size));
    session.pty.write("echo redraw-$((6*7))\r");
    await waitFor(() => session.output().includes("redraw-42"));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const before = session.output().length;

    await backend.redraw(id, spec());

    // Through ConPTY the repaint starts at the top left and contains the marker again.
    await waitFor(() => session.output().slice(before).split("\x1b[H").at(-1)!.includes("redraw-42"));
  }, 30_000);

  it("reports a client detached from outside without exit code and keeps the session", async () => {
    backend = new WslBackend({ socket: SOCKET });
    const id = nextId();
    const session = track(await backend.start(id, spec(), size));
    await waitFor(() => session.output().length > 0);
    await tmux(["detach-client", "-s", `=td-${id}`]);
    expect(await session.exit).toEqual({});
    expect(await backend.exists(id, spec())).toBe(true);
  }, 30_000);

  it("listLive finds the live sessions with one call and agrees with exists (issue #134)", async () => {
    // A socket without a server first: nothing is alive.
    const empty = new WslBackend({ socket: wslTestSocket() });
    expect(await empty.listLive([{ id: nextId(), spec: spec() }])).toEqual(new Set());
    void empty.dispose();

    backend = new WslBackend({ socket: SOCKET });
    const [a, b, dead, none] = [nextId(), nextId(), nextId(), nextId()];
    const first = track(await backend.start(a, spec(), size));
    const second = track(await backend.start(b, spec(), size));
    await waitFor(() => first.output().length > 0 && second.output().length > 0);
    first.pty.dispose();
    // A leftover whose program ended (remain-on-exit), made without the backend so no hook removes it.
    const name = `td-${dead}`;
    // In the same call, so the option is set before the program ends.
    await tmux([
      "new-session",
      "-d",
      "-s",
      name,
      "sh",
      "-c",
      "sleep 1; exit 3",
      ";",
      "set-option",
      "-w",
      "-t",
      `=${name}:`,
      "remain-on-exit",
      "on",
    ]);
    await waitFor(
      async () =>
        (await tmux(["display-message", "-p", "-t", `=${name}:`, "#{pane_dead}"])).stdout.trim() === "1",
    );

    const ids = [a, b, dead, none];
    const live = await backend.listLive(ids.map((id) => ({ id, spec: spec() })));

    expect(live).toEqual(new Set([a, b]));
    for (const id of ids) expect(await backend.exists(id, spec())).toBe(live!.has(id));
  }, 30_000);

  it("kill ends the session", async () => {
    backend = new WslBackend({ socket: SOCKET });
    const id = nextId();
    const session = track(await backend.start(id, spec(), size));
    await waitFor(() => session.output().length > 0);
    await backend.kill(id, spec());
    expect(await backend.exists(id, spec())).toBe(false);
    expect((await session.exit).exitCode).toBeUndefined();
  }, 30_000);

  it("keeps a session without PTY alive for 25 s through the keepalive", async () => {
    backend = new WslBackend({ socket: SOCKET });
    const id = nextId();
    const session = track(await backend.start(id, spec(), size));
    session.pty.write("echo alive-$((3*3))\r");
    await waitFor(() => session.output().includes("alive-9"));
    session.pty.dispose();
    // No wsl.exe call from this process except the keepalive (WSL stops an idle distro after 8–20 s).
    await new Promise((resolve) => setTimeout(resolve, 25_000));
    expect(await backend.exists(id, spec())).toBe(true);
    expect(await screen(id, spec())).toMatch(/^alive-9$/m);
  }, 60_000);
});
