// Window content: sidebar, tab bar, the panes of every tab with one terminal view each, and the status bar
// (ADR 0006). All tabs of the window stay mounted and attached; the inactive ones are only hidden.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { LaunchSpec, SessionId } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  canRun,
  panesFull,
  pasteInto,
  runCommand,
  splitActivePane,
  startProjectSession,
} from "./commands.js";
import { ContextMenu } from "./ContextMenu.js";
import { DragProvider, useDropHandler } from "./drag/DragProvider.js";
import type { DragPayload } from "./drag/drag-model.js";
import { dropSource, dropTarget } from "./layout-drop.js";
import { paneMenu, sessionPlaceEntries, tabMenu } from "./layout-menus.js";
import type { LayoutAction } from "./layout-menus.js";
import { tabOfPane } from "./layout-moves.js";
import type { MoveSource, MoveTarget } from "./layout-moves.js";
import type { MenuEntry } from "./sidebar-model.js";
import type { CommandDeps } from "./commands.js";
import { handleKey, resolveKey } from "./keymap.js";
import type { KeyCommands } from "./keymap.js";
import { startLayoutSync } from "./layout-sync.js";
import { PaneTree } from "./PaneTree.js";
import { coreHints } from "./session-display.js";
import { connectStore } from "./session-sync.js";
import { QuitDialog } from "./QuitDialog.js";
import { SearchDialog } from "./SearchDialog.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { modalOpen } from "./dialog-state.js";
import { ShortcutsDialog } from "./ShortcutsDialog.js";
import { Sidebar } from "./Sidebar.js";
import { SnapBar } from "./SnapBar.js";
import type { OpenMode, SidebarActions } from "./Sidebar.js";
import { StatusBar } from "./StatusBar.js";
import { TabBar } from "./TabBar.js";
import type { TerminalController, ViewStatus } from "./terminal-controller.js";
import { activeTab, MAX_PANES, MAX_TABS, paneCount, tabSessionId, UiStore } from "./ui-store.js";
import type { SplitDirection } from "./ui-store.js";

/** How long the note "Core neu gestartet" stays (#130). */
const CORE_RESTARTED_NOTE_MS = 4_000;

export function App({ api }: { api: TermdockApi }) {
  const store = useMemo(() => new UiStore({ newId: () => crypto.randomUUID() }), []);
  const state = useSyncExternalStore(store.subscribe, store.getState);
  // Views by pane id.
  const [statuses, setStatuses] = useState<Record<string, ViewStatus>>({});
  const controllers = useRef(new Map<string, TerminalController>());
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  // The window of the main process (restored layout, #29) is in the store; until then the page shows nothing.
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const connection = connectStore(store, api, setLoadError);
    return connection.dispose;
  }, [store, api]);

  useEffect(() => {
    const sync = startLayoutSync(store, api, (message) => console.error(`termdock layout: ${message}`));
    let current = true;
    void sync.ready.then(() => current && setRestored(true));
    // A report that still waits for its delay goes out when the page goes away (window closed, reload).
    window.addEventListener("pagehide", sync.flush);
    return () => {
      current = false;
      window.removeEventListener("pagehide", sync.flush);
      sync.dispose();
    };
  }, [store, api]);

  // Creating a session and its error live here, not in the form: hiding the sidebar unmounts the form, and a
  // create in flight must neither be started twice nor lose its error.
  const [creating, setCreating] = useState(false);
  const creatingNow = useRef(false);
  const [createError, setCreateError] = useState<string>();
  // Raised by clicks that leave the focus on a button; the active terminal takes it back.
  const [focusSignal, setFocusSignal] = useState(0);
  const refocus = useCallback(() => setFocusSignal((signal) => signal + 1), []);

  /**
   * Shift+click in the sidebar: the active pane splits to the right and the new pane shows `sessionId`. With the
   * same session the new view reads, so the writing pane stays active and keeps the focus (the store decides,
   * `splitPane`). The keys and buttons start a new session instead (`splitActivePane`, #66).
   */
  const split = useCallback(
    (direction: SplitDirection, sessionId: SessionId) => {
      const tab = activeTab(store.getState());
      if (!tab) return;
      const paneId = store.splitPane(tab.id, tab.activePaneId, direction, sessionId);
      setNotice(paneId === undefined ? panesFull(MAX_PANES) : undefined);
      refocus();
    },
    [store, refocus],
  );

  const open = useCallback(
    (sessionId: SessionId, mode: OpenMode) => {
      if (mode === "split" && activeTab(store.getState())) {
        split("row", sessionId);
        return;
      }
      const tabId = store.openSession(sessionId, { forceNew: mode === "newTab" });
      setNotice(tabId === undefined ? `Höchstens ${MAX_TABS} Tabs je Fenster` : undefined);
      refocus();
    },
    [store, refocus, split],
  );

  const create = useCallback(
    (name: string, launch: LaunchSpec) => {
      if (creatingNow.current) return;
      creatingNow.current = true;
      setCreating(true);
      setCreateError(undefined);
      api
        .createSession({ name, launch })
        .then(
          (session) => {
            // The event of the main process may have added the session already; the store keeps what it has.
            store.sessionCreated(session);
            setFormOpen(false);
            open(session.id, "tab");
          },
          (failure: unknown) => setCreateError(failure instanceof Error ? failure.message : String(failure)),
        )
        .finally(() => {
          creatingNow.current = false;
          setCreating(false);
        });
    },
    [api, store, open],
  );

  // What the sidebar may ask of the core (#63). The windows learn the outcome from the core's events; a session
  // that comes back in an answer is merged on top, which is idempotent (metadata only, the state is the events').
  const sidebarActions = useMemo<SidebarActions>(
    () => ({
      moveSession: async (sessionId, workspaceId) =>
        store.mergeSessionUpdate(await api.updateSession(sessionId, { workspaceId })),
      renameSession: async (sessionId, name) =>
        store.mergeSessionUpdate(await api.updateSession(sessionId, { name })),
      archiveSession: (sessionId) => api.archiveSession(sessionId),
      restartSession: (sessionId) => api.restartSession(sessionId),
      deleteSession: async (sessionId) => {
        await api.deleteSession(sessionId);
        store.sessionRemoved(sessionId);
      },
      createWorkspace: (name) => api.createWorkspace(name),
      renameWorkspace: (workspaceId, name) => api.updateWorkspace(workspaceId, name),
      deleteWorkspace: (workspaceId) => api.deleteWorkspace(workspaceId),
      createProject: (workspaceId, name, path, backend) =>
        api.createProject(workspaceId, name, path, backend),
      renameProject: (projectId, name) => api.updateProject(projectId, name),
      deleteProject: (projectId) => api.deleteProject(projectId),
      startProjectSession: (project, mode) =>
        startProjectSession(
          { store, createSession: (params) => api.createSession(params), open },
          project,
          mode,
        ),
    }),
    [api, store, open],
  );

  const setStatus = useCallback((paneId: string, status: ViewStatus | undefined) => {
    setStatuses((current) => {
      if (status === undefined) {
        const { [paneId]: _gone, ...rest } = current;
        return rest;
      }
      return { ...current, [paneId]: status };
    });
  }, []);

  const setController = useCallback((paneId: string, controller: TerminalController | undefined) => {
    if (controller) controllers.current.set(paneId, controller);
    else controllers.current.delete(paneId);
  }, []);

  const tab = activeTab(state);
  const activeSessionId = tab && tabSessionId(tab);
  const activeSession = state.sessions.find((session) => session.id === activeSessionId);
  const activeView = tab ? statuses[tab.activePaneId] : undefined;
  const { sidebarVisible = true, tabs } = state.window;

  const showForm = (): void => {
    if (!sidebarVisible) store.toggleSidebar();
    setFormOpen(true);
  };

  // Key bindings (#28): the terminal hands bound keys to `run` (attachCustomKeyEventHandler), the window catches
  // them while the focus is elsewhere (sidebar, empty window). The latest closures are read through the ref.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // The history search (#62, Ctrl+Shift+F) is a dialog like the overview; only one of them is open.
  const [searchOpen, setSearchOpen] = useState(false);
  // The main process asks this window to show the quit dialog (#60); it answers once.
  const [quit, setQuit] = useState<{ requestId: string; activeSessions: number; windowsSessions: number }>();
  useEffect(
    () =>
      api.onEvent((event) => {
        // The main process repeats a question until it is confirmed; one that is answered stays answered.
        if (event.kind === "quitRequested" && !answeredQuits.current.has(event.requestId))
          setQuit((open) =>
            open?.requestId === event.requestId
              ? open
              : {
                  requestId: event.requestId,
                  activeSessions: event.activeSessions,
                  windowsSessions: event.windowsSessions ?? 0,
                },
          );
      }),
    [api],
  );
  const answeredQuits = useRef(new Set<string>());
  // The settings dialog (#64): Ctrl+, (key map) or the menu entry of the main process, in the focused window.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => {
    setShortcutsOpen(false);
    setSearchOpen(false);
    setSettingsOpen(true);
  }, []);
  useEffect(
    () =>
      api.onEvent((event) => {
        // The quit dialog is modal too and wins: the app is about to quit.
        if (event.kind === "quitRequested") setSettingsOpen(false);
        // Like the keys, which never reach a command while a modal dialog has the focus: no second dialog.
        else if (event.kind === "openSettings" && !quitOpenRef.current && !modalOpen(document))
          openSettings();
      }),
    [api, openSettings],
  );
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    refocus();
  }, [refocus]);
  // The dialog confirms to the main process that it is shown; without that the question is cancelled there.
  const quitRequestId = quit?.requestId;
  useEffect(() => {
    if (quitRequestId !== undefined)
      api.quitShown(quitRequestId).catch((error: unknown) => console.error(error));
  }, [api, quitRequestId]);
  const commandDeps: CommandDeps = {
    store,
    clipboard: navigator.clipboard,
    activeController: () => (tab ? controllers.current.get(tab.activePaneId) : undefined),
    createSession: (params) => api.createSession(params),
    showForm,
    shortcutsOpen,
    toggleShortcuts: () => {
      setShortcutsOpen(!shortcutsOpen);
      // Closing by key gives the terminal the focus back, like Escape and the button do.
      if (shortcutsOpen) refocus();
    },
    searchOpen,
    toggleSearch: () => {
      setSearchOpen(!searchOpen);
      if (searchOpen) refocus();
    },
    openSettings,
    notify: setNotice,
    refocus,
  };
  const commandRef = useRef(commandDeps);
  commandRef.current = commandDeps;
  // The quit dialog (#60) is modal: while it is open no key binding of the window runs.
  const quitOpenRef = useRef(false);
  quitOpenRef.current = quit !== undefined;
  const keyCommands = useMemo<KeyCommands>(
    () => ({
      applies: (command) => !quitOpenRef.current && canRun(command, commandRef.current),
      run: (command) => void runCommand(command, commandRef.current),
    }),
    [],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // The terminal has handled a bound key already (and prevented it).
      if (event.defaultPrevented || quitOpenRef.current) return;
      // The dialogs and menus of the sidebar (#63) are modal too: their keys are theirs.
      if (event.target instanceof Element && event.target.closest('[aria-modal="true"], [role="menu"]'))
        return;
      // The form's fields keep copy and paste.
      const command = resolveKey(event);
      if ((command === "copy" || command === "paste") && isTextField(event.target)) return;
      handleKey(event, keyCommands);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keyCommands]);

  /** A move of tabs and panes (#67), by drop or menu: the terminal of the active pane takes the focus afterwards. */
  const arrange = (source: MoveSource, target: MoveTarget): void => {
    if (store.move(source, target)) setNotice(undefined);
    refocus();
  };

  // Menus of tabs and panes (#67); the sidebar has its own.
  const [layoutMenu, setLayoutMenu] = useState<{
    x: number;
    y: number;
    label: string;
    entries: MenuEntry<() => void>[];
    opener: HTMLElement | null;
  }>();
  const openLayoutMenu = (
    event: ReactMouseEvent<HTMLElement>,
    label: string,
    entries: readonly MenuEntry<LayoutAction>[],
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    if (entries.length === 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    // The menu key, Shift+F10 and Enter send the event without a pointer position: beside the element.
    const fromKeyboard =
      event.type === "click" ? event.detail === 0 : event.clientX === 0 && event.clientY === 0;
    setLayoutMenu({
      x: fromKeyboard ? box.left + 12 : event.clientX,
      y: fromKeyboard ? box.bottom : event.clientY,
      label,
      opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      entries: entries.map((entry) => ({
        ...entry,
        action: () => {
          const action = entry.action;
          if (action.kind === "move") arrange(action.source, action.target);
          else if (action.kind === "closeTab") {
            store.closeTab(action.tabId);
            refocus();
          } else {
            const owner = tabOfPane(store.getState().window, action.paneId);
            if (owner) store.closePane(owner.id, action.paneId);
            refocus();
          }
        },
      })),
    });
  };

  // The tab area: the bar of layout patterns opens at its top edge (#78).
  const tabPanels = useRef<HTMLDivElement>(null);

  // Restart of the core (#130): the button once the automatic restarts gave up, and a short note after a restart.
  const restartCore =
    state.coreClosed && !state.coreRestarting
      ? () => void api.restartCore().catch((error: unknown) => console.error(error))
      : undefined;
  const [coreRestartedShown, setCoreRestartedShown] = useState(false);
  useEffect(() => {
    if (state.coreGeneration === 0) return;
    setCoreRestartedShown(true);
    const timer = setTimeout(() => setCoreRestartedShown(false), CORE_RESTARTED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [state.coreGeneration]);

  if (!restored) return <div className="app app--loading" data-view="restoring" />;

  return (
    <DragProvider>
      <LayoutDropRules store={store} onMove={arrange} />
      <div className={`app${sidebarVisible ? "" : " app--sidebar-hidden"}`}>
        {sidebarVisible && (
          <Sidebar
            sessions={state.sessions}
            workspaces={state.workspaces}
            activeSessionId={activeSessionId}
            actions={sidebarActions}
            onNotice={setNotice}
            formOpen={formOpen}
            creating={creating}
            createError={createError}
            onFormOpen={(open) => {
              setFormOpen(open);
              if (!open) setCreateError(undefined);
            }}
            onOpen={open}
            placeEntries={(sessionId) => sessionPlaceEntries(store.getState().window, sessionId)}
            onPlace={(sessionId, zone) => {
              const current = activeTab(store.getState());
              if (current)
                arrange({ kind: "session", sessionId }, { kind: "pane", paneId: current.activePaneId, zone });
            }}
            onCreate={create}
          />
        )}
        <main className="main">
          <TabBar
            tabs={tabs}
            activeTabId={state.window.activeTabId}
            sessions={state.sessions}
            sidebarVisible={sidebarVisible}
            panes={tab ? paneCount(tab) : 0}
            maxPanes={MAX_PANES}
            onToggleSidebar={() => store.toggleSidebar()}
            onFocus={(tabId) => {
              store.focusTab(tabId);
              refocus();
            }}
            onClose={(tabId) => store.closeTab(tabId)}
            onSplit={(direction) => void splitActivePane(commandRef.current, direction)}
            onShowShortcuts={() => setShortcutsOpen(true)}
            onSearch={() => setSearchOpen(true)}
            onMenu={(tabId, event) =>
              openLayoutMenu(event, "Aktionen für den Tab", tabMenu(store.getState().window, tabId))
            }
            onClosePane={() => {
              if (tab) store.closePane(tab.id, tab.activePaneId);
              setNotice(undefined);
              refocus();
            }}
          />
          <div className="tab-panels" ref={tabPanels}>
            {tabs.length === 0 && (
              <EmptyState error={loadError} loaded={state.sessions.length > 0} onNewSession={showForm} />
            )}
            {/* Layout patterns at the top edge while a tab or pane is dragged (#78). */}
            {tabs.length > 0 && <SnapBar window={state.window} sessions={state.sessions} area={tabPanels} />}
            {/* One flat list for the panes of all tabs (#67): a pane that moves keeps its element and view. */}
            <PaneTree
              api={api}
              tabs={tabs}
              activeTabId={state.window.activeTabId}
              sessions={state.sessions}
              sessionsLoaded={state.sessionsLoaded}
              focusSignal={focusSignal}
              onStatus={setStatus}
              onController={setController}
              // A press only makes the pane active; taking the input is the pane's button or a double
              // click (TerminalView, #66), so neither the writer nor the size jump on a click.
              onPanePress={(tabId, paneId) => store.focusPane(tabId, paneId)}
              onClosePane={(tabId, paneId) => store.closePane(tabId, paneId)}
              commands={keyCommands}
              onPanePaste={(paneId) => {
                const controller = controllers.current.get(paneId);
                if (controller) void pasteInto(controller, navigator.clipboard, setNotice);
              }}
              onMoveDivider={(tabId, splitId, index, delta, minShare) =>
                store.moveDivider(tabId, splitId, index, delta, minShare)
              }
              onPaneMenu={(paneId, event) =>
                openLayoutMenu(event, "Aktionen für das Pane", paneMenu(store.getState().window, paneId))
              }
              dismissedWarnings={state.dismissedWarnings}
              onDismissWarnings={(sessionId) => {
                store.dismissWarnings(sessionId);
                refocus();
              }}
              coreGeneration={state.coreGeneration}
              onRestartCore={restartCore}
            />
            {coreRestartedShown && (
              <div className="core-toast" role="status" data-hint="core-restarted">
                Core neu gestartet
              </div>
            )}
          </div>
        </main>
        <StatusBar
          session={activeSession}
          view={activeView}
          hints={coreHints(state.coreStatus, state.coreClosed, state.coreRestarting)}
          onRestartCore={restartCore}
          notice={notice}
          // claimWriter never rejects; a refusal arrives as the error of the view status.
          onClaimWriter={() => {
            void (tab && controllers.current.get(tab.activePaneId)?.claimWriter());
            refocus(); // like the button in the pane: the terminal takes the keys again
          }}
        />
        {quit && (
          <QuitDialog
            activeSessions={quit.activeSessions}
            windowsSessions={quit.windowsSessions}
            onAnswer={(answer) => {
              const { requestId } = quit;
              answeredQuits.current.add(requestId);
              setQuit(undefined);
              // A refused answer (the main process asked nobody) changes nothing: the dialog is closed either way.
              api.answerQuit(requestId, answer).catch((error: unknown) => console.error(error));
              refocus();
            }}
          />
        )}
        {searchOpen && (
          <SearchDialog
            api={api}
            sessions={state.sessions}
            onOpen={(sessionId) => {
              // Like a click in the sidebar: opens the tab or focuses the one that shows the session. A session
              // that no longer lives (archived, ended) opens as a placeholder.
              setSearchOpen(false);
              open(sessionId, "tab");
            }}
            onClose={() => {
              setSearchOpen(false);
              refocus();
            }}
          />
        )}
        {settingsOpen && <SettingsDialog api={api} onClose={closeSettings} />}
        {shortcutsOpen && (
          <ShortcutsDialog
            onClose={() => {
              setShortcutsOpen(false);
              refocus();
            }}
          />
        )}
        {layoutMenu && (
          <ContextMenu
            x={layoutMenu.x}
            y={layoutMenu.y}
            label={layoutMenu.label}
            entries={layoutMenu.entries}
            onClose={(chosen) => {
              setLayoutMenu(undefined);
              if (!chosen) layoutMenu.opener?.focus();
            }}
          />
        )}
      </div>
    </DragProvider>
  );
}

/**
 * The drop rules of tab bar and panes (#67): a tab, a pane or a session of the sidebar on a zone of a pane or on the
 * tab bar, as `layout-moves.ts` allows. Inside the window's `DragProvider`, next to the sidebar's own rules.
 */
function LayoutDropRules({
  store,
  onMove,
}: {
  store: UiStore;
  onMove: (source: MoveSource, target: MoveTarget) => void;
}) {
  const resolve = (payload: DragPayload, targetId: string) => {
    const source = dropSource(payload);
    const target = dropTarget(store.getState().window, targetId);
    return source && target ? { source, target } : undefined;
  };
  useDropHandler({
    accepts: (payload, targetId) => {
      const move = resolve(payload, targetId);
      return move !== undefined && store.canMove(move.source, move.target);
    },
    onDrop: (payload, targetId) => {
      const move = resolve(payload, targetId);
      if (move) onMove(move.source, move.target);
    },
  });
  return null;
}

/** An input field of the page; the text area of xterm.js is none, its keys are the terminal's. */
function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !target.classList.contains("xterm-helper-textarea") &&
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
  );
}

function EmptyState({
  error,
  loaded,
  onNewSession,
}: {
  error: string | undefined;
  loaded: boolean;
  onNewSession: () => void;
}) {
  return (
    <div className="empty-state" data-view="empty">
      <h1 className="empty-state__title">Keine Tabs offen</h1>
      <p>
        {loaded
          ? "Wähle eine Session in der Seitenleiste oder lege eine neue an."
          : "Lege eine Session an, um zu beginnen."}
      </p>
      {error && <p className="empty-state__error">Sessions nicht verfügbar: {error}</p>}
      <button className="button button--primary" type="button" onClick={onNewSession}>
        Neue Session
      </button>
    </div>
  );
}
