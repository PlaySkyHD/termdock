// Integration tests against a real WSL distro with tmux. Only with TERMDOCK_WSL_TESTS=1 (local, not in CI).
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { LaunchSpec } from "@termdock/protocol";
import type { PtyHandle } from "../types.js";
import { WslBackend } from "./backend.js";
import { runWsl } from "./processes.js";

const SOCKET = "termdock-test";
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

  it("is available", async () => {
    backend = new WslBackend({ socket: SOCKET, distro });
    expect(await backend.available()).toBe(true);
    const missing = new WslBackend({ socket: SOCKET, distro: "termdock-no-such-distro" });
    expect(await missing.available()).toBe(false);
    missing.dispose();
  });

  it("starts in the requested directory within 3 s, echoes input and follows resizes", async () => {
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

  it("reports a client detached from outside without exit code and keeps the session", async () => {
    backend = new WslBackend({ socket: SOCKET });
    const id = nextId();
    const session = track(await backend.start(id, spec(), size));
    await waitFor(() => session.output().length > 0);
    await tmux(["detach-client", "-s", `=td-${id}`]);
    expect(await session.exit).toEqual({});
    expect(await backend.exists(id, spec())).toBe(true);
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
