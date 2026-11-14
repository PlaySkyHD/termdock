// Scenes of the screenshot mode for the layout restore (#29, ADR 0006): two windows with several tabs and splits,
// a restart of the UI, and the restored state compared with the one before. A session killed with
// `tmux kill-session` while the UI is "away" comes back as a placeholder. Needs Electron, WSL and the isolated
// core; no unit test (the pieces are tested: layout mapping, coordinator, geometry, placeholder).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { LayoutDocument, SessionInfo } from "@termdock/protocol";
import type { BrowserWindow } from "electron";
import type { ScenarioDeps } from "./screenshot-scenario.js";

type Wsl = (args: readonly string[]) => Promise<string>;

const sessionSelector = (name: string): string => `[data-session-name=${JSON.stringify(name)}]`;

/** What a window shows of its layout: tab titles (active one starred), sidebar and the panes with their shares. */
const SUMMARY_EXPRESSION = `(() => ({
  sidebar: Boolean(document.querySelector('.sidebar')),
  tabs: [...document.querySelectorAll('[data-tab-title]')].map((tab) => tab.dataset.tabTitle + (tab.classList.contains('tab--active') ? '*' : '')),
  panels: [...document.querySelectorAll('.tab-panel')].map((panel) => {
    const area = panel.querySelector('.pane-tree').getBoundingClientRect();
    return [...panel.querySelectorAll('.pane')].map((pane) => {
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
  const capture = async (win: BrowserWindow, name: string): Promise<void> => {
    await sleep(300);
    const file = path.join(dir, name);
    writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    console.log(file);
  };
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
        const divider = document.querySelector('.tab-panel[data-active="true"] .divider');
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
  first.setBounds({ x: 40, y: 40, width: 1000, height: 640 });
  await waitFor(
    first,
    `document.querySelectorAll('[data-session-name]').length >= 10`,
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
  second.setBounds({ x: 120, y: 100, width: 900, height: 600 });
  await waitFor(
    second,
    `document.querySelectorAll('[data-session-name]').length >= 10`,
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
      `!document.querySelector('[data-view="restoring"]') && document.querySelector('.tab-panel')`,
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
  await click(againSecond, '[data-tab-title="Crash"] .tab__main');
  await click(againSecond, `[data-session-id="${crash.id}"] [data-action="close-pane-placeholder"]`);
  await waitFor(
    againSecond,
    `!document.querySelector('[data-session-id="${crash.id}"]')`,
    "the placeholder pane to close",
  );
  await flushLayout();
  const saved = (await core.request("layout.get", {})).result.layout;
  const ids = JSON.stringify(saved);
  if (ids.includes(crash.id)) throw new Error("the closed pane is still in the saved layout");
  log("placeholder closed and saved");
}
