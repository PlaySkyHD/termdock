// Status bar of the window: backend and distro, the active session and its state, the role of its view,
// and notes about the core. Its colour follows the role of the active view, as in the first desktop shell.
import type { SessionInfo } from "@termdock/protocol";
import { backendText, stateText } from "./session-display.js";
import type { ViewStatus } from "./terminal-controller.js";

export interface StatusBarProps {
  /** Session of the active tab; undefined without one (or when the session is unknown). */
  session: SessionInfo | undefined;
  /** View of the active tab; undefined without one or while the tab shows only a notice. */
  view: ViewStatus | undefined;
  /** Notes about the core (lost connection, backends it could not reach). */
  hints: readonly string[];
  /** Short message of the window itself, e.g. the limit of tabs. */
  notice: string | undefined;
  onClaimWriter: () => void;
}

export function StatusBar({ session, view, hints, notice, onClaimWriter }: StatusBarProps) {
  const reader = view?.role === "reader";
  return (
    <footer className={`status-bar status-bar--${view?.role ?? "none"}`} role="status">
      {session && (
        <>
          <span className="status-bar__item" data-status="backend">
            {backendText(session.launch)}
          </span>
          <span className="status-bar__item" data-status="session">
            {session.name}
          </span>
          <span className="status-bar__item" data-status="state">
            {stateText(session)}
          </span>
        </>
      )}
      {view && <span className="status-bar__item">{roleText(view)}</span>}
      {view?.size && (
        <span className="status-bar__item">
          {view.size.cols}×{view.size.rows}
        </span>
      )}
      <span className="status-bar__spacer" />
      {view?.error && view.role !== "error" && (
        <span className="status-bar__item status-bar__item--error">{view.error}</span>
      )}
      {notice && <span className="status-bar__item status-bar__item--warning">{notice}</span>}
      {hints.map((hint) => (
        <span className="status-bar__item status-bar__item--warning" key={hint} data-status="hint">
          {hint}
        </span>
      ))}
      {reader && (
        <button className="status-bar__button" type="button" onClick={onClaimWriter}>
          Schreibrecht übernehmen
        </button>
      )}
    </footer>
  );
}

function roleText(status: ViewStatus): string {
  switch (status.role) {
    case "connecting":
      return "Verbinde …";
    case "writer":
      return "Schreibt";
    case "reader":
      return "Liest";
    case "closed":
      return "Verbindung zum Core getrennt";
    case "error":
      return `Fehler: ${status.error ?? "unbekannt"}`;
  }
}
