import { describe, expect, it } from "vitest";
import { nextFocusIndex } from "./focus-trap.js";

describe("nextFocusIndex", () => {
  it("moves forward and wraps from the last element to the first", () => {
    expect(nextFocusIndex(4, 0, false)).toBe(1);
    expect(nextFocusIndex(4, 3, false)).toBe(0);
  });

  it("moves backward and wraps from the first element to the last", () => {
    expect(nextFocusIndex(4, 2, true)).toBe(1);
    expect(nextFocusIndex(4, 0, true)).toBe(3);
  });

  it("pulls a focus from outside into the trap: Tab to the first, Shift+Tab to the last", () => {
    expect(nextFocusIndex(4, -1, false)).toBe(0);
    expect(nextFocusIndex(4, -1, true)).toBe(3);
  });

  it("stays on a single element and gives none for an empty trap", () => {
    expect(nextFocusIndex(1, 0, false)).toBe(0);
    expect(nextFocusIndex(1, 0, true)).toBe(0);
    expect(nextFocusIndex(0, -1, false)).toBe(-1);
  });
});
