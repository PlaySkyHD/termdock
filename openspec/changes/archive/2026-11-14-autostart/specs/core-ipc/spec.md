## MODIFIED Requirements

### Requirement: Startreihenfolge des Core

Der Core SHALL beim Start zuerst die Pipe belegen, danach die Datenbank im Datenverzeichnis öffnen (Option, sonst `TERMDOCK_DATA_DIR` bzw. `%APPDATA%\TermDock`), das WSL-Backend auf dem tmux-Socket `termdock` (per Option änderbar) registrieren, die gespeicherten Sessions abgleichen und den Autostart ausführen. Den `hello`-Handshake SHALL er sofort beantworten; jede weitere Anfrage MUST warten, bis der Abgleich endet und die Autostart-Sessions eingetragen sind, nicht bis zu ihrem Start.

#### Scenario: Anfrage während des Abgleichs

- **GIVEN** ein Core, dessen Abgleich noch läuft, und ein verbundener Client
- **WHEN** der Client `session.list` sendet
- **THEN** kommt die Antwort erst nach dem Abgleich und enthält die abgeglichenen Zustände

#### Scenario: Anfrage während des Autostarts

- **GIVEN** ein Autostart-Profil, ein Backend, dessen Erreichbarkeitsprüfung noch läuft, und ein verbundener Client
- **WHEN** der Client `session.list` sendet
- **THEN** kommt die Antwort erst nach der Prüfung und enthält die Session des Profils

#### Scenario: Neustart mit derselben Datenbank

- **GIVEN** ein Core, der eine Session angelegt hat und ohne Stop beendet wurde
- **WHEN** ein neuer Core mit demselben Datenverzeichnis startet
- **THEN** liefert `session.list` die Session mit derselben ID im abgeglichenen Zustand

### Requirement: Status des Core

`core.status` SHALL die Backends nennen, die beim Abgleich oder beim Autostart nicht erreichbar waren (`backendUnavailable`, leer, wenn alle erreichbar waren), jedes höchstens einmal. Der Core MUST jedes nicht erreichbare Backend außerdem beim Start auf stderr melden.

#### Scenario: WSL beim Start nicht erreichbar

- **GIVEN** eine gespeicherte WSL-Session in `Running` und ein WSL-Backend, das nicht verfügbar ist
- **WHEN** der Core startet und ein Client `core.status` sendet
- **THEN** enthält `backendUnavailable` den Wert `wsl`, stderr meldet `backend_unavailable` und die Session ist `Interrupted`

#### Scenario: Abgleich und Autostart finden dasselbe Backend nicht

- **GIVEN** eine gespeicherte WSL-Session in `Running`, ein Autostart-Profil für WSL und ein WSL-Backend, das nicht verfügbar ist
- **WHEN** der Core startet und ein Client `core.status` sendet
- **THEN** ist `backendUnavailable` genau `["wsl"]` und es gibt keine neue Session
