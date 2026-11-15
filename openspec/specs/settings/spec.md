# settings Specification

## Purpose
Legt fest, wie der Core die globalen Einstellungen (`Settings`, Protokoll 1.3) speichert und bereitstellt: ein JSON-Wert je Schlüssel in der Tabelle `settings` (ADR 0004), Standardwerte für fehlende Schlüssel, das Zusammenführen eines Patches mit Prüfung und die Methoden `settings.get` und `settings.set` samt Event `settings.changed`.

## Requirements

### Requirement: Einstellungen speichern und lesen

Der Core SHALL die Einstellungen je Schlüssel als JSON-Wert in der Tabelle `settings` speichern. `settings.get` SHALL immer ein vollständiges `Settings` liefern: ein fehlender Schlüssel hat seinen Standard aus `DEFAULT_SETTINGS`. Ein nicht lesbarer oder ungültiger Wert MUST den Standard ergeben, ohne dass `settings.get` scheitert, und der Core SHALL ihn melden; unbekannte Schlüssel SHALL er ignorieren. Eine synchrone Lesefunktion SHALL anderen Teilen des Core die Einstellungen liefern.

#### Scenario: Nichts gespeichert

- **GIVEN** eine leere Tabelle `settings`
- **WHEN** ein Client `settings.get` aufruft
- **THEN** erhält er `DEFAULT_SETTINGS` (10 MiB Verlauf, Verlauf an, Nachfrage beim Schließen an, keine Aktion)

#### Scenario: Wert übersteht einen Neustart

- **GIVEN** `settings.set { settings: { confirmQuitWhileRunning: false, quitAction: "keepSessions" } }` wurde beantwortet
- **WHEN** der Core neu startet und ein Client `settings.get` aufruft
- **THEN** sind beide Werte gesetzt, alle anderen Schlüssel haben ihren Standard

#### Scenario: Unbrauchbare Zeile

- **GIVEN** die Tabelle enthält `historyLimitBytes` mit `"big"` und einen unbekannten Schlüssel
- **WHEN** ein Client `settings.get` aufruft
- **THEN** antwortet der Core mit dem Standard für `historyLimitBytes`, meldet den Wert und ignoriert den unbekannten Schlüssel

### Requirement: Einstellungen ändern

`settings.set` SHALL den Patch in die gespeicherten Einstellungen zusammenführen: ein fehlender Schlüssel bleibt, `null` entfernt einen optionalen Schlüssel (dann gilt wieder sein Standard), und das Ergebnis MUST mit `validateSettings` gültig sein, sonst SHALL der Core `bad_request` antworten und nichts speichern. Lesen, Prüfen und Schreiben SHALL unter einer Schreibsperre laufen. Die Antwort SHALL die vollständigen Einstellungen tragen.

#### Scenario: Patch zusammenführen

- **GIVEN** gespeichert ist `defaultDistro: "Ubuntu"`
- **WHEN** ein Client `settings.set { settings: { confirmQuitWhileRunning: false } }` sendet
- **THEN** antwortet der Core mit beiden Werten und den Standards der übrigen Schlüssel

#### Scenario: Schlüssel entfernen

- **GIVEN** gespeichert ist `quitAction: "stopSessions"`
- **WHEN** ein Client `settings.set { settings: { quitAction: null } }` sendet
- **THEN** fehlt `quitAction` in der Antwort und in `settings.get`

#### Scenario: Ungültiger Patch

- **WHEN** ein Client `settings.set { settings: {} }` oder `{ settings: { historyLimitBytes: 1 } }` sendet
- **THEN** antwortet der Core mit `bad_request`, und die gespeicherten Einstellungen bleiben unverändert

### Requirement: Änderungen melden

Nach jedem erfolgreichen `settings.set` SHALL der Core `settings.changed { settings }` mit den vollständigen Einstellungen an jede Verbindung senden, die `session.list` genutzt hat, auch an die auslösende.

#### Scenario: Zwei Listen-Clients

- **GIVEN** zwei Clients haben `session.list` genutzt, ein dritter nicht
- **WHEN** einer von ihnen `settings.set` aufruft
- **THEN** erhalten die beiden Listen-Clients je genau ein `settings.changed`, der dritte keines

### Requirement: Vorgaben für neue Sessions

Legt ein Client eine Session an (direkt oder aus einem Profil), SHALL der Core einem WSL-`LaunchSpec` ohne `distro` die Einstellung `defaultDistro` und einem Windows-`LaunchSpec` ohne `shell` die Einstellung `defaultShell` geben, gelesen beim Anlegen. Ein gesetztes `distro` oder `shell` MUST unverändert bleiben. Ohne Einstellung SHALL das Backend wie bisher die Standard-Distro von WSL auflösen. Bestehende Sessions MUST unverändert bleiben.

#### Scenario: Distribution aus den Einstellungen

- **GIVEN** gespeichert ist `defaultDistro: "Debian"`
- **WHEN** ein Client `session.create { name: "a", launch: { backend: "wsl", cwd: "/" } }` aufruft
- **THEN** hat die neue Session `launch.distro` `Debian`

#### Scenario: Ausdrückliche Distribution gewinnt

- **GIVEN** gespeichert ist `defaultDistro: "Debian"`
- **WHEN** ein Client eine Session mit `launch.distro: "Ubuntu"` oder aus einem Profil mit `distro: "Ubuntu"` anlegt
- **THEN** hat die Session `launch.distro` `Ubuntu`

#### Scenario: Profil ohne Distribution

- **GIVEN** gespeichert ist `defaultDistro: "Debian"` und ein WSL-Profil ohne `distro`
- **WHEN** ein Client `session.create { name: "a", profileId }` aufruft
- **THEN** hat die Session `launch.distro` `Debian`, das Profil selbst bleibt ohne `distro`

#### Scenario: Shell aus den Einstellungen

- **GIVEN** gespeichert ist `defaultShell: "cmd"`
- **WHEN** ein Client eine Windows-Session ohne `shell` anlegt
- **THEN** hat sie `launch.shell` `cmd`; eine WSL-Session bekommt keine `shell`
