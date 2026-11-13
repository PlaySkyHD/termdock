## MODIFIED Requirements

### Requirement: Snapshot für neue Views

Beim Anhängen SHALL eine View einen Snapshot erhalten. Liefert das Backend einen eigenen Bildschirminhalt, MUST dieser verwendet werden, ergänzt um Ausgabe, die während der Abfrage eintraf, dann entfällt das Feld `cursor`. Liefert das Backend nichts oder schlägt die Abfrage fehl, MUST der Inhalt des Rohdaten-Puffers verwendet werden. Der Puffer MUST auf die letzten 256 KiB Ausgabe je Session begrenzt sein.

#### Scenario: Fallback auf den Puffer

- **GIVEN** ein Backend ohne eigenen Snapshot und eine Session, die 300 KiB ausgegeben hat
- **WHEN** eine View angehängt wird
- **THEN** enthält ihr Snapshot genau die letzten 256 KiB der Ausgabe

#### Scenario: Snapshot des Backends

- **GIVEN** ein Backend, das für die Session einen Bildschirminhalt mit Cursor liefert
- **WHEN** eine View angehängt wird
- **THEN** enthält ihr Snapshot diese Daten und das Feld `cursor`

#### Scenario: Ausgabe während der Snapshot-Abfrage

- **GIVEN** ein Backend, das Bildschirminhalt mit Cursorposition liefert
- **WHEN** während der Abfrage weitere Ausgabe eintrifft
- **THEN** enthält der Snapshot den Bildschirminhalt gefolgt von dieser Ausgabe und kein Feld `cursor`

#### Scenario: Snapshot-Abfrage schlägt fehl

- **GIVEN** ein Backend, dessen Snapshot-Abfrage fehlschlägt
- **WHEN** eine View angehängt wird
- **THEN** gelingt das Anhängen und der Snapshot enthält den Rohdaten-Puffer
