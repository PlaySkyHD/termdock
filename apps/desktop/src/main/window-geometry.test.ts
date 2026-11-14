import { describe, expect, it } from "vitest";
import { fitBounds } from "./window-geometry.js";

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const left = { x: -1280, y: 0, width: 1280, height: 984 };

describe("fitBounds", () => {
  it("keeps bounds that lie on a display", () => {
    const bounds = { x: 100, y: 80, width: 1000, height: 640 };
    expect(fitBounds(bounds, [primary], primary)).toEqual(bounds);
  });

  it("keeps bounds on a second display left of the primary one", () => {
    const bounds = { x: -1100, y: 50, width: 900, height: 600 };
    expect(fitBounds(bounds, [left, primary], primary)).toEqual(bounds);
  });

  it("keeps a window that sticks out of the display as long as enough of it is visible", () => {
    const bounds = { x: 1500, y: 800, width: 1000, height: 640 };
    expect(fitBounds(bounds, [primary], primary)).toEqual(bounds);
  });

  it("centers a window of a display that is gone on the primary display", () => {
    const bounds = { x: -1100, y: 50, width: 900, height: 600 };
    expect(fitBounds(bounds, [primary], primary)).toEqual({ x: 510, y: 220, width: 900, height: 600 });
  });

  it("treats a window with only a sliver on a display as off screen", () => {
    const bounds = { x: 1880, y: 10, width: 900, height: 600 };
    expect(fitBounds(bounds, [primary], primary)).toEqual({ x: 510, y: 220, width: 900, height: 600 });
  });

  it("shrinks a window that is bigger than the primary display, and centers it", () => {
    const bounds = { x: 4000, y: 0, width: 3000, height: 2000 };
    expect(fitBounds(bounds, [primary], primary)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });

  it("does not make a window smaller than a usable size", () => {
    const bounds = { x: 5000, y: 5000, width: 50, height: 40 };
    expect(fitBounds(bounds, [primary], primary)).toEqual({ x: 760, y: 370, width: 400, height: 300 });
  });

  it("centers inside a primary work area that does not start at the origin", () => {
    const area = { x: 0, y: 40, width: 1000, height: 700 };
    expect(fitBounds({ x: 9000, y: 9000, width: 600, height: 400 }, [area], area)).toEqual({
      x: 200,
      y: 190,
      width: 600,
      height: 400,
    });
  });

  it("works without any display list by trusting the primary one", () => {
    expect(fitBounds({ x: 9000, y: 0, width: 600, height: 400 }, [], primary)).toMatchObject({ x: 660 });
  });
});
