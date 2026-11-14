// Quit dialog (#60): shown when the app is about to quit while sessions run. Three choices and "Nicht mehr
// fragen"; Escape cancels. A click on the backdrop does nothing, so a stray click never quits.
import { useEffect, useRef, useState } from "react";
import { quitMessage } from "../shared/quit-decision.js";
import { trapFocus } from "./focus-trap.js";
import type { QuitAnswer } from "../shared/quit-decision.js";

export function QuitDialog({
  activeSessions,
  onAnswer,
}: {
  activeSessions: number;
  onAnswer: (answer: QuitAnswer) => void;
}) {
  const [remember, setRemember] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Takes the focus from the terminal; the default is the behavior of closing so far: keep the sessions.
    keep.current?.focus();
    // aria-modal alone does not hold the focus: Tab must not reach the terminal behind (its keys would go to the
    // session), and a focus that escapes comes back.
    return dialog.current ? trapFocus(dialog.current, () => keep.current) : undefined;
  }, []);
  // Escape cancels wherever the focus is: a click beside the dialog must not leave it without a way out.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onAnswer({ choice: "cancel", remember: false });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onAnswer]);
  const answer = (choice: QuitAnswer["choice"]): void => onAnswer({ choice, remember });
  return (
    // A press on the backdrop must not take the focus from the dialog (and give it to the terminal behind).
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && event.preventDefault()}
    >
      <div
        className="dialog"
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="quit-title"
        aria-describedby="quit-message"
        data-dialog="quit"
      >
        <h2 className="dialog__title" id="quit-title">
          TermDock beenden?
        </h2>
        <p className="dialog__text" id="quit-message" data-quit="message">
          {quitMessage(activeSessions)} Sie können weiterlaufen, auch wenn die Oberfläche geschlossen ist.
        </p>
        <label className="dialog__check">
          <input
            type="checkbox"
            data-quit="remember"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          Nicht mehr fragen
        </label>
        <div className="dialog__actions dialog__actions--wrap">
          <button
            className="button"
            type="button"
            data-quit-choice="cancel"
            onClick={() => onAnswer({ choice: "cancel", remember: false })}
          >
            Abbrechen
          </button>
          <button
            className="button button--danger"
            type="button"
            data-quit-choice="stopSessions"
            onClick={() => answer("stopSessions")}
          >
            Sessions beenden
          </button>
          <button
            className="button button--primary"
            type="button"
            ref={keep}
            data-quit-choice="keepSessions"
            onClick={() => answer("keepSessions")}
          >
            Oberfläche schließen, Sessions behalten
          </button>
        </div>
      </div>
    </div>
  );
}
