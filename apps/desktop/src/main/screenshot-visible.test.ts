import { describe, expect, it } from "vitest";
import {
  assertVisible,
  contentBox,
  intersectRects,
  isRectVisible,
  visibleArea,
} from "./screenshot-visible.js";
import type { ClipBox, Rect, VisibilityProbe } from "./screenshot-visible.js";

const viewport: Rect = { top: 0, left: 0, bottom: 680, right: 1100 };
const box = (rect: Rect, border = 0, scrollbar = 0): ClipBox => ({
  rect,
  clientLeft: border,
  clientTop: border,
  clientWidth: rect.right - rect.left - 2 * border - scrollbar,
  clientHeight: rect.bottom - rect.top - 2 * border,
});
const panel = box({ top: 100, left: 200, bottom: 500, right: 900 });

describe("contentBox", () => {
  it("leaves out border and scrollbar", () => {
    const area = contentBox(box({ top: 100, left: 200, bottom: 500, right: 900 }, 2, 15));
    expect(area).toEqual({ top: 102, left: 202, bottom: 498, right: 883 });
  });
});

describe("intersectRects", () => {
  it("cuts nested containers down to the inner one", () => {
    const outer: Rect = { top: 0, left: 0, bottom: 400, right: 800 };
    const inner: Rect = { top: 50, left: 100, bottom: 600, right: 700 };
    expect(intersectRects([outer, inner])).toEqual({ top: 50, left: 100, bottom: 400, right: 700 });
  });
});

describe("visibleArea", () => {
  it("is the window without clipping ancestors", () => {
    expect(visibleArea([], viewport)).toEqual(viewport);
  });
});

describe("isRectVisible", () => {
  it("accepts an element completely inside container and window", () => {
    expect(isRectVisible({ top: 150, left: 250, bottom: 200, right: 600 }, [panel], viewport)).toBe(true);
  });

  it("rejects an element cut off at the bottom of the scrolling container", () => {
    expect(isRectVisible({ top: 450, left: 250, bottom: 560, right: 600 }, [panel], viewport)).toBe(false);
  });

  it("rejects an element completely outside the container", () => {
    expect(isRectVisible({ top: 600, left: 250, bottom: 640, right: 600 }, [panel], viewport)).toBe(false);
  });

  it("without a clipping container only the window counts", () => {
    expect(isRectVisible({ top: 600, left: 250, bottom: 640, right: 600 }, [], viewport)).toBe(true);
    expect(isRectVisible({ top: 650, left: 250, bottom: 700, right: 600 }, [], viewport)).toBe(false);
  });

  it("rejects an element that leaves the window although the container is larger", () => {
    const tall = box({ top: 0, left: 0, bottom: 2000, right: 1100 });
    expect(isRectVisible({ top: 900, left: 10, bottom: 950, right: 100 }, [tall], viewport)).toBe(false);
  });

  it("rejects an element cut off by an outer container although the inner one shows it", () => {
    const inner = box({ top: 100, left: 200, bottom: 900, right: 900 });
    const outer = box({ top: 0, left: 0, bottom: 300, right: 1100 }); // e.g. overflow: hidden
    const element = { top: 400, left: 250, bottom: 450, right: 600 };
    expect(isRectVisible(element, [inner], viewport)).toBe(true);
    expect(isRectVisible(element, [inner, outer], viewport)).toBe(false);
  });

  it("rejects an element under the scrollbar of its container", () => {
    const scrolling = box({ top: 100, left: 200, bottom: 500, right: 900 }, 0, 15);
    expect(isRectVisible({ top: 150, left: 800, bottom: 200, right: 895 }, [scrolling], viewport)).toBe(
      false,
    );
    expect(isRectVisible({ top: 150, left: 800, bottom: 200, right: 880 }, [scrolling], viewport)).toBe(true);
  });

  it("rejects an element without area", () => {
    expect(isRectVisible({ top: 150, left: 250, bottom: 150, right: 250 }, [panel], viewport)).toBe(false);
  });

  it("tolerates sub-pixel rounding", () => {
    expect(isRectVisible({ top: 99.7, left: 250, bottom: 200, right: 600 }, [panel], viewport)).toBe(true);
  });
});

describe("assertVisible", () => {
  const probing = (probe: VisibilityProbe) => async () => probe as never;

  it("passes for a visible element", async () => {
    const element = { top: 150, left: 250, bottom: 200, right: 600 };
    await expect(
      assertVisible(probing({ element, clips: [panel], viewport }), "65-x.png", "[data-x]"),
    ).resolves.toBeUndefined();
  });

  it("names scene and selector when the element is missing", async () => {
    await expect(
      assertVisible(probing({ element: null, clips: [], viewport }), "65-x.png", "[data-x]", 0),
    ).rejects.toThrow(/65-x\.png.*\[data-x\].*does not exist/);
  });

  it("names scene and selector when the element is cut off", async () => {
    const element = { top: 450, left: 250, bottom: 560, right: 600 };
    await expect(
      assertVisible(probing({ element, clips: [panel], viewport }), "65-x.png", "[data-x]", 0),
    ).rejects.toThrow(/65-x\.png.*\[data-x\].*not fully visible/);
  });

  it("waits for an element that settles into view", async () => {
    const probes: VisibilityProbe[] = [
      { element: null, clips: [panel], viewport },
      { element: { top: 150, left: 250, bottom: 200, right: 600 }, clips: [panel], viewport },
    ];
    const evaluate = async () => probes.shift() as never;
    await expect(assertVisible(evaluate, "65-x.png", "[data-x]", 2_000)).resolves.toBeUndefined();
  });
});
