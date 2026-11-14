// Connects the output of the registry with the history store (spec history): every output of a session with
// `loggingEnabled` goes into its ring buffer, except the repaint of a redraw the registry requested.
import type { SessionId } from "@termdock/protocol";
import type { Disposable } from "../backend/types.js";
import type { HistoryStore } from "./history-store.js";

/** The part of `SessionRegistry` the recorder uses. */
export interface HistorySource {
  onOutput(
    listener: (event: { sessionId: SessionId; data: Uint8Array; fromRedraw: boolean }) => void,
  ): Disposable;
  /** Throws for an unknown session. */
  get(sessionId: SessionId): { loggingEnabled: boolean };
}

/** Records the output of all sessions of `registry` into `store`; dispose to stop. */
export function recordHistory(registry: HistorySource, store: HistoryStore): Disposable {
  // `loggingEnabled` is read from the session at each output, so switching it takes effect at once.
  return registry.onOutput(({ sessionId, data, fromRedraw }) => {
    // A repaint after an attach repeats what is on the screen (issue #88).
    if (fromRedraw) return;
    let loggingEnabled: boolean;
    try {
      loggingEnabled = registry.get(sessionId).loggingEnabled;
    } catch {
      return;
    }
    if (loggingEnabled) store.append(sessionId, data);
  });
}
