// Numbered schema migrations of termdock.db (ADR 0004). Never edit a released migration; add a new one.
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  /** Consecutive, starting at 1. */
  readonly version: number;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX projects_workspace ON projects (workspace_id);

      -- Window/tab/split layout of a workspace as JSON.
      CREATE TABLE layouts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      -- workspace_id has no foreign key yet: the registry accepts workspace ids before workspaces are managed.
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        backend TEXT NOT NULL CHECK (backend IN ('wsl', 'windows')),
        distro TEXT,
        shell TEXT,
        cwd TEXT NOT NULL,
        command TEXT,
        env TEXT,
        state TEXT NOT NULL
          CHECK (state IN ('Starting', 'Running', 'Detached', 'Exited', 'Interrupted', 'Archived')),
        workspace_id TEXT,
        profile_id TEXT,
        cols INTEGER NOT NULL,
        rows INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_exit_code INTEGER,
        logging_enabled INTEGER NOT NULL CHECK (logging_enabled IN (0, 1))
      ) STRICT;
      CREATE INDEX sessions_workspace ON sessions (workspace_id);
    `,
  },
];

/** Highest applied migration; 0 for an empty database. */
export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_version").get();
  return typeof row?.version === "number" ? row.version : 0;
}

/**
 * Applies every migration newer than the database, each in its own transaction together with its
 * `schema_version` entry. The version is read again under the write lock, so a migration another
 * connection applied meanwhile is skipped. Refuses a database that is newer than this code.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY) STRICT");
  const current = schemaVersion(db);
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new Error(`Database schema version ${current} is newer than this TermDock (${latest})`);
  }
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Another connection may have migrated between the first read and this lock.
      if (schemaVersion(db) >= migration.version) {
        db.exec("COMMIT");
        continue;
      }
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(migration.version);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
