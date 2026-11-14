// Central key map (#28): command -> shortcut, and the resolution of a key event to a command. Free of DOM and
// Electron, so the table and the rules around it are unit-tested. A settings dialog that rebinds commands
// comes with phase 3; until then `DEFAULT_KEYMAP` is the only map.
//
// Rule for the defaults: no shortcut is Ctrl+<letter> without Shift (or Alt), so the shell, tmux (Ctrl+B) and
// TUIs keep every such key. Everything that is not bound here goes to the terminal unchanged.

const TAB_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export const COMMAND_IDS = [
  "newSession",
  "closeTab",
  "nextTab",
  "previousTab",
  ...TAB_NUMBERS.map((n) => `gotoTab${n}` as const),
  "splitRow",
  "splitColumn",
  "focusLeft",
  "focusRight",
  "focusUp",
  "focusDown",
  "toggleSidebar",
  "newWindow",
  "copy",
  "paste",
  "showShortcuts",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

/** Command -> shortcut like `Ctrl+Shift+T`: modifiers `Ctrl`, `Alt`, `Shift`, then one key. */
export type Keymap = Readonly<Record<CommandId, string>>;

export const DEFAULT_KEYMAP: Keymap = {
  newSession: "Ctrl+Shift+T",
  closeTab: "Ctrl+Shift+W",
  nextTab: "Ctrl+Tab",
  previousTab: "Ctrl+Shift+Tab",
  gotoTab1: "Ctrl+1",
  gotoTab2: "Ctrl+2",
  gotoTab3: "Ctrl+3",
  gotoTab4: "Ctrl+4",
  gotoTab5: "Ctrl+5",
  gotoTab6: "Ctrl+6",
  gotoTab7: "Ctrl+7",
  gotoTab8: "Ctrl+8",
  gotoTab9: "Ctrl+9",
  splitRow: "Ctrl+Shift+D",
  splitColumn: "Ctrl+Shift+E",
  focusLeft: "Alt+Left",
  focusRight: "Alt+Right",
  focusUp: "Alt+Up",
  focusDown: "Alt+Down",
  toggleSidebar: "Ctrl+Shift+B",
  newWindow: "Ctrl+Shift+N",
  copy: "Ctrl+Shift+C",
  paste: "Ctrl+Shift+V",
  showShortcuts: "Ctrl+Shift+H",
};

/** Names of the commands in the overview of the shortcuts. */
export const COMMAND_LABELS: Readonly<Record<CommandId, string>> = {
  newSession: "Neue Session",
  closeTab: "Tab schließen",
  nextTab: "Nächster Tab",
  previousTab: "Vorheriger Tab",
  gotoTab1: "Zu Tab 1",
  gotoTab2: "Zu Tab 2",
  gotoTab3: "Zu Tab 3",
  gotoTab4: "Zu Tab 4",
  gotoTab5: "Zu Tab 5",
  gotoTab6: "Zu Tab 6",
  gotoTab7: "Zu Tab 7",
  gotoTab8: "Zu Tab 8",
  gotoTab9: "Zu Tab 9",
  splitRow: "Pane rechts teilen",
  splitColumn: "Pane unten teilen",
  focusLeft: "Fokus ins Pane links",
  focusRight: "Fokus ins Pane rechts",
  focusUp: "Fokus ins Pane oben",
  focusDown: "Fokus ins Pane unten",
  toggleSidebar: "Seitenleiste ein-/ausblenden",
  newWindow: "Neues Fenster",
  copy: "Auswahl kopieren",
  paste: "Einfügen",
  showShortcuts: "Tastenkürzel anzeigen",
};

/**
 * Commands the application menu runs through its accelerator (main process): the renderer neither runs nor
 * prevents them, or the menu would never see the key. It still keeps the key from the terminal.
 */
const MENU_COMMANDS: ReadonlySet<CommandId> = new Set(["newWindow"]);

/**
 * The part of a `KeyboardEvent` the map looks at. Letters match by `key` (the character the layout produces, so
 * Ctrl+Shift+W is the key labelled W on AZERTY too, like the menu accelerator); digits, arrows and Tab match by
 * `code`, because `key` of a digit is a symbol on layouts that need Shift for it.
 */
export interface KeyLike {
  type: string;
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

interface Chord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  code: string;
  /** Lower-case letter for letter shortcuts. */
  letter?: string;
}

const KEY_CODES: Readonly<Record<string, string>> = {
  Tab: "Tab",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Up: "ArrowUp",
  Down: "ArrowDown",
};

function parseShortcut(shortcut: string): Chord {
  const parts = shortcut.split("+");
  const key = parts.pop() ?? "";
  const modifiers = new Set(parts);
  const code =
    KEY_CODES[key] ?? (/^[A-Z]$/.test(key) ? `Key${key}` : /^[0-9]$/.test(key) ? `Digit${key}` : "");
  const unknown = parts.filter((part) => part !== "Ctrl" && part !== "Shift" && part !== "Alt");
  if (code === "" || unknown.length > 0) throw new Error(`Unknown shortcut ${shortcut}`);
  return {
    ctrl: modifiers.has("Ctrl"),
    shift: modifiers.has("Shift"),
    alt: modifiers.has("Alt"),
    code,
    ...(/^[A-Z]$/.test(key) ? { letter: key.toLowerCase() } : {}),
  };
}

function sameKey(chord: Chord, event: KeyLike): boolean {
  if (chord.letter === undefined) return chord.code === event.code;
  // A layout without Latin letters (Cyrillic, Greek) has none to compare: the physical key stands in.
  return /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() === chord.letter : chord.code === event.code;
}

const compiled = new WeakMap<Keymap, Array<[Chord, CommandId]>>();

function compile(keymap: Keymap): Array<[Chord, CommandId]> {
  let chords = compiled.get(keymap);
  if (!chords) {
    chords = COMMAND_IDS.map((id): [Chord, CommandId] => [parseShortcut(keymap[id]), id]);
    compiled.set(keymap, chords);
  }
  return chords;
}

/** The command a key press is bound to, or undefined when the key belongs to the terminal. */
export function resolveKey(event: KeyLike, keymap: Keymap = DEFAULT_KEYMAP): CommandId | undefined {
  if (event.isComposing || event.metaKey) return undefined;
  return compile(keymap).find(
    ([chord]) =>
      sameKey(chord, event) &&
      chord.ctrl === event.ctrlKey &&
      chord.shift === event.shiftKey &&
      chord.alt === event.altKey,
  )?.[1];
}

/**
 * What a bound key can do right now. `applies` is asked for every event of the key and must not change anything;
 * a command that has nothing to do (Alt+Left in a single pane, Ctrl+Tab with one tab) does not apply, and its key
 * belongs to the terminal after all (readline word jumps, tmux `bind -n M-Left`).
 */
export interface KeyCommands {
  applies(command: CommandId): boolean;
  run(command: CommandId): void;
}

/**
 * Handles one key event of xterm.js or the window. Returns whether the terminal may process the key: false for
 * every event of a bound key whose command applies (key down, press and up), true for all others, which stay
 * untouched. Such a key runs its command once, on key down, and is kept from the browser (Ctrl+Shift+V would
 * otherwise paste a second time through the text area of xterm.js).
 */
export function handleKey(
  event: KeyLike & { preventDefault(): void },
  commands: KeyCommands,
  keymap: Keymap = DEFAULT_KEYMAP,
): boolean {
  const command = resolveKey(event, keymap);
  if (command === undefined) return true;
  if (MENU_COMMANDS.has(command)) return false;
  if (!commands.applies(command)) return true;
  event.preventDefault();
  if (event.type === "keydown") commands.run(command);
  return false;
}

export interface KeymapRow {
  command: CommandId;
  label: string;
  shortcut: string;
}

/** All commands with their shortcut, in the order of `COMMAND_IDS`. */
export function keymapRows(keymap: Keymap = DEFAULT_KEYMAP): KeymapRow[] {
  return COMMAND_IDS.map((command) => ({
    command,
    label: COMMAND_LABELS[command],
    shortcut: keymap[command],
  }));
}

/** The rows of the overview dialog: the nine tab numbers share one row ("Ctrl+1 … Ctrl+9"). */
export function overviewRows(keymap: Keymap = DEFAULT_KEYMAP): KeymapRow[] {
  return keymapRows(keymap).flatMap((row) => {
    if (row.command === "gotoTab1")
      return [{ ...row, label: "Zu Tab 1 bis 9", shortcut: `${row.shortcut} … ${keymap.gotoTab9}` }];
    return /^gotoTab[2-9]$/.test(row.command) ? [] : [row];
  });
}
