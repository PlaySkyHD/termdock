# Design: Terminal-Modi im Attach-Snapshot

## Context

Siehe proposal.md. Ursache im Code: `WslBackend.snapshot` (`packages/core/src/backend/wsl/commands.ts`, `snapshotArgs`/`parseSnapshot`) liefert `capture-pane -p -e -J` plus Cursorposition und `#{cursor_flag}`; `SessionRegistry.attachView` reicht das unverändert weiter, der Rohdaten-Puffer enthält nur die letzten 256 KiB. Keine Stelle liefert Modi. Der Desktop setzt nach `reset()` deshalb `ESC[?2004h` selbst (`TerminalController`, Option `bracketedPaste`).

Messung mit tmux 3.6 und der mitgelieferten ConPTY (Probe über `WslBackend.start`, Socket `termdock-test-probe42`):

- Beim Start schreibt die PTY u. a. `ESC[?1004h ESC[?9001h` (ConPTY), `ESC[?1049h ESC[?1h ESC=` (tmux `smcup`/`smkx`), `ESC[?2004h` (tmux schaltet Bracketed Paste am Client immer ein und filtert je Pane) und mehrfach `ESC[?1006l ESC[?1000l ESC[?1002l ESC[?1003l`.
- `set -g mouse on` ergibt am Client `ESC[?1006h ESC[?1000h ESC[?1002h`.
- `less` im Pane ändert am Client nichts: tmux hält den Client immer in DECCKM/Keypad und übersetzt Tasten selbst.
- Die tmux-Formate beschreiben das Pane, nicht den Client: mit `mouse on` und `less` meldet `display-message` `mouse_any_flag=0 mouse_sgr_flag=0 mouse_button_flag=0 mouse_all_flag=0`, `keypad_cursor_flag=1 keypad_flag=1`; `bracket_paste_flag` und `focus_flag` gibt es in tmux 3.6 nicht (leer).

## Goals / Non-Goals

**Goals:** Eine spät angehängte View hat dieselben Eingabe-Modi wie eine View, die die ganze Ausgabe gesehen hat, für tmux und für den Rohdaten-Puffer; kein Protokollwechsel.

**Non-Goals:** Alternate Screen (`?1049`), Cursorform (`DECSCUSR`), Cursor-Blinken (`?12`), Sichtbarkeit (`?25`, kommt schon aus `#{cursor_flag}`), `win32-input-mode` (`?9001`, xterm.js 6.0.0 kennt ihn nicht), Theme-Berichte (`?2031`), erweiterte Tasten. Kein Speichern der Modi in SQLite.

## Decisions

### Modi aus dem Ausgabestrom der Client-PTY, nicht aus tmux-Formaten

Gesucht sind die äußeren Modi des tmux-Clients, also was der xterm.js einer View setzen muss. Die Formate liefern die inneren Modi des Panes (Messung oben): Mausberichte stünden auf 0, obwohl tmux sie wegen `mouse on` am Client einschaltet, und für Bracketed Paste gibt es kein Format. Aus Formaten müsste der Core die Logik von tmux (`server_client_reset_state`, `tty_start_tty`) nachbauen, samt terminfo-Abhängigkeit von `smkx`. Der Strom der PTY ist genau das, was die erste View sieht, und gilt ebenso für Backends ohne tmux (Rohdaten-Puffer). Verworfen: Formate beim Snapshot (falsch für Maus, unvollständig), ein eigener `display-message` je Modus (zusätzliche `wsl.exe`-Aufrufe, gleiche Lücke).

### Verfolgung in der Registry, im Schritt der Ausgabe-Nummerierung

Ein reines Modul `packages/core/src/session/terminal-modes.ts` (`TerminalModes`: `feed(bytes)`, `reset()`, `sequence()`) wird in `bindPty` im selben synchronen Schritt gefüttert, in dem `outputSeq` steigt. `attachView` liest `sequence()` im selben Schritt wie die Marke und stellt sie dem Snapshot voran (Backend-Snapshot und Puffer). So passen Modi und Marke exakt zusammen; Ausgabe über der Marke bringt spätere Wechsel live. Die Backend-Schnittstelle (`backend/types.ts`, gemeinsamer Baustein) bleibt unverändert. Verworfen: Verfolgung in `WslPty` (die Registry ruft `snapshot` ohne PTY-Bezug auf, Windows-Puffer bliebe ohne Modi).

Über einen PTY-Wechsel (verlorener Client) laufen die Modi weiter; der neue tmux-Client setzt sie ohnehin neu. Der Parser beginnt beim Binden jeder PTY im Grundzustand (`endOfStream`), damit eine abgeschnittene Sequenz nicht mit Bytes der neuen PTY weiterläuft. `restart` (mit `clearOutput`) und `archive` setzen ihn mit dem Puffer zurück, weil ein neues Programm mit Grundzustand beginnt.

### Parser und Semantik

Bytezustandsautomat über Chunks hinweg, nur 7-Bit-Sequenzen:

- `ESC =` / `ESC >` und `CSI ? 66 h/l`: Application Keypad.
- `CSI ? Pm h/l` mit mehreren Parametern: `1` (DECCKM), `9`/`1000`/`1002`/`1003` (Mausprotokoll; Setzen wählt es, Zurücksetzen eines davon schaltet ab, wie xterm.js), `1006`/`1016` (Kodierung; Zurücksetzen fällt auf Standard; `1005` und `1015` ignoriert xterm.js, sie werden nicht verfolgt), `1004` (Fokus), `2004` (Bracketed Paste).
- C0-Steuerzeichen innerhalb einer Sequenz führt das Terminal aus, die Sequenz läuft weiter; CAN und SUB brechen sie ab, ESC beginnt eine neue (wie xterm.js). Im Grundzustand springt der Parser per `indexOf` zum nächsten ESC.
- `ESC c` (RIS) setzt alles zurück, `CSI ! p` (DECSTR) alles außer der Maus (wie xterm.js `softReset`).
- Andere Sequenzen werden übersprungen; eine unvollständige CSI-Sequenz über 64 Bytes wird verworfen (begrenzter Zustand, kein Puffer ohne Obergrenze).

`sequence()` erzeugt nur Sequenzen aus dieser festen Liste in fester Reihenfolge: `ESC[?1h`, `ESC=`, `ESC[?<Protokoll>h`, `ESC[?<Kodierung>h`, `ESC[?1004h`, `ESC[?2004h`; nur eingeschaltete Modi, weil die View vorher `reset()` aufruft. Beim Rohdaten-Puffer stimmt das Ergebnis ebenfalls: Wechsel im Puffer werden danach noch einmal abgespielt und enden im selben Zustand.

### Reihenfolge in der View

Der `TerminalController` ruft `reset()` und schreibt dann den Snapshot: Reset → Modi → Bildschirm → `ESC[0m`, Cursor, Sichtbarkeit (ADR 0003, #32). Die Option `bracketedPaste` entfällt.

### Keine Vertragsänderung

Die Modi stehen in den Snapshot-Bytes der Nutzdaten. `packages/protocol` und `PROTOCOL_VERSION` bleiben unverändert; ein Desktop ohne diesen Change schreibt die Sequenzen mit und funktioniert gleich.

## Risks / Trade-offs

- [Fokusberichte `?1004` stammen von der ConPTY] → Die erste View hat sie auch; xterm.js meldet den Fokus sofort beim Setzen, der Schreiber sendet `ESC[I`/`ESC[O`. Gemessen (WSL-Test „keeps the focus reports …“): die ConPTY schluckt sie, `cat -v` im Pane zeigt nur den Text, kein `^[[I`/`^[[O`. Leser verwerfen alles aus `onData`.
- [Ein Snapshot über 4 MiB wird vorn gekürzt (`server.ts`) und verliert den Präfix] → Puffer 256 KiB und tmux-Bildschirm liegen weit darunter; unverändertes Verhalten.
- [Sequenzen in DCS-Passthrough oder OSC könnten fälschlich zählen] → tmux schreibt an den Client keine solchen Modus-Sequenzen in Passthrough; Abweichung wäre ein falscher Modus bis zum nächsten Wechsel, kein Sicherheitsproblem, weil nur feste Sequenzen erzeugt werden.
- [Alternate Screen fehlt der späten View] → bewusst außerhalb, eigener Change, falls nötig.

## Migration Plan

Keine Datenmigration. Ein laufender Core ohne diesen Change kennt die Modi nicht; nach dem Update setzt der neue tmux-Client beim Wiederanbinden seine Modi erneut, sie stehen damit im Strom.
