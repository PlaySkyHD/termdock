// Driving one window of the screenshot mode like a user (#63, #67): JavaScript in the page to read it, and the real
// mouse and keyboard through `webContents.sendInputEvent` (press, moves with the button held, release), so drag and
// drop runs the whole way through the pointer events. Shared by the scenes of sidebar and tabs. Needs Electron.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserWindow } from "electron";
import { describeError } from "./screenshot.js";
import { assertVisible } from "./screenshot-visible.js";
import type { CaptureOptions } from "./screenshot-visible.js";

export interface Point {
  x: number;
  y: number;
}

/** Writes a PNG of the window; with `visible` the run fails first when that element is not fully visible (#116). */
export async function captureWindow(
  win: BrowserWindow,
  dir: string,
  name: string,
  options: CaptureOptions = {},
): Promise<void> {
  await sleep(300); // one more frame
  if (options.visible !== undefined)
    await assertVisible(
      <T>(expression: string) => win.webContents.executeJavaScript(expression, true) as Promise<T>,
      name,
      options.visible,
    );
  const file = path.join(dir, name);
  writeFileSync(file, (await capturePageWithRetry(win)).toPNG());
  console.log(file);
}

/**
 * `capturePage()` fails with `UnknownVizError` while the GPU process is busy or a window has just opened (#127).
 * It is transient: wait and ask again, up to 5 times; the last error is named.
 */
async function capturePageWithRetry(win: BrowserWindow): Promise<Electron.NativeImage> {
  let last: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await win.webContents.capturePage();
    } catch (error) {
      last = error;
      if (attempt < 5) await sleep(1_000);
    }
  }
  throw new Error(`capturePage failed 5 times: ${describeError(last)}`);
}

export function pageDriver(win: BrowserWindow, dir: string) {
  const evaluate = <T>(expression: string): Promise<T> =>
    win.webContents.executeJavaScript(expression, true) as Promise<T>;
  const waitFor = async (expression: string, what: string, timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await evaluate<boolean>(`Boolean(${expression})`).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  const capture = (name: string, options?: CaptureOptions): Promise<void> =>
    captureWindow(win, dir, name, options);
  const click = async (selector: string): Promise<void> => {
    await waitFor(`document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await sleep(200);
  };
  /** Types into a field of the page the way React hears it. */
  const fill = async (selector: string, value: string): Promise<void> => {
    await waitFor(`document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(100);
  };
  /** A point of the element, as shares of its box (the center by default). */
  const pointIn = (selector: string, u = 0.5, v = 0.5): Promise<Point> =>
    evaluate(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: box.left + box.width * ${u}, y: box.top + box.height * ${v} };
    })()`);
  const center = (selector: string): Promise<Point> => pointIn(selector);
  const mouse = (
    type: "mouseDown" | "mouseUp" | "mouseMove",
    x: number,
    y: number,
    button: "left" | "right" = "left",
  ): void =>
    win.webContents.sendInputEvent({
      type,
      x: Math.round(x),
      y: Math.round(y),
      button,
      clickCount: 1,
      // A move between down and up is a drag: the button is held.
      ...(type === "mouseMove" && button === "left" ? { modifiers: ["leftbuttondown" as const] } : {}),
    });
  /** Presses at `from`, moves in steps to `to` and stops there with the button held. */
  const dragTo = async (from: Point, to: Point): Promise<void> => {
    mouse("mouseDown", from.x, from.y);
    await sleep(50);
    const steps = 8;
    for (let step = 1; step <= steps; step += 1) {
      mouse(
        "mouseMove",
        from.x + ((to.x - from.x) * step) / steps,
        from.y + ((to.y - from.y) * step) / steps,
      );
      await sleep(40);
    }
  };
  /** A key press; `text` adds the `char` event that activates a focused button (Enter) like a typed key. */
  const key = async (
    keyCode: string,
    modifiers: Array<"shift" | "control"> = [],
    wait = 300,
    text?: string,
  ): Promise<void> => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    if (text !== undefined) win.webContents.sendInputEvent({ type: "char", keyCode: text, modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await sleep(wait);
  };
  return { evaluate, waitFor, capture, click, fill, pointIn, center, mouse, dragTo, key };
}
