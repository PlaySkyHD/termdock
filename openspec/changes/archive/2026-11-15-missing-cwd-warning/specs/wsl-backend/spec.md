## ADDED Requirements

### Requirement: Prüfung des Arbeitsverzeichnisses beim Start

Beim Start einer Session SHALL das WSL-Backend ein absolutes `cwd` (bis 512 Zeichen) mit `wsl.exe -d <distro> --cd ~ --exec test -d <cwd>` als Argument-Array prüfen, parallel zum Statusaufruf des Starts. Fehlt das Verzeichnis, MUST die Session trotzdem starten (die Shell läuft in `/`) und die PTY die Warnung `cwd_missing` mit Pfad und Distro tragen. `~`, `~/…` und andere Formen MUST es nicht prüfen; `attach` prüft nicht.

#### Scenario: Fehlendes Verzeichnis

- **GIVEN** ein `LaunchSpec` mit `cwd` `/srv/api`, das es in der Distro `Ubuntu` nicht gibt
- **WHEN** die Session gestartet wird und in ihr `pwd` läuft
- **THEN** läuft sie, die Ausgabe zeigt `/`, und die PTY trägt `[{ code: "cwd_missing", path: "/srv/api", distro: "Ubuntu" }]`

#### Scenario: Vorhandenes Verzeichnis

- **GIVEN** ein `LaunchSpec` mit `cwd` `/tmp`
- **WHEN** die Session gestartet wird
- **THEN** trägt die PTY keine Warnung

#### Scenario: Pfad wörtlich

- **GIVEN** ein `cwd` `/srv/api; rm -rf ~`
- **WHEN** die Session gestartet wird
- **THEN** ist der Prüfaufruf genau `["-d", "<distro>", "--cd", "~", "--exec", "test", "-d", "/srv/api; rm -rf ~"]`, ohne Shell

#### Scenario: WSL nicht erreichbar oder zu langsam

- **GIVEN** der Prüfaufruf scheitert, wirft, endet mit einer Meldung von wsl.exe oder braucht länger als 5 s
- **WHEN** die Session gestartet wird
- **THEN** startet sie wie bisher und die PTY trägt keine Warnung

#### Scenario: Keine Prüfung für das Home-Verzeichnis

- **GIVEN** ein `cwd` `~` oder `~/src`
- **WHEN** die Session gestartet wird
- **THEN** ruft das Backend `test -d` nicht auf

#### Scenario: Parallel zum Statusaufruf

- **WHEN** eine Session gestartet wird
- **THEN** laufen Statusaufruf und Prüfung gleichzeitig, nicht nacheinander

#### Scenario: Beitritt zu einer lebenden Session

- **GIVEN** die tmux-Session der ID läuft noch
- **WHEN** `start` ihr beitritt
- **THEN** trägt die PTY keine Warnung
