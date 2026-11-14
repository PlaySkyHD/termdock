# Design

## Kontext

Die PTY einer WSL-Session liefert den Strom des tmux-Clients, nachdem die ConPTY ihn neu gerendert hat. Fordert die Registry nach einem Anhängen `redraw` an, ruft das WSL-Backend `list-clients` und je Client `refresh-client` auf (zwei `wsl.exe`-Aufrufe, ADR 0003). tmux schreibt das Neuzeichnen in denselben Client-Strom wie die Programmausgabe. In den Bytes der PTY gibt es keine Herkunft: Die ConPTY setzt Ausgabe zu eigenen Frames zusammen, ein Neuzeichnen und Programmausgabe können im selben Datenblock stehen.

Messung (tmux 3.6, ConPTY 1.23, Socket `termdock-test`, 40×6, Leerlauf, drei Läufe): `backend.redraw` dauerte rund 270 ms. Das Neuzeichnen kam jedes Mal als ein Datenblock (`ESC[?25l … ESC[H`, jede Zeile mit `ESC[K`, Cursor) und 40 bis 50 ms bevor das Versprechen von `redraw` erfüllt war. Unabhängig davon zeichnet tmux etwa 5 s nach dem Start einer Session von selbst neu (`ESC[?7727h …`, Mausmodi aus, ganzer Bildschirm).

## Entscheidung

**Kennzeichnung über den Lauf des angeforderten Neuzeichnens.** Die Registry hält je Session schon `redraw` (läuft gerade ein Neuzeichnen, siehe `requestRedraw`). Jede Ausgabe, die eintrifft, solange dieser Eintrag gesetzt ist, bekommt im `OutputEvent` `fromRedraw: true`. Der Eintrag wird beim Anfordern im selben synchronen Schritt wie das Registrieren der View gesetzt und gelöscht, wenn `runRedraws` endet, also nach der Wiederholung eines gescheiterten Versuchs und nach einem zusammengefassten Folge-Neuzeichnen. `recordHistory` verwirft solche Ausgabe; Views, Rohpuffer und Modus-Verfolgung bekommen sie wie bisher.

Die Grenzen sind Ereignisse im Core (Anfordern, Ende des Backend-Aufrufs), keine geschätzte Dauer. Dass das Neuzeichnen vor dem Ende des Aufrufs ankommt, folgt aus dem Ablauf: tmux schreibt das Neuzeichnen in derselben Runde seiner Ereignisschleife, in der es `refresh-client` beendet; der Aufrufer erfährt das Ende erst über das Beenden von `tmux` und `wsl.exe`. Gemessen lag das Neuzeichnen immer davor.

**Feld statt Ausblenden in der Registry.** Die Registry meldet weiterhin jede Ausgabe; sie entscheidet nicht über den Verlauf. Der Recorder ist der einzige Verbraucher, der das Feld liest. Das IPC-Event `session.output` übernimmt es nicht (der Server liest nur `sessionId`, `seq`, `data`, `viewIds`): Views stellen das Neuzeichnen dar wie jede Ausgabe, ein Protokollfeld hätte keinen Nutzer.

## Grenzen

- Programmausgabe, die während des Laufs eintrifft (rund 0,3 s je Anhängen, bei Fehlern länger), fehlt im Verlauf. Ihr sichtbares Ergebnis steht im neu gezeichneten Bildschirm, der ebenfalls nicht gespeichert wird. Das ist der Preis für eine Grenze ohne Schätzung; wiederholte Bildschirme bei jedem Tab-Wechsel wiegen für Suche und Ringpuffer schwerer.
- Kommt das Neuzeichnen erst nach dem Ende des Aufrufs an (ConPTY stark verzögert), wird es gespeichert wie vor dieser Änderung.
- Neuzeichnen, das tmux von selbst auslöst, wird gespeichert; der Core fordert es nicht an und kennt es nicht.
- Windows-Sessions haben kein Neuzeichnen (Snapshot aus dem Rohpuffer), für sie ändert sich nichts.

## Verworfene Alternativen

- **Festes Zeitfenster nach dem Anhängen:** Die Dauer hängt von WSL-Start, Last und Anzahl der Clients ab; jede feste Zahl ist entweder zu kurz (Wiederholung im Verlauf) oder zu lang (Ausgabe fehlt).
- **Marker im Strom über `refresh-client -l`:** tmux schreibt dabei eine OSC-52-Abfrage (`ESC]52;;?BEL`) in den Client-Strom, und sie kommt durch die ConPTY (gemessen). Die Reihenfolge zum Neuzeichnen wäre exakt. Aber tmux lässt je Client nur eine offene Abfrage zu und wartet bis zu 5 s auf Antwort; schnelle Tab-Wechsel bekämen keinen Marker. Ohne Antwort hängt der Zustand, eine Antwort des Core legte Paste-Buffer in tmux an, und die Abfrage müsste vor den Views entfernt werden, sonst fragt sie deren Zwischenablage ab.
- **Synchronized Output (`ESC[?2026h/l`) oder Fenstertitel als Klammer:** tmux sendet `?2026` nur mit der Fähigkeit `sync` und dann auch um normale Ausgabe; einen gesetzten Titel gab die ConPTY im Versuch nicht weiter.
- **Vergleich mit dem Snapshot:** Die Bytes des Neuzeichnens weichen von `capture-pane` ab (andere Sequenzen, Zeilenenden, Cursor), ein Vergleich wäre eine Schätzung über den Inhalt.
- **Backend meldet den genauen Beginn (`refresh-client`):** Würde den Lauf um `list-clients` verkürzen, ändert aber die gemeinsame Backend-Schnittstelle (`backend/types.ts`) und beseitigt die Grenze nicht.

## Risiken

- Ein langes Neuzeichnen (WSL hängt, Zeitlimit der `wsl.exe`-Aufrufe) verlängert den Lauf; so lange wird nichts gespeichert. Die Aufrufe haben ein Zeitlimit, danach endet der Lauf mit `onRedrawError`.
