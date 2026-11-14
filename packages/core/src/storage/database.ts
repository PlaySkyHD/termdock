// SQLite storage of the Core metadata (ADR 0004): termdock.db in the data directory, WAL, numbered migrations.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Disposable } from "../backend/types.js";
import { SqliteLayoutRepository } from "./layout-repository.js";
import type { LayoutRepository } from "./layout-repository.js";
import { migrate, schemaVersion } from "./migrations.js";
import { SqliteSessionRepository } from "./session-repository.js";
import type { SessionRepository } from "./session-repository.js";
import { SqliteProfileRepository } from "./profile-repository.js";
import type { ProfileRepository } from "./profile-repository.js";
import { SqliteSettingsRepository } from "./settings-repository.js";
import type { SettingsRepository } from "./settings-repository.js";
import { SqliteWorkspaceRepository } from "./workspace-repository.js";
import type { WorkspaceRepository } from "./workspace-repository.js";

export const DATABASE_FILE = "termdock.db";

/** Waits this long for a lock held by another connection before failing. */
const BUSY_TIMEOUT_MS = 5000;

/** `TERMDOCK_DATA_DIR` if set (tests), otherwise `%APPDATA%\TermDock`. */
export function resolveDataDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env.TERMDOCK_DATA_DIR;
  if (override) return override;
  const appData = env.APPDATA;
  if (!appData)
    throw new Error("Neither TERMDOCK_DATA_DIR nor APPDATA is set; cannot locate the data directory");
  return join(appData, "TermDock");
}

/** Opens (and creates) a database file, or `:memory:`, in WAL mode with all migrations applied. */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA journal_mode = WAL");
    // Safe with WAL: a power loss can lose the last commits but never corrupts the file; saves no fsync per write.
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export interface Storage extends Disposable {
  readonly sessions: SessionRepository;
  readonly layouts: LayoutRepository;
  readonly settings: SettingsRepository;
  readonly workspaces: WorkspaceRepository;
  readonly profiles: ProfileRepository;
  /** Highest applied migration. */
  schemaVersion(): number;
  /** Closes the database. */
  dispose(): void;
}

export interface OpenStorageOptions {
  /** Directory of termdock.db; defaults to `resolveDataDir()`. Created if missing. */
  dataDir?: string;
  /** Receives the reason when a stored layout or setting cannot be used; defaults to stderr. */
  onLayoutInvalid?: (message: string) => void;
  /** Receives the reason when a stored profile cannot be used (it is skipped); defaults to stderr. */
  onProfileInvalid?: (message: string) => void;
}

export function openStorage(options: OpenStorageOptions = {}): Storage {
  const dataDir = options.dataDir ?? resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  let sessions: SessionRepository;
  let layouts: LayoutRepository;
  let settings: SettingsRepository;
  let workspaces: WorkspaceRepository;
  let profiles: ProfileRepository;
  try {
    sessions = new SqliteSessionRepository(db);
    layouts = new SqliteLayoutRepository(db, options.onLayoutInvalid);
    settings = new SqliteSettingsRepository(db, options.onLayoutInvalid);
    workspaces = new SqliteWorkspaceRepository(db);
    profiles = new SqliteProfileRepository(db, options.onProfileInvalid);
  } catch (error) {
    db.close();
    throw error;
  }
  let open = true;
  return {
    sessions,
    layouts,
    settings,
    workspaces,
    profiles,
    schemaVersion: () => schemaVersion(db),
    dispose: () => {
      if (!open) return;
      open = false;
      db.close();
    },
  };
}
