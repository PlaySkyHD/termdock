// Scenes of the screenshot mode for the explorer panel (#202): a WSL session after `cd` into a folder with a few files,
// a folder opened in the tree, the panel following a `cd` and the keys (focus, arrows, Escape back to the terminal), a
// Windows shell (cmd) after `cd` into a folder, the panel hidden by its key and its width dragged (both checked in the
// saved layout), a folder that is gone (error) and a session that ended. Any other outcome ends the run with an error
// (exit code 1). Folders live under `/tmp/termdock-shot-<nonce>` in the distro and `C:\Users\Public\termdock-shot-<nonce>`
// (no user name in a path), both removed at the end. Needs Electron, WSL and the isolated core; no unit test (the pieces
// are tested: tree, keys, target, texts, store).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { LayoutWindow, SessionInfo } from "@termdock/protocol";
import type { ScenarioDeps } from "./screenshot-scenario.js";
import { pageDriver } from "./screenshot-page.js";
import { NEUTRAL_PROMPT } from "./screenshot-prompt.js";

const sessionSelector = (name: string): string => `[data-session-name=${JSON.stringify(name)}]`;
const PANEL = ".explorer";
const row = (entryPath: string): string => `${PANEL} [data-path=${JSON.stringify(entryPath)}]`;
const ctrlShift: Array<"shift" | "control"> = ["control", "shift"];

export async function explorerScenes(deps: ScenarioDeps): Promise<void> {
  const { dir, bridge, core, createWindow, flushLayout, log } = deps;
  mkdirSync(dir, { recursive: true });
  const nonce = `${process.pid}-${randomBytes(3).toString("hex")}`;
  const linuxDir = `/tmp/termdock-shot-${nonce}`;
  const windowsBase = path.join(process.env["PUBLIC"] ?? "C:\\Users\\Public", `termdock-shot-${nonce}`);
  let distro: string | undefined;
  try {
    const win = createWindow(1200, 700);
    const windowId = win.webContents.id;
    // Windows of earlier scenes lie below; a covered window stops painting.
    win.webContents.setBackgroundThrottling(false);
    win.show();
    win.moveTop();
    win.focus();
    const { evaluate, waitFor, capture, click, key, center, dragTo, mouse } = pageDriver(win, dir);
    await waitFor(`document.querySelector('.app') && !document.querySelector('.app--loading')`, "the window");
    const exists = (selector: string): string => `document.querySelector(${JSON.stringify(selector)})`;
    /** The state of the panel and the path of its header, for messages. */
    const panelState = (): Promise<string> =>
      evaluate<string>(
        `(() => { const p = document.querySelector('${PANEL}'); return p ? p.dataset.explorerState + ' ' + p.querySelector('[data-explorer-path]').dataset.explorerPath : 'no panel'; })()`,
      );
    /** Waits for the state and the folder of the header; `prefix` takes a folder that starts with `folder`. */
    const waitPanel = async (state: string, folder: string, what: string, prefix = false): Promise<void> => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const now = await panelState();
        if (prefix ? now.startsWith(`${state} ${folder}`) : now === `${state} ${folder}`) return;
        if (Date.now() > deadline) {
          const { sessions } = (await core.request("session.list", {})).result;
          const known = sessions.map((each) => `${each.name}: ${each.state} ${each.currentCwd ?? "-"}`);
          throw new Error(
            `Timed out waiting for ${what}; the panel shows: ${now}; the core has ${known.join(", ")}`,
          );
        }
        await sleep(150);
      }
    };

    const create = async (name: string, launch: SessionInfo["launch"]): Promise<SessionInfo> => {
      const created = await bridge.call(windowId, { method: "createSession", params: { name, launch } });
      if (!created.ok) throw new Error(`createSession ${name}: ${created.error.message}`);
      return created.value as SessionInfo;
    };
    const open = async (session: SessionInfo): Promise<string> => {
      await click(sessionSelector(session.name));
      const deadline = Date.now() + 60_000;
      for (;;) {
        const viewId = bridge
          .viewsOf(windowId)
          .find((view) => bridge.sessionOf(windowId, view) === session.id);
        if (viewId !== undefined) return viewId;
        if (Date.now() > deadline) throw new Error(`${session.name} was not attached`);
        await sleep(100);
      }
    };
    const type = async (viewId: string, data: string): Promise<void> => {
      const result = await bridge.call(windowId, { method: "input", viewId, data });
      if (!result.ok) throw new Error(`input: ${result.error.message}`);
    };
    const savedWindow = async (): Promise<LayoutWindow | undefined> => {
      await flushLayout();
      const { result } = await core.request("layout.get", {});
      return result.layout?.windows.find((each) => each.tabs.length > 0);
    };

    // --- A WSL session after cd into a folder with files; the panel shows by its key -------------------------
    const project = await create("Projekt", { backend: "wsl", cwd: "/tmp" });
    distro = project.launch.distro;
    if (distro === undefined) throw new Error("The core did not pin a distro for Projekt");
    const shell = await open(project);
    await sleep(800); // snapshot and first fit
    await type(shell, NEUTRAL_PROMPT);
    await sleep(600);
    await type(
      shell,
      `mkdir -p ${linuxDir}/src/lib ${linuxDir}/docs && printf 'hallo\\n' > ${linuxDir}/README.md && ` +
        `printf 'x\\n' > ${linuxDir}/src/main.ts && touch ${linuxDir}/notes.txt ${linuxDir}/src/util.ts && ` +
        `cd ${linuxDir} && clear\r`,
    );
    if (await evaluate<boolean>(`Boolean(${exists(PANEL)})`))
      throw new Error("A new window of the screenshot run shows the explorer before its key");
    await key("X", ctrlShift);
    await waitPanel("listed", linuxDir, "the folder of the shell in the explorer");
    await waitFor(exists(row(`${linuxDir}/README.md`)), "the files of the folder in the explorer");
    const order = await evaluate<string[]>(
      `[...document.querySelectorAll('${PANEL} [role="treeitem"]')].map((item) => item.dataset.path.split('/').pop())`,
    );
    // Folders first (the order of the service), then the files.
    if (
      JSON.stringify(order.slice(0, 2)) !== JSON.stringify(["docs", "src"]) ||
      JSON.stringify(order.slice(2).sort()) !== JSON.stringify(["README.md", "notes.txt"])
    )
      throw new Error(`The explorer does not list folders first: ${JSON.stringify(order)}`);
    await capture("72-explorer-wsl.png", { visible: row(`${linuxDir}/README.md`) });

    // --- A folder opens in the tree --------------------------------------------------------------------------
    await click(row(`${linuxDir}/src`));
    await waitFor(exists(row(`${linuxDir}/src/main.ts`)), "the files of src in the tree");
    await capture("73-explorer-expanded.png", { visible: row(`${linuxDir}/src/main.ts`) });

    // --- Keys: into the panel, arrows, Escape back; no key reaches the shell ----------------------------------
    await key("O", ctrlShift);
    await waitFor(
      `document.activeElement && document.activeElement.closest('${PANEL}')`,
      "the focus in the explorer",
    );
    await key("Home");
    await key("Down"); // src
    await key("Left"); // closes src
    await waitFor(`!${exists(row(`${linuxDir}/src/main.ts`))}`, "src to close by key");
    await key("Right"); // opens it again
    await key("Right"); // into src: lib
    const selected = await evaluate<string>(
      `document.querySelector('${PANEL} [aria-selected="true"]')?.dataset.path ?? ''`,
    );
    if (selected !== `${linuxDir}/src/lib`) throw new Error(`The keys selected ${selected}, not src/lib`);
    await key("Escape");
    await waitFor(
      `document.activeElement && document.activeElement.classList.contains('xterm-helper-textarea')`,
      "the terminal to take the focus back",
    );

    // --- The panel follows a cd and drops the open folders -------------------------------------------------
    await type(shell, "cd src && clear\r");
    await waitPanel("listed", `${linuxDir}/src`, "the explorer to follow cd src");
    await waitFor(exists(row(`${linuxDir}/src/main.ts`)), "the files of src at the top of the tree");
    if (await evaluate<boolean>(`Boolean(${exists(`${PANEL} [aria-expanded="true"]`)})`))
      throw new Error("An open folder of the old directory stayed open after cd");
    await type(shell, "cd .. && clear\r");
    await waitPanel("listed", linuxDir, "the explorer to follow cd ..");

    // --- A Windows shell (cmd) after cd into a folder: the directory of its prompt hook ---------------------
    mkdirSync(path.join(windowsBase, "Berichte"), { recursive: true });
    writeFileSync(path.join(windowsBase, "Berichte", "november.txt"), "x\r\n");
    writeFileSync(path.join(windowsBase, "liesmich.txt"), "x\r\n");
    // Not "Windows cmd": the group `windows` leaves a session of that name, and the sidebar would open that one.
    const cmd = await create("Berichte cmd", {
      backend: "windows",
      shell: "cmd",
      cwd: path.dirname(windowsBase),
    });
    const cmdView = await open(cmd);
    await waitPanel("listed", path.dirname(windowsBase), "the explorer at the start folder of cmd");
    await type(cmdView, `cd ${path.basename(windowsBase)}\rcls\r`);
    await waitPanel("listed", windowsBase, "the explorer to follow cd in cmd");
    await waitFor(exists(row(path.join(windowsBase, "liesmich.txt"))), "the files of the Windows folder");
    await click(row(path.join(windowsBase, "Berichte")));
    await waitFor(exists(row(path.join(windowsBase, "Berichte", "november.txt"))), "the files of Berichte");
    await capture("74-explorer-windows.png", {
      visible: row(path.join(windowsBase, "Berichte", "november.txt")),
    });
    // cmd leaves the folder, so it can be removed at the end (Windows keeps a shell's directory in use).
    await type(cmdView, "cd ..\r");
    await waitPanel("listed", path.dirname(windowsBase), "the explorer to follow cd .. in cmd");

    // --- The width by the divider and the hidden panel, both in the saved layout -----------------------------
    await click(sessionSelector(project.name));
    await waitPanel("listed", linuxDir, "the explorer back at the WSL session");
    const before = await evaluate<number>(`document.querySelector('${PANEL}').getBoundingClientRect().width`);
    const grip = await center(`${PANEL} [data-explorer-divider]`);
    await dragTo(grip, { x: grip.x - 80, y: grip.y });
    mouse("mouseUp", grip.x - 80, grip.y);
    await sleep(300);
    const after = await evaluate<number>(`document.querySelector('${PANEL}').getBoundingClientRect().width`);
    if (Math.abs(after - before - 80) > 3)
      throw new Error(`The divider made the explorer ${before} → ${after} px`);
    const wide = await savedWindow();
    if (wide?.explorerWidth === undefined || Math.abs(wide.explorerWidth - after) > 3)
      throw new Error(`The layout keeps width ${wide?.explorerWidth}, the panel is ${after}`);
    await key("X", ctrlShift);
    await waitFor(`!${exists(PANEL)}`, "the explorer to hide");
    await capture("75-explorer-hidden.png", { visible: '.pane[data-tab-active="true"] .terminal-pane' });
    if ((await savedWindow())?.explorerVisible !== false)
      throw new Error("The layout does not keep the hidden explorer");
    await key("X", ctrlShift);
    await waitPanel("listed", linuxDir, "the explorer to show again");
    // Showing the panel leaves the keys in the terminal, also after the tree had the focus once (Ctrl+Shift+O above).
    await sleep(300);
    if (
      !(await evaluate<boolean>(
        `document.activeElement?.classList.contains('xterm-helper-textarea') === true`,
      ))
    )
      throw new Error("Showing the explorer took the focus from the terminal");

    const message = (): Promise<string> =>
      evaluate<string>(`document.querySelector('${PANEL} [data-explorer-message]').textContent`);

    // --- A folder the file service refuses: a backslash in a Linux name has no place in \\wsl.localhost ------
    const odd = `${linuxDir}/a\\b`;
    await type(shell, `mkdir 'a\\b' && cd 'a\\b' && clear\r`);
    await waitPanel("error", odd, "the error of the service for a refused folder");
    if ((await message()) !== "Dieser Ort kann nicht angezeigt werden")
      throw new Error(`The explorer names the error as: ${await message()}`);
    await capture("76-explorer-error.png", { visible: `${PANEL} [data-explorer-message]` });

    // --- The folder of the shell is gone: the core knows no directory ----------------------------------------
    await type(shell, `cd ${linuxDir} && mkdir weg && cd weg && rmdir ../weg && clear\r`);
    await waitPanel("unknownCwd", "", "the explorer of a shell whose folder is gone");
    await capture("77-explorer-unknown.png", { visible: `${PANEL} [data-explorer-message]` });

    // --- The session ended: no directory --------------------------------------------------------------------
    await type(shell, "cd /tmp && exit\r");
    await waitPanel("notRunning", "", "the explorer of an ended session");
    await capture("78-explorer-not-running.png", { visible: `${PANEL} [data-explorer-message]` });
    log("explorer scenes done");
  } finally {
    // Best effort: a failure here must not hide the failure of a scene.
    try {
      rmSync(windowsBase, { recursive: true, force: true });
    } catch (error) {
      log(
        `explorer: the Windows folder of the scenes stays: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (distro !== undefined) await removeLinuxDir(distro, linuxDir);
  }
}

/** Removes the folder of the scenes in the distro (argument array, no shell). */
function removeLinuxDir(distro: string, folder: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      "wsl.exe",
      ["-d", distro, "--cd", "/tmp", "--exec", "rm", "-rf", "--", folder],
      { timeout: 15_000 },
      () => resolve(),
    );
  });
}
