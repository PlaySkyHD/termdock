import type { SessionInfo } from "@termdock/protocol";
import { describe, expect, it, vi } from "vitest";
import { canRun, PASTE_REFUSED, pasteInto, runCommand } from "./commands.js";
import type { Clipboard, CommandDeps } from "./commands.js";
import type { CommandId } from "./keymap.js";
import { activeTab, UiStore } from "./ui-store.js";

/** The part of a TerminalController the commands use. */
class FakeController {
  writer = true;
  selection = "";
  pasted: string[] = [];
  selectedText = (): string => this.selection;
  canPaste = (): boolean => this.writer;
  paste = (text: string): boolean => {
    if (!this.writer) return false;
    this.pasted.push(text);
    return true;
  };
}

class FakeClipboard implements Clipboard {
  text = "";
  failRead = false;
  failWrite = false;
  readText = async (): Promise<string> => {
    if (this.failRead) throw new Error("denied");
    return this.text;
  };
  writeText = async (text: string): Promise<void> => {
    if (this.failWrite) throw new Error("denied");
    this.text = text;
  };
}

function session(id: string): SessionInfo {
  return {
    id,
    name: id,
    state: "Running",
    launch: { backend: "wsl", cwd: "/" },
    size: { cols: 80, rows: 24 },
    loggingEnabled: false,
    createdAt: "2026-11-13T10:00:00Z",
    updatedAt: "2026-11-13T10:00:00Z",
  };
}

function setup(sessions: string[] = []) {
  let next = 0;
  const store = new UiStore({ newId: () => `id${++next}` });
  store.setSessions(sessions.map(session));
  for (const id of sessions) store.openSession(id);
  const controller = new FakeController();
  const clipboard = new FakeClipboard();
  const notices: Array<string | undefined> = [];
  const calls: string[] = [];
  const deps: CommandDeps = {
    store,
    clipboard,
    activeController: () => controller,
    split: (direction) => calls.push(`split ${direction}`),
    showForm: () => calls.push("showForm"),
    shortcutsOpen: false,
    toggleShortcuts: () => calls.push("toggleShortcuts"),
    notify: (text) => notices.push(text),
    refocus: () => calls.push("refocus"),
  };
  const run = (command: CommandId) => runCommand(command, deps);
  const activeIndex = () =>
    store.getState().window.tabs.findIndex((tab) => tab.id === activeTab(store.getState())?.id);
  return { store, controller, clipboard, notices, calls, run, deps, activeIndex };
}

describe("runCommand: tabs", () => {
  it("goes to the next and the previous tab and wraps around", async () => {
    const { run, activeIndex } = setup(["a", "b", "c"]);
    expect(activeIndex()).toBe(2);

    await run("nextTab");
    expect(activeIndex()).toBe(0);
    await run("previousTab");
    expect(activeIndex()).toBe(2);
    await run("previousTab");
    expect(activeIndex()).toBe(1);
  });

  it("goes to tab N and ignores a tab that does not exist", async () => {
    const { run, activeIndex } = setup(["a", "b", "c"]);

    await run("gotoTab1");
    expect(activeIndex()).toBe(0);
    await run("gotoTab2");
    expect(activeIndex()).toBe(1);
    await run("gotoTab9");
    expect(activeIndex()).toBe(1);
  });

  it("closes the active tab", async () => {
    const { run, store } = setup(["a", "b"]);

    await run("closeTab");

    expect(store.getState().window.tabs).toHaveLength(1);
  });

  it("does nothing for tabs and panes without tabs", async () => {
    const { run, store, calls } = setup();

    await run("nextTab");
    await run("previousTab");
    await run("closeTab");
    await run("gotoTab1");
    await run("splitRow");
    await run("focusLeft");

    expect(store.getState().window.tabs).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("gives the focus back to the terminal after a tab command", async () => {
    const { run, calls } = setup(["a", "b"]);

    await run("nextTab");

    expect(calls).toEqual(["refocus"]);
  });
});

describe("canRun", () => {
  it("does not apply when there is nothing to move to, so the key stays with the shell", () => {
    const { deps } = setup(["a"]); // one tab with one pane

    for (const command of [
      "nextTab",
      "previousTab",
      "gotoTab1", // the active tab
      "gotoTab2",
      "gotoTab9",
      "focusLeft",
      "focusRight",
      "focusUp",
      "focusDown",
    ] as const)
      expect(canRun(command, deps), command).toBe(false);
  });

  it("does not apply without tabs", () => {
    const { deps } = setup();

    for (const command of ["closeTab", "splitRow", "splitColumn", "gotoTab1", "nextTab"] as const)
      expect(canRun(command, deps), command).toBe(false);
  });

  it("applies when there is somewhere to go", () => {
    const { deps, store } = setup(["a", "b"]);
    const tab = activeTab(store.getState())!;
    store.splitPane(tab.id, tab.activePaneId, "row", "a");

    // Two tabs; the active one has two panes, and the new pane at the right is active.
    expect(canRun("nextTab", deps)).toBe(true);
    expect(canRun("previousTab", deps)).toBe(true);
    expect(canRun("gotoTab1", deps)).toBe(true);
    expect(canRun("gotoTab2", deps)).toBe(false); // the active tab
    expect(canRun("gotoTab3", deps)).toBe(false);
    expect(canRun("closeTab", deps)).toBe(true);
    expect(canRun("splitRow", deps)).toBe(true);
    expect(canRun("focusLeft", deps)).toBe(true);
    expect(canRun("focusRight", deps)).toBe(false);
  });

  it("always applies to the commands that act on the window or the clipboard", () => {
    const { deps } = setup();

    for (const command of ["newSession", "toggleSidebar", "copy", "paste", "showShortcuts"] as const)
      expect(canRun(command, deps), command).toBe(true);
  });
});

describe("while the overview is open", () => {
  it("takes every bound key but acts only on the overview itself", async () => {
    const { deps, store, calls } = setup(["a", "b"]);
    const open = { ...deps, shortcutsOpen: true };
    const before = store.getState();

    for (const command of [
      "nextTab",
      "gotoTab1",
      "closeTab",
      "splitRow",
      "focusRight",
      "toggleSidebar",
    ] as const) {
      expect(canRun(command, open), command).toBe(true);
      await runCommand(command, open);
    }
    expect(store.getState()).toBe(before);
    expect(calls).toEqual([]);

    await runCommand("showShortcuts", open);
    expect(calls).toEqual(["toggleShortcuts"]);
  });

  it("does not copy or paste underneath", async () => {
    const { deps, controller, clipboard } = setup(["a"]);
    clipboard.text = "x";
    controller.selection = "y";

    await runCommand("paste", { ...deps, shortcutsOpen: true });
    await runCommand("copy", { ...deps, shortcutsOpen: true });

    expect(controller.pasted).toEqual([]);
    expect(clipboard.text).toBe("x");
  });
});

describe("runCommand: panes, sidebar and dialogs", () => {
  it("splits right and down through the window", async () => {
    const { run, calls } = setup(["a"]);

    await run("splitRow");
    await run("splitColumn");

    expect(calls).toEqual(["split row", "split column"]);
  });

  it("moves the focus between panes by direction", async () => {
    const { run, store } = setup(["a"]);
    const tab = () => activeTab(store.getState())!;
    const first = tab().activePaneId;
    const second = store.splitPane(tab().id, first, "row", "b")!; // another session: the new pane is active
    expect(tab().activePaneId).toBe(second);

    await run("focusLeft");
    expect(tab().activePaneId).toBe(first);
    await run("focusLeft"); // at the edge
    expect(tab().activePaneId).toBe(first);
    await run("focusRight");
    expect(tab().activePaneId).toBe(second);
    await run("focusUp");
    expect(tab().activePaneId).toBe(second);
  });

  it("toggles the sidebar", async () => {
    const { run, store } = setup();

    await run("toggleSidebar");
    expect(store.getState().window.sidebarVisible).toBe(false);
    await run("toggleSidebar");
    expect(store.getState().window.sidebarVisible).toBe(true);
  });

  it("opens the form for a new session and the overview of the shortcuts", async () => {
    const { run, calls } = setup();

    await run("newSession");
    await run("showShortcuts");

    expect(calls).toEqual(["showForm", "toggleShortcuts"]);
  });

  it("leaves a new window to the application menu", async () => {
    const { run, calls, store } = setup(["a"]);
    const before = store.getState();

    await run("newWindow");

    expect(calls).toEqual([]);
    expect(store.getState()).toBe(before);
  });
});

describe("runCommand: clipboard", () => {
  it("copies the selection, with umlauts and line breaks", async () => {
    const { run, controller, clipboard, notices } = setup(["a"]);
    controller.selection = "Größe äöü ß\nzweite Zeile";

    await run("copy");

    expect(clipboard.text).toBe("Größe äöü ß\nzweite Zeile");
    expect(notices).toEqual([undefined]);
  });

  it("copies nothing without a selection and keeps the clipboard", async () => {
    const { run, clipboard } = setup(["a"]);
    clipboard.text = "kept";

    await run("copy");

    expect(clipboard.text).toBe("kept");
  });

  it("reports a clipboard that cannot be written", async () => {
    const { run, controller, clipboard, notices } = setup(["a"]);
    controller.selection = "x";
    clipboard.failWrite = true;

    await run("copy");

    expect(notices.at(-1)).toMatch(/Zwischenablage/);
  });

  it("pastes the clipboard into the writing pane", async () => {
    const { run, controller, clipboard } = setup(["a"]);
    clipboard.text = "echo Grüße\nls";

    await run("paste");

    expect(controller.pasted).toEqual(["echo Grüße\nls"]);
  });

  it("refuses to paste into a reading pane, does not even read the clipboard, and says why", async () => {
    const { run, controller, clipboard, notices } = setup(["a"]);
    controller.writer = false;
    const read = vi.spyOn(clipboard, "readText");

    await run("paste");

    expect(controller.pasted).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(notices.at(-1)).toBe(PASTE_REFUSED);
  });

  it("reports a clipboard that cannot be read and pastes nothing", async () => {
    const { run, controller, clipboard, notices } = setup(["a"]);
    clipboard.failRead = true;

    await run("paste");

    expect(controller.pasted).toEqual([]);
    expect(notices.at(-1)).toMatch(/Zwischenablage/);
  });

  it("does nothing without an active pane", async () => {
    const { deps, clipboard, notices } = setup();
    clipboard.text = "x";

    await runCommand("paste", { ...deps, activeController: () => undefined });
    await runCommand("copy", { ...deps, activeController: () => undefined });

    expect(notices).toEqual([]);
  });
});

describe("pasteInto", () => {
  it("is what the context menu of a pane uses: the same rule as Ctrl+Shift+V", async () => {
    const { controller, clipboard, notices } = setup(["a"]);
    clipboard.text = "text";
    controller.writer = false;

    await pasteInto(controller, clipboard, (text) => notices.push(text));
    controller.writer = true;
    await pasteInto(controller, clipboard, (text) => notices.push(text));

    expect(controller.pasted).toEqual(["text"]);
    expect(notices).toEqual([PASTE_REFUSED, undefined]);
  });
});
