// Current directory per session in the renderer (issue #199, ADR 0006): pure functions the store uses and that the
// file explorer (#202) reads with. Free of React and Electron.
import type { SessionId, SessionInfo, SessionState } from "@termdock/protocol";

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

/** The current directory of the session (a Linux path for WSL), or undefined when unknown or the session is not known. */
export function currentCwdOf(
  state: { readonly sessions: readonly SessionInfo[] },
  sessionId: SessionId,
): string | undefined {
  return state.sessions.find((session) => session.id === sessionId)?.currentCwd;
}
