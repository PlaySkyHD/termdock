# Proposal

## Why

Die Verlauf-Suche (#62) entfernt Steuerzeichen beim Lesen, auch Backspace und `ESC[K`. Korrigiert der Nutzer einen Tippfehler, schreibt die Shell Backspace und „Rest der Zeile löschen“; die Suche zeigt dann die Zeile samt Tippfehler (belegt im Verlauf einer Session, #102). Ebenso überschreibt ein `\r` ohne `\n` (Fortschrittsbalken, Readline-Neuzeichnen) die Zeile nicht. Treffer zeigen so Text, den das Terminal nie angezeigt hat, und Suchen nach der abgeschickten Zeile schlagen fehl.

## What Changes

- Beim Zusammensetzen einer Trefferzeile gilt ein einfaches Zeilenmodell mit Cursor: Zeichen überschreiben an der Cursorposition oder hängen an, Backspace setzt den Cursor um eins zurück (nie vor den Anfang), `ESC[K` und `ESC[0K` löschen ab dem Cursor, `\r` setzt den Cursor an den Anfang, `\n` beendet die Zeile.
- Alle anderen Sequenzen werden weiterhin nur entfernt, nie interpretiert.
- Zeitstempel, Position des Treffers und Grenzen (Zeilenpuffer, Treffer, Zeit) bleiben; das Zeilenmodell arbeitet über Eintragsgrenzen.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `history`: neue Anforderung „Trefferzeilen wie im Terminal“ (ADDED).

## Impact

- Nur `packages/core` (`storage/history-search.ts` und Test). Kein Vertragswechsel, keine neue Dependency, keine UI-Änderung.
- Non-Goals: Cursorbewegungen über `\b`, `\r` und `ESC[K` hinaus (`ESC[D`, `ESC[P`, `ESC[@`, `ESC[2K`), Bildschirmmodell, Alternate Screen.
- Security: Terminal-Ausgabe bleibt Daten; es werden nur Zeichen in einem Zeilenpuffer ersetzt, nichts ausgeführt.
- Breaking Changes: Eine Zeile, die mit `\r` neu beginnt, ersetzt jetzt die vorherige Anzeige (vorher zwei Treffer: jede Zwischenstufe), und eine Zeile mit Tippfehler ist nicht mehr auffindbar.
