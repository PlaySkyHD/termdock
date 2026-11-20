// Failure scenarios of the assembled core without WSL (issue #133): WSL cannot be reached at the start (FakeBackend
// with `available()` false, no `wsl --shutdown`), and a data directory that cannot be written (full or read-only disk:
// the database refuses writes, the history directory cannot be created).
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LAYOUT_VERSION } from "@termdock/protocol";
import type { LaunchSpec, LayoutDocument, SessionId, SessionState } from "@termdock/protocol";
import { FakeBackend } from "../backend/fake.js";
import { connect, IpcError } from "../ipc/client.js";
import type { CoreClient } from "../ipc/client.js";
import { logDir } from "../log/index.js";
import { openStorage } from "../storage/database.js";
import type { Storage } from "../storage/database.js";
import { CORE_LOG_FILE, runCore } from "./run-core.js";
import type { RunCoreOptions, RunCoreResult } from "./run-core.js";

const launch: LaunchSpec = { backend: "wsl", cwd: "/home/dev" };
const decoder = new TextDecoder();
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function uniquePipe(): string {
  const name = `termdock-test-${randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "termdock-failure-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function start(options: RunCoreOptions): Promise<RunCoreResult> {
  const result = await runCore({ installSignalHandlers: false, stderr: { write: () => {} }, ...options });
  cleanups.push(() => result.close?.());
  return result;
}

async function client(pipePath: string): Promise<CoreClient> {
  const c = await connect(pipePath, { requestTimeoutMs: 5000 });
  cleanups.push(() => c.close());
  return c;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function failure(request: Promise<unknown>): Promise<IpcError> {
  const error = await request.then(
    () => expect.fail("the request succeeded"),
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(IpcError);
  return error as IpcError;
}

/** What SQLite throws when the disk is full (`SQLITE_FULL`); a read-only file gives `SQLITE_READONLY` likewise. */
function diskFull(): Error {
  return Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13 });
}

/** The storage, with every write failing while `full()` is true; reads keep working. */
function fillingStorage(storage: Storage, full: () => boolean): Storage {
  const guard = <A extends unknown[], R>(write: (...args: A) => R) => {
    return (...args: A): R => {
      if (full()) throw diskFull();
      return write(...args);
    };
  };
  const { sessions, layouts, settings, workspaces, profiles } = storage;
  return {
    sessions: {
      list: () => sessions.list(),
      save: guard((session) => sessions.save(session)),
      delete: guard((id) => sessions.delete(id)),
      clearWorkspace: guard((id, updatedAt) => sessions.clearWorkspace(id, updatedAt)),
    },
    layouts: { get: () => layouts.get(), save: guard((layout, base) => layouts.save(layout, base)) },
    settings: { get: () => settings.get(), set: guard((patch) => settings.set(patch)) },
    workspaces: {
      list: () => workspaces.list(),
      save: guard((workspace) => workspaces.save(workspace)),
      delete: guard((id, also) => workspaces.delete(id, also)),
    },
    profiles: {
      list: () => profiles.list(),
      save: guard((profile) => profiles.save(profile)),
      delete: guard((id) => profiles.delete(id)),
    },
    schemaVersion: () => storage.schemaVersion(),
    dispose: () => storage.dispose(),
  };
}

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

describe("WSL cannot be reached when the core starts (issue #133)", () => {
  it("[V1-09] makes the stored sessions Interrupted and reports backend_unavailable without touching WSL", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    const first = await start({ pipePath, dataDir, backends: [new FakeBackend()] });
    const c1 = await client(pipePath);
    await c1.request("session.create", { name: "build", launch });
    const { session } = (await c1.request("session.create", { name: "watch", launch })).result;
    await c1.request("session.attach", { sessionId: session.id });
    await c1.close();
    await first.close?.();

    const offline = new FakeBackend();
    offline.isAvailable = false;
    const second = await start({ pipePath, dataDir, backends: [offline] });
    expect(second.restore?.backendUnavailable).toEqual(["wsl"]);
    const c2 = await client(pipePath);

    const sessions = (await c2.request("session.list", {})).result.sessions;
    expect(sessions.map((s) => [s.name, s.state])).toEqual([
      ["build", "Interrupted"],
      ["watch", "Interrupted"],
    ]);
    expect((await c2.request("core.status", {})).result).toEqual({ backendUnavailable: ["wsl"] });
    // Nothing was attached or started on the unreachable backend.
    expect(offline.attaches).toEqual([]);
    expect(offline.starts).toEqual([]);
  });
});

describe("the data directory cannot be written (issue #133)", () => {
  it("answers failed writes with internal and keeps running; a session without history goes on", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    let full = false;
    const backend = new FakeBackend();
    const core = await start({
      pipePath,
      dataDir,
      backends: [backend],
      openStorage: (options) => fillingStorage(openStorage(options), () => full),
    });
    expect(core.exitCode).toBe(0);
    const c = await client(pipePath);
    const states = new Map<SessionId, SessionState>();
    c.on("session.stateChanged", (event) => states.set(event.sessionId, event.state));
    let output = "";
    c.on("session.output", (_event, payload) => (output += decoder.decode(payload)));
    await c.request("session.list", {});
    const { session } = (await c.request("session.create", { name: "build", launch })).result;
    const { viewId } = (await c.request("session.attach", { sessionId: session.id })).result;

    // The disk is full: the database refuses every write, and the history directory cannot be created.
    full = true;
    writeFileSync(join(dataDir, "history"), "");

    expect((await failure(c.request("layout.save", { layout }))).code).toBe("internal");
    expect(
      (await failure(c.request("settings.set", { settings: { historyLimitBytes: 1 << 20 } }))).code,
    ).toBe("internal");
    // A session that cannot be stored is not started: it would be lost on the next start.
    expect((await failure(c.request("session.create", { name: "lost", launch }))).code).toBe("internal");
    expect(backend.starts).toHaveLength(1);

    // The running session goes on: output reaches the view, input reaches the process, its end is reported.
    for (let i = 0; i < 20; i++) {
      backend.pty(session.id).emitData(`still running ${i}\r\n`);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await until(() => output.includes("still running 19"), "the output of the session");
    await c.request("session.input", { viewId }, new TextEncoder().encode("ls\r"));
    expect(backend.pty(session.id).input).toBe("ls\r");
    backend.pty(session.id).emitExit(0);
    await until(() => states.get(session.id) === "Exited", "the end of the session");
    expect((await c.request("session.list", {})).result.sessions.map((s) => [s.name, s.state])).toEqual([
      ["build", "Exited"],
    ]);

    // Room again: writes work without a restart.
    full = false;
    expect((await c.request("layout.save", { layout })).result).toEqual({ revision: 1 });

    await c.close();
    await core.close?.();
    const log = readFileSync(join(logDir(dataDir), CORE_LOG_FILE), "utf8");
    // One line for the history, however many flushes failed (it would otherwise fill the log, issue #133).
    expect(log.match(/could not write history of session/g)).toHaveLength(1);
    expect(log).toContain(`could not save session ${session.id}: database or disk is full`);
  });
});
