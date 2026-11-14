// Sidebar: sessions grouped by workspace, with the state of each, and the form for a new WSL session.
import { useEffect, useRef, useState } from "react";
import type { SessionId, SessionInfo } from "@termdock/protocol";
import { groupSessions, stateText } from "./session-display.js";
import { StateIcon } from "./StateIcon.js";

/** `tab`: open or focus the tab; `newTab`: always a new tab; `split`: next to the active pane. */
export type OpenMode = "tab" | "newTab" | "split";

export interface SidebarProps {
  sessions: readonly SessionInfo[];
  /** Session of the active pane of the active tab. */
  activeSessionId: SessionId | undefined;
  formOpen: boolean;
  /** A create is in flight (owned by the window, so it survives hiding the sidebar). */
  creating: boolean;
  /** Message of the last failed create. */
  createError: string | undefined;
  onFormOpen: (open: boolean) => void;
  /** Click opens or focuses the tab; Ctrl+click always opens a new one; Shift+click splits the active pane. */
  onOpen: (sessionId: SessionId, mode: OpenMode) => void;
  /** Starts creating the session and opening its tab; `creating` and `createError` report the outcome. */
  onCreate: (name: string, cwd: string) => void;
}

export function Sidebar({
  sessions,
  activeSessionId,
  formOpen,
  creating,
  createError,
  onFormOpen,
  onOpen,
  onCreate,
}: SidebarProps) {
  const groups = groupSessions(sessions);
  return (
    <aside className="sidebar" aria-label="Sessions">
      <header className="sidebar__header">
        <span className="sidebar__title">Sessions</span>
        <button
          className="icon-button"
          type="button"
          data-action="new-session"
          title="Neue WSL-Session"
          aria-label="Neue WSL-Session"
          onClick={() => onFormOpen(!formOpen)}
        >
          +
        </button>
      </header>
      {formOpen && (
        <NewSessionForm
          busy={creating}
          error={createError}
          onCreate={onCreate}
          onCancel={() => onFormOpen(false)}
        />
      )}
      <div className="sidebar__groups">
        {groups.map((group) => (
          <section className="sidebar__group" key={group.key} aria-label={group.label}>
            <h2 className="sidebar__group-title">{group.label}</h2>
            <ul className="sidebar__list">
              {group.sessions.length === 0 && <li className="sidebar__empty">Keine Sessions</li>}
              {group.sessions.map((session) => (
                <li key={session.id}>
                  <button
                    className={`session-item${session.id === activeSessionId ? " session-item--active" : ""}${
                      session.state === "Exited" || session.state === "Interrupted"
                        ? " session-item--ended"
                        : ""
                    }`}
                    type="button"
                    data-session-name={session.name}
                    data-state={session.state}
                    title={`${session.name} · ${stateText(session)}\nStrg+Klick: in neuem Tab öffnen\nUmschalt+Klick: neben dem aktiven Pane öffnen (dieselbe Session liest dort mit)`}
                    onClick={(event) =>
                      onOpen(session.id, event.ctrlKey ? "newTab" : event.shiftKey ? "split" : "tab")
                    }
                  >
                    <StateIcon session={session} />
                    <span className="session-item__name">{session.name}</span>
                    <span className="session-item__state">{stateText(session)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}

function NewSessionForm({
  busy,
  error,
  onCreate,
  onCancel,
}: {
  busy: boolean;
  error: string | undefined;
  onCreate: SidebarProps["onCreate"];
  onCancel: () => void;
}) {
  const [name, setName] = useState("WSL");
  const [cwd, setCwd] = useState("~");
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => nameField.current?.select(), []);

  const submit = (): void => {
    if (busy || name.trim() === "") return;
    // The creating may take long when WSL starts cold (up to 60 s); the window keeps its state, also when the
    // sidebar is hidden meanwhile.
    onCreate(name.trim(), cwd.trim() === "" ? "~" : cwd.trim());
  };

  return (
    <form
      className="new-session"
      data-form="new-session"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <label className="new-session__field">
        Name
        <input
          ref={nameField}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="new-session__field">
        Arbeitsverzeichnis
        <input
          value={cwd}
          disabled={busy}
          spellCheck={false}
          onChange={(event) => setCwd(event.target.value)}
        />
      </label>
      {busy && <p className="new-session__note">Wird angelegt …</p>}
      {error && <p className="new-session__error">{error}</p>}
      <div className="new-session__actions">
        <button className="button button--primary" type="submit" disabled={busy || name.trim() === ""}>
          Anlegen
        </button>
        <button className="button" type="button" disabled={busy} onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}
