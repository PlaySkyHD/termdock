// Rules for launch profiles (spec launch-profiles): merge a change into the stored profile, check its binding to
// workspace and project, validate the whole result, then store it. The server sends the events; this class only
// changes the repository and resolves a profile into the launch spec of a new session.
import { randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS, MAX_PROFILES, validateLaunchProfile } from "@termdock/protocol";
import type {
  LaunchProfile,
  LaunchSpec,
  Project,
  ProfileCreateParams,
  ProfileUpdateParams,
  Settings,
  Workspace,
} from "@termdock/protocol";
import { CoreError } from "../session/errors.js";
import type { ProfileRepository } from "../storage/profile-repository.js";
import { defaultCwd } from "./default-cwd.js";
import type { WorkspaceService } from "./service.js";

/** `launch.cwd` of a profile that names no directory of its own: the session takes `defaultCwd(...)`. */
export const PROFILE_DEFAULT_CWD = "~";

/** Names of `launch.env` variables that obviously hold a secret; a profile does not store them in plain text. */
const SECRET_ENV_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)$/i;

/** What a new session takes from its profile. */
export interface ProfileLaunch {
  launch: LaunchSpec;
  loggingEnabled: boolean;
  /** Workspace of the profile, the default of a session that names none. */
  workspaceId?: string;
}

export class ProfileService {
  constructor(
    private readonly repository: ProfileRepository,
    private readonly workspaces: WorkspaceService,
  ) {}

  list(): LaunchProfile[] {
    const known = this.workspaces.list();
    return this.repository.list().map((profile) => withoutStaleBinding(profile, known));
  }

  create(params: ProfileCreateParams): LaunchProfile {
    if (this.repository.list().length >= MAX_PROFILES) {
      throw new CoreError("invalid_state", `At most ${MAX_PROFILES} profiles are allowed`);
    }
    const profile: LaunchProfile = {
      id: randomUUID(),
      name: params.name,
      launch: params.launch,
      autostart: params.autostart ?? false,
      loggingEnabled: params.loggingEnabled ?? DEFAULT_SETTINGS.historyEnabledByDefault,
    };
    if (params.workspaceId !== undefined) profile.workspaceId = params.workspaceId;
    if (params.projectId !== undefined) profile.projectId = params.projectId;
    return this.store(profile, false);
  }

  update(params: ProfileUpdateParams): LaunchProfile {
    const merged = this.get(params.profileId);
    if (params.name !== undefined) merged.name = params.name;
    if (params.launch !== undefined) merged.launch = params.launch;
    if (params.autostart !== undefined) merged.autostart = params.autostart;
    if (params.loggingEnabled !== undefined) merged.loggingEnabled = params.loggingEnabled;
    if (params.workspaceId === null) delete merged.workspaceId;
    else if (params.workspaceId !== undefined) merged.workspaceId = params.workspaceId;
    if (params.projectId === null) delete merged.projectId;
    else if (params.projectId !== undefined) {
      merged.projectId = params.projectId;
      // A new project without a workspace in the same request takes the workspace of that project, as on create.
      if (params.workspaceId === undefined) delete merged.workspaceId;
    }
    return this.store(merged, params.workspaceId === null);
  }

  delete(profileId: string): void {
    if (!this.repository.delete(profileId)) throw notFound("profile", profileId);
  }

  /** Throws `not_found` for an unknown profile. */
  get(profileId: string): LaunchProfile {
    const found = this.list().find((profile) => profile.id === profileId);
    if (!found) throw notFound("profile", profileId);
    return found;
  }

  /**
   * Launch spec and logging switch of a new session from the profile. An explicit `launch` replaces the spec of
   * the profile as a whole. Without one, a profile `cwd` of `~` becomes `defaultCwd(...)` (project of the profile,
   * its workspace, `settings`, then `~`).
   */
  launchFor(
    profileId: string,
    explicitLaunch: LaunchSpec | undefined,
    settings: Pick<Settings, "defaultCwd">,
  ): ProfileLaunch {
    const profile = this.get(profileId);
    let launch = explicitLaunch;
    if (launch === undefined) {
      launch = profile.launch;
      if (launch.cwd === PROFILE_DEFAULT_CWD) {
        const workspace = this.workspaces.list().find((candidate) => candidate.id === profile.workspaceId);
        const project = workspace?.projects.find((candidate) => candidate.id === profile.projectId);
        const input: Parameters<typeof defaultCwd>[0] = { backend: launch.backend, settings };
        if (project !== undefined) input.project = project;
        if (workspace !== undefined) input.workspace = workspace;
        launch = { ...launch, cwd: defaultCwd(input) };
      }
    }
    const result: ProfileLaunch = { launch, loggingEnabled: profile.loggingEnabled };
    if (profile.workspaceId !== undefined) result.workspaceId = profile.workspaceId;
    return result;
  }

  /**
   * Checks that the workspace and project exist and belong together (spec session-persistence), validates the
   * whole profile so no client receives a list it has to reject, and saves it.
   */
  private store(profile: LaunchProfile, workspaceRemoved: boolean): LaunchProfile {
    const known = this.workspaces.list();
    if (
      profile.workspaceId !== undefined &&
      !known.some((workspace) => workspace.id === profile.workspaceId)
    ) {
      throw notFound("workspace", profile.workspaceId);
    }
    if (profile.projectId !== undefined) {
      const owner = known.find((workspace) => workspace.projects.some((p) => p.id === profile.projectId));
      if (!owner) throw notFound("project", profile.projectId);
      if (profile.workspaceId === undefined) {
        if (workspaceRemoved) {
          throw new CoreError("bad_request", "A profile with a project needs the workspace of that project");
        }
        profile.workspaceId = owner.id;
      } else if (profile.workspaceId !== owner.id) {
        throw new CoreError("bad_request", "The project of a profile must belong to its workspace");
      }
    }
    const checked = validateLaunchProfile(profile);
    if (!checked.ok) throw new CoreError("bad_request", checked.error.message);
    for (const key of Object.keys(profile.launch.env ?? {})) {
      if (SECRET_ENV_KEY.test(key)) {
        // The key only, never the value (security.instructions.md).
        throw new CoreError(
          "bad_request",
          `launch.env key "${key.slice(0, 64)}" looks like a secret; credentials come from the CLI login or a protected environment variable, not from a profile`,
        );
      }
    }
    this.repository.save(profile);
    return profile;
  }
}

/**
 * The database unbinds a profile when its workspace or project is deleted (`ON DELETE SET NULL`); a repository
 * without foreign keys does not. Reading through the known workspaces gives both the same answer.
 */
function withoutStaleBinding(profile: LaunchProfile, known: Workspace[]): LaunchProfile {
  const workspace = known.find((candidate) => candidate.id === profile.workspaceId);
  const project: Project | undefined = workspace?.projects.find(
    (candidate) => candidate.id === profile.projectId,
  );
  const result = { ...profile };
  if (workspace === undefined) delete result.workspaceId;
  if (project === undefined) delete result.projectId;
  return result;
}

function notFound(kind: "profile" | "workspace" | "project", id: string): CoreError {
  return new CoreError("not_found", `Unknown ${kind} ${id.length > 64 ? `${id.slice(0, 64)}...` : id}`);
}
