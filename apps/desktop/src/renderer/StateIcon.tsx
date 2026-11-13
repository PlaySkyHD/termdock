import type { SessionInfo } from "@termdock/protocol";
import { stateText } from "./session-display.js";

/** Shape and colour of a session state; only `Running` is a filled green dot (ADR 0005). */
export function StateIcon({ session }: { session: SessionInfo }) {
  const text = stateText(session);
  return (
    <span
      className={`state-icon state-icon--${session.state.toLowerCase()}`}
      role="img"
      aria-label={text}
      title={text}
    />
  );
}
