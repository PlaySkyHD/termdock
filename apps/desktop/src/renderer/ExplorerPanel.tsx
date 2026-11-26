// The explorer panel right of the panes (#202, ADR 0009): the current directory of the session the panel follows
// (`explorerTarget`), as a tree that lists folders when they open. The rules live in pure modules: the tree in
// `explorer-tree.ts`, keys and clicks in `explorer-keys.ts`, what is drawn, width and texts in `explorer-view.ts`.
// This component only runs the listings (`files.list`) and draws. File actions (#203) hang on the same tree.
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { FileDoneResult, FileListResult, FilesApi } from "../shared/files.js";
import { explorerClick, explorerDoubleClick, explorerKey } from "./explorer-keys.js";
import type { ExplorerKeyAction } from "./explorer-keys.js";
import { shortPath } from "./explorer-source.js";
import type { ExplorerTarget } from "./explorer-source.js";
import {
  collapse,
  entryRow,
  expand,
  finishLoad,
  loadRoot,
  locationAt,
  refreshAll,
  selectEntry,
  treeFor,
} from "./explorer-tree.js";
import type { ExplorerRow, ExplorerTree, ListRequest } from "./explorer-tree.js";
import { focusStep, hintText, openErrorText, panelView } from "./explorer-view.js";

export interface ExplorerPanelProps {
  files: FilesApi;
  target: ExplorerTarget;
  /** Width in pixels, within the limits (`explorerWidth`). */
  width: number;
  /** The key that focuses the panel was pressed: the tree takes the keyboard focus, then `onFocused` clears it. */
  focusWanted: boolean;
  onFocused(): void;
  /** Escape in the panel: the terminal of the active pane takes the focus. */
  onLeave(): void;
  /** The divider was dragged: the wanted width and the width of panes and panel together. */
  onResize(width: number, available: number): void;
  onHide(): void;
}

type EntryRow = Extract<ExplorerRow, { kind: "entry" }>;

/** Indent of one level of the tree in pixels. */
const INDENT_PX = 12;

export function ExplorerPanel({
  files,
  target,
  width,
  focusWanted,
  onFocused,
  onLeave,
  onResize,
  onHide,
}: ExplorerPanelProps) {
  // The tree lives in a ref, so a listing that answers late is checked against the tree shown then, not the one of
  // its render (`finishLoad` drops stale answers); `setVersion` draws it.
  const tree = useRef<ExplorerTree>(undefined);
  const shownKey = useRef<string>(undefined);
  const [, setVersion] = useState(0);
  const [notice, setNotice] = useState<string>();
  const panel = useRef<HTMLElement>(null);
  const treeElement = useRef<HTMLDivElement>(null);

  const update = (next: ExplorerTree): void => {
    if (next === tree.current) return;
    tree.current = next;
    setVersion((version) => version + 1);
  };
  const run = (request: ListRequest): void => {
    void files
      .list(request.location)
      .catch((): FileListResult => ({ ok: false, code: "OTHER" }))
      .then((result) => {
        if (tree.current) update(finishLoad(tree.current, request, result));
      });
  };

  // A new folder or session: a fresh tree, open folders are gone, and answers for the old one no longer match.
  // `target` is a new object on every store change; only its key decides.
  const key = target.kind === "folder" ? target.key : undefined;
  const location = target.kind === "folder" ? target.location : undefined;
  useEffect(() => {
    setNotice(undefined);
    shownKey.current = key;
    if (key === undefined || location === undefined) return;
    const { tree: next, request } = loadRoot(treeFor(location, tree.current));
    update(next);
    run(request);
  }, [key]);

  const current = key !== undefined && shownKey.current === key ? tree.current : undefined;
  const view = panelView(target, current);
  const selected = current?.selected;

  const apply = (action: ExplorerKeyAction): void => {
    if (action.kind === "leave") {
      onLeave();
      return;
    }
    const now = tree.current;
    if (!now || shownKey.current !== key) return;
    switch (action.kind) {
      case "select":
        update(selectEntry(now, action.path));
        return;
      case "expand": {
        const opened = expand(selectEntry(now, action.path), action.path);
        update(opened.tree);
        if (opened.request) run(opened.request);
        return;
      }
      case "collapse":
        update(collapse(selectEntry(now, action.path), action.path));
        return;
      case "open": {
        const row = entryRow(view.rows, action.path);
        if (!row) return;
        update(selectEntry(now, action.path));
        setNotice(undefined);
        void files
          .open(locationAt(now, action.path))
          .catch((): FileDoneResult => ({ ok: false, code: "OTHER" }))
          .then((result) => {
            // A hint for a file of a folder the panel no longer shows would be misleading.
            if (!result.ok && shownKey.current === key) setNotice(openErrorText(row.name, result.code));
          });
        return;
      }
    }
  };

  // The key that focuses the panel (`focusStep`): the tree takes the keys, the panel itself while it shows a text.
  // While the root loads the wish waits for the tree; it is used once, so showing the panel later takes nothing.
  useEffect(() => {
    const step = focusStep(focusWanted, view.state, treeElement.current !== null);
    if (step.target === "tree") treeElement.current?.focus();
    else if (step.target === "panel") panel.current?.focus();
    if (focusWanted && step.settled) onFocused();
  }, [focusWanted, view.state]);
  // A panel that goes away keeps no wish for the next one.
  const settle = useRef(onFocused);
  settle.current = onFocused;
  useEffect(() => () => settle.current(), []);

  useEffect(() => {
    if (selected !== undefined)
      treeElement.current
        ?.querySelector(`[data-path="${CSS.escape(selected)}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const path = location?.path;
  return (
    <aside
      className="explorer"
      ref={panel}
      style={{ width }}
      tabIndex={-1}
      aria-label="Explorer"
      data-explorer-state={view.state}
      {...(target.kind === "folder" ? { "data-explorer-session": target.session.id } : {})}
      onKeyDown={(event) => {
        // Escape anywhere in the panel; the tree handles its own keys first.
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onLeave();
      }}
    >
      <Divider panel={panel} width={width} onResize={onResize} />
      <div className="explorer__header">
        <span className="explorer__path" title={path} data-explorer-path={path ?? ""}>
          {path === undefined ? "Explorer" : shortPath(path)}
        </span>
        <button
          type="button"
          className="icon-button explorer__button"
          aria-label="Aktualisieren"
          title="Aktualisieren"
          data-action="explorer-refresh"
          disabled={!current}
          onClick={() => {
            if (!tree.current || shownKey.current !== key) return;
            setNotice(undefined);
            const { tree: next, requests } = refreshAll(tree.current);
            update(next);
            requests.forEach(run);
          }}
        >
          ⟳
        </button>
        <button
          type="button"
          className="icon-button explorer__button"
          aria-label="Explorer ausblenden"
          title="Explorer ausblenden"
          data-action="explorer-hide"
          onClick={onHide}
        >
          ×
        </button>
      </div>
      {notice !== undefined && (
        <div className="explorer__notice" role="status" data-explorer-notice>
          {notice}
        </div>
      )}
      {view.message !== undefined ? (
        <div className="explorer__message" data-explorer-message>
          {view.message}
        </div>
      ) : (
        <div
          className="explorer__tree"
          ref={treeElement}
          role="tree"
          aria-label="Dateien"
          tabIndex={0}
          {...(selected === undefined ? {} : { "aria-activedescendant": rowId(selected) })}
          onKeyDown={(event) => {
            const action = explorerKey(event.key, view.rows, selected);
            if (!action) return;
            // The tree's keys are its own: none goes on to the window's key handler (or the terminal).
            event.preventDefault();
            event.stopPropagation();
            apply(action);
          }}
        >
          {view.rows.map((row) => (
            <Row
              key={`${row.kind}:${row.path}`}
              row={row}
              selected={row.kind === "entry" && row.path === selected}
              onClick={(entry) => {
                treeElement.current?.focus();
                apply(explorerClick(entry));
              }}
              onDoubleClick={(entry) => {
                const action = explorerDoubleClick(entry);
                if (action) apply(action);
              }}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

function Row({
  row,
  selected,
  onClick,
  onDoubleClick,
}: {
  row: ExplorerRow;
  selected: boolean;
  onClick(entry: EntryRow): void;
  onDoubleClick(entry: EntryRow): void;
}) {
  const indent = 8 + row.depth * INDENT_PX;
  if (row.kind !== "entry")
    return (
      <div
        className={`explorer__hint explorer__hint--${row.kind}`}
        style={{ paddingLeft: indent + 16 }}
        data-explorer-hint={row.kind}
      >
        {hintText(row)}
      </div>
    );
  return (
    <div
      id={rowId(row.path)}
      className={`explorer__row${selected ? " explorer__row--selected" : ""}`}
      style={{ paddingLeft: indent }}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      {...(row.folder ? { "aria-expanded": row.expanded } : {})}
      data-path={row.path}
      data-kind={row.folder ? "folder" : "file"}
      title={row.name}
      // The tree keeps the focus; a press must not move it to the row (it has none) or select text.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onClick(row)}
      onDoubleClick={() => onDoubleClick(row)}
    >
      <span className="explorer__twisty" aria-hidden="true">
        {row.folder ? (row.expanded ? "▾" : "▸") : ""}
      </span>
      <span className="explorer__name">{row.name}</span>
    </div>
  );
}

/** The divider at the left edge of the panel: dragging it changes the width (the store keeps the limits). */
function Divider({
  panel,
  width,
  onResize,
}: {
  panel: { current: HTMLElement | null };
  width: number;
  onResize(width: number, available: number): void;
}) {
  const start = useRef<{ x: number; width: number }>(undefined);
  const [dragging, setDragging] = useState(false);
  const end = (): void => {
    start.current = undefined;
    setDragging(false);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!start.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const available = panel.current?.parentElement?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY;
    onResize(start.current.width + (start.current.x - event.clientX), available);
  };
  return (
    <div
      className={`explorer__divider${dragging ? " explorer__divider--dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Breite des Explorers"
      aria-valuenow={width}
      data-explorer-divider
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width };
        setDragging(true);
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        end();
      }}
      onLostPointerCapture={end}
    />
  );
}

/** Id of a row for `aria-activedescendant`: the path, made safe for an id. */
function rowId(path: string): string {
  return `explorer-row-${encodeURIComponent(path)}`;
}
