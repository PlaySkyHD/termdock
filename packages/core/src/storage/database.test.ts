import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "@termdock/protocol";
import { DATABASE_FILE, openStorage, resolveDataDir } from "./database.js";
import type { Storage } from "./database.js";
import { MIGRATIONS } from "./migrations.js";

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
      expect.arrayContaining(["layouts", "projects", "schema_version", "sessions", "workspaces"]),
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

  it("refuses a database whose schema is newer than the code", () => {
    const dataDir = tempDir();
    open(dataDir).dispose();
    const db = inspect(dataDir);
    db.exec("INSERT INTO schema_version (version) VALUES (9999)");
    db.close();

    expect(() => open(dataDir)).toThrow(/newer/);
  });
});
