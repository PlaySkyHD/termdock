## REMOVED Requirements

### Requirement: Platzhalter für Methoden der Phase 3

**Reason**: `history.search` war die letzte Methode der Phase 3 mit Platzhalter; alle Methoden haben jetzt Fachlogik, es gibt nichts mehr zu beantworten.
**Migration**: Clients rufen `history.search` auf und erhalten `hits` und `truncated`.

## ADDED Requirements

### Requirement: history.search beantwortet die Suche

Der Core SHALL `history.search` mit der Suche im gespeicherten Verlauf beantworten (Spec `history`) und nur Sessions durchsuchen, die die Registry kennt. Scheitert die Suche beim Lesen, SHALL der Core mit `internal` antworten; die Verbindung MUST offen bleiben und der Core MUST weiter Anfragen bedienen.

#### Scenario: Suche statt Platzhalter

- **GIVEN** ein verbundener Client und ein Core mit Verlauf zweier Sessions
- **WHEN** er `history.search` mit gültigen Parametern aufruft
- **THEN** antwortet der Core mit `hits` und `truncated`, nicht mit „noch nicht umgesetzt“

#### Scenario: Fehler der Suche

- **GIVEN** eine Suche, die beim Lesen des Verlaufs scheitert
- **WHEN** der Client `history.search` aufruft
- **THEN** antwortet der Core mit `internal`, und danach gelingt `session.list` auf derselben Verbindung
