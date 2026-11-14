// What the commands of the key map do (#28). They run on the store and the controller of the active pane; the
// window supplies what depends on React (the form, the overview, the notice), so this module stays testable
// without DOM. "newWindow" is the application menu's (main process): nothing to do here.
import { neighborPane } from "./pane-focus.js";
import type { FocusDirection } from "./pane-focus.js";
import type { CommandId } from "./keymap.js";
import type { TerminalController } from "./terminal-controller.js";
import { activeTab } from "./ui-store.js";
import type { SplitDirection, UiStore } from "./ui-store.js";

/**
 * Text clipboard. The renderer's `navigator.clipboard` is enough: with the sandbox and without a permission
 * handler Electron grants `clipboard-read` and `clipboard-write` to the app's own page, so no bridge call is
 * needed (a probe in a sandboxed window with context isolation read and wrote text, umlauts and line breaks).
 */
export interface Clipboard {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

/** Shown when pasting is refused because the pane only reads (ADR 0003: only the writing view sends input). */
export const PASTE_REFUSED = "Einfügen nur im schreibenden Pane: zuerst „Schreibrecht übernehmen“";
const CLIPBOARD_FAILED = "Zwischenablage nicht verfügbar";

type PasteTarget = Pick<TerminalController, "canPaste" | "paste">;
type CopySource = Pick<TerminalController, "selectedText">;

export interface CommandDeps {
  store: UiStore;
  clipboard: Clipboard;
  /** Controller of the active pane of the active tab, if it has a view. */
  activeController(): (PasteTarget & CopySource) | undefined;
  /** Splits the active pane; the new pane shows the same session (App). */
  split(direction: SplitDirection): void;
  /** Opens the form for a new session, showing the sidebar if needed (App). */
  showForm(): void;
  toggleShortcuts(): void;
  /** Sets the notice of the status bar; undefined clears it. */
  notify(text: string | undefined): void;
  /** The active terminal takes the keyboard focus (App). */
  refocus(): void;
}

const DIRECTIONS: Partial<Record<CommandId, FocusDirection>> = {
  focusLeft: "left",
  focusRight: "right",
  focusUp: "up",
  focusDown: "down",
};

export async function runCommand(command: CommandId, deps: CommandDeps): Promise<void> {
  const { store } = deps;
  const state = store.getState();
  const tab = activeTab(state);
  const { tabs } = state.window;
  const index = tab ? tabs.indexOf(tab) : -1;
  const goTo = (target: number): void => {
    const next = tabs[target];
    if (!next || next === tab) return;
    store.focusTab(next.id);
    deps.refocus();
  };

  switch (command) {
    case "newSession":
      deps.showForm();
      return;
    case "closeTab":
      if (tab) store.closeTab(tab.id);
      return;
    case "nextTab":
      if (tab) goTo((index + 1) % tabs.length);
      return;
    case "previousTab":
      if (tab) goTo((index - 1 + tabs.length) % tabs.length);
      return;
    case "splitRow":
      if (tab) deps.split("row");
      return;
    case "splitColumn":
      if (tab) deps.split("column");
      return;
    case "focusLeft":
    case "focusRight":
    case "focusUp":
    case "focusDown": {
      const target = tab && neighborPane(tab.root, tab.activePaneId, DIRECTIONS[command]!);
      if (tab && target !== undefined) {
        store.focusPane(tab.id, target);
        deps.refocus();
      }
      return;
    }
    case "toggleSidebar":
      store.toggleSidebar();
      deps.refocus();
      return;
    case "copy": {
      const text = deps.activeController()?.selectedText() ?? "";
      if (text === "") return;
      try {
        await deps.clipboard.writeText(text);
        deps.notify(undefined);
      } catch {
        deps.notify(CLIPBOARD_FAILED);
      }
      return;
    }
    case "paste": {
      const controller = deps.activeController();
      if (controller) await pasteInto(controller, deps.clipboard, deps.notify);
      return;
    }
    case "showShortcuts":
      deps.toggleShortcuts();
      return;
    case "newWindow":
      return; // the application menu opens it (main.ts)
    default: {
      // gotoTab1 .. gotoTab9
      const number = /^gotoTab([1-9])$/.exec(command)?.[1];
      if (number !== undefined) goTo(Number(number) - 1);
    }
  }
}

/**
 * Pastes the clipboard into the pane's view. Only the writing view takes input; a reader is refused before the
 * clipboard is even read, and the notice says why. Also used by the context menu of a pane.
 */
export async function pasteInto(
  controller: PasteTarget,
  clipboard: Clipboard,
  notify: (text: string | undefined) => void,
): Promise<void> {
  if (!controller.canPaste()) {
    notify(PASTE_REFUSED);
    return;
  }
  let text: string;
  try {
    text = await clipboard.readText();
  } catch {
    notify(CLIPBOARD_FAILED);
    return;
  }
  // The role may have changed while the clipboard was read; `paste` checks it again.
  notify(controller.paste(text) || text === "" ? undefined : PASTE_REFUSED);
}
