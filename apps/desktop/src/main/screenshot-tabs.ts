// Scenes of the screenshot mode for arranging tabs and panes by drag and drop (#67, ADR 0006). The mouse is real
// (`webContents.sendInputEvent`), so pointer events, zones, rules and store all run. Besides the pictures it checks
// what must not change: a moved pane keeps its view in the bridge (no detach, no attach) and its role, and Esc
// leaves everything as it was. Needs Electron, WSL and the isolated core; no unit test (moves, zones, menus and
// store are tested).
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { SessionInfo } from "@termdock/protocol";
import { pageDriver } from "./screenshot-page.js";
import type { ScenarioDeps } from "./screenshot-scenario.js";

const tabSelector = (title: string): string => `.tab[data-tab-title=${JSON.stringify(title)}]`;
const PANES = `.pane[data-tab-active="true"]`;

export async function tabScenes(deps: ScenarioDeps): Promise<void> {
  const { dir, createWindow, bridge, log } = deps;
  mkdirSync(dir, { recursive: true });
  const win = createWindow(1100, 680);
  win.webContents.setBackgroundThrottling(false);
  win.show();
  win.moveTop();
  const windowId = win.webContents.id;
  const { evaluate, waitFor, capture, click, pointIn, mouse, dragTo, key } = pageDriver(win, dir);
  const expect = (condition: boolean, what: string): void => {
    if (!condition) throw new Error(`Tab scene failed: ${what}`);
  };

  /** The views of this window by session (the bridge knows which view shows which session). */
  const viewsBySession = (): Map<string, string[]> => {
    const views = new Map<string, string[]>();
    for (const viewId of bridge.viewsOf(windowId)) {
      const sessionId = bridge.sessionOf(windowId, viewId);
      if (sessionId !== undefined) views.set(sessionId, [...(views.get(sessionId) ?? []), viewId]);
    }
    return views;
  };
  const tabOrder = (): Promise<string[]> =>
    evaluate(`[...document.querySelectorAll('[data-tab-title]')].map((tab) => tab.dataset.tabTitle)`);
  /** Session and role of every pane of the visible tab, in tree order. */
  const visiblePanes = (): Promise<Array<{ session: string; role: string }>> =>
    evaluate(`[...document.querySelectorAll('${PANES}')].map((pane) => ({
      session: pane.dataset.sessionId,
      role: pane.querySelector('[data-role]')?.dataset.role ?? 'none',
    }))`);

  // --- Three sessions, three tabs ---------------------------------------------------------------------
  const created: SessionInfo[] = [];
  for (const name of ["Tab A", "Tab B", "Tab C"]) {
    const result = await bridge.call(windowId, {
      method: "createSession",
      params: { name, launch: { backend: "wsl", cwd: "/" } },
    });
    if (!result.ok) throw new Error(`createSession ${name}: ${result.error.message}`);
    created.push(result.value as SessionInfo);
  }
  const [a, b, c] = created as [SessionInfo, SessionInfo, SessionInfo];
  for (const session of created) {
    await click(`[data-session-name=${JSON.stringify(session.name)}]`);
    await waitFor(
      `document.querySelector(${JSON.stringify(tabSelector(session.name))})`,
      `${session.name}'s tab`,
    );
    const deadline = Date.now() + 60_000;
    while (!viewsBySession().has(session.id)) {
      if (Date.now() > deadline) throw new Error(`${session.name} was not attached`);
      await sleep(100);
    }
  }
  await waitFor(
    `document.querySelectorAll('${PANES} [data-role="writer"]').length === 1`,
    "the writer of Tab C",
  );
  await sleep(800);
  const viewsBefore = viewsBySession();
  const viewOf = (session: SessionInfo): string => viewsBefore.get(session.id)?.[0] ?? "none";
  const sameViews = (sessions: readonly SessionInfo[]): boolean => {
    const now = viewsBySession();
    return sessions.every((each) => now.get(each.id)?.includes(viewOf(each)) === true);
  };

  // --- Reorder: Tab C onto the left half of Tab A -------------------------------------------------------
  await dragTo(await pointIn(`${tabSelector("Tab C")} .tab__main`), await pointIn(tabSelector("Tab A"), 0.2));
  await waitFor(
    `document.querySelector('${tabSelector("Tab A")}.tab--drop-before')`,
    "the insertion mark before A",
  );
  await capture("40-tab-reorder-drag.png");
  const reorderAt = await pointIn(tabSelector("Tab A"), 0.2);
  mouse("mouseUp", reorderAt.x, reorderAt.y);
  await waitFor(`!document.body.classList.contains('is-dragging')`, "the end of the drag");
  const order = await tabOrder();
  log(`tabs after reordering: ${order.join(", ")}`);
  expect(order.join() === "Tab C,Tab A,Tab B", `the order is ${order.join()}, not C, A, B`);
  expect(sameViews(created), "reordering attached a view again");
  await capture("41-tabs-reordered.png");

  // --- Esc aborts a tab dragged over a pane --------------------------------------------------------------
  await click(`${tabSelector("Tab B")} .tab__main`);
  await waitFor(`document.querySelector('${tabSelector("Tab B")}.tab--active')`, "Tab B in front");
  const right = await pointIn(PANES, 0.92, 0.5);
  await dragTo(await pointIn(`${tabSelector("Tab A")} .tab__main`), right);
  await waitFor(`document.querySelector('[data-drop-overlay="right"]')`, "the zones over the pane of B");
  await key("Escape");
  await waitFor(`!document.querySelector('.pane-drop')`, "the zones to go after Esc");
  mouse("mouseUp", right.x, right.y);
  await sleep(500);
  expect((await tabOrder()).length === 3, "Esc changed the tabs");
  expect(
    (await evaluate<boolean>(
      `document.querySelector('${tabSelector("Tab B")}').classList.contains('tab--active')`,
    )) === true,
    "the release after Esc switched the tab",
  );

  // --- Tab A into the right half of B's pane --------------------------------------------------------------
  await dragTo(await pointIn(`${tabSelector("Tab A")} .tab__main`), right);
  await waitFor(
    `document.querySelector('[data-drop-overlay="right"] .pane-drop__zone--over[data-zone="right"]')`,
    "the right zone",
  );
  await capture("42-drop-zones.png");
  mouse("mouseUp", right.x, right.y);
  await waitFor(`document.querySelectorAll('${PANES}').length === 2`, "two panes in B");
  await sleep(800);
  let panes = await visiblePanes();
  log(`B after the drop: ${JSON.stringify(panes)}`);
  expect((await tabOrder()).join() === "Tab C,Tab B", "Tab A did not close after its drop");
  expect(panes[0]?.session === b.id && panes[1]?.session === a.id, "A is not right of B");
  expect(
    panes.every((pane) => pane.role === "writer"),
    "a moved view lost its role",
  );
  expect(sameViews(created), "the drop attached a view again");
  await capture("43-drop-split.png");

  // --- A session of the sidebar onto the top of the pane of A: a new view, which reads -----------------------
  const top = await pointIn(`${PANES}[data-session-id="${a.id}"]`, 0.5, 0.08);
  await dragTo(await pointIn(`[data-session-name="Tab B"]`), top);
  await waitFor(`document.querySelector('[data-drop-overlay="top"]')`, "the top zone of A");
  mouse("mouseUp", top.x, top.y);
  await waitFor(`document.querySelectorAll('${PANES}').length === 3`, "three panes in B");
  await waitFor(`document.querySelector('${PANES} [data-role="reader"]')`, "the new view as a reader");
  panes = await visiblePanes();
  log(`B after the sidebar drop: ${JSON.stringify(panes)}`);
  expect(
    panes
      .filter((pane) => pane.session === b.id)
      .map((pane) => pane.role)
      .sort()
      .join() === "reader,writer",
    "B is not shown once writing and once reading",
  );
  expect(sameViews(created), "the sidebar drop attached the other views again");
  await capture("44-session-onto-pane.png");

  // --- The pane of A out onto the tab bar: a tab of its own at the end ------------------------------------------
  const grip = `${PANES}[data-session-id="${a.id}"] .pane-grip`;
  await waitFor(`document.querySelector('${grip}')`, "the grip of A's pane");
  const barEnd = await evaluate<{ x: number; y: number }>(`(() => {
    const bar = document.querySelector('.tab-bar__tabs').getBoundingClientRect();
    const last = [...document.querySelectorAll('.tab')].at(-1).getBoundingClientRect();
    return { x: (last.right + bar.right) / 2, y: bar.top + bar.height / 2 };
  })()`);
  await dragTo(await pointIn(grip), barEnd);
  await waitFor(`document.querySelector('.tab-bar__tabs--drop-end')`, "the insertion mark at the end");
  mouse("mouseUp", barEnd.x, barEnd.y);
  await waitFor(`document.querySelectorAll('[data-tab-title]').length === 3`, "the pulled out tab");
  await sleep(800);
  expect((await tabOrder()).join() === "Tab C,Tab B,Tab A", `the order is ${(await tabOrder()).join()}`);
  panes = await visiblePanes();
  expect(
    panes.length === 1 && panes[0]?.session === a.id && panes[0].role === "writer",
    "A is not alone in front, writing",
  );
  expect(sameViews(created), "pulling out attached a view again");
  await capture("45-pane-pulled-out.png");

  // --- Keyboard: Ctrl+Shift+PageUp moves the active tab left -------------------------------------------------
  await key("PageUp", ["control", "shift"], 500);
  expect(
    (await tabOrder()).join() === "Tab C,Tab A,Tab B",
    `Ctrl+Shift+PageUp left ${(await tabOrder()).join()}`,
  );
  expect(
    (await evaluate<boolean>(
      `document.querySelector('${tabSelector("Tab A")}').classList.contains('tab--active')`,
    )) === true,
    "the moved tab is not active",
  );
  log(`tab scenes done (views kept: ${created.map((each) => each.name).join(", ")}, C ${viewOf(c)})`);
}
