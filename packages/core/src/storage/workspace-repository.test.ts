import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, SessionInfo, Workspace } from "@termdock/protocol";
import { SqliteSessionRepository } from "./session-repository.js";
import { DATABASE_FILE, openDatabase } from "./database.js";
import { InMemoryWorkspaceRepository, SqliteWorkspaceRepository } from "./workspace-repository.js";
import type { WorkspaceRepository } from "./workspace-repository.js";

const databases: DatabaseSync[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(dir: string): DatabaseSync {
  const db = openDatabase(join(dir, DATABASE_FILE));
  databases.push(db);
  return db;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "termdock-ws-"));
  tempDirs.push(dir);
  return dir;
}

const project = (id: string, workspaceId: string, extra: Partial<Project> = {}): Project => ({
  id,
  workspaceId,
  name: `name-${id}`,
  path: `/home/dev/${id}`,
  backend: "wsl",
  ...extra,
});

function workspace(id: string, projects: Project[] = [], extra: Partial<Workspace> = {}): Workspace {
  return { id, name: `ws-${id}`, projects, ...extra };
}

const kinds: [string, () => WorkspaceRepository][] = [
  ["in-memory", () => new InMemoryWorkspaceRepository()],
  ["sqlite", () => new SqliteWorkspaceRepository(open(tempDir()))],
];

describe.each(kinds)("WorkspaceRepository (%s)", (_name, make) => {
  it("lists nothing at first", () => {
    expect(make().list()).toEqual([]);
  });

  it("returns what was saved, with optional fields unset, in creation order", () => {
    const repo = make();
    const full = workspace(
      "b",
      [project("p1", "b", { distro: "Ubuntu" }), project("p2", "b", { backend: "windows", path: "C:\\dev" })],
      {
        defaultCwd: "/srv",
      },
    );
    repo.save(full);
    repo.save(workspace("a"));
    const listed = repo.list();
    expect(listed.map((w) => w.id)).toEqual(["b", "a"]);
    expect(listed[0]).toEqual(full);
    expect("defaultCwd" in listed[1]!).toBe(false);
    expect("distro" in listed[0]!.projects[1]!).toBe(false);
  });

  it("replaces a workspace in place: rename, remove optional value, drop and add projects", () => {
    const repo = make();
    repo.save(workspace("a", [project("p1", "a"), project("p2", "a")], { defaultCwd: "/x" }));
    repo.save(workspace("b"));
    repo.save(workspace("a", [project("p2", "a", { name: "renamed" }), project("p3", "a")]));
    const [first, second] = repo.list();
    expect(second!.id).toBe("b");
    expect(first).toEqual(workspace("a", [project("p2", "a", { name: "renamed" }), project("p3", "a")]));
  });

  it("deletes a workspace with its projects and reports whether it existed", () => {
    const repo = make();
    repo.save(workspace("a", [project("p1", "a")]));
    repo.save(workspace("b", [project("p2", "b")]));
    expect(repo.delete("a")).toBe(true);
    expect(repo.delete("a")).toBe(false);
    expect(repo.list()).toEqual([workspace("b", [project("p2", "b")])]);
  });

  it("does not share objects with the caller", () => {
    const repo = make();
    const saved = workspace("a", [project("p1", "a")]);
    repo.save(saved);
    saved.name = "changed";
    repo.list()[0]!.projects.length = 0;
    expect(repo.list()).toEqual([workspace("a", [project("p1", "a")])]);
  });
});

describe("SqliteWorkspaceRepository", () => {
  it("keeps workspaces and projects over a restart", () => {
    const dir = tempDir();
    const first = open(dir);
    const saved = workspace(
      "a",
      [project("p1", "a", { distro: "Ubuntu" }), project("p2", "a", { backend: "windows", path: "D:\\x" })],
      {
        defaultCwd: "/srv",
      },
    );
    new SqliteWorkspaceRepository(first).save(saved);
    new SqliteWorkspaceRepository(first).save(workspace("b"));
    first.close();
    expect(new SqliteWorkspaceRepository(open(dir)).list()).toEqual([saved, workspace("b")]);
  });

  it("rolls the whole save back when one project is rejected", () => {
    const db = open(tempDir());
    const repo = new SqliteWorkspaceRepository(db);
    repo.save(workspace("a", [project("p1", "a")]));
    const broken = workspace("a", [project("p2", "a"), project("p3", "a", { backend: "ftp" as never })], {
      defaultCwd: "/y",
    });
    expect(() => repo.save(broken)).toThrow();
    expect(db.isTransaction).toBe(false);
    expect(repo.list()).toEqual([workspace("a", [project("p1", "a")])]);
  });

  it("deletes together with the caller's writes in one transaction, or not at all", () => {
    const db = open(tempDir());
    const repo = new SqliteWorkspaceRepository(db);
    const sessions = new SqliteSessionRepository(db);
    const session = (id: string, workspaceId: string): SessionInfo => ({
      id,
      name: id,
      state: "Running",
      launch: { backend: "wsl", cwd: "/" },
      workspaceId,
      size: { cols: 80, rows: 24 },
      loggingEnabled: true,
      createdAt: "2026-11-14T10:00:00.000Z",
      updatedAt: "2026-11-14T10:00:00.000Z",
    });
    const groups = () => sessions.list().map((s) => s.workspaceId ?? null);
    repo.save(workspace("a", [project("p1", "a")]));
    sessions.save(session("s1", "a"));
    const clear = () => sessions.clearWorkspace("a", "2026-11-14T11:00:00.000Z");

    // The removal itself fails: the caller's write is undone.
    expect(() =>
      repo.delete("a", () => {
        clear();
        throw new Error("disk full");
      }),
    ).toThrow("disk full");
    expect(db.isTransaction).toBe(false);
    expect(groups()).toEqual(["a"]);
    expect(repo.list()).toHaveLength(1);

    // Unknown workspace: false, and the caller's write is undone too.
    expect(repo.delete("nope", clear)).toBe(false);
    expect(groups()).toEqual(["a"]);

    expect(repo.delete("a", clear)).toBe(true);
    expect(groups()).toEqual([null]);
    expect(repo.list()).toEqual([]);
  });

  it("lets a profile survive its workspace and project, without the binding", () => {
    const db = open(tempDir());
    const repo = new SqliteWorkspaceRepository(db);
    repo.save(workspace("a", [project("p1", "a"), project("p2", "a")]));
    const insert = db.prepare(`
      INSERT INTO launch_profiles (id, name, workspace_id, project_id, backend, cwd, autostart, logging_enabled, created_at, updated_at)
      VALUES (:id, 'x', 'a', :project_id, 'wsl', '/', 0, 1, 'now', 'now')
    `);
    insert.run({ id: "pr1", project_id: "p1" });
    insert.run({ id: "pr2", project_id: "p2" });
    const bindings = () =>
      db.prepare("SELECT id, workspace_id, project_id FROM launch_profiles ORDER BY id").all();

    // Removing a project from the list unbinds only that project.
    repo.save(workspace("a", [project("p2", "a")]));
    expect(bindings()).toEqual([
      { id: "pr1", workspace_id: "a", project_id: null },
      { id: "pr2", workspace_id: "a", project_id: "p2" },
    ]);
    expect(repo.delete("a")).toBe(true);
    expect(bindings()).toEqual([
      { id: "pr1", workspace_id: null, project_id: null },
      { id: "pr2", workspace_id: null, project_id: null },
    ]);
  });
});
