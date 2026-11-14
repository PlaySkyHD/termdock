// Electron main (ADR 0006): one process owns all windows, connects to the core or starts it, and serves the
// bridge. Start: `npm start -w apps/desktop` (in agent shells first `unset ELECTRON_RUN_AS_NODE`).
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { connect, defaultPipeName } from "@termdock/core";
import type { CoreClient } from "@termdock/core";
import { MAX_LAYOUT_WINDOWS } from "@termdock/protocol";
import type { LayoutWindow } from "@termdock/protocol";
import { app, BrowserWindow, dialog, ipcMain, Menu, screen } from "electron";
import { CALL_CHANNEL, EVENT_CHANNEL } from "../shared/bridge.js";
import { DesktopBridge } from "./bridge.js";
import type { WindowLayouts } from "./bridge.js";
import {
  connectOrStartCore,
  READY_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  SLOW_REQUEST_TIMEOUTS_MS,
  withRequestTimeout,
} from "./core-connection.js";
import { coreEntryPath, startDetachedCore } from "./core-process.js";
import { LayoutCoordinator } from "./layout-coordinator.js";
import {
  isolatedCore,
  QuietWatch,
  screenshotDir,
  screenshotProfileDir,
  staleProfileDirs,
  stopIsolatedCore,
} from "./screenshot.js";
import type { IsolatedCore } from "./screenshot.js";
import { runScenario } from "./screenshot-scenario.js";
import type { ScenarioControl } from "./screenshot-scenario.js";
import { fitBounds } from "./window-geometry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(here, "..", "preload", "preload.cjs");
const RENDERER = path.join(here, "..", "renderer", "index.html");
/** Upper bound of a whole screenshot run, including the start of the core and WSL. */
const SCREENSHOT_TIMEOUT_MS = 480_000;
/** Longest wait for the last `layout.save` when the app quits. */
const QUIT_SAVE_TIMEOUT_MS = 3_000;

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
  app.setPath("userData", screenshotProfileDir(tmpdir(), process.pid));
  // Profiles of ended runs are free again. Errors (for example locked files) are ignored; the next run tries again.
  for (const dir of staleProfileDirs(tmpdir(), readdirSync(tmpdir()), process.pid, isAlive)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
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

  const port = withRequestTimeout(client, REQUEST_TIMEOUT_MS, SLOW_REQUEST_TIMEOUTS_MS);
  // The layout of all windows (#29): the renderers report their parts, this process adds the geometry and saves.
  // A `let` so the screenshot run can start over with a fresh one, like a restart of the app.
  const newCoordinator = (): LayoutCoordinator => new LayoutCoordinator({ core: port, log });
  let coordinator = newCoordinator();
  const layouts: WindowLayouts = {
    windowOf: (windowId) => coordinator.windowOf(windowId),
    report: (windowId, part) => coordinator.report(windowId, part),
  };
  const bridge = new DesktopBridge(port, layouts);
  ipcMain.handle(CALL_CHANNEL, (event, raw: unknown) => bridge.call(event.sender.id, raw));

  // Windows that close while the app quits stay in the layout; so does the last one. In the screenshot run the
  // scenario can ask to forget them.
  let quitting = false;
  let forgetOnClose = false;

  /** Every open window stays in the layout with its current geometry (quit, end of the Windows session). */
  const retainAll = (): void => {
    quitting = true;
    for (const win of BrowserWindow.getAllWindows()) {
      const id = win.webContents.id;
      coordinator.setGeometry(id, { bounds: win.getNormalBounds(), maximized: win.isMaximized() });
      coordinator.closeWindow(id, { keep: true });
    }
  };

  /** The last save, then the end of the connection; once, however often it is asked for. */
  let finishing: Promise<void> | undefined;
  const finishLayoutAndClient = (): Promise<void> =>
    (finishing ??= (async () => {
      await Promise.race([coordinator.flush(), sleep(QUIT_SAVE_TIMEOUT_MS)]);
      await client.close().catch(() => {});
    })());

  const createWindow = (width = 1000, height = 640, restored?: LayoutWindow): BrowserWindow | undefined => {
    // The layout document holds at most this many windows, windows that stay in it included; a further one could
    // never be saved.
    if (coordinator.size() >= MAX_LAYOUT_WINDOWS) {
      log(`at most ${MAX_LAYOUT_WINDOWS} windows`);
      return undefined;
    }
    // A saved position that no screen shows any more would open a window nobody can reach.
    const fitted =
      restored?.bounds &&
      fitBounds(
        restored.bounds,
        screen.getAllDisplays().map((display) => display.workArea),
        screen.getPrimaryDisplay().workArea,
      );
    const win = new BrowserWindow({
      ...(fitted ?? {}),
      width: fitted?.width ?? width,
      height: fitted?.height ?? height,
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

    coordinator.addWindow(
      id,
      restored ? { ...restored, ...(fitted ? { bounds: fitted } : {}) } : { id: randomUUID(), tabs: [] },
      { restored: restored !== undefined },
    );
    const geometry = (): void =>
      coordinator.setGeometry(id, { bounds: win.getNormalBounds(), maximized: win.isMaximized() });
    if (restored?.maximized) win.maximize();
    else if (!restored) geometry();
    win.on("resize", geometry);
    win.on("move", geometry);
    win.on("maximize", geometry);
    win.on("unmaximize", geometry);
    // Windows logoff or shutdown: the windows get no `before-quit`, the system ends the session. Treat it like a
    // quit: all windows stay in the layout, and what is not saved yet is saved now.
    win.on("session-end", () => {
      retainAll();
      void finishLayoutAndClient();
    });
    win.on("close", () => {
      geometry();
      coordinator.closeWindow(id, { keep: !forgetOnClose && (quitting || coordinator.openWindows() <= 1) });
    });
    void win.loadFile(RENDERER);
    return win;
  };

  /** Opens the windows of the stored layout; a window in its start state without one (also when it is unusable). */
  const openStartWindows = async (): Promise<BrowserWindow[]> => {
    const saved = (await coordinator.load()).slice(0, MAX_LAYOUT_WINDOWS);
    const opened = saved.map((window) => createWindow(undefined, undefined, window));
    const list = opened.filter((win): win is BrowserWindow => win !== undefined);
    return list.length > 0 ? list : [createWindow()].filter((win) => win !== undefined);
  };

  /** Closes all windows and waits until they are gone (`forget`: they also leave the layout). */
  const closeAllWindows = async (forget: boolean): Promise<void> => {
    forgetOnClose = forget;
    quitting = !forget;
    for (const win of BrowserWindow.getAllWindows()) win.close();
    while (BrowserWindow.getAllWindows().length > 0) await sleep(50);
    quitting = false;
    forgetOnClose = false;
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
    // The scenario closes and reopens windows itself; that must not end the app.
    app.on("window-all-closed", () => {});
    await runScreenshot(shotDir, client, bridge, {
      createWindow: (width, height) => {
        const win = createWindow(width, height);
        if (!win) throw new Error("Too many windows");
        return win;
      },
      closeAllWindows,
      // Like a restart of the UI: save, drop all state of this process's layout, read it back from the core.
      restartUi: async () => {
        await closeAllWindows(false);
        await coordinator.flush();
        coordinator = newCoordinator();
        return openStartWindows();
      },
      flushLayout: () => coordinator.flush(),
    });
    return;
  }

  // Closing the UI keeps the sessions (ADR 0001): only the connection ends, the core keeps running. The layout is
  // saved first, but never waits for long.
  let quitReady = false;
  const quitAfterSave = (): void =>
    void finishLayoutAndClient().finally(() => {
      quitReady = true;
      app.quit();
    });
  // `app.quit()` ("Beenden", Ctrl+Q) closes the windows without `window-all-closed`: stop it once, keep the
  // windows in the layout, save and close the connection, then quit for real.
  app.on("before-quit", (event) => {
    retainAll();
    if (quitReady) return;
    event.preventDefault();
    quitAfterSave();
  });
  app.on("window-all-closed", quitAfterSave);
  windows.open = () => void createWindow();
  await openStartWindows();
  for (; windows.queued > 0; windows.queued -= 1) createWindow();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user or runs elevated.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Plays the scenes of `screenshot-scenario.ts`, then ends the isolated core and its sessions. */
async function runScreenshot(
  dir: string,
  client: CoreClient,
  bridge: DesktopBridge,
  control: ScenarioControl,
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
      // Ends every session of this core (tmux kill-session on the run's own socket) and the core itself.
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
    await runScenario({ dir, bridge, watch, log, tmuxSocket, core: client, ...control });
  } catch (error) {
    log(`screenshot failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
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
