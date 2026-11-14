// session.update, session.archive and session.delete over a real named pipe (issue #57, spec core-ipc).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@termdock/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FakeBackend } from "../backend/fake.js";
import { runCore } from "../bin/run-core.js";
import { sessionHistoryDir } from "../storage/history-files.js";
import { connect, IpcError } from "./client.js";
import type { CoreClient } from "./client.js";

const launch = { backend: "wsl", cwd: "/home/dev" } as const;
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function uniquePipe(): string {
  const name = `termdock-test-${randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
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

async function startCore(dataDir: string) {
  const backend = new FakeBackend();
  const pipePath = uniquePipe();
  const core = await runCore({
    pipePath,
    dataDir,
    backends: [backend],
    stderr: { write: () => {} },
    installSignalHandlers: false,
  });
  expect(core.exitCode).toBe(0);
  cleanups.push(() => core.close?.());
  return { backend, pipePath, core };
}

async function newClient(pipePath: string): Promise<CoreClient> {
  const client = await connect(pipePath, { requestTimeoutMs: 3000 });
  cleanups.push(() => client.close());
  return client;
}

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "termdock-manage-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** History segments as the HistoryStore writes them (ADR 0004). */
function writeHistory(dataDir: string, sessionId: string): string {
  const dir = sessionHistoryDir(dataDir, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.log"), "output");
  return dir;
}

async function createSession(client: CoreClient, workspaceId?: string): Promise<SessionInfo> {
  const params =
    workspaceId === undefined ? { name: "build", launch } : { name: "build", launch, workspaceId };
  return (await client.request("session.create", params)).result.session;
}

describe("session management over IPC (issue #57)", () => {
  it("renames and moves a session, answers with it and sends session.updated to every lister", async () => {
    const { backend, pipePath } = await startCore(tempDataDir());
    const caller = await newClient(pipePath);
    const other = await newClient(pipePath);
    const stranger = await newClient(pipePath);
    await caller.request("session.list", {});
    await other.request("session.list", {});
    const seen = new Map<CoreClient, SessionInfo[]>([
      [caller, []],
      [other, []],
      [stranger, []],
    ]);
    for (const [client, list] of seen) client.on("session.updated", ({ session }) => list.push(session));
    const session = await createSession(caller, "w1");

    const renamed = (await caller.request("session.update", { sessionId: session.id, name: "deploy" }))
      .result;
    const ungrouped = (await caller.request("session.update", { sessionId: session.id, workspaceId: null }))
      .result;
    const regrouped = (await caller.request("session.update", { sessionId: session.id, workspaceId: "w2" }))
      .result;

    expect(renamed.session).toMatchObject({ name: "deploy", workspaceId: "w1", state: "Detached" });
    expect(ungrouped.session).not.toHaveProperty("workspaceId");
    expect(regrouped.session).toMatchObject({ name: "deploy", workspaceId: "w2" });
    // Events are written before the answers.
    for (const client of [caller, other]) {
      expect(seen.get(client)).toEqual([renamed.session, ungrouped.session, regrouped.session]);
    }
    expect(seen.get(stranger)).toEqual([]);
    expect(backend.kills).toEqual([]);
    expect(backend.pty(session.id).disposed).toBe(false);
    expect((await other.request("session.list", {})).result.sessions[0]).toMatchObject({ workspaceId: "w2" });
    expect(await errorCode(caller.request("session.update", { sessionId: "nope", name: "x" }))).toBe(
      "not_found",
    );
  });

  it("archives a running session: process ended, Archived reported, history kept", async () => {
    const dataDir = tempDataDir();
    const { backend, pipePath } = await startCore(dataDir);
    const client = await newClient(pipePath);
    await client.request("session.list", {});
    const states: string[] = [];
    client.on("session.stateChanged", ({ state }) => states.push(state));
    const session = await createSession(client);
    const { viewId } = (await client.request("session.attach", { sessionId: session.id })).result;
    const history = writeHistory(dataDir, session.id);

    expect((await client.request("session.archive", { sessionId: session.id })).result).toEqual({});

    expect(backend.kills).toEqual([session.id]);
    expect(states.at(-1)).toBe("Archived");
    expect(existsSync(join(history, "a.log"))).toBe(true);
    // The view is gone with the archive; the server does not keep it either.
    expect(await errorCode(client.request("session.claimWriter", { viewId }))).toBe("not_found");
  });

  it("refuses to delete a running session and keeps its history", async () => {
    const dataDir = tempDataDir();
    const { pipePath } = await startCore(dataDir);
    const client = await newClient(pipePath);
    const session = await createSession(client);
    const history = writeHistory(dataDir, session.id);

    expect(await errorCode(client.request("session.delete", { sessionId: session.id }))).toBe(
      "invalid_state",
    );

    expect(existsSync(history)).toBe(true);
    expect((await client.request("session.list", {})).result.sessions).toHaveLength(1);
  });

  it("deletes a session with its views, history and stored row and sends session.removed", async () => {
    const dataDir = tempDataDir();
    const first = await startCore(dataDir);
    const lister = await newClient(first.pipePath);
    const viewer = await newClient(first.pipePath);
    await lister.request("session.list", {});
    const removed: string[] = [];
    lister.on("session.removed", ({ sessionId }) => removed.push(sessionId));
    const writers: Array<string | undefined> = [];
    viewer.on("view.writerChanged", ({ writerViewId }) => writers.push(writerViewId));
    const session = await createSession(lister);
    const kept = await createSession(lister);
    const { viewId } = (await viewer.request("session.attach", { sessionId: session.id })).result;
    await lister.request("session.kill", { sessionId: session.id });
    const history = writeHistory(dataDir, session.id);
    const keptHistory = writeHistory(dataDir, kept.id);
    writers.length = 0;

    expect((await lister.request("session.delete", { sessionId: session.id })).result).toEqual({});

    expect(removed).toEqual([session.id]);
    expect(existsSync(history)).toBe(false);
    expect(existsSync(keptHistory)).toBe(true);
    expect((await lister.request("session.list", {})).result.sessions.map((s) => s.id)).toEqual([kept.id]);
    // The viewer learned that nobody writes any more, and its view is gone.
    await expect.poll(() => writers).toEqual([undefined]);
    expect(await errorCode(viewer.request("session.claimWriter", { viewId }))).toBe("not_found");
    expect(await errorCode(lister.request("session.delete", { sessionId: session.id }))).toBe("not_found");

    // The row is gone from the database too: a new core does not load the session.
    await lister.close();
    await viewer.close();
    await first.core.close?.();
    const second = await startCore(dataDir);
    const client = await newClient(second.pipePath);
    expect((await client.request("session.list", {})).result.sessions.map((s) => s.id)).toEqual([kept.id]);
  });
});
