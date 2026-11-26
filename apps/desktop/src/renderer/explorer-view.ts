// Size, visibility and texts of the explorer panel (#202). Pure; the store keeps visibility and width in the window
// of the layout (`explorerVisible`, `explorerWidth`), so each window restores its own.
import type { LayoutWindow } from "@termdock/protocol";
import type { FileErrorCode } from "../shared/files.js";
import type { ExplorerTarget } from "./explorer-source.js";
import { rowsOf } from "./explorer-tree.js";
import type { ExplorerRow, ExplorerTree } from "./explorer-tree.js";

export const EXPLORER_DEFAULT_WIDTH = 280;
export const EXPLORER_MIN_WIDTH = 180;
export const EXPLORER_MAX_WIDTH = 640;
/** The panes keep at least this much width next to the panel. */
export const PANES_MIN_WIDTH = 240;

/** Without an entry in the layout the panel shows. */
export function explorerVisible(window: LayoutWindow): boolean {
  return window.explorerVisible ?? true;
}

/**
 * The width the panel takes: `width` (the stored one, or the default) within the limits, and never so wide that the
 * panes have less than `PANES_MIN_WIDTH` of `available` (the width of the tab area with the panel). The minimum wins
 * over that in a very narrow window.
 */
export function explorerWidth(width: number | undefined, available = Number.POSITIVE_INFINITY): number {
  const wanted = Number.isFinite(width) && width !== undefined ? Math.round(width) : EXPLORER_DEFAULT_WIDTH;
  const max = Math.min(EXPLORER_MAX_WIDTH, available - PANES_MIN_WIDTH);
  return Math.max(EXPLORER_MIN_WIDTH, Math.min(wanted, max));
}

/** What a code of the file service means for a listing. */
export function listErrorText(code: FileErrorCode): string {
  switch (code) {
    case "ENOENT":
      return "Ordner nicht gefunden";
    case "EACCES":
      return "Kein Zugriff auf den Ordner";
    case "EINVAL":
      return "Dieser Ort kann nicht angezeigt werden";
    case "EEXIST":
    case "OTHER":
      return "Ordner konnte nicht gelesen werden";
  }
}

/** The hint after a failed `files.open`. */
export function openErrorText(name: string, code: FileErrorCode): string {
  switch (code) {
    case "EINVAL":
      return `„${name}“ wird nicht geöffnet: Programme und Skripte startet der Explorer nicht`;
    case "ENOENT":
      return `„${name}“ gibt es nicht mehr`;
    case "EACCES":
      return `Kein Zugriff auf „${name}“`;
    case "EEXIST":
    case "OTHER":
      return `„${name}“ konnte nicht geöffnet werden`;
  }
}

/** The text of the panel when it shows no folder; undefined when it shows one. */
export function targetText(target: ExplorerTarget): string | undefined {
  switch (target.kind) {
    case "noTab":
      return "Kein Tab offen";
    case "noSession":
      return "Session nicht gefunden";
    case "notRunning":
      return "Session läuft nicht";
    case "unknownCwd":
      return "Verzeichnis unbekannt";
    case "folder":
      return undefined;
  }
}

export type PanelState = Exclude<ExplorerTarget["kind"], "folder"> | "loading" | "error" | "empty" | "listed";

export interface PanelView {
  /** Also the `data-explorer-state` of the panel, for the screenshot scenes. */
  state: PanelState;
  /** The text instead of the tree; undefined when the tree shows. */
  message?: string;
  rows: ExplorerRow[];
}

/**
 * What the panel draws for `target` with `tree`, the tree of the target's folder (undefined before it exists). The
 * root's listing decides between "Lädt …", the error, the empty folder and the tree; a refresh keeps the tree.
 */
export function panelView(target: ExplorerTarget, tree: ExplorerTree | undefined): PanelView {
  const text = targetText(target);
  if (text !== undefined) return { state: target.kind as PanelState, message: text, rows: [] };
  const root = tree?.folders.get(tree.root.path);
  if (!tree || root === undefined || (root.status === "loading" && root.previous === undefined))
    return { state: "loading", message: "Lädt …", rows: [] };
  if (root.status === "error") return { state: "error", message: listErrorText(root.code), rows: [] };
  const rows = rowsOf(tree);
  return rows.length === 0 ? { state: "empty", message: "Ordner ist leer", rows } : { state: "listed", rows };
}

/**
 * The focus wish of `Ctrl+Shift+O` (`focusWanted`): where the panel puts the focus and whether the wish is settled.
 * The tree takes it once it shows; while the root loads the panel itself holds it and the wish waits for the tree;
 * a text (error, empty, no session) settles it on the panel. Without a wish nothing happens. The window clears the
 * wish on Escape, hiding, `refocus` and a press into a pane, so a slow listing cannot take the keys later.
 */
export function focusStep(
  wanted: boolean,
  state: PanelState,
  hasTree: boolean,
): { target?: "tree" | "panel"; settled: boolean } {
  if (!wanted) return { settled: true };
  if (hasTree) return { target: "tree", settled: true };
  return { target: "panel", settled: state !== "loading" };
}

/** The text of a row that is not an entry: loading, empty folder, error, cut listing. */
export function hintText(row: Exclude<ExplorerRow, { kind: "entry" }>): string {
  switch (row.kind) {
    case "loading":
      return "Lädt …";
    case "empty":
      return "Leer";
    case "error":
      return listErrorText(row.code);
    case "truncated":
      return truncatedText(row.shown, row.total);
  }
}

/** The hint under a listing that was cut at the limit of the service. */
export function truncatedText(shown: number, total: number): string {
  return `${shown} von ${total} Einträgen angezeigt`;
}
