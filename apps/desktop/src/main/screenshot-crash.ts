// Scenes of the screenshot mode for a crashed renderer (#133): two windows show one session, the first one writes.
// Its renderer is crashed with `forcefullyCrashRenderer()`; the main process detaches the views of that window, the
// input right is free, and the second window takes it and writes. A reload of the first window attaches it again,
// now as a reader. Any other outcome ends the run with an error (exit code 1). Needs Electron, WSL and the isolated
// core; no unit test (the pieces are tested: bridge `resetWindow`, registry writer, terminal controller).
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { SessionInfo } from "@termdock/protocol";
import type { BrowserWindow } from "electron";
import type { ScenarioDeps } from "./screenshot-scenario.js";
import { pageDriver } from "./screenshot-page.js";
import { NEUTRAL_PROMPT } from "./screenshot-prompt.js";

const PANE = '.pane[data-tab-active="true"]';
const WRITER = `${PANE} .terminal-pane[data-role="writer"]`;
const READER = `${PANE} .terminal-pane[data-role="reader"]`;
const TAKE_INPUT = `${READER} [data-action="take-input"]`;

export async function crashScenes(deps: ScenarioDeps): Promise<void> {
  const { dir, bridge, createWindow, watch, log, core } = deps;
  mkdirSync(dir, { recursive: true });
  const open = (): BrowserWindow => {
    const win = createWindow(900, 560);
    // Windows of earlier scenes lie below; a covered window stops painting.
    win.webContents.setBackgroundThrottling(false);
    win.show();
    return win;
  };
  const first = open();
  const second = open();
  // Side by side, relative to the first window (the run picks the monitor, screenshot-restore.ts).
  const [x = 0, y = 0] = first.getPosition();
  second.setPosition(x + 920, y);
  const firstId = first.webContents.id;
  const secondId = second.webContents.id;
  const a = pageDriver(first, dir);
  const b = pageDriver(second, dir);
  const loaded = `document.querySelector('.app') && !document.querySelector('.app--loading')`;
  await a.waitFor(loaded, "the first window");
  await b.waitFor(loaded, "the second window");

  const created = await bridge.call(firstId, {
    method: "createSession",
    params: { name: "Crashy", launch: { backend: "wsl", cwd: "/tmp" } },
  });
  if (!created.ok) throw new Error(`createSession Crashy: ${created.error.message}`);
  const session = created.value as SessionInfo;
  const viewIn = (windowId: number): string | undefined =>
    bridge.viewsOf(windowId).find((view) => bridge.sessionOf(windowId, view) === session.id);
  const attachedIn = async (windowId: number, what: string): Promise<string> => {
    const deadline = Date.now() + 60_000;
    for (let view = viewIn(windowId); ; view = viewIn(windowId)) {
      if (view !== undefined) return view;
      if (Date.now() > deadline) throw new Error(`Crashy was not attached in ${what}`);
      await sleep(100);
    }
  };
  const writerOf = async (): Promise<string | undefined> => {
    const { sessions } = (await core.request("session.list", {})).result;
    return sessions.find((s) => s.id === session.id)?.writerViewId;
  };
  const rowsHave = (text: string): string =>
    `[...document.querySelectorAll(${JSON.stringify(`${PANE} .xterm-rows > div`)})].some((row) => row.textContent.includes(${JSON.stringify(text)}))`;

  // --- The first window writes, the second one reads ---------------------------------------------------------
  first.moveTop();
  await a.click(`[data-session-name="Crashy"]`);
  const crashedView = await attachedIn(firstId, "the first window");
  await a.waitFor(`document.querySelector(${JSON.stringify(WRITER)})`, "the writer in the first window");
  await sleep(1_000); // snapshot and first fit
  await bridge.call(firstId, { method: "input", viewId: crashedView, data: NEUTRAL_PROMPT });
  await sleep(600);
  await bridge.call(firstId, { method: "input", viewId: crashedView, data: "echo before-crash-$((6*7))\r" });
  await watch.quiet(800, 15_000);
  second.moveTop();
  await b.click(`[data-session-name="Crashy"]`);
  await attachedIn(secondId, "the second window");
  await b.waitFor(
    `document.querySelector(${JSON.stringify(READER)}) && ${rowsHave("before-crash-42")}`,
    "the reader with the output in the second window",
  );

  // --- The renderer of the first window crashes ----------------------------------------------------------------
  first.webContents.forcefullyCrashRenderer();
  const deadline = Date.now() + 30_000;
  while (bridge.viewsOf(firstId).length > 0 || (await writerOf()) !== undefined) {
    if (Date.now() > deadline)
      throw new Error(
        `The crashed window kept its views (${bridge.viewsOf(firstId).join(", ")}) or the writer (${await writerOf()})`,
      );
    await sleep(100);
  }
  const lost = await bridge.call(firstId, { method: "input", viewId: crashedView, data: "echo lost\r" });
  if (lost.ok) throw new Error("Input of a view of the crashed window was accepted");
  await b.capture("31-crash-input-free.png", { visible: TAKE_INPUT });

  // --- The second window takes the input and writes ------------------------------------------------------------
  await b.click(TAKE_INPUT);
  await b.waitFor(`document.querySelector(${JSON.stringify(WRITER)})`, "the writer in the second window");
  const writer = await attachedIn(secondId, "the second window");
  if ((await writerOf()) !== writer)
    throw new Error("The core does not name the second window as the writer");
  await bridge.call(secondId, { method: "input", viewId: writer, data: "echo after-crash-$((6*8))\r" });
  await watch.quiet(800, 15_000);
  await b.waitFor(rowsHave("after-crash-48"), "the output of the second window");
  await b.capture("32-crash-other-window-writes.png", { visible: WRITER });

  // --- The first window reloads and attaches again, as a reader --------------------------------------------------
  first.webContents.reload();
  await a.waitFor(loaded, "the reloaded first window", 60_000);
  first.moveTop();
  const reattached = await attachedIn(firstId, "the reloaded first window");
  if (reattached === crashedView)
    throw new Error("The reloaded window kept the view of the crashed renderer");
  await a.waitFor(
    `document.querySelector(${JSON.stringify(READER)}) && ${rowsHave("after-crash-48")}`,
    "the reloaded window as a reader with the output",
    60_000,
  );
  if ((await writerOf()) !== writer) throw new Error("The reload took the input from the second window");
  await a.capture("33-crash-reloaded-reader.png", { visible: READER });
  log(
    "crash: the views of the crashed window were detached, the other window writes, the reload attached again",
  );
}
