// Integration tests over a real named pipe with FakeBackend (issue #5, spec core-ipc).
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect as netConnect } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  encodeFrame,
  FrameDecoder,
  LAYOUT_VERSION,
  MAX_PATH_LENGTH,
  MAX_PAYLOAD_BYTES,
  MAX_PROFILE_BYTES,
  MAX_PROFILES,
  MAX_PROJECTS_PER_WORKSPACE,
  MAX_WORKSPACES,
  PHASE_3_METHODS,
} from "@termdock/protocol";
import type { Frame, LaunchProfile, LayoutDocument, SessionInfo } from "@termdock/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeBackend } from "../backend/fake.js";
import { SessionRegistry } from "../session/registry.js";
import { InMemoryLayoutRepository } from "../storage/layout-repository.js";
import { InMemoryWorkspaceRepository } from "../storage/workspace-repository.js";
import { runCore } from "../bin/run-core.js";
import { connect, IpcError } from "./client.js";
import type { CoreClient } from "./client.js";
import { CoreServer } from "./server.js";
import type { CoreServerOptions } from "./server.js";

const launch = { backend: "wsl", cwd: "/home/dev" } as const;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function uniquePipe(): string {
  const name = `termdock-test-${randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startCore(options: Partial<CoreServerOptions> = {}) {
  const backend = new FakeBackend();
  const registry = new SessionRegistry({ backends: [backend] });
  const pipePath = uniquePipe();
  const server = await CoreServer.start({
    registry,
    layouts: new InMemoryLayoutRepository(),
    pipePath,
    ...options,
  });
  cleanups.push(() => server.close());
  return { backend, registry, pipePath, server };
}

async function newClient(pipePath: string): Promise<CoreClient> {
  const client = await connect(pipePath, { requestTimeoutMs: 3000 });
  cleanups.push(() => client.close());
  return client;
}

async function createSession(client: CoreClient, name = "build"): Promise<SessionInfo> {
  return (await client.request("session.create", { name, launch })).result.session;
}

async function attach(client: CoreClient, sessionId: string) {
  const { result, payload } = await client.request("session.attach", { sessionId });
  return { ...result, snapshot: decoder.decode(payload) };
}

function collectOutput(client: CoreClient): string[] {
  const chunks: string[] = [];
  client.on("session.output", (_data, payload) => chunks.push(decoder.decode(payload)));
  return chunks;
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IpcError) return error.code;
    throw error;
  }
  throw new Error("expected the request to fail");
}

/** Plain socket speaking the wire format, to see what the server sends and in which order. */
function rawConnect(pipePath: string): Promise<{
  socket: Socket;
  frames: Frame[];
  send: (header: unknown, payload?: Uint8Array) => void;
  closed: () => boolean;
}> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(pipePath);
    const decoderState = new FrameDecoder();
    const frames: Frame[] = [];
    let closed = false;
    socket.on("data", (chunk) => frames.push(...decoderState.push(chunk)));
    socket.on("close", () => (closed = true));
    socket.on("error", () => {});
    cleanups.push(() => void socket.destroy());
    socket.once("connect", () =>
      resolve({
        socket,
        frames,
        send: (header, payload) => void socket.write(encodeFrame(header, payload)),
        closed: () => closed,
      }),
    );
    socket.once("error", reject);
  });
}

const hello = { kind: "request", id: "h", method: "hello", params: helloParams() };

function helloParams(version = "1.0") {
  return { protocolVersion: version, clientId: "raw", clientKind: "test" };
}

describe("handshake", () => {
  it("answers hello with the core's protocol version", async () => {
    const { pipePath } = await startCore();
    const raw = await rawConnect(pipePath);
    raw.send(hello);
    await waitFor(() => raw.frames.length === 1, "hello response");
    expect(raw.frames[0]?.header).toEqual({ kind: "response", id: "h", result: { protocolVersion: "1.3" } });
  });

  it("accepts a hello with protocol 1.1 from an older minor version (issue #46)", async () => {
    const { pipePath } = await startCore();
    const raw = await rawConnect(pipePath);
    raw.send({ ...hello, params: helloParams("1.1") });
    await waitFor(() => raw.frames.length === 1, "hello response");
    expect(raw.frames[0]?.header).toEqual({ kind: "response", id: "h", result: { protocolVersion: "1.3" } });
  });

  it("rejects a first message that is not hello with bad_request and closes", async () => {
    const { pipePath } = await startCore();
    const raw = await rawConnect(pipePath);
    raw.send({ kind: "request", id: "x", method: "session.list", params: {} });
    await waitFor(() => raw.closed(), "connection close");
    const header = raw.frames[0]?.header as { id: string; error: { code: string } };
    expect(header.id).toBe("x");
    expect(header.error.code).toBe("bad_request");
  });

  it("answers a wrong major version with protocol_mismatch and closes", async () => {
    const { pipePath } = await startCore();
    const raw = await rawConnect(pipePath);
    raw.send({ ...hello, params: helloParams("2.0") });
    await waitFor(() => raw.closed(), "connection close");
    const header = raw.frames[0]?.header as { error: { code: string } };
    expect(header.error.code).toBe("protocol_mismatch");
  });

  it("makes connect() fail with protocol_mismatch", async () => {
    const { pipePath } = await startCore();
    const code = await errorCode(connect(pipePath, { protocolVersion: "2.0" }));
    expect(code).toBe("protocol_mismatch");
  });

  it("closes a connection that sends no hello within the timeout", async () => {
    const { pipePath } = await startCore({ helloTimeoutMs: 100 });
    const raw = await rawConnect(pipePath);
    await waitFor(() => raw.closed(), "connection close");
    expect(raw.frames).toEqual([]);
  });

  it("rejects a hello timeout that is zero, negative or not finite when starting", async () => {
    for (const helloTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(startCore({ helloTimeoutMs }), String(helloTimeoutMs)).rejects.toThrow(RangeError);
    }
  });

  it("rejects a pending-handshake limit below 1 or not an integer when starting", async () => {
    for (const maxPendingHandshakes of [0, -1, 1.5, Number.NaN]) {
      await expect(startCore({ maxPendingHandshakes }), String(maxPendingHandshakes)).rejects.toThrow(
        RangeError,
      );
    }
  });

  it("disconnects new connections at once while the limit of connections without hello is reached", async () => {
    const { pipePath } = await startCore({ maxPendingHandshakes: 2 });
    const first = await rawConnect(pipePath);
    const second = await rawConnect(pipePath);
    const third = await rawConnect(pipePath);
    await waitFor(() => third.closed(), "third connection close");
    expect(first.closed()).toBe(false);
    expect(second.closed()).toBe(false);
    // hello frees a slot, and so does closing a connection
    first.send(hello);
    await waitFor(() => first.frames.length === 1, "hello response");
    const fourth = await rawConnect(pipePath);
    fourth.send({ ...hello, id: "h4" });
    await waitFor(() => fourth.frames.length === 1, "fourth hello response");
    expect(fourth.closed()).toBe(false);
    // second and fifth are without hello again: the limit is reached
    const fifth = await rawConnect(pipePath);
    const sixth = await rawConnect(pipePath);
    await waitFor(() => sixth.closed(), "sixth connection close");
    expect(fifth.closed()).toBe(false);
    second.socket.destroy();
    await waitFor(() => second.closed(), "second close");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const seventh = await rawConnect(pipePath);
    seventh.send({ ...hello, id: "h7" });
    await waitFor(() => seventh.frames.length === 1, "seventh hello response");
  });

  it("keeps a connection open after hello even past the hello timeout", async () => {
    const { pipePath } = await startCore({ helloTimeoutMs: 100 });
    const raw = await rawConnect(pipePath);
    raw.send(hello);
    await waitFor(() => raw.frames.length === 1, "hello response");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(raw.closed()).toBe(false);
    raw.send({ kind: "request", id: "l", method: "session.list", params: {} });
    await waitFor(() => raw.frames.length === 2, "list response");
  });

  it("drops a connection that sends garbage", async () => {
    const { pipePath } = await startCore();
    const raw = await rawConnect(pipePath);
    raw.socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 1, 2, 3]));
    await waitFor(() => raw.closed(), "connection close");
  });
});

describe("dispatch", () => {
  it("creates a session and lists it", async () => {
    const { pipePath } = await startCore();
    const client = await newClient(pipePath);
    const created = await createSession(client);
    const { result } = await client.request("session.list", {});
    expect(result.sessions.map((s) => s.id)).toEqual([created.id]);
    expect(created.state).toBe("Detached");
  });

  it("passes CoreError codes through", async () => {
    const { pipePath } = await startCore();
    const client = await newClient(pipePath);
    expect(await errorCode(client.request("session.kill", { sessionId: "nope" }))).toBe("not_found");
    expect(await errorCode(client.request("session.attach", { sessionId: "nope" }))).toBe("not_found");
  });

  it("answers invalid requests with bad_request and keeps the connection", async () => {
    const { pipePath } = await startCore();
    const raw = await rawConnect(pipePath);
    raw.send(hello);
    raw.send({ kind: "request", id: "bad", method: "session.attach", params: {} });
    raw.send({ kind: "request", id: "ok", method: "session.list", params: {} });
    await waitFor(() => raw.frames.length === 3, "three responses");
    const bad = raw.frames[1]?.header as { id: string; error: { code: string } };
    expect(bad.id).toBe("bad");
    expect(bad.error.code).toBe("bad_request");
    expect(raw.frames[2]?.header).toMatchObject({ id: "ok", result: { sessions: [] } });
  });

  it("maps unknown errors to internal without a stack trace", async () => {
    const reported: unknown[] = [];
    const { pipePath, registry } = await startCore({ onInternalError: (error) => reported.push(error) });
    vi.spyOn(registry, "list").mockImplementation(() => {
      throw new Error("secret detail\n    at /private/path.js:1");
    });
    const client = await newClient(pipePath);
    const error = await client.request("session.list", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcError);
    expect((error as IpcError).code).toBe("internal");
    expect((error as IpcError).message).not.toMatch(/secret|private|\bat\b/);
    expect(reported).toHaveLength(1);
  });

  it("reports a failed backend start as backend_unavailable", async () => {
    const { pipePath, backend } = await startCore();
    backend.failNextStart = new Error("no wsl");
    const client = await newClient(pipePath);
    const code = await errorCode(client.request("session.create", { name: "x", launch }));
    expect(code).toBe("backend_unavailable");
  });
});

describe("two clients on one session", () => {
  async function twoViews() {
    const core = await startCore();
    const a = await newClient(core.pipePath);
    const b = await newClient(core.pipePath);
    const session = await createSession(a);
    const viewA = await attach(a, session.id);
    const viewB = await attach(b, session.id);
    return { ...core, a, b, session, viewA, viewB };
  }

  it("gives the first view the writer role, only the writer may input and resize", async () => {
    const { a, b, backend, session, viewA, viewB } = await twoViews();
    expect(viewA.writerViewId).toBe(viewA.viewId);
    expect(viewB.writerViewId).toBe(viewA.viewId);

    await a.request("session.input", { viewId: viewA.viewId }, encoder.encode("ls\r"));
    expect(backend.pty(session.id).input).toBe("ls\r");
    expect(await errorCode(b.request("session.input", { viewId: viewB.viewId }, encoder.encode("rm")))).toBe(
      "not_writer",
    );
    expect(
      await errorCode(b.request("session.resize", { viewId: viewB.viewId, size: { cols: 50, rows: 10 } })),
    ).toBe("not_writer");
    expect(backend.pty(session.id).input).toBe("ls\r");

    const resized: unknown[] = [];
    b.on("session.resized", (data) => resized.push(data));
    await a.request("session.resize", { viewId: viewA.viewId, size: { cols: 100, rows: 30 } });
    await waitFor(() => resized.length === 1, "resized event");
    expect(resized[0]).toEqual({ sessionId: session.id, size: { cols: 100, rows: 30 } });
    expect(backend.pty(session.id).resizes.at(-1)).toEqual({ cols: 100, rows: 30 });
  });

  it("delivers the output to both clients", async () => {
    const { a, b, backend, session } = await twoViews();
    const outA = collectOutput(a);
    const outB = collectOutput(b);
    backend.pty(session.id).emitData("hello world");
    await waitFor(() => outA.length === 1 && outB.length === 1, "output on both clients");
    expect([outA[0], outB[0]]).toEqual(["hello world", "hello world"]);
  });

  it("transfers the writer role with claimWriter and announces it", async () => {
    const { a, b, session, viewA, viewB } = await twoViews();
    const changes: unknown[] = [];
    a.on("view.writerChanged", (data) => changes.push(data));
    await b.request("session.claimWriter", { viewId: viewB.viewId });
    await waitFor(() => changes.length === 1, "writerChanged");
    expect(changes[0]).toEqual({ sessionId: session.id, writerViewId: viewB.viewId });
    expect(await errorCode(a.request("session.input", { viewId: viewA.viewId }, encoder.encode("x")))).toBe(
      "not_writer",
    );
  });

  it("keeps a view private to its connection", async () => {
    const { registry, b, session, viewA } = await twoViews();
    expect(await errorCode(b.request("session.detach", { viewId: viewA.viewId }))).toBe("not_found");
    expect(await errorCode(b.request("session.claimWriter", { viewId: viewA.viewId }))).toBe("not_found");
    expect(registry.get(session.id).writerViewId).toBe(viewA.viewId);
  });

  it("detaches a view on session.detach", async () => {
    const { registry, a, b, session, viewA } = await twoViews();
    const changes: unknown[] = [];
    b.on("view.writerChanged", (data) => changes.push(data));
    await a.request("session.detach", { viewId: viewA.viewId });
    await waitFor(() => changes.length === 1, "writerChanged after detach");
    expect(changes[0]).toEqual({ sessionId: session.id });
    expect(registry.get(session.id).writerViewId).toBeUndefined();
  });

  it("splits output larger than the payload limit into several events with the same number", async () => {
    const { a, backend, session } = await twoViews();
    let total = 0;
    const seqs: Array<number | undefined> = [];
    a.on("session.output", (data, payload) => {
      total += payload.length;
      seqs.push(data.seq);
    });
    backend.pty(session.id).emitData(new Uint8Array(MAX_PAYLOAD_BYTES + 1000));
    await waitFor(() => total === MAX_PAYLOAD_BYTES + 1000, "all output bytes");
    expect(seqs).toEqual([1, 1]);
  });

  it("numbers the output of a session and answers attach with the mark (issue #34)", async () => {
    const { a, backend, session, pipePath, viewB } = await twoViews();
    const seqs: Array<number | undefined> = [];
    a.on("session.output", (data) => seqs.push(data.seq));
    backend.pty(session.id).emitData("one");
    backend.pty(session.id).emitData("two");
    await waitFor(() => seqs.length === 2, "two outputs");

    const viewC = await attach(await newClient(pipePath), session.id);

    expect(viewB.outputSeq).toBe(0);
    expect(seqs).toEqual([1, 2]);
    expect(viewC.outputSeq).toBe(2);
  });

  it("only sends events to clients with a view or a session list", async () => {
    const { pipePath, backend, session } = await twoViews();
    const lister = await newClient(pipePath);
    await lister.request("session.list", {});
    const stranger = await newClient(pipePath);
    const strangerEvents: string[] = [];
    for (const name of [
      "session.output",
      "session.stateChanged",
      "session.resized",
      "view.writerChanged",
    ] as const) {
      stranger.on(name, () => strangerEvents.push(name));
    }
    const listerStates: string[] = [];
    lister.on("session.stateChanged", (data) => listerStates.push(data.state));
    const listerOutput = collectOutput(lister);

    backend.pty(session.id).emitData("x");
    backend.pty(session.id).emitExit(0);
    await waitFor(() => listerStates.length === 1, "state change on the list client");
    expect(listerStates).toEqual(["Exited"]);
    expect(listerOutput).toEqual([]);

    // Events are written before this answer, so nothing is still on its way.
    await errorCode(stranger.request("session.kill", { sessionId: "nope" }));
    expect(strangerEvents).toEqual([]);
  });

  it("tells the clients that listed sessions about a created session, once (issue #46)", async () => {
    const { pipePath } = await startCore();
    const a = await newClient(pipePath);
    const b = await newClient(pipePath);
    const stranger = await newClient(pipePath);
    await a.request("session.list", {});
    await b.request("session.list", {});
    const seenByA: SessionInfo[] = [];
    const seenByB: SessionInfo[] = [];
    const seenByStranger: SessionInfo[] = [];
    a.on("session.created", ({ session }) => seenByA.push(session));
    b.on("session.created", ({ session }) => seenByB.push(session));
    stranger.on("session.created", ({ session }) => seenByStranger.push(session));

    const created = await createSession(a, "from a");
    // Events are written before this answer, so nothing is still on its way.
    await errorCode(b.request("session.kill", { sessionId: "nope" }));
    await errorCode(stranger.request("session.kill", { sessionId: "nope" }));

    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]).toMatchObject({ id: created.id, name: "from a", state: "Starting" });
    expect(seenByA.map((session) => session.id)).toEqual([created.id]);
    // Like session.stateChanged, it only goes to clients that list sessions.
    expect(seenByStranger).toEqual([]);
  });

  it("announces a session whose start fails, followed by its state change to Interrupted", async () => {
    const { pipePath, backend } = await startCore();
    const a = await newClient(pipePath);
    const b = await newClient(pipePath);
    await b.request("session.list", {});
    const seen: string[] = [];
    b.on("session.created", ({ session }) => seen.push(`created:${session.state}`));
    b.on("session.stateChanged", ({ state }) => seen.push(`state:${state}`));
    backend.failNextStart = new Error("distro not reachable");

    expect(await errorCode(a.request("session.create", { name: "x", launch }))).toBe("backend_unavailable");
    await waitFor(() => seen.length === 2, "created and state change");

    expect(seen).toEqual(["created:Starting", "state:Interrupted"]);
  });

  it("sends session.created in front of the answer of session.create", async () => {
    const { pipePath } = await startCore();
    const a = await newClient(pipePath);
    await a.request("session.list", {});
    const order: string[] = [];
    a.on("session.created", () => order.push("event"));
    await a.request("session.create", { name: "x", launch });
    order.push("answer");
    expect(order).toEqual(["event", "answer"]);
  });

  it("announces no session when create is refused", async () => {
    const { pipePath } = await startCore();
    const a = await newClient(pipePath);
    const b = await newClient(pipePath);
    await b.request("session.list", {});
    const seen: string[] = [];
    b.on("session.created", ({ session }) => seen.push(session.id));
    const refused = a.request("session.create", { name: "x", launch, size: { cols: 0, rows: 0 } });
    expect(await errorCode(refused)).toBe("bad_request");
    await errorCode(b.request("session.kill", { sessionId: "nope" }));
    expect(seen).toEqual([]);
  });
});

describe("event order", () => {
  it("delivers events of a new view after the attach response", async () => {
    const { pipePath, registry } = await startCore();
    const info = await registry.create({ name: "x", launch });
    const raw = await rawConnect(pipePath);
    raw.send(hello);
    raw.send({ kind: "request", id: "att", method: "session.attach", params: { sessionId: info.id } });
    // The new view hears of Detached -> Running and of becoming the writer, both after the response.
    await waitFor(() => raw.frames.length >= 4, "attach response and two events");
    const kinds = raw.frames.map((f) => (f.header as { kind: string; id?: string }).id ?? "event");
    expect(kinds).toEqual(["h", "att", "event", "event"]);
  });
});

describe("client abort", () => {
  it("keeps the session running and frees the writer role", async () => {
    const { registry, backend, pipePath } = await startCore();
    const a = await newClient(pipePath);
    const b = await newClient(pipePath);
    const session = await createSession(a);
    const viewA = await attach(a, session.id);
    const viewB = await attach(b, session.id);
    const changes: unknown[] = [];
    b.on("view.writerChanged", (data) => changes.push(data));

    await a.close();
    await waitFor(() => changes.length === 1, "writerChanged after abort");
    expect(changes[0]).toEqual({ sessionId: session.id });
    expect(registry.get(session.id).state).toBe("Running");
    expect(registry.get(session.id).writerViewId).toBeUndefined();
    expect(backend.pty(session.id).ended).toBe(false);

    await b.request("session.claimWriter", { viewId: viewB.viewId });
    await b.request("session.input", { viewId: viewB.viewId }, encoder.encode("still here"));
    expect(backend.pty(session.id).input).toBe("still here");
    expect(viewA.viewId).not.toBe(viewB.viewId);
  });

  it("moves a session without views to Detached", async () => {
    const { registry, pipePath } = await startCore();
    const a = await newClient(pipePath);
    const session = await createSession(a);
    await attach(a, session.id);
    expect(registry.get(session.id).state).toBe("Running");
    await a.close();
    await waitFor(() => registry.get(session.id).state === "Detached", "Detached after abort");
  });

  it("detaches views of a client that disconnects while attach is running", async () => {
    const { registry, backend, pipePath } = await startCore();
    const info = await registry.create({ name: "x", launch });
    backend.setSnapshot(info.id, "screen");
    const raw = await rawConnect(pipePath);
    raw.send(hello);
    raw.send({ kind: "request", id: "att", method: "session.attach", params: { sessionId: info.id } });
    raw.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await waitFor(() => registry.get(info.id).state === "Detached", "view released");
    expect(registry.get(info.id).writerViewId).toBeUndefined();
  });
});

describe("backpressure", () => {
  it("disconnects a client that does not read and keeps the session running", async () => {
    const { registry, backend, pipePath } = await startCore({ maxBufferedBytes: 128 * 1024 });
    const info = await registry.create({ name: "x", launch });
    const raw = await rawConnect(pipePath);
    raw.send(hello);
    raw.send({ kind: "request", id: "att", method: "session.attach", params: { sessionId: info.id } });
    await waitFor(() => raw.frames.length >= 2, "attached");
    expect(registry.get(info.id).writerViewId).toBeDefined();

    raw.socket.pause();
    const chunk = new Uint8Array(64 * 1024);
    for (let i = 0; i < 400 && registry.get(info.id).writerViewId !== undefined; i += 1) {
      backend.pty(info.id).emitData(chunk);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(registry.get(info.id).writerViewId).toBeUndefined();
    expect(backend.pty(info.id).ended).toBe(false);

    const other = await newClient(pipePath);
    expect((await other.request("session.list", {})).result.sessions).toHaveLength(1);
  });
});

describe("single instance", () => {
  it("makes the second core fail with already_running", async () => {
    const { pipePath } = await startCore();
    const stderr: string[] = [];
    const outcome = await runCore({
      pipePath,
      backends: [new FakeBackend()],
      stderr: { write: (text: string) => void stderr.push(text) },
      installSignalHandlers: false,
    });
    expect(outcome.exitCode).toBe(10);
    expect(outcome.errorCode).toBe("already_running");
    expect(stderr.join("")).toContain("already_running");

    const client = await newClient(pipePath);
    expect((await client.request("session.list", {})).result.sessions).toEqual([]);
  });

  it("rejects CoreServer.start with already_running", async () => {
    const { pipePath, registry } = await startCore();
    const error = await CoreServer.start({
      registry,
      layouts: new InMemoryLayoutRepository(),
      pipePath,
    }).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("already_running");
  });

  it("starts a core through runCore and serves clients", async () => {
    const pipePath = uniquePipe();
    const dataDir = mkdtempSync(join(tmpdir(), "termdock-ipc-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const outcome = await runCore({
      pipePath,
      dataDir,
      backends: [new FakeBackend()],
      stderr: { write: () => {} },
      installSignalHandlers: false,
    });
    expect(outcome.exitCode).toBe(0);
    cleanups.push(() => outcome.close?.());
    const client = await newClient(pipePath);
    expect((await client.request("session.list", {})).result.sessions).toEqual([]);
  });
});

describe("core.shutdown", () => {
  async function withTwoSessions(options: Partial<CoreServerOptions> = {}) {
    const core = await startCore(options);
    const first = await core.registry.create({ name: "one", launch });
    const second = await core.registry.create({ name: "two", launch });
    const client = await newClient(core.pipePath);
    return { ...core, client, ids: [first.id, second.id] as const };
  }

  it("stops all sessions and closes the pipe with stopSessions", async () => {
    const onShutdown = vi.fn();
    const { client, registry, pipePath, ids } = await withTwoSessions({ onShutdown });
    const closed = new Promise<void>((resolve) => client.onClose(resolve));
    await client.request("core.shutdown", { stopSessions: true });
    await closed;
    expect(ids.map((id) => registry.get(id).state)).toEqual(["Exited", "Exited"]);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(await errorCode(connect(pipePath, { connectTimeoutMs: 500 }))).toBe("closed");
  });

  it("stops a session whose lost client is being re-attached", async () => {
    const { client, registry, backend, ids } = await withTwoSessions();
    // The first check fails, so the re-attach waits 0.5 s before its next attempt.
    backend.failNextExists = new Error("wsl.exe timed out");
    backend.pty(ids[0]).loseClient();
    await waitFor(() => backend.failNextExists === undefined, "first failed check");

    await client.request("core.shutdown", { stopSessions: true });

    expect(ids.map((id) => registry.get(id).state)).toEqual(["Exited", "Exited"]);
    expect(backend.kills).toContain(ids[0]);
    expect(backend.attaches).toEqual([]);
  });

  it("only closes the server without stopSessions", async () => {
    const onShutdown = vi.fn();
    const { client, registry, backend, pipePath, ids } = await withTwoSessions({ onShutdown });
    const closed = new Promise<void>((resolve) => client.onClose(resolve));
    await client.request("core.shutdown", { stopSessions: false });
    await closed;
    expect(ids.map((id) => registry.get(id).state)).toEqual(["Detached", "Detached"]);
    expect(backend.kills).toEqual([]);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(await errorCode(connect(pipePath, { connectTimeoutMs: 500 }))).toBe("closed");
  });

  it("treats missing params like stopSessions false", async () => {
    const { client, registry, ids } = await withTwoSessions();
    await client.request("core.shutdown", {});
    expect(registry.get(ids[0]).state).toBe("Detached");
  });

  it("answers with an error naming the sessions that could not be stopped, and stops the rest", async () => {
    const { client, registry, backend, ids } = await withTwoSessions();
    backend.failNextKill = new Error("tmux gone");
    const closed = new Promise<void>((resolve) => client.onClose(resolve));
    const error = await client.request("core.shutdown", { stopSessions: true }).catch((e: unknown) => e);
    await closed;
    expect(error).toBeInstanceOf(IpcError);
    expect((error as IpcError).code).toBe("backend_unavailable");
    const states = ids.map((id) => registry.get(id).state);
    expect(states).toContain("Exited");
    const failed = ids.filter((id) => registry.get(id).state !== "Exited");
    expect(failed).toHaveLength(1);
    expect((error as IpcError).message).toContain(failed[0]);
  });

  /** Makes the backend's next start wait until `release()` is called, so a session stays in Starting. */
  function holdNextStart(backend: FakeBackend): { release: () => void } {
    const originalStart = backend.start.bind(backend);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    backend.start = async (...args) => {
      backend.start = originalStart;
      await gate;
      return originalStart(...args);
    };
    return { release: () => release() };
  }

  it("waits for sessions in Starting and stops them too, rejecting new requests meanwhile", async () => {
    const { backend, registry, pipePath } = await startCore();
    const gate = holdNextStart(backend);
    const creator = await newClient(pipePath);
    const creating = creator.request("session.create", { name: "slow", launch });
    await waitFor(() => registry.list().some((s) => s.state === "Starting"), "session in Starting");
    const id = registry.list()[0]!.id;

    const shutter = await newClient(pipePath);
    const closed = new Promise<void>((resolve) => shutter.onClose(resolve));
    const shutdown = shutter.request("core.shutdown", { stopSessions: true });
    const other = await newClient(pipePath);
    // Shutdown has begun once the other client's request is refused.
    let refused = "";
    for (let i = 0; i < 100 && refused !== "invalid_state"; i += 1) {
      refused = await other.request("session.list", {}).then(
        () => "ok",
        (e: IpcError) => e.code,
      );
      if (refused === "ok") await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(refused).toBe("invalid_state");
    expect(await errorCode(other.request("session.create", { name: "late", launch }))).toBe("invalid_state");

    gate.release();
    await creating.catch(() => {});
    await shutdown;
    await closed;
    expect(registry.get(id).state).toBe("Exited");
    expect(registry.list()).toHaveLength(1);
  });

  it("answers every shutdown request and applies stopSessions of any of them", async () => {
    const { client, registry, pipePath, ids } = await withTwoSessions();
    const second = await newClient(pipePath);
    const firstClosed = new Promise<void>((resolve) => client.onClose(resolve));
    const secondClosed = new Promise<void>((resolve) => second.onClose(resolve));
    const first = client.request("core.shutdown", {});
    await first;
    // Shortly after the first answer, still before the server closes.
    await second.request("core.shutdown", { stopSessions: true });
    await Promise.all([firstClosed, secondClosed]);
    expect(ids.map((id) => registry.get(id).state)).toEqual(["Exited", "Exited"]);
  });

  it("answers two concurrent shutdown requests", async () => {
    const { client, registry, pipePath, ids } = await withTwoSessions();
    const second = await newClient(pipePath);
    const results = await Promise.all([
      client.request("core.shutdown", {}),
      second.request("core.shutdown", { stopSessions: true }),
    ]);
    expect(results).toHaveLength(2);
    expect(ids.map((id) => registry.get(id).state)).toEqual(["Exited", "Exited"]);
  });
});

describe("attach failure", () => {
  it("still delivers events held back during a failing attach", async () => {
    const { backend, registry, pipePath } = await startCore();
    const info = await registry.create({ name: "x", launch });
    // The first view's attach waits in the backend snapshot; the session is archived meanwhile.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    backend.snapshot = async () => {
      await gate;
      return undefined;
    };
    const client = await newClient(pipePath);
    const states: string[] = [];
    client.on("session.stateChanged", (data) => states.push(data.state));
    await client.request("session.list", {});
    const attaching = client.request("session.attach", { sessionId: info.id });
    await waitFor(() => registry.list().length === 1 && backend.starts.length === 1, "attach started");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await registry.archive(info.id);
    release();
    expect(await errorCode(attaching)).toBe("invalid_state");
    await waitFor(() => states.includes("Archived"), "stateChanged(Archived) after the failed attach");
  });
});

describe("client library", () => {
  function silentServer(afterHello: "silent" | "hangup"): Promise<string> {
    const pipePath = uniquePipe();
    const sockets: Socket[] = [];
    const server: Server = createServer((socket) => {
      const frames = new FrameDecoder();
      let greeted = false;
      sockets.push(socket);
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        for (const frame of frames.push(chunk)) {
          if (!greeted) {
            greeted = true;
            const id = (frame.header as { id: string }).id;
            socket.write(encodeFrame({ kind: "response", id, result: { protocolVersion: "1.0" } }));
          } else if (afterHello === "hangup") {
            socket.destroy();
          }
        }
      });
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    cleanups.push(() => void sockets.forEach((socket) => socket.destroy()));
    return new Promise((resolve) => server.listen(pipePath, () => resolve(pipePath)));
  }

  it("rejects a request that gets no answer with timeout", async () => {
    const pipePath = await silentServer("silent");
    const client = await connect(pipePath, { requestTimeoutMs: 100 });
    cleanups.push(() => client.close());
    expect(await errorCode(client.request("session.list", {}))).toBe("timeout");
  });

  it("rejects open requests with closed when the server hangs up", async () => {
    const pipePath = await silentServer("hangup");
    const client = await connect(pipePath, { requestTimeoutMs: 2000 });
    cleanups.push(() => client.close());
    expect(await errorCode(client.request("session.list", {}))).toBe("closed");
    expect(client.isClosed).toBe(true);
  });

  it("ignores an event name it does not know and stays connected (issue #46)", async () => {
    const pipePath = uniquePipe();
    const sockets: Socket[] = [];
    const server: Server = createServer((socket) => {
      const frames = new FrameDecoder();
      sockets.push(socket);
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        for (const frame of frames.push(chunk)) {
          const { id, method } = frame.header as { id: string; method: string };
          if (method === "session.list") {
            socket.write(encodeFrame({ kind: "event", event: "session.fromTheFuture", data: {} }));
            socket.write(encodeFrame({ kind: "response", id, result: { sessions: [] } }));
          } else {
            socket.write(encodeFrame({ kind: "response", id, result: { protocolVersion: "1.3" } }));
          }
        }
      });
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    cleanups.push(() => void sockets.forEach((socket) => socket.destroy()));
    await new Promise<void>((resolve) => server.listen(pipePath, () => resolve()));
    const client = await connect(pipePath, { requestTimeoutMs: 2000 });
    cleanups.push(() => client.close());
    const reported: unknown[] = [];
    client.on("session.created", (data) => reported.push(data));

    expect((await client.request("session.list", {})).result.sessions).toEqual([]);

    expect(client.isClosed).toBe(false);
    expect(reported).toEqual([]);
  });

  it("rejects requests after close and close() is idempotent", async () => {
    const { pipePath } = await startCore();
    const client = await connect(pipePath);
    await client.close();
    await client.close();
    expect(await errorCode(client.request("session.list", {}))).toBe("closed");
  });

  it("survives a throwing listener: others and later frames still arrive, the error is reported", async () => {
    const { pipePath, backend, registry } = await startCore();
    const reported: unknown[] = [];
    const client = await connect(pipePath, {
      requestTimeoutMs: 3000,
      onListenerError: (error) => reported.push(error),
    });
    cleanups.push(() => client.close());
    const info = await registry.create({ name: "x", launch });
    await attach(client, info.id);
    client.on("session.output", () => {
      throw new Error("listener bug");
    });
    const seen = collectOutput(client);
    backend.pty(info.id).emitData("one");
    backend.pty(info.id).emitData("two");
    await waitFor(() => seen.length === 2, "both outputs");
    expect(seen).toEqual(["one", "two"]);
    expect(reported).toHaveLength(2);
    expect((await client.request("session.list", {})).result.sessions).toHaveLength(1);
  });

  it("stops delivering events to a disposed listener", async () => {
    const { pipePath, backend, registry } = await startCore();
    const client = await newClient(pipePath);
    const info = await registry.create({ name: "x", launch });
    await attach(client, info.id);
    const seen: string[] = [];
    const subscription = client.on("session.output", (_d, payload) => seen.push(decoder.decode(payload)));
    backend.pty(info.id).emitData("one");
    await waitFor(() => seen.length === 1, "first output");
    subscription.dispose();
    backend.pty(info.id).emitData("two");
    const other = collectOutput(client);
    await waitFor(() => other.length === 1, "second output on a fresh listener");
    expect(seen).toEqual(["one"]);
  });
});

describe("phase 3 (issue #55)", () => {
  /** Valid params per phase-3 method; a stub answers each of them with internal. */
  const stubCalls: Record<(typeof PHASE_3_METHODS)[number], unknown> = {
    "workspace.list": {},
    "workspace.create": { name: "TermDock" },
    "workspace.update": { workspaceId: "w1", name: "Neu" },
    "workspace.delete": { workspaceId: "w1" },
    "project.create": { workspaceId: "w1", name: "api", path: "/home/dev/api", backend: "wsl" },
    "project.update": { projectId: "p1", name: "web" },
    "project.delete": { projectId: "p1" },
    "profile.list": {},
    "profile.create": { name: "Claude", launch: { ...launch, command: ["claude"] } },
    "profile.update": { profileId: "pr1", autostart: true },
    "profile.delete": { profileId: "pr1" },
    "session.update": { sessionId: "s1", workspaceId: null },
    "session.archive": { sessionId: "s1" },
    "session.delete": { sessionId: "s1" },
    "settings.get": {},
    "settings.set": { settings: { historyEnabledByDefault: false } },
    "history.search": { query: "error" },
  };

  it("answers every phase-3 method with internal 'noch nicht umgesetzt' and keeps serving", async () => {
    const errors: unknown[] = [];
    const { pipePath } = await startCore({ onInternalError: (error) => errors.push(error) });
    const raw = await rawConnect(pipePath);
    raw.send(hello);
    const calls: [string, unknown][] = [
      // workspace.* and project.* are implemented (issue #56, tests in "workspaces and projects").
      // profile.* and session.create from a profile are implemented too (issue #58, "launch profiles").
      ...Object.entries(stubCalls).filter(([method]) => !/^(workspace|project|profile)\./.test(method)),
    ];
    for (const [method, params] of calls) raw.send({ kind: "request", id: method, method, params });
    raw.send({ kind: "request", id: "list", method: "session.list", params: {} });
    await waitFor(() => raw.frames.length === calls.length + 2, "all responses");

    for (const [index, [method]] of calls.entries()) {
      const header = raw.frames[index + 1]?.header as {
        id: string;
        error?: { code: string; message: string };
      };
      expect(header.id).toBe(method);
      expect(header.error?.code, method).toBe("internal");
      expect(header.error?.message).toContain(method);
      expect(header.error?.message).toContain("noch nicht umgesetzt");
    }
    expect(raw.frames.at(-1)?.header).toMatchObject({ id: "list", result: { sessions: [] } });
    expect(raw.closed()).toBe(false);
    // A stub is a known answer, not a crash.
    expect(errors).toEqual([]);
  });

  it("has a stub for every phase-3 method", () => {
    expect(Object.keys(stubCalls).sort()).toEqual([...PHASE_3_METHODS].sort());
  });

  it("sends the phase-3 events once to each client that listed sessions, never to others", async () => {
    const { pipePath, server } = await startCore();
    const asker = await newClient(pipePath);
    const other = await newClient(pipePath);
    const stranger = await newClient(pipePath);
    await asker.request("session.list", {});
    await other.request("session.list", {});
    const names = [
      "session.updated",
      "session.removed",
      "workspace.changed",
      "profile.changed",
      "settings.changed",
    ] as const;
    const seen = new Map<CoreClient, string[]>([
      [asker, []],
      [other, []],
      [stranger, []],
    ]);
    for (const [client, list] of seen) for (const name of names) client.on(name, () => list.push(name));
    const session: SessionInfo = {
      id: "s1",
      name: "x",
      state: "Detached",
      launch,
      size: { cols: 80, rows: 24 },
      loggingEnabled: true,
      createdAt: "2026-11-13T10:00:00.000Z",
      updatedAt: "2026-11-13T10:00:00.000Z",
    };

    server.notifyListers("session.updated", { session });
    server.notifyListers("session.removed", { sessionId: "s1" });
    server.notifyListers("workspace.changed", { workspaces: [{ id: "w1", name: "TermDock", projects: [] }] });
    server.notifyListers("profile.changed", { profiles: [] });
    server.notifyListers("settings.changed", { settings: { ...DEFAULT_SETTINGS } });
    // Events are written before these answers, so nothing is still on its way.
    for (const client of seen.keys()) await errorCode(client.request("session.kill", { sessionId: "nope" }));

    expect(seen.get(asker)).toEqual([...names]);
    expect(seen.get(other)).toEqual([...names]);
    expect(seen.get(stranger)).toEqual([]);
  });

  it("accepts a client with protocol 1.2 and answers 1.3", async () => {
    const { pipePath } = await startCore();
    const raw = await rawConnect(pipePath);
    raw.send({ ...hello, params: helloParams("1.2") });
    await waitFor(() => raw.frames.length === 1, "hello response");
    expect(raw.frames[0]?.header).toEqual({ kind: "response", id: "h", result: { protocolVersion: "1.3" } });
  });
});

describe("layout", () => {
  const pane = (id: string) => ({ kind: "pane", id, sessionId: `session-${id}` }) as const;
  const layout = (title: string): LayoutDocument => ({
    version: LAYOUT_VERSION,
    windows: [
      {
        id: "w1",
        tabs: [{ id: "t1", title, root: pane("p1"), activePaneId: "p1" }],
        activeTabId: "t1",
      },
    ],
  });

  it("saves and loads the layout, counting revisions", async () => {
    const { pipePath } = await startCore();
    const client = await newClient(pipePath);
    expect((await client.request("layout.get", {})).result).toEqual({ revision: 0 });
    expect((await client.request("layout.save", { layout: layout("one") })).result).toEqual({ revision: 1 });
    expect((await client.request("layout.get", {})).result).toEqual({ layout: layout("one"), revision: 1 });
    const other = await newClient(pipePath);
    expect((await other.request("layout.save", { layout: layout("two"), baseRevision: 1 })).result).toEqual({
      revision: 2,
    });
    expect((await client.request("layout.get", {})).result).toEqual({ layout: layout("two"), revision: 2 });
  });

  it("answers a stale baseRevision with invalid_state and keeps the stored layout", async () => {
    const { pipePath } = await startCore();
    const client = await newClient(pipePath);
    await client.request("layout.save", { layout: layout("one") });
    await client.request("layout.save", { layout: layout("two") });
    expect(await errorCode(client.request("layout.save", { layout: layout("three"), baseRevision: 1 }))).toBe(
      "invalid_state",
    );
    expect((await client.request("layout.get", {})).result).toEqual({ layout: layout("two"), revision: 2 });
  });

  it("answers an invalid layout with bad_request", async () => {
    const { pipePath } = await startCore();
    const raw = await rawConnect(pipePath);
    raw.send(hello);
    const duplicate = { ...layout("one"), windows: [{ ...layout("one").windows[0], id: "p1" }] };
    raw.send({ kind: "request", id: "bad", method: "layout.save", params: { layout: duplicate } });
    await waitFor(() => raw.frames.length === 2, "two responses");
    expect(raw.frames[1]?.header).toMatchObject({ id: "bad", error: { code: "bad_request" } });
  });
});

describe("workspaces and projects (issue #56)", () => {
  const wslProject = (name = "api") => ({ name, path: `/home/dev/${name}`, backend: "wsl" as const });

  async function twoClients() {
    const core = await startCore();
    const a = await newClient(core.pipePath);
    const b = await newClient(core.pipePath);
    await a.request("session.list", {});
    await b.request("session.list", {});
    return { ...core, a, b };
  }

  it("creates, renames and lists workspaces and projects", async () => {
    const { pipePath } = await startCore();
    const client = await newClient(pipePath);
    const { workspace } = (await client.request("workspace.create", { name: "Web" })).result;
    expect(workspace).toMatchObject({ name: "Web", projects: [] });
    const renamed = (
      await client.request("workspace.update", {
        workspaceId: workspace.id,
        name: "Web 2",
        defaultCwd: "/srv",
      })
    ).result.workspace;
    expect(renamed).toEqual({ id: workspace.id, name: "Web 2", projects: [], defaultCwd: "/srv" });
    const { project } = (
      await client.request("project.create", { workspaceId: workspace.id, ...wslProject(), distro: "Ubuntu" })
    ).result;
    expect(project).toMatchObject({ workspaceId: workspace.id, name: "api", distro: "Ubuntu" });
    const updated = (await client.request("project.update", { projectId: project.id, name: "api2" })).result
      .project;
    expect(updated).toEqual({ ...project, name: "api2" });
    const cleared = (
      await client.request("workspace.update", { workspaceId: workspace.id, defaultCwd: null })
    ).result.workspace;
    expect("defaultCwd" in cleared).toBe(false);
    expect((await client.request("workspace.list", {})).result.workspaces).toEqual([
      { id: workspace.id, name: "Web 2", projects: [updated] },
    ]);
    await client.request("project.delete", { projectId: project.id });
    expect((await client.request("workspace.list", {})).result.workspaces[0]?.projects).toEqual([]);
  });

  it("sends workspace.changed with the full list to every listing client, in front of the answer", async () => {
    const { pipePath, a, b } = await twoClients();
    const stranger = await newClient(pipePath);
    const seenByA: string[] = [];
    const seenByB: number[] = [];
    const seenByStranger: number[] = [];
    a.on("workspace.changed", () => seenByA.push("event"));
    b.on("workspace.changed", ({ workspaces }) => seenByB.push(workspaces.length));
    stranger.on("workspace.changed", ({ workspaces }) => seenByStranger.push(workspaces.length));

    const { workspace } = (await a.request("workspace.create", { name: "one" })).result;
    seenByA.push("answer");
    await a.request("project.create", { workspaceId: workspace.id, ...wslProject() });
    await a.request("workspace.create", { name: "two" });
    await errorCode(stranger.request("session.kill", { sessionId: "nope" }));

    expect(seenByA).toEqual(["event", "answer", "event", "event"]);
    expect(seenByB).toEqual([1, 1, 2]);
    expect(seenByStranger).toEqual([]);
  });

  it("sends no workspace.changed for a refused request", async () => {
    const { a, b } = await twoClients();
    const { workspace } = (await a.request("workspace.create", { name: "one" })).result;
    const seen: string[] = [];
    b.on("workspace.changed", () => seen.push("changed"));
    await errorCode(b.request("session.kill", { sessionId: "nope" }));
    seen.length = 0;

    const refusals = [
      a.request("workspace.update", { workspaceId: "nope", name: "x" }),
      a.request("workspace.delete", { workspaceId: "nope" }),
      a.request("project.create", { workspaceId: "nope", ...wslProject() }),
      a.request("project.update", { projectId: "nope", name: "x" }),
      a.request("project.delete", { projectId: "nope" }),
    ];
    for (const refusal of refusals) expect(await errorCode(refusal)).toBe("not_found");
    expect(
      await errorCode(
        a.request("project.create", {
          workspaceId: workspace.id,
          name: "w",
          path: "C:\\dev",
          backend: "wsl",
        }),
      ),
    ).toBe("bad_request");
    await errorCode(b.request("session.kill", { sessionId: "nope" }));
    expect(seen).toEqual([]);
  });

  it("checks project paths per backend, also when only the backend changes", async () => {
    const { pipePath } = await startCore();
    const client = await newClient(pipePath);
    const { workspace } = (await client.request("workspace.create", { name: "w" })).result;
    const create = (params: { path: string; backend: "wsl" | "windows" }) =>
      client.request("project.create", { workspaceId: workspace.id, name: "p", ...params });
    expect(await errorCode(create({ path: "relative/dir", backend: "wsl" }))).toBe("bad_request");
    expect(await errorCode(create({ path: "/home/dev", backend: "windows" }))).toBe("bad_request");
    const linux = (await create({ path: "/home/dev/api", backend: "wsl" })).result.project;
    const windows = (await create({ path: "C:\\dev\\api", backend: "windows" })).result.project;
    await create({ path: "\\\\server\\share\\x", backend: "windows" });
    expect(await errorCode(client.request("project.update", { projectId: windows.id, backend: "wsl" }))).toBe(
      "bad_request",
    );
    // Without distro: null the guard refuses the switch, with it the old Linux path fails the syntax check.
    expect(
      await errorCode(
        client.request("project.update", { projectId: linux.id, backend: "windows", distro: null }),
      ),
    ).toBe("bad_request");
    const switched = (
      await client.request("project.update", {
        projectId: linux.id,
        backend: "windows",
        path: "D:\\dev\\api",
        distro: null,
      })
    ).result.project;
    expect(switched).toMatchObject({ backend: "windows", path: "D:\\dev\\api" });
    expect(await errorCode(client.request("project.update", { projectId: linux.id, path: "/x" }))).toBe(
      "bad_request",
    );
  });

  it("keeps a distro that the merged project would not allow out of the store", async () => {
    const { pipePath } = await startCore();
    const client = await newClient(pipePath);
    const { workspace } = (await client.request("workspace.create", { name: "w" })).result;
    const { project } = (
      await client.request("project.create", {
        workspaceId: workspace.id,
        name: "p",
        path: "C:\\dev",
        backend: "windows",
      })
    ).result;
    // distro alone passes the request guard, the merged windows project must not be stored.
    expect(
      await errorCode(client.request("project.update", { projectId: project.id, distro: "Ubuntu" })),
    ).toBe("bad_request");
    expect((await client.request("workspace.list", {})).result.workspaces[0]?.projects).toEqual([project]);
  });

  it("enforces the limits of workspaces and projects", async () => {
    const { pipePath } = await startCore();
    const client = await newClient(pipePath);
    const first = (await client.request("workspace.create", { name: "w0" })).result.workspace;
    for (let i = 1; i < MAX_WORKSPACES; i++) await client.request("workspace.create", { name: `w${i}` });
    expect(await errorCode(client.request("workspace.create", { name: "too many" }))).toBe("invalid_state");
    for (let i = 0; i < MAX_PROJECTS_PER_WORKSPACE; i++) {
      await client.request("project.create", { workspaceId: first.id, ...wslProject(`p${i}`) });
    }
    expect(
      await errorCode(client.request("project.create", { workspaceId: first.id, ...wslProject() })),
    ).toBe("invalid_state");
    const { workspaces } = (await client.request("workspace.list", {})).result;
    expect(workspaces).toHaveLength(MAX_WORKSPACES);
    expect(workspaces[0]?.projects).toHaveLength(MAX_PROJECTS_PER_WORKSPACE);
  });

  it("refuses a change that pushes the workspace over its byte limit and stores nothing", async () => {
    const { pipePath } = await startCore();
    const client = await newClient(pipePath);
    const { workspace } = (await client.request("workspace.create", { name: "w" })).result;
    // 512 characters of a character that JSON escapes to 6 bytes: 3 KiB per project.
    const heavy = `/${"\u0001".repeat(MAX_PATH_LENGTH - 1)}`;
    let created = 0;
    for (; created < MAX_PROJECTS_PER_WORKSPACE; created++) {
      const request = client.request("project.create", {
        workspaceId: workspace.id,
        name: "p",
        path: heavy,
        backend: "wsl",
      });
      if (
        (await request.then(
          () => "ok",
          (error: unknown) => (error as IpcError).code,
        )) !== "ok"
      )
        break;
    }
    expect(created).toBeLessThan(MAX_PROJECTS_PER_WORKSPACE);
    expect((await client.request("workspace.list", {})).result.workspaces[0]?.projects).toHaveLength(created);
  });

  it("refuses a session for an unknown or deleted workspace with not_found", async () => {
    const { pipePath, registry } = await startCore();
    const client = await newClient(pipePath);
    const { workspace } = (await client.request("workspace.create", { name: "w" })).result;
    await client.request("session.create", { name: "ok", launch, workspaceId: workspace.id });
    await client.request("workspace.delete", { workspaceId: workspace.id });

    for (const workspaceId of [workspace.id, "never-existed"]) {
      expect(await errorCode(client.request("session.create", { name: "x", launch, workspaceId }))).toBe(
        "not_found",
      );
    }
    expect(registry.list().map((session) => session.name)).toEqual(["ok"]);
  });

  it("keeps sessions grouped when deleting the workspace fails, and survives a failing list", async () => {
    const workspaces = new InMemoryWorkspaceRepository();
    const errors: unknown[] = [];
    const { pipePath } = await startCore({ workspaces, onInternalError: (error) => errors.push(error) });
    const a = await newClient(pipePath);
    await a.request("session.list", {});
    const { workspace } = (await a.request("workspace.create", { name: "w" })).result;
    await a.request("session.create", { name: "in", launch, workspaceId: workspace.id });
    const updated: string[] = [];
    a.on("session.updated", ({ session }) => updated.push(session.name));

    workspaces.delete = () => {
      throw new Error("disk full");
    };
    expect(await errorCode(a.request("workspace.delete", { workspaceId: workspace.id }))).toBe("internal");
    // Memory changes only after the commit: no event, the session keeps its workspace.
    expect(await errorCode(a.request("session.kill", { sessionId: "nope" }))).toBe("not_found");
    expect(updated).toEqual([]);
    expect(
      (await a.request("session.list", {})).result.sessions.map((session) => session.workspaceId),
    ).toEqual([workspace.id]);

    // A read that fails after the write is committed does not fail the request.
    const list = workspaces.list.bind(workspaces);
    let reads = 0;
    workspaces.list = () => {
      // service.createWorkspace reads once for the limit; the second read is the one of the notification.
      if (++reads === 2) throw new Error("busy");
      return list();
    };
    const created = (await a.request("workspace.create", { name: "again" })).result.workspace;
    workspaces.list = list;
    expect(created.name).toBe("again");
    // One for the failed delete (answered with internal), one for the failed read of the notification.
    expect(errors.map((error) => (error as Error).message)).toEqual(["disk full", "busy"]);
    expect((await a.request("workspace.list", {})).result.workspaces.map((w) => w.name)).toEqual([
      "w",
      "again",
    ]);
  });

  it("deletes a workspace with its projects, ungroups its running sessions and tells the other client", async () => {
    const { a, b, backend, registry } = await twoClients();
    const { workspace } = (await a.request("workspace.create", { name: "doomed" })).result;
    const other = (await a.request("workspace.create", { name: "stays" })).result.workspace;
    await a.request("project.create", { workspaceId: workspace.id, ...wslProject() });
    const inside = (await a.request("session.create", { name: "in", launch, workspaceId: workspace.id }))
      .result.session;
    const outside = (await a.request("session.create", { name: "out", launch, workspaceId: other.id })).result
      .session;
    const loose = (await a.request("session.create", { name: "loose", launch })).result.session;
    const events: string[] = [];
    b.on("session.updated", ({ session }) => {
      events.push(`updated:${session.name}:${session.workspaceId ?? "none"}:${session.state}`);
    });
    b.on("workspace.changed", ({ workspaces }) =>
      events.push(`changed:${workspaces.map((w) => w.name).join(",")}`),
    );

    await a.request("workspace.delete", { workspaceId: workspace.id });
    await errorCode(b.request("session.kill", { sessionId: "nope" }));

    expect(events).toEqual([`updated:in:none:${inside.state}`, "changed:stays"]);
    const sessions = (await b.request("session.list", {})).result.sessions;
    expect(sessions.find((s) => s.id === inside.id)).toMatchObject({ state: inside.state });
    expect("workspaceId" in sessions.find((s) => s.id === inside.id)!).toBe(false);
    expect(sessions.find((s) => s.id === outside.id)?.workspaceId).toBe(other.id);
    expect("workspaceId" in sessions.find((s) => s.id === loose.id)!).toBe(false);
    expect(backend.pty(inside.id).ended).toBe(false);
    expect(registry.get(inside.id).workspaceId).toBeUndefined();
    expect((await a.request("workspace.list", {})).result.workspaces.map((w) => w.id)).toEqual([other.id]);
    expect(await errorCode(a.request("workspace.delete", { workspaceId: workspace.id }))).toBe("not_found");
  });
});

describe("launch profiles (issue #58)", () => {
  const claude = { backend: "wsl", cwd: "/home/dev/claude", command: ["claude", "--resume"] } as const;

  async function setup() {
    const core = await startCore();
    const a = await newClient(core.pipePath);
    const b = await newClient(core.pipePath);
    await a.request("session.list", {});
    await b.request("session.list", {});
    return { ...core, a, b };
  }

  async function workspaceWithProject(client: CoreClient, name = "Web", path = "/home/dev/api") {
    const { workspace } = (await client.request("workspace.create", { name })).result;
    const { project } = (
      await client.request("project.create", { workspaceId: workspace.id, name: "api", path, backend: "wsl" })
    ).result;
    return { workspace, project };
  }

  it("creates, updates, lists and deletes profiles with defaults and a command array", async () => {
    const { a } = await setup();
    const { profile } = (await a.request("profile.create", { name: "Claude", launch: claude })).result;
    expect(profile).toEqual({
      id: profile.id,
      name: "Claude",
      launch: claude,
      autostart: false,
      loggingEnabled: true,
    });
    const updated = (
      await a.request("profile.update", { profileId: profile.id, name: "Claude 2", autostart: true })
    ).result.profile;
    expect(updated).toEqual({ ...profile, name: "Claude 2", autostart: true });
    await a.request("profile.create", { name: "Codex", launch: { ...claude, command: ["codex"] } });
    expect((await a.request("profile.list", {})).result.profiles.map((p) => p.name)).toEqual([
      "Claude 2",
      "Codex",
    ]);
    await a.request("profile.delete", { profileId: profile.id });
    expect((await a.request("profile.list", {})).result.profiles.map((p) => p.name)).toEqual(["Codex"]);
    expect(await errorCode(a.request("profile.delete", { profileId: profile.id }))).toBe("not_found");
    expect(await errorCode(a.request("profile.update", { profileId: "nope", name: "x" }))).toBe("not_found");
  });

  it("allows at most 64 profiles and rejects an oversized one without storing anything", async () => {
    const { a } = await setup();
    const big = { ...claude, env: { BIG: "x".repeat(MAX_PROFILE_BYTES) } };
    expect(await errorCode(a.request("profile.create", { name: "big", launch: big }))).toBe("bad_request");
    for (let i = 0; i < MAX_PROFILES; i += 1)
      await a.request("profile.create", { name: `p${i}`, launch: claude });
    expect(await errorCode(a.request("profile.create", { name: "one more", launch: claude }))).toBe(
      "invalid_state",
    );
    expect((await a.request("profile.list", {})).result.profiles).toHaveLength(MAX_PROFILES);
  });

  it("checks that the project belongs to the workspace and that both exist", async () => {
    const { a } = await setup();
    const one = await workspaceWithProject(a, "one");
    const two = (await a.request("workspace.create", { name: "two" })).result.workspace;
    const bind = (workspaceId?: string, projectId?: string) => ({
      name: "p",
      launch: claude,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(projectId === undefined ? {} : { projectId }),
    });

    expect(await errorCode(a.request("profile.create", bind(two.id, one.project.id)))).toBe("bad_request");
    expect(await errorCode(a.request("profile.create", bind("nope")))).toBe("not_found");
    expect(await errorCode(a.request("profile.create", bind(one.workspace.id, "nope")))).toBe("not_found");
    expect((await a.request("profile.list", {})).result.profiles).toEqual([]);

    // The workspace of the project is filled in when missing.
    const { profile } = (await a.request("profile.create", bind(undefined, one.project.id))).result;
    expect(profile).toMatchObject({ workspaceId: one.workspace.id, projectId: one.project.id });

    expect(await errorCode(a.request("profile.update", { profileId: profile.id, workspaceId: two.id }))).toBe(
      "bad_request",
    );
    expect(await errorCode(a.request("profile.update", { profileId: profile.id, workspaceId: null }))).toBe(
      "bad_request",
    );
    const moved = (
      await a.request("profile.update", { profileId: profile.id, workspaceId: two.id, projectId: null })
    ).result.profile;
    expect(moved).toMatchObject({ workspaceId: two.id });
    expect("projectId" in moved).toBe(false);
    expect((await a.request("profile.list", {})).result.profiles).toEqual([moved]);
  });

  it("sends profile.changed with the full list to listing clients only, after each change", async () => {
    const { pipePath, a, b } = await setup();
    const stranger = await newClient(pipePath);
    const seenByA: string[] = [];
    const seenByB: string[][] = [];
    const seenByStranger: number[] = [];
    a.on("profile.changed", () => seenByA.push("event"));
    b.on("profile.changed", ({ profiles }) => seenByB.push(profiles.map((p) => p.name)));
    stranger.on("profile.changed", ({ profiles }) => seenByStranger.push(profiles.length));

    const { profile } = (await a.request("profile.create", { name: "one", launch: claude })).result;
    seenByA.push("answer");
    await a.request("profile.update", { profileId: profile.id, name: "uno" });
    await errorCode(a.request("profile.delete", { profileId: "nope" }));
    await a.request("profile.delete", { profileId: profile.id });
    await errorCode(stranger.request("session.kill", { sessionId: "nope" }));

    expect(seenByA).toEqual(["event", "answer", "event", "event"]);
    expect(seenByB).toEqual([["one"], ["uno"], []]);
    expect(seenByStranger).toEqual([]);
  });

  it("unbinds profiles and sends profile.changed when a workspace or project is deleted", async () => {
    const { a, b } = await setup();
    const one = await workspaceWithProject(a, "one");
    const two = await workspaceWithProject(a, "two");
    const bound = (
      await a.request("profile.create", { name: "x", launch: claude, projectId: one.project.id })
    ).result.profile;
    const kept = (await a.request("profile.create", { name: "y", launch: claude, projectId: two.project.id }))
      .result.profile;
    const lists: LaunchProfile[][] = [];
    b.on("profile.changed", ({ profiles }) => lists.push(profiles));

    await a.request("project.delete", { projectId: two.project.id });
    await a.request("workspace.delete", { workspaceId: one.workspace.id });
    await errorCode(b.request("session.kill", { sessionId: "nope" }));

    const { projectId: _dropped, ...afterProject } = kept;
    const { workspaceId: _w, projectId: _p, ...afterWorkspace } = bound;
    expect(lists).toEqual([
      [bound, afterProject],
      [afterWorkspace, afterProject],
    ]);
    expect((await a.request("profile.list", {})).result.profiles).toEqual(lists[1]);
  });

  it("creates a session from a profile: its launch spec, logging switch and profile id", async () => {
    const { a } = await setup();
    const { profile } = (
      await a.request("profile.create", { name: "Claude", launch: claude, loggingEnabled: false })
    ).result;
    const { session } = (await a.request("session.create", { name: "from profile", profileId: profile.id }))
      .result;
    expect(session).toMatchObject({ profileId: profile.id, launch: claude, loggingEnabled: false });
    const logged = (
      await a.request("session.create", { name: "logged", profileId: profile.id, loggingEnabled: true })
    ).result.session;
    expect(logged.loggingEnabled).toBe(true);
  });

  it("lets an explicit launch replace the profile's spec as a whole", async () => {
    const { a } = await setup();
    const { profile } = (await a.request("profile.create", { name: "Claude", launch: claude })).result;
    const { session } = (
      await a.request("session.create", {
        name: "own",
        profileId: profile.id,
        launch: { backend: "wsl", cwd: "/tmp" },
      })
    ).result;
    expect(session.launch).toEqual({ backend: "wsl", cwd: "/tmp" });
    expect(session.profileId).toBe(profile.id);
  });

  it("answers an unknown profile with not_found and creates no session", async () => {
    const { a } = await setup();
    expect(await errorCode(a.request("session.create", { name: "x", profileId: "nope" }))).toBe("not_found");
    expect(await errorCode(a.request("session.create", { name: "x", profileId: "nope", launch }))).toBe(
      "not_found",
    );
    expect((await a.request("session.list", {})).result.sessions).toEqual([]);
  });

  it("fills a profile cwd of ~ in the order project, workspace, setting, ~", async () => {
    const { a } = await setup();
    const home = { backend: "wsl", cwd: "~", command: ["bash"] } as const;
    const { workspace, project } = await workspaceWithProject(a, "Web", "/home/dev/api");
    await a.request("workspace.update", { workspaceId: workspace.id, defaultCwd: "/srv/web" });
    const cwdOf = async (profileId: string) =>
      (await a.request("session.create", { name: "s", profileId })).result.session.launch.cwd;
    const create = async (binding: Record<string, string>) =>
      (await a.request("profile.create", { name: "p", launch: home, ...binding })).result.profile.id;

    expect(await cwdOf(await create({ projectId: project.id }))).toBe("/home/dev/api");
    expect(await cwdOf(await create({ workspaceId: workspace.id }))).toBe("/srv/web");
    expect(await cwdOf(await create({}))).toBe("~");
    // A directory of its own is kept as it is.
    const own = (await a.request("profile.create", { name: "own", launch: claude, projectId: project.id }))
      .result.profile;
    expect(await cwdOf(own.id)).toBe("/home/dev/claude");
  });
});
