// IPC message types (ADR 0002). Headers are JSON; terminal bytes travel in the frame payload.

import type {
  BackendKind,
  ClientId,
  ErrorCode,
  LaunchProfileId,
  LaunchSpec,
  SessionId,
  SessionInfo,
  SessionState,
  TerminalSize,
  ViewId,
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
  launch: LaunchSpec;
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
}

export interface CoreStatusResult {
  /** Backends the core could not reach when it reconciled the stored sessions on start (ADR 0005). */
  backendUnavailable: BackendKind[];
}

export interface CoreShutdownParams {
  /** true: end all running sessions before the core exits (ADR 0001). Default false: only the core ends. */
  stopSessions?: boolean;
}

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
}

export type Method = keyof MethodMap;

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
] as const satisfies readonly Method[];

// --- Events ---------------------------------------------------------------------------------

export interface EventMap {
  /** Output bytes travel in the event payload. */
  "session.output": { sessionId: SessionId };
  "session.stateChanged": { sessionId: SessionId; state: SessionState; lastExitCode?: number };
  "session.resized": { sessionId: SessionId; size: TerminalSize };
  /** writerViewId undefined means nobody writes. */
  "view.writerChanged": { sessionId: SessionId; writerViewId?: ViewId };
}

export type EventName = keyof EventMap;

export const EVENT_NAMES = [
  "session.output",
  "session.stateChanged",
  "session.resized",
  "view.writerChanged",
] as const satisfies readonly EventName[];

// --- Payload rules --------------------------------------------------------------------------

/** none: payload must be empty. nonEmpty: bytes required. any: bytes required but may be empty. */
export type PayloadRule = "none" | "nonEmpty" | "any";

export const REQUEST_PAYLOAD: Record<Method, PayloadRule> = {
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
};

export const RESPONSE_PAYLOAD: Record<Method, PayloadRule> = {
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
};

export const EVENT_PAYLOAD: Record<EventName, PayloadRule> = {
  "session.output": "nonEmpty",
  "session.stateChanged": "none",
  "session.resized": "none",
  "view.writerChanged": "none",
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
