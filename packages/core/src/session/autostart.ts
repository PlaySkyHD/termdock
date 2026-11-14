// Autostart of launch profiles (issue #61, spec launch-profiles, ADR 0005): once per Core start, after the
// reconcile, only from the Core. No client request reaches this module.
import type { BackendKind, LaunchProfile, SessionInfo, SessionState, Settings } from "@termdock/protocol";
import type { Backend } from "../backend/types.js";
import type { ProfileService } from "../workspace/profile-service.js";
import type { SessionRegistry } from "./registry.js";

/** States in which a session of a profile counts as its running instance. */
const LIVE_STATES: ReadonlySet<SessionState> = new Set(["Starting", "Running", "Detached"]);

export interface AutostartOptions {
  /** Already restored: the autostart sees the reconciled states. */
  registry: SessionRegistry;
  profiles: ProfileService;
  /** The stored settings, read once; `defaultCwd` takes part in the directory of a profile with `cwd: "~"`. */
  settings: () => Pick<Settings, "defaultCwd">;
  backends: readonly Backend[];
  /** Backends the reconcile found unreachable and reported; they are neither asked nor reported again. */
  knownUnavailable?: readonly BackendKind[];
  /** Checked after the backend checks; when true (the Core is closing) nothing is created. */
  cancelled?: () => boolean;
  /** One line per problem, without command or environment of a profile. */
  report: (text: string) => void;
}

export interface AutostartResult {
  /** Sessions the autostart registered, in profile order and as registered (`Starting`). */
  sessions: SessionInfo[];
  /** Backends of autostart profiles that were missing or unreachable; their profiles got no session. */
  backendUnavailable: BackendKind[];
  /** Settles when every start has ended (`Running`/`Detached` or `Interrupted`). Never rejects. */
  started: Promise<void>;
}

/**
 * Creates one session for every profile with `autostart` that has no session in `Starting`, `Running` or
 * `Detached`, like `session.create { name, profileId }`. Resolves once the sessions are registered, before they
 * have started, so the Core can let requests through with the sessions already listed. Never rejects and never
 * retries: an unreachable backend and a failed start are reported once.
 */
export async function runAutostart(options: AutostartOptions): Promise<AutostartResult> {
  const { registry, report } = options;
  const result: AutostartResult = { sessions: [], backendUnavailable: [], started: Promise.resolve() };
  let due: LaunchProfile[];
  try {
    const live = new Set(
      registry
        .list()
        .filter((session) => session.profileId !== undefined && LIVE_STATES.has(session.state))
        .map((session) => session.profileId),
    );
    due = options.profiles.list().filter((profile) => profile.autostart && !live.has(profile.id));
  } catch (error) {
    report(`autostart: could not read the launch profiles: ${messageOf(error)}`);
    return result;
  }
  if (due.length === 0) return result;

  const unavailable = await unreachableBackends(due, options);
  if (options.cancelled?.()) return result;
  const known = new Set(options.knownUnavailable ?? []);
  for (const [kind, count] of unavailable) {
    result.backendUnavailable.push(kind);
    // The reconcile has already reported it on stderr and in `core.status`: once per Core start.
    if (known.has(kind)) continue;
    registry.reportBackendUnavailable(kind);
    report(
      `autostart: backend_unavailable: ${kind} could not be reached, ${count} autostart profile(s) not started`,
    );
  }

  let settings: Pick<Settings, "defaultCwd">;
  try {
    settings = options.settings();
  } catch (error) {
    report(`autostart: could not read the settings: ${messageOf(error)}`);
    return result;
  }
  const starts: Promise<void>[] = [];
  const created = registry.onCreated(({ session }) => result.sessions.push(session));
  try {
    for (const profile of due) {
      if (unavailable.has(profile.launch.backend)) continue;
      starts.push(start(profile, settings, options));
    }
  } finally {
    // `create` registers synchronously before its first await, so every session is in the list by now.
    created.dispose();
  }
  result.started = Promise.all(starts).then(() => {});
  return result;
}

/** Same input as `session.create { name, profileId }` (`ProfileService.sessionInput`); reports a failure once. */
function start(
  profile: LaunchProfile,
  settings: Pick<Settings, "defaultCwd">,
  options: AutostartOptions,
): Promise<void> {
  try {
    const input = options.profiles.sessionInput(profile.id, { name: profile.name }, settings);
    return options.registry.create(input).then(
      () => {},
      (error: unknown) => {
        // Closing the Core stops a start on purpose; the session stays for the next reconcile.
        if (options.cancelled?.()) return;
        options.report(`autostart of profile ${profile.id} failed: ${messageOf(error)}`);
      },
    );
  } catch (error) {
    options.report(`autostart of profile ${profile.id} failed: ${messageOf(error)}`);
    return Promise.resolve();
  }
}

/** Kinds of the due profiles whose backend is missing or unreachable, with the number of profiles each. */
async function unreachableBackends(
  due: readonly LaunchProfile[],
  options: AutostartOptions,
): Promise<Map<BackendKind, number>> {
  const counts = new Map<BackendKind, number>();
  for (const profile of due)
    counts.set(profile.launch.backend, (counts.get(profile.launch.backend) ?? 0) + 1);
  const known = new Set(options.knownUnavailable ?? []);
  const unavailable = new Map<BackendKind, number>();
  // One check per backend, one after another, so a slow WSL is not hit with parallel wsl.exe calls.
  for (const [kind, count] of counts) {
    const backend = options.backends.find((candidate) => candidate.kind === kind);
    const reachable =
      backend !== undefined && !known.has(kind) && (await backend.available().catch(() => false));
    if (!reachable) unavailable.set(kind, count);
  }
  return unavailable;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
