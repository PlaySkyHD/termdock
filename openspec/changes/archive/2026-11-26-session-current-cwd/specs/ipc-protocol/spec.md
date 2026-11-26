## MODIFIED Requirements

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
- **THEN** ist sie `1.8`, und Clients mit `1.2` bis `1.7` werden weiter angenommen

## ADDED Requirements

### Requirement: Aktuelles Verzeichnis im Vertrag

Protokoll 1.8 SHALL `SessionInfo` ein optionales Feld `currentCwd` geben und das Event `session.cwdChanged { sessionId, currentCwd? }` ohne Nutzdaten enthalten; fehlt `currentCwd` im Event, ist das Verzeichnis unbekannt. `currentCwd` MUST 1 bis 512 Zeichen lang sein und darf keine Steuerzeichen (U+0000 bis U+001F, U+007F) enthalten. Das Paket SHALL diese Prüfung als `isValidCurrentCwd` exportieren, damit der Core vor dem Senden dieselbe Grenze anwendet.

#### Scenario: Gültiges Verzeichnis

- **GIVEN** ein `session.cwdChanged { sessionId: "s1", currentCwd: "/tmp" }`, ein `session.cwdChanged { sessionId: "s1" }` und eine `SessionInfo` mit `currentCwd: "/home/nic/Projekt Ä"` in `session.list`
- **WHEN** sie geparst werden
- **THEN** sind alle gültig

#### Scenario: Ungültiges Verzeichnis

- **GIVEN** `currentCwd` leer, mit 513 Zeichen, mit NUL, Zeilenumbruch, Escape oder DEL, oder als Zahl, im Event oder in einer `SessionInfo`; oder ein Event ohne `sessionId` oder mit Nutzdaten
- **WHEN** es geparst wird
- **THEN** ist das Ergebnis `bad_request` mit dem Pfad des Feldes
