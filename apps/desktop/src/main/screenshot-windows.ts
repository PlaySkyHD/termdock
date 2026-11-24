// Scenes of the screenshot mode for Windows shells and their persistence limit (#65): the form "Neue Session" with
// backend Windows and shell cmd, the session with its badge in the sidebar and the note in the status bar, a Windows
// project in the project dialog, the quit dialog that names the limit, and the session `Interrupted` after the core
// ended, with its restart. Any other outcome ends the run with an error (exit code 1). Needs Electron, WSL (for the
// WSL session beside it) and the isolated core; no unit test (the pieces are tested: backend, models, texts).
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { SessionInfo } from "@termdock/protocol";
import type { ScenarioDeps } from "./screenshot-scenario.js";
import { pageDriver } from "./screenshot-page.js";

const WINDOWS = "Windows cmd";
const sessionSelector = (name: string): string => `[data-session-name=${JSON.stringify(name)}]`;
const PANE = '.pane[data-tab-active="true"]';
const FORM = '[data-form="new-session"]';
const PERSISTENCE = '[data-status="persistence"]';
const NOTICE = `${PANE} [data-view="notice"]`;
const WRITER = `${PANE} .terminal-pane[data-role="writer"]`;

export async function windowsScenes(deps: ScenarioDeps): Promise<void> {
  const { dir, bridge, core, createWindow, decideQuit, killCore, watch, log } = deps;
  mkdirSync(dir, { recursive: true });
  const win = createWindow(1100, 680);
  const windowId = win.webContents.id;
  // Windows of earlier scenes lie below; a covered window stops painting.
  win.webContents.setBackgroundThrottling(false);
  win.show();
  win.moveTop();
  win.focus();
  const { evaluate, waitFor, capture, click, fill } = pageDriver(win, dir);
  await waitFor(`document.querySelector('.app') && !document.querySelector('.app--loading')`, "the window");
  const exists = (selector: string): string => `document.querySelector(${JSON.stringify(selector)})`;
  /** Sets a select the way React hears it (`fill` covers inputs). */
  const choose = async (selector: string, value: string): Promise<void> => {
    await waitFor(exists(selector), selector);
    await evaluate(`(() => {
      const field = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(100);
  };
  const text = (selector: string): Promise<string> =>
    evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
  const rows = (): Promise<string[]> =>
    evaluate<string[]>(
      `[...document.querySelectorAll('${PANE} .xterm-rows > div')].map((row) => row.textContent)`,
    );
  const waitRows = async (found: (rows: string[]) => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 30_000;
    while (!found(await rows())) {
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(await rows())}`);
      await sleep(200);
    }
  };
  const session = async (name: string): Promise<SessionInfo> => {
    const found = (await core.request("session.list", {})).result.sessions.find((each) => each.name === name);
    if (!found) throw new Error(`No session ${name}`);
    return found;
  };
  const viewOf = (sessionId: string): string | undefined =>
    bridge.viewsOf(windowId).find((view) => bridge.sessionOf(windowId, view) === sessionId);
  const attached = async (sessionId: string): Promise<string> => {
    const deadline = Date.now() + 60_000;
    for (let view = viewOf(sessionId); ; view = viewOf(sessionId)) {
      if (view !== undefined) return view;
      if (Date.now() > deadline) throw new Error(`${WINDOWS} was not attached`);
      await sleep(100);
    }
  };
  const type = async (viewId: string, data: string): Promise<void> => {
    const result = await bridge.call(windowId, { method: "input", viewId, data });
    if (!result.ok) throw new Error(`input: ${result.error.message}`);
  };

  // A WSL session beside it: it has no badge, its tmux session outlives the core.
  const linux = await bridge.call(windowId, {
    method: "createSession",
    params: { name: "Linux", launch: { backend: "wsl", cwd: "/tmp" } },
  });
  if (!linux.ok) throw new Error(`createSession Linux: ${linux.error.message}`);

  // --- The form "Neue Session" with backend Windows and shell cmd -----------------------------------------------
  await click('[data-action="new-session"]');
  await waitFor(exists(FORM), "the form");
  await choose(`${FORM} [data-field="backend"]`, "windows");
  await choose(`${FORM} [data-field="shell"]`, "cmd");
  await fill(`${FORM} [data-field="name"]`, WINDOWS);
  // C:\ keeps the user folder (and its name) out of the prompt.
  await fill(`${FORM} [data-field="cwd"]`, "C:\\");
  const formNote = await text(`${FORM} [data-form-note="persistence"]`);
  if (!formNote.includes("Läuft nur, solange der TermDock-Core läuft"))
    throw new Error(`The form does not name the limit: ${formNote}`);
  await capture("34-windows-new-session.png", { visible: `${FORM} [data-field="shell"]` });

  await click(`${FORM} button[type="submit"]`);
  await waitFor(`!${exists(FORM)}`, "the form to close");
  const shell = await session(WINDOWS);
  if (shell.launch.backend !== "windows" || shell.launch.shell !== "cmd" || shell.launch.cwd !== "C:\\")
    throw new Error(`The core started another launch spec: ${JSON.stringify(shell.launch)}`);
  const first = await attached(shell.id);
  await waitRows((current) => current.some((row) => row.includes("C:\\>")), "the prompt of cmd");
  await type(first, "echo Windows-Shell %PROCESSOR_ARCHITECTURE%\r");
  await watch.quiet(800, 15_000);
  await waitRows(
    (current) => current.some((row) => /^Windows-Shell \w+/.test(row.trim())),
    "the output of cmd",
  );

  // --- Sidebar badge and status bar note -----------------------------------------------------------------------
  await waitFor(
    exists(`${sessionSelector(WINDOWS)} [data-badge="windows"]`),
    "the badge of the Windows session",
  );
  if (await evaluate<boolean>(`Boolean(${exists(`${sessionSelector("Linux")} [data-badge]`)})`))
    throw new Error("The WSL session has a badge");
  const note = await text(PERSISTENCE);
  if (note !== "Läuft nur, solange der TermDock-Core läuft")
    throw new Error(`Unexpected status note: ${note}`);
  const backend = await text('[data-status="backend"]');
  if (backend !== "Windows · cmd") throw new Error(`Unexpected backend in the status bar: ${backend}`);
  await capture("35-windows-session.png", { visible: PERSISTENCE });
  log("windows: the session runs with badge and status note");

  // --- A Windows project through the dialog of the workspace --------------------------------------------------
  const created = await bridge.call(windowId, { method: "createWorkspace", name: "Windows-Projekte" });
  if (!created.ok) throw new Error(`createWorkspace: ${created.error.message}`);
  await click('[data-workspace-name="Windows-Projekte"] [data-action="workspace-menu"]');
  await click('[data-menu-item="addProject"]');
  await fill('[data-dialog="name"] [data-field="name"]', "web");
  await choose('[data-dialog="name"] [data-field="backend"]', "windows");
  await fill('[data-dialog="name"] [data-field="path"]', "C:\\");
  const projectNote = '[data-dialog="name"] [data-field-note="backend"]';
  await waitFor(exists(projectNote), "the note of the Windows backend");
  await capture("36-windows-project-dialog.png", { visible: projectNote });
  await click('[data-dialog="name"] [data-name="ok"]');
  await waitFor(
    exists('[data-project-name="web"] [data-badge="windows"]'),
    "the Windows project with its badge",
  );

  // --- The quit dialog names the limit -------------------------------------------------------------------------
  const asked = decideQuit(win);
  await waitFor(exists('[data-quit="windows"]'), "the Windows note of the quit dialog");
  const quitNote = await text('[data-quit="windows"]');
  if (!quitNote.startsWith("Die Windows-Shell läuft nur, solange der TermDock-Core läuft"))
    throw new Error(`Unexpected quit note: ${quitNote}`);
  await capture("37-windows-quit-dialog.png", { visible: '[data-quit="windows"]' });
  await click('[data-quit-choice="cancel"]');
  if ((await asked) !== undefined) throw new Error("Abbrechen must not quit");
  await waitFor(`!${exists('[data-dialog="quit"]')}`, "the quit dialog to close");

  // --- The core ends: the Windows shell with it, the WSL session lives on ---------------------------------------
  await click(sessionSelector(WINDOWS));
  killCore();
  await waitFor(
    `${exists(`${sessionSelector(WINDOWS)}[data-state="Interrupted"]`)} && ${exists(NOTICE)}`,
    `${WINDOWS} Interrupted with its notice after the core restart`,
    90_000,
  );
  await waitFor(
    `document.querySelector('${sessionSelector("Linux")}')?.dataset.state === "Detached" || document.querySelector('${sessionSelector("Linux")}')?.dataset.state === "Running"`,
    "Linux alive after the core restart",
    60_000,
  );
  const notice = await text(NOTICE);
  if (!notice.includes("mit dem Core beendet")) throw new Error(`Unexpected notice: ${notice}`);
  await capture("38-windows-interrupted.png", { visible: NOTICE });

  // --- "Neu starten" starts a new shell after the separator ---------------------------------------------------
  await click(`${NOTICE} [data-action="restart-session"]`);
  await waitFor(exists(WRITER), "a writing view of the restarted shell", 60_000);
  await waitRows((current) => current.some((row) => row.includes("--- Neu gestartet")), "the separator");
  await waitRows((current) => current.some((row) => row.includes("C:\\>")), "the prompt of the new shell");
  await capture("39-windows-restarted.png", { visible: WRITER });
  log("windows scenes done");
}
