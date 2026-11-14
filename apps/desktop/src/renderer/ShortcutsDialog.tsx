// Overview of the key bindings (#28): a small dialog over the window, fed by the key map. Escape, the button and a
// click on the backdrop close it; the keys of the map still work, Ctrl+Shift+H toggles it.
import { useEffect, useRef } from "react";
import { overviewRows } from "./keymap.js";

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Takes the focus from the terminal, so Escape closes the dialog instead of reaching the shell.
    close.current?.focus();
  }, []);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        data-dialog="shortcuts"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 className="dialog__title" id="shortcuts-title">
          Tastenkürzel
        </h2>
        <table className="shortcuts">
          <tbody>
            {overviewRows().map((row) => (
              <tr key={row.command} data-command={row.command}>
                <td>{row.label}</td>
                <td className="shortcuts__keys">
                  <kbd>{row.shortcut}</kbd>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="dialog__note">
          Alle anderen Tasten, auch Strg+C und Strg+B (tmux), gehen unverändert an die Shell. Rechtsklick fügt
          ein; Einfügen gilt nur im schreibenden Pane.
        </p>
        <p className="dialog__note" data-note="same-session">
          Teilen startet eine neue Session. Dieselbe Session in einem weiteren Pane: Umschalt+Klick in der
          Seitenleiste; das Pane liest mit, bis du „Eingabe übernehmen“ wählst oder doppelt hineinklickst.
        </p>
        <div className="dialog__actions">
          <button className="button button--primary" type="button" ref={close} onClick={onClose}>
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
