# Design

## Context

`attachView` fragt `backend.snapshot` ab und sammelt in der Zwischenzeit eintreffende Ausgabe (`inFlight`). Bisher wurde bei vorhandener Ausgabe `{ data: snapshot + inFlight }` ohne Cursor geliefert, sonst `{ data, cursor }`. Die Views (xterm.js) werten `cursor` nicht aus.

## Goals / Non-Goals

**Goals:**

- Nach dem Schreiben des Snapshots steht der Cursor an der Position des Backends, auch wenn Ausgabe folgt.

**Non-Goals:**

- Protokoll, Desktop-App, Windows-Pfad.

## Decisions

- Das WSL-Backend (`parseSnapshot`) baut die Terminal-Bytes und hängt `ESC[0m` (SGR-Reset, die Farbe der letzten Zelle soll nicht in Folgeausgabe laufen), `ESC[<y+1>;<x+1>H` (Backend-Cursor 0-basiert, CUP 1-basiert) und `ESC[?25h` bzw. `ESC[?25l` an (tmux `#{cursor_flag}` 0 = verborgen, z. B. htop). Die Registry hängt Ausgabe der Aufnahme dahinter. Alternative: die Registry hängt die Positionierung an; verworfen, weil das Backend die Bytes schon baut und Sichtbarkeit kennt.
- Bildschirm, Cursor und Sichtbarkeit kommen aus einem tmux-Aufruf (`capture-pane ; display-message` in einem `wsl.exe`-Aufruf), Ausgabe dazwischen trennt sie nicht.
- Das Feld `cursor` bleibt bei unveränderter Ausgabe erhalten und entfällt bei angehängter Ausgabe (es wäre veraltet). Das Protokoll bleibt unverändert.
- Ohne Cursor im Backend-Snapshot bleiben die Daten unverändert.
- Bekannte Grenze: Steht Ausgabe, die während der Aufnahme eintrifft, schon im Bildschirm, erscheint sie doppelt (älteres Rennen, eigenes Issue).

## Risks / Trade-offs

- Der Snapshot enthält mit der Sequenz ein Byte-Suffix mehr; Views, die Leerzeilen am Ende abschneiden, sehen die Sequenz als letzte Daten (siehe #24, wird dort entfernt).
