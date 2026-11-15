// Scenes of the screenshot mode for the layout patterns while dragging (#78, ADR 0006). The mouse is real
// (`webContents.sendInputEvent`): a tab dragged to the top edge of the tab area opens the bar, its fields are named
// after the views that would land there, Esc aborts, a drop arranges the active tab, and the pane menu offers the same
// patterns by keyboard. Besides the pictures it checks that no view is attached again and every role stays. Needs
// Electron, WSL and the isolated core; no unit test (patterns, targets, menus and store are tested).
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { SessionInfo } from "@termdock/protocol";
import { pageDriver } from "./screenshot-page.js";
import type { Point } from "./screenshot-page.js";
import type { ScenarioDeps } from "./screenshot-scenario.js";

const tabSelector = (title: string): string => `.tab[data-tab-title=${JSON.stringify(title)}]`;
const PANES = `.pane[data-tab-active="true"]`;
const field = (pattern: string, slot: number): string =>
  `[data-snap-pattern="${pattern}"] [data-snap-field="${slot}"]`;

interface FieldInfo {
  session: string | null;
  moved: boolean;
  name: string;
}

export async function snapScenes(deps: ScenarioDeps): Promise<void> {
  const { dir, createWindow, bridge, log } = deps;
  mkdirSync(dir, { recursive: true });
  const win = createWindow(1200, 720);
  win.webContents.setBackgroundThrottling(false);
  win.show();
  win.moveTop();
  const windowId = win.webContents.id;
  const { evaluate, waitFor, capture, click, pointIn, mouse, dragTo, key } = pageDriver(win, dir);
  const expect = (condition: boolean, what: string): void => {
    if (!condition) throw new Error(`Snap scene failed: ${what}`);
  };

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
  /** Session, role and place (shares of the tab area, rounded) of every pane of the visible tab. */
  const visiblePanes = (): Promise<
    Array<{ session: string; role: string; x: number; y: number; w: number }>
  > =>
    evaluate(`(() => {
      const area = document.querySelector('.pane-tree').getBoundingClientRect();
      const share = (value, total) => Math.round((value / total) * 100) / 100;
      return [...document.querySelectorAll('${PANES}')].map((pane) => {
        const box = pane.getBoundingClientRect();
        return {
          session: pane.dataset.sessionId,
          role: pane.querySelector('[data-role]')?.dataset.role ?? 'none',
          x: share(box.left - area.left, area.width),
          y: share(box.top - area.top, area.height),
          w: share(box.width, area.width),
        };
      });
    })()`);
  const fieldsOf = (pattern: string): Promise<FieldInfo[]> =>
    evaluate(`[...document.querySelectorAll('[data-snap-pattern="${pattern}"] [data-snap-field]')].map((f) => ({
      session: f.dataset.snapSession ?? null,
      moved: f.dataset.snapMoved === 'true',
      name: f.textContent,
    }))`);
  const hiddenPatterns = (): Promise<string[]> =>
    evaluate(`[...document.querySelectorAll('.snap-pattern--hidden')].map((p) => p.dataset.snapPattern)`);
  /** Moves the pointer with the button held from `from` to `to` in steps. */
  const moveHeld = async (from: Point, to: Point): Promise<void> => {
    const steps = 6;
    for (let step = 1; step <= steps; step += 1) {
      mouse(
        "mouseMove",
        from.x + ((to.x - from.x) * step) / steps,
        from.y + ((to.y - from.y) * step) / steps,
      );
      await sleep(40);
    }
  };
  /** Drags the tab to the top edge of the tab area until the bar is open; returns where the pointer is. */
  const tabToBar = async (title: string): Promise<Point> => {
    const edge = await pointIn(".tab-panels", 0.5, 0);
    const strip = { x: edge.x, y: edge.y + 12 };
    await dragTo(await pointIn(`${tabSelector(title)} .tab__main`), strip);
    await waitFor(`document.querySelector('[data-snap-bar="open"]')`, "the bar of layout patterns");
    return strip;
  };

  // --- Three sessions, three tabs ---------------------------------------------------------------------
  const created: SessionInfo[] = [];
  for (const name of ["Snap A", "Snap B", "Snap C"]) {
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
  await click(`${tabSelector("Snap B")} .tab__main`);
  await waitFor(`document.querySelector('${tabSelector("Snap B")}.tab--active')`, "Snap B in front");
  await waitFor(`document.querySelectorAll('${PANES} [data-role="writer"]').length === 1`, "the writer of B");
  await sleep(800);
  const viewsBefore = viewsBySession();
  const sameViews = (): boolean => {
    const now = viewsBySession();
    return created.every((each) => {
      const before = viewsBefore.get(each.id)?.[0];
      return before !== undefined && now.get(each.id)?.includes(before) === true;
    });
  };

  // --- The bar: Tab A over the first field of "1 + 2" ------------------------------------------------------
  let at = await tabToBar("Snap A");
  expect((await hiddenPatterns()).length === 0, "a pattern is hidden for two views");
  let to = await pointIn(field("mainLeft", 0));
  await moveHeld(at, to);
  await waitFor(
    `document.querySelector('${field("mainLeft", 0)}.snap-field--over')`,
    "the field under the pointer",
  );
  const fields = await fieldsOf("mainLeft");
  log(`fields of "1 + 2" for A: ${JSON.stringify(fields)}`);
  expect(
    fields[0]?.session === a.id && fields[0].moved && fields[0].name === "Snap A",
    "A is not marked in field 1",
  );
  expect(
    fields[1]?.session === b.id && !fields[1].moved && fields[1].name === "Snap B",
    "B is not in field 2",
  );
  expect(fields[2]?.session === null && fields[2].name === "leer", "field 3 is not empty");
  await capture("50-snap-bar.png");

  // --- Esc aborts: the bar closes, nothing changes -------------------------------------------------------------
  await key("Escape");
  await waitFor(`document.querySelector('[data-snap-bar="closed"]')`, "the bar to close after Esc");
  mouse("mouseUp", to.x, to.y);
  await sleep(500);
  expect(
    (await tabOrder()).join() === "Snap A,Snap B,Snap C",
    `Esc changed the tabs: ${(await tabOrder()).join()}`,
  );
  expect((await visiblePanes()).length === 1, "Esc changed the panes of B");

  // --- Drop A on the second field of "2 nebeneinander": B left, A right, A closes as a tab ------------------------
  at = await tabToBar("Snap A");
  to = await pointIn(field("columns", 1));
  await moveHeld(at, to);
  await waitFor(
    `document.querySelector('${field("columns", 1)}.snap-field--over')`,
    "the second field of columns",
  );
  mouse("mouseUp", to.x, to.y);
  await waitFor(`document.querySelectorAll('${PANES}').length === 2`, "two panes after the drop");
  await sleep(800);
  let panes = await visiblePanes();
  log(`after "2 nebeneinander": ${JSON.stringify(panes)}`);
  expect((await tabOrder()).length === 2, `Tab A did not close: ${(await tabOrder()).join()}`);
  expect(
    panes[0]?.session === b.id && panes[1]?.session === a.id && panes[1].x === 0.5,
    "A is not right of B",
  );
  expect(
    panes.every((pane) => pane.role === "writer"),
    "a view lost its role",
  );
  expect(sameViews(), "the drop attached a view again");
  await capture("51-snap-dropped.png");

  // --- Tab C onto "1 + 2": three views, the patterns of two fields are hidden ------------------------------------
  at = await tabToBar("Snap C");
  const hidden = await hiddenPatterns();
  expect(hidden.join() === "columns,rows", `hidden patterns for three views: ${hidden.join()}`);
  to = await pointIn(field("mainLeft", 0));
  await moveHeld(at, to);
  await waitFor(
    `document.querySelector('${field("mainLeft", 0)}.snap-field--over')`,
    "the big field of 1 + 2",
  );
  await capture("52-snap-bar-three.png");
  mouse("mouseUp", to.x, to.y);
  await waitFor(`document.querySelectorAll('${PANES}').length === 3`, "three panes after the drop");
  await sleep(800);
  panes = await visiblePanes();
  log(`after "1 + 2": ${JSON.stringify(panes)}`);
  const place = (session: SessionInfo) => panes.find((pane) => pane.session === session.id);
  expect(place(c)?.x === 0 && place(c)?.w === 0.5, "C is not the big field on the left");
  expect(
    place(b)?.x === 0.5 && place(b)?.y === 0 && place(a)?.x === 0.5 && place(a)?.y === 0.5,
    "B, A not right",
  );
  expect(
    panes.every((pane) => pane.role === "writer"),
    "a view lost its role",
  );
  expect(sameViews(), "the drop of C attached a view again");
  await capture("53-snap-main-left.png");

  // --- Keyboard: the grip of B, Enter, the arrow keys to "Anordnen: 2 × 2", Enter -------------------------------
  await evaluate(`document.querySelector('${PANES}[data-session-id="${b.id}"] .pane-grip').focus()`);
  await key("Return", [], 500, "\r");
  await waitFor(`document.querySelector('[role="menu"]')`, "the menu of B's pane");
  const items = await evaluate<string[]>(
    `[...document.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')].map((el) => el.dataset.menuItem)`,
  );
  log(`pane menu: ${items.join(", ")}`);
  const gridIndex = items.indexOf("snap:grid");
  expect(gridIndex > 0, "the pane menu has no enabled 2 × 2");
  for (let index = 0; index < gridIndex; index += 1) await key("Down", [], 100);
  expect(
    (await evaluate<string>(`document.activeElement?.dataset?.menuItem ?? 'none'`)) === "snap:grid",
    "the arrow keys did not reach 2 × 2",
  );
  await capture("54-snap-menu.png");
  await key("Return", [], 800, "\r");
  await sleep(500);
  panes = await visiblePanes();
  log(`after "2 × 2" by keyboard: ${JSON.stringify(panes)}`);
  // B in the first field, then C and A in order; the fourth field is empty and not created.
  expect(place(b)?.x === 0 && place(b)?.y === 0 && place(b)?.w === 0.5, "B is not in the first field");
  expect(place(c)?.x === 0.5 && place(c)?.y === 0, "C is not in the second field");
  expect(place(a)?.x === 0 && place(a)?.y === 0.5 && place(a)?.w === 1, "A does not take the bottom row");
  expect(
    panes.every((pane) => pane.role === "writer"),
    "a view lost its role",
  );
  expect(sameViews(), "the menu attached a view again");
  await waitFor(
    `document.activeElement?.closest('.pane')?.dataset.sessionId === '${b.id}'`,
    "the focus in B's terminal after the menu",
  );
  await capture("55-snap-grid-keyboard.png");
  log("snap scenes done");
}
