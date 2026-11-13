import { describe, expect, it } from "vitest";
import { usableSize } from "./terminal-size.js";

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
