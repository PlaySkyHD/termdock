// Window content: sidebar, tab bar with one terminal view per tab, and the status bar (ADR 0006).
// All tabs of the window stay mounted and attached; the inactive ones are only hidden (design add-sidebar-tabs).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SessionId, SessionInfo } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";
import { coreHints, endedNotice, isAttachable } from "./session-display.js";
import { connectStore } from "./session-sync.js";
import { Sidebar } from "./Sidebar.js";
import { StatusBar } from "./StatusBar.js";
import { TabBar } from "./TabBar.js";
import type { TerminalController, ViewStatus } from "./terminal-controller.js";
import { TerminalView } from "./TerminalView.js";
import { activeTab, MAX_TABS, tabSessionId, UiStore } from "./ui-store.js";

export function App({ api }: { api: TermdockApi }) {
  const store = useMemo(() => new UiStore({ newId: () => crypto.randomUUID() }), []);
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [statuses, setStatuses] = useState<Record<string, ViewStatus>>({});
  const controllers = useRef(new Map<string, TerminalController>());
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    const connection = connectStore(store, api, setLoadError);
    return connection.dispose;
  }, [store, api]);

  // Creating a session and its error live here, not in the form: hiding the sidebar unmounts the form, and a
  // create in flight must neither be started twice nor lose its error.
  const [creating, setCreating] = useState(false);
  const creatingNow = useRef(false);
  const [createError, setCreateError] = useState<string>();
  // Raised by clicks that leave the focus on a button; the active terminal takes it back.
  const [focusSignal, setFocusSignal] = useState(0);
  const refocus = useCallback(() => setFocusSignal((signal) => signal + 1), []);

  const open = useCallback(
    (sessionId: SessionId, forceNew: boolean) => {
      const tabId = store.openSession(sessionId, { forceNew });
      setNotice(tabId === undefined ? `Höchstens ${MAX_TABS} Tabs je Fenster` : undefined);
      refocus();
    },
    [store, refocus],
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
            open(session.id, false);
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

  const setStatus = useCallback((tabId: string, status: ViewStatus | undefined) => {
    setStatuses((current) => {
      if (status === undefined) {
        const { [tabId]: _gone, ...rest } = current;
        return rest;
      }
      return { ...current, [tabId]: status };
    });
  }, []);

  const tab = activeTab(state);
  const activeSessionId = tab && tabSessionId(tab);
  const activeSession = state.sessions.find((session) => session.id === activeSessionId);
  const { sidebarVisible = true, tabs } = state.window;

  const showForm = (): void => {
    if (!sidebarVisible) store.toggleSidebar();
    setFormOpen(true);
  };

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
          onToggleSidebar={() => store.toggleSidebar()}
          onFocus={(tabId) => {
            store.focusTab(tabId);
            refocus();
          }}
          onClose={(tabId) => store.closeTab(tabId)}
        />
        <div className="tab-panels">
          {tabs.length === 0 && (
            <EmptyState error={loadError} loaded={state.sessions.length > 0} onNewSession={showForm} />
          )}
          {tabs.map((each) => (
            <TabPanel
              key={each.id}
              api={api}
              sessionId={tabSessionId(each)}
              session={state.sessions.find((session) => session.id === tabSessionId(each))}
              active={each.id === state.window.activeTabId}
              focusSignal={focusSignal}
              onStatus={(status) => setStatus(each.id, status)}
              onController={(controller) =>
                controller
                  ? controllers.current.set(each.id, controller)
                  : controllers.current.delete(each.id)
              }
            />
          ))}
        </div>
      </main>
      <StatusBar
        session={activeSession}
        view={tab ? statuses[tab.id] : undefined}
        hints={coreHints(state.coreStatus, state.coreClosed)}
        notice={notice}
        // claimWriter never rejects; a refusal arrives as the error of the view status.
        onClaimWriter={() => void (tab && controllers.current.get(tab.id)?.claimWriter())}
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

interface TabPanelProps {
  api: TermdockApi;
  sessionId: SessionId | undefined;
  session: SessionInfo | undefined;
  active: boolean;
  focusSignal: number;
  onStatus: (status: ViewStatus | undefined) => void;
  onController: (controller: TerminalController | undefined) => void;
}

/**
 * One tab. A session that cannot be attached (starting, exited, interrupted) shows a notice instead of a view.
 * Once attached, the view stays when the session ends, so its last output remains readable.
 */
function TabPanel({ api, sessionId, session, active, focusSignal, onStatus, onController }: TabPanelProps) {
  const attachable = session !== undefined && isAttachable(session.state);
  const [attached, setAttached] = useState(attachable);
  useEffect(() => {
    if (attachable) setAttached(true);
  }, [attachable]);

  const notice = session ? endedNotice(session) : undefined;
  return (
    <div className={`tab-panel${active ? "" : " tab-panel--hidden"}`} data-active={active}>
      {(attached || attachable) && sessionId !== undefined ? (
        <TerminalView
          api={api}
          sessionId={sessionId}
          active={active}
          focusSignal={focusSignal}
          onStatus={onStatus}
          onController={onController}
        />
      ) : (
        <div className="empty-state" data-view="notice">
          <h1 className="empty-state__title">{notice?.title ?? "Session nicht gefunden"}</h1>
          <p>{notice?.detail ?? "Der Core kennt diese Session nicht (mehr)."}</p>
        </div>
      )}
    </div>
  );
}
