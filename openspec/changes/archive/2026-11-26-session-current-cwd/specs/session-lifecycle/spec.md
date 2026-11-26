## ADDED Requirements

### Requirement: Aktuelles Verzeichnis laufender Sessions

Die Registry SHALL das Verzeichnis über `Backend.currentCwd` nur für Sessions mit gebundener PTY und mindestens einer View abfragen: beim Anhängen einer View, beim Binden einer PTY mit Views und 300 ms nach der letzten Ausgabe, die nicht aus einem Neuzeichnen stammt. Ein anderes Ergebnis SHALL sie in `SessionInfo.currentCwd` übernehmen und melden, ein gleiches oder fehlendes nicht. Ein Backend ohne `currentCwd` wird nie gefragt.

#### Scenario: Wechsel nach einer Pause

- **GIVEN** eine `Running`-Session mit View, deren Backend `/home/nic` und dann `/tmp` meldet
- **WHEN** die View anhängt und später Ausgabe kommt, nach der es 300 ms ruhig bleibt
- **THEN** meldet die Registry zuerst `/home/nic`, dann `/tmp`, je genau einmal

#### Scenario: Keine Meldung ohne Änderung

- **GIVEN** eine Session, deren Backend immer `/tmp` meldet
- **WHEN** nach mehreren Ausgabepausen abgefragt wird
- **THEN** gibt es genau eine Meldung; liefert eine Abfrage nichts, bleibt `/tmp`

### Requirement: Drosselung der Verzeichnisabfrage

Je Session MUST höchstens eine Abfrage laufen, und zwischen dem Beginn zweier Abfragen MUST mindestens 1 s liegen; Ausgabe während einer Abfrage plant höchstens eine weitere. Ohne View SHALL die Registry keine Abfrage planen; geht die letzte View, entfällt eine geplante Abfrage, und der bekannte Wert bleibt.

#### Scenario: Gedrosselt

- **GIVEN** eine Session mit View und Ausgabe alle 100 ms über 3 s
- **WHEN** die Ausgabe läuft
- **THEN** fragt die Registry erst nach der letzten Ausgabe und Pause, nie zwei Abfragen gleichzeitig und nie zwei innerhalb einer Sekunde

#### Scenario: Ohne View

- **GIVEN** eine `Detached`-Session ohne View
- **WHEN** sie Ausgabe erzeugt
- **THEN** fragt die Registry nicht

### Requirement: Abbau der Verzeichnisabfrage

Verlässt eine Session `Running` und `Detached`, SHALL die Registry `currentCwd` entfernen und, wenn es einen Wert gab, nach dem Zustandswechsel eine Änderung ohne Verzeichnis melden. Endet oder wechselt die PTY, oder wird die Registry freigegeben, MUST sie den Timer abbauen und ein noch ausstehendes Ergebnis verwerfen. Das Repository MUST `currentCwd` nicht speichern.

#### Scenario: Ende des Prozesses

- **GIVEN** eine Session mit `currentCwd: "/tmp"`
- **WHEN** ihr Prozess endet
- **THEN** ist sie `Exited` ohne `currentCwd`, und eine Meldung ohne Verzeichnis folgt dem Zustandswechsel

#### Scenario: Ergebnis nach dem Ende

- **GIVEN** eine laufende Abfrage einer Session
- **WHEN** die PTY endet, bevor das Backend antwortet
- **THEN** übernimmt die Registry das Ergebnis nicht, und kein Timer der Session bleibt

#### Scenario: Freigabe der Registry

- **GIVEN** eine Session mit geplanter Abfrage
- **WHEN** `dispose` läuft
- **THEN** fragt die Registry danach nicht mehr

#### Scenario: Nicht gespeichert

- **GIVEN** eine Session mit `currentCwd`
- **WHEN** das Repository sie speichert
- **THEN** enthält der gespeicherte Eintrag kein `currentCwd`
