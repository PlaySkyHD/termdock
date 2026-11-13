// Integration tests over a real named pipe with FakeBackend (issue #5, spec core-ipc).
import { randomUUID } from "node:crypto";
import { createServer, connect as netConnect } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, FrameDecoder, MAX_PAYLOAD_BYTES } from "@termdock/protocol";
import type { Frame, SessionInfo } from "@termdock/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeBackend } from "../backend/fake.js";
import { SessionRegistry } from "../session/registry.js";
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
  const server = await CoreServer.start({ registry, pipePath, ...options });
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
    expect(raw.frames[0]?.header).toEqual({ kind: "response", id: "h", result: { protocolVersion: "1.0" } });
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

  it("splits output larger than the payload limit into several events", async () => {
    const { a, backend, session } = await twoViews();
    let total = 0;
    let events = 0;
    a.on("session.output", (_data, payload) => {
      total += payload.length;
      events += 1;
    });
    backend.pty(session.id).emitData(new Uint8Array(MAX_PAYLOAD_BYTES + 1000));
    await waitFor(() => total === MAX_PAYLOAD_BYTES + 1000, "all output bytes");
    expect(events).toBe(2);
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
    const error = await CoreServer.start({ registry, pipePath }).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("already_running");
  });

  it("starts a core through runCore and serves clients", async () => {
    const pipePath = uniquePipe();
    const outcome = await runCore({
      pipePath,
      backends: [new FakeBackend()],
      stderr: { write: () => {} },
      installSignalHandlers: false,
    });
    expect(outcome.exitCode).toBe(0);
    cleanups.push(() => outcome.server?.close());
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

  it("still stops the other sessions when one cannot be stopped", async () => {
    const { client, registry, backend, ids } = await withTwoSessions();
    backend.failNextKill = new Error("tmux gone");
    const closed = new Promise<void>((resolve) => client.onClose(resolve));
    await client.request("core.shutdown", { stopSessions: true });
    await closed;
    const states = ids.map((id) => registry.get(id).state);
    expect(states).toContain("Exited");
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

  it("rejects requests after close and close() is idempotent", async () => {
    const { pipePath } = await startCore();
    const client = await connect(pipePath);
    await client.close();
    await client.close();
    expect(await errorCode(client.request("session.list", {}))).toBe("closed");
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
