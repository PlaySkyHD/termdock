// Scenes of the screenshot mode for a restart of the core (#130): the isolated core is ended by its process id like a
// crash, the supervisor of the main process starts it again (held for the first picture), the pane shows
// "Core startet neu …" and drops input meanwhile, then "Core neu gestartet", the old output from the new snapshot
// and a writing view that takes input again. Any other outcome ends the run with an error (exit code 1). Needs
// Electron, WSL and the isolated core; no unit test (the pieces are tested: supervisor, bridge, store, controller).
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { SessionInfo } from "@termdock/protocol";
import type { ScenarioDeps } from "./screenshot-scenario.js";
import { pageDriver } from "./screenshot-page.js";

const PANE = '.pane[data-tab-active="true"]';
const RESTARTING = `${PANE} [data-core="restarting"]`;
const RESTARTED = '[data-hint="core-restarted"]';
const WRITER = `${PANE} .terminal-pane[data-role="writer"]`;

export async function restartScenes(deps: ScenarioDeps): Promise<void> {
  const { dir, bridge, createWindow, watch, log, killCore, holdCoreRestart } = deps;
  mkdirSync(dir, { recursive: true });
  const win = createWindow(1100, 680);
  const windowId = win.webContents.id;
  // Windows of earlier scenes lie below; a covered window stops painting.
  win.webContents.setBackgroundThrottling(false);
  win.show();
  win.moveTop();
  win.focus();
  const { evaluate, waitFor, capture, click } = pageDriver(win, dir);
  await waitFor(`document.querySelector('.app') && !document.querySelector('.app--loading')`, "the window");

  const created = await bridge.call(windowId, {
    method: "createSession",
    params: { name: "Phoenix", launch: { backend: "wsl", cwd: "/tmp" } },
  });
  if (!created.ok) throw new Error(`createSession Phoenix: ${created.error.message}`);
  const session = created.value as SessionInfo;
  const viewOf = (): string | undefined =>
    bridge.viewsOf(windowId).find((view) => bridge.sessionOf(windowId, view) === session.id);
  const attached = async (): Promise<string> => {
    const deadline = Date.now() + 60_000;
    for (let view = viewOf(); ; view = viewOf()) {
      if (view !== undefined) return view;
      if (Date.now() > deadline) throw new Error("Phoenix was not attached");
      await sleep(100);
    }
  };
  const type = async (viewId: string, data: string) =>
    bridge.call(windowId, { method: "input", viewId, data });
  const rowsHave = (text: string): string =>
    `[...document.querySelectorAll(${JSON.stringify(`${PANE} .xterm-rows > div`)})].some((row) => row.textContent.includes(${JSON.stringify(text)}))`;

  await click(`[data-session-name="Phoenix"]`);
  const before = await attached();
  await sleep(1_000); // snapshot and first fit
  await type(before, "PS1='$ '; clear\r");
  await sleep(600);
  await type(before, "echo before-restart-$((6*7))\r");
  await watch.quiet(800, 15_000);
  await waitFor(rowsHave("before-restart-42"), "the marker before the restart");

  // --- The core ends like a crash; its restart is held so the pane can be captured ----------------------------
  const release = holdCoreRestart();
  try {
    killCore();
    await waitFor(`document.querySelector(${JSON.stringify(RESTARTING)})`, "Core startet neu … in the pane");
    // The views died with the core: the main process forgot them, input goes nowhere and is not kept.
    if (bridge.viewsOf(windowId).length > 0) throw new Error("The main process kept views of the dead core");
    const lost = await type(before, "echo lost-$((6*9))\r");
    if (lost.ok) throw new Error("Input of a view of the dead core was accepted");
    const text = await evaluate<string>(`document.querySelector(${JSON.stringify(RESTARTING)}).textContent`);
    if (!text.includes("Core startet neu …")) throw new Error(`Unexpected restart note: ${text}`);
    await capture("90-core-restarting.png", { visible: RESTARTING });
  } finally {
    release();
  }

  // --- The core is back: note, old output from the new snapshot, a writer ------------------------------------
  // The note closes itself after a few seconds; the view attaches in the same moment, so wait for all three.
  await waitFor(
    `document.querySelector(${JSON.stringify(RESTARTED)}) && document.querySelector(${JSON.stringify(WRITER)}) && ${rowsHave("before-restart-42")}`,
    "Core neu gestartet with the old output in a writing pane",
    60_000,
  );
  await capture("91-core-restarted.png", { visible: RESTARTED });
  const after = await attached();
  if (after === before) throw new Error("The pane did not attach a new view");
  await type(after, "echo after-restart-$((6*8))\r");
  await watch.quiet(800, 15_000);
  await waitFor(rowsHave("after-restart-48"), "input after the restart");
  if (await evaluate<boolean>(rowsHave("lost-54")))
    throw new Error("Input typed during the restart reached the session");
  await waitFor(
    `document.querySelector('[data-session-name="Phoenix"][data-state="Running"]')`,
    "Phoenix Running in the sidebar",
  );
  log("restart: the core came back, the pane attached again and writes");
}
