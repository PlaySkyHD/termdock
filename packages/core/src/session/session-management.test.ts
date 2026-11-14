// Rename, move, archive and delete sessions in the registry (issue #57, spec session-lifecycle).
import { describe, expect, it, vi } from "vitest";
import type { LaunchSpec, SessionId } from "@termdock/protocol";
import { FakeBackend } from "../backend/fake.js";
import { InMemorySessionRepository } from "../storage/session-repository.js";
import { SessionRegistry } from "./registry.js";
import type { SessionRegistryOptions, WriterChangedEvent } from "./registry.js";

const spec: LaunchSpec = { backend: "wsl", cwd: "/home/user/project" };

/** Lets the registry finish its existence check after a PTY ended without exit code. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: Partial<SessionRegistryOptions> = {}) {
  const backend = new FakeBackend();
  const repository = new InMemorySessionRepository();
  const removed: SessionId[] = [];
  let tick = 0;
  const registry = new SessionRegistry({
    backends: [backend],
    repository,
    // Every call is one second later, so each change has its own updatedAt.
    now: () => new Date(Date.UTC(2026, 10, 14, 10, 0, tick++)),
    removeHistory: async (sessionId) => void removed.push(sessionId),
    ...options,
  });
  const writers: WriterChangedEvent[] = [];
  registry.onWriterChanged((event) => writers.push(event));
  return { registry, backend, repository, removed, writers };
}

async function exited(registry: SessionRegistry, backend: FakeBackend) {
  const session = await registry.create({ name: "shell", launch: spec });
  backend.pty(session.id).emitExit(0);
  return session.id;
}

async function interrupted(registry: SessionRegistry, backend: FakeBackend) {
  const session = await registry.create({ name: "shell", launch: spec });
  backend.setExists(session.id, false);
  backend.pty(session.id).emitExit();
  await settle();
  expect(registry.get(session.id).state).toBe("Interrupted");
  return session.id;
}

describe("SessionRegistry.update", () => {
  it("renames a running session without touching its process and stores the change", async () => {
    const { registry, backend, repository } = setup();
    const session = await registry.create({ name: "shell", launch: spec });
    const pty = backend.pty(session.id);

    const updated = registry.update(session.id, { name: "build" });

    expect(updated).toMatchObject({ id: session.id, name: "build", state: "Detached" });
    expect(updated.updatedAt > session.updatedAt).toBe(true);
    expect(repository.list()[0]).toMatchObject({ name: "build", updatedAt: updated.updatedAt });
    expect(backend.pty(session.id)).toBe(pty);
    expect(pty.disposed).toBe(false);
    expect(backend.kills).toEqual([]);
    expect(backend.starts).toHaveLength(1);
  });

  it("moves a session to ungrouped and back into a workspace", async () => {
    const { registry, repository } = setup();
    const session = await registry.create({ name: "shell", launch: spec, workspaceId: "w1" });

    const ungrouped = registry.update(session.id, { workspaceId: null });
    expect(ungrouped).not.toHaveProperty("workspaceId");
    expect(repository.list()[0]).not.toHaveProperty("workspaceId");

    const moved = registry.update(session.id, { workspaceId: "w2" });
    expect(moved.workspaceId).toBe("w2");
    expect(repository.list()[0]?.workspaceId).toBe("w2");
    expect(registry.get(session.id).state).toBe("Detached");
  });

  it("switches the history off and leaves fields that are not in the patch unchanged", async () => {
    const { registry } = setup();
    const session = await registry.create({ name: "shell", launch: spec, workspaceId: "w1" });

    const updated = registry.update(session.id, { loggingEnabled: false });

    expect(updated).toMatchObject({ name: "shell", workspaceId: "w1", loggingEnabled: false });
  });

  it("renames an archived session", async () => {
    const { registry, backend } = setup();
    const id = await exited(registry, backend);
    await registry.archive(id);

    expect(registry.update(id, { name: "old build" })).toMatchObject({
      name: "old build",
      state: "Archived",
    });
  });

  it("rejects an empty or too long name and an unknown session", async () => {
    const { registry } = setup();
    const session = await registry.create({ name: "shell", launch: spec });

    expect(() => registry.update(session.id, { name: "  " })).toThrow(
      expect.objectContaining({ code: "bad_request" }),
    );
    expect(() => registry.update(session.id, { name: "x".repeat(129) })).toThrow(
      expect.objectContaining({ code: "bad_request" }),
    );
    expect(() => registry.update("nope", { name: "x" })).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(registry.get(session.id).name).toBe("shell");
  });
});

describe("SessionRegistry.archive keeps the history", () => {
  it("ends a running process, archives the session and does not remove its history", async () => {
    const { registry, backend, removed, repository } = setup();
    const session = await registry.create({ name: "shell", launch: spec });
    await registry.attachView(session.id, "v1");

    await registry.archive(session.id);

    expect(backend.kills).toEqual([session.id]);
    expect(registry.get(session.id)).toMatchObject({ state: "Archived" });
    expect(registry.get(session.id)).not.toHaveProperty("writerViewId");
    expect(repository.list()[0]?.state).toBe("Archived");
    expect(removed).toEqual([]);
  });
});

describe("SessionRegistry.delete", () => {
  it.each(["Detached", "Running"] as const)("rejects a %s session with invalid_state", async (state) => {
    const { registry, backend, removed, repository } = setup();
    const session = await registry.create({ name: "shell", launch: spec });
    if (state === "Running") await registry.attachView(session.id, "v1");

    await expect(registry.delete(session.id)).rejects.toMatchObject({ code: "invalid_state" });

    expect(registry.get(session.id).state).toBe(state);
    expect(repository.list()).toHaveLength(1);
    expect(removed).toEqual([]);
    expect(backend.kills).toEqual([]);
  });

  it("rejects a session that is still starting", async () => {
    const { registry, backend } = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const start = backend.start.bind(backend);
    backend.start = async (...args) => {
      await gate;
      return start(...args);
    };
    const creating = registry.create({ name: "shell", launch: spec });
    const [starting] = registry.list();

    await expect(registry.delete(starting!.id)).rejects.toMatchObject({ code: "invalid_state" });

    release();
    await creating;
  });

  it("detaches the views, removes history and stored row of an Exited session and forgets it", async () => {
    const { registry, backend, removed, repository, writers } = setup();
    const session = await registry.create({ name: "shell", launch: spec });
    await registry.attachView(session.id, "v1");
    await registry.attachView(session.id, "v2");
    backend.pty(session.id).emitExit(0);
    writers.length = 0;

    await registry.delete(session.id);

    // Still addressed to the views, so the server can deliver it before it forgets them.
    expect(writers).toEqual([{ sessionId: session.id, writerViewId: undefined, viewIds: ["v1", "v2"] }]);
    expect(removed).toEqual([session.id]);
    expect(repository.list()).toEqual([]);
    expect(registry.list()).toEqual([]);
    expect(() => registry.get(session.id)).toThrow(expect.objectContaining({ code: "not_found" }));
    await expect(registry.delete(session.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("ends a backend session that survived an Interrupted session, so none is left behind", async () => {
    const { registry, backend, removed } = setup();
    const id = await interrupted(registry, backend);
    backend.setExists(id, true);

    await registry.delete(id);

    expect(backend.kills).toEqual([id]);
    expect(await backend.exists(id, spec)).toBe(false);
    expect(removed).toEqual([id]);
    expect(registry.list()).toEqual([]);
  });

  it("does not end anything when the Interrupted session has no backend session left", async () => {
    const { registry, backend } = setup();
    const id = await interrupted(registry, backend);

    await registry.delete(id);

    expect(backend.kills).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it.each(["Exited", "Archived"] as const)(
    "deletes an %s session without asking the backend",
    async (state) => {
      const { registry, backend, removed } = setup();
      const id = await exited(registry, backend);
      if (state === "Archived") await registry.archive(id);
      backend.failNextExists = new Error("WSL unreachable");

      await registry.delete(id);

      expect(removed).toEqual([id]);
      expect(registry.list()).toEqual([]);
      expect(backend.failNextExists).toBeDefined();
    },
  );

  it("deletes an Interrupted session when the check fails because the backend is not available", async () => {
    const { registry, backend, removed } = setup();
    const id = await interrupted(registry, backend);
    backend.failNextExists = new Error("WSL not installed");
    backend.isAvailable = false;

    await registry.delete(id);

    expect(backend.kills).toEqual([]);
    expect(removed).toEqual([id]);
    expect(registry.list()).toEqual([]);
  });

  it("keeps the session when the existence check fails while the backend is available", async () => {
    const { registry, backend, removed, repository } = setup();
    const id = await interrupted(registry, backend);
    backend.failNextExists = new Error("WSL unreachable");

    await expect(registry.delete(id)).rejects.toMatchObject({ code: "backend_unavailable" });

    expect(registry.get(id).state).toBe("Interrupted");
    expect(repository.list()).toHaveLength(1);
    expect(removed).toEqual([]);
  });

  it("keeps the session and its views when ending the leftover backend session fails", async () => {
    const { registry, backend, removed } = setup();
    const id = await interrupted(registry, backend);
    await registry.attachView(id, "v1");
    backend.setExists(id, true);
    backend.failNextKill = new Error("tmux failed");

    await expect(registry.delete(id)).rejects.toMatchObject({ code: "backend_unavailable" });

    expect(registry.get(id)).toMatchObject({ state: "Interrupted", writerViewId: "v1" });
    expect(removed).toEqual([]);
  });

  it("keeps the session and its stored row when the history cannot be removed", async () => {
    const failure = new Error("EBUSY");
    const { registry, backend, repository } = setup({
      removeHistory: async () => {
        throw failure;
      },
    });
    const id = await exited(registry, backend);

    await expect(registry.delete(id)).rejects.toMatchObject({ code: "internal", cause: failure });

    expect(registry.get(id).state).toBe("Exited");
    expect(repository.list()).toHaveLength(1);
  });

  it("rejects attach, update, restart and a second delete while the delete runs", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { registry, backend, repository } = setup({ removeHistory: () => gate });
    const id = await exited(registry, backend);

    const deleting = registry.delete(id);
    await settle();

    await expect(registry.attachView(id, "late")).rejects.toMatchObject({ code: "invalid_state" });
    expect(() => registry.update(id, { name: "x" })).toThrow(
      expect.objectContaining({ code: "invalid_state" }),
    );
    await expect(registry.restart(id)).rejects.toMatchObject({ code: "invalid_state" });
    await expect(registry.delete(id)).rejects.toMatchObject({ code: "invalid_state" });

    release();
    await deleting;
    expect(registry.list()).toEqual([]);
    expect(repository.list()).toEqual([]);
    expect(backend.starts).toHaveLength(1);
  });

  it("changes nothing when the registry is disposed while the delete runs", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { registry, backend, repository } = setup({ removeHistory: () => gate });
    const id = await exited(registry, backend);

    const deleting = registry.delete(id);
    await settle();
    registry.dispose();
    release();

    await expect(deleting).rejects.toMatchObject({ code: "invalid_state" });
    expect(registry.list().map((s) => s.id)).toEqual([id]);
    expect(repository.list()).toHaveLength(1);
  });

  it("reports a failing row delete as internal and keeps the session", async () => {
    const repository = new InMemorySessionRepository();
    const failure = new Error("disk full");
    const { registry, backend } = setup({ repository });
    const id = await exited(registry, backend);
    vi.spyOn(repository, "delete").mockImplementation(() => {
      throw failure;
    });

    await expect(registry.delete(id)).rejects.toMatchObject({ code: "internal", cause: failure });

    expect(registry.get(id).state).toBe("Exited");
  });
});
