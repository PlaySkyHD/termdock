## ADDED Requirements

### Requirement: Status-Abfrage

`core.status` SHALL ohne Parameter auskommen und im Ergebnis `backendUnavailable` als Liste von Backend-Arten (`wsl`, `windows`) liefern. Parser MUST ein fehlendes Feld, einen Nicht-Array-Wert und unbekannte Backend-Arten mit `bad_request` ablehnen.

#### Scenario: core.status

- **GIVEN** eine Antwort auf `core.status`
- **WHEN** sie mit `backendUnavailable: ["wsl"]` oder `[]` geparst wird
- **THEN** ist sie gültig; ein fehlendes Feld oder ein unbekannter Wert wie `"mac"` ergibt `bad_request`

## MODIFIED Requirements

### Requirement: Methoden der Phase 1

Der Vertrag SHALL die Methoden `hello`, `session.create`, `session.list`, `session.attach`, `session.detach`, `session.input`, `session.resize`, `session.claimWriter`, `session.kill`, `core.status` und `core.shutdown` mit typisierten Parametern und Ergebnissen definieren; Parser SHALL Anfragen und Antworten gegen diese Typen prüfen. `core.shutdown` SHALL den optionalen booleschen Parameter `stopSessions` tragen.

#### Scenario: session.attach liefert Snapshot

- **GIVEN** eine Antwort auf `session.attach`
- **WHEN** sie geparst wird
- **THEN** enthält sie `viewId`, `size`, optional `writerViewId` im Ergebnis und den Snapshot als Nutzdaten (leer erlaubt)

#### Scenario: session.input trägt Bytes

- **GIVEN** eine Anfrage `session.input` mit `viewId` und nicht leeren Nutzdaten
- **WHEN** sie geparst wird
- **THEN** liefert der Parser die Bytes unverändert; ohne Nutzdaten ist das Ergebnis `bad_request`

#### Scenario: Nutzdaten bei Methode ohne Nutzdaten

- **GIVEN** eine Anfrage `session.kill` mit nicht leeren Nutzdaten
- **WHEN** sie geparst wird
- **THEN** ist das Ergebnis `bad_request`

#### Scenario: core.shutdown mit stopSessions

- **GIVEN** eine Anfrage `core.shutdown` mit `stopSessions: true`
- **WHEN** sie geparst wird
- **THEN** liefert der Parser den Wert; ein nicht boolescher Wert ergibt `bad_request`, und `{}` bleibt gültig
