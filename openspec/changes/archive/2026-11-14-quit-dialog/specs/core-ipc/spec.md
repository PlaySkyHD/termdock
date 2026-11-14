## MODIFIED Requirements

### Requirement: Platzhalter für Methoden der Phase 3

Bis ihre Fachlogik umgesetzt ist, SHALL der Core jede Methode der Phase 3 (`workspace.*`, `project.*`, `profile.*`, `session.update`, `session.archive`, `session.delete`, `history.search`) und `session.create` ohne `launch` mit dem Fehler `internal` beantworten, dessen Meldung die Methode und „noch nicht umgesetzt“ nennt. `settings.get` und `settings.set` sind umgesetzt (Capability `settings`). Die Verbindung MUST offen bleiben und der Core MUST weiter Anfragen bedienen.

#### Scenario: Stub antwortet mit Fehler

- **GIVEN** ein verbundener Client
- **WHEN** er nacheinander jede noch nicht umgesetzte Methode der Phase 3 mit gültigen Parametern aufruft
- **THEN** antwortet der Core jeweils mit `internal` und „noch nicht umgesetzt“, und danach gelingt `session.list` auf derselben Verbindung
