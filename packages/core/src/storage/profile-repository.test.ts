import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { LaunchProfile } from "@termdock/protocol";
import { DATABASE_FILE, openDatabase } from "./database.js";
import { InMemoryProfileRepository, SqliteProfileRepository } from "./profile-repository.js";
import type { ProfileRepository } from "./profile-repository.js";
import { SqliteWorkspaceRepository } from "./workspace-repository.js";

const databases: DatabaseSync[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "termdock-profiles-"));
  tempDirs.push(dir);
  return dir;
}

function open(dir: string): DatabaseSync {
  const db = openDatabase(join(dir, DATABASE_FILE));
  databases.push(db);
  return db;
}

function profile(id: string, extra: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id,
    name: `profile-${id}`,
    launch: { backend: "wsl", cwd: "/home/dev" },
    autostart: false,
    loggingEnabled: true,
    ...extra,
  };
}

const kinds: [string, () => ProfileRepository][] = [
  ["in-memory", () => new InMemoryProfileRepository()],
  ["sqlite", () => new SqliteProfileRepository(open(tempDir()))],
];

describe.each(kinds)("ProfileRepository (%s)", (_name, make) => {
  it("lists nothing at first", () => {
    expect(make().list()).toEqual([]);
  });

  it("returns what was saved, with optional fields unset, in creation order", () => {
    const repo = make();
    const full = profile("b", {
      launch: {
        backend: "wsl",
        distro: "Ubuntu",
        cwd: "~",
        command: ["bash", "-lc", "pwd; exec bash"],
        env: { A: "1" },
      },
      autostart: true,
      loggingEnabled: false,
    });
    repo.save(full);
    repo.save(profile("a"));
    const listed = repo.list();
    expect(listed.map((p) => p.id)).toEqual(["b", "a"]);
    expect(listed[0]).toEqual(full);
    expect(Object.keys(listed[1]!.launch).sort()).toEqual(["backend", "cwd"]);
    expect("workspaceId" in listed[1]!).toBe(false);
  });

  it("keeps a Windows shell", () => {
    const repo = make();
    const windows = profile("w", { launch: { backend: "windows", shell: "pwsh", cwd: "C:\\dev" } });
    repo.save(windows);
    expect(repo.list()).toEqual([windows]);
  });

  it("replaces a profile in place and keeps its position", () => {
    const repo = make();
    repo.save(profile("a", { launch: { backend: "wsl", cwd: "/x", command: ["claude"] } }));
    repo.save(profile("b"));
    repo.save(profile("a", { name: "renamed", autostart: true }));
    const [first, second] = repo.list();
    expect(second?.id).toBe("b");
    expect(first).toEqual(profile("a", { name: "renamed", autostart: true }));
  });

  it("deletes a profile and reports whether it existed", () => {
    const repo = make();
    repo.save(profile("a"));
    expect(repo.delete("a")).toBe(true);
    expect(repo.delete("a")).toBe(false);
    expect(repo.list()).toEqual([]);
  });

  it("does not share objects with the caller", () => {
    const repo = make();
    const saved = profile("a", { launch: { backend: "wsl", cwd: "/x", command: ["claude"] } });
    repo.save(saved);
    saved.name = "changed";
    (saved.launch.command as string[]).push("--x");
    repo.list()[0]!.launch.cwd = "/y";
    expect(repo.list()).toEqual([
      profile("a", { launch: { backend: "wsl", cwd: "/x", command: ["claude"] } }),
    ]);
  });
});

describe("SqliteProfileRepository", () => {
  it("keeps profiles over a restart", () => {
    const dir = tempDir();
    const saved = profile("a", {
      launch: { backend: "wsl", cwd: "/x", command: ["codex"], env: { K: "v" } },
    });
    new SqliteProfileRepository(open(dir)).save(saved);
    databases.pop()!.close();
    expect(new SqliteProfileRepository(open(dir)).list()).toEqual([saved]);
  });

  it("loses the binding, not the profile, when its workspace is deleted", () => {
    const db = open(tempDir());
    const workspaces = new SqliteWorkspaceRepository(db);
    workspaces.save({
      id: "w",
      name: "w",
      projects: [{ id: "p", workspaceId: "w", name: "p", path: "/p", backend: "wsl" }],
    });
    const repo = new SqliteProfileRepository(db);
    repo.save(profile("a", { workspaceId: "w", projectId: "p" }));
    workspaces.delete("w");
    expect(repo.list()).toEqual([profile("a")]);
  });
});
