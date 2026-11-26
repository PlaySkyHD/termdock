// Tree of the explorer panel (#202, ADR 0009): the folder the panel shows, the folders below it that are open, what
// each listing answered and which entry is selected. Pure and free of React and DOM; `ExplorerPanel.tsx` keeps one
// tree in its state and changes it only through these functions. File actions (#203) build on the same tree:
// `entryRow` finds an entry, `selectEntry` marks it, `replaceEntry` puts a renamed or removed entry in place and
// `reloadFolder` lists a folder again after an action.
import type { FileEntry, FileErrorCode, FileListResult, FileLocation } from "../shared/files.js";

/** What the panel knows of one folder. */
export type FolderState =
  | {
      status: "loading";
      /** Answers of other loads of this folder are stale. */
      token: number;
      /** The entries of the last listing, shown until the new one arrives (refresh without flicker). */
      previous?: LoadedFolder;
    }
  | ({ status: "loaded" } & LoadedFolder)
  | { status: "error"; code: FileErrorCode };

export interface LoadedFolder {
  /** In the order of the file service: folders first, then by name. */
  entries: readonly FileEntry[];
  truncated: boolean;
  total: number;
}

export interface ExplorerTree {
  /** The folder the panel shows (the current directory of the session). */
  readonly root: FileLocation;
  /** By path; the root folder too. */
  readonly folders: ReadonlyMap<string, FolderState>;
  /** Paths of open folders below the root; the root is always open. */
  readonly expanded: ReadonlySet<string>;
  /** Path of the selected entry. */
  readonly selected?: string;
  /** Token of the next load; a new tree for another folder continues the count, so no old answer matches. */
  readonly nextToken: number;
}

/** One load to run: `files.list(location)`, then `finishLoad` with the same request. */
export interface ListRequest {
  readonly location: FileLocation;
  readonly token: number;
}

export type ExplorerRow =
  | {
      kind: "entry";
      path: string;
      name: string;
      depth: number;
      entry: FileEntry;
      /** A folder or a symlink to one: it opens in the tree. */
      folder: boolean;
      expanded: boolean;
    }
  /** Shown under an open folder whose listing is not there (yet). */
  | { kind: "loading"; path: string; depth: number }
  | { kind: "empty"; path: string; depth: number }
  | { kind: "error"; path: string; depth: number; code: FileErrorCode }
  /** The folder has more entries than the service returns (`total` of them). */
  | { kind: "truncated"; path: string; depth: number; shown: number; total: number };

/**
 * A tree for `root` with nothing loaded. `previous` is the tree the panel showed before: its token count goes on, so
 * a slow answer for the old folder never lands in the new one. Open folders and the selection are dropped.
 */
export function treeFor(root: FileLocation, previous?: ExplorerTree): ExplorerTree {
  return { root, folders: new Map(), expanded: new Set(), nextToken: previous?.nextToken ?? 1 };
}

/** The location of `path` in the backend (and distro) of the tree. */
export function locationAt(tree: ExplorerTree, path: string): FileLocation {
  return tree.root.backend === "wsl" ? { ...tree.root, path } : { backend: "windows", path };
}

/** Path of the entry `name` in the folder `parent`, with the separator of the backend. */
export function childPath(backend: FileLocation["backend"], parent: string, name: string): string {
  const separator = backend === "wsl" ? "/" : "\\";
  return parent.endsWith(separator) ? `${parent}${name}` : `${parent}${separator}${name}`;
}

/** Whether the entry opens in the tree: a folder, or a symlink whose target is one. */
export function isFolder(entry: FileEntry): boolean {
  return entry.kind === "directory" || (entry.kind === "symlink" && entry.targetKind === "directory");
}

/** Starts a load of the folder at `path`; entries listed before stay visible until the answer. */
export function startLoad(tree: ExplorerTree, path: string): { tree: ExplorerTree; request: ListRequest } {
  const token = tree.nextToken;
  const known = tree.folders.get(path);
  const previous =
    known?.status === "loaded" ? loadedPart(known) : known?.status === "loading" ? known.previous : undefined;
  const folders = new Map(tree.folders);
  folders.set(path, { status: "loading", token, ...(previous ? { previous } : {}) });
  return {
    tree: { ...tree, folders, nextToken: token + 1 },
    request: { location: locationAt(tree, path), token },
  };
}

/**
 * Takes the answer of `request`. A stale answer (another folder, a newer load of the same one, a tree for another
 * root) changes nothing and returns `tree` itself.
 */
export function finishLoad(tree: ExplorerTree, request: ListRequest, result: FileListResult): ExplorerTree {
  if (!sameRoot(tree.root, request.location)) return tree;
  const path = request.location.path;
  const known = tree.folders.get(path);
  if (known?.status !== "loading" || known.token !== request.token) return tree;
  const folders = new Map(tree.folders);
  folders.set(
    path,
    result.ok
      ? { status: "loaded", entries: result.entries, truncated: result.truncated, total: result.total }
      : { status: "error", code: result.code },
  );
  return { ...tree, folders };
}

/** Loads the root folder (when the panel shows a new folder). */
export function loadRoot(tree: ExplorerTree): { tree: ExplorerTree; request: ListRequest } {
  return startLoad(tree, tree.root.path);
}

/**
 * Opens the folder at `path`. It is listed when it was never listed or its listing failed; a folder listed before
 * shows its entries at once (the refresh button lists again). Returns the request to run, if any.
 */
export function expand(tree: ExplorerTree, path: string): { tree: ExplorerTree; request?: ListRequest } {
  const opened: ExplorerTree = tree.expanded.has(path)
    ? tree
    : { ...tree, expanded: new Set([...tree.expanded, path]) };
  const known = opened.folders.get(path);
  if (known === undefined || known.status === "error") return startLoad(opened, path);
  return { tree: opened };
}

/** Closes the folder at `path`; open folders below it stay open for the next time. */
export function collapse(tree: ExplorerTree, path: string): ExplorerTree {
  if (!tree.expanded.has(path)) return tree;
  const expanded = new Set(tree.expanded);
  expanded.delete(path);
  return { ...tree, expanded };
}

/** Marks the entry at `path` as selected (undefined clears the selection). */
export function selectEntry(tree: ExplorerTree, path: string | undefined): ExplorerTree {
  if (tree.selected === path) return tree;
  const { selected: _old, ...rest } = tree;
  return path === undefined ? rest : { ...rest, selected: path };
}

/**
 * Lists the root and every open folder again (the refresh button). Folders that are open but below a closed one
 * are listed when they show again. Returns one request per folder.
 */
export function refreshAll(tree: ExplorerTree): { tree: ExplorerTree; requests: ListRequest[] } {
  let next = tree;
  const requests: ListRequest[] = [];
  for (const row of [{ path: tree.root.path }, ...visibleFolders(tree)]) {
    const started = startLoad(next, row.path);
    next = started.tree;
    requests.push(started.request);
  }
  return { tree: next, requests };
}

/** Lists one folder again, e.g. after a file action in it (#203). A folder never listed is left alone. */
export function reloadFolder(
  tree: ExplorerTree,
  path: string,
): { tree: ExplorerTree; request?: ListRequest } {
  if (!tree.folders.has(path)) return { tree };
  return startLoad(tree, path);
}

/**
 * Replaces the entry `name` in the listed folder `parent` with `next`, or removes it without `next` (#203: after a
 * rename or delete, before the folder is listed again). The order of the service stays: a replaced entry keeps its
 * place. A removed open folder closes, and a selection on it or below it goes.
 */
export function replaceEntry(
  tree: ExplorerTree,
  parent: string,
  name: string,
  next?: FileEntry,
): ExplorerTree {
  const folder = tree.folders.get(parent);
  if (folder?.status !== "loaded") return tree;
  const index = folder.entries.findIndex((entry) => entry.name === name);
  if (index < 0) return tree;
  const entries =
    next === undefined ? folder.entries.toSpliced(index, 1) : folder.entries.toSpliced(index, 1, next);
  const folders = new Map(tree.folders);
  folders.set(parent, { ...folder, entries, total: folder.total - (next === undefined ? 1 : 0) });
  const gone = childPath(tree.root.backend, parent, name);
  // The same name (new size or time): open folders and the selection below it stay.
  if (next?.name === name) return { ...tree, folders };
  const below = (path: string): boolean => path === gone || isBelow(tree.root.backend, gone, path);
  const expanded = new Set([...tree.expanded].filter((path) => !below(path)));
  for (const path of [...folders.keys()]) if (below(path)) folders.delete(path);
  const changed = { ...tree, folders, expanded };
  return tree.selected !== undefined && below(tree.selected) ? selectEntry(changed, undefined) : changed;
}

/** The visible rows below the root, depth first, in the order of the service. */
export function rowsOf(tree: ExplorerTree): ExplorerRow[] {
  const rows: ExplorerRow[] = [];
  const walk = (path: string, depth: number): void => {
    const folder = shownFolder(tree.folders.get(path));
    if (folder === undefined) {
      const state = tree.folders.get(path);
      if (depth > 0 && state?.status === "error") rows.push({ kind: "error", path, depth, code: state.code });
      else if (depth > 0) rows.push({ kind: "loading", path, depth });
      return;
    }
    if (folder.entries.length === 0 && depth > 0) rows.push({ kind: "empty", path, depth });
    for (const entry of folder.entries) {
      const entryPath = childPath(tree.root.backend, path, entry.name);
      const opens = isFolder(entry);
      const expanded = opens && tree.expanded.has(entryPath);
      rows.push({ kind: "entry", path: entryPath, name: entry.name, depth, entry, folder: opens, expanded });
      if (expanded) walk(entryPath, depth + 1);
    }
    if (folder.truncated)
      rows.push({ kind: "truncated", path, depth, shown: folder.entries.length, total: folder.total });
  };
  walk(tree.root.path, 0);
  return rows;
}

/** The entry row at `path`, if it is visible. */
export function entryRow(
  rows: readonly ExplorerRow[],
  path: string,
): Extract<ExplorerRow, { kind: "entry" }> | undefined {
  return rows.find(
    (row): row is Extract<ExplorerRow, { kind: "entry" }> => row.kind === "entry" && row.path === path,
  );
}

/** Paths of the open folders that are visible (open, and every folder above them open too). */
function visibleFolders(tree: ExplorerTree): Array<{ path: string }> {
  return rowsOf(tree).filter((row) => row.kind === "entry" && row.expanded);
}

/** The entries a folder shows: its listing, or the previous one while it loads again. */
function shownFolder(state: FolderState | undefined): LoadedFolder | undefined {
  if (state?.status === "loaded") return state;
  if (state?.status === "loading") return state.previous;
  return undefined;
}

function loadedPart(folder: LoadedFolder): LoadedFolder {
  return { entries: folder.entries, truncated: folder.truncated, total: folder.total };
}

function sameRoot(root: FileLocation, location: FileLocation): boolean {
  return (
    root.backend === location.backend &&
    (root.backend !== "wsl" || location.backend !== "wsl" || root.distro === location.distro)
  );
}

function isBelow(backend: FileLocation["backend"], parent: string, path: string): boolean {
  return path.startsWith(childPath(backend, parent, ""));
}
