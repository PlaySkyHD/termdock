// Scenes of the screenshot mode for the history search (#62): two sessions print a common word, Ctrl+Shift+F opens
// the dialog, the search finds hits in both sessions (shown grouped by session), and a click on a hit focuses the
// session's tab. Needs Electron, WSL and the isolated core; no unit test (the pieces are tested: search model,
// commands, bridge, core search).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SessionInfo } from "@termdock/protocol";
import type { ScenarioDeps } from "./screenshot-scenario.js";

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
  const capture = async (name: string): Promise<void> => {
    await sleep(300);
    const file = path.join(dir, name);
    writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    console.log(file);
  };
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
  log("history search scenes done");
}
