// Window content: sidebar, tab bar, the panes of every tab with one terminal view each, and the status bar
// (ADR 0006). All tabs of the window stay mounted and attached; the inactive ones are only hidden.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SessionId } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";
import { startLayoutSync } from "./layout-sync.js";
import { PaneTree } from "./PaneTree.js";
import { coreHints } from "./session-display.js";
import { connectStore } from "./session-sync.js";
import { Sidebar } from "./Sidebar.js";
import type { OpenMode } from "./Sidebar.js";
import { StatusBar } from "./StatusBar.js";
import { TabBar } from "./TabBar.js";
import type { TerminalController, ViewStatus } from "./terminal-controller.js";
import { activeTab, MAX_PANES, MAX_TABS, paneCount, tabSessionId, UiStore } from "./ui-store.js";
import type { SplitDirection } from "./ui-store.js";

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
    return () => {
      current = false;
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
   * Splits the active pane of the active tab; the new pane shows `sessionId`. With the same session the new view
   * reads, so the writing pane stays active and keeps the focus (the store decides, `splitPane`).
   */
  const split = useCallback(
    (direction: SplitDirection, sessionId: SessionId) => {
      const tab = activeTab(store.getState());
      if (!tab) return;
      const paneId = store.splitPane(tab.id, tab.activePaneId, direction, sessionId);
      setNotice(paneId === undefined ? `Höchstens ${MAX_PANES} Panes je Tab` : undefined);
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
    (name: string, cwd: string) => {
      if (creatingNow.current) return;
      creatingNow.current = true;
      setCreating(true);
      setCreateError(undefined);
      api
        .createSession({ name, launch: { backend: "wsl", cwd } })
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

  if (!restored) return <div className="app app--loading" data-view="restoring" />;

  return (
    <div className={`app${sidebarVisible ? "" : " app--sidebar-hidden"}`}>
      {sidebarVisible && (
        <Sidebar
          sessions={state.sessions}
          activeSessionId={activeSessionId}
          formOpen={formOpen}
          creating={creating}
          createError={createError}
          onFormOpen={(open) => {
            setFormOpen(open);
            if (!open) setCreateError(undefined);
          }}
          onOpen={open}
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
          onSplit={(direction) => activeSessionId !== undefined && split(direction, activeSessionId)}
          onClosePane={() => {
            if (tab) store.closePane(tab.id, tab.activePaneId);
            setNotice(undefined);
            refocus();
          }}
        />
        <div className="tab-panels">
          {tabs.length === 0 && (
            <EmptyState error={loadError} loaded={state.sessions.length > 0} onNewSession={showForm} />
          )}
          {tabs.map((each) => {
            const active = each.id === state.window.activeTabId;
            return (
              <div
                key={each.id}
                className={`tab-panel${active ? "" : " tab-panel--hidden"}`}
                data-active={active}
              >
                <PaneTree
                  api={api}
                  tab={each}
                  sessions={state.sessions}
                  sessionsLoaded={state.sessionsLoaded}
                  active={active}
                  focusSignal={focusSignal}
                  onStatus={setStatus}
                  onController={setController}
                  onPanePress={(paneId) => store.focusPane(each.id, paneId)}
                  onPaneClick={(paneId) => {
                    // A real click into a reading pane takes the writer, selecting text does not;
                    // claimWriter never rejects.
                    if (statuses[paneId]?.role === "reader")
                      void controllers.current.get(paneId)?.claimWriter();
                  }}
                  onClosePane={(paneId) => store.closePane(each.id, paneId)}
                  onMoveDivider={(splitId, index, delta, minShare) =>
                    store.moveDivider(each.id, splitId, index, delta, minShare)
                  }
                />
              </div>
            );
          })}
        </div>
      </main>
      <StatusBar
        session={activeSession}
        view={activeView}
        hints={coreHints(state.coreStatus, state.coreClosed)}
        notice={notice}
        // claimWriter never rejects; a refusal arrives as the error of the view status.
        onClaimWriter={() => void (tab && controllers.current.get(tab.activePaneId)?.claimWriter())}
      />
    </div>
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
          : "Lege eine WSL-Session an, um zu beginnen."}
      </p>
      {error && <p className="empty-state__error">Sessions nicht verfügbar: {error}</p>}
      <button className="button button--primary" type="button" onClick={onNewSession}>
        Neue WSL-Session
      </button>
    </div>
  );
}
