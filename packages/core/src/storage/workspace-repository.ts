// Stored workspaces and their projects (ADR 0004, tables `workspaces` and `projects`).
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { BackendKind, Project, Workspace } from "@termdock/protocol";

export interface WorkspaceRepository {
  /** All workspaces with their projects, in the order they were created. */
  list(): Workspace[];
  /**
   * Inserts the workspace or replaces the stored one with the same id, including its project list: projects
   * that are no longer listed are removed. The caller has validated the workspace.
   */
  save(workspace: Workspace): void;
  /**
   * Removes the workspace and its projects; false when it did not exist (then nothing was changed).
   * `alsoInTransaction` runs in the same transaction, before the removal: when it or the removal throws, or the
   * workspace does not exist, its writes are rolled back. For SQLite it must use the same connection.
   */
  delete(workspaceId: string, alsoInTransaction?: () => void): boolean;
}

/** Repository without a file, for tests and a Core without storage. */
export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  // A Map keeps the insertion order when a key is set again.
  private readonly workspaces = new Map<string, Workspace>();

  list(): Workspace[] {
    return [...this.workspaces.values()].map((workspace) => structuredClone(workspace));
  }

  save(workspace: Workspace): void {
    this.workspaces.set(workspace.id, structuredClone(workspace));
  }

  delete(workspaceId: string, alsoInTransaction?: () => void): boolean {
    if (!this.workspaces.has(workspaceId)) return false;
    alsoInTransaction?.();
    return this.workspaces.delete(workspaceId);
  }
}

export class SqliteWorkspaceRepository implements WorkspaceRepository {
  private readonly selectWorkspaces: StatementSync;
  private readonly selectProjects: StatementSync;
  private readonly upsertWorkspace: StatementSync;
  private readonly upsertProject: StatementSync;
  private readonly selectProjectIds: StatementSync;
  private readonly deleteProject: StatementSync;
  private readonly deleteWorkspace: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    // rowid keeps the creation order; an upsert does not change it.
    this.selectWorkspaces = db.prepare("SELECT * FROM workspaces ORDER BY rowid");
    this.selectProjects = db.prepare("SELECT * FROM projects ORDER BY rowid");
    this.upsertWorkspace = db.prepare(`
      INSERT INTO workspaces (id, name, default_cwd, created_at, updated_at)
      VALUES (:id, :name, :default_cwd, :now, :now)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name, default_cwd = excluded.default_cwd, updated_at = excluded.updated_at
    `);
    this.upsertProject = db.prepare(`
      INSERT INTO projects (id, workspace_id, name, path, backend, distro, created_at, updated_at)
      VALUES (:id, :workspace_id, :name, :path, :backend, :distro, :now, :now)
      ON CONFLICT (id) DO UPDATE SET
        workspace_id = excluded.workspace_id, name = excluded.name, path = excluded.path,
        backend = excluded.backend, distro = excluded.distro, updated_at = excluded.updated_at
    `);
    this.selectProjectIds = db.prepare("SELECT id FROM projects WHERE workspace_id = :workspace_id");
    this.deleteProject = db.prepare("DELETE FROM projects WHERE id = :id");
    this.deleteWorkspace = db.prepare("DELETE FROM workspaces WHERE id = :id");
  }

  list(): Workspace[] {
    const byWorkspace = new Map<string, Project[]>();
    for (const row of this.selectProjects.all()) {
      const project = projectFromRow(row);
      const projects = byWorkspace.get(project.workspaceId);
      if (projects) projects.push(project);
      else byWorkspace.set(project.workspaceId, [project]);
    }
    return this.selectWorkspaces.all().map((row) => {
      const id = String(row.id);
      const workspace: Workspace = { id, name: String(row.name), projects: byWorkspace.get(id) ?? [] };
      if (typeof row.default_cwd === "string") workspace.defaultCwd = row.default_cwd;
      return workspace;
    });
  }

  save(workspace: Workspace): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.upsertWorkspace.run({
        id: workspace.id,
        name: workspace.name,
        default_cwd: workspace.defaultCwd ?? null,
        now,
      });
      const kept = new Set(workspace.projects.map((project) => project.id));
      for (const row of this.selectProjectIds.all({ workspace_id: workspace.id })) {
        if (!kept.has(String(row.id))) this.deleteProject.run({ id: String(row.id) });
      }
      for (const project of workspace.projects) {
        this.upsertProject.run({
          id: project.id,
          workspace_id: workspace.id,
          name: project.name,
          path: project.path,
          backend: project.backend,
          distro: project.distro ?? null,
          now,
        });
      }
    });
  }

  delete(workspaceId: string, alsoInTransaction?: () => void): boolean {
    // Projects go with the workspace (ON DELETE CASCADE); profiles lose their binding (ON DELETE SET NULL).
    let removed = false;
    this.transaction(() => {
      alsoInTransaction?.();
      removed = Number(this.deleteWorkspace.run({ id: workspaceId }).changes) > 0;
      // Nothing to delete: undo what the caller wrote in the same transaction.
      if (!removed) throw new NothingToDelete();
    }, NothingToDelete);
    return removed;
  }

  /** All writes of one save under one write lock, so a crash or a second connection never sees half of it. */
  private transaction(work: () => void, rolledBackQuietly?: new () => Error): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      if (rolledBackQuietly && error instanceof rolledBackQuietly) return;
      throw error;
    }
  }
}

/** Internal signal: `delete` found no workspace and rolls back. */
class NothingToDelete extends Error {}

function projectFromRow(row: Record<string, unknown>): Project {
  const project: Project = {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    path: String(row.path),
    backend: String(row.backend) as BackendKind,
  };
  if (typeof row.distro === "string") project.distro = row.distro;
  return project;
}
