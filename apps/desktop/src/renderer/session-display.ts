// What the sidebar, tabs and status bar say about sessions (ADR 0005, ADR 0006). Pure, no DOM.
import type {
  BackendKind,
  CoreStatusResult,
  LaunchSpec,
  SessionInfo,
  SessionState,
} from "@termdock/protocol";

export const NO_GROUP_LABEL = "Ohne Gruppe";

/** Only `Running` is shown as running; `Detached` lives without a view, `Exited` and `Interrupted` do not live. */
export function isRunning(state: SessionState): boolean {
  return state === "Running";
}

/** A view can attach to the session (the process lives). */
export function isAttachable(state: SessionState): boolean {
  return state === "Running" || state === "Detached";
}

/**
 * `session.restart` takes the session (#156): its process ended or was lost. The core refuses every other state
 * with `invalid_state` (ADR 0005); the pane's button and the sidebar's menu entry share this rule.
 */
export function canRestart(state: SessionState): boolean {
  return state === "Exited" || state === "Interrupted";
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
        detail:
          session.launch.backend === "windows"
            ? "Die Windows-Shell ist mit dem Core beendet worden, etwa bei einem Neustart des Core oder von Windows. Windows-Shells laufen nur, solange der TermDock-Core läuft."
            : "Der Prozess der Session ist verloren gegangen, etwa weil WSL oder tmux beendet wurde.",
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

/**
 * Whether the snapshot of the session is the raw output the core kept (ADR 0003): Windows shells have no screen of
 * their own (#65). Its line breaks at the end place the cursor and must stay; a tmux snapshot lists blank rows.
 */
export function rawSnapshot(launch: Pick<LaunchSpec, "backend">): boolean {
  return launch.backend === "windows";
}

/** The persistence limit of Windows shells (ADR 0001, #65), as the status bar and the tooltips say it. */
export const WINDOWS_PERSISTENCE_TEXT = "Läuft nur, solange der TermDock-Core läuft";

/**
 * What a session or project says about how long its process lives (#65): Windows shells run in the core and end
 * with it (core restart, Windows restart), WSL sessions live on in tmux and say nothing. `label` is the short badge
 * of the sidebar, `title` its tooltip, `note` the hint of the status bar.
 */
export function persistenceLimit(
  launch: Pick<LaunchSpec, "backend" | "shell">,
): { label: string; title: string; note: string } | undefined {
  if (launch.backend !== "windows") return undefined;
  const shell = launch.shell === undefined ? "Windows-Shell" : `Windows-Shell (${launch.shell})`;
  return {
    label: "Win",
    title: `${shell} · ${WINDOWS_PERSISTENCE_TEXT}; ein Neustart des Core oder von Windows unterbricht sie.`,
    note: WINDOWS_PERSISTENCE_TEXT,
  };
}

/** What a pane and the status bar say while the core connection is gone (#130). */
export const CORE_RESTARTING_TEXT = "Core startet neu …";
export const CORE_CLOSED_TEXT = "Verbindung zum Core getrennt";

/**
 * Notes of the status bar about the core: the lost connection (or its restart, #130) and backends it could not
 * reach.
 */
export function coreHints(
  status: CoreStatusResult | undefined,
  closed: boolean,
  restarting = false,
): string[] {
  return [
    ...(closed ? [restarting ? CORE_RESTARTING_TEXT : CORE_CLOSED_TEXT] : []),
    ...(status?.backendUnavailable ?? []).map((backend) => `${backendName(backend)} nicht erreichbar`),
  ];
}

/** State for sidebar and status bar: the protocol's name, for an exited session with its exit code. */
export function stateText(session: SessionInfo): string {
  return session.state === "Exited" && session.lastExitCode !== undefined
    ? `Exited (Code ${session.lastExitCode})`
    : session.state;
}

/** One warning as the pane shows it: `before`, the (shortened) `path`, `after`; `text` is the whole sentence. */
export interface WarningText {
  text: string;
  before: string;
  path: string;
  after: string;
}

/**
 * Texts of the warnings of a session's run that the window has not dismissed (#113), one per known code; codes of a
 * newer core are left out. `cwd_missing`: wsl.exe cannot change into the directory and starts the shell in `/`; the
 * Windows backend starts the shell in the user folder instead (#65).
 */
export function warningTexts(session: SessionInfo | undefined, dismissed: readonly string[]): WarningText[] {
  if (!session?.warnings || dismissed.includes(session.id) || !isAttachable(session.state)) return [];
  const texts: WarningText[] = [];
  for (const warning of session.warnings) {
    if (warning.code !== "cwd_missing" || warning.path === undefined) continue;
    const before = "Verzeichnis ";
    let after: string;
    if (session.launch.backend === "windows") {
      after = " fehlt – die Session läuft im Benutzerordner.";
    } else {
      const distro = warning.distro ?? session.launch.distro ?? "der WSL-Distribution";
      after = ` fehlt in ${distro} – die Session läuft im Wurzelverzeichnis /.`;
    }
    texts.push({ text: `${before}${warning.path}${after}`, before, path: warning.path, after });
  }
  return texts;
}
