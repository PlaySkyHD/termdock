// Stored settings (ADR 0004, table `settings`): one row per key with a JSON value; a missing key has its default.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { DEFAULT_SETTINGS, validateSettings } from "@termdock/protocol";
import type { Settings, SettingsPatch } from "@termdock/protocol";
import { CoreError } from "../session/errors.js";

export interface SettingsRepository {
  /** All settings, a missing or unusable key with its default. Synchronous, so other parts can read it per use. */
  get(): Settings;
  /**
   * Merges the patch into the stored settings and returns the result: a missing key stays, `null` removes an
   * optional key. A result that is not a valid `Settings` stores nothing and throws `CoreError("bad_request")`.
   */
  set(patch: SettingsPatch): Settings;
}

/** The keys of `Settings`; the only keys the table holds. */
const KEYS = [
  "defaultDistro",
  "defaultShell",
  "defaultCwd",
  "historyLimitBytes",
  "historyEnabledByDefault",
  "confirmQuitWhileRunning",
  "quitAction",
] as const satisfies readonly (keyof Settings)[];

/** The merged settings, checked with the protocol guard. Pure: the caller stores nothing before it succeeds. */
export function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  const merged: Record<string, unknown> = { ...current };
  for (const key of KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  const checked = validateSettings(merged);
  if (!checked.ok) throw new CoreError("bad_request", checked.error.message);
  return checked.value;
}

/** Repository without a file, for tests and a Core without storage. */
export class InMemorySettingsRepository implements SettingsRepository {
  private current: Settings = { ...DEFAULT_SETTINGS };

  get(): Settings {
    return { ...this.current };
  }

  set(patch: SettingsPatch): Settings {
    this.current = applySettingsPatch(this.current, patch);
    return this.get();
  }
}

export class SqliteSettingsRepository implements SettingsRepository {
  private readonly selectAll: StatementSync;
  private readonly upsert: StatementSync;
  private readonly remove: StatementSync;

  /** `onInvalid` receives the reason when a stored value cannot be used; defaults to stderr. */
  constructor(
    private readonly db: DatabaseSync,
    private readonly onInvalid: (message: string) => void = (message) =>
      void process.stderr.write(`termdock-core: ${message}\n`),
  ) {
    this.selectAll = db.prepare("SELECT key, value FROM settings");
    this.upsert = db.prepare(
      "INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
    this.remove = db.prepare("DELETE FROM settings WHERE key = :key");
  }

  get(): Settings {
    // An old, damaged or hand-edited row must not block every settings.get: report it and use the default.
    let settings: Settings = { ...DEFAULT_SETTINGS };
    const rows = new Map(this.selectAll.all().map((row) => [String(row.key), row.value]));
    for (const key of KEYS) {
      const data = rows.get(key);
      if (data === undefined) continue;
      try {
        if (typeof data !== "string") throw new Error("expected text");
        const next = validateSettings({ ...settings, [key]: JSON.parse(data) as unknown });
        if (!next.ok) throw new Error(next.error.message);
        settings = next.value;
      } catch (error) {
        this.onInvalid(
          `stored setting ${key} is not usable: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
    return settings;
  }

  set(patch: SettingsPatch): Settings {
    // Read, check and write under one write lock, so a second connection cannot slip in between.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const merged = applySettingsPatch(this.get(), patch);
      for (const key of KEYS) {
        const value = patch[key];
        if (value === undefined) continue;
        if (value === null) this.remove.run({ key });
        else this.upsert.run({ key, value: JSON.stringify(value) });
      }
      this.db.exec("COMMIT");
      return merged;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
