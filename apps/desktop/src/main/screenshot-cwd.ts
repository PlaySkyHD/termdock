// Scenes of the screenshot mode for a missing working directory (#113): a session whose `cwd` does not exist in the
// distro starts anyway, its pane shows the warning of the core with the path, the distro and where the shell runs
// (`/`), the shell really runs there, and closing the hint hides it while the terminal keeps its input. A session in
// an existing directory shows no hint. Any other outcome ends the run with an error (exit code 1). Needs Electron,
// WSL and the isolated core; no unit test (the pieces are tested: core check, contract, store, texts).
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { SessionInfo } from "@termdock/protocol";
import type { ScenarioDeps } from "./screenshot-scenario.js";
import { pageDriver } from "./screenshot-page.js";

const sessionSelector = (name: string): string => `[data-session-name=${JSON.stringify(name)}]`;
const HINT = '.pane[data-tab-active="true"] [data-hint="session-warnings"]';

export async function cwdScenes(deps: ScenarioDeps): Promise<void> {
  const { dir, bridge, createWindow, watch, log } = deps;
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

  const create = async (name: string, cwd: string): Promise<SessionInfo> => {
    const created = await bridge.call(windowId, {
      method: "createSession",
      params: { name, launch: { backend: "wsl", cwd } },
    });
    if (!created.ok) throw new Error(`createSession ${name}: ${created.error.message}`);
    return created.value as SessionInfo;
  };
  const open = async (session: SessionInfo): Promise<string> => {
    await click(sessionSelector(session.name));
    const deadline = Date.now() + 60_000;
    let viewId: string | undefined;
    while (viewId === undefined) {
      viewId = bridge.viewsOf(windowId).find((view) => bridge.sessionOf(windowId, view) === session.id);
      if (Date.now() > deadline) throw new Error(`${session.name} was not attached`);
      await sleep(100);
    }
    await sleep(1_000); // snapshot and first fit
    return viewId;
  };
  const type = async (viewId: string, data: string): Promise<void> => {
    const result = await bridge.call(windowId, { method: "input", viewId, data });
    if (!result.ok) throw new Error(`input: ${result.error.message}`);
  };
  const rows = (): Promise<string[]> =>
    evaluate<string[]>(
      `[...document.querySelectorAll('.pane[data-tab-active="true"] .xterm-rows > div')].map((row) => row.textContent)`,
    );

  // --- A project path that does not exist in the distro: the session starts and warns --------------------------
  const missing = `/srv/termdock-missing-${process.pid}`;
  const api = await create("API", missing);
  const warning = api.warnings?.[0];
  if (api.state !== "Detached" || warning?.code !== "cwd_missing" || warning.path !== missing)
    throw new Error(`The core did not start API with a cwd_missing warning: ${JSON.stringify(api)}`);
  const distro = warning.distro ?? "?";
  const view = await open(api);
  await waitFor(`document.querySelector(${JSON.stringify(HINT)})`, "the warning hint in the pane");
  const text = await evaluate<string>(`document.querySelector(${JSON.stringify(HINT)}).textContent`);
  const expected = `Verzeichnis ${missing} fehlt in ${distro} – die Session läuft im Wurzelverzeichnis /.`;
  if (!text.includes(expected)) throw new Error(`Unexpected hint: ${text}`);
  // The hint tells the truth: the shell runs in /.
  await type(view, "PS1='$ '; clear\r");
  await sleep(600);
  await type(view, "printf 'cwd=%s\\n' \"$PWD\"\r");
  await watch.quiet(800, 15_000);
  if (!(await rows()).some((row) => row.trim() === "cwd=/"))
    throw new Error(`The shell does not run in /: ${JSON.stringify(await rows())}`);
  await capture("70-cwd-missing-warning.png");
  log(`cwd: API started in / with the hint for ${missing} in ${distro}`);

  // --- Closing the hint hides it; the terminal keeps its input ------------------------------------------------
  await click(`${HINT} [data-action="dismiss-warnings"]`);
  await waitFor(`!document.querySelector(${JSON.stringify(HINT)})`, "the hint to close");
  await type(view, "echo still-writing-$((6*7))\r");
  await watch.quiet(800, 15_000);
  if (!(await rows()).some((row) => row.includes("still-writing-42")))
    throw new Error("The terminal lost its input after closing the hint");
  await capture("71-cwd-warning-dismissed.png");

  // --- An existing directory: no hint -------------------------------------------------------------------------
  const tmp = await create("Tmp", "/tmp");
  if (tmp.warnings !== undefined) throw new Error(`Tmp has warnings: ${JSON.stringify(tmp.warnings)}`);
  await open(tmp);
  await sleep(500);
  if (await evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(HINT)}))`))
    throw new Error("A session in an existing directory shows a hint");
  log("cwd scenes done");
}
