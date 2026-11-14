// Contract between renderer, preload and main (ADR 0002, ADR 0006). Types only plus the channel names:
// the sandboxed preload cannot load local modules, so it imports nothing at runtime from here.
import type {
  CoreStatusResult,
  ErrorCode,
  LayoutWindow,
  SessionCreateParams,
  SessionId,
  SessionInfo,
  SessionState,
  TerminalSize,
  ViewId,
} from "@termdock/protocol";
import type { LayoutWindowPart } from "./layout-mapping.js";

/** `ipcRenderer.invoke` channel for every call of the bridge. */
export const CALL_CHANNEL = "termdock:call";
/** `webContents.send` channel for every event of the bridge. */
export const EVENT_CHANNEL = "termdock:event";

/** The only calls a renderer may make. Anything else is `bad_request`. */
export type BridgeCall =
  | { method: "coreStatus" }
  | { method: "listSessions" }
  | { method: "createSession"; params: SessionCreateParams }
  | { method: "attach"; sessionId: SessionId; size: TerminalSize }
  | { method: "detach"; viewId: ViewId }
  | { method: "input"; viewId: ViewId; data: string }
  | { method: "resize"; viewId: ViewId; size: TerminalSize }
  | { method: "claimWriter"; viewId: ViewId }
  /** The layout of this window as the main process holds it (restore, #29). */
  | { method: "windowLayout" }
  /** The tabs and sidebar of this window after a change; the main process bundles and saves the layout. */
  | { method: "reportLayout"; window: LayoutWindowPart };

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
  coreStatus: CoreStatusResult;
  listSessions: SessionInfo[];
  createSession: SessionInfo;
  attach: AttachedView;
  detach: null;
  input: null;
  resize: null;
  claimWriter: null;
  windowLayout: LayoutWindow;
  reportLayout: null;
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
  /** The core's `session.created`: a session came into the registry, from any client (ADR 0002, 0006). */
  | { kind: "sessionCreated"; session: SessionInfo }
  | { kind: "coreClosed" };

/**
 * API the preload exposes as `window.termdock`. Rejected promises carry the code in the message as
 * `[code] message`, because errors crossing `contextBridge` keep only their message.
 */
export interface TermdockApi {
  coreStatus(): Promise<CoreStatusResult>;
  listSessions(): Promise<SessionInfo[]>;
  createSession(params: SessionCreateParams): Promise<SessionInfo>;
  attach(sessionId: SessionId, size: TerminalSize): Promise<AttachedView>;
  detach(viewId: ViewId): Promise<void>;
  input(viewId: ViewId, data: string): Promise<void>;
  resize(viewId: ViewId, size: TerminalSize): Promise<void>;
  claimWriter(viewId: ViewId): Promise<void>;
  windowLayout(): Promise<LayoutWindow>;
  reportLayout(window: LayoutWindowPart): Promise<void>;
  /** Subscribes to all bridge events of this window; the returned function unsubscribes. */
  onEvent(listener: (event: BridgeEvent) => void): () => void;
}
