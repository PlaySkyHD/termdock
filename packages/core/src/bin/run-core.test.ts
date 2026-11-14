// Assembly of the core process with FakeBackend and a real database (issue #13, spec core-ipc).
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LAYOUT_VERSION } from "@termdock/protocol";
import type { LaunchSpec, LayoutDocument } from "@termdock/protocol";
import { FakeBackend } from "../backend/fake.js";
import { connect } from "../ipc/client.js";
import type { CoreClient } from "../ipc/client.js";
import { openStorage } from "../storage/database.js";
import { historyDir, readHistory } from "../storage/history-store.js";
import { runCore } from "./run-core.js";
import type { RunCoreOptions, RunCoreResult } from "./run-core.js";

const launch: LaunchSpec = { backend: "wsl", cwd: "/home/dev" };
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function uniquePipe(): string {
  const name = `termdock-test-${randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "termdock-core-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stderrSink() {
  const lines: string[] = [];
  return { lines, write: (text: string) => void lines.push(text) };
}

async function start(options: RunCoreOptions): Promise<RunCoreResult> {
  const result = await runCore({ installSignalHandlers: false, stderr: stderrSink(), ...options });
  cleanups.push(() => result.close?.());
  return result;
}

async function client(pipePath: string): Promise<CoreClient> {
  const c = await connect(pipePath, { requestTimeoutMs: 5000 });
  cleanups.push(() => c.close());
  return c;
}

/** Connects as soon as the pipe is taken. */
async function clientWhenListening(pipePath: string): Promise<CoreClient> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return await client(pipePath);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function timeout(ms: number, what: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms));
}

/** Signal source the test triggers instead of sending real signals to the test process. */
function fakeSignals() {
  const handlers = new Map<NodeJS.Signals, Set<() => void>>();
  return {
    once(signal: NodeJS.Signals, handler: () => void): void {
      const set = handlers.get(signal) ?? new Set();
      set.add(handler);
      handlers.set(signal, set);
    },
    off(signal: NodeJS.Signals, handler: () => void): void {
      handlers.get(signal)?.delete(handler);
    },
    emit(signal: NodeJS.Signals): void {
      const set = handlers.get(signal);
      for (const handler of [...(set ?? [])]) {
        set?.delete(handler);
        handler();
      }
    },
    listeners: (): number => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

describe("runCore", () => {
  it("keeps sessions in the data directory across a restart without stop", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    const backend = new FakeBackend();
    const first = await start({ pipePath, dataDir, backends: [backend] });
    const c1 = await client(pipePath);
    const { session } = (await c1.request("session.create", { name: "build", launch })).result;
    await c1.close();
    await first.close?.();

    expect(backend.pty(session.id).disposed).toBe(true);
    expect(backend.kills).toEqual([]);

    await start({ pipePath, dataDir, backends: [backend] });
    const c2 = await client(pipePath);
    const { sessions } = (await c2.request("session.list", {})).result;
    expect(sessions).toEqual([expect.objectContaining({ id: session.id, name: "build", state: "Detached" })]);
    expect(backend.attaches.map((a) => a.id)).toEqual([session.id]);
  });

  it("takes the logging default of new sessions from the stored settings (issues #59, #60)", async () => {
    const pipePath = uniquePipe();
    const backend = new FakeBackend();
    await start({ pipePath, dataDir: tempDir(), backends: [backend] });
    const c = await client(pipePath);
    await c.request("settings.set", { settings: { historyEnabledByDefault: false } });

    const { session } = (await c.request("session.create", { name: "a", launch })).result;

    expect(session.loggingEnabled).toBe(false);
    await c.close();
  });

  it("writes the output of sessions into history/<id> and flushes it on close (issue #59)", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    const backend = new FakeBackend();
    const core = await start({ pipePath, dataDir, backends: [backend] });
    const c = await client(pipePath);
    const logged = (await c.request("session.create", { name: "a", launch })).result.session;
    const silent = (await c.request("session.create", { name: "b", launch, loggingEnabled: false })).result
      .session;

    expect(logged.loggingEnabled).toBe(true);
    backend.pty(logged.id).emitData("kept\r\n");
    backend.pty(silent.id).emitData("not kept\r\n");
    await c.close();
    await core.close?.();

    const text = [];
    for await (const entry of readHistory(dataDir, logged.id))
      text.push(new TextDecoder().decode(entry.data));
    expect(text.join("")).toBe("kept\r\n");
    expect(existsSync(historyDir(dataDir, silent.id))).toBe(false);
  });

  it("keeps workspaces and the ungrouped sessions of a deleted workspace across a restart (issue #56)", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    const backend = new FakeBackend();
    const first = await start({ pipePath, dataDir, backends: [backend] });
    const c1 = await client(pipePath);
    const kept = (await c1.request("workspace.create", { name: "kept", defaultCwd: "/srv" })).result
      .workspace;
    const gone = (await c1.request("workspace.create", { name: "gone" })).result.workspace;
    const project = (
      await c1.request("project.create", {
        workspaceId: kept.id,
        name: "api",
        path: "/home/dev/api",
        backend: "wsl",
        distro: "Ubuntu",
      })
    ).result.project;
    const { session } = (await c1.request("session.create", { name: "s", launch, workspaceId: gone.id }))
      .result;
    await c1.request("workspace.delete", { workspaceId: gone.id });
    await c1.close();
    await first.close?.();

    await start({ pipePath, dataDir, backends: [backend] });
    const c2 = await client(pipePath);
    expect((await c2.request("workspace.list", {})).result.workspaces).toEqual([
      { ...kept, projects: [project] },
    ]);
    const stored = (await c2.request("session.list", {})).result.sessions.find((s) => s.id === session.id);
    expect(stored).toBeDefined();
    expect("workspaceId" in stored!).toBe(false);
  });

  it("keeps profiles across a restart and unbinds them when their workspace is deleted (issue #58)", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    const backend = new FakeBackend();
    const first = await start({ pipePath, dataDir, backends: [backend] });
    const c1 = await client(pipePath);
    const workspace = (await c1.request("workspace.create", { name: "w" })).result.workspace;
    const gone = (await c1.request("workspace.create", { name: "gone" })).result.workspace;
    const spec = { backend: "wsl", cwd: "~", command: ["bash", "-lc", "pwd; exec bash"] } as const;
    const kept = (
      await c1.request("profile.create", { name: "kept", launch: spec, workspaceId: workspace.id })
    ).result.profile;
    const unbound = (
      await c1.request("profile.create", { name: "unbound", launch: spec, workspaceId: gone.id })
    ).result.profile;
    await c1.request("workspace.delete", { workspaceId: gone.id });
    await c1.close();
    await first.close?.();

    await start({ pipePath, dataDir, backends: [backend] });
    const c2 = await client(pipePath);
    const { workspaceId: _removed, ...withoutWorkspace } = unbound;
    expect((await c2.request("profile.list", {})).result.profiles).toEqual([kept, withoutWorkspace]);
  });

  it("answers hello at once but holds other requests until the reconcile is done", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    const first = await start({ pipePath, dataDir, backends: [new FakeBackend()] });
    const c1 = await client(pipePath);
    await c1.request("session.create", { name: "build", launch });
    await c1.close();
    await first.close?.();

    let release: (available: boolean) => void = () => {};
    const slow = new (class extends FakeBackend {
      override available(): Promise<boolean> {
        return new Promise((resolve) => (release = resolve));
      }
    })();
    const starting = runCore({
      pipePath,
      dataDir,
      backends: [slow],
      installSignalHandlers: false,
      stderr: stderrSink(),
    });
    cleanups.push(async () => (await starting).close?.());
    const c2 = await clientWhenListening(pipePath);
    let answered = false;
    const listing = c2.request("session.list", {}).then((answer) => {
      answered = true;
      return answer;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);

    release(false);
    expect((await starting).exitCode).toBe(0);
    expect((await listing).result.sessions.map((s) => s.state)).toEqual(["Interrupted"]);
  });

  it("keeps the layout and its revision across a restart and holds layout.get until the reconcile is done", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    const first = await start({ pipePath, dataDir, backends: [new FakeBackend()] });
    const c1 = await client(pipePath);
    const layout = {
      version: LAYOUT_VERSION,
      windows: [
        {
          id: "w1",
          tabs: [{ id: "t1", root: { kind: "pane", id: "p1", sessionId: "gone" }, activePaneId: "p1" }],
          activeTabId: "t1",
        },
      ],
    } satisfies LayoutDocument;
    // A stored session makes the reconcile ask the backend, which the test then holds back.
    await c1.request("session.create", { name: "build", launch });
    expect((await c1.request("layout.save", { layout })).result).toEqual({ revision: 1 });
    expect((await c1.request("layout.save", { layout, baseRevision: 1 })).result).toEqual({ revision: 2 });
    await c1.close();
    await first.close?.();

    let release: (available: boolean) => void = () => {};
    const slow = new (class extends FakeBackend {
      override available(): Promise<boolean> {
        return new Promise((resolve) => (release = resolve));
      }
    })();
    const starting = runCore({
      pipePath,
      dataDir,
      backends: [slow],
      installSignalHandlers: false,
      stderr: stderrSink(),
    });
    cleanups.push(async () => (await starting).close?.());
    const c2 = await clientWhenListening(pipePath);
    let answered = false;
    const loading = c2.request("layout.get", {}).then((answer) => {
      answered = true;
      return answer;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);

    release(false);
    expect((await starting).exitCode).toBe(0);
    expect((await loading).result).toEqual({ layout, revision: 2 });
  });

  it("reports an unreachable backend on stderr and through core.status", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    const first = await start({ pipePath, dataDir, backends: [new FakeBackend()] });
    const c1 = await client(pipePath);
    expect((await c1.request("core.status", {})).result).toEqual({ backendUnavailable: [] });
    await c1.request("session.create", { name: "build", launch });
    await c1.close();
    await first.close?.();

    const offline = new FakeBackend();
    offline.isAvailable = false;
    const stderr = stderrSink();
    await start({ pipePath, dataDir, backends: [offline], stderr });
    const c2 = await client(pipePath);

    expect((await c2.request("core.status", {})).result).toEqual({ backendUnavailable: ["wsl"] });
    expect(stderr.lines.join("")).toContain("backend_unavailable: wsl");
  });

  it("fails with already_running before it creates or opens the data directory", async () => {
    const pipePath = uniquePipe();
    await start({ pipePath, dataDir: tempDir(), backends: [new FakeBackend()] });
    const dataDir = join(tempDir(), "second");
    const stderr = stderrSink();

    const second = await start({ pipePath, dataDir, backends: [new FakeBackend()], stderr });

    expect(second).toMatchObject({ exitCode: 10, errorCode: "already_running" });
    expect(stderr.lines.join("")).toContain("already_running");
    expect(existsSync(dataDir)).toBe(false);
  });

  it("frees the pipe and exits with start_failed when the database cannot be opened", async () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, "termdock.db"), "this is not a database, just some text to break sqlite");
    const pipePath = uniquePipe();
    const stderr = stderrSink();

    const failed = await start({ pipePath, dataDir, backends: [new FakeBackend()], stderr });

    expect(failed).toMatchObject({ exitCode: 1, errorCode: "start_failed" });
    expect(stderr.lines.join("")).toMatch(/start failed: .+/);
    const next = await start({ pipePath, dataDir: tempDir(), backends: [new FakeBackend()] });
    expect(next.exitCode).toBe(0);
  });

  it("tears down on a signal during a slow reconcile without changing the stored state", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    const first = await start({ pipePath, dataDir, backends: [new FakeBackend()] });
    const c1 = await client(pipePath);
    const { session } = (await c1.request("session.create", { name: "build", launch })).result;
    await c1.close();
    await first.close?.();

    let release: (exists: boolean) => void = () => {};
    let checking = false;
    const slow = new (class extends FakeBackend {
      override exists(): Promise<boolean> {
        checking = true;
        return new Promise((resolve) => (release = resolve));
      }
    })();
    const signals = fakeSignals();
    let exited: (code: number) => void = () => {};
    const exitCode = new Promise<number>((resolve) => (exited = resolve));
    const starting = runCore({
      pipePath,
      dataDir,
      backends: [slow],
      signals,
      stderr: stderrSink(),
      onExit: (code) => exited(code),
    });
    cleanups.push(async () => (await starting).close?.());
    cleanups.push(() => release(false));
    await until(() => checking, "reconcile asks the backend");

    signals.emit("SIGTERM");

    expect(await Promise.race([exitCode, timeout(2000, "onExit")])).toBe(0);
    expect((await starting).exitCode).toBe(0);
    expect(signals.listeners()).toBe(0);
    release(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slow.attaches).toEqual([]);
    const storage = openStorage({ dataDir });
    expect(storage.sessions.list()).toEqual([expect.objectContaining({ id: session.id, state: "Detached" })]);
    storage.dispose();
    // The core closed its database: Windows would refuse to delete an open file.
    rmSync(dataDir, { recursive: true });
    const next = await start({ pipePath, dataDir: tempDir(), backends: [new FakeBackend()] });
    expect(next.exitCode).toBe(0);
  });

  it("tears down on core.shutdown and then calls onExit", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    const backend = new FakeBackend();
    let exited: (code: number) => void = () => {};
    const exitCode = new Promise<number>((resolve) => (exited = resolve));
    await start({ pipePath, dataDir, backends: [backend], onExit: (code) => exited(code) });
    const c = await client(pipePath);
    const { session } = (await c.request("session.create", { name: "build", launch })).result;

    await c.request("core.shutdown", {});

    expect(await exitCode).toBe(0);
    expect(backend.pty(session.id).disposed).toBe(true);
    expect(backend.kills).toEqual([]);
    // The database is closed: Windows would refuse to delete an open file.
    rmSync(dataDir, { recursive: true });
  });
});

describe("runCore autostart (issue #61)", () => {
  /** Starts a core, lets `prepare` set it up through a client, and closes it without stopping the sessions. */
  async function prepared(
    dataDir: string,
    pipePath: string,
    backend: FakeBackend,
    prepare: (c: CoreClient) => Promise<void>,
  ): Promise<void> {
    const core = await start({ pipePath, dataDir, backends: [backend] });
    const c = await client(pipePath);
    await prepare(c);
    await c.close();
    await core.close?.();
  }

  async function sessionsOf(pipePath: string) {
    const c = await client(pipePath);
    const { sessions } = (await c.request("session.list", {})).result;
    await c.close();
    return sessions;
  }

  it("starts exactly the autostart profiles, and a restart with running sessions starts none", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    const backend = new FakeBackend();
    const ids: string[] = [];
    await prepared(dataDir, pipePath, backend, async (c) => {
      for (const [name, autostart] of [
        ["Claude", true],
        ["Codex", true],
        ["Manual", false],
      ] as const) {
        const { profile } = (await c.request("profile.create", { name, launch, autostart })).result;
        if (autostart) ids.push(profile.id);
      }
      // Marking a profile starts nothing; it takes effect on the next Core start.
      expect((await c.request("session.list", {})).result.sessions).toEqual([]);
    });

    const second = await start({ pipePath, dataDir, backends: [backend] });
    await second.autostart?.started;
    const sessions = await sessionsOf(pipePath);
    expect(sessions.map((session) => [session.name, session.profileId, session.state])).toEqual([
      ["Claude", ids[0], "Detached"],
      ["Codex", ids[1], "Detached"],
    ]);
    expect(backend.starts).toHaveLength(2);
    await second.close?.();

    const third = await start({ pipePath, dataDir, backends: [backend] });
    await third.autostart?.started;
    const again = await sessionsOf(pipePath);
    expect(again.map((session) => [session.id, session.state])).toEqual(
      sessions.map((session) => [session.id, "Detached"]),
    );
    expect(backend.starts).toHaveLength(2);
    expect(third.autostart?.sessions).toEqual([]);
  });

  it("gives a profile whose session was interrupted exactly one new session and keeps the old", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    const backend = new FakeBackend();
    let old = "";
    await prepared(dataDir, pipePath, backend, async (c) => {
      const { profile } = (await c.request("profile.create", { name: "Claude", launch, autostart: true }))
        .result;
      old = (await c.request("session.create", { name: "Claude", profileId: profile.id })).result.session.id;
    });
    // The tmux session is gone when the next Core starts: the reconcile makes the session Interrupted.
    backend.setExists(old, false);

    const next = await start({ pipePath, dataDir, backends: [backend] });
    await next.autostart?.started;

    const sessions = await sessionsOf(pipePath);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((session) => session.id === old)?.state).toBe("Interrupted");
    expect(sessions.find((session) => session.id !== old)?.state).toBe("Detached");
  });

  it("holds requests until the autostart sessions are registered; two clients see one start", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    const backend = new FakeBackend();
    await prepared(dataDir, pipePath, backend, async (c) => {
      await c.request("profile.create", { name: "Claude", launch, autostart: true });
    });

    // The reconcile has nothing to check, so the first `available()` is the autostart's backend check.
    let release: (available: boolean) => void = () => {};
    let asked = false;
    const slow = new (class extends FakeBackend {
      override available(): Promise<boolean> {
        asked = true;
        return new Promise((resolve) => (release = resolve));
      }
    })();
    const starting = runCore({
      pipePath,
      dataDir,
      backends: [slow],
      installSignalHandlers: false,
      stderr: stderrSink(),
    });
    cleanups.push(async () => (await starting).close?.());
    const a = await clientWhenListening(pipePath);
    const b = await client(pipePath);
    const created: string[] = [];
    for (const c of [a, b]) c.on("session.created", ({ session }) => void created.push(session.id));
    let answered = false;
    const lists = Promise.all([a.request("session.list", {}), b.request("session.list", {})]).then(
      (answers) => {
        answered = true;
        return answers.map((answer) => answer.result.sessions);
      },
    );
    await until(() => asked, "backend check");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);

    release(true);
    const [first, second] = await lists;
    expect(first).toHaveLength(1);
    expect(second?.map((session) => session.id)).toEqual(first?.map((session) => session.id));
    await (
      await starting
    ).autostart?.started;
    expect(slow.starts).toHaveLength(1);
    // Nobody had listed when the session was registered; both clients know it from their list.
    expect(created).toEqual([]);
  });

  it("reports an unreachable backend once on stderr and in core.status and starts nothing", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    await prepared(dataDir, pipePath, new FakeBackend(), async (c) => {
      await c.request("profile.create", { name: "a", launch, autostart: true });
      await c.request("profile.create", { name: "b", launch, autostart: true });
    });

    const offline = new FakeBackend();
    offline.isAvailable = false;
    const stderr = stderrSink();
    const core = await start({ pipePath, dataDir, backends: [offline], stderr });
    await core.autostart?.started;
    const c = await client(pipePath);

    expect((await c.request("core.status", {})).result).toEqual({ backendUnavailable: ["wsl"] });
    expect((await c.request("session.list", {})).result.sessions).toEqual([]);
    expect(stderr.lines.filter((line) => line.includes("autostart: backend_unavailable: wsl"))).toHaveLength(
      1,
    );
    expect(offline.starts).toEqual([]);
  });

  it("reports a backend the reconcile and the autostart both miss only once", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    let old = "";
    await prepared(dataDir, pipePath, new FakeBackend(), async (c) => {
      await c.request("profile.create", { name: "a", launch, autostart: true });
      old = (await c.request("session.create", { name: "build", launch })).result.session.id;
    });

    const offline = new FakeBackend();
    offline.isAvailable = false;
    const stderr = stderrSink();
    const core = await start({ pipePath, dataDir, backends: [offline], stderr });
    await core.autostart?.started;
    const c = await client(pipePath);

    expect((await c.request("core.status", {})).result).toEqual({ backendUnavailable: ["wsl"] });
    const sessions = (await c.request("session.list", {})).result.sessions;
    expect(sessions.map((session) => [session.id, session.state])).toEqual([[old, "Interrupted"]]);
    expect(stderr.lines.filter((line) => line.includes("backend_unavailable: wsl"))).toHaveLength(1);
  });
});
