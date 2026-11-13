// Session state machine. Single source of the allowed transitions (ADR 0005).
import type { SessionState } from "@termdock/protocol";
import { CoreError } from "./errors.js";

const TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  Starting: ["Running", "Interrupted", "Exited"],
  Running: ["Detached", "Exited", "Interrupted", "Archived"],
  Detached: ["Running", "Exited", "Interrupted", "Archived"],
  Exited: ["Starting", "Archived"],
  Interrupted: ["Starting", "Archived"],
  Archived: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Returns `to` when the transition is allowed, otherwise throws `CoreError` with code `invalid_state`. */
export function transition(from: SessionState, to: SessionState): SessionState {
  if (!canTransition(from, to)) {
    throw new CoreError("invalid_state", `Session cannot change from ${from} to ${to}`);
  }
  return to;
}
