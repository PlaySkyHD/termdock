## ADDED Requirements

### Requirement: Trefferzeilen wie im Terminal

Die Suche SHALL jede Zeile so zusammensetzen, wie das Terminal sie anzeigte: Zeichen überschreiben am Cursor, Backspace setzt ihn um eins zurück (nie vor den Anfang), `ESC[K` und `ESC[0K` löschen ab dem Cursor, `\r` setzt ihn an den Anfang, `\n` beendet die Zeile. Zeile und Position eines Treffers MUST aus dieser fertigen Zeile stammen. Andere Sequenzen SHALL nur entfernt, nie interpretiert werden; die Grenzen der Suche gelten unverändert, auch über Eintragsgrenzen.

#### Scenario: Tippfehler mit Backspace

- **GIVEN** ein Verlauf mit der Ausgabe `echo Apfelk`, `i`, `u`, `c`, `h`, viermal Backspace mit `ESC[K`, dann `u`, `c`, `h`, `e`, `n`
- **WHEN** der Client „echo“ sucht
- **THEN** zeigt der Treffer „echo Apfelkuchen“ mit der Position des Treffers in dieser Zeile, und eine Suche nach „kiu“ findet nichts

#### Scenario: Überschreiben mit Wagenrücklauf

- **GIVEN** die Ausgabe `10%\r20%\r100%\r\n`
- **WHEN** der Client „%“ sucht
- **THEN** liefert der Core genau eine Zeile „100%“

#### Scenario: Backspace über Grenzen

- **GIVEN** ein Backspace im nächsten Eintrag als die Zeile, oder am Anfang der Zeile
- **WHEN** der Client sucht
- **THEN** wirkt der Backspace auf die Zeile, und der Cursor bleibt am Anfang, statt davor zu liegen
