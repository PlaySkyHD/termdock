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

export const PROTOCOL_VERSION = "1.0" as const;
