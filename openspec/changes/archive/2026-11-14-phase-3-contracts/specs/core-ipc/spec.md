## ADDED Requirements

### Requirement: Platzhalter für Methoden der Phase 3

Bis ihre Fachlogik umgesetzt ist, SHALL der Core jede Methode der Phase 3 (`workspace.*`, `project.*`, `profile.*`, `session.update`, `session.archive`, `session.delete`, `settings.*`, `history.search`) und `session.create` ohne `launch` mit dem Fehler `internal` beantworten, dessen Meldung die Methode und „noch nicht umgesetzt“ nennt. Die Verbindung MUST offen bleiben und der Core MUST weiter Anfragen bedienen.

#### Scenario: Stub antwortet mit Fehler

- **GIVEN** ein verbundener Client
- **WHEN** er nacheinander jede Methode der Phase 3 mit gültigen Parametern aufruft
- **THEN** antwortet der Core jeweils mit `internal` und „noch nicht umgesetzt“, und danach gelingt `session.list` auf derselben Verbindung

### Requirement: Empfänger der Phase-3-Events

Der Core SHALL `session.updated`, `session.removed`, `workspace.changed`, `profile.changed` und `settings.changed` wie `session.created` an jede Verbindung senden, die `session.list` genutzt hat, auch an die auslösende, je Event höchstens einmal je Verbindung. Verbindungen ohne `session.list` MUST sie nicht erhalten.

#### Scenario: Event an Listen-Clients

- **GIVEN** ein Client, der `session.list` genutzt hat, und einer, der es nicht hat
- **WHEN** der Core `workspace.changed` sendet
- **THEN** erhält nur der erste Client das Event, genau einmal
