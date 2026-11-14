// Connects the bridge to the UI store of a window (ADR 0006): lists the sessions, asks for the core status and
// keeps the store current from `stateChanged` and `sessionCreated` events. Free of React and Electron.
import type { SessionId, SessionInfo, SessionState } from "@termdock/protocol";
import type { BridgeEvent, TermdockApi } from "../shared/bridge.js";
import type { UiStore } from "./ui-store.js";

type Api = Pick<TermdockApi, "onEvent" | "listSessions" | "coreStatus">;

interface StateChange {
  sessionId: SessionId;
  state: SessionState;
  lastExitCode?: number;
}

export interface StoreConnection {
  /** Settles when the list and the status are in the store (or have failed); never rejects. */
  ready: Promise<void>;
  dispose(): void;
}

/** Waits before the retries of a failed first list. */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 8_000];

export interface ConnectOptions {
  retryDelaysMs?: readonly number[];
  sleep?(ms: number): Promise<void>;
}

/**
 * Subscribes first, then lists. Events that arrive before the list is answered are kept and applied on top of
 * it: a session created meanwhile is added unless the list has it, a state change is applied to listed sessions.
 * The core sends `stateChanged` to this client only after the first `session.list` (ADR 0006), so the list
 * also switches that stream on.
 */
export function connectStore(
  store: UiStore,
  api: Api,
  onError: (message: string) => void,
  options: ConnectOptions = {},
): StoreConnection {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let listed = false;
  let disposed = false;
  const created: SessionInfo[] = [];
  const changes: StateChange[] = [];

  const off = api.onEvent((event: BridgeEvent) => {
    switch (event.kind) {
      case "sessionCreated":
        if (listed) store.sessionCreated(event.session);
        else created.push(event.session);
        return;
      case "stateChanged": {
        const { kind: _kind, ...change } = event;
        if (listed) store.sessionStateChanged(change.sessionId, change.state, change.lastExitCode);
        else changes.push(change);
        return;
      }
      case "coreClosed":
        store.markCoreClosed();
        return;
      case "output":
      case "resized":
      case "writerChanged":
        return;
    }
  });

  /**
   * The first list failed. Tries again with growing waits; a list that arrives is merged into what the events have
   * put into the store. When every try fails the sessions count as loaded anyway (and empty): panes of unknown
   * sessions then show the placeholder with "Pane schließen" instead of waiting for ever (#29).
   */
  const retryList = async (): Promise<void> => {
    for (const wait of options.retryDelaysMs ?? RETRY_DELAYS_MS) {
      await sleep(wait);
      if (disposed) return;
      try {
        const sessions = await api.listSessions();
        if (disposed) return;
        for (const session of sessions) {
          if (store.getState().sessions.some((known) => known.id === session.id))
            store.sessionStateChanged(session.id, session.state, session.lastExitCode);
          else store.sessionCreated(session);
        }
        store.setSessions(store.getState().sessions, true);
        return;
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      }
    }
    if (!disposed) store.setSessions(store.getState().sessions, true);
  };

  const ready = (async () => {
    let sessions: SessionInfo[] = [];
    let loaded = true;
    try {
      sessions = await api.listSessions();
    } catch (error) {
      loaded = false;
      onError(error instanceof Error ? error.message : String(error));
    }
    // A disposed connection must not overwrite what a newer one has put into the store (StrictMode, reload).
    if (disposed) return;
    // From here on, to the end of this block, nothing can interleave: events go straight to the store after it.
    store.setSessions(sessions, loaded);
    const known = new Set(sessions.map((session) => session.id));
    for (const session of created) if (!known.has(session.id)) store.sessionCreated(session);
    for (const change of changes)
      store.sessionStateChanged(change.sessionId, change.state, change.lastExitCode);
    listed = true;
    created.length = 0;
    changes.length = 0;
    if (!loaded) void retryList();
    try {
      const status = await api.coreStatus();
      if (!disposed) store.setCoreStatus(status);
    } catch {
      // Without the status the bar just shows no hint; the list is what the user needs.
    }
  })();

  return {
    ready,
    dispose: () => {
      disposed = true;
      off();
    },
  };
}
