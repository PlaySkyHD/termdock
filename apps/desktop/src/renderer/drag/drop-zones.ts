// Drop targets with zones (#67): one element stands for several targets `<id>:<zone>`, and the zone comes from
// where the pointer is in it. A pane has five (`pane`: its four edges and its center), a tab two (`sides`: its
// left and right half). Pure; the provider reads the element's box and asks the rules which zones are valid, so
// the state machine keeps plain target ids.

export type ZoneSet = "pane" | "sides";

export const ZONE_SETS: Readonly<Record<ZoneSet, readonly string[]>> = {
  pane: ["left", "right", "top", "bottom", "center"],
  sides: ["before", "after"],
};

/** Share of the width or height that counts as an edge of a pane; the rest is its center. */
export const EDGE_SHARE = 0.3;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const zoneTarget = (base: string, zone: string): string => `${base}:${zone}`;

/** Base id and zone of a target id with a zone; undefined without one. */
export function parseZoneTarget(targetId: string): { base: string; zone: string } | undefined {
  const at = targetId.lastIndexOf(":");
  return at <= 0 ? undefined : { base: targetId.slice(0, at), zone: targetId.slice(at + 1) };
}

/** All target ids of an element with zones. */
export function zoneTargets(base: string, set: ZoneSet): string[] {
  return ZONE_SETS[set].map((zone) => zoneTarget(base, zone));
}

/**
 * The zone under the point. A pane: the nearest edge when the point lies in its outer `EDGE_SHARE` (so the borders
 * between two edges are the diagonals), else the center. A tab: its left or right half.
 */
export function zoneAt(set: ZoneSet, box: Box, x: number, y: number): string {
  const u = box.width > 0 ? (x - box.left) / box.width : 0.5;
  const v = box.height > 0 ? (y - box.top) / box.height : 0.5;
  if (set === "sides") return u < 0.5 ? "before" : "after";
  const edges: Array<[string, number]> = [
    ["left", u],
    ["right", 1 - u],
    ["top", v],
    ["bottom", 1 - v],
  ];
  const [edge, distance] = edges.reduce((best, each) => (each[1] < best[1] ? each : best));
  return distance < EDGE_SHARE ? edge : "center";
}

/**
 * The target id under the point. An edge of a pane that is not valid (the tab is full) falls back to the center
 * when that is valid, so the whole pane takes the drop.
 */
export function pickZoneTarget(
  set: ZoneSet,
  base: string,
  box: Box,
  x: number,
  y: number,
  valid: (targetId: string) => boolean,
): string {
  const id = zoneTarget(base, zoneAt(set, box, x, y));
  if (set === "pane" && !valid(id) && valid(zoneTarget(base, "center"))) return zoneTarget(base, "center");
  return id;
}

/** Where the dropped pane would land, as shares of the target pane: the half at an edge, all of it in the center. */
export function zonePreview(zone: string): Box {
  switch (zone) {
    case "left":
      return { left: 0, top: 0, width: 0.5, height: 1 };
    case "right":
      return { left: 0.5, top: 0, width: 0.5, height: 1 };
    case "top":
      return { left: 0, top: 0, width: 1, height: 0.5 };
    case "bottom":
      return { left: 0, top: 0.5, width: 1, height: 0.5 };
    default:
      return { left: 0, top: 0, width: 1, height: 1 };
  }
}
