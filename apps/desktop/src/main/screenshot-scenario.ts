// The scenes of the screenshot mode (`--screenshot <dir>`, ADR 0006): sessions in every state, several tabs, a
// collapsed sidebar, an empty window with the form, a notice tab and a reader. It drives the renderer like a user
// (clicks through `webContents.executeJavaScript`, `data-` attributes of the sidebar) and the sessions through the
// bridge, so what is captured is what the app shows. Needs Electron, WSL and the isolated core; no unit test.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { SessionInfo } from "@termdock/protocol";
import type { BrowserWindow } from "electron";
import type { DesktopBridge } from "./bridge.js";
import type { QuietWatch } from "./screenshot.js";

const run = promisify(execFile);

export interface ScenarioDeps {
  dir: string;
  bridge: DesktopBridge;
  watch: QuietWatch;
  createWindow(width: number, height: number): BrowserWindow;
  log(text: string): void;
  /** Tmux socket of the isolated core (`isolated.env.TERMDOCK_TMUX_SOCKET`). */
  tmuxSocket: string;
}

const sessionSelector = (name: string): string => `[data-session-name=${JSON.stringify(name)}]`;
/** JavaScript expression that finds the sidebar entry of the session once it shows the state. */
const stateSelector = (name: string, state: string): string =>
  `document.querySelector(${JSON.stringify(`${sessionSelector(name)}[data-state="${state}"]`)})`;

export async function runScenario({
  dir,
  bridge,
  watch,
  createWindow,
  log,
  tmuxSocket,
}: ScenarioDeps): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const main = createWindow(1100, 680);
  const mainId = main.webContents.id;

  const evaluate = <T>(win: BrowserWindow, expression: string): Promise<T> =>
    win.webContents.executeJavaScript(expression, true) as Promise<T>;

  const waitFor = async (win: BrowserWindow, expression: string, what: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await evaluate<boolean>(win, `Boolean(${expression})`).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(100);
    }
  };

  const click = async (win: BrowserWindow, selector: string): Promise<void> => {
    await waitFor(win, `document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(win, `document.querySelector(${JSON.stringify(selector)}).click()`);
  };

  const viewOf = (win: BrowserWindow, sessionId: string): string | undefined => {
    const windowId = win.webContents.id;
    return bridge.viewsOf(windowId).find((viewId) => bridge.sessionOf(windowId, viewId) === sessionId);
  };

  /** Clicks the session in the sidebar and waits until the window has attached a view for it. */
  const openSession = async (win: BrowserWindow, session: SessionInfo): Promise<void> => {
    await click(win, sessionSelector(session.name));
    const deadline = Date.now() + 60_000;
    while (viewOf(win, session.id) === undefined) {
      if (Date.now() > deadline) throw new Error(`${session.name} was not attached`);
      await sleep(100);
    }
    await sleep(1_000); // snapshot and first fit
  };

  const type = async (win: BrowserWindow, session: SessionInfo, data: string): Promise<void> => {
    const viewId = viewOf(win, session.id);
    if (viewId === undefined) throw new Error(`${session.name} has no view`);
    const result = await bridge.call(win.webContents.id, { method: "input", viewId, data });
    if (!result.ok) throw new Error(`input: ${result.error.message}`);
  };

  /** A short prompt without user and host name, then a clean screen, then the command. */
  const typeCommand = async (win: BrowserWindow, session: SessionInfo, command: string): Promise<void> => {
    await type(win, session, "PS1='$ '; clear\r");
    await sleep(600);
    await type(win, session, `${command}\r`);
    // A timeout fails the run: a picture of a half-drawn screen must not pass.
    await watch.quiet(800, 15_000);
    await sleep(300);
  };

  const capture = async (win: BrowserWindow, name: string): Promise<void> => {
    await sleep(300); // one more frame
    const file = path.join(dir, name);
    writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    console.log(file);
  };

  // --- Sessions in every state ---------------------------------------------------------------
  await waitFor(main, `document.querySelector('[data-view="empty"]')`, "the empty window");
  const created = new Map<string, SessionInfo>();
  for (const name of ["Build", "Logs", "Notes", "Done", "Lost"]) {
    // `/` instead of `~`, so no personal file name appears in a picture.
    const result = await bridge.call(mainId, {
      method: "createSession",
      params: { name, launch: { backend: "wsl", cwd: "/" } },
    });
    if (!result.ok) throw new Error(`createSession ${name}: ${result.error.message}`);
    created.set(name, result.value as SessionInfo);
    log(`created ${name}`);
  }
  const session = (name: string): SessionInfo => {
    const found = created.get(name);
    if (!found) throw new Error(`no session ${name}`);
    return found;
  };
  // Every window learned about them from `sessionCreated`.
  await waitFor(main, `document.querySelectorAll('[data-session-name]').length === 5`, "five sessions");

  // Notes stays detached; the other four open as tabs.
  await openSession(main, session("Build"));
  await typeCommand(main, session("Build"), "ls --color /");
  await openSession(main, session("Logs"));
  await typeCommand(main, session("Logs"), "uname -sr");
  await openSession(main, session("Done"));
  await type(main, session("Done"), "exit\r");
  await waitFor(main, stateSelector("Done", "Exited"), "Done to be Exited");
  await openSession(main, session("Lost"));
  // Kills the tmux session behind the view, as a crash of WSL or tmux would.
  const { distro } = session("Lost").launch;
  if (distro === undefined) throw new Error("The created session has no distro");
  await run("wsl.exe", [
    ...["-d", distro, "--exec", "tmux", "-L", tmuxSocket],
    ...["kill-session", "-t", `=td-${session("Lost").id}`],
  ]);
  await waitFor(main, stateSelector("Lost", "Interrupted"), "Lost to be Interrupted");
  await click(main, sessionSelector("Build")); // focuses the open tab
  await waitFor(main, `document.querySelector('.tab--active[data-tab-title="Build"]')`, "the Build tab");

  await capture(main, "01-sidebar-sessions-tabs.png");

  // --- Collapsed sidebar ---------------------------------------------------------------------
  await click(main, '[data-action="toggle-sidebar"]');
  await waitFor(main, `!document.querySelector('.sidebar')`, "the sidebar to collapse");
  await sleep(800); // the writer fits the wider area
  await capture(main, "02-sidebar-collapsed.png");

  // --- A second window: own tabs, empty, with the form -----------------------------------------
  const second = createWindow(900, 560);
  await waitFor(
    second,
    `document.querySelectorAll('[data-session-name]').length === 5`,
    "the sessions in window 2",
  );
  await click(second, '[data-action="new-session"]');
  await waitFor(second, `document.querySelector('[data-form="new-session"]')`, "the form");
  await capture(second, "03-new-window-empty-form.png");
  await click(second, '[data-action="new-session"]'); // closes the form

  // A session that is gone opens a notice instead of a view, and no view is attached for it.
  await click(second, sessionSelector("Done"));
  await click(second, sessionSelector("Lost"));
  await waitFor(
    second,
    `document.querySelector('.tab-panel[data-active="true"] [data-view="notice"]')`,
    "the notice",
  );
  if (viewOf(second, session("Lost").id) !== undefined) throw new Error("Lost must not be attached");
  await capture(second, "04-interrupted-notice.png");

  // The same session as in window 1: this window reads.
  await openSession(second, session("Build"));
  await waitFor(second, `document.querySelector('.status-bar--reader')`, "the reader role");
  await capture(second, "05-reader.png");
}
