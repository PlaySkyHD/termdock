// History search (#62, Ctrl+Shift+F): a dialog with a search field and the hits of all sessions, grouped by
// session. A click on a hit opens or focuses the session. Hit lines are text nodes: React escapes them, and the
// core already removed escape sequences, so nothing of the output is ever interpreted. Escape closes the dialog.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { MAX_HISTORY_QUERY_LENGTH } from "@termdock/protocol";
import type { SessionId, SessionInfo } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";
import { trapFocus } from "./focus-trap.js";
import { formatHitTime, HistorySearchModel, splitHit } from "./history-search.js";
import type { SearchView } from "./history-search.js";

export interface SearchDialogProps {
  api: Pick<TermdockApi, "searchHistory">;
  sessions: readonly SessionInfo[];
  /** A hit was chosen: the window opens or focuses the session. */
  onOpen: (sessionId: SessionId) => void;
  onClose: () => void;
}

export function SearchDialog({ api, sessions, onOpen, onClose }: SearchDialogProps) {
  const latestSessions = useRef(sessions);
  latestSessions.current = sessions;
  const model = useMemo(() => new HistorySearchModel(api, () => latestSessions.current), [api]);
  useEffect(() => () => model.dispose(), [model]);
  const view = useSyncExternalStore(model.subscribe, model.getState);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Takes the focus from the terminal, so typing goes into the field and Escape closes the dialog.
    input.current?.focus();
    // Tab must not reach the terminal behind (its keys would go to the session).
    return dialog.current ? trapFocus(dialog.current, () => input.current) : undefined;
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="dialog-backdrop dialog-backdrop--top"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="dialog dialog--search"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-title"
        data-dialog="search"
      >
        <h2 className="dialog__title" id="search-title">
          Im Verlauf suchen
        </h2>
        <input
          ref={input}
          className="search__input"
          type="search"
          data-search="input"
          placeholder="Text in der Ausgabe aller Sessions"
          aria-label="Suchtext"
          maxLength={MAX_HISTORY_QUERY_LENGTH}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => model.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void model.run(event.currentTarget.value);
          }}
        />
        <Results view={view} onOpen={onOpen} />
        <div className="dialog__actions">
          <button className="button" type="button" data-search="close" onClick={onClose}>
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}

function Results({ view, onOpen }: { view: SearchView; onOpen: (sessionId: SessionId) => void }) {
  if (view.status === "idle")
    return (
      <p className="dialog__note" data-search="hint">
        Durchsucht den gespeicherten Verlauf aller Sessions, ohne Beachtung der Groß- und Kleinschreibung.
        Sessions ohne Verlauf (Logging aus) fehlen.
      </p>
    );
  if (view.status === "searching")
    return (
      <p className="dialog__note" data-search="status">
        Suche …
      </p>
    );
  if (view.status === "error")
    return (
      <p className="dialog__note search__error" role="alert" data-search="error">
        Suche nicht möglich: {view.message}
      </p>
    );
  if (view.total === 0)
    return (
      <p className="dialog__note" data-search="status">
        Keine Treffer für „{view.query}“.
      </p>
    );
  return (
    <>
      <p className="dialog__note" data-search="status">
        {view.total} Treffer in {view.groups.length} {view.groups.length === 1 ? "Session" : "Sessions"}
        {view.truncated ? ". Es gibt weitere Treffer: Suchtext verfeinern." : ""}
      </p>
      <div className="search__results" data-search="results">
        {view.groups.map((group) => (
          <section className="search__group" key={group.sessionId} data-search-group={group.name}>
            <h3 className="search__group-title">
              {group.name}
              {group.state === "Archived" && <span className="search__tag">archiviert</span>}
              <span className="search__count">{group.hits.length}</span>
            </h3>
            <ul className="search__hits">
              {group.hits.map((hit, index) => {
                const { before, match, after } = splitHit(hit, view.query);
                return (
                  <li key={`${hit.timestamp}-${index}`}>
                    <button
                      className="search__hit"
                      type="button"
                      data-search-hit={group.sessionId}
                      title={`${group.name}, ${formatHitTime(hit.timestamp)}`}
                      onClick={() => onOpen(group.sessionId)}
                    >
                      <span className="search__time">{formatHitTime(hit.timestamp)}</span>
                      <span className="search__line">
                        {before}
                        <mark>{match}</mark>
                        {after}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
