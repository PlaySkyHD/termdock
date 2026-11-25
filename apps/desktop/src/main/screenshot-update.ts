// Scenes of the screenshot mode for the update dialog (#136): a downloaded update with a WSL session and a Windows
// shell running, the dialog that leaves the focus in the terminal and names what ends, the dialog in a second
// window, "Später" for every window, no second offer of a postponed version, a newer version and "Jetzt neu
// starten". The screenshot run offers the update by hand and installs nothing; it counts the install. Any other
// outcome ends the run with an error (exit code 1). Needs Electron, WSL and the isolated core; no unit test (the
// pieces are tested: update service, quit flow, texts, offer, bridge).
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { countActiveWindows } from "../shared/quit-decision.js";
import { updateSessionsNote } from "../shared/update-decision.js";
import type { ScenarioDeps } from "./screenshot-scenario.js";
import { pageDriver } from "./screenshot-page.js";
import { NEUTRAL_PROMPT } from "./screenshot-prompt.js";

const DIALOG = '[data-dialog="update"]';
const NOTE = `${DIALOG} [data-update="sessions"]`;
const WRITER = '.pane[data-tab-active="true"] .terminal-pane[data-role="writer"]';
/** A repeated group (#127) must not meet the versions of its first try: the service remembers "Später". */
let attempt = 0;

export async function updateScenes(deps: ScenarioDeps): Promise<void> {
  const { dir, bridge, core, createWindow, offerUpdate, updateInstalls, log } = deps;
  mkdirSync(dir, { recursive: true });
  attempt += 1;
  const first = `0.${attempt * 10}.0`;
  const newer = `0.${attempt * 10 + 1}.0`;
  const installsBefore = updateInstalls();

  const win = createWindow(1100, 680);
  const windowId = win.webContents.id;
  // Windows of earlier scenes lie below; a covered window stops painting.
  win.webContents.setBackgroundThrottling(false);
  win.show();
  win.moveTop();
  win.focus();
  const page = pageDriver(win, dir);
  const { evaluate, waitFor, capture, click } = page;
  await waitFor(`document.querySelector('.app') && !document.querySelector('.app--loading')`, "the window");
  const exists = (selector: string): string => `document.querySelector(${JSON.stringify(selector)})`;
  const text = (selector: string): Promise<string> =>
    evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);

  // A WSL session in a tab and a Windows shell beside it: the note names the one that ends.
  for (const params of [
    { name: "Linux", launch: { backend: "wsl" as const, cwd: "/tmp" } },
    { name: "Windows cmd", launch: { backend: "windows" as const, shell: "cmd" as const, cwd: "C:\\" } },
  ]) {
    const created = await bridge.call(windowId, { method: "createSession", params });
    if (!created.ok) throw new Error(`createSession ${params.name}: ${created.error.message}`);
  }
  await waitFor(
    `[...document.querySelectorAll('[data-session-name]')].filter((e) => ['Running', 'Detached'].includes(e.dataset.state)).length >= 2`,
    "both sessions alive",
    60_000,
  );
  await click('[data-session-name="Linux"]');
  await waitFor(exists(WRITER), "the writing view of Linux", 60_000);
  // A short prompt without user and host name.
  const [viewId] = bridge.viewsOf(windowId);
  if (viewId === undefined) throw new Error("Linux has no view");
  const input = await bridge.call(windowId, { method: "input", viewId, data: NEUTRAL_PROMPT });
  if (!input.ok) throw new Error(`input: ${input.error.message}`);
  await waitFor(
    `[...document.querySelectorAll('${WRITER} .xterm-rows > div')].some((row) => row.textContent.trim() === "$")`,
    "the short prompt",
  );
  await click(`${WRITER} .xterm`);
  await sleep(300);
  const focusBefore = await evaluate<string>(`(() => {
    window.__updateFocus = document.activeElement;
    return document.activeElement?.className ?? "";
  })()`);
  log(`update: focus before the offer on ${focusBefore}`);

  // --- The offer: version, note about the sessions, focus stays ----------------------------------------
  offerUpdate(first);
  await waitFor(exists(DIALOG), "the update dialog");
  const message = await text(`${DIALOG} [data-update="message"]`);
  if (message !== `Update auf Version ${first} ist bereit.`)
    throw new Error(`Unexpected message: ${message}`);
  // In a full run the shell of the group `windows` may still run beside ours: count what the core has.
  const { sessions } = (await core.request("session.list", {})).result;
  const windowsShells = countActiveWindows(sessions);
  const note = await text(NOTE);
  if (windowsShells < 1 || note !== updateSessionsNote(windowsShells))
    throw new Error(`The dialog does not name what survives (${windowsShells} Windows shells): ${note}`);
  const focusKept = await evaluate<boolean>(`document.activeElement === window.__updateFocus`);
  if (!focusKept) throw new Error("The update dialog took the focus from the terminal");
  if (await evaluate<boolean>(`Boolean(${exists('[aria-modal="true"]')})`))
    throw new Error("The update dialog must not be modal");
  await capture("96a-update-dialog.png", { visible: NOTE });

  // --- A second window shows it too; "Später" there hides it in both -------------------------------------
  const second = createWindow(900, 560);
  second.webContents.setBackgroundThrottling(false);
  const other = pageDriver(second, dir);
  await other.waitFor(exists(DIALOG), "the update dialog in the second window");
  await other.capture("96b-update-second-window.png", { visible: DIALOG });
  await other.click(`${DIALOG} [data-update-choice="later"]`);
  await other.waitFor(`!${exists(DIALOG)}`, "the dialog to close in the second window");
  await waitFor(`!${exists(DIALOG)}`, "the dialog to close in the first window");

  // The postponed version is not offered again while the app runs; a newer one is.
  offerUpdate(first);
  await sleep(1_000);
  if (await evaluate<boolean>(`Boolean(${exists(DIALOG)})`))
    throw new Error("A postponed version was offered again");
  offerUpdate(newer);
  await waitFor(`${exists(`${DIALOG}[data-update-version="${newer}"]`)}`, "the newer version");
  await other.waitFor(exists(DIALOG), "the newer version in the second window");
  if (updateInstalls() !== installsBefore) throw new Error("Später must not install");

  // --- "Jetzt neu starten": one install, the dialog leaves every window --------------------------------------
  await click(`${DIALOG} [data-update-choice="install"]`);
  await waitFor(`!${exists(DIALOG)}`, "the dialog to close after Jetzt neu starten");
  await other.waitFor(`!${exists(DIALOG)}`, "the dialog to close in the second window after the install");
  if (updateInstalls() !== installsBefore + 1)
    throw new Error(`Expected one install, got ${updateInstalls() - installsBefore}`);
  second.close();
  log("update scenes done");
}
