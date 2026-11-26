// Keyboard of the explorer tree (#202): what a key does on the visible rows. Pure; the panel runs the action. The
// keys follow the tree view of VS Code and the Windows Explorer: up and down move, right opens or goes into a
// folder, left closes or goes to the parent folder, Enter opens a file or a folder, F2 renames, Delete asks to delete
// (#203), Escape hands the keys back to the terminal.
import type { ExplorerRow } from "./explorer-tree.js";

export type ExplorerKeyAction =
  | { kind: "select"; path: string }
  | { kind: "expand"; path: string }
  | { kind: "collapse"; path: string }
  /** A file: `files.open`. */
  | { kind: "open"; path: string }
  /** F2 (#203): the name of the entry becomes a field. The panel checks that the menu offers it. */
  | { kind: "rename"; path: string }
  /** Delete (#203): the confirmation for the entry. The panel checks that the menu offers it. */
  | { kind: "delete"; path: string }
  /** The terminal of the active pane takes the focus. */
  | { kind: "leave" };

type EntryRow = Extract<ExplorerRow, { kind: "entry" }>;

/** A click on an entry: a folder opens or closes, a file is selected. */
export function explorerClick(row: EntryRow): ExplorerKeyAction {
  if (!row.folder) return { kind: "select", path: row.path };
  return { kind: row.expanded ? "collapse" : "expand", path: row.path };
}

/** A double click on an entry: a file opens (`files.open`); a folder has had its two clicks already. */
export function explorerDoubleClick(row: EntryRow): ExplorerKeyAction | undefined {
  return row.folder ? undefined : { kind: "open", path: row.path };
}

/**
 * The action for `key` (`KeyboardEvent.key`) with `selected` as the selected entry, or undefined when the key does
 * nothing in the tree. Without a selection, up, down, Home and End select the first or last entry.
 */
export function explorerKey(
  key: string,
  rows: readonly ExplorerRow[],
  selected: string | undefined,
): ExplorerKeyAction | undefined {
  if (key === "Escape") return { kind: "leave" };
  const entries = rows.filter((row): row is EntryRow => row.kind === "entry");
  if (entries.length === 0) return undefined;
  const index = entries.findIndex((row) => row.path === selected);
  const current = entries[index];
  const select = (row: EntryRow | undefined): ExplorerKeyAction | undefined =>
    row && row.path !== selected ? { kind: "select", path: row.path } : undefined;
  switch (key) {
    case "ArrowDown":
      return select(current ? entries[index + 1] : entries[0]);
    case "ArrowUp":
      return select(current ? entries[index - 1] : entries.at(-1));
    case "Home":
      return select(entries[0]);
    case "End":
      return select(entries.at(-1));
    case "ArrowRight":
      if (!current?.folder) return current ? undefined : select(entries[0]);
      if (!current.expanded) return { kind: "expand", path: current.path };
      // Into the open folder: its first entry, if it has one yet.
      return entries[index + 1]?.depth === current.depth + 1 ? select(entries[index + 1]) : undefined;
    case "ArrowLeft": {
      if (!current) return select(entries[0]);
      if (current.folder && current.expanded) return { kind: "collapse", path: current.path };
      // To the folder this entry is in; an entry of the root has none in the tree.
      const parent = entries.slice(0, index).findLast((row) => row.depth === current.depth - 1);
      return select(parent);
    }
    case "Enter":
      if (!current) return undefined;
      if (!current.folder) return { kind: "open", path: current.path };
      return current.expanded
        ? { kind: "collapse", path: current.path }
        : { kind: "expand", path: current.path };
    case "F2":
      return current ? { kind: "rename", path: current.path } : undefined;
    case "Delete":
      return current ? { kind: "delete", path: current.path } : undefined;
    default:
      return undefined;
  }
}
