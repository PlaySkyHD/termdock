// File actions of the explorer panel (#203, ADR 0009): which actions a row offers, where an entry may be dragged,
// the texts of the confirmation and the hints, and the tree after an action. Pure; `ExplorerPanel.tsx` runs the calls
// of `window.termdock.files` and draws. The file service checks every location again (it is the boundary); these
// rules only decide what the panel offers.
import type { FileErrorCode, FileLocation } from "../shared/files.js";
import { childPath, entryRow, expand, reloadFolder, replaceEntry, selectEntry } from "./explorer-tree.js";
import type { ExplorerRow, ExplorerTree, ListRequest } from "./explorer-tree.js";
import { quotePath } from "./path-quote.js";
import type { PasteShell } from "./path-quote.js";
import type { Confirmation, MenuEntry } from "./sidebar-model.js";

type EntryRow = Extract<ExplorerRow, { kind: "entry" }>;

export type FileAction = "open" | "download" | "reveal" | "copyPath" | "pastePath" | "rename" | "delete";

/** Payload kind of a dragged row (`DragPayload.kind`); its id is the path. */
export const ENTRY_KIND = "explorer-entry";
const DROP_PREFIX = "explorer:";

/** Drop target id of a folder row or the header (the root). */
export function explorerDropTarget(path: string): string {
  return `${DROP_PREFIX}${path}`;
}

/** The path of a drop target id of the explorer, or undefined for another id. */
export function dropTargetPath(targetId: string): string | undefined {
  return targetId.startsWith(DROP_PREFIX) ? targetId.slice(DROP_PREFIX.length) : undefined;
}

/**
 * Places the file service never renames, moves or deletes (`isProtected` in `main/file-paths.ts`, which the renderer
 * cannot load): WSL `/`, every entry directly under `/` and `/mnt`, and directly under `/mnt/wsl`; a Windows drive.
 */
export function isProtectedPath(location: FileLocation): boolean {
  if (location.backend === "windows") return /^[A-Za-z]:\\?$/.test(location.path);
  const segments = location.path.split("/").filter((segment) => segment !== "");
  if (segments.length <= 1) return true;
  if (segments[0] === "mnt") return segments.length === 2 || (segments[1] === "wsl" && segments.length === 3);
  return false;
}

export interface MenuContext {
  /** The panel's session has a writing view in this tab: the path can be pasted there. */
  writer: boolean;
  /** The shell a pasted path is quoted for. */
  shell: PasteShell;
}

export const PASTE_NO_WRITER = "Nur in ein schreibendes Pane der Session: zuerst „Eingabe übernehmen“";
/** A path `quotePath` refuses: control characters, or `%` for cmd. */
export const PASTE_UNSAFE = "Der Pfad lässt sich in dieser Shell nicht sicher einfügen";
/** The hint when "Pfad kopieren" could not write the clipboard. */
export const CLIPBOARD_FAILED = "Zwischenablage nicht verfügbar";

/**
 * The context menu of `row` at `location`: open (files only), download (WSL only), reveal | copy and paste the path |
 * rename and delete (not on a protected location). Paste is disabled without a writer or for a path that cannot be
 * quoted. The keys F2 and Delete take the same entries (`offers`).
 */
export function explorerMenu(
  row: EntryRow,
  location: FileLocation,
  context: MenuContext,
): MenuEntry<FileAction>[] {
  const quotable = quotePath(location.path, context.shell) !== undefined;
  const pasteHint = !context.writer ? PASTE_NO_WRITER : !quotable ? PASTE_UNSAFE : undefined;
  const entries: MenuEntry<FileAction>[] = [];
  if (!row.folder) entries.push({ key: "open", label: "Öffnen", action: "open" });
  if (location.backend === "wsl")
    entries.push({ key: "download", label: "Herunterladen …", action: "download" });
  entries.push(
    { key: "reveal", label: "Im Windows-Explorer zeigen", action: "reveal" },
    { key: "copyPath", label: "Pfad kopieren", action: "copyPath", separator: true },
    {
      key: "pastePath",
      label: "Pfad ins Terminal einfügen",
      action: "pastePath",
      ...(pasteHint === undefined ? {} : { disabled: true, hint: pasteHint }),
    },
  );
  if (!isProtectedPath(location))
    entries.push(
      { key: "rename", label: "Umbenennen", action: "rename", separator: true },
      { key: "delete", label: "Löschen …", action: "delete", danger: true },
    );
  return entries;
}

/**
 * The entry a `contextmenu` event of the tree is for: the row under the pointer (`rowPath`, the row the event's target
 * is in), else the selected one (menu key and Shift+F10 go to the focused tree).
 */
export function menuPath(rowPath: string | undefined, selected: string | undefined): string | undefined {
  return rowPath ?? selected;
}

/**
 * Where the menu opens: at the pointer; for the menu key and Shift+F10, which send the event without a pointer
 * position (0, 0), below the row and a little in from its left edge, like the sidebar.
 */
export function menuPoint(
  client: { x: number; y: number },
  row: { left: number; bottom: number } | undefined,
): { x: number; y: number } {
  const fromKeyboard = client.x === 0 && client.y === 0;
  return fromKeyboard && row ? { x: row.left + 24, y: row.bottom } : client;
}

/** Whether `entries` offer `action` and it is enabled. */
export function offers(entries: readonly MenuEntry<FileAction>[], action: FileAction): boolean {
  return entries.some((entry) => entry.action === action && entry.disabled !== true);
}

/**
 * Whether the entry at `source` may be dropped on `target`: the root or a visible row of a real folder (`isDropFolder`),
 * but never the entry itself, a path below it or the folder it is in already. A protected entry (or one no longer
 * shown) does not move.
 */
export function canDropEntry(
  view: { root: FileLocation; rows: readonly ExplorerRow[] },
  source: string,
  target: string,
): boolean {
  const entry = view.rows.find((row): row is EntryRow => row.kind === "entry" && row.path === source);
  if (!entry || isProtectedPath(at(view.root, source))) return false;
  const isTarget =
    target === view.root.path ||
    view.rows.some((row) => row.kind === "entry" && isDropFolder(row) && row.path === target);
  if (!isTarget || target === source || target === entry.parent) return false;
  return !target.startsWith(childPath(view.root.backend, source, ""));
}

/**
 * Whether a row is a drop target: only a real folder. A symlink to one could point at the dragged entry itself or
 * below it, which the paths cannot show, so "never into itself" would not hold.
 */
export function isDropFolder(row: EntryRow): boolean {
  return row.entry.kind === "directory";
}

/**
 * The new name for a rename: undefined when the input is the old name unchanged (also one with spaces at its ends)
 * or blank; otherwise the input as typed. The main process checks the name (ADR 0009); trimming here would rename an
 * untouched name with spaces at its ends.
 */
export function renameTarget(oldName: string, input: string): string | undefined {
  if (input === oldName || input.trim() === "") return undefined;
  return input;
}

/** A rename in progress: the row whose name is a field, and whether the service is answering. */
export interface RenameState {
  path: string;
  busy: boolean;
}

/**
 * Whether a rename field stays: while the service answers (the answer ends it), or while its row is visible. A row
 * that goes without a blur (a late listing, its folder closed) would leave the field state behind and keep the menu
 * and dragging locked.
 */
export function keepsRename(rename: RenameState, rows: readonly ExplorerRow[]): boolean {
  return rename.busy || entryRow(rows, rename.path) !== undefined;
}

/** One Delete that waits for the listing of its folder before the confirmation opens. */
export interface DeleteRequest {
  /** Counts up per Delete; only the latest opens. */
  id: number;
  /** The key of the folder the panel showed (`ExplorerTarget.key`). */
  key: string;
  path: string;
}

/**
 * Whether the answer for `request` opens the confirmation: it is the latest Delete (`latest`, the id of the last one
 * asked), the panel still shows its folder, and its entry is still selected. A slow listing of an earlier Delete must
 * not replace the dialog of a later one, nor open one for an entry the user has left.
 */
export function deletePromptOpens(
  request: DeleteRequest,
  latest: number | undefined,
  shownKey: string | undefined,
  selected: string | undefined,
): boolean {
  return request.id === latest && request.key === shownKey && request.path === selected;
}

/** Whether a confirmed delete runs: only while the panel shows the folder the dialog was opened for. */
export function deleteRuns(dialogKey: string, shownKey: string | undefined): boolean {
  return dialogKey === shownKey;
}

/** What the field of a rename marks at first: the name of a file without its extension, all of a folder's name. */
export function renameSelection(name: string, folder: boolean): [number, number] {
  const dot = name.lastIndexOf(".");
  return folder || dot <= 0 ? [0, name.length] : [0, dot];
}

/**
 * Whether the confirmation of a delete counts the entries of `row`: only a real folder. A symlink to a folder is
 * removed itself (the service never follows it), so its target's entries are not deleted.
 */
export function countsEntries(row: EntryRow): boolean {
  return row.entry.kind === "directory";
}

/** The confirmation before a delete; `count` is the number of direct entries of a folder, when the listing told it. */
export function deleteConfirmation(name: string, folder: boolean, count?: number): Confirmation {
  const what = !folder
    ? `„${name}“ wird endgültig gelöscht.`
    : count === undefined
      ? `Der Ordner „${name}“ wird endgültig gelöscht, mit allem darin.`
      : count === 0
        ? `Der leere Ordner „${name}“ wird endgültig gelöscht.`
        : `Der Ordner „${name}“ mit ${count === 1 ? "1 Eintrag" : `${count} Einträgen`} wird endgültig gelöscht, mit allem darin.`;
  return {
    title: "Endgültig löschen?",
    message: `${what} Es gibt keinen Papierkorb.`,
    confirm: "Löschen",
  };
}

export type FailedAction = "rename" | "move" | "delete" | "download" | "reveal";

const DONE: Record<FailedAction, string> = {
  rename: "umbenannt",
  move: "verschoben",
  delete: "gelöscht",
  download: "heruntergeladen",
  reveal: "gezeigt",
};

/** The hint after a failed action on `name`; `newName` is the name a rename wanted. Never a path. */
export function actionErrorText(
  action: FailedAction,
  name: string,
  code: FileErrorCode,
  newName?: string,
): string {
  switch (code) {
    case "ENOENT":
      return `„${name}“ gibt es nicht mehr`;
    case "EACCES":
      return `Kein Zugriff auf „${name}“`;
    case "EEXIST":
      if (action === "rename" && newName !== undefined) return `„${newName}“ gibt es in diesem Ordner schon`;
      if (action === "move") return `Im Ziel gibt es „${name}“ schon`;
      break;
    case "EINVAL":
      if (action === "rename" && newName !== undefined) return `„${newName}“ ist kein gültiger Name`;
      return `„${name}“ kann nicht ${action === "move" ? "dorthin verschoben" : DONE[action]} werden`;
    case "OTHER":
      break;
  }
  return `„${name}“ konnte nicht ${DONE[action]} werden`;
}

/** The hint after a download that skipped entries (symlinks, names Windows cannot hold); undefined for none. */
export function skippedText(skipped: number): string | undefined {
  if (skipped <= 0) return undefined;
  return skipped === 1 ? "1 Eintrag übersprungen" : `${skipped} Einträge übersprungen`;
}

/** A tree after an action and the listings to run for it. */
export interface ActionOutcome {
  tree: ExplorerTree;
  requests: ListRequest[];
}

/** After a rename: the entry takes its new name at once and is selected; its folder lists again. */
export function afterRename(tree: ExplorerTree, row: EntryRow, newName: string): ActionOutcome {
  const renamed = replaceEntry(tree, row.parent, row.name, { ...row.entry, name: newName });
  const selected = selectEntry(renamed, childPath(tree.root.backend, row.parent, newName));
  return reload(selected, [row.parent]);
}

/**
 * After a move into `target`: the entry leaves its folder at once, a closed target opens, both folders list again,
 * and the moved entry is selected (visible once the target's listing is there).
 */
export function afterMove(tree: ExplorerTree, row: EntryRow, target: string): ActionOutcome {
  const removed = replaceEntry(tree, row.parent, row.name);
  const requests: ListRequest[] = [];
  let next = removed;
  if (target !== tree.root.path && !next.expanded.has(target)) {
    const opened = expand(next, target);
    next = opened.tree;
    if (opened.request) requests.push(opened.request);
  }
  const selected = selectEntry(next, childPath(tree.root.backend, target, row.name));
  const folders = requests.length > 0 ? [row.parent] : [row.parent, target];
  const reloaded = reload(selected, folders);
  return { tree: reloaded.tree, requests: [...requests, ...reloaded.requests] };
}

/** After a delete: the entry leaves the tree at once (open folders below it close); its folder lists again. */
export function afterDelete(tree: ExplorerTree, row: EntryRow): ActionOutcome {
  return reload(replaceEntry(tree, row.parent, row.name), [row.parent]);
}

/** After a failed action: the folders involved list again (each once; one never listed is left alone). */
export function afterFailure(tree: ExplorerTree, folders: readonly string[]): ActionOutcome {
  return reload(tree, folders);
}

function reload(tree: ExplorerTree, folders: readonly string[]): ActionOutcome {
  let next = tree;
  const requests: ListRequest[] = [];
  for (const folder of new Set(folders)) {
    const started = reloadFolder(next, folder);
    next = started.tree;
    if (started.request) requests.push(started.request);
  }
  return { tree: next, requests };
}

function at(root: FileLocation, path: string): FileLocation {
  return root.backend === "wsl" ? { ...root, path } : { backend: "windows", path };
}
