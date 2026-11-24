// Update dialog (#136): a downloaded update asks "Jetzt neu starten" or "Später". Not modal and without the focus
// when it appears: the download ends at any moment, often while the user types, and the keys must stay in the
// terminal. Escape inside the dialog means "Später". The answer counts for every window (main process).
import { useEffect, useState } from "react";
import type { SessionInfo } from "@termdock/protocol";
import type { TermdockApi, UpdateChoice } from "../shared/bridge.js";
import { countActiveWindows } from "../shared/quit-decision.js";
import {
  NO_UPDATE_OFFER,
  nextUpdateOffer,
  updateMessage,
  updateSessionsNote,
} from "../shared/update-decision.js";

export function UpdateDialog({
  api,
  sessions,
  onAnswered,
}: {
  api: Pick<TermdockApi, "updateState" | "answerUpdate" | "onEvent">;
  /** The sessions of the window's store: the note names the Windows shells that end with the core. */
  sessions: readonly SessionInfo[];
  /** After a click: the terminal takes the keys again. */
  onAnswered: () => void;
}) {
  const [offer, setOffer] = useState(NO_UPDATE_OFFER);
  useEffect(() => {
    const stop = api.onEvent((event) => {
      if (event.kind === "updateChanged")
        setOffer((current) => nextUpdateOffer(current, { kind: "event", version: event.version }));
    });
    // A page that loads after the download asks once; an event that came meanwhile wins.
    api
      .updateState()
      .then((state) =>
        setOffer((current) => nextUpdateOffer(current, { kind: "state", version: state.version })),
      )
      .catch((error: unknown) => console.error(error));
    return stop;
  }, [api]);

  if (offer.version === undefined) return null;
  const answer = (choice: UpdateChoice): void => {
    // The main process hides the offer in every window with `updateChanged`; this one at once.
    setOffer((current) => nextUpdateOffer(current, { kind: "event" }));
    api.answerUpdate(choice).catch((error: unknown) => console.error(error));
    onAnswered();
  };
  return (
    <div
      className="dialog update-dialog"
      role="dialog"
      aria-modal="false"
      aria-labelledby="update-title"
      aria-describedby="update-sessions"
      data-dialog="update"
      data-update-version={offer.version}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        answer("later");
      }}
    >
      <h2 className="dialog__title" id="update-title" data-update="message">
        {updateMessage(offer.version)}
      </h2>
      <p className="dialog__text" id="update-sessions" data-update="sessions">
        {updateSessionsNote(countActiveWindows(sessions))}
      </p>
      <div className="dialog__actions dialog__actions--wrap">
        <button className="button" type="button" data-update-choice="later" onClick={() => answer("later")}>
          Später
        </button>
        <button
          className="button button--primary"
          type="button"
          data-update-choice="install"
          onClick={() => answer("install")}
        >
          Jetzt neu starten
        </button>
      </div>
    </div>
  );
}
