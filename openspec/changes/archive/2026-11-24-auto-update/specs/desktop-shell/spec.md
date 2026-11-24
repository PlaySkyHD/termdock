## MODIFIED Requirements

### Requirement: Abschnitt Allgemein

Der Abschnitt Allgemein SHALL die Distribution (Auswahl aus `listDistros` plus „WSL-Standard“, ohne Liste ein freies Feld mit dem Grund), die Standardshell (pwsh, powershell, cmd oder keine), das Standardverzeichnis, den Schalter „Beim Schließen fragen“ (`confirmQuitWhileRunning`) und den Schalter „Nach Updates suchen“ (`checkForUpdates`, fehlend heißt an) zeigen. Speichern SHALL nur geänderte Schlüssel mit `updateSettings` senden; ein geleertes Feld MUST den Schlüssel entfernen (`null`).

#### Scenario: Nachfrage wieder einschalten

- **GIVEN** gespeichert ist `confirmQuitWhileRunning: false` mit `quitAction: "keepSessions"`
- **WHEN** der Benutzer „Beim Schließen fragen“ einschaltet und speichert
- **THEN** sendet das Fenster `settings.set { settings: { confirmQuitWhileRunning: true } }`, und das nächste Beenden mit laufenden Sessions fragt wieder

#### Scenario: Update-Suche ausschalten

- **GIVEN** `checkForUpdates` ist nicht gespeichert
- **WHEN** der Benutzer „Nach Updates suchen“ ausschaltet und speichert
- **THEN** sendet das Fenster `settings.set { settings: { checkForUpdates: false } }`; schaltet er es wieder ein, sendet es `checkForUpdates: true`

#### Scenario: Distribution aus der Liste

- **GIVEN** `listDistros` liefert `Ubuntu` (Standard) und `Debian`
- **WHEN** der Benutzer `Debian` wählt und speichert
- **THEN** ist `defaultDistro` `Debian`; wählt er danach „WSL-Standard“, sendet das Fenster `defaultDistro: null`

#### Scenario: WSL nicht verfügbar

- **GIVEN** `listDistros` liefert eine leere Liste mit Grund
- **WHEN** der Abschnitt öffnet
- **THEN** zeigt er den Grund und ein Textfeld für die Distribution
