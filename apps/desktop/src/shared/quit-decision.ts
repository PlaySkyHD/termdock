// Quit decision (issue #60, concept chapters 2 and 6): whether quitting asks, and what an answer means. Pure, so
// the main process, the renderer and the tests share it. No Electron, no I/O.
import type { QuitAction, SessionState, SettingsPatch } from "@termdock/protocol";

/** `user`: menu, Ctrl+Q, closing the last window. `session-end`: Windows logoff or shutdown. */
export type QuitReason = "user" | "session-end";

/** What the user picked in the dialog. */
export type QuitChoice = QuitAction | "cancel";

/** The answer of the dialog; `remember` is the checkbox "Nicht mehr fragen". */
export interface QuitAnswer {
  choice: QuitChoice;
  remember: boolean;
}

/** The part of the settings the decision reads (`Settings` fits). */
export interface QuitSettings {
  confirmQuitWhileRunning: boolean;
  quitAction?: QuitAction | undefined;
}

/** `quit`: go on without asking; `ask`: show the dialog. */
export type QuitPlan = { kind: "quit"; stopSessions: boolean } | { kind: "ask" };

/** `cancel`: the app keeps running. `quit`: it quits; `remember` is what to store before. */
export type QuitOutcome =
  { kind: "cancel" } | { kind: "quit"; stopSessions: boolean; remember?: SettingsPatch };

/** Sessions the user would lose or leave behind: the ones whose process lives (`Running`, `Detached`). */
export function countActive(sessions: readonly { state: SessionState }[]): number {
  return sessions.filter((session) => session.state === "Running" || session.state === "Detached").length;
}

/**
 * Without a running session nothing is at stake, so quitting never asks and keeps what is there. The end of the
 * Windows session never asks either and keeps the sessions. Otherwise the stored choice applies when the user
 * turned the question off (a missing action means "keepSessions"), and the dialog opens when not.
 */
export function planQuit(input: {
  reason: QuitReason;
  activeSessions: number;
  settings: QuitSettings;
}): QuitPlan {
  if (input.reason === "session-end" || input.activeSessions === 0)
    return { kind: "quit", stopSessions: false };
  if (input.settings.confirmQuitWhileRunning) return { kind: "ask" };
  return { kind: "quit", stopSessions: input.settings.quitAction === "stopSessions" };
}

/**
 * What the answer of the dialog means. Cancel never stores anything, also with the checkbox set: the user did
 * not choose an action. A choice with the checkbox stores that the question is off and which action applies.
 */
export function outcomeOfAnswer(answer: QuitAnswer): QuitOutcome {
  if (answer.choice === "cancel") return { kind: "cancel" };
  const stopSessions = answer.choice === "stopSessions";
  return answer.remember
    ? { kind: "quit", stopSessions, remember: { confirmQuitWhileRunning: false, quitAction: answer.choice } }
    : { kind: "quit", stopSessions };
}

/** The sentence of the dialog. */
export function quitMessage(activeSessions: number): string {
  return activeSessions === 1 ? "1 Session läuft noch." : `${activeSessions} Sessions laufen noch.`;
}
