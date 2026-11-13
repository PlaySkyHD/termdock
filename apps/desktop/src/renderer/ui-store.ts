// UI state of one window (ADR 0006): free of React and Electron, so tabs, splits (#27), key bindings (#28) and
// layout restore (#29) build on it. The window part has the shape of `LayoutWindow` with `LayoutTab`, so what is
// stored later is what is held here; the root of a tab is a pane tree (`PaneNode`) of 1 to 4 panes.
import type {
  CoreStatusResult,
  LayoutPane,
  LayoutSplit,
  LayoutTab,
  LayoutWindow,
  PaneNode,
  SessionId,
  SessionInfo,
  SessionState,
} from "@termdock/protocol";

/** `MAX_TABS_PER_WINDOW` of the protocol; a test keeps them equal (the renderer imports only types). */
export const MAX_TABS = 64;

/** `MAX_PANES_PER_TAB` of the protocol; a test keeps them equal. */
export const MAX_PANES = 4;

/** Smallest share of a pane in a split when the caller names none. */
export const MIN_SHARE = 0.05;

export type SplitDirection = LayoutSplit["direction"];

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
    const index = window.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const tabs = window.tabs.filter((tab) => tab.id !== tabId);
    const { activeTabId: _active, ...rest } = window;
    const activeTabId =
      window.activeTabId === tabId ? (tabs[index] ?? tabs[index - 1])?.id : window.activeTabId;
    this.setWindow({ ...rest, tabs, ...(activeTabId === undefined ? {} : { activeTabId }) });
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
    if (!tab || !findPane(tab.root, paneId) || paneCount(tab) >= MAX_PANES) return undefined;
    const added: LayoutPane = { kind: "pane", id: this.newId(), sessionId };
    const parent = parentOf(tab.root, paneId);
    const root =
      parent?.direction === direction
        ? // Three columns instead of a column inside a column: the pane hands half of its share to the new one.
          replaceNode(tab.root, parent.id, () => {
            const index = parent.children.findIndex((child) => child.id === paneId);
            const half = parent.sizes[index]! / 2;
            return {
              ...parent,
              children: parent.children.toSpliced(index + 1, 0, added),
              sizes: parent.sizes.toSpliced(index, 1, half, half),
            };
          })
        : replaceNode(tab.root, paneId, (pane) => ({
            kind: "split",
            id: this.newId(),
            direction,
            children: [pane, added],
            sizes: [0.5, 0.5],
          }));
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
    if (tab.root.kind === "pane") {
      this.closeTab(tabId);
      return;
    }
    const parent = parentOf(tab.root, paneId)!;
    const index = parent.children.findIndex((child) => child.id === paneId);
    const children = parent.children.toSpliced(index, 1);
    const rest = parent.sizes.toSpliced(index, 1);
    const total = rest.reduce((sum, size) => sum + size, 0);
    const replacement: PaneNode =
      children.length === 1 ? children[0]! : { ...parent, children, sizes: rest.map((size) => size / total) };
    // A split that gives way to its last child can leave a row inside a row; merge it into its parent.
    const root = mergeSameDirection(replaceNode(tab.root, parent.id, () => replacement));
    const successor = children[index] ?? children[index - 1]!;
    const activePaneId = tab.activePaneId === paneId ? firstPane(successor)!.id : tab.activePaneId;
    this.setTab({ ...tab, root, activePaneId });
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
  return paneSession(tab.root, tab.activePaneId) ?? firstPane(tab.root)?.sessionId;
}

function paneSession(node: PaneNode, paneId: string): SessionId | undefined {
  return findPane(node, paneId)?.sessionId;
}

/**
 * The tree without a split directly inside a split of the same direction: the inner children take its place,
 * each with its share of the inner split times the inner split's share. Unchanged branches keep their identity.
 */
function mergeSameDirection(node: PaneNode): PaneNode {
  if (node.kind === "pane") return node;
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  let changed = false;
  node.children.forEach((original, index) => {
    const child = mergeSameDirection(original);
    const share = node.sizes[index]!;
    if (child !== original) changed = true;
    if (child.kind === "split" && child.direction === node.direction) {
      changed = true;
      children.push(...child.children);
      sizes.push(...child.sizes.map((size) => size * share));
    } else {
      children.push(child);
      sizes.push(share);
    }
  });
  return changed ? { ...node, children, sizes } : node;
}

function firstPane(node: PaneNode): LayoutPane | undefined {
  return node.kind === "pane" ? node : firstPane(node.children[0]!);
}

/** Number of panes of the tab (1 to `MAX_PANES`). */
export function paneCount(tab: LayoutTab): number {
  return panesOf(tab.root).length;
}

/** The panes of the tree, left to right and top to bottom. */
export function panesOf(node: PaneNode): LayoutPane[] {
  return node.kind === "pane" ? [node] : node.children.flatMap(panesOf);
}

/** The split that has the node `id` as a direct child; undefined for the root. */
function parentOf(node: PaneNode, id: string): LayoutSplit | undefined {
  if (node.kind === "pane") return undefined;
  if (node.children.some((child) => child.id === id)) return node;
  for (const child of node.children) {
    const found = parentOf(child, id);
    if (found) return found;
  }
  return undefined;
}

function findNode(node: PaneNode, id: string): PaneNode | undefined {
  if (node.id === id) return node;
  if (node.kind === "pane") return undefined;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

function findPane(node: PaneNode, paneId: string): LayoutPane | undefined {
  const found = findNode(node, paneId);
  return found?.kind === "pane" ? found : undefined;
}

/** The tree with the node `id` replaced by `replace(node)`; untouched branches keep their identity. */
function replaceNode(node: PaneNode, id: string, replace: (node: PaneNode) => PaneNode): PaneNode {
  if (node.id === id) return replace(node);
  if (node.kind === "pane") return node;
  const children = node.children.map((child) => replaceNode(child, id, replace));
  return children.every((child, index) => child === node.children[index]) ? node : { ...node, children };
}

function byCreation(sessions: readonly SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
