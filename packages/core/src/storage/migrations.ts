// Numbered schema migrations of termdock.db (ADR 0004). Never edit a released migration; add a new one.
import type { DatabaseSync } from "node:sqlite";
import { secretEnvReason } from "../session/secret-env.js";

export interface Migration {
  /** Consecutive, starting at 1. */
  readonly version: number;
  readonly sql: string;
  /** Runs after `sql` in the same transaction, for changes plain SQL cannot make. `warn` never gets a value. */
  readonly run?: (db: DatabaseSync, warn: (message: string) => void) => void;
}

/**
 * Issue #149: sessions created before the refusal of secret keys (#146) keep the value in `sessions.env`, and a
 * restart would pass it on. Removes every entry the shared rule (`secret-env.ts`) takes for a secret and warns with
 * session id and key, never the value. A row whose JSON cannot be read is left alone (the repository skips it).
 */
export function removeSecretSessionEnv(db: DatabaseSync, warn: (message: string) => void): void {
  const rows = db.prepare("SELECT id, env FROM sessions WHERE env IS NOT NULL").all();
  const update = db.prepare("UPDATE sessions SET env = ? WHERE id = ?");
  for (const row of rows) {
    const id = String(row.id);
    let env: unknown;
    try {
      env = JSON.parse(String(row.env));
    } catch {
      continue;
    }
    if (typeof env !== "object" || env === null || Array.isArray(env)) continue;
    const kept: Record<string, unknown> = {};
    const removed: string[] = [];
    for (const [key, value] of Object.entries(env)) {
      if (secretEnvReason(key, String(value)) === undefined) kept[key] = value;
      else removed.push(key);
    }
    if (removed.length === 0) continue;
    update.run(Object.keys(kept).length === 0 ? null : JSON.stringify(kept), id);
    for (const key of removed) {
      warn(`session ${id}: removed env key ${JSON.stringify(key.slice(0, 64))} (looks like a secret)`);
    }
  }
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
  {
    version: 2,
    // Revision of the stored layout: 0 for a row without saves, +1 per save (layout.save, baseRevision).
    sql: `ALTER TABLE layouts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 3,
    // Phase 3 (issue #55): project backends, workspace default directory, launch profiles, settings.
    sql: `
      ALTER TABLE workspaces ADD COLUMN default_cwd TEXT;

      -- Existing projects were all WSL folders.
      ALTER TABLE projects ADD COLUMN backend TEXT NOT NULL DEFAULT 'wsl' CHECK (backend IN ('wsl', 'windows'));
      ALTER TABLE projects ADD COLUMN distro TEXT;

      -- LaunchSpec in columns as in sessions; command and env as JSON. Deleting a workspace or project
      -- unbinds the profile (deleting a workspace cascades to its projects).
      CREATE TABLE launch_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_id TEXT REFERENCES workspaces (id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
        backend TEXT NOT NULL CHECK (backend IN ('wsl', 'windows')),
        distro TEXT,
        shell TEXT,
        cwd TEXT NOT NULL,
        command TEXT,
        env TEXT,
        autostart INTEGER NOT NULL CHECK (autostart IN (0, 1)),
        logging_enabled INTEGER NOT NULL CHECK (logging_enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX launch_profiles_workspace ON launch_profiles (workspace_id);
      CREATE INDEX launch_profiles_project ON launch_profiles (project_id);

      -- One row per key of Settings with a JSON value; a missing key has its default.
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      -- Autostart looks up the sessions of a profile (ADR 0005). No foreign key: a session keeps its profile id.
      CREATE INDEX sessions_profile ON sessions (profile_id);
    `,
  },
  {
    version: 4,
    // Issue #149: remove secret-looking entries from stored sessions.
    sql: "",
    run: removeSecretSessionEnv,
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
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  warn: (message: string) => void = () => {},
): void {
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
      migration.run?.(db, warn);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(migration.version);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
