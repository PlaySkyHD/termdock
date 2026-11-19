// Main side of the bridge (ADR 0002, ADR 0006): checks every renderer call, keeps which window owns which view
// and routes core events to the windows that show the session. Free of Electron so it runs in tests.
import { IpcError } from "@termdock/core";
import type { Disposable } from "@termdock/core";
import { MAX_HISTORY_HITS, MAX_HISTORY_QUERY_LENGTH } from "@termdock/protocol";
import type {
  LayoutWindow,
  ProfileCreateParams,
  SessionCreateParams,
  SessionId,
  SettingsPatch,
  TerminalSize,
  ViewId,
} from "@termdock/protocol";
import type {
  BridgeCall,
  BridgeErrorBody,
  BridgeEvent,
  BridgeResult,
  ProfileChange,
} from "../shared/bridge.js";
import type { LayoutWindowPart } from "../shared/layout-mapping.js";
import type { QuitAnswer } from "../shared/quit-decision.js";
import type { CorePort } from "./core-connection.js";

/** The layout of the windows, as the bridge needs it (`LayoutCoordinator` fits). `report` throws `IpcError`. */
export interface WindowLayouts {
  windowOf(windowId: number): LayoutWindow | undefined;
  report(windowId: number, part: LayoutWindowPart): void;
}

/** The open quit question, as the bridge needs it (`QuitPrompt` fits). `answer` throws `IpcError`. */
export interface QuitAnswers {
  answer(windowId: number, requestId: string, answer: QuitAnswer): void;
  /** The window shows the dialog for this question. */
  ack(windowId: number, requestId: string): void;
}

/** The restart of the core as the bridge needs it (`CoreSupervisor` fits, #130). */
export interface CoreRestarts {
  /** True while the main process replaces a lost connection; read when the connection ends. */
  restarting(): boolean;
  /** True while there is no connection because the core restarts or the restarts gave up. */
  disconnected(): boolean;
  /** The button "Core neu starten"; does nothing unless the automatic restarts gave up. */
  restart(): void;
}

/** A window as the bridge sees it; `id` is the `webContents` id. */
export interface BridgeWindow {
  readonly id: number;
  send(event: BridgeEvent): void;
}

interface ViewRecord {
  windowId: number;
  sessionId: SessionId;
}

/** Largest terminal the bridge passes on; anything bigger is a broken renderer, not a real screen. */
const MAX_COLS = 1_000;
const MAX_ROWS = 500;

class BadRequest extends Error {}

export class DesktopBridge {
  private readonly windows = new Map<number, BridgeWindow>();
  private readonly views = new Map<ViewId, ViewRecord>();
  /** Attaches in progress per session and window; their window gets events before the view is known. */
  private readonly attaching = new Map<SessionId, Map<number, number>>();
  /** Number of the last output event per session (ADR 0006: snapshot mark). */
  private readonly outputSeq = new Map<SessionId, number>();
  /** Raised when a window's renderer reloads or crashes; attaches of an older renderer are given back. */
  private readonly epochs = new Map<number, number>();
  private readonly subscriptions: Disposable[];
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly core: CorePort,
    private readonly layouts?: WindowLayouts,
    private readonly quit?: QuitAnswers,
    private readonly restarts?: CoreRestarts,
  ) {
    this.subscriptions = [
      core.on("session.output", ({ sessionId, seq: coreSeq }, payload) => {
        // The core's number (protocol 1.1); a 1.0 core sends none, then the main counts itself.
        const seq = coreSeq ?? (this.outputSeq.get(sessionId) ?? 0) + 1;
        this.outputSeq.set(sessionId, seq);
        this.toSession(sessionId, { kind: "output", sessionId, seq, data: payload });
      }),
      core.on("session.resized", ({ sessionId, size }) =>
        this.toSession(sessionId, { kind: "resized", sessionId, size }),
      ),
      core.on("view.writerChanged", ({ sessionId, writerViewId }) =>
        this.toSession(sessionId, {
          kind: "writerChanged",
          sessionId,
          ...(writerViewId === undefined ? {} : { writerViewId }),
        }),
      ),
      core.on("session.stateChanged", ({ sessionId, state, lastExitCode, warnings }) => {
        // Archiving makes the core forget all views of the session; the records here must go with them.
        if (state === "Archived") this.forgetViews(sessionId);
        this.toAll({
          kind: "stateChanged",
          sessionId,
          state,
          ...(lastExitCode === undefined ? {} : { lastExitCode }),
          ...(warnings === undefined ? {} : { warnings }),
        });
      }),
      core.on("session.created", ({ session }) => this.toAll({ kind: "sessionCreated", session })),
      core.on("session.updated", ({ session }) => this.toAll({ kind: "sessionUpdated", session })),
      core.on("session.removed", ({ sessionId }) => {
        // The session is gone for good; neither its output counter nor a view record may outlive it (the core has
        // dropped the views already, and the window's detach of a dead view then ends with `not_found` here).
        this.outputSeq.delete(sessionId);
        this.forgetViews(sessionId);
        this.toAll({ kind: "sessionRemoved", sessionId });
      }),
      core.on("workspace.changed", ({ workspaces }) => this.toAll({ kind: "workspaceChanged", workspaces })),
      // Settings dialog (#64): every window, also for changes of other clients.
      core.on("settings.changed", ({ settings }) => this.toAll({ kind: "settingsChanged", settings })),
      core.on("profile.changed", ({ profiles }) => this.toAll({ kind: "profilesChanged", profiles })),
      core.onClose(() => {
        // The views and their numbers belonged to the core that is gone; a new core knows none of them (#130).
        this.views.clear();
        this.attaching.clear();
        this.outputSeq.clear();
        this.toAll({ kind: "coreClosed", restarting: this.restarts?.restarting() ?? false });
      }),
    ];
  }

  /** The main process is connected to a core again (#130): every window lists anew and attaches again. */
  coreRestarted(): void {
    this.toAll({ kind: "coreRestarted" });
  }

  /** The restarts gave up (#130): the windows stay disconnected and offer "Core neu starten". */
  coreRestartFailed(): void {
    this.toAll({ kind: "coreClosed", restarting: false });
  }

  /** "Core neu starten" started a restart after the restarts gave up (#130): the panes show it again. */
  coreRestarting(): void {
    this.toAll({ kind: "coreClosed", restarting: true });
  }

  addWindow(window: BridgeWindow): void {
    this.windows.set(window.id, window);
  }

  /** Forgets the window and detaches its views; the sessions keep running. */
  async removeWindow(windowId: number): Promise<void> {
    this.windows.delete(windowId);
    this.epochs.delete(windowId);
    await Promise.all(this.viewsOf(windowId).map((viewId) => this.detachView(viewId)));
  }

  /**
   * The window's renderer reloaded or crashed: its views are gone with it, so detach them (otherwise a dead view
   * could keep the writer). The window stays and its new renderer can attach again.
   */
  async resetWindow(windowId: number): Promise<void> {
    this.epochs.set(windowId, (this.epochs.get(windowId) ?? 0) + 1);
    await Promise.all(this.viewsOf(windowId).map((viewId) => this.detachView(viewId)));
  }

  viewsOf(windowId: number): ViewId[] {
    return [...this.views].filter(([, view]) => view.windowId === windowId).map(([viewId]) => viewId);
  }

  /** Session of a view of this window, or undefined. */
  sessionOf(windowId: number, viewId: ViewId): SessionId | undefined {
    const view = this.views.get(viewId);
    return view?.windowId === windowId ? view.sessionId : undefined;
  }

  /** One event to one window (the quit dialog); false for a window that is gone or unknown. */
  sendTo(windowId: number, event: BridgeEvent): boolean {
    const window = this.windows.get(windowId);
    window?.send(event);
    return window !== undefined;
  }

  /** Handles one renderer call. Never throws: errors come back as `{ ok: false }` with a stable code. */
  async call(windowId: number, raw: unknown): Promise<BridgeResult> {
    try {
      return { ok: true, value: await this.dispatch(windowId, parseCall(raw)) };
    } catch (error) {
      return { ok: false, error: errorBody(error) };
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.windows.clear();
  }

  private async dispatch(windowId: number, call: BridgeCall): Promise<unknown> {
    const core = this.core;
    switch (call.method) {
      case "coreStatus":
        return (await core.request("core.status", {})).result;
      case "listSessions":
        return (await core.request("session.list", {})).result.sessions;
      case "createSession": {
        // The windows learn about the new session from the core's `session.created` (protocol 1.2).
        return (await core.request("session.create", call.params)).result.session;
      }
      case "attach":
        return this.attach(windowId, call.sessionId, call.size);
      case "detach":
        this.ownView(windowId, call.viewId);
        await this.detachView(call.viewId);
        return null;
      case "input": {
        this.ownView(windowId, call.viewId);
        // session.input needs a payload; an empty string has nothing to send.
        if (call.data.length > 0)
          await core.request("session.input", { viewId: call.viewId }, this.encoder.encode(call.data));
        return null;
      }
      case "resize":
        this.ownView(windowId, call.viewId);
        await core.request("session.resize", { viewId: call.viewId, size: call.size });
        return null;
      case "claimWriter":
        this.ownView(windowId, call.viewId);
        await core.request("session.claimWriter", { viewId: call.viewId });
        return null;
      // Workspaces and sessions (#63): the windows learn the outcome from the core's events, which it sends to
      // this client before the answer; only the new name of a session comes back.
      case "listWorkspaces":
        return (await core.request("workspace.list", {})).result.workspaces;
      case "createWorkspace":
        await core.request("workspace.create", { name: call.name });
        return null;
      case "updateWorkspace":
        await core.request("workspace.update", { workspaceId: call.workspaceId, name: call.name });
        return null;
      case "deleteWorkspace":
        await core.request("workspace.delete", { workspaceId: call.workspaceId });
        return null;
      case "createProject":
        await core.request("project.create", {
          workspaceId: call.workspaceId,
          name: call.name,
          path: call.path,
          backend: call.backend,
        });
        return null;
      case "updateProject":
        await core.request("project.update", { projectId: call.projectId, name: call.name });
        return null;
      case "deleteProject":
        await core.request("project.delete", { projectId: call.projectId });
        return null;
      case "updateSession": {
        const { method: _method, ...params } = call;
        return (await core.request("session.update", params)).result.session;
      }
      case "archiveSession":
        await core.request("session.archive", { sessionId: call.sessionId });
        return null;
      case "deleteSession":
        await core.request("session.delete", { sessionId: call.sessionId });
        return null;
      case "windowLayout": {
        const window = this.layouts?.windowOf(windowId);
        if (!window) throw new IpcError("not_found", "This window has no layout");
        return window;
      }
      case "reportLayout":
        // The main process checks the whole document; the id of the window is the caller's, never a parameter.
        this.layouts?.report(windowId, call.window);
        return null;
      case "answerQuit":
        // Throws `not_found` for a window or id that was not asked.
        this.quit?.answer(windowId, call.requestId, { choice: call.choice, remember: call.remember });
        return null;
      case "quitShown":
        this.quit?.ack(windowId, call.requestId);
        return null;
      case "searchHistory":
        // All sessions: no `sessionIds`. The core bounds query, hits and running time.
        return (
          await core.request("history.search", {
            query: call.query,
            ...(call.limit === undefined ? {} : { limit: call.limit }),
          })
        ).result;
      // Settings dialog (#64): the windows also learn the outcome from `settingsChanged` and `profilesChanged`.
      case "getSettings":
        return (await core.request("settings.get", {})).result.settings;
      case "updateSettings":
        return (await core.request("settings.set", { settings: call.settings })).result.settings;
      case "listProfiles":
        return (await core.request("profile.list", {})).result.profiles;
      case "createProfile":
        return (await core.request("profile.create", call.profile)).result.profile;
      case "updateProfile":
        return (await core.request("profile.update", { ...call.change, profileId: call.profileId })).result
          .profile;
      case "deleteProfile":
        await core.request("profile.delete", { profileId: call.profileId });
        return null;
      case "listDistros":
        return (await core.request("wsl.distros", {})).result;
      case "restartCore":
        this.restarts?.restart();
        return null;
      case "coreConnection":
        // A page that loads while the core is gone would wait for an event sent before it listened (#130).
        return {
          closed: this.restarts?.disconnected() ?? false,
          restarting: this.restarts?.restarting() ?? false,
        };
    }
  }

  private async attach(windowId: number, sessionId: SessionId, size: TerminalSize): Promise<unknown> {
    const counts = this.attaching.get(sessionId) ?? new Map<number, number>();
    this.attaching.set(sessionId, counts);
    counts.set(windowId, (counts.get(windowId) ?? 0) + 1);
    const epoch = this.epochs.get(windowId) ?? 0;
    try {
      const { result, payload } = await this.core.request("session.attach", { sessionId, size });
      // The core's mark is exact, also for held events that arrive in a later read (issue #34). A 1.0 core sends
      // none; then everything this main numbered up to here counts as part of the snapshot (ADR 0006).
      const outputSeq = result.outputSeq ?? this.outputSeq.get(sessionId) ?? 0;
      this.views.set(result.viewId, { windowId, sessionId });
      if (!this.windows.has(windowId) || (this.epochs.get(windowId) ?? 0) !== epoch) {
        // The window closed or its renderer reloaded while the core attached; nobody can use this view.
        await this.detachView(result.viewId);
        throw new IpcError("closed", "Window closed or reloaded during attach");
      }
      return {
        viewId: result.viewId,
        size: result.size,
        ...(result.writerViewId === undefined ? {} : { writerViewId: result.writerViewId }),
        snapshot: payload,
        outputSeq,
      };
    } finally {
      // Events right behind the response are routed in the same turn, before this runs.
      const left = (counts.get(windowId) ?? 1) - 1;
      if (left > 0) counts.set(windowId, left);
      else counts.delete(windowId);
      // After the end of the connection a new attach may have its own counts already.
      if (counts.size === 0 && this.attaching.get(sessionId) === counts) this.attaching.delete(sessionId);
    }
  }

  private async detachView(viewId: ViewId): Promise<void> {
    this.views.delete(viewId);
    try {
      await this.core.request("session.detach", { viewId });
    } catch {
      // The view is gone for the window either way; a closed core has dropped it already.
    }
  }

  /** The core has dropped the views of the session (archive, delete): the window's later calls end in `not_found`. */
  private forgetViews(sessionId: SessionId): void {
    for (const [viewId, view] of this.views) if (view.sessionId === sessionId) this.views.delete(viewId);
  }

  private ownView(windowId: number, viewId: ViewId): void {
    if (this.sessionOf(windowId, viewId) === undefined)
      throw new IpcError("not_found", `View ${viewId} does not belong to this window`);
  }

  private toSession(sessionId: SessionId, event: BridgeEvent): void {
    const targets = new Set<number>(this.attaching.get(sessionId)?.keys());
    for (const view of this.views.values()) if (view.sessionId === sessionId) targets.add(view.windowId);
    for (const windowId of targets) this.windows.get(windowId)?.send(event);
  }

  private toAll(event: BridgeEvent): void {
    for (const window of this.windows.values()) window.send(event);
  }
}

function errorBody(error: unknown): BridgeErrorBody {
  if (error instanceof BadRequest) return { code: "bad_request", message: error.message };
  if (error instanceof IpcError) return { code: error.code, message: error.message };
  return { code: "internal", message: error instanceof Error ? error.message : "unknown error" };
}

// --- Runtime checks of renderer calls -------------------------------------------------------

function parseCall(raw: unknown): BridgeCall {
  if (!isRecord(raw)) throw new BadRequest("A call must be an object");
  switch (raw["method"]) {
    case "coreStatus":
      return { method: "coreStatus" };
    case "listSessions":
      return { method: "listSessions" };
    case "createSession":
      return { method: "createSession", params: createParams(raw["params"]) };
    case "attach":
      return { method: "attach", sessionId: text(raw["sessionId"], "sessionId"), size: size(raw["size"]) };
    case "detach":
      return { method: "detach", viewId: text(raw["viewId"], "viewId") };
    case "input":
      if (typeof raw["data"] !== "string") throw new BadRequest("data must be a string");
      return { method: "input", viewId: text(raw["viewId"], "viewId"), data: raw["data"] };
    case "resize":
      return { method: "resize", viewId: text(raw["viewId"], "viewId"), size: size(raw["size"]) };
    case "claimWriter":
      return { method: "claimWriter", viewId: text(raw["viewId"], "viewId") };
    case "listWorkspaces":
      return { method: "listWorkspaces" };
    case "createWorkspace":
      return { method: "createWorkspace", name: text(raw["name"], "name") };
    case "updateWorkspace":
      return {
        method: "updateWorkspace",
        workspaceId: text(raw["workspaceId"], "workspaceId"),
        name: text(raw["name"], "name"),
      };
    case "deleteWorkspace":
      return { method: "deleteWorkspace", workspaceId: text(raw["workspaceId"], "workspaceId") };
    case "createProject": {
      const backend = raw["backend"];
      if (backend !== "wsl" && backend !== "windows") throw new BadRequest("backend must be wsl or windows");
      return {
        method: "createProject",
        workspaceId: text(raw["workspaceId"], "workspaceId"),
        name: text(raw["name"], "name"),
        path: text(raw["path"], "path"),
        backend,
      };
    }
    case "updateProject":
      return {
        method: "updateProject",
        projectId: text(raw["projectId"], "projectId"),
        name: text(raw["name"], "name"),
      };
    case "deleteProject":
      return { method: "deleteProject", projectId: text(raw["projectId"], "projectId") };
    case "updateSession": {
      const call: Extract<BridgeCall, { method: "updateSession" }> = {
        method: "updateSession",
        sessionId: text(raw["sessionId"], "sessionId"),
      };
      // `undefined` counts as absent (a structured clone keeps the key), `null` is "ungrouped".
      if (raw["name"] !== undefined) call.name = text(raw["name"], "name");
      if (raw["workspaceId"] !== undefined)
        call.workspaceId = raw["workspaceId"] === null ? null : text(raw["workspaceId"], "workspaceId");
      if (call.name === undefined && call.workspaceId === undefined)
        throw new BadRequest("updateSession needs a name or a workspaceId");
      return call;
    }
    case "archiveSession":
      return { method: "archiveSession", sessionId: text(raw["sessionId"], "sessionId") };
    case "deleteSession":
      return { method: "deleteSession", sessionId: text(raw["sessionId"], "sessionId") };
    case "windowLayout":
      return { method: "windowLayout" };
    case "reportLayout":
      return { method: "reportLayout", window: layoutPart(raw["window"]) };
    case "answerQuit": {
      const choice = raw["choice"];
      if (choice !== "keepSessions" && choice !== "stopSessions" && choice !== "cancel")
        throw new BadRequest("choice must be keepSessions, stopSessions or cancel");
      if (typeof raw["remember"] !== "boolean") throw new BadRequest("remember must be a boolean");
      return {
        method: "answerQuit",
        requestId: text(raw["requestId"], "requestId"),
        choice,
        remember: raw["remember"],
      };
    }
    case "quitShown":
      return { method: "quitShown", requestId: text(raw["requestId"], "requestId") };
    case "searchHistory": {
      const query = text(raw["query"], "query");
      if (query.length > MAX_HISTORY_QUERY_LENGTH)
        throw new BadRequest(`query must not be longer than ${MAX_HISTORY_QUERY_LENGTH} characters`);
      const limit = raw["limit"];
      if (limit === undefined) return { method: "searchHistory", query };
      if (!isCount(limit, MAX_HISTORY_HITS))
        throw new BadRequest(`limit must be a whole number from 1 to ${MAX_HISTORY_HITS}`);
      return { method: "searchHistory", query, limit };
    }
    case "getSettings":
      return { method: "getSettings" };
    case "updateSettings":
      return {
        method: "updateSettings",
        settings: changeOf(raw["settings"], SETTINGS_KEYS, "settings") as SettingsPatch,
      };
    case "listProfiles":
      return { method: "listProfiles" };
    case "createProfile": {
      const profile = changeOf(raw["profile"], PROFILE_CREATE_KEYS, "profile");
      text(profile["name"], "profile.name");
      if (!isRecord(profile["launch"])) throw new BadRequest("profile.launch must be an object");
      return { method: "createProfile", profile: profile as unknown as ProfileCreateParams };
    }
    case "updateProfile":
      return {
        method: "updateProfile",
        profileId: text(raw["profileId"], "profileId"),
        change: changeOf(raw["change"], PROFILE_CHANGE_KEYS, "change") as ProfileChange,
      };
    case "deleteProfile":
      return { method: "deleteProfile", profileId: text(raw["profileId"], "profileId") };
    case "listDistros":
      return { method: "listDistros" };
    case "restartCore":
      return { method: "restartCore" };
    case "coreConnection":
      return { method: "coreConnection" };
    default:
      throw new BadRequest(`Unknown bridge call ${String(raw["method"])}`);
  }
}

/** Keys of `SettingsPatch`; the values are the core's to check. */
const SETTINGS_KEYS = [
  "defaultDistro",
  "defaultShell",
  "defaultCwd",
  "historyLimitBytes",
  "historyEnabledByDefault",
  "confirmQuitWhileRunning",
  "quitAction",
] as const satisfies readonly (keyof SettingsPatch)[];
const PROFILE_CHANGE_KEYS = [
  "name",
  "workspaceId",
  "projectId",
  "launch",
  "autostart",
  "loggingEnabled",
] as const satisfies readonly (keyof ProfileChange)[];
const PROFILE_CREATE_KEYS = PROFILE_CHANGE_KEYS satisfies readonly (keyof ProfileCreateParams)[];

/**
 * An object with only `allowed` keys and at least one set (a structured clone keeps `undefined` keys, which count
 * as absent). Shape only: the core checks the values with its guards.
 */
function changeOf(raw: unknown, allowed: readonly string[], name: string): Record<string, unknown> {
  if (!isRecord(raw)) throw new BadRequest(`${name} must be an object`);
  const present = Object.entries(raw).filter(([, value]) => value !== undefined);
  const unknown = present.find(([key]) => !allowed.includes(key));
  if (unknown !== undefined) throw new BadRequest(`${name}.${unknown[0]} is not allowed`);
  if (present.length === 0) throw new BadRequest(`${name} needs at least one change`);
  return Object.fromEntries(present);
}

const PART_KEYS = ["sidebarVisible", "sidebarWidth", "tabs", "activeTabId"];

/**
 * Shape only: what a renderer may report of its window. Id, position, size and maximization are the main
 * process's; the rest (limits, unique ids) is checked on the whole document by the coordinator.
 */
function layoutPart(raw: unknown): LayoutWindowPart {
  if (!isRecord(raw) || !Array.isArray(raw["tabs"])) throw new BadRequest("window needs tabs");
  const unknown = Object.keys(raw).find((key) => !PART_KEYS.includes(key));
  if (unknown !== undefined) throw new BadRequest(`window.${unknown} is not reported by a renderer`);
  return raw as unknown as LayoutWindowPart;
}

/** Shape only; the core checks the launch spec itself with its guards. */
function createParams(raw: unknown): SessionCreateParams {
  if (!isRecord(raw) || typeof raw["name"] !== "string" || !isRecord(raw["launch"]))
    throw new BadRequest("createSession needs name and launch");
  return raw as unknown as SessionCreateParams;
}

function size(raw: unknown): TerminalSize {
  if (!isRecord(raw)) throw new BadRequest("size must be an object");
  const { cols, rows } = raw;
  if (!isCount(cols, MAX_COLS) || !isCount(rows, MAX_ROWS))
    throw new BadRequest("size needs whole cols and rows above 0");
  return { cols, rows };
}

function text(raw: unknown, name: string): string {
  if (typeof raw !== "string" || raw.length === 0) throw new BadRequest(`${name} must be a non-empty string`);
  return raw;
}

function isCount(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
