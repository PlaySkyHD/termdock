import { describe, expect, it } from "vitest";
import { bringToFront, paintedFrame } from "./screenshot-page.js";
import type { PaintableWindow } from "./screenshot-page.js";

/** A window whose page answers the frame wait with `answers` in turn (`true`: painted, `false`: timed out). */
function fakeWindow(answers: Array<boolean | Error>) {
  const calls: string[] = [];
  const win: PaintableWindow = {
    setAlwaysOnTop: (flag) => calls.push(`top:${flag}`),
    moveTop: () => calls.push("moveTop"),
    focus: () => calls.push("focus"),
    webContents: {
      executeJavaScript: (code) => {
        calls.push("wait");
        expect(code).toContain("requestAnimationFrame");
        const answer = answers.shift() ?? false;
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
      invalidate: () => calls.push("invalidate"),
    },
  };
  return { win, calls };
}

describe("paintedFrame", () => {
  it("returns after the first painted frame without raising the window", async () => {
    const { win, calls } = fakeWindow([true]);
    await paintedFrame(win);
    expect(calls).toEqual(["wait"]);
  });

  it("raises the window and tries again until a frame is painted", async () => {
    const { win, calls } = fakeWindow([false, new Error("page is loading"), true]);
    await paintedFrame(win);
    const lift = ["top:true", "moveTop", "focus", "top:false", "invalidate"];
    expect(calls).toEqual(["wait", ...lift, "wait", ...lift, "wait"]);
  });

  it("fails after 5 tries without a frame", async () => {
    const { win, calls } = fakeWindow([]);
    await expect(paintedFrame(win)).rejects.toThrow("the window paints no frames");
    expect(calls.filter((call) => call === "wait")).toHaveLength(5);
    expect(calls.filter((call) => call === "moveTop")).toHaveLength(4);
  });
});

describe("bringToFront", () => {
  it("lifts the window for a moment and repaints it", () => {
    const { win, calls } = fakeWindow([]);
    bringToFront(win);
    expect(calls).toEqual(["top:true", "moveTop", "focus", "top:false", "invalidate"]);
  });
});
