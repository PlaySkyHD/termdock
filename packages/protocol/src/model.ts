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
