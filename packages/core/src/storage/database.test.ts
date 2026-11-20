import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "@termdock/protocol";
import { DATABASE_FILE, openStorage, resolveDataDir } from "./database.js";
import type { Storage } from "./database.js";
import { MIGRATIONS, migrate, schemaVersion } from "./migrations.js";

const opened: Array<{ close(): void }> = [];
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "termdock-db-"));
  tempDirs.push(dir);
  return dir;
}

function open(dataDir: string): Storage {
  const storage = openStorage({ dataDir });
  opened.push({ close: () => storage.dispose() });
  return storage;
}

/** Second connection that looks at the file the way an external tool would (the schema is fixed by ADR 0004). */
function inspect(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(join(dataDir, DATABASE_FILE));
  opened.push(db);
  return db;
}

afterEach(() => {
  // Close handles before deleting: Windows keeps open database files locked.
  for (const handle of opened.splice(0).reverse()) {
    try {
      handle.close();
    } catch {
      // Already closed by the test.
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const session: SessionInfo = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "shell",
  state: "Detached",
  launch: { backend: "wsl", cwd: "/home/user" },
  size: { cols: 80, rows: 24 },
  loggingEnabled: true,
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
};

describe("resolveDataDir", () => {
  it("uses TERMDOCK_DATA_DIR when set", () => {
    expect(resolveDataDir({ TERMDOCK_DATA_DIR: "D:\\data", APPDATA: "C:\\Users\\u\\AppData\\Roaming" })).toBe(
      "D:\\data",
    );
  });

  it("falls back to TermDock under APPDATA", () => {
    expect(resolveDataDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" })).toBe(
      join("C:\\Users\\u\\AppData\\Roaming", "TermDock"),
    );
  });

  it("fails without TERMDOCK_DATA_DIR and APPDATA", () => {
    expect(() => resolveDataDir({})).toThrow(/TERMDOCK_DATA_DIR/);
  });
});

describe("openStorage", () => {
  it("creates termdock.db with all tables, the latest schema version and WAL in an empty directory", () => {
    const dataDir = join(tempDir(), "nested");

    const storage = open(dataDir);

    expect(DATABASE_FILE).toBe("termdock.db");
    expect(existsSync(join(dataDir, "termdock.db"))).toBe(true);
    expect(storage.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    const db = inspect(dataDir);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "launch_profiles",
        "layouts",
        "projects",
        "schema_version",
        "sessions",
        "settings",
        "workspaces",
      ]),
    );
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  });

  it("applies no migration again when reopened and keeps the stored sessions", () => {
    const dataDir = tempDir();
    const first = open(dataDir);
    first.sessions.save(session);
    first.dispose();

    const second = open(dataDir);

    expect(second.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    const versions = inspect(dataDir)
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all()
      .map((row) => row.version);
    expect(versions).toEqual(MIGRATIONS.map((m) => m.version));
    expect(second.sessions.list()).toEqual([session]);
  });

  it("skips migrations another connection applied after this one read the version", () => {
    const dataDir = tempDir();
    const file = join(dataDir, DATABASE_FILE);
    const a = new DatabaseSync(file);
    const b = new DatabaseSync(file);
    opened.push(a, b);
    // Connection B migrates the file right after A has read the (empty) schema version.
    let raced = false;
    const migrations = Object.assign([...MIGRATIONS], {
      at(index: number) {
        if (!raced) {
          raced = true;
          migrate(b);
        }
        return MIGRATIONS.at(index);
      },
    });

    expect(() => migrate(a, migrations)).not.toThrow();

    expect(raced).toBe(true);
    expect(schemaVersion(a)).toBe(MIGRATIONS.at(-1)?.version);
    const versions = a
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all()
      .map((row) => row.version);
    expect(versions).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it("migrates a version-2 database to 3 and keeps the stored data (issue #55)", () => {
    const dataDir = tempDir();
    const old = new DatabaseSync(join(dataDir, DATABASE_FILE));
    opened.push(old);
    migrate(
      old,
      MIGRATIONS.filter((m) => m.version <= 2),
    );
    expect(schemaVersion(old)).toBe(2);
    const at = "2026-11-13T10:00:00.000Z";
    old.exec(`
      INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('w1', 'TermDock', '${at}', '${at}');
      INSERT INTO projects (id, workspace_id, name, path, created_at, updated_at)
        VALUES ('p1', 'w1', 'termdock', '/home/user/termdock', '${at}', '${at}');
      INSERT INTO layouts (id, workspace_id, data, updated_at, revision) VALUES ('global', NULL, '{"x":1}', '${at}', 4);
      INSERT INTO sessions (id, name, backend, cwd, state, workspace_id, cols, rows, created_at, updated_at,
        logging_enabled)
        VALUES ('${session.id}', 'shell', 'wsl', '/home/user', 'Detached', NULL, 80, 24, '${at}', '${at}', 1);
    `);
    old.close();

    const storage = open(dataDir);

    expect(storage.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(storage.sessions.list()).toEqual([session]);
    const db = inspect(dataDir);
    expect(db.prepare("SELECT id, name, default_cwd FROM workspaces").all()).toEqual([
      { id: "w1", name: "TermDock", default_cwd: null },
    ]);
    expect(db.prepare("SELECT id, workspace_id, path, backend, distro FROM projects").all()).toEqual([
      { id: "p1", workspace_id: "w1", path: "/home/user/termdock", backend: "wsl", distro: null },
    ]);
    expect(db.prepare("SELECT data, revision FROM layouts").all()).toEqual([
      { data: '{"x":1}', revision: 4 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM launch_profiles").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings").get()).toEqual({ n: 0 });
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'")
      .all()
      .map((row) => row.name);
    expect(indexes).toContain("sessions_profile");
  });

  it("stores profiles and settings and unbinds a profile when its workspace is deleted (issue #55)", () => {
    const dataDir = tempDir();
    open(dataDir);
    const db = new DatabaseSync(join(dataDir, DATABASE_FILE));
    opened.push(db);
    db.exec("PRAGMA foreign_keys = ON");
    const at = "2026-11-13T10:00:00.000Z";
    db.exec(`
      INSERT INTO workspaces (id, name, default_cwd, created_at, updated_at)
        VALUES ('w1', 'TermDock', '/home/user', '${at}', '${at}');
      INSERT INTO projects (id, workspace_id, name, path, backend, distro, created_at, updated_at)
        VALUES ('p1', 'w1', 'api', '/home/user/api', 'wsl', 'Ubuntu', '${at}', '${at}');
      INSERT INTO launch_profiles (id, name, workspace_id, project_id, backend, distro, shell, cwd, command, env,
        autostart, logging_enabled, created_at, updated_at)
        VALUES ('pr1', 'Claude', 'w1', 'p1', 'wsl', NULL, NULL, '/home/user/api', '["claude"]', NULL, 1, 1,
          '${at}', '${at}');
      INSERT INTO settings (key, value) VALUES ('historyLimitBytes', '65536');
    `);
    expect(() =>
      db.exec(`INSERT INTO projects (id, workspace_id, name, path, backend, created_at, updated_at)
        VALUES ('p2', 'w1', 'x', '/x', 'mac', '${at}', '${at}')`),
    ).toThrow(/CHECK/);

    db.exec("DELETE FROM workspaces WHERE id = 'w1'");

    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT id, workspace_id, project_id, autostart FROM launch_profiles").all()).toEqual([
      { id: "pr1", workspace_id: null, project_id: null, autostart: 1 },
    ]);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'historyLimitBytes'").get()).toEqual({
      value: "65536",
    });
  });

  it("unbinds only the project of a profile when that project is deleted (PR #79)", () => {
    const dataDir = tempDir();
    open(dataDir);
    const db = new DatabaseSync(join(dataDir, DATABASE_FILE));
    opened.push(db);
    db.exec("PRAGMA foreign_keys = ON");
    const at = "2026-11-13T10:00:00.000Z";
    db.exec(`
      INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('w1', 'TermDock', '${at}', '${at}');
      INSERT INTO projects (id, workspace_id, name, path, created_at, updated_at)
        VALUES ('p1', 'w1', 'api', '/home/user/api', '${at}', '${at}');
      INSERT INTO launch_profiles (id, name, workspace_id, project_id, backend, cwd, autostart, logging_enabled,
        created_at, updated_at)
        VALUES ('pr1', 'Claude', 'w1', 'p1', 'wsl', '/home/user/api', 0, 1, '${at}', '${at}');
    `);

    db.exec("DELETE FROM projects WHERE id = 'p1'");

    expect(db.prepare("SELECT id, workspace_id, project_id FROM launch_profiles").all()).toEqual([
      { id: "pr1", workspace_id: "w1", project_id: null },
    ]);
    expect(db.prepare("SELECT id FROM workspaces").all()).toEqual([{ id: "w1" }]);
  });

  it("refuses a database whose schema is newer than the code", () => {
    const dataDir = tempDir();
    open(dataDir).dispose();
    const db = inspect(dataDir);
    db.exec("INSERT INTO schema_version (version) VALUES (9999)");
    db.close();

    expect(() => open(dataDir)).toThrow(/newer/);
  });

  it("removes secret-looking env entries from stored sessions and warns without the value (issue #149)", () => {
    const dataDir = tempDir();
    const old = new DatabaseSync(join(dataDir, DATABASE_FILE));
    opened.push(old);
    migrate(
      old,
      MIGRATIONS.filter((m) => m.version <= 3),
    );
    const at = "2026-11-13T10:00:00.000Z";
    const fake = "td-test-secret-0000";
    const insert = old.prepare(`
      INSERT INTO sessions (id, name, backend, cwd, env, state, cols, rows, created_at, updated_at, logging_enabled)
      VALUES (?, 's', 'wsl', '/home/user', ?, 'Detached', 80, 24, '${at}', '${at}', 1)`);
    insert.run(
      "mixed",
      JSON.stringify({ LANG: "C.UTF-8", GITHUB_TOKEN: fake, SECRET_KEY: fake, SORT_KEY: "asc" }),
    );
    insert.run(
      "only-secret",
      JSON.stringify({ DATABASE_URL: `postgres://app:${fake}@db.example.invalid/x` }),
    );
    insert.run("harmless", JSON.stringify({ KEYBOARD: "us", PATH: "/usr/bin" }));
    insert.run("none", null);
    insert.run("broken", "{not json");
    old.close();
    const warnings: string[] = [];

    const storage = openStorage({ dataDir, onMigrationWarning: (message) => warnings.push(message) });
    opened.push({ close: () => storage.dispose() });

    const db = inspect(dataDir);
    const env = (id: string) => db.prepare("SELECT env FROM sessions WHERE id = ?").get(id)?.env;
    expect(env("mixed")).toBe(JSON.stringify({ LANG: "C.UTF-8", SORT_KEY: "asc" }));
    expect(env("only-secret")).toBeNull();
    expect(env("harmless")).toBe(JSON.stringify({ KEYBOARD: "us", PATH: "/usr/bin" }));
    expect(env("none")).toBeNull();
    expect(env("broken")).toBe("{not json");
    expect(warnings.sort()).toEqual([
      'session mixed: removed env key "GITHUB_TOKEN" (looks like a secret)',
      'session mixed: removed env key "SECRET_KEY" (looks like a secret)',
      'session only-secret: removed env key "DATABASE_URL" (looks like a secret)',
    ]);
    expect(warnings.join("\n")).not.toContain(fake);
    // The database file (WAL included) no longer holds the value.
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE env LIKE ?").get(`%${fake}%`)).toEqual({
      n: 0,
    });
  });

  it("logs migration warnings only after the commit, none when the migration is rolled back (issue #149)", () => {
    const db = new DatabaseSync(":memory:");
    opened.push(db);
    const failing: typeof MIGRATIONS = [
      {
        version: 1,
        sql: "CREATE TABLE t (id TEXT) STRICT;",
        run: (_db, warn) => {
          warn('profile p1: removed env key "X_TOKEN" (looks like a secret)');
          throw new Error("boom");
        },
      },
    ];
    const warnings: string[] = [];
    expect(() => migrate(db, failing, (message) => warnings.push(message))).toThrow(/boom/);
    expect(warnings).toEqual([]);
    expect(schemaVersion(db)).toBe(0);

    const working: typeof MIGRATIONS = [{ ...failing[0]!, run: (_db, warn) => warn("w") }];
    migrate(db, working, (message) => warnings.push(message));
    expect(warnings).toEqual(["w"]);
  });
});
