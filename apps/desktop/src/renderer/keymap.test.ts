import { describe, expect, it, vi } from "vitest";
import { COMMAND_IDS, DEFAULT_KEYMAP, handleKey, keymapRows, overviewRows, resolveKey } from "./keymap.js";
import type { CommandId, KeyLike } from "./keymap.js";

/** A key press as xterm.js and the window see it; `code` is the physical key, independent of the layout. */
function press(
  code: string,
  modifiers: Partial<Omit<KeyLike, "code" | "type">> = {},
  type = "keydown",
): KeyLike {
  const letter = code.startsWith("Key") ? code.slice(3) : undefined;
  return {
    type,
    // QWERTY: the key names its own letter; others pass `key` to say what the layout produces.
    key: letter === undefined ? code : modifiers.shiftKey ? letter : letter.toLowerCase(),
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...modifiers,
  };
}
const ctrlShift = { ctrlKey: true, shiftKey: true };

describe("resolveKey", () => {
  it.each<[string, KeyLike, CommandId]>([
    ["Ctrl+Shift+T", press("KeyT", ctrlShift), "newSession"],
    ["Ctrl+Shift+W", press("KeyW", ctrlShift), "closeTab"],
    ["Ctrl+Tab", press("Tab", { ctrlKey: true }), "nextTab"],
    ["Ctrl+Shift+Tab", press("Tab", ctrlShift), "previousTab"],
    ["Ctrl+1", press("Digit1", { ctrlKey: true }), "gotoTab1"],
    ["Ctrl+9", press("Digit9", { ctrlKey: true }), "gotoTab9"],
    ["Ctrl+Shift+D", press("KeyD", ctrlShift), "splitRow"],
    ["Ctrl+Shift+E", press("KeyE", ctrlShift), "splitColumn"],
    ["Alt+Left", press("ArrowLeft", { altKey: true }), "focusLeft"],
    ["Alt+Right", press("ArrowRight", { altKey: true }), "focusRight"],
    ["Alt+Up", press("ArrowUp", { altKey: true }), "focusUp"],
    ["Alt+Down", press("ArrowDown", { altKey: true }), "focusDown"],
    ["Ctrl+Shift+B", press("KeyB", ctrlShift), "toggleSidebar"],
    ["Ctrl+Shift+N", press("KeyN", ctrlShift), "newWindow"],
    ["Ctrl+Shift+C", press("KeyC", ctrlShift), "copy"],
    ["Ctrl+Shift+V", press("KeyV", ctrlShift), "paste"],
    ["Ctrl+Shift+H", press("KeyH", ctrlShift), "showShortcuts"],
  ])("maps %s to %s", (_name, event, command) => {
    expect(resolveKey(event)).toBe(command);
  });

  it("leaves unbound keys to the shell, in particular Ctrl+<letter>", () => {
    const passed = [
      press("KeyC", { ctrlKey: true }), // interrupt
      press("KeyB", { ctrlKey: true }), // tmux prefix
      press("KeyD", { ctrlKey: true }), // end of input
      press("KeyV", { ctrlKey: true }), // vim block mode
      press("KeyW", { ctrlKey: true }), // delete word
      press("KeyT", { ctrlKey: true }),
      press("KeyA"),
      press("KeyT", { shiftKey: true }),
      press("Enter"),
      press("Tab"), // completion
      press("Tab", { shiftKey: true }),
      press("ArrowLeft"),
      press("ArrowLeft", { ctrlKey: true }), // word jump
      press("Digit1"),
      press("Digit1", { altKey: true }),
      press("KeyT", { altKey: true }),
    ];
    for (const event of passed)
      expect(resolveKey(event), `${event.code} ${JSON.stringify(event)}`).toBeUndefined();
  });

  it("needs exactly the bound modifiers", () => {
    expect(resolveKey(press("KeyT", { ...ctrlShift, altKey: true }))).toBeUndefined();
    expect(resolveKey(press("KeyT", { ...ctrlShift, metaKey: true }))).toBeUndefined();
    // AltGr on a German layout reports Ctrl and Alt together; it must not move the pane focus.
    expect(resolveKey(press("ArrowLeft", { ctrlKey: true, altKey: true }))).toBeUndefined();
  });

  it("matches letters by the character of the layout, not by the physical key", () => {
    // AZERTY: the key at the QWERTY position of W is labelled Z, and the W sits where QWERTY has Z.
    expect(resolveKey(press("KeyZ", { ...ctrlShift, key: "W" }))).toBe("closeTab");
    expect(resolveKey(press("KeyW", { ...ctrlShift, key: "Z" }))).toBeUndefined();
    expect(resolveKey(press("KeyM", { ...ctrlShift, key: "N" }))).toBe("newWindow");
    // Case does not matter (Caps Lock).
    expect(resolveKey(press("KeyD", { ...ctrlShift, key: "d" }))).toBe("splitRow");
  });

  it("falls back to the physical key where the layout has no Latin letters", () => {
    expect(resolveKey(press("KeyD", { ...ctrlShift, key: "В" }))).toBe("splitRow");
  });

  it("matches digits by the physical key, also where Shift is needed for the digit", () => {
    // AZERTY: Ctrl+& is Ctrl+1; `key` is the symbol.
    expect(resolveKey(press("Digit1", { ctrlKey: true, key: "&" }))).toBe("gotoTab1");
  });

  it("ignores keys while an input method composes", () => {
    expect(resolveKey(press("KeyT", { ...ctrlShift, isComposing: true }))).toBeUndefined();
  });

  it("follows another keymap", () => {
    const custom = { ...DEFAULT_KEYMAP, splitRow: "Ctrl+Shift+Y" };

    expect(resolveKey(press("KeyY", ctrlShift), custom)).toBe("splitRow");
    expect(resolveKey(press("KeyD", ctrlShift), custom)).toBeUndefined();
  });
});

describe("the default keymap", () => {
  it("binds every command exactly once", () => {
    expect(Object.keys(DEFAULT_KEYMAP).sort()).toEqual([...COMMAND_IDS].sort());
    const shortcuts = Object.values(DEFAULT_KEYMAP);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it("never binds Ctrl+<letter> without Shift", () => {
    // Shell, tmux (Ctrl+B) and TUIs keep these keys (issue #28).
    for (const shortcut of Object.values(DEFAULT_KEYMAP)) {
      const keys = shortcut.split("+");
      const letter = /^[A-Z]$/.test(keys.at(-1)!);
      expect(letter && keys.includes("Ctrl") && !keys.includes("Shift"), shortcut).toBe(false);
      expect(letter && keys.length === 1, shortcut).toBe(false);
    }
  });

  it("lists every command with its shortcut for the overview", () => {
    const rows = keymapRows();

    expect(rows).toHaveLength(COMMAND_IDS.length);
    expect(rows.find((row) => row.command === "splitRow")).toEqual({
      command: "splitRow",
      label: "Pane rechts teilen",
      shortcut: "Ctrl+Shift+D",
    });
  });
});

describe("overviewRows", () => {
  it("shows the nine tab numbers as one row", () => {
    const rows = overviewRows();

    expect(rows).toHaveLength(COMMAND_IDS.length - 8);
    expect(rows.find((row) => row.command === "gotoTab1")).toEqual({
      command: "gotoTab1",
      label: "Zu Tab 1 bis 9",
      shortcut: "Ctrl+1 … Ctrl+9",
    });
    expect(rows.some((row) => row.command === "gotoTab2")).toBe(false);
  });
});

describe("handleKey", () => {
  const event = (key: KeyLike) => ({ ...key, preventDefault: vi.fn() });
  const commands = (applies = true) => ({ applies: vi.fn(() => applies), run: vi.fn() });

  it("runs the command on key down and keeps the key from xterm.js and the browser", () => {
    const run = commands();
    const key = event(press("KeyD", ctrlShift));

    const forTerminal = handleKey(key, run);

    expect(forTerminal).toBe(false);
    expect(run.run).toHaveBeenCalledExactlyOnceWith("splitRow");
    expect(key.preventDefault).toHaveBeenCalled();
  });

  it("swallows the other events of a bound key without running it again", () => {
    const run = commands();

    expect(handleKey(event(press("KeyD", ctrlShift, "keyup")), run)).toBe(false);
    expect(handleKey(event(press("KeyD", ctrlShift, "keypress")), run)).toBe(false);
    expect(run.run).not.toHaveBeenCalled();
  });

  it("passes unbound keys on untouched", () => {
    const run = commands();
    const key = event(press("KeyC", { ctrlKey: true }));

    expect(handleKey(key, run)).toBe(true);
    expect(run.run).not.toHaveBeenCalled();
    expect(key.preventDefault).not.toHaveBeenCalled();
  });

  it("gives a bound key to the terminal when its command has nothing to do", () => {
    // Alt+Left in a single pane: the shell's word jump.
    const run = commands(false);

    for (const type of ["keydown", "keypress", "keyup"]) {
      const key = event(press("ArrowLeft", { altKey: true }, type));
      expect(handleKey(key, run)).toBe(true);
      expect(key.preventDefault).not.toHaveBeenCalled();
    }
    expect(run.applies).toHaveBeenCalledWith("focusLeft");
    expect(run.run).not.toHaveBeenCalled();
  });

  it("leaves new window to the application menu, which needs the event unprevented", () => {
    const run = commands();
    const key = event(press("KeyN", ctrlShift));

    expect(handleKey(key, run)).toBe(false);
    expect(run.run).not.toHaveBeenCalled();
    expect(key.preventDefault).not.toHaveBeenCalled();
  });
});
