// What the sidebar, tabs and status bar say about sessions (ADR 0005, ADR 0006). Pure, no DOM.
import type {
  BackendKind,
  CoreStatusResult,
  LaunchSpec,
  SessionInfo,
  SessionState,
} from "@termdock/protocol";

export const NO_GROUP_LABEL = "Ohne Gruppe";

export interface SessionGroup {
  /** The workspace id; empty for the group without workspace. */
  key: string;
  label: string;
  sessions: SessionInfo[];
}

/**
 * Sessions per workspace, headed by the workspace id (names come with workspaces in phase 3), sorted by id, and
 * always followed by the group without workspace. Archived sessions are not shown.
 */
export function groupSessions(sessions: readonly SessionInfo[]): SessionGroup[] {
  const byWorkspace = new Map<string, SessionInfo[]>();
  const ungrouped: SessionInfo[] = [];
  for (const session of sessions) {
    if (session.state === "Archived") continue;
    if (session.workspaceId === undefined) ungrouped.push(session);
    else byWorkspace.set(session.workspaceId, [...(byWorkspace.get(session.workspaceId) ?? []), session]);
  }
  const groups = [...byWorkspace]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => ({ key, label: key, sessions: list }));
  return [...groups, { key: "", label: NO_GROUP_LABEL, sessions: ungrouped }];
}

/** Only `Running` is shown as running; `Detached` lives without a view, `Exited` and `Interrupted` do not live. */
export function isRunning(state: SessionState): boolean {
  return state === "Running";
}

/** A view can attach to the session (the process lives). */
export function isAttachable(state: SessionState): boolean {
  return state === "Running" || state === "Detached";
}

/** Text of a tab whose session cannot be attached; undefined when it can. */
export function endedNotice(session: SessionInfo): { title: string; detail: string } | undefined {
  switch (session.state) {
    case "Starting":
      return { title: "Startet", detail: "Die Session wird gestartet." };
    case "Exited":
      return {
        title: "Beendet",
        detail:
          session.lastExitCode === undefined
            ? "Der Prozess ist beendet."
            : `Der Prozess ist mit Exit-Code ${session.lastExitCode} beendet.`,
      };
    case "Interrupted":
      return {
        title: "Unterbrochen",
        detail: "Der Prozess der Session ist verloren gegangen, etwa weil WSL oder tmux beendet wurde.",
      };
    case "Archived":
      return { title: "Archiviert", detail: "Die Session ist archiviert." };
    case "Running":
    case "Detached":
      return undefined;
  }
}

const BACKEND_NAMES: Record<BackendKind, string> = { wsl: "WSL", windows: "Windows" };

export function backendName(backend: BackendKind): string {
  return BACKEND_NAMES[backend];
}

/** Backend and distro (or shell) for the status bar. */
export function backendText(launch: LaunchSpec): string {
  const name = backendName(launch.backend);
  if (launch.backend === "wsl") return `${name} · ${launch.distro ?? "Standard-Distro"}`;
  return launch.shell === undefined ? name : `${name} · ${launch.shell}`;
}

/** Notes of the status bar about the core: the lost connection and backends it could not reach. */
export function coreHints(status: CoreStatusResult | undefined, closed: boolean): string[] {
  return [
    ...(closed ? ["Verbindung zum Core getrennt"] : []),
    ...(status?.backendUnavailable ?? []).map((backend) => `${backendName(backend)} nicht erreichbar`),
  ];
}

/** State for sidebar and status bar: the protocol's name, for an exited session with its exit code. */
export function stateText(session: SessionInfo): string {
  return session.state === "Exited" && session.lastExitCode !== undefined
    ? `Exited (Code ${session.lastExitCode})`
    : session.state;
}
