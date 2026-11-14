import { describe, expect, it } from "vitest";
import { nextMenuIndex } from "./menu-navigation.js";

describe("nextMenuIndex", () => {
  const all = [true, true, true];

  it("moves down and up, wrapping around at both ends", () => {
    expect(nextMenuIndex(all, 0, "ArrowDown")).toBe(1);
    expect(nextMenuIndex(all, 2, "ArrowDown")).toBe(0);
    expect(nextMenuIndex(all, 1, "ArrowUp")).toBe(0);
    expect(nextMenuIndex(all, 0, "ArrowUp")).toBe(2);
  });

  it("starts at the first entry going down and at the last going up when nothing has the focus", () => {
    expect(nextMenuIndex(all, -1, "ArrowDown")).toBe(0);
    expect(nextMenuIndex(all, -1, "ArrowUp")).toBe(2);
  });

  it("skips disabled entries", () => {
    const enabled = [true, false, true, false];
    expect(nextMenuIndex(enabled, 0, "ArrowDown")).toBe(2);
    expect(nextMenuIndex(enabled, 2, "ArrowDown")).toBe(0);
    expect(nextMenuIndex(enabled, 0, "ArrowUp")).toBe(2);
  });

  it("jumps to the first and last enabled entry with Home and End", () => {
    const enabled = [false, true, true, false];
    expect(nextMenuIndex(enabled, 2, "Home")).toBe(1);
    expect(nextMenuIndex(enabled, 1, "End")).toBe(2);
  });

  it("stays on the only enabled entry", () => {
    expect(nextMenuIndex([false, true], 1, "ArrowDown")).toBe(1);
    expect(nextMenuIndex([false, true], 1, "ArrowUp")).toBe(1);
  });

  it("gives -1 for a menu without an enabled entry", () => {
    expect(nextMenuIndex([false, false], 0, "ArrowDown")).toBe(-1);
    expect(nextMenuIndex([], -1, "Home")).toBe(-1);
  });
});
