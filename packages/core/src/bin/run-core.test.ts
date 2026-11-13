// Assembly of the core process with FakeBackend and a real database (issue #13, spec core-ipc).
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LaunchSpec } from "@termdock/protocol";
import { FakeBackend } from "../backend/fake.js";
import { connect } from "../ipc/client.js";
import type { CoreClient } from "../ipc/client.js";
import { openStorage } from "../storage/database.js";
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
