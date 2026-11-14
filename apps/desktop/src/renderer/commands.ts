// What the commands of the key map do (#28). They run on the store and the controller of the active pane; the
// window supplies what depends on React (the form, the overview, the notice), so this module stays testable
// without DOM. "newWindow" is the application menu's (main process): nothing to do here.
import type { LayoutTab, SessionCreateParams, SessionInfo } from "@termdock/protocol";
import { neighborPane } from "./pane-focus.js";
import type { FocusDirection } from "./pane-focus.js";
import type { CommandId } from "./keymap.js";
import type { TerminalController } from "./terminal-controller.js";
import { activeTab, MAX_PANES, MAX_TABS, paneCount, tabSessionId } from "./ui-store.js";
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
export const PASTE_REFUSED = "Einfügen nur im schreibenden Pane: zuerst „Eingabe übernehmen“";
const CLIPBOARD_FAILED = "Zwischenablage nicht verfügbar";

type PasteTarget = Pick<TerminalController, "canPaste" | "paste">;
type CopySource = Pick<TerminalController, "selectedText">;

/** What splitting needs (#66): the store, `session.create` through the bridge, the notice and the focus. */
export interface SplitDeps {
  store: UiStore;
  createSession(params: SessionCreateParams): Promise<SessionInfo>;
  /** Sets the notice of the status bar; undefined clears it. */
  notify(text: string | undefined): void;
  /** The active terminal takes the keyboard focus (App). */
  refocus(): void;
}

export interface CommandDeps extends SplitDeps {
  clipboard: Clipboard;
  /** Controller of the active pane of the active tab, if it has a view. */
  activeController(): (PasteTarget & CopySource) | undefined;
  /** Opens the form for a new session, showing the sidebar if needed (App). */
  showForm(): void;
  /** The overview of the shortcuts is open. */
  shortcutsOpen: boolean;
  toggleShortcuts(): void;
}

/** Stores with a split whose session is still being created; a second split waits for it (no session over the limit). */
const splitting = new WeakSet<UiStore>();

export const SPLIT_BUSY = "Neue Session wird noch gestartet …";
export const SPLIT_UNKNOWN = "Teilen nicht möglich: Die Session des aktiven Panes ist unbekannt";
export const panesFull = (max: number): string => `Höchstens ${max} Panes je Tab`;

/**
 * Splits the active pane of the active tab (#66): starts a new session with backend, distro, shell, working
 * directory and workspace of the active pane's session and shows it in the new pane, which becomes active and
 * writes. The command, environment and profile are not taken over: splitting starts a shell. The same session in
 * a second pane is Shift+click in the sidebar (`UiStore.splitPane`). Used by the keys and the buttons.
 */
export async function splitActivePane(deps: SplitDeps, direction: SplitDirection): Promise<void> {
  const { store } = deps;
  const state = store.getState();
  const tab = activeTab(state);
  if (!tab) return;
  if (paneCount(tab) >= MAX_PANES) {
    deps.notify(panesFull(MAX_PANES));
    return;
  }
  const source = state.sessions.find((each) => each.id === tabSessionId(tab));
  if (!source) {
    deps.notify(SPLIT_UNKNOWN);
    return;
  }
  if (splitting.has(store)) {
    deps.notify(SPLIT_BUSY);
    return;
  }
  const paneId = tab.activePaneId;
  const { backend, distro, shell, cwd } = source.launch;
  const params: SessionCreateParams = {
    name: nextName(source.name, state.sessions),
    launch: {
      backend,
      ...(distro === undefined ? {} : { distro }),
      ...(shell === undefined ? {} : { shell }),
      cwd,
    },
    ...(source.workspaceId === undefined ? {} : { workspaceId: source.workspaceId }),
  };
  splitting.add(store);
  let created: SessionInfo;
  try {
    created = await deps.createSession(params);
  } catch (error) {
    deps.notify(`Neue Session nicht gestartet: ${error instanceof Error ? error.message : String(error)}`);
    deps.refocus();
    return;
  } finally {
    splitting.delete(store);
  }
  // The event of the main process may have added it already; the store keeps what it has.
  store.sessionCreated(created);
  // Split the pane that was active when the user asked; when it is gone or the tab filled up meanwhile, the
  // session gets a tab of its own instead of staying out of sight.
  const added = store.splitPane(tab.id, paneId, direction, created.id);
  // The user asked for this pane: when another tab came to the front meanwhile, the split one does again, so
  // the new session does not start out of sight. Its tab keeps the context of the split (not a tab of its own).
  if (added !== undefined) store.focusTab(tab.id);
  const shown = added ?? store.openSession(created.id, { forceNew: true });
  deps.notify(
    shown === undefined
      ? `Höchstens ${MAX_TABS} Tabs je Fenster: „${created.name}“ steht in der Seitenleiste`
      : undefined,
  );
  deps.refocus();
}

/**
 * `<name> 2`, `<name> 3` …: the smallest number no session of that name has. A trailing number is replaced only
 * when it came from this scheme (a session named like the rest exists), so "Python 3" becomes "Python 3 2".
 */
function nextName(name: string, sessions: readonly SessionInfo[]): string {
  const taken = new Set(sessions.map((each) => each.name));
  const stripped = name.replace(/ \d+$/, "");
  const base = stripped !== name && taken.has(stripped) ? stripped : name;
  let number = 2;
  while (taken.has(`${base} ${number}`)) number++;
  return `${base} ${number}`;
}

const DIRECTIONS: Partial<Record<CommandId, FocusDirection>> = {
  focusLeft: "left",
  focusRight: "right",
  focusUp: "up",
  focusDown: "down",
};

/** The tab a tab command goes to; undefined without tabs and when it is the active one or does not exist. */
function tabTarget(command: CommandId, deps: CommandDeps): LayoutTab | undefined {
  const state = deps.store.getState();
  const tab = activeTab(state);
  const { tabs } = state.window;
  if (!tab) return undefined;
  const index = tabs.indexOf(tab);
  const goto = /^gotoTab([1-9])$/.exec(command)?.[1];
  const target =
    command === "nextTab"
      ? tabs[(index + 1) % tabs.length]
      : command === "previousTab"
        ? tabs[(index - 1 + tabs.length) % tabs.length]
        : goto !== undefined
          ? tabs[Number(goto) - 1]
          : undefined;
  return target === tab ? undefined : target;
}

/**
 * Whether the command has something to do. A key whose command does not apply (Alt+Left in a single pane, Ctrl+Tab
 * with one tab) goes to the terminal, where the shell or tmux may use it. While the overview is open every bound
 * key applies, so that nothing under the dialog reacts and the key does not reach the terminal either.
 */
export function canRun(command: CommandId, deps: CommandDeps): boolean {
  if (deps.shortcutsOpen) return true;
  const tab = activeTab(deps.store.getState());
  switch (command) {
    case "closeTab":
    case "splitRow":
    case "splitColumn":
      return tab !== undefined;
    case "focusLeft":
    case "focusRight":
    case "focusUp":
    case "focusDown":
      return (
        tab !== undefined && neighborPane(tab.root, tab.activePaneId, DIRECTIONS[command]!) !== undefined
      );
    case "nextTab":
    case "previousTab":
      return tabTarget(command, deps) !== undefined;
    default:
      // The window and clipboard commands always apply (a missing selection must not send Ctrl+Shift+C to the
      // shell as an interrupt); `newWindow` is the menu's.
      return /^gotoTab[1-9]$/.test(command) ? tabTarget(command, deps) !== undefined : true;
  }
}

export async function runCommand(command: CommandId, deps: CommandDeps): Promise<void> {
  if (deps.shortcutsOpen && command !== "showShortcuts") return;
  const { store } = deps;
  const tab = activeTab(store.getState());
  const goTo = (target: LayoutTab | undefined): void => {
    if (!target) return;
    store.focusTab(target.id);
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
    case "previousTab":
      goTo(tabTarget(command, deps));
      return;
    case "splitRow":
    case "splitColumn":
      await splitActivePane(deps, command === "splitRow" ? "row" : "column");
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
    default:
      goTo(tabTarget(command, deps)); // gotoTab1 .. gotoTab9
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
