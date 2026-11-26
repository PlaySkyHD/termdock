// What the explorer panel shows (#202): the session it follows and the folder of that session. Pure; the panel reads
// it from the store on every change, so a `cd`, a switch of tab or pane and the end of a run show at once.
import type { LayoutTab, LayoutWindow, SessionId, SessionInfo, SessionState } from "@termdock/protocol";
import type { FileLocation } from "../shared/files.js";
import { findPane, panesOf } from "./pane-tree.js";
import type { ViewRole } from "./terminal-controller.js";

export type ExplorerTarget =
  /** The window has no tab. */
  | { kind: "noTab" }
  /** The pane shows a session the store does not know (deleted, or the list is not there yet). */
  | { kind: "noSession"; sessionId: SessionId }
  /** The session has no live run, so no current directory. */
  | { kind: "notRunning"; session: SessionInfo; state: SessionState }
  /** The session runs, but its directory is not known (yet). */
  | { kind: "unknownCwd"; session: SessionInfo }
  | {
      kind: "folder";
      session: SessionInfo;
      location: FileLocation;
      /** Changes when the session or its folder changes: the panel lists anew and closes open folders. */
      key: string;
    };

const LIVE: ReadonlySet<SessionState> = new Set(["Running", "Detached"]);

/**
 * The pane the panel follows in `tab`: the active pane when it writes; otherwise a pane of the tab that writes (the
 * session the user types into); without a writer the active pane. `roleOf` is the role of the pane's view.
 */
export function explorerPaneId(tab: LayoutTab, roleOf: (paneId: string) => ViewRole | undefined): string {
  if (roleOf(tab.activePaneId) === "writer") return tab.activePaneId;
  const writer = panesOf(tab.root).find((pane) => roleOf(pane.id) === "writer");
  return writer?.id ?? (findPane(tab.root, tab.activePaneId) ? tab.activePaneId : panesOf(tab.root)[0]!.id);
}

/**
 * The location of the session's current directory: a Linux path in its distro, or a Windows path. A WSL session
 * that names no distro runs in the default distro of WSL (`defaultDistro`): the core pins it only after it reported
 * the new session (`session.created` comes before the start), and no later event carries the pinned one.
 */
export function sessionLocation(
  session: SessionInfo,
  cwd: string,
  defaultDistro?: string,
): FileLocation | undefined {
  if (session.launch.backend === "windows") return { backend: "windows", path: cwd };
  const distro = session.launch.distro ?? defaultDistro;
  return distro === undefined ? undefined : { backend: "wsl", distro, path: cwd };
}

/** What the panel of `window` shows; `defaultDistro` as for `sessionLocation`. */
export function explorerTarget(
  window: LayoutWindow,
  sessions: readonly SessionInfo[],
  roleOf: (paneId: string) => ViewRole | undefined,
  defaultDistro?: string,
): ExplorerTarget {
  const tab = window.tabs.find((each) => each.id === window.activeTabId);
  if (!tab) return { kind: "noTab" };
  const pane = findPane(tab.root, explorerPaneId(tab, roleOf))!;
  const session = sessions.find((each) => each.id === pane.sessionId);
  if (!session) return { kind: "noSession", sessionId: pane.sessionId };
  if (!LIVE.has(session.state)) return { kind: "notRunning", session, state: session.state };
  const cwd = session.currentCwd;
  const location = cwd === undefined ? undefined : sessionLocation(session, cwd, defaultDistro);
  if (!location) return { kind: "unknownCwd", session };
  const where = location.backend === "wsl" ? `wsl:${location.distro}` : "windows";
  return { kind: "folder", session, location, key: `${session.id}\n${where}\n${location.path}` };
}

/**
 * Whether the panel waits for the default distro of WSL: it follows a live WSL session with a known directory but
 * without a distro. Only then the window asks `wsl.distros` (a `wsl.exe` call in the core).
 */
export function needsDefaultDistro(target: ExplorerTarget): boolean {
  return (
    target.kind === "unknownCwd" &&
    target.session.launch.backend === "wsl" &&
    target.session.launch.distro === undefined &&
    target.session.currentCwd !== undefined
  );
}

/**
 * The path for the header, shortened from the left to at most `max` characters: the end of a path says more than
 * its start. The full path goes into the tooltip.
 */
export function shortPath(path: string, max = 48): string {
  if (path.length <= max) return path;
  return `…${path.slice(path.length - (max - 1))}`;
}
