import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LaunchSpec, SessionInfo, SessionState } from "@termdock/protocol";
import { FakeBackend } from "../backend/fake.js";
import { openStorage } from "../storage/database.js";
import type { Storage } from "../storage/database.js";
import { InMemorySessionRepository } from "../storage/session-repository.js";
import { SessionRegistry } from "./registry.js";

const wsl: LaunchSpec = { backend: "wsl", distro: "Ubuntu", cwd: "/home/user/project" };
const windows: LaunchSpec = { backend: "windows", shell: "pwsh", cwd: "C:\\Projects\\x" };

const opened: Storage[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  // Close handles before deleting: Windows keeps open database files locked.
  for (const storage of opened.splice(0)) storage.dispose();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stored(overrides: Partial<SessionInfo> & Pick<SessionInfo, "id" | "state">): SessionInfo {
  return {
    name: `session ${overrides.id}`,
    launch: wsl,
    size: { cols: 100, rows: 30 },
    loggingEnabled: true,
    createdAt: "2026-11-13T10:00:00.000Z",
    updatedAt: "2026-11-13T10:00:00.000Z",
    ...overrides,
  };
}

function stateOf(repository: InMemorySessionRepository, id: string): SessionState | undefined {
  return repository.list().find((session) => session.id === id)?.state;
}

describe("SessionRegistry: write-through", () => {
  it("stores a created session and every state change", async () => {
    const repository = new InMemorySessionRepository();
    const backend = new FakeBackend();
    const registry = new SessionRegistry({ backends: [backend], repository });

    const session = await registry.create({ name: "shell", launch: wsl, workspaceId: "ws-1" });
    expect(repository.list()).toEqual([registry.get(session.id)]);
    expect(stateOf(repository, session.id)).toBe("Detached");

    backend.pty(session.id).emitExit(3);

    expect(repository.list()).toEqual([expect.objectContaining({ state: "Exited", lastExitCode: 3 })]);
  });

  it("stores the state before it reports the change", async () => {
    const repository = new InMemorySessionRepository();
    const registry = new SessionRegistry({ backends: [new FakeBackend()], repository });
    const seen: Array<[SessionState, SessionState | undefined]> = [];
    registry.onStateChange(({ sessionId, to }) => seen.push([to, stateOf(repository, sessionId)]));

    await registry.create({ name: "shell", launch: wsl });

    expect(seen).toEqual([
      ["Running", "Running"],
      ["Detached", "Detached"],
    ]);
  });

  it("stores the session already while it is starting", async () => {
    const repository = new InMemorySessionRepository();
    const backend = new FakeBackend();
    backend.failNextStart = new Error("boom");
    const registry = new SessionRegistry({ backends: [backend], repository });

    await expect(registry.create({ name: "shell", launch: wsl })).rejects.toMatchObject({
      code: "backend_unavailable",
    });

    expect(repository.list().map((s) => s.state)).toEqual(["Interrupted"]);
  });

  it("stores the size the writer sets", async () => {
    const repository = new InMemorySessionRepository();
    const registry = new SessionRegistry({ backends: [new FakeBackend()], repository });
    const session = await registry.create({ name: "shell", launch: wsl });
    await registry.attachView(session.id, "view-a");

    registry.resize(session.id, "view-a", { cols: 120, rows: 40 });

    expect(repository.list()[0]?.size).toEqual({ cols: 120, rows: 40 });
  });

  it("stores archiving", async () => {
    const repository = new InMemorySessionRepository();
    const registry = new SessionRegistry({ backends: [new FakeBackend()], repository });
    const session = await registry.create({ name: "shell", launch: wsl });

    await registry.archive(session.id);

    expect(stateOf(repository, session.id)).toBe("Archived");
  });
});

const NOW = new Date("2026-11-14T08:00:00.000Z");

function restoring(sessions: SessionInfo[], backends = [new FakeBackend()]) {
  const repository = new InMemorySessionRepository();
  for (const session of sessions) repository.save(session);
  const registry = new SessionRegistry({ backends, repository, now: () => NOW });
  return { registry, repository, backends };
}

describe("SessionRegistry.restore: reconcile (ADR 0005)", () => {
  it("re-attaches a live WSL session and makes it Detached without starting a new process", async () => {
    const backend = new FakeBackend();
    backend.setExists("live", true);
    const { registry, repository } = restoring([stored({ id: "live", state: "Running" })], [backend]);

    const result = await registry.restore();

    expect(result).toEqual({
      sessions: [{ sessionId: "live", from: "Running", to: "Detached" }],
      backendUnavailable: [],
    });
    expect(backend.starts).toEqual([]);
    expect(backend.attaches).toEqual([{ id: "live", spec: wsl, size: { cols: 100, rows: 30 } }]);
    expect(registry.get("live")).toMatchObject({ state: "Detached", updatedAt: NOW.toISOString() });
    expect(stateOf(repository, "live")).toBe("Detached");
  });

  it("binds the re-attached PTY: views get output and input reaches the process", async () => {
    const backend = new FakeBackend();
    backend.setExists("live", true);
    const { registry } = restoring([stored({ id: "live", state: "Detached" })], [backend]);
    await registry.restore();
    const output: string[] = [];
    registry.onOutput(({ data }) => output.push(new TextDecoder().decode(data)));

    await registry.attachView("live", "view-a");
    registry.input("live", "view-a", "ls\r");
    backend.pty("live").emitData("hello");

    expect(registry.get("live").state).toBe("Running");
    expect(backend.pty("live").input).toBe("ls\r");
    expect(output).toEqual(["hello"]);
  });

  it("re-attaches a live session that was still Starting", async () => {
    const backend = new FakeBackend();
    backend.setExists("starting", true);
    const { registry } = restoring([stored({ id: "starting", state: "Starting" })], [backend]);

    await registry.restore();

    expect(registry.get("starting").state).toBe("Detached");
  });

  it("makes a WSL session whose tmux session is gone Interrupted", async () => {
    const backend = new FakeBackend();
    const { registry, repository } = restoring([stored({ id: "gone", state: "Detached" })], [backend]);

    const result = await registry.restore();

    expect(result.sessions).toEqual([{ sessionId: "gone", from: "Detached", to: "Interrupted" }]);
    expect(result.backendUnavailable).toEqual([]);
    expect(backend.attaches).toEqual([]);
    expect(registry.get("gone").state).toBe("Interrupted");
    expect(stateOf(repository, "gone")).toBe("Interrupted");
  });

  it("makes a Windows session Interrupted without asking the backend", async () => {
    const backend = new FakeBackend({ kind: "windows" });
    const probe = new Error("exists must not be called");
    backend.failNextExists = probe;
    backend.isAvailable = false;
    const { registry } = restoring([stored({ id: "win", state: "Running", launch: windows })], [backend]);

    const result = await registry.restore();

    expect(result).toEqual({
      sessions: [{ sessionId: "win", from: "Running", to: "Interrupted" }],
      backendUnavailable: [],
    });
    expect(backend.failNextExists).toBe(probe);
    expect(backend.attaches).toEqual([]);
  });

  it("makes WSL sessions Interrupted and reports backend_unavailable when WSL is not available", async () => {
    const backend = new FakeBackend();
    backend.isAvailable = false;
    backend.setExists("a", true);
    const { registry } = restoring(
      [stored({ id: "a", state: "Running" }), stored({ id: "b", state: "Detached" })],
      [backend],
    );

    const result = await registry.restore();

    expect(result.backendUnavailable).toEqual(["wsl"]);
    expect(registry.list().map((s) => s.state)).toEqual(["Interrupted", "Interrupted"]);
    expect(backend.attaches).toEqual([]);
  });

  it("reports backend_unavailable when the existence check fails and still reconciles the other sessions", async () => {
    const backend = new FakeBackend();
    backend.failNextExists = new Error("wsl.exe timed out");
    backend.setExists("b", true);
    const { registry } = restoring(
      [
        stored({ id: "a", state: "Running" }),
        stored({ id: "b", state: "Running", createdAt: "2026-11-13T11:00:00.000Z" }),
      ],
      [backend],
    );

    const result = await registry.restore();

    expect(result.backendUnavailable).toEqual(["wsl"]);
    expect(registry.get("a").state).toBe("Interrupted");
    expect(registry.get("b").state).toBe("Detached");
  });

  it("reports backend_unavailable when no backend of the kind is registered", async () => {
    const { registry } = restoring([stored({ id: "a", state: "Running" })], []);

    const result = await registry.restore();

    expect(result.backendUnavailable).toEqual(["wsl"]);
    expect(registry.get("a").state).toBe("Interrupted");
  });

  it("makes a session Interrupted when re-attaching fails", async () => {
    const backend = new FakeBackend();
    backend.setExists("a", true);
    backend.failNextStart = new Error("attach failed");
    const { registry } = restoring([stored({ id: "a", state: "Detached" })], [backend]);

    const result = await registry.restore();

    expect(result.backendUnavailable).toEqual([]);
    expect(registry.get("a").state).toBe("Interrupted");
  });

  it("keeps Exited, Interrupted and Archived sessions unchanged without asking the backend", async () => {
    const backend = new FakeBackend();
    const probe = new Error("exists must not be called");
    backend.failNextExists = probe;
    const sessions = [
      stored({ id: "exited", state: "Exited", lastExitCode: 0 }),
      stored({ id: "interrupted", state: "Interrupted" }),
      stored({ id: "archived", state: "Archived" }),
    ];
    const { registry, repository } = restoring(sessions, [backend]);

    const result = await registry.restore();

    expect(result).toEqual({ sessions: [], backendUnavailable: [] });
    expect(registry.list()).toEqual(repository.list());
    expect(registry.list()).toEqual(expect.arrayContaining(sessions));
    expect(backend.failNextExists).toBe(probe);
  });

  it("restores sessions whose lifecycle continues: an interrupted session restarts under the same id", async () => {
    const backend = new FakeBackend();
    const { registry } = restoring([stored({ id: "gone", state: "Running" })], [backend]);
    await registry.restore();

    const session = await registry.restart("gone");

    expect(session).toMatchObject({ id: "gone", state: "Detached" });
    expect(backend.starts.map((s) => s.id)).toEqual(["gone"]);
  });

  it("requires a repository", async () => {
    const registry = new SessionRegistry({ backends: [new FakeBackend()] });

    await expect(registry.restore()).rejects.toMatchObject({ code: "internal" });
  });

  it("rejects a restore into a registry that already has sessions", async () => {
    const { registry } = restoring([stored({ id: "a", state: "Exited" })]);
    await registry.restore();

    await expect(registry.restore()).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("Core restart with the same database (acceptance 09)", () => {
  it("restores live, lost, Windows and finished sessions from the file", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "termdock-restart-"));
    tempDirs.push(dataDir);
    // The fake backends play tmux and ConPTY; tmux sessions survive the Core, ConPTY shells do not.
    const wslBackend = new FakeBackend();
    const windowsBackend = new FakeBackend({ kind: "windows" });

    const storageA = openStorage({ dataDir });
    opened.push(storageA);
    const registryA = new SessionRegistry({
      backends: [wslBackend, windowsBackend],
      repository: storageA.sessions,
    });
    const live = await registryA.create({ name: "live", launch: wsl, workspaceId: "ws-1" });
    await registryA.attachView(live.id, "view-a");
    const lost = await registryA.create({ name: "lost", launch: wsl });
    const win = await registryA.create({ name: "win", launch: windows });
    const done = await registryA.create({ name: "done", launch: { ...wsl, command: ["make", "test"] } });
    wslBackend.pty(done.id).emitExit(0);
    const before = registryA.list();
    // Core A goes away without cleaning up; the tmux session of "lost" ends meanwhile.
    storageA.dispose();
    wslBackend.setExists(lost.id, false);

    const storageB = openStorage({ dataDir });
    opened.push(storageB);
    const registryB = new SessionRegistry({
      backends: [wslBackend, windowsBackend],
      repository: storageB.sessions,
    });
    const result = await registryB.restore();

    expect(result.backendUnavailable).toEqual([]);
    const after = new Map(registryB.list().map((s) => [s.id, s]));
    expect(after.get(live.id)?.state).toBe("Detached");
    expect(after.get(lost.id)?.state).toBe("Interrupted");
    expect(after.get(win.id)?.state).toBe("Interrupted");
    expect(after.get(done.id)).toMatchObject({ state: "Exited", lastExitCode: 0 });
    expect(wslBackend.attaches.map((a) => a.id)).toEqual([live.id]);
    for (const session of before) {
      expect(after.get(session.id)).toMatchObject({
        id: session.id,
        name: session.name,
        launch: session.launch,
      });
    }
    expect(after.get(live.id)?.workspaceId).toBe("ws-1");
    expect(after.get(live.id)?.writerViewId).toBeUndefined();
    expect(storageB.sessions.list().map((s) => s.state)).toEqual(registryB.list().map((s) => s.state));
  });
});
