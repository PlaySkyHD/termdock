// UI state of one window (ADR 0006): free of React and Electron, so tabs, splits (#27), key bindings (#28) and
// layout restore (#29) build on it. The window part has the shape of `LayoutWindow` with `LayoutTab`, so what is
// stored later is what is held here; the root of a tab is a pane tree (`PaneNode`) of 1 to 4 panes.
import type {
  CoreStatusResult,
  LayoutPane,
  LayoutSplit,
  LayoutTab,
  LayoutWindow,
  SessionId,
  SessionInfo,
  SessionState,
  SessionWarning,
  Workspace,
} from "@termdock/protocol";
import type { TransferItem, TransferSource } from "../shared/bridge.js";
import { applyMove, canMove } from "./layout-moves.js";
import { applyIncoming, takeOut, withoutIncoming, withoutTab } from "./window-transfer.js";
import type { MoveSource, MoveTarget } from "./layout-moves.js";
import {
  findNode,
  findPane,
  firstPane,
  insertAt,
  MAX_PANES,
  MAX_TABS,
  panesOf,
  removePane,
  replaceNode,
} from "./pane-tree.js";

export { MAX_PANES, MAX_TABS, paneCount, panesOf } from "./pane-tree.js";

/** Smallest share of a pane in a split when the caller names none. */
export const MIN_SHARE = 0.05;

export type SplitDirection = LayoutSplit["direction"];

export interface UiState {
  /** Sessions as the core reports them, oldest first. */
  readonly sessions: readonly SessionInfo[];
  /** The first list of sessions has arrived; before that a pane cannot tell a missing session from an unknown one. */
  readonly sessionsLoaded: boolean;
  /** Workspaces with their projects in the core's order (#63). */
  readonly workspaces: readonly Workspace[];
  readonly window: LayoutWindow;
  readonly coreStatus: CoreStatusResult | undefined;
  /** The connection to the core ended; until `coreRestarted` (#130). */
  readonly coreClosed: boolean;
  /** While `coreClosed`: the main process starts the core again; otherwise it waits for "Core neu starten". */
  readonly coreRestarting: boolean;
  /** Raised on every restart of the core: the panes mount and attach their views again (#130). */
  readonly coreGeneration: number;
  /** Sessions whose warning hint the user closed in this window, until their next start (#113). */
  readonly dismissedWarnings: readonly SessionId[];
}

export interface UiStoreOptions {
  /** Ids of window, tabs and panes; unique in the whole layout document. */
  newId: () => string;
}

export class UiStore {
  private state: UiState;
  private readonly listeners = new Set<() => void>();
  private readonly newId: () => string;

  constructor(options: UiStoreOptions) {
    this.newId = options.newId;
    this.state = {
      sessions: [],
      sessionsLoaded: false,
      workspaces: [],
      window: { id: options.newId(), sidebarVisible: true, tabs: [] },
      coreStatus: undefined,
      coreClosed: false,
      coreRestarting: false,
      coreGeneration: 0,
      dismissedWarnings: [],
    };
  }

  getState = (): UiState => this.state;

  /** For `useSyncExternalStore`; the returned function unsubscribes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  // --- Sessions -------------------------------------------------------------------------------

  /** `loaded: false` for a list that could not be fetched: the sessions are then unknown, not missing. */
  setSessions(sessions: readonly SessionInfo[], loaded = true): void {
    this.set({ sessions: byCreation(sessions), sessionsLoaded: loaded });
  }

  /** Takes over the window the main process holds for this one (layout restore, #29); id and tabs come from it. */
  loadWindow(window: LayoutWindow): void {
    this.setWindow(window);
  }

  /**
   * Adds the session unless its id is known. The event and the answer of `createSession` can arrive after
   * later state changes; a known session is at least as new as they are.
   */
  sessionCreated(session: SessionInfo): void {
    if (this.state.sessions.some((known) => known.id === session.id)) return;
    this.set({ sessions: byCreation([...this.state.sessions, session]) });
  }

  /**
   * `warnings` are those of the current run (#113) and replace the known ones; without them the session has none.
   * A new start (`Starting`) shows the warnings of its run again, even where the last ones were dismissed.
   */
  sessionStateChanged(
    sessionId: SessionId,
    state: SessionState,
    lastExitCode?: number,
    warnings?: readonly SessionWarning[],
  ): void {
    const known = this.state.sessions.find((session) => session.id === sessionId);
    if (!known) return;
    // A stale exit code does not belong to a session that runs again.
    const { lastExitCode: _old, warnings: _oldWarnings, ...rest } = known;
    const next: SessionInfo = {
      ...rest,
      state,
      ...(lastExitCode === undefined ? {} : { lastExitCode }),
      ...(warnings === undefined || warnings.length === 0 ? {} : { warnings: [...warnings] }),
    };
    const restarted = state === "Starting" && this.state.dismissedWarnings.includes(sessionId);
    this.set({
      sessions: this.state.sessions.map((session) => (session === known ? next : session)),
      ...(restarted
        ? { dismissedWarnings: this.state.dismissedWarnings.filter((id) => id !== sessionId) }
        : {}),
    });
  }

  /** Closes the warning hint of the session's run in this window (#113); it blocks nothing and stays closed. */
  dismissWarnings(sessionId: SessionId): void {
    if (this.state.dismissedWarnings.includes(sessionId)) return;
    this.set({ dismissedWarnings: [...this.state.dismissedWarnings, sessionId] });
  }

  /**
   * A session of the core changed its name, workspace or logging (`session.updated`, from any client). Only these
   * fields are taken: the state has its own events, and the update can be older than a state change that reached
   * the window first. An unknown session is added.
   */
  sessionUpdated(session: SessionInfo): void {
    if (!this.state.sessions.some((each) => each.id === session.id)) {
      this.sessionCreated(session);
      return;
    }
    this.mergeSessionUpdate(session);
  }

  /**
   * Like `sessionUpdated`, for the answer of `updateSession`: only a session the store knows. A late answer must not
   * bring back a session that `session.removed` has taken out meanwhile; adding is for events.
   */
  mergeSessionUpdate(session: SessionInfo): void {
    const known = this.state.sessions.find((each) => each.id === session.id);
    if (!known) return;
    const { workspaceId: _old, ...rest } = known;
    const next: SessionInfo = {
      ...rest,
      name: session.name,
      loggingEnabled: session.loggingEnabled,
      updatedAt: session.updatedAt,
      ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
    };
    this.set({ sessions: this.state.sessions.map((each) => (each === known ? next : each)) });
  }

  /** The session and its history are gone (`session.removed`); panes that show it fall back to the placeholder. */
  sessionRemoved(sessionId: SessionId): void {
    if (!this.state.sessions.some((session) => session.id === sessionId)) return;
    this.set({
      sessions: this.state.sessions.filter((session) => session.id !== sessionId),
      dismissedWarnings: this.state.dismissedWarnings.filter((id) => id !== sessionId),
    });
  }

  setWorkspaces(workspaces: readonly Workspace[]): void {
    this.set({ workspaces });
  }

  setCoreStatus(coreStatus: CoreStatusResult): void {
    this.set({ coreStatus });
  }

  markCoreClosed(restarting = false): void {
    this.set({ coreClosed: true, coreRestarting: restarting });
  }

  /**
   * The main process is connected to a core again (#130): the sessions as the new core lists them, and a new
   * generation, so every pane attaches again (panes of sessions that did not survive show their placeholder).
   */
  coreRestarted(sessions: readonly SessionInfo[]): void {
    this.set({
      sessions: byCreation(sessions),
      sessionsLoaded: true,
      coreClosed: false,
      coreRestarting: false,
      coreGeneration: this.state.coreGeneration + 1,
    });
  }

  // --- Tabs -----------------------------------------------------------------------------------

  /**
   * Shows the session in a tab: focuses the tab that has it, otherwise opens one (always, with `forceNew`).
   * Returns the tab, or undefined when the window is at the limit of tabs.
   */
  openSession(sessionId: SessionId, options: { forceNew?: boolean } = {}): string | undefined {
    const { tabs } = this.state.window;
    if (!options.forceNew) {
      // The active pane of a tab wins over another pane that shows the session too.
      const existing =
        tabs.find((tab) => tabSessionId(tab) === sessionId) ??
        tabs.find((tab) => panesOf(tab.root).some((pane) => pane.sessionId === sessionId));
      if (existing) {
        if (tabSessionId(existing) !== sessionId) {
          const pane = panesOf(existing.root).find((each) => each.sessionId === sessionId)!;
          this.focusPane(existing.id, pane.id);
        }
        this.focusTab(existing.id);
        return existing.id;
      }
    }
    if (tabs.length >= MAX_TABS) return undefined;
    const pane: LayoutPane = { kind: "pane", id: this.newId(), sessionId };
    const tab: LayoutTab = { id: this.newId(), root: pane, activePaneId: pane.id };
    this.setWindow({ ...this.state.window, tabs: [...tabs, tab], activeTabId: tab.id });
    return tab.id;
  }

  focusTab(tabId: string): void {
    const { window } = this.state;
    if (window.activeTabId === tabId || !window.tabs.some((tab) => tab.id === tabId)) return;
    this.setWindow({ ...window, activeTabId: tabId });
  }

  /** Closes the tab. When it was active, its right neighbour becomes active, or the left one for the last tab. */
  closeTab(tabId: string): void {
    const { window } = this.state;
    const next = withoutTab(window, tabId);
    if (next !== window) this.setWindow(next);
  }

  // --- Moves between windows (#68) -----------------------------------------------------------

  /**
   * Puts a tab or pane of another window in at `target` with new ids (`applyIncoming`). Returns the new panes, each
   * with its pane in the source, or undefined when the move is not allowed (nothing changes then).
   */
  receive(item: TransferItem, target: MoveTarget): Record<string, string> | undefined {
    const result = applyIncoming(this.state.window, item, target, this.newId);
    if (!result) return undefined;
    this.setWindow(result.window);
    return result.panes;
  }

  /** Whether `receive` would put the item in; changes nothing. */
  canReceive(item: TransferItem, target: MoveTarget): boolean {
    return applyIncoming(this.state.window, item, target, () => "probe") !== undefined;
  }

  /** Takes out the panes of a move into this window that was cancelled; their views detach. */
  dropIncoming(paneIds: readonly string[]): void {
    const { window } = this.state;
    const next = withoutIncoming(window, paneIds);
    if (next !== window) this.setWindow(next);
  }

  /** The other window holds the tab or pane now: it leaves this one, and its views detach. */
  takeOut(source: TransferSource): void {
    const { window } = this.state;
    const next = takeOut(window, source);
    if (next !== window) this.setWindow(next);
  }

  // --- Panes ----------------------------------------------------------------------------------

  /**
   * Splits the pane: the new pane shows `sessionId` right of it (`row`) or below it (`column`). It becomes active
   * when it shows another session. Returns the new pane, or undefined when the pane is unknown or the tab is full.
   */
  splitPane(
    tabId: string,
    paneId: string,
    direction: SplitDirection,
    sessionId: SessionId,
  ): string | undefined {
    const tab = this.state.window.tabs.find((each) => each.id === tabId);
    if (!tab || !findPane(tab.root, paneId) || panesOf(tab.root).length >= MAX_PANES) return undefined;
    const added: LayoutPane = { kind: "pane", id: this.newId(), sessionId };
    // Three columns instead of a column inside a column: the pane hands half of its share to the new one.
    const root = insertAt(tab.root, paneId, direction === "row" ? "right" : "bottom", added, this.newId);
    // A second view of the same session reads; the writing pane keeps the focus so typing goes on.
    const sameSession = findPane(tab.root, paneId)!.sessionId === sessionId;
    this.setTab({ ...tab, root, activePaneId: sameSession ? paneId : added.id });
    return added.id;
  }

  /**
   * Closes the pane. Its siblings share its space; a split left with one child gives way to that child. The last
   * pane closes the tab. When the pane was active, the pane that moves into its place becomes active.
   */
  closePane(tabId: string, paneId: string): void {
    const tab = this.state.window.tabs.find((each) => each.id === tabId);
    if (!tab || !findPane(tab.root, paneId)) return;
    const rest = removePane(tab, paneId);
    if (rest) this.setTab(rest);
    else this.closeTab(tabId);
  }

  /**
   * Arranges tabs and panes (#67): moves a tab, a pane or a session of the sidebar to a zone of a pane or to the
   * tab bar (`applyMove`). Panes keep their ids, so their views stay attached. Returns whether anything changed.
   */
  move(source: MoveSource, target: MoveTarget): boolean {
    const window = applyMove(this.state.window, source, target, this.newId);
    if (!window) return false;
    this.setWindow(window);
    return true;
  }

  /** Whether `move` would change something; changes nothing. */
  canMove(source: MoveSource, target: MoveTarget): boolean {
    return canMove(this.state.window, source, target);
  }

  /**
   * Moves the divider between child `index` and `index + 1` of the split by `delta` (a share of the split). Both
   * children keep at least `minShare`; the other shares and the sum stay as they are.
   */
  moveDivider(tabId: string, splitId: string, index: number, delta: number, minShare = MIN_SHARE): void {
    const tab = this.state.window.tabs.find((each) => each.id === tabId);
    const split = tab && findNode(tab.root, splitId);
    if (!tab || split?.kind !== "split" || index < 0 || index + 1 >= split.children.length) return;
    const pair = split.sizes[index]! + split.sizes[index + 1]!;
    if (pair < 2 * minShare) return;
    let first = split.sizes[index]! + delta;
    // The side that hits the minimum gets it exactly, so a divider at the edge stays put.
    if (first < minShare) first = minShare;
    else if (pair - first < minShare) first = pair - minShare;
    const second = first === pair - minShare ? minShare : pair - first;
    if (first === split.sizes[index] && second === split.sizes[index + 1]) return;
    const sizes = split.sizes.toSpliced(index, 2, first, second);
    this.setTab({ ...tab, root: replaceNode(tab.root, splitId, () => ({ ...split, sizes })) });
  }

  focusPane(tabId: string, paneId: string): void {
    const tab = this.state.window.tabs.find((each) => each.id === tabId);
    if (!tab || tab.activePaneId === paneId || !findPane(tab.root, paneId)) return;
    this.setTab({ ...tab, activePaneId: paneId });
  }

  // --- Sidebar --------------------------------------------------------------------------------

  toggleSidebar(): void {
    this.setWindow({ ...this.state.window, sidebarVisible: !(this.state.window.sidebarVisible ?? true) });
  }

  private setTab(tab: LayoutTab): void {
    const { window } = this.state;
    this.setWindow({ ...window, tabs: window.tabs.map((each) => (each.id === tab.id ? tab : each)) });
  }

  private setWindow(window: LayoutWindow): void {
    this.set({ window });
  }

  private set(change: Partial<UiState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of [...this.listeners]) listener();
  }
}

/** The tab of the active window, or undefined without tabs. */
export function activeTab(state: UiState): LayoutTab | undefined {
  return state.window.tabs.find((tab) => tab.id === state.window.activeTabId);
}

/** Session of the tab's active pane: title of the tab, marked entry of the sidebar. */
export function tabSessionId(tab: LayoutTab): SessionId | undefined {
  return findPane(tab.root, tab.activePaneId)?.sessionId ?? firstPane(tab.root).sessionId;
}

function byCreation(sessions: readonly SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
