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

/** Distance of a screenshot window from the corner of its work area. */
const SHOT_INSET = 40;

/**
 * Where screenshot windows open, so a run does not cover the screen the user is working on. `choice` is
 * `TERMDOCK_SCREENSHOT_DISPLAY`: `primary`, or the 1-based number of a display in `displays` order; without it the
 * first display that is not the primary one, and the primary one if there is no other.
 */
export function screenshotOrigin(
  displays: readonly { workArea: WindowBounds; primary: boolean }[],
  choice: string | undefined,
): { x: number; y: number } {
  const number = choice !== undefined && /^\d+$/.test(choice) ? Number(choice) : undefined;
  const area =
    (number !== undefined ? displays[number - 1] : undefined) ??
    (choice === "primary" ? undefined : displays.find((display) => !display.primary)) ??
    displays.find((display) => display.primary) ??
    displays[0];
  return { x: (area?.workArea.x ?? 0) + SHOT_INSET, y: (area?.workArea.y ?? 0) + SHOT_INSET };
}

/**
 * Where the pointer lies in a window that opens or moves under it (#68), measured from the top left corner of its
 * client area: over its tab bar (35 px high), a bit right of the edge.
 */
export const POINTER_OFFSET = { x: 80, y: 16 } as const;

/**
 * Bounds of a window of `size` whose tab bar lies under the screen point (#68): the frame starts `titleBar` pixels
 * above the client area. The window stays inside `workArea`, the work area of the screen under the pointer (shrunk to
 * it when larger), so its title bar is never off the screen; near an edge the pointer then lies elsewhere on it.
 */
export function boundsAtPointer(
  point: { x: number; y: number },
  size: { width: number; height: number },
  workArea: WindowBounds,
  titleBar: number,
): WindowBounds {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  const clamp = (value: number, start: number, room: number): number =>
    Math.min(Math.max(Math.round(value), start), start + room);
  return {
    x: clamp(point.x - POINTER_OFFSET.x, workArea.x, workArea.width - width),
    y: clamp(point.y - titleBar - POINTER_OFFSET.y, workArea.y, workArea.height - height),
    width,
    height,
  };
}

/**
 * The window under the screen point (#68): of the windows whose frame contains it, the one focused last (Electron
 * gives no z-order). `recent` lists window ids, the last focused first; a window it does not name comes after them.
 */
export function windowAtPoint(
  point: { x: number; y: number },
  windows: ReadonlyArray<{ id: number; bounds: WindowBounds }>,
  recent: readonly number[],
): number | undefined {
  const rank = (id: number): number => {
    const index = recent.indexOf(id);
    return index < 0 ? recent.length : index;
  };
  return windows
    .filter(
      ({ bounds }) =>
        point.x >= bounds.x &&
        point.x < bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y < bounds.y + bounds.height,
    )
    .sort((a, b) => rank(a.id) - rank(b.id))[0]?.id;
}

/** Length of the overlap of two intervals (0 when they do not meet). */
function overlap(start: number, length: number, otherStart: number, otherLength: number): number {
  return Math.max(0, Math.min(start + length, otherStart + otherLength) - Math.max(start, otherStart));
}
