import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_SETTINGS } from "@termdock/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CoreError } from "../session/errors.js";
import { DATABASE_FILE, openStorage } from "./database.js";
import type { Storage } from "./database.js";
import { InMemorySettingsRepository } from "./settings-repository.js";
import type { SettingsRepository } from "./settings-repository.js";

const opened: Storage[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const storage of opened.splice(0)) storage.dispose();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "termdock-settings-"));
  tempDirs.push(dir);
  return dir;
}

function open(dir: string, onInvalid?: (message: string) => void): Storage {
  const storage = openStorage({ dataDir: dir, ...(onInvalid ? { onLayoutInvalid: onInvalid } : {}) });
  opened.push(storage);
  return storage;
}

function failure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

const implementations: [string, () => SettingsRepository][] = [
  ["InMemorySettingsRepository", () => new InMemorySettingsRepository()],
  ["SqliteSettingsRepository", () => open(tempDir()).settings],
];

describe.each(implementations)("%s", (_name, create) => {
  it("returns the defaults while nothing is stored", () => {
    expect(create().get()).toEqual(DEFAULT_SETTINGS);
  });

  it("merges a patch and keeps the other keys", () => {
    const repository = create();
    expect(repository.set({ confirmQuitWhileRunning: false, quitAction: "stopSessions" })).toEqual({
      ...DEFAULT_SETTINGS,
      confirmQuitWhileRunning: false,
      quitAction: "stopSessions",
    });
    repository.set({ defaultDistro: "Ubuntu" });
    expect(repository.get()).toEqual({
      ...DEFAULT_SETTINGS,
      confirmQuitWhileRunning: false,
      quitAction: "stopSessions",
      defaultDistro: "Ubuntu",
    });
  });

  it("removes an optional key with null and falls back to its default", () => {
    const repository = create();
    repository.set({ quitAction: "stopSessions", defaultCwd: "/work" });
    expect(repository.set({ quitAction: null })).toEqual({ ...DEFAULT_SETTINGS, defaultCwd: "/work" });
    expect(repository.get().quitAction).toBeUndefined();
  });

  it("rejects an invalid result with bad_request and stores nothing", () => {
    const repository = create();
    repository.set({ historyLimitBytes: 5_000_000 });
    // The guard keeps this out of the wire; the repository checks the merged result on its own.
    const error = failure(() => repository.set({ historyLimitBytes: 1 }));
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe("bad_request");
    expect(repository.get().historyLimitBytes).toBe(5_000_000);
  });
});

describe("SqliteSettingsRepository", () => {
  it("keeps the values across a reopen", () => {
    const dir = tempDir();
    const first = open(dir);
    first.settings.set({ confirmQuitWhileRunning: false, quitAction: "keepSessions" });
    first.dispose();
    expect(open(dir).settings.get()).toEqual({
      ...DEFAULT_SETTINGS,
      confirmQuitWhileRunning: false,
      quitAction: "keepSessions",
    });
  });

  it("stores one JSON row per set key", () => {
    const dir = tempDir();
    const storage = open(dir);
    storage.settings.set({ confirmQuitWhileRunning: false, defaultDistro: "Ubuntu" });
    storage.dispose();
    const db = new DatabaseSync(join(dir, DATABASE_FILE));
    try {
      const rows = db.prepare("SELECT key, value FROM settings ORDER BY key").all();
      expect(rows.map((row) => ({ ...row }))).toEqual([
        { key: "confirmQuitWhileRunning", value: "false" },
        { key: "defaultDistro", value: '"Ubuntu"' },
      ]);
    } finally {
      db.close();
    }
  });

  it("reports an unusable row and uses the default for that key only", () => {
    const dir = tempDir();
    const storage = open(dir);
    storage.settings.set({ quitAction: "stopSessions" });
    storage.dispose();
    const db = new DatabaseSync(join(dir, DATABASE_FILE));
    db.prepare("INSERT INTO settings (key, value) VALUES ('historyLimitBytes', '\"big\"')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('confirmQuitWhileRunning', 'not json')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('unknownKey', '1')").run();
    db.close();
    const messages: string[] = [];
    const settings = open(dir, (message) => messages.push(message)).settings.get();
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, quitAction: "stopSessions" });
    expect(messages).toHaveLength(2);
    expect(messages.join("\n")).toContain("historyLimitBytes");
    expect(messages.join("\n")).toContain("confirmQuitWhileRunning");
  });
});
