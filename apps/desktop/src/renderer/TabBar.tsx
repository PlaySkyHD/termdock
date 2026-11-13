// Tab bar: the sidebar toggle at the left, one tab per view, a close button on each.
import type { LayoutTab, SessionInfo } from "@termdock/protocol";
import { StateIcon } from "./StateIcon.js";
import { tabSessionId } from "./ui-store.js";

export interface TabBarProps {
  tabs: readonly LayoutTab[];
  activeTabId: string | undefined;
  sessions: readonly SessionInfo[];
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onFocus: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

export function TabBar({
  tabs,
  activeTabId,
  sessions,
  sidebarVisible,
  onToggleSidebar,
  onFocus,
  onClose,
}: TabBarProps) {
  return (
    <div className="tab-bar">
      <button
        className="icon-button tab-bar__toggle"
        type="button"
        data-action="toggle-sidebar"
        aria-pressed={sidebarVisible}
        title={sidebarVisible ? "Seitenleiste ausblenden" : "Seitenleiste einblenden"}
        aria-label={sidebarVisible ? "Seitenleiste ausblenden" : "Seitenleiste einblenden"}
        onClick={onToggleSidebar}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" />
          <rect x="2" y="3" width="4" height="10" fill={sidebarVisible ? "currentColor" : "none"} />
          <line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" />
        </svg>
      </button>
      <div className="tab-bar__tabs" role="tablist">
        {tabs.map((tab) => {
          const sessionId = tabSessionId(tab);
          const session = sessions.find((candidate) => candidate.id === sessionId);
          const active = tab.id === activeTabId;
          const title = session?.name ?? "Unbekannte Session";
          return (
            <div
              className={`tab${active ? " tab--active" : ""}`}
              key={tab.id}
              role="tab"
              aria-selected={active}
              data-tab-title={title}
              // Middle click closes, like in VS Code.
              onAuxClick={(event) => {
                if (event.button === 1) onClose(tab.id);
              }}
            >
              <button className="tab__main" type="button" title={title} onClick={() => onFocus(tab.id)}>
                {session && <StateIcon session={session} />}
                <span className="tab__title">{title}</span>
              </button>
              <button
                className="tab__close"
                type="button"
                title="Tab schließen"
                aria-label={`Tab ${title} schließen`}
                onClick={() => onClose(tab.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
