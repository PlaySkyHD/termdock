// The scenes of the screenshot mode (`--screenshot <dir>`, ADR 0006): sessions in every state, several tabs, a
// collapsed sidebar, an empty window with the form, a notice tab, a reader, and split panes (#27: 2 to 4 panes,
// `stty size` around a dragged divider, a clipped reader, vim around a change of size). It drives the renderer like a user
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

/** Upper bound of one `wsl.exe` call of the scenario (a cold distro start included). */
const WSL_TIMEOUT_MS = 30_000;

/** Runs `wsl.exe` with an argument array and a timeout; a failure names the call. Returns stdout. */
async function wsl(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run("wsl.exe", args, {
      timeout: WSL_TIMEOUT_MS,
      env: { ...process.env, WSL_UTF8: "1" },
    });
    return stdout;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`wsl.exe ${args.join(" ")} failed or took longer than ${WSL_TIMEOUT_MS} ms: ${reason}`);
  }
}

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
  await wsl([
    ...["-d", distro, "--cd", "~", "--exec", "tmux", "-L", tmuxSocket],
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

  await splitScenes({ dir, bridge, watch, createWindow, log, tmuxSocket }, capture, session("Notes"));
}

// --- Split panes (#27) ------------------------------------------------------------------------------

/** What the renderer shows of one pane: its role, the text of its rows and where the cursor is drawn. */
interface PaneShot {
  id: string;
  active: boolean;
  role: string | null;
  hint: string | null;
  rows: string[];
  cursor: { x: number; y: number } | null;
  width: number;
  height: number;
}

/** Reads the panes of the visible tab from the DOM (xterm.js draws rows as DOM elements). */
const PANES_EXPRESSION = `[...document.querySelectorAll('.tab-panel[data-active="true"] .pane')].map((pane) => {
  const rows = [...pane.querySelectorAll('.xterm-rows > div')];
  let cursor = null;
  rows.forEach((row, y) => {
    const mark = row.querySelector('.xterm-cursor');
    if (!mark) return;
    let x = 0;
    for (const node of row.childNodes) { if (node === mark) break; x += (node.textContent ?? '').length; }
    cursor = { x, y };
  });
  const box = pane.getBoundingClientRect();
  return {
    id: pane.dataset.paneId,
    active: pane.dataset.activePane === 'true',
    role: pane.querySelector('[data-role]')?.dataset.role ?? null,
    hint: pane.querySelector('[data-hint]')?.textContent ?? null,
    rows: rows.map((row) => (row.textContent ?? '').replace(/\\u00a0/g, ' ')),
    cursor,
    width: box.width,
    height: box.height,
  };
})`;

async function splitScenes(
  { bridge, watch, createWindow, log, tmuxSocket }: ScenarioDeps,
  capture: (win: BrowserWindow, name: string) => Promise<void>,
  /** Detached so far; it joins a split as a third session. */
  notes: SessionInfo,
): Promise<void> {
  const win = createWindow(1280, 800);
  const windowId = win.webContents.id;
  const evaluate = <T>(expression: string): Promise<T> =>
    win.webContents.executeJavaScript(expression, true) as Promise<T>;
  const waitFor = async (expression: string, what: string, timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await evaluate<boolean>(`Boolean(${expression})`).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  const panes = (): Promise<PaneShot[]> => evaluate<PaneShot[]>(PANES_EXPRESSION);
  const viewsOf = (sessionId: string): string[] =>
    bridge.viewsOf(windowId).filter((viewId) => bridge.sessionOf(windowId, viewId) === sessionId);
  const waitForViews = async (sessionId: string, count: number): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (viewsOf(sessionId).length < count) {
      if (Date.now() > deadline) {
        // The picture of the failed state helps more than the message alone.
        await capture(win, "failed-waiting-for-views.png").catch(() => {});
        throw new Error(`Timed out waiting for ${count} views of ${sessionId}`);
      }
      await sleep(100);
    }
    await sleep(1_000); // snapshot and first fit
  };

  const sessions = new Map<string, SessionInfo>([["Notes", notes]]);
  for (const name of ["Shell", "Editor", "Misc", "Vim"]) {
    const result = await bridge.call(windowId, {
      method: "createSession",
      params: { name, launch: { backend: "wsl", cwd: "/" } },
    });
    if (!result.ok) throw new Error(`createSession ${name}: ${result.error.message}`);
    sessions.set(name, result.value as SessionInfo);
    log(`created ${name}`);
  }
  const session = (name: string): SessionInfo => {
    const found = sessions.get(name);
    if (!found) throw new Error(`no session ${name}`);
    return found;
  };
  await waitFor(`document.querySelectorAll('[data-session-name]').length === 9`, "nine sessions");

  /** Input goes through the window's writing view of the session; readers are refused by the core. */
  const type = async (name: string, data: string): Promise<void> => {
    for (const viewId of viewsOf(session(name).id)) {
      const result = await bridge.call(windowId, { method: "input", viewId, data });
      if (result.ok) return;
    }
    throw new Error(`${name} has no writing view in this window`);
  };
  const typeCommand = async (name: string, command: string, clear = true): Promise<void> => {
    if (clear) {
      await type(name, "PS1='$ '; clear\r");
      await sleep(600);
    }
    await type(name, `${command}\r`);
    // A timeout fails the run: a picture of a half-drawn screen must not pass.
    await watch.quiet(800, 15_000);
    await sleep(300);
  };

  /** Clicks with real mouse events of the window (so pointer capture and focus behave as for a user). */
  const mouse = (type: "mouseDown" | "mouseUp" | "mouseMove", x: number, y: number): void =>
    win.webContents.sendInputEvent({
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
      // A move between down and up is a drag: the left button is held.
      ...(type === "mouseMove" ? { modifiers: ["leftbuttondown" as const] } : {}),
    });
  const center = (selector: string): Promise<{ x: number; y: number }> =>
    evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
  const clickAt = async (selector: string): Promise<void> => {
    await waitFor(`document.querySelector(${JSON.stringify(selector)})`, selector);
    const { x, y } = await center(selector);
    mouse("mouseDown", x, y);
    mouse("mouseUp", x, y);
    await sleep(300);
  };
  const paneSelector = (id: string): string => `.tab-panel[data-active="true"] [data-pane-id="${id}"]`;
  const button = async (action: string): Promise<void> => {
    const selector = `[data-action="${action}"]`;
    await waitFor(`document.querySelector('${selector}:not(:disabled)')`, selector);
    await evaluate(`document.querySelector('${selector}').click()`);
  };
  /** Sidebar click with modifier keys, like a user with Shift or Ctrl held down. */
  const sidebarClick = async (name: string, modifier: "" | "shiftKey" = ""): Promise<void> => {
    const selector = sessionSelector(name);
    await waitFor(`document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(
      new MouseEvent('click', { bubbles: true ${modifier ? `, ${modifier}: true` : ""} }))`);
  };
  /** Drags the divider of the visible tab to `share` of the tab's width (row) or height (column). */
  const dragDivider = async (index: number, share: number): Promise<void> => {
    const box = await evaluate<{
      x: number;
      y: number;
      row: boolean;
      left: number;
      top: number;
      w: number;
      h: number;
    }>(
      `(() => {
        const divider = document.querySelectorAll('.tab-panel[data-active="true"] .divider')[${index}];
        const area = divider.parentElement.getBoundingClientRect();
        const box = divider.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2, row: divider.classList.contains('divider--row'),
          left: area.left, top: area.top, w: area.width, h: area.height };
      })()`,
    );
    const to = box.row ? { x: box.left + share * box.w, y: box.y } : { x: box.x, y: box.top + share * box.h };
    mouse("mouseDown", box.x, box.y);
    for (let step = 1; step <= 10; step++) {
      mouse("mouseMove", box.x + ((to.x - box.x) * step) / 10, box.y + ((to.y - box.y) * step) / 10);
      await sleep(30);
    }
    mouse("mouseUp", to.x, to.y);
    await sleep(800); // the layout delay, the resize in tmux and the redraw
  };
  const tmuxInfo = async (name: string): Promise<{ x: number; y: number; cols: number; rows: number }> => {
    const { distro } = session(name).launch;
    if (distro === undefined) throw new Error("The created session has no distro");
    const stdout = await wsl([
      ...["-d", distro, "--cd", "~", "--exec", "tmux", "-L", tmuxSocket, "display-message", "-p"],
      ...["-t", `=td-${session(name).id}:`, "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}"],
    ]);
    const [x, y, cols, rows] = stdout.trim().split(" ").map(Number);
    return { x: x!, y: y!, cols: cols!, rows: rows! };
  };
  /** Last `stty size` answer (`rows cols`) on the pane's screen. */
  const sttyOf = (pane: PaneShot): string => {
    const answers = pane.rows.map((row) => row.trim()).filter((row) => /^\d+ \d+$/.test(row));
    const last = answers.at(-1);
    if (last === undefined) throw new Error(`no stty answer in pane ${pane.id}`);
    return last;
  };
  /** Compares the cursor drawn in pane `index` with tmux; xterm.js draws it a frame late, so it retries briefly. */
  const expectCursor = async (name: string, index: number, what: string): Promise<void> => {
    const tmux = await tmuxInfo(name);
    let at = "none";
    for (let attempt = 0; attempt < 20; attempt++) {
      const pane = (await panes())[index];
      at = pane?.cursor ? `${pane.cursor.x},${pane.cursor.y}` : "none";
      if (pane?.cursor?.x === tmux.x && pane.cursor.y === tmux.y) break;
      await sleep(250);
    }
    log(`${what}: xterm cursor ${at}, tmux cursor ${tmux.x},${tmux.y} (${tmux.cols}x${tmux.rows})`);
    if (at !== `${tmux.x},${tmux.y}`) {
      const classes = await evaluate<string[]>(
        `[...document.querySelectorAll('.tab-panel[data-active="true"] .pane')[${index}].querySelectorAll('.xterm-rows [class*="cursor"]')].map((e) => e.className)`,
      );
      throw new Error(
        `${what}: cursor at ${at}, tmux has ${tmux.x},${tmux.y}; cursor elements ${JSON.stringify(classes)}`,
      );
    }
  };

  // --- The same session in two panes: the new one reads, clipped to its pane ------------------------
  await sidebarClick("Shell");
  await waitForViews(session("Shell").id, 1);
  await typeCommand("Shell", "ls --color /; stty size");
  await button("split-row");
  await waitForViews(session("Shell").id, 2);
  await dragDivider(0, 0.68);
  let shot = await panes();
  const [writer, reader] = shot;
  if (writer?.role !== "writer" || reader?.role !== "reader" || !reader.hint)
    throw new Error(
      `expected writer and clipped reader, got ${JSON.stringify(shot.map((p) => [p.role, p.hint]))}`,
    );
  // The reader shows the writer's screen row for row; output twice would shift its rows (#34).
  const differing = writer.rows.findIndex((row, index) => row !== reader.rows[index]);
  if (differing >= 0 || writer.rows.length !== reader.rows.length)
    throw new Error(
      `reader and writer rows differ at row ${differing}: ${JSON.stringify(writer.rows[differing])} vs ${JSON.stringify(reader.rows[differing])}`,
    );
  // The second view of the same session reads, so the writing pane stays active.
  if (!writer.active)
    throw new Error("the writing pane must stay active after splitting with the same session");
  log(`reader hint: ${reader.hint}`);
  await capture(win, "06-same-session-reader-clipped.png");

  // Selecting text in the reader makes it active but does not take the writer.
  const from = await center(paneSelector(reader.id));
  mouse("mouseDown", from.x - 100, from.y - 300);
  for (let step = 1; step <= 5; step++) mouse("mouseMove", from.x - 100 + step * 20, from.y - 300);
  mouse("mouseUp", from.x, from.y - 300);
  await sleep(800);
  shot = await panes();
  if (shot[1]?.role !== "reader" || !shot[1].active)
    throw new Error(
      `selecting text must not take the writer: ${JSON.stringify(shot.map((p) => [p.role, p.active]))}`,
    );

  // A click into the reading pane takes the writer; the other pane reads and is dimmed around the terminal.
  await clickAt(paneSelector(reader.id));
  await waitFor(
    `document.querySelector('${paneSelector(reader.id)} [data-role="writer"]') && document.querySelector('${paneSelector(writer.id)} [data-role="reader"]')`,
    "the writer to move to the clicked pane",
  );
  await sleep(800);
  await typeCommand("Shell", "stty size", false);
  await capture(win, "07-same-session-writer-claimed.png");

  // --- Two panes with two sessions: stty size follows the divider -------------------------------
  await sidebarClick("Editor");
  await waitForViews(session("Editor").id, 1);
  await typeCommand("Editor", "stty size");
  await sidebarClick("Misc", "shiftKey");
  await waitForViews(session("Misc").id, 1);
  await typeCommand("Misc", "stty size");
  await typeCommand("Editor", "stty size", false); // the split made it narrower
  shot = await panes();
  const before = shot.map(sttyOf);
  log(`stty before: ${before.join(" | ")}`);
  await capture(win, "08-two-panes-stty-before.png");

  await dragDivider(0, 0.7);
  await typeCommand("Editor", "stty size", false);
  await typeCommand("Misc", "stty size", false);
  shot = await panes();
  const after = shot.map(sttyOf);
  log(`stty after: ${after.join(" | ")}`);
  const cols = (answer: string | undefined): number => Number(answer?.split(" ")[1]);
  if (!(cols(after[0]) > cols(before[0]) && cols(after[1]) < cols(before[1])))
    throw new Error(`stty size did not follow the divider: ${before.join(",")} -> ${after.join(",")}`);
  const editorTmux = await tmuxInfo("Editor");
  if (cols(after[0]) !== editorTmux.cols)
    throw new Error(`stty ${after[0]} but tmux ${editorTmux.cols} cols`);
  await capture(win, "09-two-panes-stty-after.png");

  // --- Three and four panes ----------------------------------------------------------------------
  const [editorPane] = shot;
  if (!editorPane) throw new Error("no Editor pane");
  await clickAt(paneSelector(editorPane.id));
  await sidebarClick("Notes", "shiftKey");
  await waitForViews(session("Notes").id, 1);
  await waitFor(
    `document.querySelectorAll('.tab-panel[data-active="true"] .pane').length === 3`,
    "three panes",
  );
  // The short prompt also here: the default one names user and host.
  await typeCommand("Notes", "stty size");
  await capture(win, "10-three-panes.png");

  await clickAt(paneSelector(editorPane.id));
  await button("split-column");
  await waitForViews(session("Editor").id, 2);
  await waitFor(
    `document.querySelector('[data-action="split-row"]:disabled')`,
    "splitting to be locked at 4",
  );
  await capture(win, "11-four-panes.png");

  // --- vim before and after a change of size, and the cursor of a view that attaches while it runs ------
  await sidebarClick("Vim");
  await waitForViews(session("Vim").id, 1);
  await typeCommand("Vim", "seq 1 300 | vim -u NONE -c 'set number ruler laststatus=2' -");
  await type("Vim", "150Gww");
  await watch.quiet(800, 15_000);
  await expectCursor("Vim", 0, "vim before");
  await capture(win, "12-vim-before.png");

  await button("split-row");
  await waitForViews(session("Vim").id, 2);
  await sleep(800);
  // The new view attached while vim runs: its snapshot puts the cursor where tmux has it (#32).
  await expectCursor("Vim", 1, "vim in the attached reader");
  await expectCursor("Vim", 0, "vim after the split");
  await capture(win, "13-vim-after-split.png");

  await dragDivider(0, 0.72);
  await watch.quiet(800, 15_000).catch(() => {}); // vim may have nothing to redraw
  await expectCursor("Vim", 0, "vim after the drag");
  await capture(win, "14-vim-after-drag.png");
}
