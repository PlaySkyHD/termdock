// Scenes of the screenshot mode for moving tabs between windows (#68, ADR 0006). Two windows side by side; the mouse
// is real (`webContents.sendInputEvent` into the source window, with points beyond its edge, as Chromium delivers
// them while the button is held), so pointer events, the main process, the drop targets of the other window and the
// handover of the views all run. Besides the pictures it checks what must hold: the moved view writes in its new
// window, the source has given its old view back, a last tab closes its window, and the layout survives a restart
// of the UI. Needs Electron, WSL and the isolated core; no unit test (models, coordinator and bridge are tested).
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { SessionInfo } from "@termdock/protocol";
import type { BrowserWindow } from "electron";
import { pageDriver } from "./screenshot-page.js";
import { NEUTRAL_PROMPT } from "./screenshot-prompt.js";
import type { Point } from "./screenshot-page.js";
import type { ScenarioDeps } from "./screenshot-scenario.js";

const tabSelector = (title: string): string => `.tab[data-tab-title=${JSON.stringify(title)}]`;
const PANES = `.pane[data-tab-active="true"]`;
const loaded = `document.querySelector('.app') && !document.querySelector('.app--loading')`;

export async function dragScenes(deps: ScenarioDeps): Promise<void> {
  const { dir, createWindow, allWindows, bridge, core, restartUi, log } = deps;
  mkdirSync(dir, { recursive: true });
  const open = (): BrowserWindow => {
    const win = createWindow(820, 560);
    // Windows of earlier scenes lie below; a covered window stops painting.
    win.webContents.setBackgroundThrottling(false);
    win.show();
    return win;
  };
  const source = open();
  const target = open();
  // Side by side, relative to the first window (the run picks the monitor, screenshot-restore.ts).
  const [x = 0, y = 0] = source.getPosition();
  target.setPosition(x + 860, y);
  const sourceId = source.webContents.id;
  const targetId = target.webContents.id;
  const a = pageDriver(source, dir);
  const b = pageDriver(target, dir);
  await a.waitFor(loaded, "the source window");
  await b.waitFor(loaded, "the target window");
  const expect = (condition: boolean, what: string): void => {
    if (!condition) throw new Error(`Drag scene failed: ${what}`);
  };

  /** A point of the target window in the client coordinates of the source (both at zoom 1). */
  const inSource = (point: Point, of: BrowserWindow = target): Point => {
    const from = of.getContentBounds();
    const to = source.getContentBounds();
    return { x: from.x + point.x - to.x, y: from.y + point.y - to.y };
  };
  const viewIn = (windowId: number, sessionId: string): string | undefined =>
    bridge.viewsOf(windowId).find((view) => bridge.sessionOf(windowId, view) === sessionId);
  const attachedIn = async (windowId: number, session: SessionInfo): Promise<string> => {
    const deadline = Date.now() + 60_000;
    for (let view = viewIn(windowId, session.id); ; view = viewIn(windowId, session.id)) {
      if (view !== undefined) return view;
      if (Date.now() > deadline) throw new Error(`${session.name} was not attached in window ${windowId}`);
      await sleep(100);
    }
  };
  const writerOf = async (session: SessionInfo): Promise<string | undefined> =>
    (await core.request("session.list", {})).result.sessions.find((each) => each.id === session.id)
      ?.writerViewId;
  const tabsOf = (driver: typeof a): Promise<string[]> =>
    driver.evaluate(`[...document.querySelectorAll('[data-tab-title]')].map((tab) => tab.dataset.tabTitle)`);

  // --- Four sessions: three tabs in the source, one in the target -------------------------------------------------
  const created: SessionInfo[] = [];
  for (const name of ["Drag A", "Drag B", "Drag C", "Drag D"]) {
    const result = await bridge.call(sourceId, {
      method: "createSession",
      params: { name, launch: { backend: "wsl", cwd: "/" } },
    });
    if (!result.ok) throw new Error(`createSession ${name}: ${result.error.message}`);
    created.push(result.value as SessionInfo);
  }
  const [sa, sb, sc, sd] = created as [SessionInfo, SessionInfo, SessionInfo, SessionInfo];
  for (const session of [sa, sb, sd]) {
    await a.click(`[data-session-name=${JSON.stringify(session.name)}]`);
    await a.waitFor(
      `document.querySelector(${JSON.stringify(tabSelector(session.name))})`,
      `${session.name}'s tab`,
    );
    await attachedIn(sourceId, session);
  }
  await b.click(`[data-session-name=${JSON.stringify(sc.name)}]`);
  await attachedIn(targetId, sc);
  // Drag A in front of the source, writing.
  await a.click(`${tabSelector(sa.name)} .tab__main`);
  await a.waitFor(`document.querySelector('${PANES} [data-role="writer"]')`, "the writer of Drag A");
  await b.waitFor(`document.querySelector('${PANES} [data-role="writer"]')`, "the writer of Drag C");
  // A short prompt without user and host name: the repository is public (as the group `update`, #136).
  for (const [driver, windowId, session] of [
    [a, sourceId, sa],
    [a, sourceId, sb],
    [b, targetId, sc],
    [a, sourceId, sd],
  ] as const) {
    const viewId = await attachedIn(windowId, session);
    const input = await bridge.call(windowId, { method: "input", viewId, data: NEUTRAL_PROMPT });
    if (!input.ok) throw new Error(`input ${session.name}: ${input.error.message}`);
    await driver.waitFor(
      `[...document.querySelectorAll('.pane[data-session-id="${session.id}"] .xterm-rows > div')].some((row) => row.textContent.trim() === "$")`,
      `the short prompt of ${session.name}`,
    );
  }
  await sleep(800);
  const oldView = viewIn(sourceId, sa.id)!;
  expect((await writerOf(sa)) === oldView, "Drag A does not write in the source");

  // --- The tab Drag A over the right edge of the pane in the target ----------------------------------------------
  // Inside the right zone (the outer 30 %), with room for the ghost beside the pointer.
  const right = await b.pointIn(PANES, 0.78, 0.5);
  await a.dragTo(await a.pointIn(`${tabSelector(sa.name)} .tab__main`), inSource(right));
  // One more move: the target shows what the main process tells it.
  a.mouse("mouseMove", inSource(right).x, inSource(right).y);
  await b.waitFor(
    `document.querySelector('[data-drop-overlay="right"] .pane-drop__zone--over[data-zone="right"]')`,
    "the right zone in the target",
  );
  await b.waitFor(`document.querySelector('[data-drag-ghost]')`, "the ghost in the target");
  // The center would replace the target's view before the handover is certain: it is blocked.
  await b.waitFor(
    `document.querySelector('[data-drop-overlay="right"] .pane-drop__zone--blocked[data-zone="center"]')`,
    "the blocked center in the target",
  );
  await b.capture("46-drag-zones-other-window.png", { visible: '[data-drop-overlay="right"]' });

  mouseUp(a, inSource(right));
  await b.waitFor(`document.querySelectorAll('${PANES}').length === 2`, "two panes in the target");
  await a.waitFor(
    `!document.querySelector(${JSON.stringify(tabSelector(sa.name))})`,
    "Drag A to leave the source",
  );
  const newView = await attachedIn(targetId, sa);
  await b.waitFor(
    `document.querySelector('${PANES}[data-session-id="${sa.id}"] [data-role="writer"]')`,
    "Drag A writing in the target",
  );
  expect(viewIn(sourceId, sa.id) === undefined, "the source kept its view of Drag A");
  expect(newView !== oldView, "the target has no view of its own");
  expect((await writerOf(sa)) === newView, "the core does not name the moved view as the writer");
  expect(
    bridge.viewsOf(targetId).filter((view) => bridge.sessionOf(targetId, view) === sa.id).length === 1,
    "the target has more than one view of Drag A",
  );
  log(`moved Drag A: view ${oldView} → ${newView}, source tabs ${(await tabsOf(a)).join(", ")}`);
  await b.capture("47-drag-dropped-other-window.png", {
    visible: `${PANES}[data-session-id="${sa.id}"] [data-role="writer"]`,
  });

  // --- The tab Drag B beside every window: a new window at the pointer ------------------------------------------------
  const below = source.getContentBounds();
  const beside: Point = { x: 160, y: below.height + 60 };
  const windowsBefore = new Set(allWindows().map((win) => win.webContents.id));
  await a.dragTo(await a.pointIn(`${tabSelector(sb.name)} .tab__main`), beside);
  // The source must see a running drag before the release, otherwise the release is a click.
  await a.waitFor(`document.body.classList.contains('is-dragging')`, "the drag of Drag B in the source");
  mouseUp(a, beside);
  const deadline = Date.now() + 30_000;
  let opened: BrowserWindow | undefined;
  while (!opened) {
    opened = allWindows().find((win) => !windowsBefore.has(win.webContents.id));
    if (Date.now() > deadline) throw new Error("no window opened for Drag B");
    await sleep(100);
  }
  opened.webContents.setBackgroundThrottling(false);
  const c = pageDriver(opened, dir);
  await c.waitFor(loaded, "the new window");
  await c.waitFor(
    `document.querySelector('${PANES}[data-session-id="${sb.id}"] [data-role="writer"]')`,
    "Drag B writing in the new window",
  );
  await a.waitFor(
    `!document.querySelector(${JSON.stringify(tabSelector(sb.name))})`,
    "Drag B to leave the source",
  );
  expect(viewIn(sourceId, sb.id) === undefined, "the source kept its view of Drag B");
  const bounds = opened.getBounds();
  const pointer = { x: below.x + beside.x, y: below.y + beside.y };
  // Under the pointer; near the bottom of the screen it moves up into the work area, still covering the pointer.
  expect(
    pointer.x >= bounds.x &&
      pointer.x < bounds.x + bounds.width &&
      pointer.y >= bounds.y &&
      pointer.y < bounds.y + bounds.height,
    `the new window ${JSON.stringify(bounds)} is not at the pointer ${JSON.stringify(pointer)}`,
  );
  await c.capture("48-drag-new-window.png", {
    visible: `${PANES}[data-session-id="${sb.id}"] [data-role="writer"]`,
  });

  // --- The last tab of the source onto the tab bar of the target: the source closes --------------------------------
  const barEnd = await b.evaluate<Point>(`(() => {
    const bar = document.querySelector('.tab-bar__tabs').getBoundingClientRect();
    const last = [...document.querySelectorAll('.tab')].at(-1).getBoundingClientRect();
    return { x: (last.right + bar.right) / 2, y: bar.top + bar.height / 2 };
  })()`);
  await a.dragTo(await a.pointIn(`${tabSelector(sd.name)} .tab__main`), inSource(barEnd));
  a.mouse("mouseMove", inSource(barEnd).x, inSource(barEnd).y);
  await b.waitFor(`document.querySelector('.tab-bar__tabs--drop-end')`, "the insertion mark in the target");
  mouseUp(a, inSource(barEnd));
  const closing = Date.now() + 30_000;
  while (!source.isDestroyed()) {
    if (Date.now() > closing) throw new Error("the source window did not close after its last tab left");
    await sleep(100);
  }
  await b.waitFor(
    `document.querySelector('${PANES}[data-session-id="${sd.id}"] [data-role="writer"]')`,
    "Drag D writing in the target",
  );
  const sessions = (await core.request("session.list", {})).result.sessions;
  expect(
    created.every((each) => sessions.find((s) => s.id === each.id)?.state === "Running"),
    "a session stopped running when its tab moved",
  );
  const targetTabs = await tabsOf(b);
  log(`target tabs: ${targetTabs.join(", ")}`);

  // --- Restart of the UI: the tabs stay where they were moved ---------------------------------------------------------
  const restored = await restartUi();
  expect(restored.length === 2, `expected 2 restored windows, got ${restored.length}`);
  const drivers = restored.map((win) => {
    win.webContents.setBackgroundThrottling(false);
    return pageDriver(win, dir);
  });
  for (const driver of drivers)
    await driver.waitFor(`${loaded} && document.querySelector('.pane')`, "a restored window");
  const sessionsOf = (driver: typeof a): Promise<string[]> =>
    driver.evaluate(`[...document.querySelectorAll('.pane')].map((pane) => pane.dataset.sessionId).sort()`);
  const restoredSessions = await Promise.all(drivers.map(sessionsOf));
  log(`restored windows: ${JSON.stringify(restoredSessions)}`);
  const withC = drivers[restoredSessions.findIndex((ids) => ids.includes(sc.id))];
  expect(
    restoredSessions.some((ids) => same(ids, [sa.id, sc.id, sd.id].sort())) &&
      restoredSessions.some((ids) => same(ids, [sb.id])),
    "the restored windows do not hold the moved tabs",
  );
  await withC!.waitFor(`document.querySelector('${PANES} [data-role]')`, "the restored target");
  await withC!.capture("49-drag-layout-restored.png", { visible: PANES });
}

function mouseUp(driver: ReturnType<typeof pageDriver>, point: Point): void {
  driver.mouse("mouseUp", point.x, point.y);
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((each, index) => each === b[index]);
}
