// Tab bar: the sidebar toggle at the left, one tab per pane tree with a close button on each, and at the right
// the actions on the active pane (split right, split down, close pane).
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
  /** Panes of the active tab (0 without one) and the limit per tab. */
  panes: number;
  maxPanes: number;
  /** Splits the active pane; the new pane shows a new session like the active one's (#66). */
  onSplit: (direction: "row" | "column") => void;
  onClosePane: () => void;
  /** Opens the overview of the key bindings. */
  onShowShortcuts: () => void;
}

export function TabBar({
  tabs,
  activeTabId,
  sessions,
  sidebarVisible,
  onToggleSidebar,
  onFocus,
  onClose,
  panes,
  maxPanes,
  onSplit,
  onClosePane,
  onShowShortcuts,
}: TabBarProps) {
  const full = panes >= maxPanes;
  const splitTitle = (text: string): string => (full ? `Höchstens ${maxPanes} Panes je Tab` : text);
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
      <div className="tab-bar__actions">
        <button
          className="icon-button"
          type="button"
          data-action="show-shortcuts"
          title="Tastenkürzel (Ctrl+Shift+H)"
          aria-label="Tastenkürzel anzeigen"
          onClick={onShowShortcuts}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="3.5" width="13" height="9" rx="1" fill="none" stroke="currentColor" />
            <path d="M4 6.5h1M7 6.5h1M10 6.5h1M4 9.5h8" stroke="currentColor" />
          </svg>
        </button>
      </div>
      {panes > 0 && (
        <div className="tab-bar__actions">
          <button
            className="icon-button"
            type="button"
            data-action="split-row"
            disabled={full}
            title={splitTitle(
              "Rechts teilen mit neuer Session (Ctrl+Shift+D)\nDieselbe Session: Umschalt+Klick in der Seitenleiste",
            )}
            aria-label="Rechts teilen"
            onClick={() => onSplit("row")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" />
              <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" />
            </svg>
          </button>
          <button
            className="icon-button"
            type="button"
            data-action="split-column"
            disabled={full}
            title={splitTitle(
              "Unten teilen mit neuer Session (Ctrl+Shift+E)\nDieselbe Session: Umschalt+Klick in der Seitenleiste",
            )}
            aria-label="Unten teilen"
            onClick={() => onSplit("column")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" />
              <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" />
            </svg>
          </button>
          {panes > 1 && (
            <button
              className="icon-button"
              type="button"
              data-action="close-pane"
              title="Pane schließen"
              aria-label="Pane schließen"
              onClick={onClosePane}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" />
                <path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
