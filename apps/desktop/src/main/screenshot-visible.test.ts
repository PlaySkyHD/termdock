import { describe, expect, it } from "vitest";
import { assertVisible, isRectVisible } from "./screenshot-visible.js";
import type { Rect, VisibilityProbe } from "./screenshot-visible.js";

const viewport: Rect = { top: 0, left: 0, bottom: 680, right: 1100 };
const panel: Rect = { top: 100, left: 200, bottom: 500, right: 900 };

describe("isRectVisible", () => {
  it("accepts an element completely inside container and window", () => {
    expect(isRectVisible({ top: 150, left: 250, bottom: 200, right: 600 }, panel, viewport)).toBe(true);
  });

  it("rejects an element cut off at the bottom of the scrolling container", () => {
    expect(isRectVisible({ top: 450, left: 250, bottom: 560, right: 600 }, panel, viewport)).toBe(false);
  });

  it("rejects an element completely outside the container", () => {
    expect(isRectVisible({ top: 600, left: 250, bottom: 640, right: 600 }, panel, viewport)).toBe(false);
  });

  it("without a scrolling container only the window counts", () => {
    expect(isRectVisible({ top: 600, left: 250, bottom: 640, right: 600 }, null, viewport)).toBe(true);
    expect(isRectVisible({ top: 650, left: 250, bottom: 700, right: 600 }, null, viewport)).toBe(false);
  });

  it("rejects an element that leaves the window although the container is larger", () => {
    const tall: Rect = { top: 0, left: 0, bottom: 2000, right: 1100 };
    expect(isRectVisible({ top: 900, left: 10, bottom: 950, right: 100 }, tall, viewport)).toBe(false);
  });

  it("rejects an element without area", () => {
    expect(isRectVisible({ top: 150, left: 250, bottom: 150, right: 250 }, panel, viewport)).toBe(false);
  });

  it("tolerates sub-pixel rounding", () => {
    expect(isRectVisible({ top: 99.7, left: 250, bottom: 200, right: 600 }, panel, viewport)).toBe(true);
  });
});

describe("assertVisible", () => {
  const probing = (probe: VisibilityProbe) => async () => probe as never;

  it("passes for a visible element", async () => {
    const element = { top: 150, left: 250, bottom: 200, right: 600 };
    await expect(
      assertVisible(probing({ element, container: panel, viewport }), "65-x.png", "[data-x]"),
    ).resolves.toBeUndefined();
  });

  it("names scene and selector when the element is missing", async () => {
    await expect(
      assertVisible(probing({ element: null, container: null, viewport }), "65-x.png", "[data-x]", 0),
    ).rejects.toThrow(/65-x\.png.*\[data-x\].*does not exist/);
  });

  it("names scene and selector when the element is cut off", async () => {
    const element = { top: 450, left: 250, bottom: 560, right: 600 };
    await expect(
      assertVisible(probing({ element, container: panel, viewport }), "65-x.png", "[data-x]", 0),
    ).rejects.toThrow(/65-x\.png.*\[data-x\].*not fully visible/);
  });

  it("waits for an element that settles into view", async () => {
    const probes: VisibilityProbe[] = [
      { element: null, container: panel, viewport },
      { element: { top: 150, left: 250, bottom: 200, right: 600 }, container: panel, viewport },
    ];
    const evaluate = async () => probes.shift() as never;
    await expect(assertVisible(evaluate, "65-x.png", "[data-x]", 2_000)).resolves.toBeUndefined();
  });
});
