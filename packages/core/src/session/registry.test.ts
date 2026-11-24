import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("starts and returns the session although an onCreated listener throws (issue #46)", async () => {
    const { registry } = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    registry.onCreated(() => {
      throw new Error("listener bug");
    });
    registry.onCreated(({ session }) => seen.push(session.id));

    const info = await registry.create({ name: "shell", launch: spec });

    expect(info.state).toBe("Detached");
    expect(seen).toEqual([info.id]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
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
  it("[V1-05] lets only the first view write when two views are attached", async () => {
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
  it("[V1-06] resizes the PTY only for the writer and reports the size to all views", async () => {
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

  it("puts the terminal modes of the output before the backend snapshot (issue #42)", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    // What tmux 3.6 writes to its client at start and for `set -g mouse on`.
    backend.pty(id).emitData("\x1b[?1h\x1b=\x1b[?2004h$ ");
    backend.pty(id).emitData("\x1b[?1006l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006h\x1b[?1000h\x1b[?1002h");
    backend.setSnapshot(id, { data: new TextEncoder().encode("screen"), cursor: { x: 6, y: 0 } });

    const { snapshot } = await registry.attachView(id, "view-a");

    expect(decode(snapshot.data)).toBe("\x1b[?1h\x1b=\x1b[?1002h\x1b[?1006h\x1b[?2004hscreen");
    expect(snapshot.cursor).toEqual({ x: 6, y: 0 });
  });

  it("puts the terminal modes before the core buffer too, and none that were switched off (issue #42)", async () => {
    const { registry, backend } = setup({}, new FakeBackend({ kind: "windows" }));
    const { id } = await registry.create({
      name: "pwsh",
      launch: { backend: "windows", shell: "pwsh", cwd: "C:\\" },
    });
    backend.pty(id).emitData("\x1b[?1000h\x1b[?20");
    backend.pty(id).emitData("04h\x1b[?1004h a ");
    backend.pty(id).emitData("\x1b[?1000l b");

    const { snapshot } = await registry.attachView(id, "view-a");

    expect(decode(snapshot.data)).toBe(
      "\x1b[?1004h\x1b[?2004h\x1b[?1000h\x1b[?20" + "04h\x1b[?1004h a \x1b[?1000l b",
    );
  });

  it("keeps the modes over a lost client but no sequence cut off by it (issue #42)", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitData("\x1b[?1h\x1b[?20");
    backend.pty(id).loseClient();
    await settle();
    backend.pty(id).emitData("04h");
    backend.setSnapshot(id, "screen");

    const { snapshot } = await registry.attachView(id, "view-a");

    expect(backend.attaches).toHaveLength(1);
    expect(decode(snapshot.data)).toBe("\x1b[?1hscreen");
  });

  it("starts without modes after a restart (issue #42)", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitData("\x1b[?2004h");
    backend.pty(id).emitExit(0);
    await registry.restart(id);
    backend.setSnapshot(id, "screen");

    const { snapshot } = await registry.attachView(id, "view-a");

    expect(decode(snapshot.data)).toBe("screen");
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

  it("retries a failed redraw once without reporting it (PR #39)", async () => {
    const errors: unknown[] = [];
    const { registry, backend } = setup({ onRedrawError: (error) => errors.push(error) });
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.setSnapshot(id, "screen");
    backend.failNextRedraw = new Error("refresh-client failed");

    await registry.attachView(id, "view-a");
    await settle();

    expect(backend.redraws).toEqual([id, id]);
    expect(errors).toEqual([]);
  });

  it("reports a redraw that fails again on the retry (PR #39)", async () => {
    const errors: Array<{ error: unknown; sessionId: string }> = [];
    const { registry, backend } = setup({
      onRedrawError: (error, session) => errors.push({ error, sessionId: session.id }),
    });
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.setSnapshot(id, "screen");
    const failure = new Error("refresh-client failed");
    backend.failNextRedraw = failure;
    backend.onRedraw = () => (backend.failNextRedraw ??= failure);

    await registry.attachView(id, "view-a");
    await settle();

    expect(backend.redraws).toEqual([id, id]);
    expect(errors).toEqual([{ error: failure, sessionId: id }]);
  });

  it("merges redraws requested while one runs into a single follow-up (PR #39)", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.setSnapshot(id, "screen");
    let release = () => {};
    backend.redrawGate = new Promise<void>((resolve) => (release = resolve));

    // Like a layout restore (#29): several panes of one session attach right after each other.
    for (const view of ["view-a", "view-b", "view-c", "view-d"]) await registry.attachView(id, view);
    expect(backend.redraws).toEqual([id]);
    release();
    await settle();

    expect(backend.redraws).toEqual([id, id]);
  });

  describe("marks the output of a requested redraw (issue #88)", () => {
    async function redrawing(options: Partial<SessionRegistryOptions> = {}, backendSnapshot = true) {
      const { registry, backend } = setup(options);
      const { id } = await registry.create({ name: "shell", launch: spec });
      if (backendSnapshot) backend.setSnapshot(id, "screen");
      const outputs: Array<{ text: string; fromRedraw: boolean; viewIds: readonly string[] }> = [];
      registry.onOutput((e) =>
        outputs.push({
          text: new TextDecoder().decode(e.data),
          fromRedraw: e.fromRedraw,
          viewIds: e.viewIds,
        }),
      );
      // Like tmux after `refresh-client`: the repaint arrives through the PTY before the call returns.
      backend.onRedraw = (sessionId) => backend.pty(sessionId).emitData("repaint");
      return { registry, backend, id, outputs };
    }

    it("flags output while the redraw runs and passes it to the views", async () => {
      const { registry, backend, id, outputs } = await redrawing();
      await registry.attachView(id, "view-a");
      await settle();
      backend.pty(id).emitData("before");

      await registry.attachView(id, "view-b");
      await settle();
      backend.pty(id).emitData("after");

      expect(outputs).toEqual([
        { text: "repaint", fromRedraw: true, viewIds: ["view-a"] },
        { text: "before", fromRedraw: false, viewIds: ["view-a"] },
        { text: "repaint", fromRedraw: true, viewIds: ["view-a", "view-b"] },
        { text: "after", fromRedraw: false, viewIds: ["view-a", "view-b"] },
      ]);
    });

    it("flags output during each call, also of a merged follow-up redraw", async () => {
      const { registry, backend, id, outputs } = await redrawing();
      let release = () => {};
      backend.redrawGate = new Promise<void>((resolve) => (release = resolve));
      await registry.attachView(id, "view-a");
      await registry.attachView(id, "view-b");
      backend.pty(id).emitData("waiting");

      backend.redrawGate = undefined;
      release();
      await settle();
      backend.pty(id).emitData("after");

      expect(backend.redraws).toEqual([id, id]);
      expect(outputs.map(({ text, fromRedraw }) => `${text}:${fromRedraw}`)).toEqual([
        "repaint:true",
        "waiting:true",
        "repaint:true",
        "after:false",
      ]);
    });

    it("does not flag the first output of a PTY re-attached during a redraw call (known limit)", async () => {
      const { registry, backend, id, outputs } = await redrawing();
      let release = () => {};
      backend.redrawGate = new Promise<void>((resolve) => (release = resolve));
      await registry.attachView(id, "view-a");
      const lost = backend.pty(id);

      lost.loseClient();
      await vi.waitFor(() => expect(backend.pty(id)).not.toBe(lost));
      backend.pty(id).emitData("fresh");
      release();
      await settle();

      expect(outputs.map(({ text, fromRedraw }) => `${text}:${fromRedraw}`)).toEqual([
        "repaint:true",
        "fresh:false",
      ]);
    });

    it("flags the re-attached PTY during the call of a follow-up redraw", async () => {
      const { registry, backend, id, outputs } = await redrawing();
      let release = () => {};
      backend.redrawGate = new Promise<void>((resolve) => (release = resolve));
      await registry.attachView(id, "view-a");
      const lost = backend.pty(id);
      lost.loseClient();
      await vi.waitFor(() => expect(backend.pty(id)).not.toBe(lost));
      // A view attaching to the new PTY merges a follow-up into the running redraw.
      await registry.attachView(id, "view-b");

      backend.redrawGate = undefined;
      release();
      await settle();
      backend.pty(id).emitData("after");

      expect(backend.redraws).toEqual([id, id]);
      expect(outputs.map(({ text, fromRedraw }) => `${text}:${fromRedraw}`)).toEqual([
        "repaint:true",
        "repaint:true",
        "after:false",
      ]);
    });

    it("flags the repaint of the retry after a failed first call", async () => {
      const { registry, backend, id, outputs } = await redrawing();
      backend.failNextRedraw = new Error("refresh-client failed");
      // A failed call repaints nothing; the retry does.
      backend.onRedraw = (sessionId) => {
        if (!backend.failNextRedraw) backend.pty(sessionId).emitData("repaint");
      };

      await registry.attachView(id, "view-a");
      await settle();
      backend.pty(id).emitData("after");

      expect(backend.redraws).toEqual([id, id]);
      expect(outputs.map(({ text, fromRedraw }) => `${text}:${fromRedraw}`)).toEqual([
        "repaint:true",
        "after:false",
      ]);
    });

    it("stops flagging when a call takes longer than redrawOutputMaxMs", async () => {
      const { registry, backend, id, outputs } = await redrawing({ redrawOutputMaxMs: 20 });
      let release = () => {};
      backend.redrawGate = new Promise<void>((resolve) => (release = resolve));
      await registry.attachView(id, "view-a");
      backend.pty(id).emitData("early");

      await new Promise((resolve) => setTimeout(resolve, 60));
      backend.pty(id).emitData("late");
      release();
      await settle();

      expect(outputs.map(({ text, fromRedraw }) => `${text}:${fromRedraw}`)).toEqual([
        "repaint:true",
        "early:true",
        "late:false",
      ]);
    });

    it("stops flagging after a redraw failed twice", async () => {
      const failure = new Error("refresh-client failed");
      const { registry, backend, id, outputs } = await redrawing({ onRedrawError: () => {} });
      backend.failNextRedraw = failure;
      backend.onRedraw = () => (backend.failNextRedraw ??= failure);

      await registry.attachView(id, "view-a");
      await settle();
      backend.pty(id).emitData("after");

      expect(backend.redraws).toEqual([id, id]);
      expect(outputs).toEqual([{ text: "after", fromRedraw: false, viewIds: ["view-a"] }]);
    });

    it("flags the repaint of tmux after a resize until the requested redraw ends (issue #99)", async () => {
      const { registry, backend, id, outputs } = await redrawing({}, false);
      await registry.attachView(id, "view-a");
      backend.pty(id).emitData("before");
      let release = () => {};
      backend.redrawGate = new Promise<void>((resolve) => (release = resolve));

      registry.resize(id, "view-a", { cols: 120, rows: 40 });
      // Like tmux after the client got SIGWINCH: the repaint follows the resize through the PTY.
      backend.pty(id).emitData("resize-repaint");
      release();
      await settle();
      backend.pty(id).emitData("after");

      expect(backend.redraws).toEqual([id]);
      expect(backend.pty(id).resizes).toEqual([{ cols: 120, rows: 40 }]);
      expect(outputs.map(({ text, fromRedraw }) => `${text}:${fromRedraw}`)).toEqual([
        "before:false",
        "repaint:true",
        "resize-repaint:true",
        "after:false",
      ]);
    });

    it("merges resizes while a redraw runs into one follow-up and flags them all (issue #99)", async () => {
      const { registry, backend, id, outputs } = await redrawing({}, false);
      await registry.attachView(id, "view-a");
      let release = () => {};
      backend.redrawGate = new Promise<void>((resolve) => (release = resolve));

      // Like dragging the window edge: one resize after the other.
      for (const cols of [100, 101, 102]) {
        registry.resize(id, "view-a", { cols, rows: 30 });
        backend.pty(id).emitData(`resize-${cols}`);
      }
      backend.redrawGate = undefined;
      release();
      await settle();
      backend.pty(id).emitData("after");

      expect(backend.redraws).toEqual([id, id]);
      expect(outputs.map(({ text, fromRedraw }) => `${text}:${fromRedraw}`)).toEqual([
        "repaint:true",
        "resize-100:true",
        "resize-101:true",
        "resize-102:true",
        "repaint:true",
        "after:false",
      ]);
    });

    it("requests no redraw for a resize to the current size (issue #99)", async () => {
      const { registry, backend, id, outputs } = await redrawing({}, false);
      await registry.attachView(id, "view-a");
      const { size } = registry.get(id);

      registry.resize(id, "view-a", { ...size });
      backend.pty(id).emitData("live");

      expect(backend.redraws).toEqual([]);
      expect(outputs.map(({ text, fromRedraw }) => `${text}:${fromRedraw}`)).toEqual(["live:false"]);
    });

    describe("bounds the flag of a resize chain (issue #99)", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      /** Like the WSL backend: a redraw call takes about 270 ms and repaints right before it ends. */
      async function slowRedraws(options: Partial<SessionRegistryOptions> = {}) {
        vi.useFakeTimers();
        // The fake clock drives the monotonic clock of the chain as well.
        const setup = await redrawing({ monotonicNow: () => Date.now(), ...options }, false);
        const { backend } = setup;
        backend.onRedraw = (sessionId) => {
          backend.redrawGate = new Promise<void>((resolve) =>
            setTimeout(() => {
              if (!backend.pty(sessionId).ended) backend.pty(sessionId).emitData("repaint");
              resolve();
            }, 270),
          );
        };
        await setup.registry.attachView(setup.id, "view-a");
        return setup;
      }

      it("stores program output once the window was dragged for longer than the limit", async () => {
        const { registry, backend, id, outputs } = await slowRedraws();
        // The renderer sends a resize every 70 ms while the edge is dragged, for 2.1 s.
        for (let step = 0; step < 30; step += 1) {
          registry.resize(id, "view-a", { cols: 100 + step, rows: 30 });
          backend.pty(id).emitData(`program-${step * 70}`);
          await vi.advanceTimersByTimeAsync(70);
        }
        await vi.advanceTimersByTimeAsync(2_000);
        backend.pty(id).emitData("after");

        const program = outputs.filter(({ text }) => text.startsWith("program-"));
        const flagged = program.filter(({ fromRedraw }) => fromRedraw).map(({ text }) => text);
        const stored = program.filter(({ fromRedraw }) => !fromRedraw).map(({ text }) => text);
        // Within RESIZE_REDRAW_MAX_MS the output is flagged, afterwards it is stored again.
        expect(flagged.at(-1)).toBe("program-980");
        expect(stored[0]).toBe("program-1050");
        expect(stored.at(-1)).toBe("program-2030");
        // No flagged follow-up after the limit; the bounded chain also bounds the backend calls.
        expect(backend.redraws.length).toBeLessThanOrEqual(5);
        expect(outputs.at(-1)).toEqual({ text: "after", fromRedraw: false, viewIds: ["view-a"] });
      });

      it("keeps the follow-up an attach asked for during a resize call flagged past the limit", async () => {
        const { registry, backend, id, outputs } = await slowRedraws();
        registry.resize(id, "view-a", { cols: 100, rows: 30 });
        await vi.advanceTimersByTimeAsync(800);
        // A second resize of the chain: its call runs from 800 to 1070 ms.
        registry.resize(id, "view-a", { cols: 101, rows: 30 });
        await vi.advanceTimersByTimeAsync(100);
        backend.setSnapshot(id, "screen");
        await registry.attachView(id, "view-b");
        // The limit passes at 1000 ms; the follow-up for the attach runs from 1070 to 1340 ms.
        await vi.advanceTimersByTimeAsync(300);
        backend.pty(id).emitData("during-attach-redraw");
        await vi.advanceTimersByTimeAsync(1_000);
        backend.pty(id).emitData("after");

        expect(backend.redraws).toEqual([id, id, id]);
        expect(outputs.map(({ text, fromRedraw }) => `${text}:${fromRedraw}`)).toEqual([
          "repaint:true",
          // The resize call ends after the limit: its repaint is stored.
          "repaint:false",
          "during-attach-redraw:true",
          "repaint:true",
          "after:false",
        ]);
      });

      it("keeps an attach redraw that runs past the limit of a resize chain flagged", async () => {
        const { registry, backend, id, outputs } = await slowRedraws();
        registry.resize(id, "view-a", { cols: 100, rows: 30 });
        await vi.advanceTimersByTimeAsync(850);
        backend.setSnapshot(id, "screen");
        // Its call runs from 850 to 1120 ms, across the limit of the chain at 1000 ms.
        await registry.attachView(id, "view-b");
        await vi.advanceTimersByTimeAsync(200);
        backend.pty(id).emitData("during-attach-redraw");
        await vi.advanceTimersByTimeAsync(1_000);
        backend.pty(id).emitData("after");

        expect(outputs.map(({ text, fromRedraw }) => `${text}:${fromRedraw}`)).toEqual([
          "repaint:true",
          "during-attach-redraw:true",
          "repaint:true",
          "after:false",
        ]);
      });

      it("flags a single resize after a quiet pause again", async () => {
        const { registry, backend, id, outputs } = await slowRedraws();
        for (let step = 0; step < 20; step += 1) {
          registry.resize(id, "view-a", { cols: 100 + step, rows: 30 });
          await vi.advanceTimersByTimeAsync(70);
        }
        await vi.advanceTimersByTimeAsync(2_000);
        outputs.length = 0;

        registry.resize(id, "view-a", { cols: 80, rows: 24 });
        backend.pty(id).emitData("resize-repaint");
        await vi.advanceTimersByTimeAsync(1_000);
        backend.pty(id).emitData("after");

        expect(outputs.map(({ text, fromRedraw }) => `${text}:${fromRedraw}`)).toEqual([
          "resize-repaint:true",
          "repaint:true",
          "after:false",
        ]);
      });
    });

    it("requests no redraw for a resize of a session without PTY and keeps the size (issue #99)", async () => {
      const { registry, backend, id } = await redrawing({}, false);
      await registry.attachView(id, "view-a");
      backend.pty(id).emitExit(0);
      expect(registry.get(id).state).toBe("Exited");

      registry.resize(id, "view-a", { cols: 120, rows: 40 });

      expect(backend.redraws).toEqual([]);
      expect(registry.get(id).size).toEqual({ cols: 120, rows: 40 });
    });

    it("stops flagging after the redraw of a resize failed twice (issue #99)", async () => {
      const failure = new Error("refresh-client failed");
      const { registry, backend, id, outputs } = await redrawing({ onRedrawError: () => {} }, false);
      await registry.attachView(id, "view-a");
      backend.failNextRedraw = failure;
      backend.onRedraw = () => (backend.failNextRedraw ??= failure);

      registry.resize(id, "view-a", { cols: 120, rows: 40 });
      await settle();
      backend.pty(id).emitData("late-repaint");

      expect(backend.redraws).toEqual([id, id]);
      expect(outputs).toEqual([{ text: "late-repaint", fromRedraw: false, viewIds: ["view-a"] }]);
    });

    it("does not flag output when no redraw was requested", async () => {
      const { registry, backend, id, outputs } = await redrawing({}, false);
      backend.pty(id).emitData("buffered");
      await registry.attachView(id, "view-a");
      backend.pty(id).emitData("live");

      expect(backend.redraws).toEqual([]);
      expect(outputs.map(({ fromRedraw }) => fromRedraw)).toEqual([false, false]);
    });
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

describe("SessionRegistry: killAll (issue #160)", () => {
  it("closes each PTY and waits for its process before it ends the backend session", async () => {
    const { registry, backend } = setup();
    const ids: string[] = [];
    for (const name of ["a", "b"]) ids.push((await registry.create({ name, launch: spec })).id);
    const release = new Map<string, () => void>();
    for (const id of ids) {
      const gate = new Promise<void>((resolve) => release.set(id, resolve));
      Object.assign(backend.pty(id), { closed: () => gate });
    }
    const disposedAtKill: boolean[] = [];
    const kill = backend.kill.bind(backend);
    backend.kill = async (id, launch) => {
      disposedAtKill.push(backend.pty(id).disposed);
      return kill(id, launch);
    };

    const done = registry.killAll(ids);
    await settle();
    expect(ids.map((id) => backend.pty(id).disposed)).toEqual([true, true]);
    expect(backend.kills).toEqual([]);
    release.get(ids[1]!)!();
    await settle();
    expect(backend.kills).toEqual([ids[1]]);
    release.get(ids[0]!)!();
    const results = await done;

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(backend.kills).toEqual([ids[1], ids[0]]);
    expect(disposedAtKill).toEqual([true, true]);
    expect(ids.map((id) => registry.get(id).state)).toEqual(["Exited", "Exited"]);
  });

  it("ends the backend sessions without waiting any longer once the wait for the PTYs is over", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "hangs", launch: spec });
    Object.assign(backend.pty(id), { closed: () => new Promise<void>(() => {}) });

    const [result] = await registry.killAll([id], 30);

    expect(result!.status).toBe("fulfilled");
    expect(backend.kills).toEqual([id]);
    expect(registry.get(id).state).toBe("Exited");
  });

  it("leaves a session whose backend could not be ended in its state, so the next core reconciles it as Detached", async () => {
    const repository = new InMemorySessionRepository();
    const backend = new FakeBackend();
    const { registry } = setup({ repository }, backend);
    const failing = (await registry.create({ name: "a", launch: spec })).id;
    const other = (await registry.create({ name: "b", launch: spec })).id;
    await registry.attachView(failing, "view-a");
    const kill = backend.kill.bind(backend);
    // `kill-session` fails, the tmux session lives on.
    backend.kill = async (id, launch) => {
      if (id === failing) throw new Error("wsl.exe failed");
      return kill(id, launch);
    };

    const results = await registry.killAll([failing, other]);

    expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "backend_unavailable" } });
    expect(results[1]!.status).toBe("fulfilled");
    expect(registry.get(failing).state).toBe("Running");
    expect(registry.get(other).state).toBe("Exited");
    expect(repository.list().find((session) => session.id === failing)?.state).toBe("Running");

    // The core ends; the next one reconciles the stored session.
    registry.dispose();
    const next = new SessionRegistry({ backends: [backend], repository });
    await next.restore();
    expect(next.get(failing).state).toBe("Detached");
    expect(next.get(other).state).toBe("Exited");
    next.dispose();
  });

  it("logs how many PTYs the wait gave up on", async () => {
    const warnings: string[] = [];
    const { registry, backend } = setup({ onWarning: (text) => warnings.push(text) });
    const ids: string[] = [];
    for (const name of ["a", "b"]) ids.push((await registry.create({ name, launch: spec })).id);
    for (const id of ids) Object.assign(backend.pty(id), { closed: () => new Promise<void>(() => {}) });

    await registry.killAll(ids, 30);

    expect(warnings).toEqual([
      "2 PTY(s) still closing after 30 ms; their sessions were ended without waiting",
    ]);
  });

  it("rejects a session without process with invalid_state, as kill", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitExit(0);

    const [result] = await registry.killAll([id]);

    expect(result).toMatchObject({ status: "rejected", reason: { code: "invalid_state" } });
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

  it("writes a separator line as the first output of the new run (issue #156)", async () => {
    const now = new Date("2026-11-20T08:00:00.000Z");
    const { registry, backend } = setup({ now: () => now });
    const { id } = await registry.create({ name: "shell", launch: spec });
    await registry.attachView(id, "view-a");
    backend.pty(id).emitData("alt");
    backend.pty(id).emitExit(0);
    const outputs: Array<{ seq: number; data: string; viewIds: readonly string[]; fromRedraw: boolean }> = [];
    registry.onOutput((e) =>
      outputs.push({
        seq: e.seq,
        data: new TextDecoder().decode(e.data),
        viewIds: e.viewIds,
        fromRedraw: e.fromRedraw,
      }),
    );

    await registry.restart(id);
    backend.pty(id).emitData("neu");

    const separator = "\r\n--- Neu gestartet 2026-11-20T08:00:00.000Z ---\r\n";
    expect(outputs).toEqual([
      { seq: 2, data: separator, viewIds: ["view-a"], fromRedraw: false },
      { seq: 3, data: "neu", viewIds: ["view-a"], fromRedraw: false },
    ]);
    // The old output is gone, the buffer starts with the separator (the fallback snapshot of a new view).
    const { snapshot } = await registry.attachView(id, "view-b");
    expect(new TextDecoder().decode(snapshot.data)).toBe(`${separator}neu`);
  });

  it("writes no separator when the restart re-attaches a backend session that runs on", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitExit();
    await settle();
    backend.setExists(id, true);
    const outputs: string[] = [];
    registry.onOutput((e) => outputs.push(new TextDecoder().decode(e.data)));

    await registry.restart(id);
    backend.pty(id).emitData("weiter");

    expect(backend.starts).toHaveLength(1);
    expect(outputs).toEqual(["weiter"]);
  });

  it("writes no separator when the restart fails", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitExit(0);
    backend.failNextStart = new Error("gone");
    const outputs: string[] = [];
    registry.onOutput((e) => outputs.push(new TextDecoder().decode(e.data)));

    await expect(registry.restart(id)).rejects.toMatchObject({ code: "backend_unavailable" });

    expect(outputs).toEqual([]);
  });

  it("starts once when restart is called twice without waiting (issue #156)", async () => {
    const { registry, backend, states } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.pty(id).emitExit(0);
    states.length = 0;

    const results = await Promise.allSettled([registry.restart(id), registry.restart(id)]);

    expect(results[0]).toMatchObject({ status: "fulfilled", value: { id, state: "Detached" } });
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "invalid_state" } });
    expect(backend.starts).toHaveLength(2);
    expect(states.map((s) => `${s.from}->${s.to}`)).toEqual([
      "Exited->Starting",
      "Starting->Running",
      "Running->Detached",
    ]);
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

describe("SessionRegistry: clearWorkspace (issue #56)", () => {
  it("ungroups only the sessions of the workspace, keeps their processes and stores the change", async () => {
    const repository = new InMemorySessionRepository();
    const now = new Date("2026-11-14T12:00:00.000Z");
    const { registry, backend } = setup({ repository, now: () => now });
    const a = await registry.create({ name: "a", launch: spec, workspaceId: "w1" });
    const b = await registry.create({ name: "b", launch: spec, workspaceId: "w2" });
    const c = await registry.create({ name: "c", launch: spec });
    const stateBefore = registry.get(a.id).state;

    const changed = registry.clearWorkspace("w1");

    expect(changed.map((s) => s.id)).toEqual([a.id]);
    expect("workspaceId" in changed[0]!).toBe(false);
    expect(changed[0]).toMatchObject({ state: stateBefore, updatedAt: now.toISOString() });
    expect("workspaceId" in registry.get(a.id)).toBe(false);
    expect(registry.get(b.id).workspaceId).toBe("w2");
    expect(registry.get(c.id).workspaceId).toBeUndefined();
    expect(backend.pty(a.id).ended).toBe(false);
    const stored = repository.list();
    expect("workspaceId" in stored.find((s) => s.id === a.id)!).toBe(false);
    expect(stored.find((s) => s.id === b.id)?.workspaceId).toBe("w2");
    expect(registry.clearWorkspace("w1")).toEqual([]);
  });

  it("changes memory only after the wrapped write went through", async () => {
    const { registry } = setup({ repository: new InMemorySessionRepository() });
    const a = await registry.create({ name: "a", launch: spec, workspaceId: "w1" });

    expect(() =>
      registry.clearWorkspace("w1", () => {
        throw new Error("rolled back");
      }),
    ).toThrow("rolled back");
    expect(registry.get(a.id).workspaceId).toBe("w1");

    let wrote = 0;
    registry.clearWorkspace("w1", (write) => {
      write();
      wrote += 1;
      expect(registry.get(a.id).workspaceId).toBe("w1");
    });
    expect(wrote).toBe(1);
    expect(registry.get(a.id).workspaceId).toBeUndefined();
  });

  it("clears stored rows that are not in memory", () => {
    const repository = new InMemorySessionRepository();
    repository.save({
      id: "stored-only",
      name: "x",
      state: "Exited",
      launch: spec,
      workspaceId: "w1",
      size: { cols: 80, rows: 24 },
      loggingEnabled: true,
      createdAt: "2026-11-13T10:00:00.000Z",
      updatedAt: "2026-11-13T10:00:00.000Z",
    });
    const { registry } = setup({ repository });

    expect(registry.clearWorkspace("w1")).toEqual([]);
    expect(repository.list()[0]?.workspaceId).toBeUndefined();
  });

  it("changes nothing in memory when the repository fails", async () => {
    class Failing extends InMemorySessionRepository {
      override clearWorkspace(): void {
        throw new Error("disk full");
      }
    }
    const { registry } = setup({ repository: new Failing() });
    const a = await registry.create({ name: "a", launch: spec, workspaceId: "w1" });

    expect(() => registry.clearWorkspace("w1")).toThrow("disk full");
    expect(registry.get(a.id).workspaceId).toBe("w1");
  });
});

// Issue #113 (openspec change missing-cwd-warning): a missing working directory starts the session with a warning.
describe("SessionRegistry: start warnings", () => {
  const missing = { code: "cwd_missing", path: "/srv/api", distro: "Ubuntu" };
  const missingSpec: LaunchSpec = { backend: "wsl", distro: "Ubuntu", cwd: "/srv/api" };

  function warned() {
    const backend = new FakeBackend();
    backend.missingCwds.add("/srv/api");
    const context = setup({}, backend);
    const changes: Array<{ to: SessionState; warnings: unknown }> = [];
    context.registry.onStateChange(({ to, session }) => changes.push({ to, warnings: session.warnings }));
    return { ...context, changes };
  }

  it("starts the session and reports the warning in the answer, the list and the state changes", async () => {
    const { registry, changes } = warned();

    const session = await registry.create({ name: "api", launch: missingSpec });

    expect(session.state).toBe("Detached");
    expect(session.warnings).toEqual([missing]);
    expect(registry.get(session.id).warnings).toEqual([missing]);
    expect(changes).toEqual([
      { to: "Running", warnings: [missing] },
      { to: "Detached", warnings: [missing] },
    ]);
  });

  it("keeps the warning while views come and go and drops it when the process ends", async () => {
    const { registry, backend, changes } = warned();
    const { id } = await registry.create({ name: "api", launch: missingSpec });
    await registry.attachView(id, "view-a");
    registry.detachView(id, "view-a");
    expect(registry.get(id).warnings).toEqual([missing]);

    backend.pty(id).emitExit(0);

    expect(registry.get(id).state).toBe("Exited");
    expect(registry.get(id).warnings).toBeUndefined();
    expect(changes.at(-1)).toEqual({ to: "Exited", warnings: undefined });
  });

  it("checks again on a restart: no warning once the directory exists", async () => {
    const { registry, backend, changes } = warned();
    const { id } = await registry.create({ name: "api", launch: missingSpec });
    backend.pty(id).emitExit(0);
    backend.missingCwds.clear();
    changes.length = 0;

    const session = await registry.restart(id);

    expect(session.warnings).toBeUndefined();
    expect(changes.map((change) => change.warnings)).toEqual([undefined, undefined, undefined]);
  });

  it("reports no warning when the restart re-attaches to a backend session that still runs", async () => {
    const { registry, backend } = warned();
    const { id } = await registry.create({ name: "api", launch: missingSpec });
    backend.pty(id).emitExit();
    await settle();
    backend.setExists(id, true);

    const session = await registry.restart(id);

    expect(backend.attaches.map((a) => a.id)).toEqual([id]);
    expect(session.warnings).toBeUndefined();
  });

  it("has no warning for a directory that exists", async () => {
    const { registry } = warned();
    const session = await registry.create({ name: "api", launch: { ...missingSpec, cwd: "/srv" } });
    expect(session.warnings).toBeUndefined();
    expect("warnings" in session).toBe(false);
  });

  it("does not store the warning (runtime state of the run)", async () => {
    const repository = new InMemorySessionRepository();
    const backend = new FakeBackend();
    backend.missingCwds.add("/srv/api");
    const { registry } = setup({ repository }, backend);
    const { id } = await registry.create({ name: "api", launch: missingSpec });
    expect(registry.get(id).warnings).toEqual([missing]);
    expect(repository.list().find((each) => each.id === id)?.warnings).toBeUndefined();
  });
});
