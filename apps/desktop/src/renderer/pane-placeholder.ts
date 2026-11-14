// What a pane shows for its session (#29, ADR 0005): a terminal view for a living process, a placeholder otherwise.
// A restored layout can name sessions that ended, were interrupted or are gone; none of them may look running.
// Pure, no DOM.
import type { SessionInfo } from "@termdock/protocol";
import { endedNotice, isAttachable } from "./session-display.js";

export type PaneContent =
  | { kind: "terminal" }
  /** The first list of sessions has not arrived; the pane cannot yet tell a missing session from an unknown one. */
  | { kind: "loading" }
  | {
      kind: "placeholder";
      title: string;
      detail: string;
      /** Protocol name of the state; `Fehlt` when the core has no such session. */
      state: string;
      /** Last exit code as text, `unbekannt` when there is none. */
      exitCode: string;
    };

export function paneContent(session: SessionInfo | undefined, sessionsLoaded: boolean): PaneContent {
  if (session === undefined) {
    if (!sessionsLoaded) return { kind: "loading" };
    return {
      kind: "placeholder",
      title: "Session nicht gefunden",
      detail: "Der Core kennt diese Session nicht (mehr).",
      state: "Fehlt",
      exitCode: "unbekannt",
    };
  }
  if (isAttachable(session.state)) return { kind: "terminal" };
  const notice = endedNotice(session);
  return {
    kind: "placeholder",
    title: notice?.title ?? session.state,
    detail: notice?.detail ?? "",
    state: session.state,
    exitCode: session.lastExitCode === undefined ? "unbekannt" : String(session.lastExitCode),
  };
}
