// Scenes of the screenshot mode for the layout restore (#29, ADR 0006): two windows with several tabs and splits,
// a restart of the UI, and the restored state compared with the one before. A session killed with
// `tmux kill-session` while the UI is "away" comes back as a placeholder. Needs Electron, WSL and the isolated
// core; no unit test (the pieces are tested: layout mapping, coordinator, geometry, placeholder).
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { LayoutDocument, SessionInfo } from "@termdock/protocol";
import type { BrowserWindow } from "electron";
import { captureWindow } from "./screenshot-page.js";
import type { ScenarioDeps } from "./screenshot-scenario.js";
import type { CaptureOptions } from "./screenshot-visible.js";

type Wsl = (args: readonly string[]) => Promise<string>;

const sessionSelector = (name: string): string => `[data-session-name=${JSON.stringify(name)}]`;

/** What a window shows of its layout: tab titles (active one starred), sidebar and the panes with their shares. */
const SUMMARY_EXPRESSION = `(() => ({
  sidebar: Boolean(document.querySelector('.sidebar')),
  tabs: [...document.querySelectorAll('[data-tab-title]')].map((tab) => tab.dataset.tabTitle + (tab.classList.contains('tab--active') ? '*' : '')),
  panels: [...document.querySelectorAll('[data-tab-id][data-tab-title]')].map((tab) => {
    const area = document.querySelector('.pane-tree').getBoundingClientRect();
    return [...document.querySelectorAll('.pane')].filter((pane) => pane.dataset.tabId === tab.dataset.tabId).map((pane) => {
      const box = pane.getBoundingClientRect();
      return [pane.dataset.sessionId, pane.dataset.activePane,
        Math.round(((box.left - area.left) / area.width) * 100), Math.round(((box.top - area.top) / area.height) * 100),
        Math.round((box.width / area.width) * 100), Math.round((box.height / area.height) * 100)];
    });
  }),
}))()`;

interface Summary {
  sidebar: boolean;
  tabs: string[];
  panels: Array<Array<[string, string, number, number, number, number]>>;
}

/** Equal except for numbers, which may differ by a pixel or two of rounding. */
function same(a: unknown, b: unknown, tolerance = 2): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= tolerance;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, index) => same(value, b[index], tolerance));
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) =>
        same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], tolerance),
      )
    );
  }
  return a === b;
}

export async function restoreScenes(deps: ScenarioDeps, wsl: Wsl): Promise<void> {
  const { dir, bridge, createWindow, closeAllWindows, restartUi, flushLayout, core, log, tmuxSocket } = deps;
  mkdirSync(dir, { recursive: true });

  const evaluate = <T>(win: BrowserWindow, expression: string): Promise<T> =>
    win.webContents.executeJavaScript(expression, true) as Promise<T>;
  const waitFor = async (win: BrowserWindow, expression: string, what: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await evaluate<boolean>(win, `Boolean(${expression})`).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  const capture = (win: BrowserWindow, name: string, options?: CaptureOptions): Promise<void> =>
    captureWindow(win, dir, name, options);
  const click = async (
    win: BrowserWindow,
    selector: string,
    modifier: "" | "shiftKey" = "",
  ): Promise<void> => {
    await waitFor(win, `document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(
      win,
      `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('click', { bubbles: true${modifier ? `, ${modifier}: true` : ""} }))`,
    );
    await sleep(300);
  };
  const waitForViews = async (win: BrowserWindow, count: number): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (bridge.viewsOf(win.webContents.id).length < count) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${count} views`);
      await sleep(100);
    }
    await sleep(1_000); // snapshot and first fit
  };
  const mouse = (win: BrowserWindow, type: "mouseDown" | "mouseUp" | "mouseMove", x: number, y: number) =>
    win.webContents.sendInputEvent({
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
      ...(type === "mouseMove" ? { modifiers: ["leftbuttondown" as const] } : {}),
    });
  /** Drags the first divider of the visible tab to `share` of the tab's width. */
  const dragDivider = async (win: BrowserWindow, share: number): Promise<void> => {
    const box = await evaluate<{ x: number; y: number; left: number; w: number }>(
      win,
      `(() => {
        const divider = document.querySelector('.divider[data-tab-active="true"]');
        const area = divider.parentElement.getBoundingClientRect();
        const box = divider.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2, left: area.left, w: area.width };
      })()`,
    );
    const toX = box.left + share * box.w;
    mouse(win, "mouseDown", box.x, box.y);
    for (let step = 1; step <= 10; step++) {
      mouse(win, "mouseMove", box.x + ((toX - box.x) * step) / 10, box.y);
      await sleep(30);
    }
    mouse(win, "mouseUp", toX, box.y);
    await sleep(800);
  };
  const summary = (win: BrowserWindow): Promise<Summary> => evaluate<Summary>(win, SUMMARY_EXPRESSION);

  // --- Start over: no windows, nothing in the layout -------------------------------------------------
  await closeAllWindows(true);
  await flushLayout();

  // Sessions that the split scenes create in a full run; a run of this group alone makes them here.
  const existing = new Set((await core.request("session.list", {})).result.sessions.map((s) => s.name));
  for (const name of ["Editor", "Shell", "Misc"]) {
    if (!existing.has(name))
      await core.request("session.create", { name, launch: { backend: "wsl", cwd: "/" } });
  }

  const listed = await core.request("session.list", {});
  const byName = (name: string): SessionInfo => {
    const found = listed.result.sessions.find((session) => session.name === name);
    if (!found) throw new Error(`no session ${name}`);
    return found;
  };
  // A session created only for this scene; its pane becomes the placeholder after the restart.
  const crash = (
    await core.request("session.create", { name: "Crash", launch: { backend: "wsl", cwd: "/" } })
  ).result.session;
  const done = byName("Done");
  const states = async (): Promise<Map<string, SessionInfo>> =>
    new Map(
      (await core.request("session.list", {})).result.sessions.map((session) => [session.name, session]),
    );
  if ((await states()).get("Done")?.state !== "Exited") throw new Error("Done must be Exited for this scene");

  // --- Window 1: three tabs, one of them split, sidebar hidden ----------------------------------------
  const first = createWindow(1000, 640);
  // Relative to where the window opened, which is the screen the run uses (TERMDOCK_SCREENSHOT_DISPLAY).
  const origin = first.getBounds();
  first.setBounds({ x: origin.x, y: origin.y, width: 1000, height: 640 });
  await waitFor(
    first,
    `document.querySelectorAll('[data-session-name]').length >= 9`,
    "the sessions in window 1",
  );
  await click(first, sessionSelector("Build"));
  await click(first, sessionSelector("Editor"));
  await click(first, sessionSelector("Logs"));
  await click(first, sessionSelector("Notes"), "shiftKey");
  await waitForViews(first, 4);
  await dragDivider(first, 0.62);
  await click(first, '[data-action="toggle-sidebar"]');
  await waitFor(first, `!document.querySelector('.sidebar')`, "the sidebar to collapse");

  // --- Window 2: a split with the session that dies later, a plain tab, an exited session ------------------
  const second = createWindow(900, 600);
  second.setBounds({ x: origin.x + 80, y: origin.y + 60, width: 900, height: 600 });
  await waitFor(
    second,
    `document.querySelectorAll('[data-session-name]').length >= 9`,
    "the sessions in window 2",
  );
  await click(second, sessionSelector("Shell"));
  await click(second, sessionSelector("Crash"), "shiftKey");
  await click(second, sessionSelector("Misc"));
  await click(second, sessionSelector("Done"));
  await waitForViews(second, 3);
  await click(second, '[data-tab-title="Crash"] .tab__main');
  await sleep(800);

  const beforeSummaries = [await summary(first), await summary(second)];
  const beforeBounds = [first.getBounds(), second.getBounds()];
  log(`before: ${JSON.stringify(beforeSummaries)}`);
  await capture(first, "15-layout-before-window-1.png");
  await capture(second, "16-layout-before-window-2.png");

  // --- The core stores what the windows reported -----------------------------------------------------------------
  await flushLayout();
  const stored = (await core.request("layout.get", {})).result;
  const document: LayoutDocument | undefined = stored.layout;
  log(`layout.get: revision ${stored.revision}, ${document?.windows.length ?? 0} windows`);
  if (document?.windows.length !== 2) throw new Error("the saved layout must have two windows");
  if (document.windows.some((window) => window.bounds === undefined))
    throw new Error("the saved windows must have bounds");
  if (document.windows[0]?.tabs.length !== 3 || document.windows[1]?.tabs.length !== 3)
    throw new Error(
      `expected 3 tabs per window, got ${document.windows.map((w) => w.tabs.length).join(",")}`,
    );

  // --- The process behind Crash is lost while the UI is away ----------------------------------------------------
  const { distro } = crash.launch;
  if (distro === undefined) throw new Error("The created session has no distro");
  await wsl([
    ...["-d", distro, "--cd", "~", "--exec", "tmux", "-L", tmuxSocket],
    ...["kill-session", "-t", `=td-${crash.id}`],
  ]);
  const deadline = Date.now() + 30_000;
  while ((await states()).get("Crash")?.state !== "Interrupted") {
    if (Date.now() > deadline) throw new Error("Crash did not become Interrupted");
    await sleep(250);
  }

  // --- Restart of the UI -------------------------------------------------------------------------------------------------
  const restored = await restartUi();
  if (restored.length !== 2) throw new Error(`expected 2 restored windows, got ${restored.length}`);
  const [again, againSecond] = restored as [BrowserWindow, BrowserWindow];
  for (const win of restored) {
    await waitFor(
      win,
      `!document.querySelector('[data-view="restoring"]') && document.querySelector('.pane')`,
      "the restored window",
    );
    await waitFor(
      win,
      `[...document.querySelectorAll('.pane')].every((pane) => pane.querySelector('.xterm-rows') || pane.querySelector('[data-view="notice"]'))`,
      "the restored panes",
    );
  }
  await sleep(1_500); // snapshots and the first fit

  const afterSummaries = [await summary(again), await summary(againSecond)];
  log(`after: ${JSON.stringify(afterSummaries)}`);
  if (!same(beforeSummaries, afterSummaries))
    throw new Error("the restored windows differ from the ones before the restart");
  const afterBounds = [again.getBounds(), againSecond.getBounds()];
  if (!same(beforeBounds, afterBounds))
    throw new Error(`bounds differ: ${JSON.stringify(beforeBounds)} vs ${JSON.stringify(afterBounds)}`);

  // The Interrupted session is a placeholder: state shown, no view attached, never Running.
  await waitFor(
    againSecond,
    `document.querySelector('[data-session-id="${crash.id}"] [data-view="notice"][data-state="Interrupted"]')`,
    "the placeholder of Crash",
  );
  const placeholder = await evaluate<string>(
    againSecond,
    `document.querySelector('[data-session-id="${crash.id}"] [data-view="notice"]').textContent`,
  );
  if (/Running/.test(placeholder)) throw new Error("a placeholder must never say Running");
  const attachedTo = bridge
    .viewsOf(againSecond.webContents.id)
    .map((viewId) => bridge.sessionOf(againSecond.webContents.id, viewId));
  if (attachedTo.includes(crash.id) || attachedTo.includes(done.id))
    throw new Error("placeholders must not attach a view");

  await capture(again, "17-layout-restored-window-1.png");
  await capture(againSecond, "18-layout-restored-window-2-interrupted.png");

  await click(againSecond, '[data-tab-title="Done"] .tab__main');
  await waitFor(
    againSecond,
    `document.querySelector('[data-state="Exited"][data-view="notice"]')`,
    "the Exited placeholder",
  );
  await capture(againSecond, "19-layout-restored-exited-placeholder.png");

  // "Pane schließen" removes the placeholder pane; the tab keeps its other pane and the layout is saved again.
  // In front: an occluded window paints no frames and Chromium throttles its timers, so its layout report (50 ms
  // delay in the renderer) could come after the flush below (#156, the check failed on main as well).
  bringToFront(againSecond);
  await click(againSecond, '[data-tab-title="Crash"] .tab__main');
  await click(againSecond, `[data-session-id="${crash.id}"] [data-action="close-pane-placeholder"]`);
  await waitFor(
    againSecond,
    `!document.querySelector('[data-session-id="${crash.id}"]')`,
    "the placeholder pane to close",
  );
  // The renderer reports after its delay; flush and read until the saved layout has lost the pane, or fail.
  const savedDeadline = Date.now() + 10_000;
  for (;;) {
    await flushLayout();
    const saved = JSON.stringify((await core.request("layout.get", {})).result.layout);
    if (!saved.includes(crash.id)) break;
    if (Date.now() > savedDeadline) throw new Error("the closed pane is still in the saved layout");
    await sleep(250);
  }
  log("placeholder closed and saved");

  await restartScenes(crash, againSecond, { core, bridge, log, evaluate, waitFor, capture, click });
}

/** Puts the window above the other one of the scene, so it paints and runs its timers unthrottled. */
function bringToFront(win: BrowserWindow): void {
  // Windows refuses a plain `focus` to an app in the background; "always on top" for a moment lifts it anyway.
  win.setAlwaysOnTop(true);
  win.moveTop();
  win.focus();
  win.setAlwaysOnTop(false);
  win.webContents.invalidate();
}

/**
 * Waits until the page has painted two frames, so `capturePage` shows the current DOM: a window that Windows reports
 * as covered paints nothing and the capture repeats an old frame (19b showed the state of 19a twice). Brings the
 * window to the front before each try; fails after 5 tries.
 */
async function paintedFrame(
  win: BrowserWindow,
  evaluate: <T>(win: BrowserWindow, expression: string) => Promise<T>,
): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    bringToFront(win);
    const painted = await evaluate<boolean>(
      win,
      `new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
        setTimeout(() => resolve(false), 1500);
      })`,
    );
    if (painted) return;
  }
  throw new Error("the window paints no frames (covered by another window?)");
}

interface RestartSceneTools {
  core: ScenarioDeps["core"];
  bridge: ScenarioDeps["bridge"];
  log: ScenarioDeps["log"];
  evaluate: <T>(win: BrowserWindow, expression: string) => Promise<T>;
  waitFor: (win: BrowserWindow, expression: string, what: string, timeoutMs?: number) => Promise<void>;
  capture: (win: BrowserWindow, name: string, options?: CaptureOptions) => Promise<void>;
  click: (win: BrowserWindow, selector: string) => Promise<void>;
}

/**
 * Restart of a session from the app (#156): the Interrupted `crash` opens again as a placeholder, its button
 * "Neu starten" brings it back in the same pane, and the history marks the new run. Then, ended, the sidebar's
 * menu restarts it; at the end it is `Exited` again, so later groups find no extra running session.
 */
async function restartScenes(
  crash: SessionInfo,
  win: BrowserWindow,
  tools: RestartSceneTools,
): Promise<void> {
  const { core, bridge, log, evaluate, waitFor, capture, click } = tools;
  const row = `[data-row-session-id="${crash.id}"]`;
  const pane = `.pane[data-session-id="${crash.id}"]`;
  const stateOf = async (): Promise<string | undefined> =>
    (await core.request("session.list", {})).result.sessions.find((session) => session.id === crash.id)
      ?.state;
  const waitForState = async (states: readonly string[], what: string): Promise<void> => {
    const deadline = Date.now() + 60_000;
    let state = await stateOf();
    while (state === undefined || !states.includes(state)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}; Crash is ${state}`);
      await sleep(250);
      state = await stateOf();
    }
  };
  const living = ["Running", "Detached"] as const;

  // --- The placeholder's button --------------------------------------------------------------------------
  await click(win, row);
  await waitFor(
    win,
    `document.querySelector('${pane} [data-view="notice"][data-state="Interrupted"] [data-action="restart-session"]')`,
    "the Neu starten button in the placeholder of Crash",
  );
  await click(win, `${pane} [data-action="restart-session"]`);
  await waitForState(living, "Crash to live again after Neu starten");
  await waitFor(win, `document.querySelector('${pane} .xterm-rows')`, "the terminal of the restarted Crash");
  const deadline = Date.now() + 30_000;
  while (
    !bridge
      .viewsOf(win.webContents.id)
      .some((viewId) => bridge.sessionOf(win.webContents.id, viewId) === crash.id)
  ) {
    if (Date.now() > deadline) throw new Error("the restarted Crash got no view in its pane");
    await sleep(100);
  }
  const separatorFound = async (): Promise<number> =>
    (await core.request("history.search", { query: "Neu gestartet", sessionIds: [crash.id] })).result.hits
      .length;
  const searchDeadline = Date.now() + 10_000;
  while ((await separatorFound()) === 0) {
    if (Date.now() > searchDeadline) throw new Error("the history of Crash has no separator line");
    await sleep(200);
  }
  await sleep(1_000); // snapshot and the first fit
  await paintedFrame(win, evaluate);
  await capture(win, "19a-session-restarted.png", { visible: `${pane} .terminal-view` });
  log("Crash restarted from its placeholder");

  // --- The sidebar's menu --------------------------------------------------------------------------------
  await core.request("session.kill", { sessionId: crash.id });
  await waitForState(["Exited"], "Crash to end");
  await waitFor(win, `document.querySelector('${row}[data-state="Exited"]')`, "the Exited row of Crash");
  bringToFront(win);
  await evaluate(
    win,
    `(() => {
      const element = document.querySelector('${row}');
      const box = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
    })()`,
  );
  const entry = `[role="menu"] [data-menu-item="restart"]`;
  await waitFor(win, `document.querySelector('${entry}')`, "Neu starten in the menu of Crash");
  // A frame without the menu would pass the check of the DOM: the window must paint it.
  await paintedFrame(win, evaluate);
  await capture(win, "19b-sidebar-restart-menu.png", { visible: entry });
  await click(win, entry);
  await waitForState(living, "Crash to live again after the menu entry");
  log("Crash restarted from the sidebar menu");

  await restartInViewScenes(crash, win, { ...tools, waitForState });
}

/**
 * "Neu starten" in the bar of an attached view (#164): the pane of `crash` keeps its view while the session ends,
 * the bar's button restarts it, and the same view shows the new run. At the end `crash` is `Exited` again.
 */
async function restartInViewScenes(
  crash: SessionInfo,
  win: BrowserWindow,
  tools: RestartSceneTools & {
    waitForState: (states: readonly string[], what: string) => Promise<void>;
  },
): Promise<void> {
  const { core, bridge, log, evaluate, waitFor, capture, click, waitForState } = tools;
  const pane = `.pane[data-session-id="${crash.id}"]`;
  const button = `${pane} [data-restart-bar="button"] [data-action="restart-in-view"]`;
  const living = ["Running", "Detached"] as const;
  const viewsOfCrash = (): string =>
    JSON.stringify(
      bridge
        .viewsOf(win.webContents.id)
        .filter((viewId) => bridge.sessionOf(win.webContents.id, viewId) === crash.id),
    );
  const rowsText = (): Promise<string> =>
    evaluate<string>(win, `document.querySelector('${pane} .xterm-rows')?.textContent ?? ''`);

  await waitFor(
    win,
    `document.querySelector('${pane} .terminal-pane[data-role="writer"]')`,
    "the writing view of Crash",
  );
  const viewsBefore = viewsOfCrash();
  if (viewsBefore === "[]") throw new Error("the pane of Crash has no view before it ends");
  await core.request("session.kill", { sessionId: crash.id });
  await waitForState(["Exited"], "Crash to end in its attached view");
  await waitFor(win, `document.querySelector('${button}')`, "Neu starten in the bar of the attached view");
  // The terminal lies below the bar: the button's middle must be the button itself, not a layer of xterm.js.
  const onTop = await evaluate<string>(
    win,
    `(() => {
      const button = document.querySelector('${button}');
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === button ? 'button' : (hit?.className || hit?.tagName || 'nothing');
    })()`,
  );
  if (onTop !== "button") throw new Error(`the bar's button is covered by ${onTop}`);
  await paintedFrame(win, evaluate);
  await capture(win, "19c-restart-bar-in-view.png", { visible: button });

  const ended = await rowsText();
  await click(win, button);
  await waitForState(living, "Crash to live again after Neu starten in the view");
  await waitFor(win, `!document.querySelector('${pane} [data-restart-bar]')`, "the bar of Crash to go");
  const viewsAfter = viewsOfCrash();
  if (viewsAfter !== viewsBefore)
    throw new Error(`the pane of Crash changed its view: ${viewsBefore} before, ${viewsAfter} after`);
  // The same view gets the new run: its rows change from the ended screen.
  const deadline = Date.now() + 30_000;
  let shown = await rowsText();
  while (shown === ended || shown.trim() === "") {
    if (Date.now() > deadline) throw new Error(`the view of Crash shows no new run; rows: ${shown}`);
    await sleep(200);
    shown = await rowsText();
  }
  await sleep(1_000); // the new run's first screen
  await paintedFrame(win, evaluate);
  await capture(win, "19d-restarted-in-view.png", { visible: `${pane} .terminal-view` });
  log("Crash restarted from the bar of its attached view");

  await core.request("session.kill", { sessionId: crash.id });
  await waitForState(["Exited"], "Crash to end again");
}
