// Stored session metadata (ADR 0004). Views and the writer are runtime state and are not stored.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type {
  BackendKind,
  LaunchSpec,
  SessionId,
  SessionInfo,
  SessionState,
  WindowsShell,
} from "@termdock/protocol";

export interface SessionRepository {
  /** All stored sessions, oldest first (by `createdAt`, then id). */
  list(): SessionInfo[];
  /** Inserts the session or replaces the stored one with the same id. */
  save(session: SessionInfo): void;
  /** Removes the stored session; an unknown id is not an error (issue #57). */
  delete(sessionId: SessionId): void;
}

/** Repository without a file, for tests and a Core without storage. */
export class InMemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, SessionInfo>();

  list(): SessionInfo[] {
    return [...this.sessions.values()]
      .sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id))
      .map((session) => toStored(session));
  }

  save(session: SessionInfo): void {
    this.sessions.set(session.id, toStored(session));
  }

  delete(sessionId: SessionId): void {
    this.sessions.delete(sessionId);
  }
}

export class SqliteSessionRepository implements SessionRepository {
  private readonly selectAll: StatementSync;
  private readonly upsert: StatementSync;
  private readonly deleteOne: StatementSync;

  constructor(db: DatabaseSync) {
    this.selectAll = db.prepare("SELECT * FROM sessions ORDER BY created_at, id");
    this.deleteOne = db.prepare("DELETE FROM sessions WHERE id = ?");
    this.upsert = db.prepare(`
      INSERT INTO sessions (
        id, name, backend, distro, shell, cwd, command, env, state, workspace_id, profile_id,
        cols, rows, created_at, updated_at, last_exit_code, logging_enabled
      ) VALUES (
        :id, :name, :backend, :distro, :shell, :cwd, :command, :env, :state, :workspace_id, :profile_id,
        :cols, :rows, :created_at, :updated_at, :last_exit_code, :logging_enabled
      )
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name, backend = excluded.backend, distro = excluded.distro, shell = excluded.shell,
        cwd = excluded.cwd, command = excluded.command, env = excluded.env, state = excluded.state,
        workspace_id = excluded.workspace_id, profile_id = excluded.profile_id, cols = excluded.cols,
        rows = excluded.rows, created_at = excluded.created_at, updated_at = excluded.updated_at,
        last_exit_code = excluded.last_exit_code, logging_enabled = excluded.logging_enabled
    `);
  }

  list(): SessionInfo[] {
    return this.selectAll.all().map((row) => fromRow(row));
  }

  save(session: SessionInfo): void {
    const { launch } = session;
    this.upsert.run({
      id: session.id,
      name: session.name,
      backend: launch.backend,
      distro: launch.distro ?? null,
      shell: launch.shell ?? null,
      cwd: launch.cwd,
      command: launch.command === undefined ? null : JSON.stringify(launch.command),
      env: launch.env === undefined ? null : JSON.stringify(launch.env),
      state: session.state,
      workspace_id: session.workspaceId ?? null,
      profile_id: session.profileId ?? null,
      cols: session.size.cols,
      rows: session.size.rows,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      last_exit_code: session.lastExitCode ?? null,
      logging_enabled: session.loggingEnabled ? 1 : 0,
    });
  }

  delete(sessionId: SessionId): void {
    this.deleteOne.run(sessionId);
  }
}

type Row = Record<string, unknown>;

function fromRow(row: Row): SessionInfo {
  const launch: LaunchSpec = { backend: text(row, "backend") as BackendKind, cwd: text(row, "cwd") };
  const distro = optionalText(row, "distro");
  if (distro !== undefined) launch.distro = distro;
  const shell = optionalText(row, "shell");
  if (shell !== undefined) launch.shell = shell as WindowsShell;
  const command = optionalText(row, "command");
  if (command !== undefined) launch.command = JSON.parse(command) as string[];
  const env = optionalText(row, "env");
  if (env !== undefined) launch.env = JSON.parse(env) as Record<string, string>;
  const session: SessionInfo = {
    id: text(row, "id"),
    name: text(row, "name"),
    state: text(row, "state") as SessionState,
    launch,
    size: { cols: integer(row, "cols"), rows: integer(row, "rows") },
    loggingEnabled: integer(row, "logging_enabled") === 1,
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
  const workspaceId = optionalText(row, "workspace_id");
  if (workspaceId !== undefined) session.workspaceId = workspaceId;
  const profileId = optionalText(row, "profile_id");
  if (profileId !== undefined) session.profileId = profileId;
  const lastExitCode = row.last_exit_code;
  if (lastExitCode !== null && lastExitCode !== undefined) session.lastExitCode = Number(lastExitCode);
  return session;
}

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`sessions.${column}: expected text`);
  return value;
}

function optionalText(row: Row, column: string): string | undefined {
  return row[column] === null || row[column] === undefined ? undefined : text(row, column);
}

function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== "number" && typeof value !== "bigint")
    throw new Error(`sessions.${column}: expected integer`);
  return Number(value);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deep copy without runtime-only fields, so later changes to the caller's object do not leak in. */
function toStored(session: SessionInfo): SessionInfo {
  const { writerViewId: _writer, ...rest } = session;
  const launch: LaunchSpec = { ...session.launch };
  if (session.launch.command !== undefined) launch.command = [...session.launch.command];
  if (session.launch.env !== undefined) launch.env = { ...session.launch.env };
  return { ...rest, launch, size: { ...session.size } };
}
