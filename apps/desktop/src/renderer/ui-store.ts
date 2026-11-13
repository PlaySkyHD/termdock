// UI state of one window (ADR 0006): free of React and Electron, so tabs, splits (#27), key bindings (#28) and
// layout restore (#29) build on it. The window part has the shape of `LayoutWindow` with `LayoutTab`, so what is
// stored later is what is held here; in this change every tab has exactly one pane.
import type {
  CoreStatusResult,
  LayoutPane,
  LayoutTab,
  LayoutWindow,
  PaneNode,
  SessionId,
  SessionInfo,
  SessionState,
} from "@termdock/protocol";

/** `MAX_TABS_PER_WINDOW` of the protocol; a test keeps them equal (the renderer imports only types). */
export const MAX_TABS = 64;

export interface UiState {
  /** Sessions as the core reports them, oldest first. */
  readonly sessions: readonly SessionInfo[];
  readonly window: LayoutWindow;
  readonly coreStatus: CoreStatusResult | undefined;
  /** The connection to the core ended; final. */
  readonly coreClosed: boolean;
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
      window: { id: options.newId(), sidebarVisible: true, tabs: [] },
      coreStatus: undefined,
      coreClosed: false,
    };
  }

  getState = (): UiState => this.state;

  /** For `useSyncExternalStore`; the returned function unsubscribes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  // --- Sessions -------------------------------------------------------------------------------

  setSessions(sessions: readonly SessionInfo[]): void {
    this.set({ sessions: byCreation(sessions) });
  }

  /**
   * Adds the session unless its id is known. The event and the answer of `createSession` can arrive after
   * later state changes; a known session is at least as new as they are.
   */
  sessionCreated(session: SessionInfo): void {
    if (this.state.sessions.some((known) => known.id === session.id)) return;
    this.set({ sessions: byCreation([...this.state.sessions, session]) });
  }

  sessionStateChanged(sessionId: SessionId, state: SessionState, lastExitCode?: number): void {
    const known = this.state.sessions.find((session) => session.id === sessionId);
    if (!known) return;
    // A stale exit code does not belong to a session that runs again.
    const { lastExitCode: _old, ...rest } = known;
    const next: SessionInfo = { ...rest, state, ...(lastExitCode === undefined ? {} : { lastExitCode }) };
    this.set({ sessions: this.state.sessions.map((session) => (session === known ? next : session)) });
  }

  setCoreStatus(coreStatus: CoreStatusResult): void {
    this.set({ coreStatus });
  }

  markCoreClosed(): void {
    this.set({ coreClosed: true });
  }

  // --- Tabs -----------------------------------------------------------------------------------

  /**
   * Shows the session in a tab: focuses the tab that has it, otherwise opens one (always, with `forceNew`).
   * Returns the tab, or undefined when the window is at the limit of tabs.
   */
  openSession(sessionId: SessionId, options: { forceNew?: boolean } = {}): string | undefined {
    const { tabs } = this.state.window;
    if (!options.forceNew) {
      const existing = tabs.find((tab) => tabSessionId(tab) === sessionId);
      if (existing) {
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
    const index = window.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const tabs = window.tabs.filter((tab) => tab.id !== tabId);
    const { activeTabId: _active, ...rest } = window;
    const activeTabId =
      window.activeTabId === tabId ? (tabs[index] ?? tabs[index - 1])?.id : window.activeTabId;
    this.setWindow({ ...rest, tabs, ...(activeTabId === undefined ? {} : { activeTabId }) });
  }

  // --- Sidebar --------------------------------------------------------------------------------

  toggleSidebar(): void {
    this.setWindow({ ...this.state.window, sidebarVisible: !(this.state.window.sidebarVisible ?? true) });
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

/** Session of the tab's active pane (with one pane per tab: its only pane). */
export function tabSessionId(tab: LayoutTab): SessionId | undefined {
  return paneSession(tab.root, tab.activePaneId) ?? firstPane(tab.root)?.sessionId;
}

function paneSession(node: PaneNode, paneId: string): SessionId | undefined {
  if (node.kind === "pane") return node.id === paneId ? node.sessionId : undefined;
  for (const child of node.children) {
    const found = paneSession(child, paneId);
    if (found !== undefined) return found;
  }
  return undefined;
}

function firstPane(node: PaneNode): LayoutPane | undefined {
  return node.kind === "pane" ? node : firstPane(node.children[0]!);
}

function byCreation(sessions: readonly SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
