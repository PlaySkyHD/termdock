## ADDED Requirements

### Requirement: Distributionen für Clients auflisten

Der Core SHALL `wsl.distros` mit den Distributionen beantworten, die `wsl.exe -l -v` nennt (Argument-Array, `WSL_UTF8=1`, Nullbytes einer UTF-16-Ausgabe entfernt, höchstens 5 s), und der Standard-Distro. Namen, die die Grenzen des Vertrags verletzen, MUST er auslassen, über 64 hinaus abschneiden. Scheitert oder dauert der Aufruf zu lange oder fehlt ein WSL-Backend, SHALL er eine leere Liste mit Grund in `unavailable` liefern, ohne Fehler und ohne Absturz.

#### Scenario: Zwei Distributionen

- **GIVEN** `wsl.exe -l -v` nennt `Ubuntu` (Standard, mit `*`) und `Debian`
- **WHEN** ein Client `wsl.distros` aufruft
- **THEN** erhält er `{ distros: ["Ubuntu", "Debian"], defaultDistro: "Ubuntu" }`

#### Scenario: WSL nicht verfügbar

- **GIVEN** `wsl.exe` endet mit einem Fehler oder antwortet nicht innerhalb von 5 s
- **WHEN** ein Client `wsl.distros` aufruft
- **THEN** erhält er `{ distros: [] }` mit einem Grund in `unavailable`, und der Core beantwortet weitere Anfragen

#### Scenario: Echte Distribution

- **GIVEN** ein Host mit WSL und `TERMDOCK_WSL_TESTS=1`
- **WHEN** das WSL-Backend die Distributionen auflistet
- **THEN** enthält die Liste die Standard-Distro, und kein Name enthält ein Nullbyte
