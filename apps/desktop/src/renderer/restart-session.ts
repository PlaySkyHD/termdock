// "Neu starten" of an ended or interrupted session (#156): what the pane's placeholder, the bar of an attached view
// (#164) and the sidebar's menu do with the core's answer. Pure, no DOM; the session's new state comes with the
// core's events.
import type { SessionInfo, SessionState } from "@termdock/protocol";
import { failureText } from "./dialog-state.js";
import { canRestart, endedNotice, isAttachable } from "./session-display.js";
import type { ViewRole } from "./terminal-controller.js";

/** The placeholder's button: a restart in flight disables it, a refusal stays shown until the next click. */
export interface RestartStatus {
  running: boolean;
  /** Message of the last refusal (`backend_unavailable`, `invalid_state`, a timeout). */
  error: string | undefined;
}

export const RESTART_IDLE: RestartStatus = { running: false, error: undefined };

/**
 * Starts a restart from the placeholder unless one runs (`undefined`, nothing sent). `update` receives the running
 * state at once and, when the core answers, the idle state with the refusal if there was one. The returned promise
 * settles after that last update and never rejects.
 */
export function restartFromPlaceholder(
  current: RestartStatus,
  restart: () => Promise<void>,
  update: (status: RestartStatus) => void,
): Promise<void> | undefined {
  if (current.running) return undefined;
  update({ running: true, error: undefined });
  return restart().then(
    () => update(RESTART_IDLE),
    (error: unknown) => update({ running: false, error: failureText(error) }),
  );
}

/** Text of a reader's hint: only the writing view restarts, like only it types (ADR 0003). */
export const READER_RESTART_HINT = "Zum Neustarten zuerst die Eingabe übernehmen.";

/**
 * The bar of an attached view whose session ended (#164): the writer gets the button, a reader only the hint.
 * Nothing while the session lives or starts, and nothing in a view without a role yet or without the core (its
 * own notice covers the pane then).
 */
export type RestartBar =
  | { kind: "button"; title: string; detail: string; running: boolean; error: string | undefined }
  | { kind: "hint"; title: string; detail: string };

export function restartBar(
  session: SessionInfo | undefined,
  role: ViewRole | undefined,
  status: RestartStatus,
): RestartBar | undefined {
  if (session === undefined || !canRestart(session.state)) return undefined;
  const notice = endedNotice(session);
  const title = notice?.title ?? session.state;
  if (role === "writer")
    return {
      kind: "button",
      title,
      detail: notice?.detail ?? "",
      running: status.running,
      error: status.error,
    };
  if (role === "reader") return { kind: "hint", title, detail: READER_RESTART_HINT };
  return undefined;
}

/**
 * Whether the session's new state ends the last refusal (#164): it lives again or is archived. A failed restart runs
 * `Starting → Interrupted`, and that event may reach the pane in the same render as the refusal, so these states and
 * `Exited` keep it; a new click clears it anyway.
 */
export function clearsRestartError(state: SessionState): boolean {
  return isAttachable(state) || state === "Archived";
}

/**
 * The status without a refusal that no longer applies (#164): applied when the state changes and when the core's
 * answer arrives. A refusal that arrives after the session already lives again (a timeout of the client while the
 * core still started it) is dropped, so it cannot show up when the session ends later.
 */
export function withoutStaleRefusal(status: RestartStatus, state: SessionState | undefined): RestartStatus {
  if (status.error === undefined || state === undefined || !clearsRestartError(state)) return status;
  return { ...status, error: undefined };
}

/** The sidebar's menu entry: a refusal goes to the status bar (`notice`). Never rejects. */
export function restartFromMenu(
  restart: () => Promise<void>,
  notice: (message: string) => void,
): Promise<void> {
  return restart().catch((error: unknown) => notice(failureText(error)));
}
