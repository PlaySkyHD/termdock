## ADDED Requirements

### Requirement: Warnungen einer Session im Vertrag

Protokoll 1.5 SHALL `SessionInfo` und `session.stateChanged` ein optionales Feld `warnings` geben: 1 bis 8 Einträge `{ code, path?, distro? }`. `code` MUST 1 bis 64 Zeichen aus `a-z`, Ziffern und `_` sein (bekannt: `cwd_missing`; unbekannte Codes sind gültig), `path` folgt den Regeln für Pfade (1 bis 512 Zeichen, kein NUL), `distro` den Regeln für Namen. Der Core SHALL `warnings` an jedes `session.stateChanged` hängen, dessen Session welche hat.

#### Scenario: Gültige Warnung

- **GIVEN** ein `session.stateChanged { sessionId, state: "Running", warnings: [{ code: "cwd_missing", path: "/srv/api", distro: "Ubuntu" }] }` und eine `SessionInfo` mit denselben `warnings` in `session.list`
- **WHEN** sie geparst werden
- **THEN** sind sie gültig, ebenso eine Warnung mit dem unbekannten Code `later_code_9`

#### Scenario: Ungültige Warnung

- **GIVEN** `warnings` als leere Liste, mit 9 Einträgen, ohne `code`, mit `code` `Cwd-Missing` oder 65 Zeichen, mit leerem oder zu langem `path`, mit NUL im `path` oder mit `distro` aus Leerzeichen
- **WHEN** sie geparst werden
- **THEN** ist das Ergebnis `bad_request` mit dem Pfad des Feldes

#### Scenario: Warnung über die Pipe

- **GIVEN** ein Client, der `session.list` genutzt hat, und ein Backend, dessen Start `cwd_missing` meldet
- **WHEN** er `session.create` sendet
- **THEN** tragen Antwort, `session.list` und die Events `session.stateChanged` mit `Running` und `Detached` die Warnung, das `session.stateChanged` mit `Exited` danach keine

#### Scenario: Version

- **WHEN** ein Client die Protokollversion liest
- **THEN** ist sie `1.5`, und Clients mit `1.2` bis `1.4` werden weiter angenommen

## MODIFIED Requirements

### Requirement: WSL-Distributionen im Vertrag

Protokoll 1.4 SHALL die Methode `wsl.distros` ohne Parameter (unbekannte Felder MUST `bad_request` ergeben) enthalten. Das Ergebnis SHALL `{ distros, defaultDistro?, unavailable? }` sein: `distros` höchstens 64 Namen wie Profilnamen (1 bis 128 Zeichen, nicht nur Leerzeichen), `defaultDistro` einer davon, `unavailable` ein Text von 1 bis 512 Zeichen. Weder Anfrage noch Antwort tragen Nutzdaten.

#### Scenario: Gültige Antwort

- **GIVEN** eine Antwort `{ distros: ["Ubuntu", "Debian"], defaultDistro: "Ubuntu" }` auf `wsl.distros`
- **WHEN** sie geparst wird
- **THEN** ist sie gültig, ebenso `{ distros: [], unavailable: "wsl.exe fehlt" }`

#### Scenario: Ungültige Antwort

- **GIVEN** eine Antwort mit 65 Namen, mit einem leeren Namen oder mit `defaultDistro: "Arch"`, das nicht in `distros` steht
- **WHEN** sie geparst wird
- **THEN** ist das Ergebnis `bad_request`

#### Scenario: Unbekanntes Feld in der Anfrage

- **GIVEN** eine Anfrage `wsl.distros { all: true }`
- **WHEN** sie geparst wird
- **THEN** ist das Ergebnis `bad_request`

#### Scenario: Version

- **WHEN** ein Client die Protokollversion liest
- **THEN** ist sie mindestens `1.4`, und ein Client mit `1.3` wird weiter angenommen
