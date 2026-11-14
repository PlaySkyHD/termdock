import { describe, expect, it } from "vitest";
import { parseZoneTarget, pickZoneTarget, zoneAt, zonePreview, zoneTargets } from "./drop-zones.js";

const box = { left: 100, top: 50, width: 200, height: 100 };

describe("zoneAt", () => {
  it.each([
    [110, 100, "left"],
    [290, 100, "right"],
    [200, 55, "top"],
    [200, 145, "bottom"],
    [200, 100, "center"],
    // Just inside the edge band (30 %) and just outside it.
    [159, 100, "left"],
    [161, 100, "center"],
  ])("finds the zone of a pane at (%d, %d): %s", (x, y, zone) => {
    expect(zoneAt("pane", box, x, y)).toBe(zone);
  });

  it("splits a corner along the diagonal: the nearer edge wins", () => {
    // 10 % from the left, 20 % from the top.
    expect(zoneAt("pane", box, 120, 70)).toBe("left");
    // 20 % from the left, 10 % from the top.
    expect(zoneAt("pane", box, 140, 60)).toBe("top");
  });

  it("finds the half of a tab", () => {
    expect(zoneAt("sides", box, 199, 100)).toBe("before");
    expect(zoneAt("sides", box, 201, 100)).toBe("after");
  });

  it("takes the center of a box without size", () => {
    expect(zoneAt("pane", { left: 0, top: 0, width: 0, height: 0 }, 5, 5)).toBe("center");
  });
});

describe("pickZoneTarget", () => {
  it("names the zone under the point", () => {
    expect(pickZoneTarget("pane", "pane:p1", box, 110, 100, () => true)).toBe("pane:p1:left");
  });

  it("falls back to the center when the edge is not valid (a full tab)", () => {
    const onlyCenter = (id: string): boolean => id.endsWith(":center");
    expect(pickZoneTarget("pane", "pane:p1", box, 110, 100, onlyCenter)).toBe("pane:p1:center");
  });

  it("keeps an invalid zone when the center is no better, and never moves to the other half of a tab", () => {
    expect(pickZoneTarget("pane", "pane:p1", box, 110, 100, () => false)).toBe("pane:p1:left");
    expect(pickZoneTarget("sides", "tab:t1", box, 110, 100, (id) => id.endsWith("after"))).toBe(
      "tab:t1:before",
    );
  });
});

describe("zone ids", () => {
  it("lists every target of an element and splits an id into base and zone", () => {
    expect(zoneTargets("pane:p1", "pane")).toEqual([
      "pane:p1:left",
      "pane:p1:right",
      "pane:p1:top",
      "pane:p1:bottom",
      "pane:p1:center",
    ]);
    expect(zoneTargets("tab:t1", "sides")).toEqual(["tab:t1:before", "tab:t1:after"]);
    expect(parseZoneTarget("pane:p1:left")).toEqual({ base: "pane:p1", zone: "left" });
    expect(parseZoneTarget("archive")).toBeUndefined();
  });

  it("previews the half of the pane at an edge and all of it in the center", () => {
    expect(zonePreview("right")).toEqual({ left: 0.5, top: 0, width: 0.5, height: 1 });
    expect(zonePreview("bottom")).toEqual({ left: 0, top: 0.5, width: 1, height: 0.5 });
    expect(zonePreview("center")).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });
});
