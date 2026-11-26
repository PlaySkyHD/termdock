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
 * The pane that "Pfad ins Terminal einfügen" (#203) writes into: the pane the panel follows, if its view writes. It is
 * the writer of the panel's session in `tab`: `explorerPaneId` prefers a writing pane, so without it the tab has none.
 * Undefined without a writer; the entry is disabled then (input lock).
 */
export function pastePaneId(
  tab: LayoutTab,
  roleOf: (paneId: string) => ViewRole | undefined,
): string | undefined {
  const paneId = explorerPaneId(tab, roleOf);
  return roleOf(paneId) === "writer" ? paneId : undefined;
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

/** What a window knows of the default distro of WSL, per core generation (`wsl.distros`). */
export interface DistroLookup {
  generation: number;
  /** The answer named one. Only an answer with a name is kept for good. */
  name?: string;
  /** Answers without a name or failures in a row. */
  failures: number;
  /** Not asked again before this time (ms); 0 after an answer with a name. */
  retryAt: number;
}

/** The longest wait between two questions after failures. */
export const DISTRO_RETRY_MAX_MS = 60_000;
const DISTRO_RETRY_FIRST_MS = 2_000;

/** The known default distro for `generation`, if any. */
export function knownDistro(lookup: DistroLookup | undefined, generation: number): string | undefined {
  return lookup?.generation === generation ? lookup.name : undefined;
}

/**
 * Whether the window asks `wsl.distros` now: the panel needs it, nothing is known for this core generation, and the
 * wait after a failure is over. The window checks again on every render, e.g. at the next `cwdChanged`.
 */
export function asksDistro(
  lookup: DistroLookup | undefined,
  generation: number,
  needed: boolean,
  now: number,
): boolean {
  if (!needed) return false;
  if (lookup?.generation !== generation) return true;
  return lookup.name === undefined && now >= lookup.retryAt;
}

/**
 * The lookup after an answer (`name`, or undefined for a failure or an answer without one, e.g. `unavailable`).
 * Failures wait 2 s, 4 s, 8 s … up to `DISTRO_RETRY_MAX_MS` before the next question; nothing failed is kept for good.
 */
export function distroAnswered(
  lookup: DistroLookup | undefined,
  generation: number,
  name: string | undefined,
  now: number,
): DistroLookup {
  if (name !== undefined) return { generation, name, failures: 0, retryAt: 0 };
  const failures = (lookup?.generation === generation ? lookup.failures : 0) + 1;
  const wait = Math.min(DISTRO_RETRY_MAX_MS, DISTRO_RETRY_FIRST_MS * 2 ** (failures - 1));
  return { generation, failures, retryAt: now + wait };
}

/**
 * The path for the header, shortened from the left to at most `max` characters: the end of a path says more than
 * its start. The full path goes into the tooltip.
 */
export function shortPath(path: string, max = 48): string {
  if (path.length <= max) return path;
  return `…${path.slice(path.length - (max - 1))}`;
}
