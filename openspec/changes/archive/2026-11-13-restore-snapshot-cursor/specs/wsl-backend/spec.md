## ADDED Requirements

### Requirement: Cursor im Snapshot

`snapshot` MUST Bildschirm und Cursor in einem tmux-Aufruf abfragen und nach dem Bildschirm `ESC[0m`, `ESC[y+1;x+1H` und `ESC[?25h` liefern, bei von tmux als verborgen gemeldetem Cursor `ESC[?25l`.

#### Scenario: Cursor im Snapshot

- **GIVEN** ein Bildschirm, dessen Cursor bei Spalte 9, Zeile 4 (0-basiert) sichtbar steht
- **WHEN** `snapshot` aufgerufen wird
- **THEN** enden die Daten mit `ESC[0m ESC[5;10H ESC[?25h`
