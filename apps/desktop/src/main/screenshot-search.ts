// Scenes of the screenshot mode for the history search (#62): two sessions print a common word, Ctrl+Shift+F opens
// the dialog, the search finds hits in both sessions (shown grouped by session), and a click on a hit focuses the
// session's tab. Needs Electron, WSL and the isolated core; no unit test (the pieces are tested: search model,
// commands, bridge, core search).
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { SessionInfo } from "@termdock/protocol";
import { captureWindow } from "./screenshot-page.js";
import type { ScenarioDeps } from "./screenshot-scenario.js";
import type { CaptureOptions } from "./screenshot-visible.js";

const sessionSelector = (name: string): string => `[data-session-name=${JSON.stringify(name)}]`;

export async function searchScenes(deps: ScenarioDeps): Promise<void> {
  const { dir, bridge, createWindow, watch, log } = deps;
  mkdirSync(dir, { recursive: true });
  const win = createWindow(1100, 680);
  const windowId = win.webContents.id;
  // Windows of earlier scenes lie below; a covered window stops painting.
  win.webContents.setBackgroundThrottling(false);
  win.show();
  win.moveTop();
  win.focus();

  const evaluate = <T>(expression: string): Promise<T> =>
    win.webContents.executeJavaScript(expression, true) as Promise<T>;
  const waitFor = async (expression: string, what: string, timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await evaluate<boolean>(`Boolean(${expression})`).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  const click = async (selector: string): Promise<void> => {
    await waitFor(`document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const capture = (name: string, options?: CaptureOptions): Promise<void> =>
    captureWindow(win, dir, name, options);
  const key = async (keyCode: string, modifiers: Array<"control" | "shift">): Promise<void> => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await sleep(400);
  };

  // Two sessions that print the word "deploy" (with logging, which is the default).
  const sessions = new Map<string, SessionInfo>();
  for (const name of ["Deploy", "Tests"]) {
    const created = await bridge.call(windowId, {
      method: "createSession",
      params: { name, launch: { backend: "wsl", cwd: "/" } },
    });
    if (!created.ok) throw new Error(`createSession ${name}: ${created.error.message}`);
    sessions.set(name, created.value as SessionInfo);
  }
  const lines: Record<string, string> = {
    Deploy: `echo 'deploy finished: 3 services updated'; echo 'DEPLOY warning: cache was cold'`,
    Tests: `echo 'tests passed: 128 ok, then deploy check passed'`,
  };
  for (const [name, command] of Object.entries(lines)) {
    const session = sessions.get(name)!;
    await click(sessionSelector(name));
    const deadline = Date.now() + 60_000;
    let viewId: string | undefined;
    while (viewId === undefined) {
      viewId = bridge.viewsOf(windowId).find((view) => bridge.sessionOf(windowId, view) === session.id);
      if (Date.now() > deadline) throw new Error(`${name} was not attached`);
      await sleep(100);
    }
    await sleep(1_000); // snapshot and first fit
    const type = async (data: string): Promise<void> => {
      const result = await bridge.call(windowId, { method: "input", viewId: viewId!, data });
      if (!result.ok) throw new Error(`input: ${result.error.message}`);
    };
    await type("PS1='$ '; clear\r");
    await sleep(600);
    await type(`${command}\r`);
    await watch.quiet(800, 15_000);
  }
  await sleep(500);

  // The key opens the dialog; the text goes into its field like typing.
  win.focus();
  await key("F", ["control", "shift"]);
  await waitFor(`document.querySelector('[data-dialog="search"]')`, "the search dialog");
  await waitFor(
    `document.activeElement && document.activeElement.dataset.search === 'input'`,
    "the field to have the focus",
  );
  await capture("26-history-search-empty.png");
  win.webContents.insertText("deploy");
  await waitFor(
    `document.querySelectorAll('[data-search-group]').length === 2`,
    "hits of two sessions",
    15_000,
  );
  const groups = await evaluate<string[]>(
    `[...document.querySelectorAll('[data-search-group]')].map((group) => group.dataset.searchGroup)`,
  );
  if (!groups.includes("Deploy") || !groups.includes("Tests"))
    throw new Error(`Hits in ${JSON.stringify(groups)} instead of Deploy and Tests`);
  await capture("27-history-search-hits.png");
  log("history search found hits in two sessions");

  // A click on a hit of Tests closes the dialog and focuses that session.
  await click(`[data-search-group="Tests"] [data-search-hit]`);
  await waitFor(`!document.querySelector('[data-dialog="search"]')`, "the dialog to close");
  await waitFor(
    `document.querySelector('.tab--active[data-tab-title="Tests"]')`,
    "the Tests tab to be active",
  );
  await capture("28-history-search-opened-session.png");

  // Keyboard (#103): the arrow keys choose a hit of the second group, Enter opens its session. The focus stays in
  // the field the whole time. Any other outcome ends the run with an error (exit code 1).
  win.focus();
  await key("F", ["control", "shift"]);
  await waitFor(`document.querySelector('[data-dialog="search"]')`, "the search dialog (second time)");
  await waitFor(
    `document.activeElement && document.activeElement.dataset.search === 'input'`,
    "the field to have the focus",
  );
  win.webContents.insertText("deploy");
  await waitFor(
    `document.querySelectorAll('[data-search-group]').length === 2`,
    "hits of two sessions",
    15_000,
  );
  const layout = await evaluate<{ names: string[]; counts: number[] }>(
    `({ names: [...document.querySelectorAll('[data-search-group]')].map((group) => group.dataset.searchGroup),
       counts: [...document.querySelectorAll('[data-search-group]')].map((group) => group.querySelectorAll('[role=option]').length) })`,
  );
  const target = layout.names[1]!;
  const activeTab = await evaluate<string | null>(
    `document.querySelector('.tab--active')?.dataset.tabTitle ?? null`,
  );
  if (activeTab === target)
    throw new Error(`The tab ${target} is active already; the scene would show nothing`);
  // The first hit of the second group comes after all hits of the first one.
  const steps = layout.counts[0]! + 1;
  for (let step = 0; step < steps; step++) await key("Down", []);
  const chosen = await evaluate<{
    focus: string | undefined;
    active: string | null;
    selectedId: string | undefined;
    group: string | undefined;
    selectedCount: number;
  }>(
    `(() => {
      const input = document.querySelector('[data-search="input"]');
      const selected = document.querySelectorAll('[role=option][aria-selected=true]');
      return {
        focus: document.activeElement && document.activeElement.dataset.search,
        active: input.getAttribute('aria-activedescendant'),
        selectedId: selected[0]?.id,
        group: selected[0]?.closest('[data-search-group]')?.dataset.searchGroup,
        selectedCount: selected.length,
      };
    })()`,
  );
  if (
    chosen.focus !== "input" ||
    chosen.selectedCount !== 1 ||
    chosen.active !== chosen.selectedId ||
    chosen.group !== target
  )
    throw new Error(`Arrow keys did not choose the first hit of ${target}: ${JSON.stringify(chosen)}`);
  await capture("29-history-search-keyboard-selected.png");
  log(`history search: the arrow keys chose a hit of ${target}`);

  await key("Return", []);
  await waitFor(`!document.querySelector('[data-dialog="search"]')`, "the dialog to close after Enter");
  await waitFor(
    `document.querySelector('.tab--active[data-tab-title=${JSON.stringify(target)}]')`,
    `the ${target} tab to be active after Enter`,
  );
  await capture("30-history-search-keyboard-opened.png");
  log("history search scenes done");
}
