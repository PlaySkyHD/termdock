## MODIFIED Requirements

### Requirement: Snapshot für neue Views

Beim Anhängen SHALL eine View einen Snapshot erhalten. Liefert das Backend einen eigenen Bildschirminhalt, MUST dieser unverändert verwendet werden, samt Feld `cursor`; Ausgabe, die während der Abfrage eintrifft, MUST NOT angehängt werden. Liefert das Backend nichts oder schlägt die Abfrage fehl, MUST der Inhalt des Rohdaten-Puffers verwendet werden. Der Puffer MUST auf die letzten 256 KiB Ausgabe je Session begrenzt sein.

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
- **THEN** enthält der Snapshot nur den Bildschirminhalt mit dem Feld `cursor`, und die neue View erhält diese Ausgabe nicht

#### Scenario: Snapshot-Abfrage schlägt fehl

- **GIVEN** ein Backend, dessen Snapshot-Abfrage fehlschlägt
- **WHEN** eine View angehängt wird
- **THEN** gelingt das Anhängen und der Snapshot enthält den Rohdaten-Puffer

## ADDED Requirements

### Requirement: Grenze zwischen Snapshot und Live-Ausgabe

Der Core SHALL die Ausgabe jeder Session fortlaufend ab 1 nummerieren und jedes Ausgabeereignis mit seiner Nummer melden. Beim Anhängen SHALL er als Marke die Nummer der letzten Ausgabe vor dem Registrieren der View liefern (0 ohne Ausgabe). Die View MUST genau die Ausgabe mit höherer Nummer erhalten; die Nummern MUST über einen Wechsel der PTY hinweg weiterlaufen.

#### Scenario: Marke beim Anhängen

- **GIVEN** eine Session, deren PTY dreimal Daten ausgegeben hat, und eine angehängte View A
- **WHEN** View B angehängt wird und die PTY danach Daten ausgibt
- **THEN** liefert das Anhängen die Marke 3, und das nächste Ausgabeereignis trägt die Nummer 4 und nennt A und B

#### Scenario: Ausgabe während der Abfrage liegt unter der Marke

- **GIVEN** eine View B, deren Backend-Snapshot noch abgefragt wird
- **WHEN** die PTY in dieser Zeit Daten ausgibt
- **THEN** nennt dieses Ausgabeereignis B nicht, und seine Nummer ist höchstens die Marke von B

### Requirement: Neuzeichnen nach dem Anhängen

Stammt der Snapshot einer neuen View vom Backend, SHALL der Core das Backend nach dem Registrieren der View auffordern, den ganzen Bildschirm neu in die PTY zu zeichnen, damit Ausgabe, die der Snapshot schon enthält oder die zwischen Snapshot und Registrieren verloren ging, überschrieben wird. Scheitert das Neuzeichnen oder kann das Backend es nicht, MUST das Anhängen trotzdem gelingen.

#### Scenario: Neuzeichnen nach Backend-Snapshot

- **GIVEN** ein Backend, das für die Session einen Bildschirminhalt liefert
- **WHEN** eine View angehängt wird
- **THEN** fordert der Core das Neuzeichnen erst an, nachdem die View registriert ist

#### Scenario: Kein Neuzeichnen beim Rohdaten-Puffer

- **GIVEN** ein Backend ohne eigenen Snapshot
- **WHEN** eine View angehängt wird
- **THEN** fordert der Core kein Neuzeichnen an

#### Scenario: Neuzeichnen scheitert

- **GIVEN** ein Backend, dessen Neuzeichnen fehlschlägt
- **WHEN** eine View angehängt wird
- **THEN** gelingt das Anhängen mit dem Snapshot des Backends
