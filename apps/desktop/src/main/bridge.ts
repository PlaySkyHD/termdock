// Main side of the bridge (ADR 0002, ADR 0006): checks every renderer call, keeps which window owns which view
// and routes core events to the windows that show the session. Free of Electron so it runs in tests.
import { IpcError } from "@termdock/core";
import type { Disposable } from "@termdock/core";
import type { SessionCreateParams, SessionId, TerminalSize, ViewId } from "@termdock/protocol";
import type { BridgeCall, BridgeErrorBody, BridgeEvent, BridgeResult } from "../shared/bridge.js";
import type { CorePort } from "./core-connection.js";

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

  constructor(private readonly core: CorePort) {
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
      core.on("session.stateChanged", ({ sessionId, state, lastExitCode }) =>
        this.toAll({
          kind: "stateChanged",
          sessionId,
          state,
          ...(lastExitCode === undefined ? {} : { lastExitCode }),
        }),
      ),
      core.onClose(() => this.toAll({ kind: "coreClosed" })),
    ];
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
        const { session } = (await core.request("session.create", call.params)).result;
        // The core has no event for new sessions; every window's sidebar learns about it from here.
        this.toAll({ kind: "sessionCreated", session });
        return session;
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
      if (counts.size === 0) this.attaching.delete(sessionId);
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
    default:
      throw new BadRequest(`Unknown bridge call ${String(raw["method"])}`);
  }
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
