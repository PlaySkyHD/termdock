// Contract between renderer, preload and main (ADR 0002, ADR 0006). Types only plus the channel names:
// the sandboxed preload cannot load local modules, so it imports nothing at runtime from here.
import type {
  BackendKind,
  CoreStatusResult,
  ErrorCode,
  HistorySearchResult,
  LaunchProfile,
  LaunchProfileId,
  LayoutWindow,
  ProfileCreateParams,
  ProfileUpdateParams,
  ProjectId,
  SessionCreateParams,
  SessionId,
  SessionInfo,
  SessionState,
  SessionWarning,
  Settings,
  SettingsPatch,
  TerminalSize,
  ViewId,
  Workspace,
  WorkspaceId,
  WslDistrosResult,
} from "@termdock/protocol";
import type { LayoutWindowPart } from "./layout-mapping.js";
import type { QuitAnswer, QuitChoice } from "./quit-decision.js";

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
  /** The workspaces with their projects, in the core's order (#63). */
  | { method: "listWorkspaces" }
  | { method: "createWorkspace"; name: string }
  | { method: "updateWorkspace"; workspaceId: WorkspaceId; name: string }
  | { method: "deleteWorkspace"; workspaceId: WorkspaceId }
  | { method: "createProject"; workspaceId: WorkspaceId; name: string; path: string; backend: BackendKind }
  | { method: "updateProject"; projectId: ProjectId; name: string }
  | { method: "deleteProject"; projectId: ProjectId }
  /** Renames and/or moves a session; `workspaceId: null` makes it ungrouped. At least one change. */
  | { method: "updateSession"; sessionId: SessionId; name?: string; workspaceId?: WorkspaceId | null }
  | { method: "archiveSession"; sessionId: SessionId }
  | { method: "deleteSession"; sessionId: SessionId }
  /** The layout of this window as the main process holds it (restore, #29). */
  | { method: "windowLayout" }
  /** The tabs and sidebar of this window after a change; the main process bundles and saves the layout. */
  | { method: "reportLayout"; window: LayoutWindowPart }
  /** The answer of this window to the quit dialog (`quitRequested`, #60). */
  | { method: "answerQuit"; requestId: string; choice: QuitChoice; remember: boolean }
  /** This window now shows the quit dialog; without it the main process cancels the question after 5 s. */
  | { method: "quitShown"; requestId: string }
  /** Searches the stored history of all sessions (`history.search`, #62); the dialog never names sessions. */
  | { method: "searchHistory"; query: string; limit?: number }
  // Settings dialog (#64): the core checks the values, the main process the shape and the keys.
  | { method: "getSettings" }
  /** A partial change; `null` removes an optional key. At least one key. */
  | { method: "updateSettings"; settings: SettingsPatch }
  | { method: "listProfiles" }
  | { method: "createProfile"; profile: ProfileCreateParams }
  /** At least one change; a missing field stays as it is. */
  | { method: "updateProfile"; profileId: LaunchProfileId; change: ProfileChange }
  | { method: "deleteProfile"; profileId: LaunchProfileId }
  /** The WSL distributions (`wsl.distros`); an empty list names its reason. */
  | { method: "listDistros" }
  /** The button "Core neu starten" (#130): restarts the core after the limit of automatic restarts. */
  | { method: "restartCore" }
  /** Whether the core is connected right now; a page that loads while it is gone asks this once (#130). */
  | { method: "coreConnection" };

/** The connection to the core as a window needs it (#130). */
export interface CoreConnectionState {
  /** No connection: the core restarts (`restarting`) or the restarts gave up. */
  closed: boolean;
  restarting: boolean;
}

/** The fields of `profile.update` besides the id. */
export type ProfileChange = Omit<ProfileUpdateParams, "profileId">;

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
  listWorkspaces: Workspace[];
  createWorkspace: null;
  updateWorkspace: null;
  deleteWorkspace: null;
  createProject: null;
  updateProject: null;
  deleteProject: null;
  updateSession: SessionInfo;
  archiveSession: null;
  deleteSession: null;
  windowLayout: LayoutWindow;
  reportLayout: null;
  answerQuit: null;
  quitShown: null;
  searchHistory: HistorySearchResult;
  getSettings: Settings;
  updateSettings: Settings;
  listProfiles: LaunchProfile[];
  createProfile: LaunchProfile;
  updateProfile: LaunchProfile;
  deleteProfile: null;
  listDistros: WslDistrosResult;
  restartCore: null;
  coreConnection: CoreConnectionState;
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
  /** `warnings`: those of the session's current run (protocol 1.5, #113); none means the session has none. */
  | {
      kind: "stateChanged";
      sessionId: SessionId;
      state: SessionState;
      lastExitCode?: number;
      warnings?: SessionWarning[];
    }
  /** The core's `session.created`: a session came into the registry, from any client (ADR 0002, 0006). */
  | { kind: "sessionCreated"; session: SessionInfo }
  /** Name, workspace or logging of a session changed (`session.updated`), from any client (#63). */
  | { kind: "sessionUpdated"; session: SessionInfo }
  /** The session and its history are gone (`session.removed`), from any client (#63). */
  | { kind: "sessionRemoved"; sessionId: SessionId }
  /** The complete list of workspaces after any change (`workspace.changed`), from any client (#63). */
  | { kind: "workspaceChanged"; workspaces: Workspace[] }
  /** The app is about to quit while sessions run: this window shows the quit dialog and answers (#60). */
  | { kind: "quitRequested"; requestId: string; activeSessions: number }
  /** The settings after any change (`settings.changed`), from any client (#64). */
  | { kind: "settingsChanged"; settings: Settings }
  /** The complete list of launch profiles after any change (`profile.changed`), from any client (#64). */
  | { kind: "profilesChanged"; profiles: LaunchProfile[] }
  /** The menu entry "Einstellungen …" asks the focused window to open the settings dialog (#64). */
  | { kind: "openSettings" }
  /**
   * The connection to the core ended; every view of the window is gone with it. `restarting`: the main process
   * starts the core again (#130), otherwise it stays disconnected until `restartCore`.
   */
  | { kind: "coreClosed"; restarting: boolean }
  /** The main process is connected to a core again: the window lists anew and attaches its views again (#130). */
  | { kind: "coreRestarted" };

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
  listWorkspaces(): Promise<Workspace[]>;
  createWorkspace(name: string): Promise<void>;
  updateWorkspace(workspaceId: WorkspaceId, name: string): Promise<void>;
  deleteWorkspace(workspaceId: WorkspaceId): Promise<void>;
  createProject(workspaceId: WorkspaceId, name: string, path: string, backend: BackendKind): Promise<void>;
  updateProject(projectId: ProjectId, name: string): Promise<void>;
  deleteProject(projectId: ProjectId): Promise<void>;
  updateSession(
    sessionId: SessionId,
    change: { name?: string; workspaceId?: WorkspaceId | null },
  ): Promise<SessionInfo>;
  archiveSession(sessionId: SessionId): Promise<void>;
  deleteSession(sessionId: SessionId): Promise<void>;
  windowLayout(): Promise<LayoutWindow>;
  reportLayout(window: LayoutWindowPart): Promise<void>;
  answerQuit(requestId: string, answer: QuitAnswer): Promise<void>;
  quitShown(requestId: string): Promise<void>;
  /** Plain-text, case-insensitive search of the stored history of all sessions, newest hits first. */
  searchHistory(query: string, limit?: number): Promise<HistorySearchResult>;
  getSettings(): Promise<Settings>;
  updateSettings(settings: SettingsPatch): Promise<Settings>;
  listProfiles(): Promise<LaunchProfile[]>;
  createProfile(profile: ProfileCreateParams): Promise<LaunchProfile>;
  updateProfile(profileId: LaunchProfileId, change: ProfileChange): Promise<LaunchProfile>;
  deleteProfile(profileId: LaunchProfileId): Promise<void>;
  listDistros(): Promise<WslDistrosResult>;
  /** Restarts the core once the automatic restarts gave up; does nothing while connected or restarting. */
  restartCore(): Promise<void>;
  coreConnection(): Promise<CoreConnectionState>;
  /** Subscribes to all bridge events of this window; the returned function unsubscribes. */
  onEvent(listener: (event: BridgeEvent) => void): () => void;
}
