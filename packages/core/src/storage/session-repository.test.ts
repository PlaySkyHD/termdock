import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "@termdock/protocol";
import { openStorage } from "./database.js";
import type { Storage } from "./database.js";
import { InMemorySessionRepository } from "./session-repository.js";
import type { SessionRepository } from "./session-repository.js";

const opened: Storage[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const storage of opened.splice(0)) storage.dispose();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sqlite(): SessionRepository {
  const dir = mkdtempSync(join(tmpdir(), "termdock-repo-"));
  tempDirs.push(dir);
  const storage = openStorage({ dataDir: dir });
  opened.push(storage);
  return storage.sessions;
}

const full: SessionInfo = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "claude",
  state: "Exited",
  launch: {
    backend: "wsl",
    distro: "Ubuntu",
    cwd: "/home/user/project",
    command: ["claude", "--resume", "a b"],
    env: { FOO: "bar", EMPTY: "" },
  },
  workspaceId: "ws-1",
  profileId: "profile-1",
  size: { cols: 120, rows: 40 },
  loggingEnabled: false,
  lastExitCode: 0,
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:05:00.000Z",
};

const minimal: SessionInfo = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "pwsh",
  state: "Running",
  launch: { backend: "windows", shell: "pwsh", cwd: "C:\\Projects\\x" },
  size: { cols: 80, rows: 24 },
  loggingEnabled: true,
  createdAt: "2026-11-13T11:00:00.000Z",
  updatedAt: "2026-11-13T11:00:00.000Z",
};

describe.each([
  ["SqliteSessionRepository", sqlite],
  ["InMemorySessionRepository", () => new InMemorySessionRepository()],
])("%s", (_name, create: () => SessionRepository) => {
  it("returns saved sessions unchanged, with and without optional fields, oldest first", () => {
    const repository = create();

    repository.save(minimal);
    repository.save(full);

    const listed = repository.list();
    expect(listed).toEqual([full, minimal]);
    expect(Object.keys(listed[1] ?? {}).sort()).toEqual(Object.keys(minimal).sort());
  });

  it("replaces a session saved again under the same id", () => {
    const repository = create();
    repository.save(full);

    repository.save({ ...full, state: "Archived", updatedAt: "2026-11-13T12:00:00.000Z" });

    expect(repository.list()).toEqual([
      { ...full, state: "Archived", updatedAt: "2026-11-13T12:00:00.000Z" },
    ]);
  });

  it("does not store the writer view", () => {
    const repository = create();

    repository.save({ ...minimal, writerViewId: "view-1" });

    expect(repository.list()).toEqual([minimal]);
  });

  it("is not affected by later changes to a saved object", () => {
    const repository = create();
    const session: SessionInfo = {
      ...full,
      launch: { ...full.launch, command: ["a"] },
      size: { cols: 1, rows: 1 },
    };
    repository.save(session);

    session.size.cols = 99;
    (session.launch.command as string[]).push("b");

    expect(repository.list()[0]?.size.cols).toBe(1);
    expect(repository.list()[0]?.launch.command).toEqual(["a"]);
  });
});
