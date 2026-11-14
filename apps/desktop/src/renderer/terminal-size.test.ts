import { describe, expect, it } from "vitest";
import { MIN_FONT_SIZE, NORMAL_FONT_SIZE, readerFontSize, usableSize } from "./terminal-size.js";

describe("readerFontSize (#66, variant A: a reader zooms out to the writer's grid)", () => {
  // Cascadia Mono at 14 px: about 8.4 × 17 px per cell.
  const cell = { width: 8.4, height: 17 };
  const grid = { cols: 100, rows: 30 }; // 840 × 510 px at the normal size
  const zoom = (area: { width: number; height: number }) =>
    readerFontSize({ grid, area, cell, normal: 14, min: 8 });

  it("keeps the normal size when the grid fits", () => {
    expect(zoom({ width: 840, height: 510 })).toBe(14);
  });

  it("never grows above the normal size in a larger pane", () => {
    expect(zoom({ width: 2_000, height: 1_200 })).toBe(14);
  });

  it("shrinks to the largest whole size at which the whole grid fits", () => {
    // 70 % of the width: 14 × 0.7 = 9.8, so 9 px; the height has room.
    expect(zoom({ width: 588, height: 510 })).toBe(9);
    // The tighter of both sides decides: 80 % of the height, 90 % of the width -> 11.2, so 11 px.
    expect(zoom({ width: 756, height: 408 })).toBe(11);
    // And the grid then fits at that size.
    const size = zoom({ width: 588, height: 510 });
    expect(grid.cols * cell.width * (size / 14)).toBeLessThanOrEqual(588);
  });

  it("stops at the minimum size below which the rest is clipped", () => {
    expect(zoom({ width: 300, height: 510 })).toBe(8);
    expect(zoom({ width: 10, height: 10 })).toBe(8);
  });

  it("keeps the normal size without a measurement (area or cell of zero)", () => {
    expect(zoom({ width: 0, height: 0 })).toBe(14);
    expect(
      readerFontSize({
        grid,
        area: { width: 500, height: 300 },
        cell: { width: 0, height: 0 },
        normal: 14,
        min: 8,
      }),
    ).toBe(14);
  });

  it("has a minimum below the normal size of the terminal", () => {
    expect(MIN_FONT_SIZE).toBeLessThan(NORMAL_FONT_SIZE);
    expect(NORMAL_FONT_SIZE).toBe(14);
  });
});

describe("usableSize", () => {
  it("rounds the proposal of the fit addon down to whole cells", () => {
    expect(usableSize({ cols: 80.7, rows: 24.2 })).toEqual({ cols: 80, rows: 24 });
  });

  it("has no size for an area without room for 2 columns and 1 row (only padding left)", () => {
    expect(usableSize({ cols: 0, rows: 0 })).toBeUndefined();
    expect(usableSize({ cols: 1, rows: 30 })).toBeUndefined();
    expect(usableSize({ cols: 80, rows: 0.5 })).toBeUndefined();
    expect(usableSize({ cols: Number.NaN, rows: 24 })).toBeUndefined();
    expect(usableSize(undefined)).toBeUndefined();
  });

  it("stays within the bounds the bridge accepts", () => {
    expect(usableSize({ cols: 5_000, rows: 900 })).toEqual({ cols: 1_000, rows: 500 });
  });
});
