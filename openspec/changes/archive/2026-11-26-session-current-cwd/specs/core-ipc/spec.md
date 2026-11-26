## ADDED Requirements

### Requirement: Empfänger von session.cwdChanged

Der Core SHALL jede Änderung des aktuellen Verzeichnisses als `session.cwdChanged { sessionId, currentCwd? }` an Verbindungen mit einer View der Session und an Verbindungen senden, die `session.list` genutzt haben, je Verbindung einmal. `session.list` SHALL `currentCwd` laufender Sessions enthalten.

#### Scenario: View und Listenclient

- **GIVEN** Client A mit einer View der Session, Client B nur mit `session.list`, Client C ohne beides
- **WHEN** sich das Verzeichnis der Session ändert
- **THEN** erhalten A und B je genau ein `session.cwdChanged` mit dem neuen Pfad, C keines

#### Scenario: Ende der Session

- **GIVEN** Client B hat `session.list` genutzt, die Session hat `currentCwd`
- **WHEN** ihr Prozess endet
- **THEN** erhält B `session.stateChanged` mit `Exited` und danach `session.cwdChanged` ohne `currentCwd`
