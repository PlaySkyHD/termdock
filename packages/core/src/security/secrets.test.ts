// Security test (issue #135, spec diagnostics): a value from the environment of a launch profile reaches neither
// IPC error answers nor `core.log`, and the database keeps it only where the user put it. The value is an
// obviously fake token; the name is no secret name, so the redaction of the logger does not hide a leak.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { LaunchSpec } from "@termdock/protocol";
import { FakeBackend } from "../backend/fake.js";
import { runCore } from "../bin/run-core.js";
import type { RunCoreResult } from "../bin/run-core.js";
import { connect, IpcError } from "../ipc/client.js";
import type { CoreClient } from "../ipc/client.js";
import { DATABASE_FILE } from "../storage/database.js";

const SECRET = "td-test-secret-0000";
const MISSING_CWD = "/td-test/missing";
const START_FAILURE = "tmux new-session failed (exit 1): server exited unexpectedly";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function uniquePipe(): string {
  const name = `termdock-test-${randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "termdock-secrets-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Core with its own pipe and data folder; stderr is collected, it must stay clean as well. */
async function startCore(dataDir: string, pipePath: string, backend: FakeBackend) {
  const stderr: string[] = [];
  const core: RunCoreResult = await runCore({
    pipePath,
    dataDir,
    backends: [backend],
    installSignalHandlers: false,
    stderr: { write: (text: string) => void stderr.push(text) },
  });
  expect(core.exitCode).toBe(0);
  cleanups.push(() => core.close?.());
  const client: CoreClient = await connect(pipePath, { requestTimeoutMs: 5000 });
  cleanups.push(() => client.close());
  return { core, client, stderr };
}

/** The error a request fails with; fails the test when the request succeeds. */
async function failure(request: Promise<unknown>): Promise<IpcError> {
  const outcome = await request.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(IpcError);
  return outcome as IpcError;
}

/** Every file below `dir` with its bytes as text, except the database files (read through SQL below). */
function filesBelow(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      for (const [path, text] of filesBelow(full)) files.set(path, text);
    } else if (!name.startsWith(DATABASE_FILE)) {
      files.set(full, readFileSync(full, "latin1"));
    }
  }
  return files;
}

/** `<table>.<column>` of every cell in the database whose text contains `needle`, once each. */
function cellsWith(dataDir: string, needle: string): string[] {
  const db = new DatabaseSync(join(dataDir, DATABASE_FILE), { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row["name"]));
    const found = new Set<string>();
    for (const table of tables) {
      for (const row of db.prepare(`SELECT * FROM "${table}"`).all()) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value === "string" && value.includes(needle)) found.add(`${table}.${column}`);
        }
      }
    }
    return [...found].sort();
  } finally {
    db.close();
  }
}

describe("secrets from the environment of a profile (issue #135)", { timeout: 60_000 }, () => {
  it("stay out of IPC errors, core.log and stderr, and the database keeps them only in env columns", async () => {
    const dataDir = tempDir();
    const pipePath = uniquePipe();
    const backend = new FakeBackend();
    const env = { TD_TEST_VALUE: SECRET };
    const launch: LaunchSpec = { backend: "wsl", cwd: MISSING_CWD, command: ["td-test-tool"], env };
    backend.missingCwds.add(MISSING_CWD);

    const first = await startCore(dataDir, pipePath, backend);
    const c = first.client;
    const { profile } = (await c.request("profile.create", { name: "p", launch, autostart: true })).result;
    const errors: IpcError[] = [];

    // Invalid working directory: the session starts with a warning that names the directory only.
    const warned = (await c.request("session.create", { name: "cwd", profileId: profile.id })).result.session;
    expect(warned.warnings).toEqual([expect.objectContaining({ code: "cwd_missing", path: MISSING_CWD })]);
    expect(JSON.stringify(warned.warnings)).not.toContain(SECRET);
    // Ended, so that the autostart of the next start has a session to start again.
    await c.request("session.kill", { sessionId: warned.id });

    // Backend error during the start.
    backend.failNextStart = new Error(START_FAILURE);
    errors.push(await failure(c.request("session.create", { name: "fail", profileId: profile.id })));
    expect(errors[0]?.code).toBe("backend_unavailable");

    // bad_request from the guards: a second env entry that is no string.
    const broken = { ...launch, env: { ...env, TD_TEST_NUMBER: 5 } } as unknown as LaunchSpec;
    errors.push(await failure(c.request("session.create", { name: "bad", launch: broken })));
    errors.push(await failure(c.request("profile.create", { name: "bad", launch: broken })));
    // bad_request for a secret name: in a profile, and (since issue #135) in a session of its own.
    const secretNamed = { ...launch, env: { TD_TEST_TOKEN: SECRET } };
    errors.push(await failure(c.request("profile.create", { name: "token", launch: secretNamed })));
    errors.push(await failure(c.request("profile.update", { profileId: profile.id, launch: secretNamed })));
    errors.push(await failure(c.request("session.create", { name: "token", launch: secretNamed })));
    errors.push(
      await failure(
        c.request("session.create", { name: "token", profileId: profile.id, launch: secretNamed }),
      ),
    );
    expect(errors.slice(1).map((error) => error.code)).toEqual(Array(6).fill("bad_request"));
    for (const error of errors) expect(`${error.code} ${error.message}`).not.toContain(SECRET);
    await c.close();
    await first.core.close?.();

    // A second start runs the autostart of the profile; its failure is reported in core.log.
    backend.failNextStart = new Error(START_FAILURE);
    const second = await startCore(dataDir, pipePath, backend);
    await second.core.autostart?.started;
    await second.client.close();
    await second.core.close?.();

    const log = readFileSync(join(dataDir, "logs", "core.log"), "utf8");
    expect(log).toContain(`autostart of profile ${profile.id} failed`);
    expect(log).not.toContain(SECRET);
    expect([...first.stderr, ...second.stderr].join("")).not.toContain(SECRET);
    for (const [file, text] of filesBelow(dataDir)) expect(text, file).not.toContain(SECRET);

    // The database: the profile the user wrote and the sessions started from it, each in its env column.
    expect(cellsWith(dataDir, SECRET)).toEqual(["launch_profiles.env", "sessions.env"]);
    expect(cellsWith(dataDir, "TD_TEST_TOKEN")).toEqual([]);
  });
});
