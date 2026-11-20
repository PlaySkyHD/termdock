## ADDED Requirements

### Requirement: Neustart im Vertrag

Protokoll 1.6 SHALL die Methode `session.restart { sessionId }` enthalten; unbekannte Felder oder eine leere ID MUST `bad_request` ergeben. Das Ergebnis SHALL `{ session }` mit einer gültigen `SessionInfo` sein. Weder Anfrage noch Antwort tragen Nutzdaten.

#### Scenario: Gültige Anfrage und Antwort

- **GIVEN** eine Anfrage `session.restart { sessionId: "s1" }` und eine Antwort `{ session }` mit einer gültigen `SessionInfo`
- **WHEN** sie geparst werden
- **THEN** sind beide gültig

#### Scenario: Ungültige Anfrage

- **GIVEN** eine Anfrage `session.restart` ohne `sessionId`, mit leerer ID, mit dem Feld `launch` oder mit Nutzdaten
- **WHEN** sie geparst wird
- **THEN** ist das Ergebnis `bad_request`

#### Scenario: Version

- **WHEN** ein Client die Protokollversion liest
- **THEN** ist sie `1.6`, und Clients mit `1.2` bis `1.5` werden weiter angenommen
