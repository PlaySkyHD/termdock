// Stored launch profiles (ADR 0004, table `launch_profiles`).
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { validateLaunchProfile } from "@termdock/protocol";
import type { BackendKind, LaunchProfile, LaunchSpec, WindowsShell } from "@termdock/protocol";

export interface ProfileRepository {
  /** All profiles in the order they were created. */
  list(): LaunchProfile[];
  /** Inserts the profile or replaces the stored one with the same id. The caller has validated it. */
  save(profile: LaunchProfile): void;
  /** Removes the profile; false when it did not exist. */
  delete(profileId: string): boolean;
}

/** Repository without a file, for tests and a Core without storage. */
export class InMemoryProfileRepository implements ProfileRepository {
  // A Map keeps the insertion order when a key is set again.
  private readonly profiles = new Map<string, LaunchProfile>();

  list(): LaunchProfile[] {
    return [...this.profiles.values()].map((profile) => structuredClone(profile));
  }

  save(profile: LaunchProfile): void {
    this.profiles.set(profile.id, structuredClone(profile));
  }

  delete(profileId: string): boolean {
    return this.profiles.delete(profileId);
  }
}

export class SqliteProfileRepository implements ProfileRepository {
  private readonly selectAll: StatementSync;
  private readonly upsert: StatementSync;
  private readonly remove: StatementSync;

  /** `onInvalid` receives the reason when a stored row cannot be used; defaults to stderr. */
  constructor(
    db: DatabaseSync,
    private readonly onInvalid: (message: string) => void = (message) =>
      void process.stderr.write(`termdock-core: ${message}\n`),
  ) {
    // rowid keeps the creation order; an upsert does not change it.
    this.selectAll = db.prepare("SELECT * FROM launch_profiles ORDER BY rowid");
    this.upsert = db.prepare(`
      INSERT INTO launch_profiles (
        id, name, workspace_id, project_id, backend, distro, shell, cwd, command, env,
        autostart, logging_enabled, created_at, updated_at
      ) VALUES (
        :id, :name, :workspace_id, :project_id, :backend, :distro, :shell, :cwd, :command, :env,
        :autostart, :logging_enabled, :now, :now
      )
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name, workspace_id = excluded.workspace_id, project_id = excluded.project_id,
        backend = excluded.backend, distro = excluded.distro, shell = excluded.shell, cwd = excluded.cwd,
        command = excluded.command, env = excluded.env, autostart = excluded.autostart,
        logging_enabled = excluded.logging_enabled, updated_at = excluded.updated_at
    `);
    this.remove = db.prepare("DELETE FROM launch_profiles WHERE id = :id");
  }

  /** A row that cannot be read or fails validation is skipped and reported: it must not block every `profile.*`. */
  list(): LaunchProfile[] {
    const profiles: LaunchProfile[] = [];
    for (const row of this.selectAll.all()) {
      try {
        const profile = profileFromRow(row);
        const checked = validateLaunchProfile(profile);
        if (!checked.ok) throw new Error(checked.error.message);
        profiles.push(profile);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown";
        this.onInvalid(`stored profile ${String(row.id).slice(0, 64)} is not usable: ${reason}`);
      }
    }
    return profiles;
  }

  save(profile: LaunchProfile): void {
    const { launch } = profile;
    this.upsert.run({
      id: profile.id,
      name: profile.name,
      workspace_id: profile.workspaceId ?? null,
      project_id: profile.projectId ?? null,
      backend: launch.backend,
      distro: launch.distro ?? null,
      shell: launch.shell ?? null,
      cwd: launch.cwd,
      command: launch.command === undefined ? null : JSON.stringify(launch.command),
      env: launch.env === undefined ? null : JSON.stringify(launch.env),
      autostart: profile.autostart ? 1 : 0,
      logging_enabled: profile.loggingEnabled ? 1 : 0,
      now: new Date().toISOString(),
    });
  }

  delete(profileId: string): boolean {
    return Number(this.remove.run({ id: profileId }).changes) > 0;
  }
}

function optionalText(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function profileFromRow(row: Record<string, unknown>): LaunchProfile {
  const launch: LaunchSpec = { backend: String(row.backend) as BackendKind, cwd: String(row.cwd) };
  const distro = optionalText(row, "distro");
  if (distro !== undefined) launch.distro = distro;
  const shell = optionalText(row, "shell");
  if (shell !== undefined) launch.shell = shell as WindowsShell;
  const command = optionalText(row, "command");
  if (command !== undefined) launch.command = JSON.parse(command) as string[];
  const env = optionalText(row, "env");
  if (env !== undefined) launch.env = JSON.parse(env) as Record<string, string>;
  const profile: LaunchProfile = {
    id: String(row.id),
    name: String(row.name),
    launch,
    autostart: Number(row.autostart) === 1,
    loggingEnabled: Number(row.logging_enabled) === 1,
  };
  const workspaceId = optionalText(row, "workspace_id");
  if (workspaceId !== undefined) profile.workspaceId = workspaceId;
  const projectId = optionalText(row, "project_id");
  if (projectId !== undefined) profile.projectId = projectId;
  return profile;
}
