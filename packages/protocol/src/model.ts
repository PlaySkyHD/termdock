// Shared domain types for Core and Desktop (ADR 0002, ADR 0005).
// Changes here are shared building blocks: only the orchestrator or an explicitly briefed agent edits this file.

export type SessionId = string;
export type ViewId = string;
export type ClientId = string;
export type WorkspaceId = string;
export type ProjectId = string;
export type LaunchProfileId = string;

/** Session states from concept chapter 6. Allowed transitions live in packages/core/src/session/lifecycle.ts. */
export const SESSION_STATES = [
  "Starting",
  "Running",
  "Detached",
  "Exited",
  "Interrupted",
  "Archived",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export type BackendKind = "wsl" | "windows";

export type WindowsShell = "pwsh" | "powershell" | "cmd";

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** What is needed to start the process of a session. */
export interface LaunchSpec {
  backend: BackendKind;
  /** WSL distribution name; only for backend "wsl". Undefined means the configured default. */
  distro?: string;
  /** Windows shell; only for backend "windows". */
  shell?: WindowsShell;
  /** Working directory: a Linux path for "wsl", a Windows path for "windows". */
  cwd: string;
  /** Command line to run instead of the login shell, as an argument array. Undefined means interactive shell. */
  command?: readonly string[];
  /** Extra environment variables. Never store secrets here (security.instructions.md). */
  env?: Readonly<Record<string, string>>;
}

export interface SessionInfo {
  id: SessionId;
  name: string;
  state: SessionState;
  launch: LaunchSpec;
  workspaceId?: WorkspaceId;
  profileId?: LaunchProfileId;
  /** View that may send input and resize; undefined when no view is attached or the writer detached. */
  writerViewId?: ViewId;
  size: TerminalSize;
  loggingEnabled: boolean;
  lastExitCode?: number;
  createdAt: string;
  updatedAt: string;
}

// --- Layout (ADR 0004, table `layouts`) -------------------------------------------------------

/** Value of `LayoutDocument.version`. */
export const LAYOUT_VERSION = 1 as const;
/** A tab shows at most this many panes. */
export const MAX_PANES_PER_TAB = 4;
/** Limits that keep a stored document, and the `layout.get` answer around it, below the 1 MiB header limit. */
export const MAX_LAYOUT_WINDOWS = 16;
/** Ids and session ids in a layout. */
export const MAX_LAYOUT_ID_LENGTH = 64;
/** UTF-8 size of `JSON.stringify(layout)`. */
export const MAX_LAYOUT_BYTES = 256 * 1024;
export const MAX_TABS_PER_WINDOW = 64;
export const MAX_TAB_TITLE_LENGTH = 128;

/** Window position and size in screen pixels. */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Leaf of a pane tree. `sessionId` may name a session that no longer exists; the app then shows a placeholder. */
export interface LayoutPane {
  kind: "pane";
  id: string;
  sessionId: SessionId;
}

/** Divides its area among `children` along `direction`; `sizes[i]` is the share of `children[i]` and they sum to about 1. */
export interface LayoutSplit {
  kind: "split";
  id: string;
  direction: "row" | "column";
  /** At least 2. */
  children: PaneNode[];
  sizes: number[];
}

export type PaneNode = LayoutPane | LayoutSplit;

export interface LayoutTab {
  id: string;
  title?: string;
  root: PaneNode;
  /** Id of a `LayoutPane` in `root`. */
  activePaneId: string;
}

export interface LayoutWindow {
  id: string;
  bounds?: WindowBounds;
  maximized?: boolean;
  sidebarVisible?: boolean;
  sidebarWidth?: number;
  /** 0 to 64 tabs. A window without tabs shows only the sidebar and the empty state. */
  tabs: LayoutTab[];
  /** Id of a tab in `tabs`. Required when there are tabs, omitted when there are none. */
  activeTabId?: string;
}

/** The one global layout of all windows. Ids are unique in the whole document; a tab has at most 4 panes. */
export interface LayoutDocument {
  version: typeof LAYOUT_VERSION;
  windows: LayoutWindow[];
}

// --- Phase 3: workspaces, projects, profiles, settings, history (ADR 0002, ADR 0004) -------------

/** Names of workspaces, projects, profiles and (in `session.update`) sessions; never empty or only spaces. */
export const MAX_NAME_LENGTH = 128;
/** Project paths and default directories; never empty, no NUL character. */
export const MAX_PATH_LENGTH = 512;
/** Keep `workspace.changed` (all workspaces with their projects) below the 1 MiB header limit. */
export const MAX_WORKSPACES = 64;
export const MAX_PROJECTS_PER_WORKSPACE = 16;
/**
 * UTF-8 size of `JSON.stringify(workspace)` with its projects. Field limits alone allow far more (JSON escapes
 * take up to 6 bytes per character); 64 × 12 KiB = 768 KiB leaves room for the frame around the list.
 */
export const MAX_WORKSPACE_BYTES = 12 * 1024;
/** Keep `profile.changed` (all profiles) below the 1 MiB header limit. */
export const MAX_PROFILES = 64;
/** UTF-8 size of `JSON.stringify(profile)` of one launch profile. */
export const MAX_PROFILE_BYTES = 8 * 1024;
/** Persistent history per session (concept chapter 8). */
export const DEFAULT_HISTORY_LIMIT_BYTES = 10 * 1024 * 1024;
export const MIN_HISTORY_LIMIT_BYTES = 64 * 1024;
export const MAX_HISTORY_LIMIT_BYTES = 1024 * 1024 * 1024;
/** `history.search`: length of the query, ids per search, hits per answer, characters of a hit line. */
export const MAX_HISTORY_QUERY_LENGTH = 256;
export const MAX_HISTORY_SESSION_IDS = 256;
export const MAX_HISTORY_HITS = 200;
export const MAX_HISTORY_LINE_LENGTH = 512;

/** A folder of a workspace. `path` is a Linux path for "wsl" and a Windows path for "windows". */
export interface Project {
  id: ProjectId;
  workspaceId: WorkspaceId;
  name: string;
  path: string;
  backend: BackendKind;
  /** WSL distribution; only for backend "wsl". Undefined means the configured default. */
  distro?: string;
}

/** Logical group of projects and sessions (concept chapter 5). Sessions without workspace are ungrouped. */
export interface Workspace {
  id: WorkspaceId;
  name: string;
  /** At most MAX_PROJECTS_PER_WORKSPACE. */
  projects: Project[];
  /** Directory for new sessions of the workspace that have no project and no `cwd`. */
  defaultCwd?: string;
}

/**
 * How a session is started (concept chapter 9). `launch.command` is an argument array, never a shell string.
 * `launch.env` holds no secrets: credentials come from existing CLI logins (security.instructions.md).
 */
export interface LaunchProfile {
  id: LaunchProfileId;
  name: string;
  workspaceId?: WorkspaceId;
  projectId?: ProjectId;
  launch: LaunchSpec;
  /** Started by the core after its reconcile when no session of the profile is alive (ADR 0005). */
  autostart: boolean;
  loggingEnabled: boolean;
}

/** What happens on quit while sessions run, when the user chose "do not ask again". */
export type QuitAction = "keepSessions" | "stopSessions";

/** Global settings with fixed keys; the core stores each key as JSON in the table `settings`. */
export interface Settings {
  defaultDistro?: string;
  defaultShell?: WindowsShell;
  defaultCwd?: string;
  /** MIN_HISTORY_LIMIT_BYTES to MAX_HISTORY_LIMIT_BYTES. */
  historyLimitBytes: number;
  historyEnabledByDefault: boolean;
  /** Ask before quitting while sessions run; false applies `quitAction` without asking. */
  confirmQuitWhileRunning: boolean;
  /** Undefined means "keepSessions". */
  quitAction?: QuitAction;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  historyLimitBytes: DEFAULT_HISTORY_LIMIT_BYTES,
  historyEnabledByDefault: true,
  confirmQuitWhileRunning: true,
};

/** Partial change of `Settings`: a missing key stays, `null` removes an optional key. */
export interface SettingsPatch {
  defaultDistro?: string | null;
  defaultShell?: WindowsShell | null;
  defaultCwd?: string | null;
  historyLimitBytes?: number;
  historyEnabledByDefault?: boolean;
  confirmQuitWhileRunning?: boolean;
  quitAction?: QuitAction | null;
}

/** One match of `history.search`. */
export interface HistoryHit {
  sessionId: SessionId;
  /** Milliseconds since 1970 of the history entry (ADR 0004). */
  timestamp: number;
  /** The line around the match, escape sequences removed; at most MAX_HISTORY_LINE_LENGTH characters. */
  line: string;
  /** Position of the match in `line`. */
  offset: number;
}

/** Stable error codes on the IPC boundary (ADR 0002). */
export const ERROR_CODES = [
  "protocol_mismatch",
  "bad_request",
  "not_found",
  "not_writer",
  "invalid_state",
  "backend_unavailable",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * 1.1: `outputSeq` in the `session.attach` result and `seq` in `session.output` (optional fields).
 * 1.2: event `session.created`.
 * 1.3: phase 3 (workspaces, projects, profiles, session update/archive/delete, settings, history search and
 * their events); `session.create` may omit `launch` when it names a `profileId`.
 */
export const PROTOCOL_VERSION = "1.3" as const;
