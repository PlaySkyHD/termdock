// IPC message types (ADR 0002). Headers are JSON; terminal bytes travel in the frame payload.

import type {
  BackendKind,
  ClientId,
  ErrorCode,
  HistoryHit,
  LaunchProfile,
  LaunchProfileId,
  LayoutDocument,
  LaunchSpec,
  Project,
  ProjectId,
  SessionId,
  SessionInfo,
  SessionState,
  Settings,
  SettingsPatch,
  TerminalSize,
  ViewId,
  Workspace,
  WorkspaceId,
} from "./model.js";

// --- Header kinds ---------------------------------------------------------------------------

export interface RequestHeader<M extends Method = Method> {
  kind: "request";
  id: string;
  method: M;
  params: MethodMap[M]["params"];
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
}

export interface ResultResponseHeader<M extends Method = Method> {
  kind: "response";
  id: string;
  result: MethodMap[M]["result"];
}

export interface ErrorResponseHeader {
  kind: "response";
  id: string;
  error: ErrorBody;
}

export type ResponseHeader<M extends Method = Method> = ResultResponseHeader<M> | ErrorResponseHeader;

/** Core to client, no id. */
export interface EventHeader<E extends EventName = EventName> {
  kind: "event";
  event: E;
  data: EventMap[E];
}

// --- Methods --------------------------------------------------------------------------------

export type ClientKind = string;

export interface HelloParams {
  protocolVersion: string;
  clientId: ClientId;
  /** Free-form short label, for example "desktop". ADR 0002 names no fixed set. */
  clientKind: ClientKind;
}

export interface HelloResult {
  /** The core's own version. */
  protocolVersion: string;
}

export interface SessionCreateParams {
  name: string;
  /** Required unless `profileId` is set; then the core takes the profile's launch spec (since 1.3). */
  launch?: LaunchSpec;
  workspaceId?: WorkspaceId;
  profileId?: LaunchProfileId;
  size?: TerminalSize;
  loggingEnabled?: boolean;
}

export interface SessionAttachParams {
  sessionId: SessionId;
  /** Requested size of the new view; the writer decides the real size. */
  size?: TerminalSize;
}

/** Snapshot bytes of the current screen travel in the response payload (may be empty). */
export interface SessionAttachResult {
  viewId: ViewId;
  size: TerminalSize;
  /** Current writer; undefined when nobody writes. */
  writerViewId?: ViewId;
  /**
   * Number (`seq` of `session.output`) of the last output of the session that does not go to the new view;
   * output with a higher number is its live output. 0 before any output. Since protocol 1.1.
   */
  outputSeq?: number;
}

export interface CoreStatusResult {
  /** Backends the core could not reach when it reconciled the stored sessions on start (ADR 0005). */
  backendUnavailable: BackendKind[];
}

export interface CoreShutdownParams {
  /** true: end all running sessions before the core exits (ADR 0001). Default false: only the core ends. */
  stopSessions?: boolean;
}

export interface LayoutGetResult {
  /** Undefined while no layout has been saved. */
  layout?: LayoutDocument;
  /** 0 while nothing is saved; grows by 1 with every `layout.save`. */
  revision: number;
}

export interface LayoutSaveParams {
  layout: LayoutDocument;
  /** When set and not the current revision, the save fails with `invalid_state`. Undefined overwrites. */
  baseRevision?: number;
}

// --- Phase 3 (since 1.3) ---------------------------------------------------------------------
// In `*.update` a missing field stays unchanged and `null` removes an optional value; at least one change is
// required. New requests reject unknown fields.

export interface WorkspaceCreateParams {
  name: string;
  defaultCwd?: string;
}

export interface WorkspaceUpdateParams {
  workspaceId: WorkspaceId;
  name?: string;
  defaultCwd?: string | null;
}

export interface ProjectCreateParams {
  workspaceId: WorkspaceId;
  name: string;
  path: string;
  backend: BackendKind;
  /** Only for backend "wsl". */
  distro?: string;
}

export interface ProjectUpdateParams {
  projectId: ProjectId;
  name?: string;
  path?: string;
  backend?: BackendKind;
  distro?: string | null;
}

export interface ProfileCreateParams {
  name: string;
  workspaceId?: WorkspaceId;
  projectId?: ProjectId;
  launch: LaunchSpec;
  /** Default false. */
  autostart?: boolean;
  /** Default: setting `historyEnabledByDefault`. */
  loggingEnabled?: boolean;
}

export interface ProfileUpdateParams {
  profileId: LaunchProfileId;
  name?: string;
  workspaceId?: WorkspaceId | null;
  projectId?: ProjectId | null;
  launch?: LaunchSpec;
  autostart?: boolean;
  loggingEnabled?: boolean;
}

export interface SessionUpdateParams {
  sessionId: SessionId;
  name?: string;
  /** `null` makes the session ungrouped. Moving never touches the process. */
  workspaceId?: WorkspaceId | null;
  loggingEnabled?: boolean;
}

export interface HistorySearchParams {
  /** 1 to MAX_HISTORY_QUERY_LENGTH characters, plain text, case-insensitive. */
  query: string;
  /** 1 to MAX_HISTORY_SESSION_IDS ids; undefined searches all sessions with stored history. */
  sessionIds?: SessionId[];
  /** 1 to MAX_HISTORY_HITS; default MAX_HISTORY_HITS. */
  limit?: number;
}

export interface HistorySearchResult {
  hits: HistoryHit[];
  /** true when the search stopped at the hit or time limit; `hits` is then partial. */
  truncated: boolean;
}

type Empty = Record<string, never>;

export interface MethodMap {
  hello: { params: HelloParams; result: HelloResult };
  "session.create": { params: SessionCreateParams; result: { session: SessionInfo } };
  "session.list": { params: Record<string, never>; result: { sessions: SessionInfo[] } };
  "session.attach": { params: SessionAttachParams; result: SessionAttachResult };
  "session.detach": { params: { viewId: ViewId }; result: Record<string, never> };
  /** Input bytes travel in the request payload. Only the writing view may send. */
  "session.input": { params: { viewId: ViewId }; result: Record<string, never> };
  /** Only the writing view may resize. */
  "session.resize": { params: { viewId: ViewId; size: TerminalSize }; result: Record<string, never> };
  "session.claimWriter": { params: { viewId: ViewId }; result: Record<string, never> };
  "session.kill": { params: { sessionId: SessionId }; result: Record<string, never> };
  "core.status": { params: Record<string, never>; result: CoreStatusResult };
  "core.shutdown": { params: CoreShutdownParams; result: Record<string, never> };
  "layout.get": { params: Record<string, never>; result: LayoutGetResult };
  "layout.save": { params: LayoutSaveParams; result: { revision: number } };
  "workspace.list": { params: Empty; result: { workspaces: Workspace[] } };
  "workspace.create": { params: WorkspaceCreateParams; result: { workspace: Workspace } };
  "workspace.update": { params: WorkspaceUpdateParams; result: { workspace: Workspace } };
  "workspace.delete": { params: { workspaceId: WorkspaceId }; result: Empty };
  "project.create": { params: ProjectCreateParams; result: { project: Project } };
  "project.update": { params: ProjectUpdateParams; result: { project: Project } };
  "project.delete": { params: { projectId: ProjectId }; result: Empty };
  "profile.list": { params: Empty; result: { profiles: LaunchProfile[] } };
  "profile.create": { params: ProfileCreateParams; result: { profile: LaunchProfile } };
  "profile.update": { params: ProfileUpdateParams; result: { profile: LaunchProfile } };
  "profile.delete": { params: { profileId: LaunchProfileId }; result: Empty };
  "session.update": { params: SessionUpdateParams; result: { session: SessionInfo } };
  /** Ends the process; metadata and history stay. The new state comes as `session.stateChanged`. */
  "session.archive": { params: { sessionId: SessionId }; result: Empty };
  /** Removes the session and its history; the core announces it with `session.removed`. */
  "session.delete": { params: { sessionId: SessionId }; result: Empty };
  "settings.get": { params: Empty; result: { settings: Settings } };
  "settings.set": { params: { settings: SettingsPatch }; result: { settings: Settings } };
  "history.search": { params: HistorySearchParams; result: HistorySearchResult };
}

export type Method = keyof MethodMap;

/** Methods added in protocol 1.3 (phase 3). */
export const PHASE_3_METHODS = [
  "workspace.list",
  "workspace.create",
  "workspace.update",
  "workspace.delete",
  "project.create",
  "project.update",
  "project.delete",
  "profile.list",
  "profile.create",
  "profile.update",
  "profile.delete",
  "session.update",
  "session.archive",
  "session.delete",
  "settings.get",
  "settings.set",
  "history.search",
] as const satisfies readonly Method[];

export const METHODS = [
  "hello",
  "session.create",
  "session.list",
  "session.attach",
  "session.detach",
  "session.input",
  "session.resize",
  "session.claimWriter",
  "session.kill",
  "core.status",
  "core.shutdown",
  "layout.get",
  "layout.save",
  ...PHASE_3_METHODS,
] as const satisfies readonly Method[];

// --- Events ---------------------------------------------------------------------------------

export interface EventMap {
  /**
   * Output bytes travel in the event payload. `seq` numbers the output of the session from 1 (since protocol
   * 1.1); parts of output split at the payload limit share it.
   */
  "session.output": { sessionId: SessionId; seq?: number };
  "session.stateChanged": { sessionId: SessionId; state: SessionState; lastExitCode?: number };
  "session.resized": { sessionId: SessionId; size: TerminalSize };
  /** writerViewId undefined means nobody writes. */
  "view.writerChanged": { sessionId: SessionId; writerViewId?: ViewId };
  /**
   * A session came into the registry through `session.create`, in state `Starting`; sent to every client that
   * used `session.list` (like `session.stateChanged`), also the one that asked. Since protocol 1.2. Also sent when
   * the start fails afterwards; `session.stateChanged` to `Interrupted` follows. Sessions loaded at the core's
   * start are not announced; clients get them with `session.list`.
   */
  "session.created": { session: SessionInfo };
  // Since 1.3, like `session.created`: to every client that used `session.list`, also the one that asked.
  /** Name, workspace or logging of a session changed (`session.update`, or a deleted workspace). */
  "session.updated": { session: SessionInfo };
  /** The session and its history are gone (`session.delete`). */
  "session.removed": { sessionId: SessionId };
  /** The complete list of workspaces with their projects after any change of one of them. */
  "workspace.changed": { workspaces: Workspace[] };
  /** The complete list of launch profiles after any change. */
  "profile.changed": { profiles: LaunchProfile[] };
  "settings.changed": { settings: Settings };
}

export type EventName = keyof EventMap;

export const EVENT_NAMES = [
  "session.output",
  "session.stateChanged",
  "session.resized",
  "view.writerChanged",
  "session.created",
  "session.updated",
  "session.removed",
  "workspace.changed",
  "profile.changed",
  "settings.changed",
] as const satisfies readonly EventName[];

/** Events that go to every connection that used `session.list` (spec core-ipc). */
export type ListerEventName =
  | "session.created"
  | "session.updated"
  | "session.removed"
  | "workspace.changed"
  | "profile.changed"
  | "settings.changed";

// --- Payload rules --------------------------------------------------------------------------

/** none: payload must be empty. nonEmpty: bytes required. any: bytes required but may be empty. */
export type PayloadRule = "none" | "nonEmpty" | "any";

/** No phase-3 message carries bytes. */
const PHASE_3_PAYLOAD: Record<(typeof PHASE_3_METHODS)[number], PayloadRule> = {
  "workspace.list": "none",
  "workspace.create": "none",
  "workspace.update": "none",
  "workspace.delete": "none",
  "project.create": "none",
  "project.update": "none",
  "project.delete": "none",
  "profile.list": "none",
  "profile.create": "none",
  "profile.update": "none",
  "profile.delete": "none",
  "session.update": "none",
  "session.archive": "none",
  "session.delete": "none",
  "settings.get": "none",
  "settings.set": "none",
  "history.search": "none",
};

export const REQUEST_PAYLOAD: Record<Method, PayloadRule> = {
  ...PHASE_3_PAYLOAD,
  hello: "none",
  "session.create": "none",
  "session.list": "none",
  "session.attach": "none",
  "session.detach": "none",
  "session.input": "nonEmpty",
  "session.resize": "none",
  "session.claimWriter": "none",
  "session.kill": "none",
  "core.status": "none",
  "core.shutdown": "none",
  "layout.get": "none",
  "layout.save": "none",
};

export const RESPONSE_PAYLOAD: Record<Method, PayloadRule> = {
  ...PHASE_3_PAYLOAD,
  hello: "none",
  "session.create": "none",
  "session.list": "none",
  "session.attach": "any",
  "session.detach": "none",
  "session.input": "none",
  "session.resize": "none",
  "session.claimWriter": "none",
  "session.kill": "none",
  "core.status": "none",
  "core.shutdown": "none",
  "layout.get": "none",
  "layout.save": "none",
};

export const EVENT_PAYLOAD: Record<EventName, PayloadRule> = {
  "session.output": "nonEmpty",
  "session.stateChanged": "none",
  "session.resized": "none",
  "view.writerChanged": "none",
  "session.created": "none",
  "session.updated": "none",
  "session.removed": "none",
  "workspace.changed": "none",
  "profile.changed": "none",
  "settings.changed": "none",
};

// --- Parsed forms ---------------------------------------------------------------------------

export type ParsedRequest = {
  [M in Method]: { id: string; method: M; params: MethodMap[M]["params"]; payload: Uint8Array };
}[Method];

export type ParsedResponse<M extends Method = Method> =
  | { id: string; ok: true; result: MethodMap[M]["result"]; payload: Uint8Array }
  | { id: string; ok: false; error: ErrorBody };

export type ParsedEvent = {
  [E in EventName]: { event: E; data: EventMap[E]; payload: Uint8Array };
}[EventName];

export interface ParseFailure {
  ok: false;
  /** Request or response id when it could be read, so a server can answer with bad_request. */
  id?: string;
  error: ErrorBody;
}

export type ParseResult<T> = { ok: true; value: T } | ParseFailure;
