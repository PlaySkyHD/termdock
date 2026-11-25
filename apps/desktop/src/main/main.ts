// Electron main (ADR 0006): one process owns all windows, connects to the core or starts it, and serves the
// bridge. Start: `npm start -w apps/desktop` (in agent shells first `unset ELECTRON_RUN_AS_NODE`).
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { connect, defaultPipeName, resolveDataDir } from "@termdock/core";
import type { CoreClient } from "@termdock/core";
import { MAX_LAYOUT_WINDOWS } from "@termdock/protocol";
import type { LayoutWindow } from "@termdock/protocol";
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from "electron";
import { CALL_CHANNEL, EVENT_CHANNEL } from "../shared/bridge.js";
import { DesktopBridge } from "./bridge.js";
import type { WindowLayouts, WindowMoves } from "./bridge.js";
import { WindowTransfers } from "./window-transfer.js";
import {
  connectOrStartCore,
  READY_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  SLOW_REQUEST_TIMEOUTS_MS,
  withRequestTimeout,
} from "./core-connection.js";
import { coreEntryPath, startDetachedCore } from "./core-process.js";
import { CoreSupervisor } from "./core-supervisor.js";
import type { SupervisorState } from "./core-supervisor.js";
import {
  createDesktopLogger,
  flushWithin,
  helpMenuTemplate,
  openLogFolder,
  removeAfterFlush,
} from "./diagnostics.js";
import { LayoutCoordinator } from "./layout-coordinator.js";
import { decideQuit, QuitFlow } from "./quit-flow.js";
import type { DecideDeps } from "./quit-flow.js";
import { QuitPrompt } from "./quit-prompt.js";
import {
  acquireScreenshotLock,
  cleanStaleSockets,
  describeError,
  isolatedCore,
  nodeLockFs,
  QuietWatch,
  releaseScreenshotLock,
  SCENE_GROUPS,
  SCREENSHOT_LOCK_NAME,
  screenshotDir,
  screenshotScenes,
  screenshotProfileDir,
  settleWithin,
  staleProfileDirs,
  stopIsolatedCore,
  wslSocketDeps,
} from "./screenshot.js";
import type { IsolatedCore, SceneGroup } from "./screenshot.js";
import { runScenario } from "./screenshot-scenario.js";
import { runSmokeTest, smokeTestDataDir, smokeTestRequested, windowsShellCheck } from "./smoke-test.js";
import { createElectronUpdater } from "./electron-updater-port.js";
import { lazyUpdater, ManualUpdater, UpdateService } from "./update-service.js";
import type { UpdaterPort } from "./update-service.js";
import { updateChecksAllowed } from "../shared/update-decision.js";
import { APP_USER_MODEL_ID, appUserDataDir } from "./app-identity.js";
import type { ScenarioControl } from "./screenshot-scenario.js";
import { boundsAtPointer, fitBounds, screenshotOrigin, windowAtPoint } from "./window-geometry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(here, "..", "preload", "preload.cjs");
const RENDERER = path.join(here, "..", "renderer", "index.html");
/** Upper bound of a whole screenshot run, including the start of the core and WSL. */
const SCREENSHOT_TIMEOUT_MS = 480_000;
/** Title bar of a Windows frame at 100 %, when no window is open to measure it (#68). */
const DEFAULT_TITLE_BAR = 31;
/** Longest wait for the last `layout.save` when the app quits. */
const QUIT_SAVE_TIMEOUT_MS = 3_000;
/** Longest wait for the log file before the app exits. */
const LOG_FLUSH_TIMEOUT_MS = 1_000;
/** Upper bound of `--smoke-test` until the first answer: the core start plus `core.status` (reconcile). */
const SMOKE_TIMEOUT_MS = 90_000;
/** Longest wait of `--smoke-test` for its Windows shell to end (#65); it ends at once when the package works. */
const SMOKE_SHELL_TIMEOUT_MS = 15_000;

// Stderr only until the data directory is known (a screenshot run uses its own); then `desktop.log` as well.
let logger = createDesktopLogger(undefined);
const log = (text: string): void => logger.error(text);

// One Electron profile (and single-instance lock) for the repo and the installed app (ADR 0007); the screenshot
// and check modes below replace it with their own. The installed app gets its AppUserModelID for one taskbar icon.
app.setPath("userData", appUserDataDir(app.getPath("appData")));
if (app.isPackaged) app.setAppUserModelId(APP_USER_MODEL_ID);

let shotDir: string | undefined;
let shotScenes: readonly SceneGroup[] = SCENE_GROUPS;
/** Exit code of a run that stops on its arguments before anything starts. */
let badArguments: number | undefined;
try {
  shotDir = screenshotDir(process.argv);
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  badArguments = 2;
}
if (shotDir !== undefined) {
  try {
    shotScenes = screenshotScenes(process.argv);
  } catch (error) {
    // Checked before the isolated core starts: a typo in the groups must not cost a run.
    log(error instanceof Error ? error.message : String(error));
    shotDir = undefined;
    badArguments = 1;
  }
}

// The screenshot run gets its own core and its own Electron profile before anything else happens, so it can
// neither reach the productive core nor hand itself over to a running app as a second instance.
let shotTemp: string | undefined;
let isolated: IsolatedCore | undefined;
let staleSocketCleanup: Promise<unknown> | undefined;
/** How long the end of a screenshot run waits for the cleanup of stale tmux sockets. */
const STALE_SOCKET_WAIT_MS = 30_000;
/** The machine-wide lock of screenshot runs (#144), taken in `main()` before the core starts. */
const screenshotLockPath = path.join(tmpdir(), SCREENSHOT_LOCK_NAME);
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
  // tmux servers of aborted runs (sockets of ended processes); never rejects, `finish()` waits for it.
  staleSocketCleanup = cleanStaleSockets(process.pid, { ...wslSocketDeps(), isAlive, log });
}

// The check mode of the built app (ADR 0007) is isolated the same way: own pipe, tmux socket and Electron
// profile, the data folder from TERMDOCK_DATA_DIR (never the productive one), no window.
let smokeDataDir: string | undefined;
if (badArguments === undefined && smokeTestRequested(process.argv)) {
  try {
    if (shotDir !== undefined) throw new Error("--smoke-test and --screenshot exclude each other");
    smokeDataDir = smokeTestDataDir(process.env);
    isolated = isolatedCore(smokeDataDir, process.pid, randomBytes(4).toString("hex"));
    app.setPath("userData", path.join(smokeDataDir, "electron-profile"));
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    smokeDataDir = undefined;
    badArguments = 2;
  }
}
const pipePath = isolated?.pipePath ?? defaultPipeName();
/** Where `termdock.db` and `logs/` lie: the isolated one of a screenshot run, else as the core resolves it. */
const dataDir: string | undefined = shotTemp ?? smokeDataDir ?? safeDataDir();
logger = createDesktopLogger(dataDir);

function safeDataDir(): string | undefined {
  try {
    return resolveDataDir();
  } catch {
    return undefined;
  }
}

if (badArguments !== undefined) {
  // Without a directory the run would fall back to the productive core; stop before anything starts.
  app.exit(badArguments);
} else if (smokeDataDir !== undefined) {
  void smokeTest();
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
  // Screenshot runs on this machine take turns (#144): they fight over GPU and focus. The wait comes before the
  // core starts and before the run's own time limit (`runScreenshot`).
  if (shotDir !== undefined) {
    let locked = false;
    try {
      locked = await acquireScreenshotLock({
        lockPath: screenshotLockPath,
        ownPid: process.pid,
        fs: nodeLockFs,
        isAlive,
        now: () => Date.now(),
        sleep: (ms) => sleep(ms),
        log,
      });
    } catch (error) {
      log(`screenshot lock: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!locked) {
      await settleWithin(staleSocketCleanup, STALE_SOCKET_WAIT_MS);
      await cleanTemp();
      await flushWithin(logger, LOG_FLUSH_TIMEOUT_MS);
      app.exit(1);
      return;
    }
  }
  let corePid: number | undefined;
  // The screenshot run holds a restart here to capture "Core startet neu …" (#130); otherwise always open.
  let restartHold: Promise<void> | undefined;
  // Set once the bridge exists; the supervisor tells the windows about restarts through it (#130).
  let restartNotes: { last: SupervisorState; bridge?: DesktopBridge } = { last: "connecting" };
  // Connects or starts the core, at the app start and after the connection ended (#130).
  const supervisor = new CoreSupervisor<CoreClient>({
    connect: async () => {
      await restartHold;
      return (
        await connectOrStartCore({
          connect: () => connect(pipePath, { clientKind: "desktop", requestTimeoutMs: READY_TIMEOUT_MS }),
          startCore: () => {
            corePid = startDetachedCore({
              execPath: process.execPath,
              entry: coreEntryPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }),
              // The core always gets the pipe this app connects to.
              env: { ...process.env, ...isolated?.env, TERMDOCK_PIPE: pipePath },
              onError: (error) => log(`core process: ${error.message}`),
            });
          },
          sleep: (ms) => sleep(ms),
          now: () => Date.now(),
        })
      ).client;
    },
    now: () => Date.now(),
    sleep: (ms) => sleep(ms),
    onState: (state) => {
      const { last, bridge: notes } = restartNotes;
      restartNotes = { ...restartNotes, last: state };
      // The button after the limit: the windows show the restart again (a lost connection says it itself).
      if (last === "failed" && state === "restarting") notes?.coreRestarting();
      if (last !== "restarting") return;
      if (state === "connected") notes?.coreRestarted();
      else if (state === "failed") notes?.coreRestartFailed();
    },
    log,
  });
  try {
    await supervisor.start();
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
      await settleWithin(staleSocketCleanup, STALE_SOCKET_WAIT_MS);
      await cleanTemp();
      releaseScreenshotLock(screenshotLockPath, process.pid, nodeLockFs);
    }
    await flushWithin(logger, LOG_FLUSH_TIMEOUT_MS);
    app.exit(1);
    return;
  }

  // The supervisor's port stays the same object across restarts of the core (#130).
  const port = withRequestTimeout(supervisor.port, REQUEST_TIMEOUT_MS, SLOW_REQUEST_TIMEOUTS_MS);
  // The layout of all windows (#29): the renderers report their parts, this process adds the geometry and saves.
  // A `let` so the screenshot run can start over with a fresh one, like a restart of the app.
  const newCoordinator = (): LayoutCoordinator => new LayoutCoordinator({ core: port, log });
  let coordinator = newCoordinator();
  const layouts: WindowLayouts = {
    windowOf: (windowId) => coordinator.windowOf(windowId),
    report: (windowId, part) => coordinator.report(windowId, part),
  };
  // The quit dialog (#60) is a view of a window: the prompt sends the question there and takes the answer back.
  const quitPrompt: QuitPrompt = new QuitPrompt((windowId, event): boolean => bridge.sendTo(windowId, event));
  // Moves of tabs and panes between windows (#68); the coordinator needs the bridge, so the bridge reaches it late.
  const moves: WindowMoves = {
    hover: (windowId, item, at) => transfers.hover(windowId, item, at),
    hoverEnd: (windowId) => transfers.hoverEnd(windowId),
    drop: (windowId, item, at, whole) => transfers.drop(windowId, item, at, whole),
    attached: (windowId, transferId, views) => transfers.attached(windowId, transferId, views),
    ready: (windowId) => transfers.ready(windowId),
    coreClosed: () => transfers.coreClosed(),
  };
  // Auto-update (#136): electron-updater only in the installed app, loaded at the first check; the screenshot run
  // offers updates by hand and installs nothing; from the repo there is no update.
  const manualUpdater = new ManualUpdater();
  const updater: UpdaterPort | undefined = updateChecksAllowed({
    packaged: app.isPackaged,
    mode: shotDir === undefined ? "app" : "screenshot",
  })
    ? lazyUpdater(() => createElectronUpdater(logger.withSource("updater")))
    : shotDir === undefined
      ? undefined
      : manualUpdater;
  const updates =
    updater &&
    new UpdateService({
      updater,
      readSettings: () =>
        port.request("settings.get", {}).then(
          (reply) => reply.result.settings,
          () => undefined,
        ),
      broadcast: (event) => bridge.broadcast(event),
      // The screenshot run only counts the install; the app saves, releases the core and runs the installer.
      releaseAndInstall: (install) => {
        if (shotDir === undefined) return quitFlow.installUpdate(install);
        return install();
      },
      timers: { setTimeout, clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) },
      log,
    });
  const bridge: DesktopBridge = new DesktopBridge(port, layouts, quitPrompt, supervisor, updates, moves);
  restartNotes = { ...restartNotes, bridge };
  /** Windows by `webContents` id, and their ids in the order of the last focus (the window under a drag, #68). */
  const windowsById = new Map<number, BrowserWindow>();
  const focusOrder: number[] = [];
  const liveWindow = (windowId: number): BrowserWindow | undefined => {
    const win = windowsById.get(windowId);
    return win && !win.isDestroyed() ? win : undefined;
  };
  /** Height of the frame above the client area (title bar); all windows of the app share their frame. */
  const titleBarOf = (win: BrowserWindow | undefined): number => {
    if (!win) return DEFAULT_TITLE_BAR;
    return Math.max(0, win.getContentBounds().y - win.getBounds().y);
  };
  /** Bounds with the tab bar under the screen point, inside the work area of the screen under it (#68). */
  const atPointer = (
    point: { x: number; y: number },
    size: { width: number; height: number },
    frame?: BrowserWindow,
  ) =>
    boundsAtPointer(
      point,
      size,
      screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).workArea,
      titleBarOf(frame ?? [...windowsById.values()].find((each) => !each.isDestroyed())),
    );
  const transfers: WindowTransfers = new WindowTransfers({
    toScreen: (windowId, point) => {
      const bounds = liveWindow(windowId)?.getContentBounds();
      return bounds && { x: bounds.x + point.x, y: bounds.y + point.y };
    },
    toClient: (windowId, point) => {
      const bounds = liveWindow(windowId)?.getContentBounds();
      return bounds && { x: point.x - bounds.x, y: point.y - bounds.y };
    },
    windowAt: (point) =>
      windowAtPoint(
        point,
        [...windowsById]
          .filter(([, win]) => !win.isDestroyed() && win.isVisible() && !win.isMinimized())
          .map(([id, win]) => ({ id, bounds: win.getBounds() })),
        focusOrder,
      ),
    openWindowAt: (point) => createWindow(undefined, undefined, undefined, point)?.webContents.id,
    moveWindowTo: (windowId, point) => {
      const win = liveWindow(windowId);
      if (!win) return;
      if (win.isMaximized()) win.unmaximize();
      const { x, y, width, height } = atPointer(point, win.getBounds(), win);
      win.setBounds({ x, y, width, height });
      win.focus();
    },
    closeWindow: (windowId) => liveWindow(windowId)?.close(),
    layoutOf: (windowId) => coordinator.windowOf(windowId),
    send: (windowId, event) => bridge.sendTo(windowId, event),
    sessionOf: (windowId, viewId) => bridge.sessionOf(windowId, viewId),
    isWriter: (windowId, viewId) => bridge.isWriter(windowId, viewId),
    claimWriter: (windowId, viewId) => bridge.claimWriterFor(windowId, viewId),
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    newId: () => randomUUID(),
    log,
  });
  ipcMain.handle(CALL_CHANNEL, (event, raw: unknown) => bridge.call(event.sender.id, raw));

  // Windows that close while the app quits stay in the layout; so does the last one. In the screenshot run the
  // scenario can ask to forget them.
  let quitting = false;
  let forgetOnClose = false;

  /** Every open window stays in the layout with its current geometry (quit, end of the Windows session). */
  const retainAll = (): void => {
    quitting = true;
    // The quit is decided: a core that ends from here on (logoff, crash during the save) is not restarted (#130).
    supervisor.stop();
    for (const win of BrowserWindow.getAllWindows()) {
      const id = win.webContents.id;
      coordinator.setGeometry(id, { bounds: win.getNormalBounds(), maximized: win.isMaximized() });
      coordinator.closeWindow(id, { keep: true });
    }
  };

  /** What the quit decision needs of the core and of the windows (#60); the logic is in `quit-flow.ts`. */
  const decideDeps = (target?: BrowserWindow): DecideDeps => {
    const failed = (what: string) => (error: unknown) => {
      log(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    };
    return {
      listSessions: () =>
        port.request("session.list", {}).then((reply) => reply.result.sessions, failed("session.list")),
      getSettings: () =>
        port.request("settings.get", {}).then((reply) => reply.result.settings, failed("settings.get")),
      saveSettings: async (patch) => void (await port.request("settings.set", { settings: patch })),
      ask: async (activeSessions, windowsSessions) => {
        const win = target ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (!win) return undefined;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        return quitPrompt.ask(win.webContents.id, activeSessions, windowsSessions);
      },
      log,
    };
  };

  // The quit of the app (#60): decision, dialog, last layout save, end of the sessions. Closing the UI keeps the
  // sessions (ADR 0001); only "Sessions beenden" (dialog or stored choice) ends them, after the layout is saved.
  const quitFlow = new QuitFlow({
    decide: (reason) => decideQuit(decideDeps(), reason),
    retainAll,
    flush: () => Promise.race([coordinator.flush(), sleep(QUIT_SAVE_TIMEOUT_MS)]).then(() => undefined),
    // A quit never restarts the core (#130), also not when it ends on the shutdown.
    shutdownCore: async () => {
      supervisor.stop({ stopSessions: true });
      await port.request("core.shutdown", { stopSessions: true });
    },
    // Before an update (#136): the core ends, its tmux sessions and the WSL keepalive stay (ADR 0001).
    // `retainAll` stopped the supervisor already; stopping again keeps it so if the order ever changes.
    releaseCore: async () => {
      supervisor.stop();
      await port.request("core.shutdown", { stopSessions: false });
    },
    // No update while the core restarts or the restarts gave up (#130): the shutdown would reach nobody.
    coreConnected: () => !supervisor.disconnected(),
    relaunch: () => app.relaunch(),
    closeClient: () => supervisor.close(),
    quit: () => app.quit(),
    log,
  });

  /** `at`: a window for a tab or pane dropped beside every window opens with its tab bar under the pointer (#68). */
  const createWindow = (
    width = 1000,
    height = 640,
    restored?: LayoutWindow,
    at?: { x: number; y: number },
  ): BrowserWindow | undefined => {
    // The layout document holds at most this many windows, windows that stay in it included; a further one could
    // never be saved.
    if (coordinator.size() >= MAX_LAYOUT_WINDOWS) {
      log(`at most ${MAX_LAYOUT_WINDOWS} windows`);
      return undefined;
    }
    // A saved position that no screen shows any more would open a window nobody can reach.
    const wanted = restored?.bounds ?? (at && atPointer(at, { width, height }));
    const fitted =
      wanted &&
      fitBounds(
        wanted,
        screen.getAllDisplays().map((display) => display.workArea),
        screen.getPrimaryDisplay().workArea,
      );
    // Screenshot windows open off the primary screen, the user may be working there (TERMDOCK_SCREENSHOT_DISPLAY).
    const shotOrigin =
      shotDir !== undefined && !fitted
        ? screenshotOrigin(
            screen.getAllDisplays().map((display) => ({
              workArea: display.workArea,
              primary: display.id === screen.getPrimaryDisplay().id,
            })),
            process.env.TERMDOCK_SCREENSHOT_DISPLAY,
          )
        : undefined;
    if (shotOrigin) log(`screenshot window at ${shotOrigin.x},${shotOrigin.y}`);
    const win = new BrowserWindow({
      ...(fitted ?? shotOrigin ?? {}),
      width: fitted?.width ?? width,
      height: fitted?.height ?? height,
      backgroundColor: "#1e1e1e",
      title: "TermDock",
      autoHideMenuBar: true,
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    const contents = win.webContents;
    const id = contents.id;
    windowsById.set(id, win);
    focusOrder.unshift(id);
    win.on("focus", () => {
      const index = focusOrder.indexOf(id);
      if (index >= 0) focusOrder.splice(index, 1);
      focusOrder.unshift(id);
    });
    bridge.addWindow({
      id,
      send: (event) => void (!contents.isDestroyed() && contents.send(EVENT_CHANNEL, event)),
    });
    // The renderer shows local content only: no navigation, no new windows.
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    // A reload (Ctrl+R) or a crashed renderer takes its views with it; the core must not keep them, a dead
    // view could hold the writer. The first load has no views yet, so detaching there is a no-op.
    contents.on("did-finish-load", () => quitPrompt.resend(id));
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        void bridge.resetWindow(id);
        quitPrompt.windowGone(id); // a reloaded page has lost the open quit dialog
        transfers.windowGone(id, true); // and its moves between windows (#68)
      }
    });
    contents.on("render-process-gone", (_event, details) => {
      log(`render-process-gone: window ${id}, reason ${details.reason}, exit code ${details.exitCode}`);
      void bridge.resetWindow(id);
      quitPrompt.windowGone(id);
      transfers.windowGone(id, true);
    });
    contents.on("destroyed", () => void bridge.removeWindow(id));
    win.on("closed", () => {
      quitPrompt.windowGone(id);
      transfers.windowGone(id);
      windowsById.delete(id);
      const index = focusOrder.indexOf(id);
      if (index >= 0) focusOrder.splice(index, 1);
      void bridge.removeWindow(id);
    });

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
    win.on("session-end", () => quitFlow.sessionEnd());
    win.on("close", (event) => {
      // Closing the last window quits the app: with running sessions the dialog decides first (#60). Other
      // windows, a quit that is already decided and the screenshot run close as before.
      if (shotDir === undefined && quitFlow.interceptClose(coordinator.openWindows() <= 1)) {
        event.preventDefault();
        return;
      }
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
          // The key is the renderer's (key map, #64), so it also works in the terminal; the menu only shows it.
          {
            label: "Einstellungen …",
            accelerator: "CmdOrCtrl+,",
            registerAccelerator: false,
            click: () => {
              const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
              if (win) bridge.sendTo(win.webContents.id, { kind: "openSettings" });
            },
          },
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
      // "Log-Ordner öffnen": the folder with core.log and desktop.log (spec diagnostics).
      helpMenuTemplate(() => {
        if (dataDir !== undefined)
          void openLogFolder(dataDir, { openPath: (folder) => shell.openPath(folder), log });
      }),
    ]),
  );

  if (shotDir !== undefined) {
    // The scenario closes and reopens windows itself; that must not end the app.
    app.on("window-all-closed", () => {});
    await runScreenshot(shotDir, shotScenes, supervisor, bridge, {
      createWindow: (width, height) => {
        const win = createWindow(width, height);
        if (!win) throw new Error("Too many windows");
        return win;
      },
      allWindows: () => BrowserWindow.getAllWindows(),
      closeAllWindows,
      // Like a restart of the UI: save, drop all state of this process's layout, read it back from the core.
      restartUi: async () => {
        await closeAllWindows(false);
        await coordinator.flush();
        coordinator = newCoordinator();
        return openStartWindows();
      },
      flushLayout: () => coordinator.flush(),
      decideQuit: (win) => decideQuit(decideDeps(win), "user"),
      // The restart scenes (#130): end the isolated core like a crash, and hold its restart for a picture.
      killCore: () => {
        if (corePid === undefined) throw new Error("The isolated core has no process id");
        process.kill(corePid);
      },
      holdCoreRestart: () => {
        let release!: () => void;
        restartHold = new Promise<void>((resolve) => (release = resolve));
        return () => {
          restartHold = undefined;
          release();
        };
      },
      // The update scenes (#136): a downloaded update, and how often "Jetzt neu starten" reached the updater.
      offerUpdate: (version) => manualUpdater.offer(version),
      updateInstalls: () => manualUpdater.installs,
    });
    return;
  }

  // `app.quit()` ("Beenden", Ctrl+Q) closes the windows without `window-all-closed`: `QuitFlow` holds it back once,
  // asks if sessions run, keeps the windows in the layout, saves, closes the connection, then quits for real.
  app.on("before-quit", (event) => quitFlow.beforeQuit(() => event.preventDefault()));
  // Closing the last window is intercepted in its `close` handler; this is the fallback for a window that went
  // away another way.
  app.on("window-all-closed", () => {
    supervisor.stop(); // the app quits: no restart (#130)
    quitFlow.windowsClosed();
  });
  // The last log lines (the incident before the end) are written before the process ends.
  let logFlushed = false;
  app.on("will-quit", (event) => {
    if (logFlushed) return;
    event.preventDefault();
    void flushWithin(logger, LOG_FLUSH_TIMEOUT_MS).then(() => {
      logFlushed = true;
      app.quit();
    });
  });
  windows.open = () => void createWindow();
  await openStartWindows();
  for (; windows.queued > 0; windows.queued -= 1) createWindow();
  updates?.start();
}

/** `--smoke-test` (ADR 0007): start the isolated core, `hello` and `core.status`, shut it down, exit 0 or 1. */
async function smokeTest(): Promise<void> {
  // Whatever throws, the process must end: a check that hangs would block the CI job until its timeout.
  let code: 0 | 1 = 1;
  try {
    code = await smokeTestRun();
  } catch (error) {
    log(`smoke test failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  } finally {
    await flushWithin(logger, LOG_FLUSH_TIMEOUT_MS);
    app.exit(code);
  }
}

async function smokeTestRun(): Promise<0 | 1> {
  await app.whenReady();
  let corePid: number | undefined;
  return runSmokeTest({
    connectOrStart: () =>
      connectOrStartCore({
        connect: () => connect(pipePath, { clientKind: "desktop", requestTimeoutMs: READY_TIMEOUT_MS }),
        startCore: () => {
          corePid = startDetachedCore({
            execPath: process.execPath,
            entry: coreEntryPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }),
            env: { ...process.env, ...isolated?.env, TERMDOCK_PIPE: pipePath },
            onError: (error) => log(`core process: ${error.message}`),
          });
        },
        sleep: (ms) => sleep(ms),
        now: () => Date.now(),
      }),
    stopCore: () =>
      stopIsolatedCore(corePid, {
        connect: () =>
          connect(pipePath, { clientKind: "desktop", connectTimeoutMs: 2_000, requestTimeoutMs: 15_000 }),
        kill: (pid) => process.kill(pid),
        isAlive: (pid) => isAlive(pid),
        sleep: (ms) => sleep(ms),
      }),
    coreAlive: () => corePid !== undefined && isAlive(corePid),
    // node-pty with the bundled ConPTY from the package (#65); needs no WSL, so it runs in CI as well.
    checkWindowsShell: (client) =>
      windowsShellCheck(client, {
        timeoutMs: SMOKE_SHELL_TIMEOUT_MS,
        sleep: (ms) => sleep(ms),
        now: () => Date.now(),
      }),
    log,
    timeoutMs: SMOKE_TIMEOUT_MS,
  });
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
  groups: readonly SceneGroup[],
  supervisor: CoreSupervisor<CoreClient>,
  bridge: DesktopBridge,
  control: ScenarioControl,
) {
  // The supervisor's port: the scenes may restart the core (#130).
  const core = supervisor.port;
  const watch = new QuietWatch();
  core.on("session.output", () => watch.saw());
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
      // No restart from here on (#130); the shutdown ends the core on purpose.
      supervisor.stop({ stopSessions: true });
      // Ends every session of this core (tmux kill-session on the run's own socket) and the core itself.
      await core.request("core.shutdown", { stopSessions: true }).catch((error: unknown) => {
        log(`core.shutdown: ${error instanceof Error ? error.message : String(error)}`);
        exitCode = 1;
      });
      await supervisor.close();
      await settleWithin(staleSocketCleanup, STALE_SOCKET_WAIT_MS);
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      await cleanTemp();
      releaseScreenshotLock(screenshotLockPath, process.pid, nodeLockFs);
      app.exit(exitCode);
    })());

  try {
    const tmuxSocket = isolated?.env.TERMDOCK_TMUX_SOCKET;
    if (tmuxSocket === undefined) throw new Error("The screenshot run has no isolated core");
    // A failed group is repeated once (#127); the lines `retry <group>: <error>` also go into the summary.
    const retried: string[] = [];
    const scenarioLog = (text: string): void => {
      if (text.startsWith("retry ")) retried.push(text);
      log(text);
    };
    try {
      await runScenario({ dir, bridge, watch, log: scenarioLog, tmuxSocket, core, ...control }, groups);
    } finally {
      log(
        retried.length === 0
          ? "screenshot run: no retries"
          : `screenshot run: retries\n  ${retried.join("\n  ")}`,
      );
    }
  } catch (error) {
    log(`screenshot failed: ${describeError(error, true)}`);
    exitCode = 1;
  }
  await finish();
}

/** Flushes the log first (it lives in the temp directory), then removes the directory; no log line after that. */
async function cleanTemp(): Promise<void> {
  const dir = shotTemp;
  if (dir === undefined) return;
  await removeAfterFlush(logger, LOG_FLUSH_TIMEOUT_MS, () => {
    try {
      // The core may still hold its database for a moment after the shutdown answer.
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      // Not through the logger: its write would create the folder again.
      process.stderr.write(
        `termdock-desktop: could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  });
}
