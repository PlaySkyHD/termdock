// Current directory of running sessions (issue #199, openspec change session-current-cwd).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchSpec } from "@termdock/protocol";
import { FakeBackend } from "../backend/fake.js";
import { InMemorySessionRepository } from "../storage/session-repository.js";
import { CWD_MAX_INTERVAL_MS, CWD_MIN_INTERVAL_MS, CWD_QUIET_MS } from "./cwd-probe.js";
import { SessionRegistry } from "./registry.js";
import type { SessionRegistryOptions } from "./registry.js";

const spec: LaunchSpec = { backend: "wsl", distro: "Ubuntu", cwd: "/home/nic" };

function setup(
  options: Partial<SessionRegistryOptions> = {},
  backend = new FakeBackend({ currentCwd: true }),
) {
  const registry = new SessionRegistry({ backends: [backend], monotonicNow: () => Date.now(), ...options });
  /** State changes and directory changes in the order the registry reported them. */
  const events: string[] = [];
  const cwds: Array<{ sessionId: string; currentCwd: string | undefined }> = [];
  registry.onStateChange(({ to }) => events.push(`state ${to}`));
  registry.onCwdChanged((event) => {
    cwds.push(event);
    events.push(`cwd ${event.currentCwd ?? "-"}`);
  });
  return { registry, backend, events, cwds };
}

/** Lets timers up to `ms` and the promises they start run. */
const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("SessionRegistry: current directory", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 50_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks when a view attaches and after a pause in the output, and reports each change once", async () => {
    const { registry, backend, cwds } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.setCwd(id, "/home/nic");

    await registry.attachView(id, "v1");
    await pass(0);
    expect(cwds).toEqual([{ sessionId: id, currentCwd: "/home/nic" }]);
    expect(registry.get(id).currentCwd).toBe("/home/nic");
    expect(registry.list()[0]?.currentCwd).toBe("/home/nic");

    backend.setCwd(id, "/tmp");
    await pass(CWD_MIN_INTERVAL_MS);
    backend.pty(id).emitData("cd /tmp\r\n$ ");
    await pass(CWD_QUIET_MS - 1);
    expect(cwds).toHaveLength(1);
    await pass(1);
    expect(cwds.map((event) => event.currentCwd)).toEqual(["/home/nic", "/tmp"]);
    expect(registry.get(id).currentCwd).toBe("/tmp");
  });

  it("reports nothing when the directory stays, and keeps it when the backend cannot tell", async () => {
    const { registry, backend, cwds } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.setCwd(id, "/tmp");
    await registry.attachView(id, "v1");
    for (let i = 0; i < 3; i += 1) {
      await pass(CWD_MAX_INTERVAL_MS);
      backend.pty(id).emitData("x");
      await pass(CWD_QUIET_MS);
    }
    backend.setCwd(id, undefined);
    backend.pty(id).emitData("x");
    await pass(CWD_MAX_INTERVAL_MS);

    expect(backend.cwdCalls).toHaveLength(5);
    expect(cwds.map((event) => event.currentCwd)).toEqual(["/tmp"]);
    expect(registry.get(id).currentCwd).toBe("/tmp");
  });

  it("backs off for output that changes nothing, also while keys drive a TUI, and leaves it on Enter", async () => {
    const { registry, backend, cwds } = setup();
    const { id } = await registry.create({ name: "top", launch: spec });
    backend.setCwd(id, "/tmp");
    await registry.attachView(id, "v1");
    // A TUI repaints all the time and gets single keys; the answers stay the same.
    for (let t = 0; t < 30_000; t += 500) {
      registry.input(id, "v1", t % 1_000 === 0 ? "j" : new Uint8Array([0x1b, 0x5b, 0x41]));
      backend.pty(id).emitData("frame");
      await pass(500);
    }
    expect(backend.cwdCalls.length).toBeLessThanOrEqual(8);

    const before = backend.cwdCalls.length;
    registry.input(id, "v1", new TextEncoder().encode("q\r"));
    backend.setCwd(id, "/srv");
    backend.pty(id).emitData("$ ");
    await pass(CWD_MIN_INTERVAL_MS);
    expect(backend.cwdCalls.length).toBe(before + 1);
    expect(cwds.map((event) => event.currentCwd)).toEqual(["/tmp", "/srv"]);
  });

  it("does not ask for a session without a view; the last view leaving drops the planned query", async () => {
    const { registry, backend, cwds } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.setCwd(id, "/tmp");
    backend.pty(id).emitData("output without a view");
    await pass(5_000);
    expect(backend.cwdCalls).toEqual([]);

    await registry.attachView(id, "v1");
    await pass(0);
    backend.setCwd(id, "/srv");
    backend.pty(id).emitData("x");
    registry.detachView(id, "v1");
    await pass(5_000);

    expect(backend.cwdCalls).toEqual([id]);
    expect(cwds.map((event) => event.currentCwd)).toEqual(["/tmp"]);
    expect(registry.get(id).state).toBe("Detached");
    expect(registry.get(id).currentCwd).toBe("/tmp");
  });

  it("runs one query at a time per session, at least a second apart", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    let open!: () => void;
    backend.cwdGate = new Promise((resolve) => (open = resolve));
    await registry.attachView(id, "v1");
    await registry.attachView(id, "v2");
    for (let t = 0; t < 3_000; t += 100) {
      backend.pty(id).emitData("tick");
      await pass(100);
    }
    expect(backend.cwdCalls).toHaveLength(1);
    expect(backend.cwdPending).toBe(1);

    backend.cwdGate = undefined;
    open();
    await pass(CWD_QUIET_MS);
    expect(backend.cwdCalls).toHaveLength(2);
  });

  it("drops the directory when the process ends and reports that after the state change", async () => {
    const { registry, backend, events } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.setCwd(id, "/tmp");
    await registry.attachView(id, "v1");
    await pass(0);
    events.length = 0;

    backend.pty(id).emitExit(0);

    expect(registry.get(id).state).toBe("Exited");
    expect(registry.get(id).currentCwd).toBeUndefined();
    expect("currentCwd" in registry.get(id)).toBe(false);
    expect(events).toEqual(["state Exited", "cwd -"]);
  });

  it("reports no change for a session that ends without a known directory", async () => {
    const { registry, backend, events } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    events.length = 0;
    backend.pty(id).emitExit(0);
    expect(events).toEqual(["state Exited"]);
  });

  it("drops an answer that arrives after the PTY ended and leaves no timer behind", async () => {
    const { registry, backend, cwds } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.setCwd(id, "/tmp");
    let open!: () => void;
    backend.cwdGate = new Promise((resolve) => (open = resolve));
    await registry.attachView(id, "v1");
    await pass(0);
    expect(backend.cwdPending).toBe(1);
    backend.pty(id).emitData("x");

    backend.pty(id).emitExit(0);
    open();
    await pass(5_000);

    expect(cwds).toEqual([]);
    expect(registry.get(id).currentCwd).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asks again with the new PTY after a lost client, and nothing after dispose", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.setCwd(id, "/tmp");
    await registry.attachView(id, "v1");
    await pass(0);
    expect(backend.cwdCalls).toHaveLength(1);

    backend.pty(id).loseClient();
    await pass(CWD_MIN_INTERVAL_MS);
    expect(backend.attaches.map((call) => call.id)).toEqual([id]);
    expect(backend.cwdCalls).toHaveLength(2);
    expect(registry.get(id).currentCwd).toBe("/tmp");

    backend.pty(id).emitData("x");
    registry.dispose();
    await pass(5_000);
    expect(backend.cwdCalls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no second query for the new PTY before the one of the old PTY ended, and drops its answer", async () => {
    const { registry, backend, cwds } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.setCwd(id, "/old");
    let open!: () => void;
    backend.cwdGate = new Promise((resolve) => (open = resolve));
    await registry.attachView(id, "v1");
    await pass(0);
    expect(backend.cwdPending).toBe(1);

    // The tmux client is lost; the re-attach binds a new PTY while the old query still runs.
    backend.pty(id).loseClient();
    await pass(CWD_MAX_INTERVAL_MS);
    expect(backend.attaches.map((call) => call.id)).toEqual([id]);
    expect(backend.cwdCalls).toHaveLength(1);

    backend.cwdGate = undefined;
    open();
    await pass(0);
    expect(cwds).toEqual([]);
    backend.setCwd(id, "/new");
    await pass(CWD_QUIET_MS);
    expect(backend.cwdCalls).toHaveLength(2);
    expect(cwds.map((event) => event.currentCwd)).toEqual(["/new"]);
  });

  it("drops the directory and reports it as unknown once the backend says it is gone", async () => {
    const { registry, backend, cwds } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.setCwd(id, "/tmp/build");
    await registry.attachView(id, "v1");
    await pass(0);

    backend.setCwd(id, null);
    await pass(CWD_MIN_INTERVAL_MS);
    backend.pty(id).emitData("$ ");
    await pass(CWD_QUIET_MS);

    expect(cwds.map((event) => event.currentCwd)).toEqual(["/tmp/build", undefined]);
    expect("currentCwd" in registry.get(id)).toBe(false);
  });

  it("never asks a backend without currentCwd", async () => {
    const backend = new FakeBackend();
    const { registry, cwds } = setup({}, backend);
    const { id } = await registry.create({ name: "shell", launch: spec });
    await registry.attachView(id, "v1");
    backend.pty(id).emitData("x");
    await pass(5_000);
    expect(cwds).toEqual([]);
    expect(registry.get(id).currentCwd).toBeUndefined();
  });

  it("does not store the directory (runtime state)", async () => {
    const repository = new InMemorySessionRepository();
    const { registry, backend } = setup({ repository });
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.setCwd(id, "/tmp");
    await registry.attachView(id, "v1");
    await pass(0);
    // Detaching saves the session (Running → Detached) while it has a directory.
    registry.detachView(id, "v1");
    expect(registry.get(id).currentCwd).toBe("/tmp");
    expect(repository.list().find((each) => each.id === id)?.currentCwd).toBeUndefined();
  });
});
