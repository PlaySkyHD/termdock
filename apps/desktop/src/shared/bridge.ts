// Contract between renderer, preload and main (ADR 0002, ADR 0006). Types only plus the channel names:
// the sandboxed preload cannot load local modules, so it imports nothing at runtime from here.
import type {
  ErrorCode,
  SessionCreateParams,
  SessionId,
  SessionInfo,
  SessionState,
  TerminalSize,
  ViewId,
} from "@termdock/protocol";

/** `ipcRenderer.invoke` channel for every call of the bridge. */
export const CALL_CHANNEL = "termdock:call";
/** `webContents.send` channel for every event of the bridge. */
export const EVENT_CHANNEL = "termdock:event";

/** The only calls a renderer may make. Anything else is `bad_request`. */
export type BridgeCall =
  | { method: "listSessions" }
  | { method: "createSession"; params: SessionCreateParams }
  | { method: "attach"; sessionId: SessionId; size: TerminalSize }
  | { method: "detach"; viewId: ViewId }
  | { method: "input"; viewId: ViewId; data: string }
  | { method: "resize"; viewId: ViewId; size: TerminalSize }
  | { method: "claimWriter"; viewId: ViewId };

export type BridgeMethod = BridgeCall["method"];

/** A view attached by this window; `snapshot` is what the screen showed when it was attached. */
export interface AttachedView {
  viewId: ViewId;
  size: TerminalSize;
  writerViewId?: ViewId;
  snapshot: Uint8Array;
  /** Output events of the session up to this sequence number are part of the snapshot; drop them. */
  outputSeq: number;
}

export interface BridgeResults {
  listSessions: SessionInfo[];
  createSession: SessionInfo;
  attach: AttachedView;
  detach: null;
  input: null;
  resize: null;
  claimWriter: null;
}

/** Transport errors of the main process join the core's stable codes. */
export type BridgeErrorCode = ErrorCode | "timeout" | "closed";

export interface BridgeErrorBody {
  code: BridgeErrorCode;
  message: string;
}

/** Electron passes only the message of a thrown error through `invoke`, so results carry their code. */
export type BridgeResult<T = unknown> = { ok: true; value: T } | { ok: false; error: BridgeErrorBody };

export type BridgeEvent =
  /** `seq` counts the output events of the session in this main process, starting at 1. */
  | { kind: "output"; sessionId: SessionId; seq: number; data: Uint8Array }
  | { kind: "resized"; sessionId: SessionId; size: TerminalSize }
  | { kind: "writerChanged"; sessionId: SessionId; writerViewId?: ViewId }
  | { kind: "stateChanged"; sessionId: SessionId; state: SessionState; lastExitCode?: number }
  | { kind: "coreClosed" };

/**
 * API the preload exposes as `window.termdock`. Rejected promises carry the code in the message as
 * `[code] message`, because errors crossing `contextBridge` keep only their message.
 */
export interface TermdockApi {
  listSessions(): Promise<SessionInfo[]>;
  createSession(params: SessionCreateParams): Promise<SessionInfo>;
  attach(sessionId: SessionId, size: TerminalSize): Promise<AttachedView>;
  detach(viewId: ViewId): Promise<void>;
  input(viewId: ViewId, data: string): Promise<void>;
  resize(viewId: ViewId, size: TerminalSize): Promise<void>;
  claimWriter(viewId: ViewId): Promise<void>;
  /** Subscribes to all bridge events of this window; the returned function unsubscribes. */
  onEvent(listener: (event: BridgeEvent) => void): () => void;
}
