// Current directory per session in the renderer (issue #199, ADR 0006): pure functions the store uses and that the
// file explorer (#202) reads with. Free of React and Electron.
import type { LayoutWindow, SessionId, SessionInfo, SessionState } from "@termdock/protocol";
import { findPane } from "./pane-tree.js";

/** Only a session with a live run has a current directory (protocol 1.8). */
const RUN_STATES: ReadonlySet<SessionState> = new Set(["Running", "Detached"]);

/**
 * The session with `cwd` as its current directory, or without one for undefined. A session outside `Running` and
 * `Detached` never keeps one, so a `cwdChanged` that is applied after the end of the run leaves none behind. Returns
 * `session` itself when nothing changes.
 */
export function withCurrentCwd(session: SessionInfo, cwd: string | undefined): SessionInfo {
  const next = RUN_STATES.has(session.state) ? cwd : undefined;
  if (session.currentCwd === next) return session;
  const { currentCwd: _old, ...rest } = session;
  return next === undefined ? rest : { ...rest, currentCwd: next };
}

/** What `relayCwd` needs of a view's controller: the directory its Windows shell reports (OSC 9;9, #200). */
export interface CwdSource {
  currentCwd(): string | undefined;
  onCwd(listener: (path: string) => void): () => void;
  /** The run ended: the next report is a change, also for the same path. */
  forgetCwd(): void;
}

/**
 * Puts the directory the view of `paneId` reports into the store as the directory of the pane's session (#202), so
 * the explorer reads Windows sessions (renderer, #200) and WSL sessions (core, #199) from one place. Several views of
 * a session report the same path; the store changes only when it differs. The store drops the directory when a run
 * ends; the view stays through a restart (#164), so it forgets its path then (`forgetCwd`) and the first report of
 * the new shell counts, also for the same path; a report that came before the store saw the new run live is taken
 * once it does. Returns the function that stops it; a pane that is not in the window relays nothing.
 */
export function relayCwd(
  store: {
    getState(): { readonly window: LayoutWindow; readonly sessions: readonly SessionInfo[] };
    subscribe(listener: () => void): () => void;
    sessionCwdChanged(sessionId: SessionId, cwd: string | undefined): void;
  },
  paneId: string,
  source: CwdSource,
): () => void {
  // A pane keeps its session for the life of its view: another session mounts a new view and controller.
  const sessionId = store
    .getState()
    .window.tabs.map((tab) => findPane(tab.root, paneId))
    .find((pane) => pane !== undefined)?.sessionId;
  if (sessionId === undefined) return () => {};
  const report = (path: string): void => store.sessionCwdChanged(sessionId, path);
  const refill = (): void => {
    const session = store.getState().sessions.find((each) => each.id === sessionId);
    if (!session) return;
    // The run ended: its path is not the next run's. The view forgets it, so whatever it knows later is the new run's.
    if (!RUN_STATES.has(session.state)) {
      source.forgetCwd();
      return;
    }
    // A report of the new shell that came while the store still said Starting was dropped there; take it now. This
    // settles after one report: the session then has a directory.
    const known = source.currentCwd();
    if (known !== undefined && session.currentCwd === undefined) report(known);
  };
  refill();
  const stopStore = store.subscribe(refill);
  const stopSource = source.onCwd(report);
  return () => {
    stopStore();
    stopSource();
  };
}

/** The current directory of the session (a Linux path for WSL), or undefined when unknown or the session is not known. */
export function currentCwdOf(
  state: { readonly sessions: readonly SessionInfo[] },
  sessionId: SessionId,
): string | undefined {
  return state.sessions.find((session) => session.id === sessionId)?.currentCwd;
}
