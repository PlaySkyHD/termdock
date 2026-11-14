// Position and size of a restored window against the screens that exist now (#29, ADR 0006). Pure, no Electron:
// main passes the work areas of `screen.getAllDisplays()`.
import type { WindowBounds } from "@termdock/protocol";

/** At least this much of the window must lie on a screen, otherwise the user could not reach it. */
const MIN_VISIBLE_WIDTH = 200;
const MIN_VISIBLE_HEIGHT = 100;
/** A restored window is never smaller than this. */
const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;

/**
 * The bounds to open the window with. Bounds with enough area on any of the `workAreas` stay as stored; otherwise
 * (the screen is gone, or was moved far away) the window is centered on the `primary` work area, shrunk to fit it.
 */
export function fitBounds(
  bounds: WindowBounds,
  workAreas: readonly WindowBounds[],
  primary: WindowBounds,
): WindowBounds {
  const needWidth = Math.min(MIN_VISIBLE_WIDTH, bounds.width);
  const needHeight = Math.min(MIN_VISIBLE_HEIGHT, bounds.height);
  const visible = workAreas.some(
    (area) =>
      overlap(bounds.x, bounds.width, area.x, area.width) >= needWidth &&
      overlap(bounds.y, bounds.height, area.y, area.height) >= needHeight,
  );
  if (visible) return bounds;
  const width = Math.min(Math.max(bounds.width, MIN_WIDTH), primary.width);
  const height = Math.min(Math.max(bounds.height, MIN_HEIGHT), primary.height);
  return {
    x: primary.x + Math.round((primary.width - width) / 2),
    y: primary.y + Math.round((primary.height - height) / 2),
    width,
    height,
  };
}

/** Length of the overlap of two intervals (0 when they do not meet). */
function overlap(start: number, length: number, otherStart: number, otherLength: number): number {
  return Math.max(0, Math.min(start + length, otherStart + otherLength) - Math.max(start, otherStart));
}
