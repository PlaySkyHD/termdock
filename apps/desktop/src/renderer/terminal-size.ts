// Size a terminal view may send (#27): whole cells, within the bounds of the bridge, and nothing for an area that
// has no room for a terminal (a pane squeezed to its padding, an element not laid out yet).
import type { TerminalSize } from "@termdock/protocol";

/** Same bounds as the bridge in the main process accepts. */
const MAX_COLS = 1_000;
const MAX_ROWS = 500;
const MIN_COLS = 2;
const MIN_ROWS = 1;

/** Font size of every terminal view in px; a writer always uses it. */
export const NORMAL_FONT_SIZE = 14;
/** Smallest font a reader zooms out to; below it the rest of the writer's grid is clipped (#66). */
export const MIN_FONT_SIZE = 8;

export interface ReaderZoom {
  /** The writer's grid. */
  grid: TerminalSize;
  /** Room of the reader's terminal in CSS px (without padding and scroll bar). */
  area: { width: number; height: number };
  /** Size of one cell in CSS px at the normal font size. */
  cell: { width: number; height: number };
  normal: number;
  min: number;
}

/**
 * Font size of a reading view (#66, variant A): the largest whole size, at most the normal one, at which the
 * writer's whole grid fits the area, but not below `min` (then the rest is clipped as before). Whole pixels keep
 * box and line drawing of TUIs sharp; rounding down leaves room for cells that do not shrink exactly in step. A
 * missing measurement keeps the normal size.
 */
export function readerFontSize({ grid, area, cell, normal, min }: ReaderZoom): number {
  const width = grid.cols * cell.width;
  const height = grid.rows * cell.height;
  if (!(width > 0 && height > 0 && area.width > 0 && area.height > 0)) return normal;
  const scale = Math.min(1, area.width / width, area.height / height);
  // The epsilon keeps 14 × (840 / 840) from becoming 13.999… and losing a whole pixel.
  return Math.max(min, Math.min(normal, Math.floor(normal * scale + 1e-9)));
}

/** The proposal of the fit addon as whole cells, or undefined when fewer than 2 columns or 1 row fit. */
export function usableSize(proposed: { cols: number; rows: number } | undefined): TerminalSize | undefined {
  if (!proposed) return undefined;
  const cols = Math.floor(proposed.cols);
  const rows = Math.floor(proposed.rows);
  if (!(cols >= MIN_COLS) || !(rows >= MIN_ROWS)) return undefined;
  return { cols: Math.min(MAX_COLS, cols), rows: Math.min(MAX_ROWS, rows) };
}
