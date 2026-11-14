// Autostart of launch profiles (issue #61, spec launch-profiles, ADR 0005): once per Core start, after the
// reconcile, only from the Core. No client request reaches this module.
import type { BackendKind, LaunchProfile, SessionInfo, SessionState, Settings } from "@termdock/protocol";
import type { Backend } from "../backend/types.js";
import type { ProfileService } from "../workspace/profile-service.js";
import type { SessionRegistry } from "./registry.js";

/** States in which a session of a profile counts as its running instance. */
const LIVE_STATES: ReadonlySet<SessionState> = new Set(["Starting", "Running", "Detached"]);
/** States of a session the autostart starts again instead of creating a new one. */
const RESTARTABLE_STATES: ReadonlySet<SessionState> = new Set(["Exited", "Interrupted"]);
/** Length limit of an error message in a report line. */
const MAX_REPORTED_MESSAGE = 200;

export interface AutostartOptions {
  /** Already restored: the autostart sees the reconciled states. */
  registry: SessionRegistry;
  profiles: ProfileService;
  /** The stored settings, read once; `defaultCwd` takes part in the directory of a profile with `cwd: "~"`. */
  settings: () => Pick<Settings, "defaultCwd">;
  backends: readonly Backend[];
  /** Backends the reconcile found unreachable and reported; they are neither asked nor reported again. */
  knownUnavailable?: readonly BackendKind[];
  /** Backends the reconcile reached; they are not asked again. */
  knownAvailable?: readonly BackendKind[];
  /** Checked after the backend checks; when true (the Core is closing) nothing is created or restarted. */
  cancelled?: () => boolean;
  /** One line per problem, without command or environment of a profile. */
  report: (text: string) => void;
}

export interface AutostartResult {
  /** Sessions the autostart created, in profile order and as registered (`Starting`). */
  sessions: SessionInfo[];
  /** `Exited` or `Interrupted` sessions the autostart started again under their id, as `Starting`. */
  restarted: SessionInfo[];
  /** Backends of autostart profiles that were missing or unreachable; their profiles got no start. */
  backendUnavailable: BackendKind[];
  /** Settles when every start has ended (`Running`/`Detached` or `Interrupted`). Never rejects. */
  started: Promise<void>;
}

/** What the autostart does for one profile without a live session. */
interface Plan {
  profile: LaunchProfile;
  /** The newest `Exited` or `Interrupted` session of the profile; started again instead of a new one. */
  restart: SessionInfo | undefined;
  backend: BackendKind;
}

/**
 * For every profile with `autostart` that has no session in `Starting`, `Running` or `Detached`: starts its newest
 * `Exited` or `Interrupted` session again (same id, history goes on), or else creates one like
 * `session.create { name, profileId }`. Resolves once every session is `Starting`, before it has started, so the
 * Core can let requests through with the sessions already listed. Never rejects and never retries: an
 * unreachable backend and a failed start are reported once.
 */
export async function runAutostart(options: AutostartOptions): Promise<AutostartResult> {
  const { registry, report } = options;
  const result: AutostartResult = {
    sessions: [],
    restarted: [],
    backendUnavailable: [],
    started: Promise.resolve(),
  };
  let plans: Plan[];
  try {
    plans = planFor(registry.list(), options.profiles.list());
  } catch (error) {
    report(`autostart: could not read the launch profiles: ${messageOf(error)}`);
    return result;
  }
  if (plans.length === 0) return result;

  const unavailable = await unreachableBackends(plans, options);
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
    for (const plan of plans) {
      if (unavailable.has(plan.backend)) continue;
      starts.push(start(plan, settings, options, result));
    }
  } finally {
    // `create` registers and `restart` sets `Starting` synchronously before their first await.
    created.dispose();
  }
  result.started = Promise.all(starts).then(() => {});
  return result;
}

function planFor(sessions: readonly SessionInfo[], profiles: readonly LaunchProfile[]): Plan[] {
  const plans: Plan[] = [];
  for (const profile of profiles) {
    if (!profile.autostart) continue;
    const own = sessions.filter((session) => session.profileId === profile.id);
    if (own.some((session) => LIVE_STATES.has(session.state))) continue;
    const restart = own
      .filter((session) => RESTARTABLE_STATES.has(session.state))
      .reduce<SessionInfo | undefined>(
        (newest, session) => (newer(session, newest) ? session : newest),
        undefined,
      );
    plans.push({ profile, restart, backend: restart?.launch.backend ?? profile.launch.backend });
  }
  return plans;
}

/** Whether `a` changed after `b` (`updatedAt`, then `createdAt`; ISO strings compare in time order). */
function newer(a: SessionInfo, b: SessionInfo | undefined): boolean {
  if (b === undefined) return true;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return a.createdAt > b.createdAt;
}

/**
 * Restarts the planned session, or creates one with the same input as `session.create { name, profileId }`
 * (`ProfileService.sessionInput`); reports a failure once.
 */
function start(
  plan: Plan,
  settings: Pick<Settings, "defaultCwd">,
  options: AutostartOptions,
  result: AutostartResult,
): Promise<void> {
  const { profile, restart } = plan;
  const failed = (error: unknown): void => {
    // Closing the Core stops a start on purpose; the session stays for the next reconcile.
    if (options.cancelled?.()) return;
    options.report(`autostart of profile ${profile.id} failed: ${failureOf(error)}`);
  };
  try {
    let running: Promise<SessionInfo>;
    if (restart) {
      running = options.registry.restart(restart.id);
      result.restarted.push(options.registry.get(restart.id));
    } else {
      running = options.registry.create(
        options.profiles.sessionInput(profile.id, { name: profile.name }, settings),
      );
    }
    return running.then(() => {}, failed);
  } catch (error) {
    failed(error);
    return Promise.resolve();
  }
}

/** Kinds of the planned starts whose backend is missing or unreachable, with the number of profiles each. */
async function unreachableBackends(
  plans: readonly Plan[],
  options: AutostartOptions,
): Promise<Map<BackendKind, number>> {
  const counts = new Map<BackendKind, number>();
  for (const plan of plans) counts.set(plan.backend, (counts.get(plan.backend) ?? 0) + 1);
  const knownDown = new Set(options.knownUnavailable ?? []);
  const knownUp = new Set(options.knownAvailable ?? []);
  const unavailable = new Map<BackendKind, number>();
  // One check per backend, one after another, so a slow WSL is not hit with parallel wsl.exe calls.
  for (const [kind, count] of counts) {
    const backend = options.backends.find((candidate) => candidate.kind === kind);
    let reachable = false;
    if (backend !== undefined && !knownDown.has(kind)) {
      reachable = knownUp.has(kind) || (await backend.available().catch(() => false));
    }
    if (!reachable) unavailable.set(kind, count);
  }
  return unavailable;
}

/** Message of a failed start with the message of its cause (the backend's reason), first line, bounded. */
function failureOf(error: unknown): string {
  let text = messageOf(error);
  if (error instanceof Error && error.cause instanceof Error) text += `: ${error.cause.message}`;
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.length > MAX_REPORTED_MESSAGE ? `${line.slice(0, MAX_REPORTED_MESSAGE)}...` : line;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
