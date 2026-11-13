import { describe, expect, it } from "vitest";
import type { LaunchSpec, SessionState } from "@termdock/protocol";
import { FakeBackend } from "../backend/fake.js";
import { InMemorySessionRepository } from "../storage/session-repository.js";
import { SessionRegistry } from "./registry.js";
import type { SessionRegistryOptions } from "./registry.js";

const spec: LaunchSpec = { backend: "wsl", cwd: "/home/user/project" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function setup(options: Partial<SessionRegistryOptions> = {}, backend = new FakeBackend()) {
  const registry = new SessionRegistry({ backends: [backend], ...options });
  const states: Array<{ sessionId: string; from: SessionState; to: SessionState }> = [];
  registry.onStateChange(({ sessionId, from, to }) => states.push({ sessionId, from, to }));
  return { registry, backend, states };
}

/** Lets the registry finish its existence check after a PTY ended without exit code. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe("SessionRegistry: create and start", () => {
  it("registers a session with a UUID and starts it once through the backend", async () => {
    const { registry, backend, states } = setup();

    const session = await registry.create({ name: "shell", launch: spec });

    expect(session.id).toMatch(UUID);
    expect(backend.starts).toEqual([{ id: session.id, spec, size: { cols: 80, rows: 24 } }]);
    expect(registry.get(session.id).state).toBe("Detached");
    expect(states.map((s) => `${s.from}->${s.to}`)).toEqual(["Starting->Running", "Running->Detached"]);
    expect(registry.list().map((s) => s.id)).toEqual([session.id]);
  });

  it("gives every session its own id", async () => {
    const { registry } = setup();
    const a = await registry.create({ name: "a", launch: spec });
    const b = await registry.create({ name: "b", launch: spec });
    expect(a.id).not.toBe(b.id);
  });

  it("marks the session Interrupted and rejects with backend_unavailable when the start fails", async () => {
    const { registry, backend } = setup();
    backend.failNextStart = new Error("distro not reachable");

    await expect(registry.create({ name: "shell", launch: spec })).rejects.toMatchObject({
      code: "backend_unavailable",
    });

    const [session] = registry.list();
    expect(session?.state).toBe("Interrupted");
  });

  it("rejects with backend_unavailable when no backend handles the launch spec", async () => {
    const { registry } = setup();
    await expect(
      registry.create({ name: "pwsh", launch: { backend: "windows", cwd: "C:\\" } }),
    ).rejects.toMatchObject({
      code: "backend_unavailable",
    });
  });

  it("reports unknown sessions as not_found", () => {
    const { registry } = setup();
    expect(errorCode(() => registry.get("missing"))).toBe("not_found");
  });

  it("pins the backend's default distro in the stored launch spec before starting", async () => {
    const backend = new FakeBackend();
    backend.defaultDistro = "Ubuntu";
    const repository = new InMemorySessionRepository();
    const { registry } = setup({ repository }, backend);

    const session = await registry.create({ name: "shell", launch: spec });

    expect(session.launch).toEqual({ ...spec, distro: "Ubuntu" });
    expect(backend.starts[0]?.spec).toEqual({ ...spec, distro: "Ubuntu" });
    expect(repository.list()[0]?.launch.distro).toBe("Ubuntu");
  });

  it("treats a failing resolve as a failed start", async () => {
    const { registry, backend } = setup();
    backend.failNextResolve = new Error("wsl.exe -l failed");

    await expect(registry.create({ name: "shell", launch: spec })).rejects.toMatchObject({
      code: "backend_unavailable",
    });

    expect(registry.list()[0]?.state).toBe("Interrupted");
    expect(backend.starts).toEqual([]);
  });
});

describe("SessionRegistry: views", () => {
  it("moves Detached -> Running on the first view and back on the last detach without ending the process", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });

    await registry.attachView(id, "view-a");
    expect(registry.get(id).state).toBe("Running");
    await registry.attachView(id, "view-b");
    registry.detachView(id, "view-a");
    expect(registry.get(id).state).toBe("Running");
    registry.detachView(id, "view-b");

    expect(registry.get(id).state).toBe("Detached");
    expect(backend.kills).toEqual([]);
    expect(backend.pty(id).disposed).toBe(false);
  });

  it("starts as Running when a view attached while the session was Starting", async () => {
    const { registry, states } = setup();
    const created = registry.create({ name: "shell", launch: spec });
    const [starting] = registry.list();
    expect(starting?.state).toBe("Starting");

    await registry.attachView(starting!.id, "view-a");
    await created;

    expect(registry.get(starting!.id).state).toBe("Running");
    expect(states.map((s) => `${s.from}->${s.to}`)).toEqual(["Starting->Running"]);
  });

  it("rejects unknown sessions and views with not_found and duplicate views with bad_request", async () => {
    const { registry } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    await registry.attachView(id, "view-a");

    await expect(registry.attachView("missing", "view-a")).rejects.toMatchObject({ code: "not_found" });
    await expect(registry.attachView(id, "view-a")).rejects.toMatchObject({ code: "bad_request" });
    expect(errorCode(() => registry.detachView(id, "view-x"))).toBe("not_found");
  });
});

describe("SessionRegistry: input lock", () => {
  it("lets only the first view write when two views are attached", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    const a = await registry.attachView(id, "view-a");
    const b = await registry.attachView(id, "view-b");

    expect(a.writer).toBe(true);
    expect(b.writer).toBe(false);
    expect(registry.get(id).writerViewId).toBe("view-a");
    registry.input(id, "view-a", "ls\r");
    expect(errorCode(() => registry.input(id, "view-b", "rm -rf ~\r"))).toBe("not_writer");
    expect(backend.pty(id).input).toBe("ls\r");
  });

  it("moves the writer atomically with claimWriter and reports it to all three views", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    const changes: Array<{ writerViewId: string | undefined; viewIds: readonly string[] }> = [];
    registry.onWriterChanged((e) => changes.push({ writerViewId: e.writerViewId, viewIds: e.viewIds }));
    await registry.attachView(id, "view-a");
    await registry.attachView(id, "view-b");
    await registry.attachView(id, "view-c");

    registry.claimWriter(id, "view-c");

    expect(registry.get(id).writerViewId).toBe("view-c");
    expect(errorCode(() => registry.input(id, "view-a", "a"))).toBe("not_writer");
    expect(errorCode(() => registry.input(id, "view-b", "b"))).toBe("not_writer");
    registry.input(id, "view-c", "c");
    expect(backend.pty(id).input).toBe("c");
    expect(changes).toEqual([
      { writerViewId: "view-a", viewIds: ["view-a"] },
      { writerViewId: "view-c", viewIds: ["view-a", "view-b", "view-c"] },
    ]);
  });

  it("does not pick a new writer when the writer detaches", async () => {
    const { registry } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    const changes: Array<string | undefined> = [];
    registry.onWriterChanged((e) => changes.push(e.writerViewId));
    await registry.attachView(id, "view-a");
    await registry.attachView(id, "view-b");

    registry.detachView(id, "view-a");
    const c = await registry.attachView(id, "view-c");

    expect(registry.get(id).writerViewId).toBeUndefined();
    expect(c.writer).toBe(false);
    expect(errorCode(() => registry.input(id, "view-b", "x"))).toBe("not_writer");
    expect(errorCode(() => registry.input(id, "view-c", "x"))).toBe("not_writer");
    expect(changes).toEqual(["view-a", undefined]);
  });

  it("rejects input when no process runs", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    await registry.attachView(id, "view-a");
    backend.pty(id).emitExit(0);

    expect(errorCode(() => registry.input(id, "view-a", "x"))).toBe("invalid_state");
  });

  it("rejects claimWriter for views that are not attached", async () => {
    const { registry } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    expect(errorCode(() => registry.claimWriter(id, "view-x"))).toBe("not_found");
  });
});

describe("SessionRegistry: resize authority", () => {
  it("resizes the PTY only for the writer and reports the size to all views", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    const resized: Array<{ cols: number; rows: number; viewIds: readonly string[] }> = [];
    registry.onResized((e) => resized.push({ ...e.size, viewIds: e.viewIds }));
    await registry.attachView(id, "view-a");
    await registry.attachView(id, "view-b");

    registry.resize(id, "view-a", { cols: 120, rows: 40 });
    expect(errorCode(() => registry.resize(id, "view-b", { cols: 10, rows: 5 }))).toBe("not_writer");

    expect(backend.pty(id).resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(registry.get(id).size).toEqual({ cols: 120, rows: 40 });
    expect(resized).toEqual([{ cols: 120, rows: 40, viewIds: ["view-a", "view-b"] }]);
  });

  it("follows the new writer after claimWriter", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    await registry.attachView(id, "view-a");
    await registry.attachView(id, "view-b");

    registry.claimWriter(id, "view-b");
    registry.resize(id, "view-b", { cols: 100, rows: 30 });

    expect(errorCode(() => registry.resize(id, "view-a", { cols: 120, rows: 40 }))).toBe("not_writer");
    expect(backend.pty(id).resizes).toEqual([{ cols: 100, rows: 30 }]);
  });

  it("rejects sizes that are not positive integers with bad_request", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    await registry.attachView(id, "view-a");

    expect(errorCode(() => registry.resize(id, "view-a", { cols: 0, rows: 24 }))).toBe("bad_request");
    expect(errorCode(() => registry.resize(id, "view-a", { cols: 80.5, rows: 24 }))).toBe("bad_request");
    expect(backend.pty(id).resizes).toEqual([]);
  });
});

describe("SessionRegistry: output", () => {
  const decode = (data: Uint8Array) => new TextDecoder().decode(data);

  it("reports each PTY output once with all attached views", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    const outputs: Array<{ data: string; viewIds: readonly string[] }> = [];
    registry.onOutput((e) => outputs.push({ data: decode(e.data), viewIds: e.viewIds }));
    await registry.attachView(id, "view-a");
    await registry.attachView(id, "view-b");

    backend.pty(id).emitData("hello\r\n");

    expect(outputs).toEqual([{ data: "hello\r\n", viewIds: ["view-a", "view-b"] }]);
  });

  it("gives a new view the last 256 KiB of output when the backend has no snapshot", async () => {
    const { registry, backend } = setup({}, new FakeBackend({ kind: "windows" }));
    const { id } = await registry.create({
      name: "pwsh",
      launch: { backend: "windows", shell: "pwsh", cwd: "C:\\" },
    });
    const chunk = new Uint8Array(100 * 1024);
    for (let i = 0; i < 3; i++) backend.pty(id).emitData(chunk.fill(65 + i));

    const { snapshot } = await registry.attachView(id, "view-a");

    expect(snapshot.data.byteLength).toBe(256 * 1024);
    const text = decode(snapshot.data);
    expect(text).toBe("A".repeat(56 * 1024) + "B".repeat(100 * 1024) + "C".repeat(100 * 1024));
  });

  it("uses the backend snapshot when the backend provides one", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitData("raw output");
    backend.setSnapshot(id, { data: new TextEncoder().encode("screen"), cursor: { x: 6, y: 0 } });

    const { snapshot } = await registry.attachView(id, "view-a");

    expect(decode(snapshot.data)).toBe("screen");
    expect(snapshot.cursor).toEqual({ x: 6, y: 0 });
  });

  it("numbers the output of a session and gives a new view the number before it as mark (issue #34)", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    const outputs: Array<{ seq: number; viewIds: readonly string[] }> = [];
    registry.onOutput((e) => outputs.push({ seq: e.seq, viewIds: e.viewIds }));
    expect((await registry.attachView(id, "view-a")).outputSeq).toBe(0);
    for (const data of ["a", "b", "c"]) backend.pty(id).emitData(data);

    const { outputSeq } = await registry.attachView(id, "view-b");
    backend.pty(id).emitData("d");

    expect(outputSeq).toBe(3);
    expect(outputs.at(-1)).toEqual({ seq: 4, viewIds: ["view-a", "view-b"] });
  });

  it("keeps counting when the PTY is replaced (issue #34)", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitData("old");
    backend.pty(id).loseClient();
    await settle();

    backend.pty(id).emitData("new");

    expect((await registry.attachView(id, "view-a")).outputSeq).toBe(2);
  });

  it("leaves the backend snapshot as it is and keeps output of the query below the mark (issue #34)", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.setSnapshot(id, { data: new TextEncoder().encode("screen"), cursor: { x: 6, y: 0 } });
    const outputs: Array<{ seq: number; viewIds: readonly string[] }> = [];
    registry.onOutput((e) => outputs.push({ seq: e.seq, viewIds: e.viewIds }));

    const attaching = registry.attachView(id, "view-a");
    backend.pty(id).emitData("+live");
    const { snapshot, outputSeq } = await attaching;

    expect(decode(snapshot.data)).toBe("screen");
    expect(snapshot.cursor).toEqual({ x: 6, y: 0 });
    expect(outputs).toEqual([{ seq: 1, viewIds: [] }]);
    expect(outputSeq).toBe(1);
  });

  it("asks the backend to redraw once the view is registered when the snapshot is the backend's (issue #34)", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.setSnapshot(id, "screen");
    const writersAtRedraw: Array<string | undefined> = [];
    backend.onRedraw = (sessionId) => writersAtRedraw.push(registry.get(sessionId).writerViewId);

    await registry.attachView(id, "view-a");

    expect(backend.redraws).toEqual([id]);
    expect(writersAtRedraw).toEqual(["view-a"]);
  });

  it("does not redraw when the snapshot comes from the core buffer (issue #34)", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitData("buffered");

    await registry.attachView(id, "view-a");

    expect(backend.redraws).toEqual([]);
  });

  it("attaches with the backend snapshot when the redraw fails (issue #34)", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.setSnapshot(id, "screen");
    backend.failNextRedraw = new Error("refresh-client failed");

    const { snapshot } = await registry.attachView(id, "view-a");
    await settle();

    expect(decode(snapshot.data)).toBe("screen");
    expect(registry.get(id).writerViewId).toBe("view-a");
  });

  it("drops the backend snapshot when the PTY ends while it is taken", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitData("last words");
    backend.setSnapshot(id, "stale screen");

    const attaching = registry.attachView(id, "view-a");
    backend.pty(id).emitExit(0);
    const { snapshot } = await attaching;

    expect(decode(snapshot.data)).toBe("last words");
  });
});

describe("SessionRegistry: end of the PTY", () => {
  it("moves to Exited with the exit code when the process ends by itself", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    await registry.attachView(id, "view-a");

    backend.pty(id).emitExit(3);

    const session = registry.get(id);
    expect(session.state).toBe("Exited");
    expect(session.lastExitCode).toBe(3);
    expect(session.writerViewId).toBe("view-a");
  });

  it.each([["Running"], ["Detached"]] as const)(
    "moves %s to Interrupted when the PTY ends without exit code and the backend session is gone",
    async (state) => {
      const { registry, backend } = setup();
      const { id } = await registry.create({ name: "shell", launch: spec });
      if (state === "Running") await registry.attachView(id, "view-a");
      expect(registry.get(id).state).toBe(state);

      backend.pty(id).emitExit();
      await settle();

      expect(registry.get(id).state).toBe("Interrupted");
      expect(registry.get(id).lastExitCode).toBeUndefined();
    },
  );
});

describe("SessionRegistry: kill", () => {
  it.each([["Running"], ["Detached"]] as const)(
    "ends a %s session through the backend as Exited",
    async (state) => {
      const { registry, backend } = setup();
      const { id } = await registry.create({ name: "shell", launch: spec });
      if (state === "Running") await registry.attachView(id, "view-a");

      await registry.kill(id);

      expect(backend.kills).toEqual([id]);
      expect(registry.get(id).state).toBe("Exited");
      expect(backend.pty(id).disposed).toBe(true);
    },
  );

  it("keeps the exit code the PTY reports while being killed", async () => {
    const { registry } = setup({}, new FakeBackend({ killExitCode: 130 }));
    const { id } = await registry.create({ name: "shell", launch: spec });

    await registry.kill(id);

    expect(registry.get(id)).toMatchObject({ state: "Exited", lastExitCode: 130 });
  });

  it("rejects kill of a session without process with invalid_state", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitExit(0);

    await expect(registry.kill(id)).rejects.toMatchObject({ code: "invalid_state" });
    expect(registry.get(id).state).toBe("Exited");
    expect(backend.kills).toEqual([]);
  });
});

describe("SessionRegistry: restart", () => {
  it("restarts an Exited session under the same id and keeps its views and writer", async () => {
    const { registry, backend, states } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    await registry.attachView(id, "view-a");
    backend.pty(id).emitExit(0);
    states.length = 0;

    const session = await registry.restart(id);

    expect(session.id).toBe(id);
    expect(session.state).toBe("Running");
    expect(session.writerViewId).toBe("view-a");
    expect(backend.starts).toHaveLength(2);
    expect(states.map((s) => `${s.from}->${s.to}`)).toEqual(["Exited->Starting", "Starting->Running"]);
    registry.input(id, "view-a", "echo again\r");
    expect(backend.pty(id).input).toBe("echo again\r");
  });

  it("re-attaches instead of starting a second process when the backend session still exists", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitExit();
    await settle();
    backend.setExists(id, true);

    const session = await registry.restart(id);

    expect(session.state).toBe("Detached");
    expect(backend.starts).toHaveLength(1);
    expect(backend.attaches.map((a) => a.id)).toEqual([id]);
  });

  it("ignores output and exit of the previous PTY after a restart", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    const old = backend.pty(id);
    old.emitExit(0);
    await registry.restart(id);
    const outputs: string[] = [];
    registry.onOutput((e) => outputs.push(new TextDecoder().decode(e.data)));

    old.emitData("stale");
    backend.pty(id).emitData("fresh");

    expect(outputs).toEqual(["fresh"]);
    expect(registry.get(id).state).toBe("Detached");
  });

  it("marks the session Interrupted when the restart fails", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitExit(0);
    backend.failNextStart = new Error("gone");

    await expect(registry.restart(id)).rejects.toMatchObject({ code: "backend_unavailable" });
    expect(registry.get(id).state).toBe("Interrupted");
  });

  it.each([["Detached"], ["Archived"]] as const)(
    "rejects restart from %s with invalid_state",
    async (state) => {
      const { registry, backend } = setup();
      const { id } = await registry.create({ name: "shell", launch: spec });
      if (state === "Archived") await registry.archive(id);

      await expect(registry.restart(id)).rejects.toMatchObject({ code: "invalid_state" });
      expect(registry.get(id).state).toBe(state);
      expect(backend.starts).toHaveLength(1);
    },
  );
});

describe("SessionRegistry: archive", () => {
  it("kills a running process first, then archives and detaches all views", async () => {
    const { registry, backend, states } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    await registry.attachView(id, "view-a");
    await registry.attachView(id, "view-b");
    states.length = 0;

    const session = await registry.archive(id);

    expect(backend.kills).toEqual([id]);
    expect(session.state).toBe("Archived");
    expect(session.writerViewId).toBeUndefined();
    expect(states.map((s) => `${s.from}->${s.to}`)).toEqual(["Running->Archived"]);
    await expect(registry.attachView(id, "view-c")).rejects.toMatchObject({ code: "invalid_state" });
    expect(errorCode(() => registry.input(id, "view-a", "x"))).toBe("not_found");
  });

  it("archives an Exited session without calling the backend", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitExit(0);

    await registry.archive(id);

    expect(backend.kills).toEqual([]);
    expect(registry.get(id)).toMatchObject({ state: "Archived", lastExitCode: 0 });
  });

  it("kills a backend session that survived an Interrupted PTY before archiving", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitExit();
    await settle();
    backend.setExists(id, true);

    await registry.archive(id);

    expect(backend.kills).toEqual([id]);
    expect(registry.get(id).state).toBe("Archived");
  });

  it("rejects archiving twice with invalid_state", async () => {
    const { registry } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    await registry.archive(id);

    await expect(registry.archive(id)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("rejects archive while the session is Starting", async () => {
    const { registry } = setup();
    const created = registry.create({ name: "shell", launch: spec });
    const [starting] = registry.list();

    await expect(registry.archive(starting!.id)).rejects.toMatchObject({ code: "invalid_state" });
    await created;
  });
});

describe("SessionRegistry: backend failures", () => {
  const decode = (data: Uint8Array) => new TextDecoder().decode(data);

  it("settles a session as Interrupted when kill fails after the PTY ended without exit code", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.failNextKill = new Error("wsl.exe failed");

    await expect(registry.kill(id)).rejects.toMatchObject({ code: "backend_unavailable" });

    expect(registry.get(id).state).toBe("Interrupted");
    await registry.restart(id);
    expect(registry.get(id).state).toBe("Detached");
  });

  it("settles a session as Exited when archive fails after the PTY reported an exit code", async () => {
    const { registry, backend } = setup({}, new FakeBackend({ killExitCode: 143 }));
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.failNextKill = new Error("wsl.exe failed");

    await expect(registry.archive(id)).rejects.toMatchObject({ code: "backend_unavailable" });

    expect(registry.get(id)).toMatchObject({ state: "Exited", lastExitCode: 143 });
  });

  it("applies a resize made while Starting to the new PTY", async () => {
    const { registry, backend } = setup();
    const created = registry.create({ name: "shell", launch: spec });
    const [starting] = registry.list();
    // Without a PTY, attachView registers the view synchronously; stay in the same tick so the start is pending.
    const attached = registry.attachView(starting!.id, "view-a");
    registry.resize(starting!.id, "view-a", { cols: 132, rows: 43 });
    expect(registry.get(starting!.id).state).toBe("Starting");
    await Promise.all([attached, created]);

    expect(backend.pty(starting!.id).size).toEqual({ cols: 132, rows: 43 });
  });

  it("falls back to the core buffer when the backend snapshot fails", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitData("buffered");
    backend.failNextSnapshot = new Error("capture-pane failed");

    const { snapshot } = await registry.attachView(id, "view-a");

    expect(decode(snapshot.data)).toBe("buffered");
    expect(registry.get(id).writerViewId).toBe("view-a");
  });

  it("reports a failing exists check during archive as backend_unavailable", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitExit();
    await settle();
    backend.failNextExists = new Error("wsl.exe failed");

    await expect(registry.archive(id)).rejects.toMatchObject({ code: "backend_unavailable" });
    expect(registry.get(id).state).toBe("Interrupted");
  });

  it("names the new session id in the error when the first start fails", async () => {
    const { registry, backend } = setup();
    backend.failNextStart = new Error("distro not reachable");

    const error = await registry.create({ name: "shell", launch: spec }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "backend_unavailable", sessionId: registry.list()[0]?.id });
    expect((error as { sessionId?: string }).sessionId).toMatch(UUID);
  });

  it("keeps the last output when a restart fails", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitData("last words");
    backend.pty(id).emitExit(1);
    backend.failNextStart = new Error("gone");

    await expect(registry.restart(id)).rejects.toMatchObject({ code: "backend_unavailable" });
    const { snapshot } = await registry.attachView(id, "view-a");

    expect(decode(snapshot.data)).toBe("last words");
  });
});
