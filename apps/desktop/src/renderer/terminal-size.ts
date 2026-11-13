// Size a terminal view may send (#27): whole cells, within the bounds of the bridge, and nothing for an area that
// has no room for a terminal (a pane squeezed to its padding, an element not laid out yet).
import type { TerminalSize } from "@termdock/protocol";

/** Same bounds as the bridge in the main process accepts. */
const MAX_COLS = 1_000;
const MAX_ROWS = 500;
const MIN_COLS = 2;
const MIN_ROWS = 1;

/** The proposal of the fit addon as whole cells, or undefined when fewer than 2 columns or 1 row fit. */
export function usableSize(proposed: { cols: number; rows: number } | undefined): TerminalSize | undefined {
  if (!proposed) return undefined;
  const cols = Math.floor(proposed.cols);
  const rows = Math.floor(proposed.rows);
  if (!(cols >= MIN_COLS) || !(rows >= MIN_ROWS)) return undefined;
  return { cols: Math.min(MAX_COLS, cols), rows: Math.min(MAX_ROWS, rows) };
}
