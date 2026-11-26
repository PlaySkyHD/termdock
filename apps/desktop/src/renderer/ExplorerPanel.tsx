// The explorer panel right of the panes (#202, ADR 0009): the current directory of the session the panel follows
// (`explorerTarget`), as a tree that lists folders when they open, with file actions (#203): a context menu, rename in
// the row, delete after a confirmation, move by dragging a row onto a folder, download, copy and paste the path. The
// rules live in pure modules: the tree in `explorer-tree.ts`, keys and clicks in `explorer-keys.ts`, what is drawn,
// width and texts in `explorer-view.ts`, the actions in `explorer-actions.ts` and the quoting in `path-quote.ts`. This
// component only runs the calls of `window.termdock.files` and draws.
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { FileFailure, FileListResult, FileLocation, FilesApi } from "../shared/files.js";
import { ContextMenu } from "./ContextMenu.js";
import { ConfirmDialog } from "./Dialogs.js";
import { useDrag, useDropHandler } from "./drag/DragProvider.js";
import {
  actionErrorText,
  afterDelete,
  afterFailure,
  afterMove,
  afterRename,
  canDropEntry,
  CLIPBOARD_FAILED,
  countsEntries,
  deleteConfirmation,
  deletePromptOpens,
  deleteRuns,
  dropTargetPath,
  ENTRY_KIND,
  explorerDropTarget,
  explorerMenu,
  isDropFolder,
  isProtectedPath,
  keepsRename,
  menuPath,
  menuPoint,
  offers,
  PASTE_NO_WRITER,
  renameSelection,
  renameTarget,
  skippedText,
} from "./explorer-actions.js";
import type {
  ActionOutcome,
  DeleteRequest,
  FileAction,
  MenuContext,
  RenameState,
} from "./explorer-actions.js";
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
  rowsOf,
  selectEntry,
  treeFor,
} from "./explorer-tree.js";
import type { ExplorerRow, ExplorerTree, ListRequest } from "./explorer-tree.js";
import { focusStep, hintText, openErrorText, panelView } from "./explorer-view.js";
import { pasteShell, quotePath } from "./path-quote.js";
import type { Confirmation } from "./sidebar-model.js";

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
  /** The clipboard of the app (#28), for "Pfad kopieren". */
  clipboard: Pick<Clipboard, "writeText">;
  /**
   * Pastes into the writing view of the panel's session (`pastePaneId`) and gives it the focus; false when the view
   * refused. Undefined without a writer: "Pfad ins Terminal einfügen" is disabled (input lock).
   */
  paste?: (text: string) => boolean;
}

type EntryRow = Extract<ExplorerRow, { kind: "entry" }>;

/** Indent of one level of the tree in pixels. */
const INDENT_PX = 12;
const MENU_LABEL = "Aktionen für den Eintrag";
/** A call that threw (a lost handler) answers like the service would. */
const failed = (): FileFailure => ({ ok: false, code: "OTHER" });

export function ExplorerPanel({
  files,
  target,
  width,
  focusWanted,
  onFocused,
  onLeave,
  onResize,
  onHide,
  clipboard,
  paste,
}: ExplorerPanelProps) {
  // The tree lives in a ref, so a listing that answers late is checked against the tree shown then, not the one of
  // its render (`finishLoad` drops stale answers); `setVersion` draws it.
  const tree = useRef<ExplorerTree>(undefined);
  const shownKey = useRef<string>(undefined);
  const [, setVersion] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [menu, setMenu] = useState<{ x: number; y: number; path: string }>();
  const [renaming, setRenaming] = useState<RenameState>();
  const [confirm, setConfirm] = useState<{
    row: EntryRow;
    location: FileLocation;
    confirmation: Confirmation;
    key: string;
  }>();
  /** Id of the latest Delete that waits for the listing of its folder (`askDelete`, `deletePromptOpens`). */
  const pendingDelete = useRef<number>(undefined);
  const deleteCount = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const treeElement = useRef<HTMLDivElement>(null);
  const drag = useDrag();
  // The visible rows of the tree in the ref, once per tree: the drop rules ask for every target of a drag.
  const rowsCache = useRef<{ tree: ExplorerTree; rows: ExplorerRow[] }>(undefined);
  const rowsNow = (now: ExplorerTree): ExplorerRow[] => {
    if (rowsCache.current?.tree !== now) rowsCache.current = { tree: now, rows: rowsOf(now) };
    return rowsCache.current.rows;
  };

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
  const settle = (outcome: ActionOutcome): void => {
    update(outcome.tree);
    outcome.requests.forEach(run);
  };
  /** After a failed action: the folders involved list again, unless the panel shows another folder by then. */
  const reloadAfterFailure = (own: string | undefined, folders: readonly string[]): void => {
    const latest = tree.current;
    if (shownKey.current === own && latest) settle(afterFailure(latest, folders));
  };
  /**
   * The tree takes the keys again after an action, once the dialog or field is gone (an effect after the render, so
   * the dialog's focus trap has let go); not when the user has put the focus elsewhere meanwhile (terminal, sidebar).
   */
  const wantsTreeFocus = useRef(false);
  const focusTree = (): void => {
    wantsTreeFocus.current = true;
    setVersion((version) => version + 1);
  };
  useEffect(() => {
    if (!wantsTreeFocus.current || confirm) return;
    wantsTreeFocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || panel.current?.contains(active)) treeElement.current?.focus();
  });

  // A new folder or session: a fresh tree, open folders are gone, and answers for the old one no longer match.
  // `target` is a new object on every store change; only its key decides.
  const key = target.kind === "folder" ? target.key : undefined;
  const location = target.kind === "folder" ? target.location : undefined;
  useEffect(() => {
    setNotice(undefined);
    setMenu(undefined);
    setRenaming(undefined);
    // A confirmation must not delete in a folder the panel no longer shows; a pending one does not open.
    setConfirm(undefined);
    pendingDelete.current = undefined;
    shownKey.current = key;
    if (key === undefined || location === undefined) return;
    const { tree: next, request } = loadRoot(treeFor(location, tree.current));
    update(next);
    run(request);
  }, [key]);

  const current = key !== undefined && shownKey.current === key ? tree.current : undefined;
  const view = panelView(target, current);
  const selected = current?.selected;
  const context: MenuContext | undefined =
    target.kind === "folder" ? { writer: paste !== undefined, shell: pasteShell(target.session) } : undefined;
  /** The hint of an action that answers later, unless the panel shows another folder by then. */
  const hintFor =
    (own: string | undefined) =>
    (text: string | undefined): void => {
      if (shownKey.current === own) setNotice(text);
    };

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
      case "rename":
      case "delete":
        runFile(action.kind, action.path);
        return;
      case "open": {
        const row = entryRow(view.rows, action.path);
        if (!row) return;
        update(selectEntry(now, action.path));
        setNotice(undefined);
        const own = key;
        const hint = hintFor(own);
        void files
          .open(locationAt(now, action.path))
          .catch(failed)
          .then((result) => {
            // A hint for a file of a folder the panel no longer shows would be misleading.
            if (result.ok) return;
            hint(openErrorText(row.name, result.code));
            reloadAfterFailure(own, [row.parent]);
          });
        return;
      }
    }
  };

  /** Runs a file action on the entry at `path`, if its menu offers it (the keys take the same entries). */
  const runFile = (action: FileAction, path: string): void => {
    const now = tree.current;
    if (!now || shownKey.current !== key || !context) return;
    const row = entryRow(rowsNow(now), path);
    const at = locationAt(now, path);
    if (!row || !offers(explorerMenu(row, at, context), action)) return;
    const own = key;
    const hint = hintFor(own);
    setNotice(undefined);
    switch (action) {
      case "open":
        apply({ kind: "open", path });
        return;
      case "rename":
        update(selectEntry(now, path));
        setRenaming({ path, busy: false });
        return;
      case "delete":
        update(selectEntry(now, path));
        askDelete(row, at);
        return;
      case "download":
        void files
          .download(at)
          .catch(failed)
          .then((result) => {
            if (result.ok) {
              if (!result.cancelled) hint(skippedText(result.skipped));
              return;
            }
            hint(actionErrorText("download", row.name, result.code));
            reloadAfterFailure(own, [row.parent]);
          });
        return;
      case "reveal":
        void files
          .reveal(at)
          .catch(failed)
          .then((result) => {
            if (result.ok) return;
            hint(actionErrorText("reveal", row.name, result.code));
            reloadAfterFailure(own, [row.parent]);
          });
        return;
      case "copyPath":
        clipboard.writeText(path).catch(() => hint(CLIPBOARD_FAILED));
        return;
      case "pastePath": {
        const text = quotePath(path, context.shell);
        if (text !== undefined && paste && !paste(text)) hint(PASTE_NO_WRITER);
        return;
      }
    }
  };

  /** The confirmation of a delete; for a folder after a listing, so it can name the number of entries. */
  const askDelete = (row: EntryRow, at: FileLocation): void => {
    const own = key;
    if (own === undefined) return;
    deleteCount.current += 1;
    const request: DeleteRequest = { id: deleteCount.current, key: own, path: row.path };
    pendingDelete.current = request.id;
    const ask = (count?: number): void => {
      const opens = deletePromptOpens(
        request,
        pendingDelete.current,
        shownKey.current,
        tree.current?.selected,
      );
      if (pendingDelete.current === request.id) pendingDelete.current = undefined;
      if (opens)
        setConfirm({
          row,
          location: at,
          confirmation: deleteConfirmation(row.name, countsEntries(row), count),
          key: own,
        });
    };
    if (!countsEntries(row)) {
      ask();
      return;
    }
    void files
      .list(at)
      .catch(failed)
      .then((result) => ask(result.ok ? result.total : undefined));
  };

  const runDelete = async (): Promise<void> => {
    if (!confirm) return;
    const { row, location: at, key: own } = confirm;
    if (!deleteRuns(own, shownKey.current)) {
      setConfirm(undefined);
      return;
    }
    const result = await files.delete(at).catch(failed);
    setConfirm(undefined);
    focusTree();
    const now = tree.current;
    if (!deleteRuns(own, shownKey.current) || !now) return;
    if (result.ok) settle(afterDelete(now, row));
    else {
      setNotice(actionErrorText("delete", row.name, result.code));
      reloadAfterFailure(own, [row.parent]);
    }
  };

  const commitRename = (row: EntryRow, value: string): void => {
    const name = renameTarget(row.name, value);
    const now = tree.current;
    if (name === undefined || !now) {
      setRenaming(undefined);
      focusTree();
      return;
    }
    setRenaming({ path: row.path, busy: true });
    const own = key;
    void files
      .rename(locationAt(now, row.path), name)
      .catch(failed)
      .then((result) => {
        const latest = tree.current;
        if (shownKey.current !== own || !latest) return;
        setRenaming(undefined);
        if (result.ok) settle(afterRename(latest, row, name));
        else {
          setNotice(actionErrorText("rename", row.name, result.code, name));
          settle(afterFailure(latest, [row.parent]));
        }
        focusTree();
      });
  };

  const move = (source: string, targetDir: string): void => {
    const now = tree.current;
    const row = now ? entryRow(rowsNow(now), source) : undefined;
    if (!now || !row) return;
    setNotice(undefined);
    const own = key;
    void files
      .move(locationAt(now, source), locationAt(now, targetDir))
      .catch(failed)
      .then((result) => {
        const latest = tree.current;
        if (shownKey.current !== own || !latest) return;
        if (result.ok) settle(afterMove(latest, row, targetDir));
        else {
          setNotice(actionErrorText("move", row.name, result.code));
          settle(afterFailure(latest, [row.parent, targetDir]));
        }
      });
  };

  // A rename whose row went without a blur (a late listing, its folder closed) ends, so menu and dragging work again.
  useEffect(() => {
    if (renaming && current && !keepsRename(renaming, view.rows)) setRenaming(undefined);
  });

  // Rows move onto folder rows and the header (the root); the rules are `canDropEntry`, judged on the tree shown now.
  useDropHandler({
    accepts: (payload, targetId) => {
      const to = dropTargetPath(targetId);
      const now = tree.current;
      if (payload.kind !== ENTRY_KIND || to === undefined || !now || shownKey.current !== key) return false;
      return canDropEntry({ root: now.root, rows: rowsNow(now) }, payload.id, to);
    },
    onDrop: (payload, targetId) => {
      const to = dropTargetPath(targetId);
      if (to !== undefined) move(payload.id, to);
    },
  });

  // The key that focuses the panel (`focusStep`): the tree takes the keys, the panel itself while it shows a text.
  // While the root loads the wish waits for the tree; it is used once, so showing the panel later takes nothing.
  useEffect(() => {
    const step = focusStep(focusWanted, view.state, treeElement.current !== null);
    if (step.target === "tree") treeElement.current?.focus();
    else if (step.target === "panel") panel.current?.focus();
    if (focusWanted && step.settled) onFocused();
  }, [focusWanted, view.state]);
  // A panel that goes away keeps no wish for the next one.
  const settleFocus = useRef(onFocused);
  settleFocus.current = onFocused;
  useEffect(() => () => settleFocus.current(), []);

  useEffect(() => {
    if (selected !== undefined)
      treeElement.current
        ?.querySelector(`[data-path="${CSS.escape(selected)}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const path = location?.path;
  const rootTarget = current && path !== undefined ? explorerDropTarget(path) : undefined;
  const menuRow = menu && current ? entryRow(view.rows, menu.path) : undefined;
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
        // Escape anywhere in the panel; the tree handles its own keys first. Menu and dialog hang in the body (a
        // portal): React passes their keys up here, but their Escape is theirs.
        if (event.key !== "Escape" || !(event.target instanceof Node)) return;
        if (!event.currentTarget.contains(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        onLeave();
      }}
    >
      <Divider panel={panel} width={width} onResize={onResize} />
      <div className="explorer__header">
        <span
          className={`explorer__path${rootTarget === undefined ? "" : ` ${drag.targetClass(rootTarget)}`}`}
          title={path}
          data-explorer-path={path ?? ""}
          {...(rootTarget === undefined ? {} : { "data-drop-target": rootTarget })}
        >
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
          // Right click on a row, or the menu key and Shift+F10 on the tree (Chromium sends `contextmenu` for both,
          // without a pointer position): the menu of that row or of the selected one.
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const now = tree.current;
            if (!now || renaming) return;
            const element =
              event.target instanceof Element ? event.target.closest<HTMLElement>("[data-path]") : null;
            const path = menuPath(element?.dataset["path"], selected);
            const row = path === undefined ? undefined : entryRow(view.rows, path);
            if (!row) return;
            const anchor =
              element ??
              treeElement.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(row.path)}"]`);
            update(selectEntry(now, row.path));
            treeElement.current?.focus();
            setMenu({
              ...menuPoint({ x: event.clientX, y: event.clientY }, anchor?.getBoundingClientRect()),
              path: row.path,
            });
          }}
        >
          {view.rows.map((row) => {
            const entry = row.kind === "entry" ? row : undefined;
            const editing = entry !== undefined && renaming?.path === entry.path ? renaming : undefined;
            const draggable =
              entry !== undefined && current !== undefined && renaming === undefined
                ? !isProtectedPath(locationAt(current, entry.path))
                : false;
            const dropId = entry && isDropFolder(entry) ? explorerDropTarget(entry.path) : undefined;
            return (
              <Row
                key={`${row.kind}:${row.path}`}
                row={row}
                selected={entry !== undefined && entry.path === selected}
                rename={
                  editing && entry
                    ? {
                        busy: editing.busy,
                        onCommit: (value) => commitRename(entry, value),
                        onCancel: () => {
                          setRenaming(undefined);
                          focusTree();
                        },
                      }
                    : undefined
                }
                {...(draggable && entry
                  ? { source: drag.sourceProps({ kind: ENTRY_KIND, id: entry.path, label: entry.name }) }
                  : {})}
                {...(dropId === undefined
                  ? {}
                  : { drop: { id: dropId, className: drag.targetClass(dropId) } })}
                onClick={(clicked) => {
                  treeElement.current?.focus();
                  apply(explorerClick(clicked));
                }}
                onDoubleClick={(clicked) => {
                  const action = explorerDoubleClick(clicked);
                  if (action) apply(action);
                }}
              />
            );
          })}
        </div>
      )}
      {menu &&
        menuRow &&
        current &&
        context &&
        createPortal(
          <ContextMenu
            x={menu.x}
            y={menu.y}
            label={MENU_LABEL}
            entries={explorerMenu(menuRow, locationAt(current, menuRow.path), context).map((entry) => ({
              ...entry,
              action: () => runFile(entry.action, menuRow.path),
            }))}
            onClose={() => {
              setMenu(undefined);
              treeElement.current?.focus();
            }}
          />,
          document.body,
        )}
      {confirm &&
        createPortal(
          <ConfirmDialog
            confirmation={confirm.confirmation}
            onConfirm={runDelete}
            onCancel={() => {
              setConfirm(undefined);
              focusTree();
            }}
          />,
          document.body,
        )}
    </aside>
  );
}

interface RenameProps {
  busy: boolean;
  onCommit(value: string): void;
  onCancel(): void;
}

function Row({
  row,
  selected,
  rename,
  source,
  drop,
  onClick,
  onDoubleClick,
}: {
  row: ExplorerRow;
  selected: boolean;
  rename: RenameProps | undefined;
  /** Props of a drag source (`DragApi.sourceProps`); absent for a row that does not move. */
  source?: { onPointerDown: (event: ReactPointerEvent) => void };
  /** A folder row is a drop target. */
  drop?: { id: string; className: string };
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
      className={`explorer__row${selected ? " explorer__row--selected" : ""}${drop ? ` ${drop.className}` : ""}`}
      style={{ paddingLeft: indent }}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      {...(row.folder ? { "aria-expanded": row.expanded } : {})}
      data-path={row.path}
      data-kind={row.folder ? "folder" : "file"}
      {...(drop ? { "data-drop-target": drop.id } : {})}
      title={row.name}
      // The tree keeps the focus; a press must not move it to the row (it has none) or select text.
      onMouseDown={(event) => event.preventDefault()}
      {...(source ?? {})}
      onClick={() => onClick(row)}
      onDoubleClick={() => onDoubleClick(row)}
    >
      <span className="explorer__twisty" aria-hidden="true">
        {row.folder ? (row.expanded ? "▾" : "▸") : ""}
      </span>
      {rename ? (
        <RenameField name={row.name} folder={row.folder} {...rename} />
      ) : (
        <span className="explorer__name">{row.name}</span>
      )}
    </div>
  );
}

/**
 * The field of a rename in the row (#203): Enter confirms, Escape and leaving the field cancel. It keeps every key to
 * itself, so neither the tree nor the window's key handler (nor the terminal) sees one.
 */
function RenameField({
  name,
  folder,
  busy,
  onCommit,
  onCancel,
}: RenameProps & { name: string; folder: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(name);
  // Read in the handlers: while the service answers, neither a key nor the lost focus cancels.
  const waiting = useRef(busy);
  waiting.current = busy;
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(...renameSelection(name, folder));
  }, []);
  const stop = (event: { stopPropagation(): void }): void => event.stopPropagation();
  return (
    <input
      ref={input}
      className="explorer__rename"
      value={value}
      readOnly={busy}
      spellCheck={false}
      aria-label="Neuer Name"
      data-explorer-rename=""
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          if (!waiting.current) onCommit(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          if (!waiting.current) onCancel();
        }
      }}
      onBlur={() => {
        if (!waiting.current) onCancel();
      }}
      // The row's handlers would select, open or drag; the field takes its own presses.
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
    />
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
