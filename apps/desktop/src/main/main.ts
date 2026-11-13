// Electron main (ADR 0006): one process owns all windows, connects to the core or starts it, and serves the
// bridge. Start: `npm start -w apps/desktop` (in agent shells first `unset ELECTRON_RUN_AS_NODE`).
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { connect, defaultPipeName } from "@termdock/core";
import type { CoreClient } from "@termdock/core";
import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { CALL_CHANNEL, EVENT_CHANNEL } from "../shared/bridge.js";
import { DesktopBridge } from "./bridge.js";
import {
  connectOrStartCore,
  READY_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  SLOW_REQUEST_TIMEOUTS_MS,
  withRequestTimeout,
} from "./core-connection.js";
import { coreEntryPath, startDetachedCore } from "./core-process.js";
import {
  isolatedCore,
  QuietWatch,
  screenshotDir,
  screenshotProfileDir,
  stopIsolatedCore,
} from "./screenshot.js";
import type { IsolatedCore } from "./screenshot.js";
import { runScenario } from "./screenshot-scenario.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(here, "..", "preload", "preload.cjs");
const RENDERER = path.join(here, "..", "renderer", "index.html");
/** Upper bound of a whole screenshot run, including the start of the core and WSL. */
const SCREENSHOT_TIMEOUT_MS = 180_000;

const log = (text: string): void => console.error(`termdock-desktop: ${text}`);

let shotDir: string | undefined;
let badArguments = false;
try {
  shotDir = screenshotDir(process.argv);
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  badArguments = true;
}

// The screenshot run gets its own core and its own Electron profile before anything else happens, so it can
// neither reach the productive core nor hand itself over to a running app as a second instance.
let shotTemp: string | undefined;
let isolated: IsolatedCore | undefined;
if (shotDir !== undefined) {
  shotTemp = mkdtempSync(path.join(tmpdir(), "termdock-shot-"));
  isolated = isolatedCore(shotTemp, process.pid, randomBytes(4).toString("hex"));
  app.setPath("userData", screenshotProfileDir(tmpdir()));
}
const pipePath = isolated?.pipePath ?? defaultPipeName();

if (badArguments) {
  // Without a directory the run would fall back to the productive core; stop before anything starts.
  app.exit(2);
} else if (shotDir === undefined && !app.requestSingleInstanceLock()) {
  // Another app runs; it opens a window in its own main process (see "second-instance").
  app.exit(0);
} else {
  void main();
}

async function main(): Promise<void> {
  // Registered before the (up to ~65 s) wait for the core, so no second start gets lost: until the
  // connection is ready, requested windows are only counted.
  const windows: { open: (() => void) | undefined; queued: number } = { open: undefined, queued: 0 };
  if (shotDir === undefined)
    app.on("second-instance", () => (windows.open ? windows.open() : (windows.queued += 1)));

  await app.whenReady();
  let client: CoreClient;
  let corePid: number | undefined;
  try {
    ({ client } = await connectOrStartCore({
      connect: () => connect(pipePath, { clientKind: "desktop", requestTimeoutMs: READY_TIMEOUT_MS }),
      startCore: () => {
        corePid = startDetachedCore({
          execPath: process.execPath,
          entry: coreEntryPath(),
          // The core always gets the pipe this app connects to.
          env: { ...process.env, ...isolated?.env, TERMDOCK_PIPE: pipePath },
          onError: (error) => log(`core process: ${error.message}`),
        });
      },
      sleep: (ms) => sleep(ms),
      now: () => Date.now(),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(message);
    if (shotDir === undefined) {
      dialog.showErrorBox("TermDock", `Der Core ist nicht erreichbar.\n\n${message}`);
    } else {
      // The isolated core may run (and hold its database) although connecting or its first answer failed.
      const outcome = await stopIsolatedCore(corePid, {
        connect: () =>
          connect(pipePath, { clientKind: "desktop", connectTimeoutMs: 2_000, requestTimeoutMs: 15_000 }),
        kill: (pid) => process.kill(pid),
        isAlive: (pid) => isAlive(pid),
        sleep: (ms) => sleep(ms),
      });
      log(`isolated core: ${outcome}`);
      cleanTemp();
    }
    app.exit(1);
    return;
  }

  const bridge = new DesktopBridge(withRequestTimeout(client, REQUEST_TIMEOUT_MS, SLOW_REQUEST_TIMEOUTS_MS));
  ipcMain.handle(CALL_CHANNEL, (event, raw: unknown) => bridge.call(event.sender.id, raw));

  const createWindow = (width = 1000, height = 640): BrowserWindow => {
    const win = new BrowserWindow({
      width,
      height,
      backgroundColor: "#1e1e1e",
      title: "TermDock",
      autoHideMenuBar: true,
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    const contents = win.webContents;
    const id = contents.id;
    bridge.addWindow({
      id,
      send: (event) => void (!contents.isDestroyed() && contents.send(EVENT_CHANNEL, event)),
    });
    // The renderer shows local content only: no navigation, no new windows.
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    // A reload (Ctrl+R) or a crashed renderer takes its views with it; the core must not keep them, a dead
    // view could hold the writer. The first load has no views yet, so detaching there is a no-op.
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) void bridge.resetWindow(id);
    });
    contents.on("render-process-gone", () => void bridge.resetWindow(id));
    contents.on("destroyed", () => void bridge.removeWindow(id));
    win.on("closed", () => void bridge.removeWindow(id));
    void win.loadFile(RENDERER);
    return win;
  };

  // The menu replaces the default one, also in the screenshot run (key bindings of #28 hang on it).
  // "Neues Fenster" opens a window with its own tabs, like a second start.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Datei",
        submenu: [
          { label: "Neues Fenster", accelerator: "CmdOrCtrl+Shift+N", click: () => void createWindow() },
          { type: "separator" },
          { label: "Beenden", role: "quit" },
        ],
      },
      {
        label: "Ansicht",
        submenu: [
          { label: "Neu laden", role: "reload" },
          { label: "Entwicklerwerkzeuge", role: "toggleDevTools" },
        ],
      },
    ]),
  );

  if (shotDir !== undefined) {
    await runScreenshot(shotDir, client, bridge, createWindow);
    return;
  }

  // Closing the UI keeps the sessions (ADR 0001): only the connection ends, the core keeps running.
  app.on("window-all-closed", () => void client.close().finally(() => app.quit()));
  windows.open = () => void createWindow();
  createWindow();
  for (; windows.queued > 0; windows.queued -= 1) createWindow();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Plays the scenes of `screenshot-scenario.ts`, then ends the isolated core and its sessions. */
async function runScreenshot(
  dir: string,
  client: CoreClient,
  bridge: DesktopBridge,
  createWindow: (width?: number, height?: number) => BrowserWindow,
) {
  const watch = new QuietWatch();
  client.on("session.output", () => watch.saw());
  let exitCode = 0;
  const guard = setTimeout(() => {
    log(`screenshot run took longer than ${SCREENSHOT_TIMEOUT_MS} ms`);
    exitCode = 1;
    void finish();
  }, SCREENSHOT_TIMEOUT_MS);
  let finishing: Promise<void> | undefined;
  const finish = (): Promise<void> =>
    (finishing ??= (async () => {
      clearTimeout(guard);
      // Ends every session of this core (tmux kill-session on `termdock-test`) and the core itself.
      await client.request("core.shutdown", { stopSessions: true }).catch((error: unknown) => {
        log(`core.shutdown: ${error instanceof Error ? error.message : String(error)}`);
        exitCode = 1;
      });
      await client.close();
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      cleanTemp();
      app.exit(exitCode);
    })());

  try {
    const tmuxSocket = isolated?.env.TERMDOCK_TMUX_SOCKET;
    if (tmuxSocket === undefined) throw new Error("The screenshot run has no isolated core");
    await runScenario({ dir, bridge, watch, createWindow, log, tmuxSocket });
  } catch (error) {
    log(`screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }
  await finish();
}

function cleanTemp(): void {
  if (shotTemp === undefined) return;
  try {
    // The core may still hold its database for a moment after the shutdown answer.
    rmSync(shotTemp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    log(`could not remove ${shotTemp}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
