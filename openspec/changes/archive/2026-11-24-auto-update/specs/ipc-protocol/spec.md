## MODIFIED Requirements

### Requirement: Einstellungen im Vertrag

`Settings` SHALL die festen Schlüssel `defaultDistro?`, `defaultShell?`, `defaultCwd?`, `historyLimitBytes`, `historyEnabledByDefault`, `confirmQuitWhileRunning`, `quitAction?` (`keepSessions` oder `stopSessions`) und seit 1.7 `checkForUpdates?` (Boolean, fehlend heißt an) haben. Standard SHALL 10 MiB Verlauf, Verlauf an und Nachfrage beim Schließen an sein. `historyLimitBytes` MUST eine ganze Zahl von 64 KiB bis 1 GiB sein; unbekannte Schlüssel MUST `bad_request` ergeben.

#### Scenario: Teiländerung der Einstellungen

- **GIVEN** eine Anfrage `settings.set { settings: { historyLimitBytes: 65536, defaultDistro: null } }`
- **WHEN** sie geparst wird
- **THEN** ist sie gültig; mit `historyLimitBytes: 65535`, `1073741825` oder einem Schlüssel `farbe` ist das Ergebnis `bad_request`

#### Scenario: Update-Suche in den Einstellungen

- **GIVEN** eine Anfrage `settings.set { settings: { checkForUpdates: false } }` oder `{ checkForUpdates: null }` und eine Antwort `settings.get` mit oder ohne `checkForUpdates`
- **WHEN** sie geparst werden
- **THEN** sind alle gültig; `checkForUpdates: "nein"` ergibt `bad_request`

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
- **THEN** ist sie `1.7`, und Clients mit `1.2` bis `1.6` werden weiter angenommen
