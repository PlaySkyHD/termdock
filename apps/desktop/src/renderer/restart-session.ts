// "Neu starten" of an ended or interrupted session (#156): what the pane's placeholder and the sidebar's menu do
// with the core's answer. Pure, no DOM; the session's new state comes with the core's events.
import { failureText } from "./dialog-state.js";

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

/** The sidebar's menu entry: a refusal goes to the status bar (`notice`). Never rejects. */
export function restartFromMenu(
  restart: () => Promise<void>,
  notice: (message: string) => void,
): Promise<void> {
  return restart().catch((error: unknown) => notice(failureText(error)));
}
