// Scenes of the screenshot mode for the sidebar with workspaces, archive, drag and drop and context menu (#63,
// ADR 0006). The mouse is real (`webContents.sendInputEvent`: press, moves with the button held, release), so the
// whole way from the pointer events through the drag controller to `session.update` is exercised; what the core
// holds afterwards is checked, not just the picture. A drag aborted with Esc must change nothing. Needs Electron,
// WSL and the isolated core; no unit test (drag model, controller, sidebar model and bridge are tested).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SessionInfo, Workspace } from "@termdock/protocol";
import type { ScenarioDeps } from "./screenshot-scenario.js";

const sessionSelector = (name: string): string => `[data-session-name=${JSON.stringify(name)}]`;
const workspaceSelector = (name: string): string => `[data-workspace-name=${JSON.stringify(name)}]`;

export async function sidebarScenes(deps: ScenarioDeps): Promise<void> {
  const { dir, createWindow, core, log } = deps;
  mkdirSync(dir, { recursive: true });
  const win = createWindow(1100, 800);
  // Windows of earlier scenes lie below; a covered window stops painting.
  win.webContents.setBackgroundThrottling(false);
  win.show();
  win.moveTop();

  const evaluate = <T>(expression: string): Promise<T> =>
    win.webContents.executeJavaScript(expression, true) as Promise<T>;
  const waitFor = async (expression: string, what: string, timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await evaluate<boolean>(`Boolean(${expression})`).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  const capture = async (name: string): Promise<void> => {
    await sleep(300);
    const file = path.join(dir, name);
    writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    console.log(file);
  };
  const click = async (selector: string): Promise<void> => {
    await waitFor(`document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await sleep(200);
  };
  /** Types into a field of the page the way React hears it. */
  const fill = async (selector: string, value: string): Promise<void> => {
    await waitFor(`document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(100);
  };
  const center = (selector: string): Promise<{ x: number; y: number }> =>
    evaluate(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
  const mouse = (
    type: "mouseDown" | "mouseUp" | "mouseMove",
    x: number,
    y: number,
    button: "left" | "right" = "left",
  ): void =>
    win.webContents.sendInputEvent({
      type,
      x: Math.round(x),
      y: Math.round(y),
      button,
      clickCount: 1,
      // A move between down and up is a drag: the button is held.
      ...(type === "mouseMove" && button === "left" ? { modifiers: ["leftbuttondown" as const] } : {}),
    });
  /** A key press; `text` adds the `char` event that activates a focused button (Enter) like a typed key. */
  const key = async (
    keyCode: string,
    modifiers: Array<"shift"> = [],
    wait = 300,
    text?: string,
  ): Promise<void> => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    if (text !== undefined) win.webContents.sendInputEvent({ type: "char", keyCode: text, modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await sleep(wait);
  };

  const sessions = async (): Promise<SessionInfo[]> =>
    (await core.request("session.list", {})).result.sessions;
  const session = async (name: string): Promise<SessionInfo> => {
    const found = (await sessions()).find((each) => each.name === name);
    if (!found) throw new Error(`No session ${name}`);
    return found;
  };
  const workspaces = async (): Promise<Workspace[]> =>
    (await core.request("workspace.list", {})).result.workspaces;
  const workspace = async (name: string): Promise<Workspace> => {
    const found = (await workspaces()).find((each) => each.name === name);
    if (!found) throw new Error(`No workspace ${name}`);
    return found;
  };
  /** Waits until the core holds the condition (the answer of a drop comes back asynchronously). */
  const waitForCore = async (check: () => Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the core: ${what}`);
      await sleep(100);
    }
  };
  const expect = (condition: boolean, what: string): void => {
    if (!condition) throw new Error(`Sidebar scene failed: ${what}`);
  };

  /** Presses on the session, moves in steps to the center of `target` and stops there with the button held. */
  const dragSessionTo = async (name: string, targetSelector: string): Promise<{ x: number; y: number }> => {
    const from = await center(sessionSelector(name));
    const to = await center(targetSelector);
    mouse("mouseDown", from.x, from.y);
    await sleep(50);
    const steps = 8;
    for (let step = 1; step <= steps; step += 1) {
      mouse(
        "mouseMove",
        from.x + ((to.x - from.x) * step) / steps,
        from.y + ((to.y - from.y) * step) / steps,
      );
      await sleep(40);
    }
    return to;
  };

  await waitFor(`document.querySelector('[data-view="empty"]')`, "the empty window");
  await waitFor(`document.querySelector(${JSON.stringify(sessionSelector("Build"))})`, "the sessions");

  // --- Workspaces through the dialog: create, then "Daten" and a project through the core ------------
  await click('[data-action="new-workspace"]');
  await waitFor(`document.querySelector('[data-dialog="name"]')`, "the name dialog");
  await fill('[data-dialog="name"] [data-field="name"]', "Web");
  await click('[data-dialog="name"] [data-name="ok"]');
  await waitFor(`document.querySelector(${JSON.stringify(workspaceSelector("Web"))})`, "the workspace Web");
  await core.request("workspace.create", { name: "Daten" });
  await waitFor(
    `document.querySelector(${JSON.stringify(workspaceSelector("Daten"))})`,
    "the workspace Daten",
  );
  const web = await workspace("Web");

  // A project through the menu of the workspace (keyboard path: the button next to the heading).
  await click(`${workspaceSelector("Web")} [data-action="workspace-menu"]`);
  await click('[data-menu-item="addProject"]');
  await fill('[data-dialog="name"] [data-field="name"]', "api");
  await fill('[data-dialog="name"] [data-field="path"]', "/srv/api");
  await click('[data-dialog="name"] [data-name="ok"]');
  await waitFor(`document.querySelector('[data-project-name="api"]')`, "the project api");

  // Sessions of earlier scenes into the workspaces: by the core, like another client (events reach the window).
  const daten = await workspace("Daten");
  await core.request("session.update", { sessionId: (await session("Build")).id, workspaceId: web.id });
  await core.request("session.update", { sessionId: (await session("Done")).id, workspaceId: web.id });
  await core.request("session.update", { sessionId: (await session("Lost")).id, workspaceId: daten.id });
  await core.request("workspace.update", { workspaceId: daten.id, name: "Daten" });
  await waitFor(
    `document.querySelector(${JSON.stringify(workspaceSelector("Web"))}).querySelector(${JSON.stringify(sessionSelector("Build"))})`,
    "Build under Web",
  );
  await waitFor(
    `document.querySelector(${JSON.stringify(workspaceSelector("Daten"))}).querySelector(${JSON.stringify(sessionSelector("Lost"))})`,
    "Lost under Daten",
  );
  log("sidebar: workspaces and sessions shown");
  await capture("30-sidebar-workspaces.png");

  // --- Archive: collapsed with a count, expanded with "Löschen" ---------------------------------------
  // An own session: later scenes still need the ones of the earlier scenes. It runs, so archiving ends a process.
  const archivedName = "Altlast";
  const old = await core.request("session.create", {
    name: archivedName,
    launch: { backend: "wsl", cwd: "~" },
  });
  await waitFor(
    `document.querySelector(${JSON.stringify(sessionSelector(archivedName))})`,
    "the new session",
  );
  await core.request("session.archive", { sessionId: old.result.session.id });
  await waitFor(
    `document.querySelector('[data-archive-count]')?.textContent === '1'`,
    "one archived session in the count",
  );
  expect(
    (await evaluate<boolean>(`!document.querySelector('[data-archive-list]')`)) === true,
    "the archive starts collapsed",
  );
  await click("[data-archive-toggle]");
  await waitFor(
    `document.querySelector('[data-archive-list] ${sessionSelector(archivedName)}')`,
    "the archived session",
  );
  await capture("31-sidebar-archive-open.png");

  // --- Drag and drop with the real mouse --------------------------------------------------------------
  const notes = await session("Notes");
  expect(notes.workspaceId === undefined, "Notes starts without a workspace");

  // Esc aborts: nothing may change, and the release after Esc must not open the session.
  await dragSessionTo("Notes", workspaceSelector("Daten"));
  await waitFor(
    `document.querySelector('.drop-target--over')`,
    "the highlight of the target under the pointer",
  );
  await key("Escape");
  await waitFor(`!document.querySelector('.drop-target--valid')`, "the highlight to go after Esc");
  const aborted = await center(workspaceSelector("Daten"));
  mouse("mouseUp", aborted.x, aborted.y);
  await sleep(600);
  expect((await session("Notes")).workspaceId === undefined, "Esc moved Notes");
  expect(
    (await evaluate<boolean>(`!document.querySelector('.tab')`)) === true,
    "a tab was opened by the drag that Esc aborted",
  );

  // The drag itself: highlight of all valid targets, the one under the pointer solid.
  const over = await dragSessionTo("Notes", workspaceSelector("Daten"));
  await waitFor(
    `document.querySelector(${JSON.stringify(workspaceSelector("Daten"))}).classList.contains('drop-target--over')`,
    "Daten as the target under the pointer",
  );
  const lit = await evaluate<{ valid: string[]; over: string[] }>(`({
    valid: [...document.querySelectorAll('.drop-target--valid')].map((el) => el.dataset.dropTarget),
    over: [...document.querySelectorAll('.drop-target--over')].map((el) => el.dataset.dropTarget),
  })`);
  log(`drag highlight: ${JSON.stringify(lit)}`);
  expect(
    lit.over.length === 1 && lit.over[0] === `workspace:${daten.id}`,
    "only Daten is the target under the pointer",
  );
  expect(
    lit.valid.includes("ungrouped") === false && lit.valid.includes("archive") && lit.valid.length === 3,
    "the valid targets are both workspaces and the archive (not Notes' own group)",
  );
  await capture("32-drag-drop-highlight.png");
  mouse("mouseUp", over.x, over.y);
  await waitForCore(async () => (await session("Notes")).workspaceId === daten.id, "Notes in Daten");
  await waitFor(
    `document.querySelector(${JSON.stringify(workspaceSelector("Daten"))}).querySelector(${JSON.stringify(sessionSelector("Notes"))})`,
    "Notes under Daten in the sidebar",
  );
  expect((await session("Notes")).state === notes.state, "the move changed the state of Notes");
  expect(
    (await evaluate<boolean>(
      `!document.querySelector('.tab') && !document.querySelector('.drop-target--valid')`,
    )) === true,
    "the drop opened a tab or left the highlight",
  );
  await capture("33-drag-drop-done.png");

  // --- Context menu with the real right mouse button, and by keyboard ---------------------------------
  const target = await center(sessionSelector("Notes"));
  mouse("mouseDown", target.x, target.y, "right");
  mouse("mouseUp", target.x, target.y, "right");
  await waitFor(`document.querySelector('[role="menu"]')`, "the context menu");
  await capture("34-context-menu.png");
  await key("Escape");
  await waitFor(`!document.querySelector('[role="menu"]')`, "the menu to close on Escape");
  expect(
    (await evaluate<boolean>(`document.activeElement?.dataset?.sessionName === 'Notes'`)) === true,
    "the focus did not return to the session after Escape",
  );

  // Keyboard: Shift+F10 on the focused entry, Down to "Verschieben nach Web", Enter.
  await key("F10", ["shift"], 500);
  await waitFor(`document.querySelector('[role="menu"]')`, "the menu by Shift+F10");
  const items = await evaluate<string[]>(
    `[...document.querySelectorAll('[role="menuitem"]')].map((el) => el.dataset.menuItem)`,
  );
  log(`menu entries: ${items.join(", ")}`);
  const webIndex = items.indexOf(`move:${web.id}`);
  expect(webIndex > 0, "the menu has no move to Web");
  // The first entry has the focus; arrow down to the move.
  for (let index = 0; index < webIndex; index += 1) await key("Down", [], 100);
  const focused = await evaluate<string>(`document.activeElement?.dataset?.menuItem ?? 'none'`);
  expect(focused === items[webIndex], `the arrow keys left the focus on ${focused}, not on the move to Web`);
  await key("Return", [], 600, "\r");
  await waitForCore(
    async () => (await session("Notes")).workspaceId === web.id,
    "Notes moved to Web by keyboard",
  );
  log("sidebar: keyboard move through the context menu works");

  // --- Delete: confirmation, then the placeholder in an open tab ---------------------------------------
  await click(`[data-archive-list] ${sessionSelector(archivedName)}`); // opens the tab with the archived notice
  await waitFor(`document.querySelector('.tab')`, "the tab of the archived session");
  await click(`[data-archive-delete=${JSON.stringify(archivedName)}]`);
  await waitFor(`document.querySelector('[data-dialog="confirm"]')`, "the delete confirmation");
  expect(
    (await evaluate<boolean>(`document.activeElement?.dataset?.confirm === 'cancel'`)) === true,
    "the default of the confirmation is not Abbrechen",
  );
  await capture("35-delete-confirm.png");
  // Escape cancels and changes nothing.
  await key("Escape");
  await waitFor(`!document.querySelector('[data-dialog="confirm"]')`, "the confirmation to close on Escape");
  expect(
    (await sessions()).some((each) => each.name === archivedName),
    "Escape deleted the session",
  );
  await click(`[data-archive-delete=${JSON.stringify(archivedName)}]`);
  await click('[data-dialog="confirm"] [data-confirm="ok"]');
  await waitForCore(
    async () => !(await sessions()).some((each) => each.name === archivedName),
    "Done deleted",
  );
  await waitFor(
    `!document.querySelector(${JSON.stringify(sessionSelector(archivedName))})`,
    "Done to leave the sidebar",
  );
  await waitFor(
    `document.querySelector('.tab-panel[data-active="true"]')?.textContent.includes('Session nicht gefunden')`,
    "the placeholder in the open tab",
  );
  await capture("36-deleted-session-placeholder.png");
  log("sidebar scenes done");
}
