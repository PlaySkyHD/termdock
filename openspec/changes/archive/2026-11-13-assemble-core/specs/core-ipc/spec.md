## ADDED Requirements

### Requirement: Startreihenfolge des Core

Der Core SHALL beim Start zuerst die Pipe belegen, danach die Datenbank im Datenverzeichnis öffnen (Option, sonst `TERMDOCK_DATA_DIR` bzw. `%APPDATA%\TermDock`), das WSL-Backend auf dem tmux-Socket `termdock` (per Option änderbar) registrieren und die gespeicherten Sessions abgleichen. Den `hello`-Handshake SHALL er sofort beantworten; jede weitere Anfrage MUST bis zum Ende des Abgleichs warten.

#### Scenario: Anfrage während des Abgleichs

- **GIVEN** ein Core, dessen Abgleich noch läuft, und ein verbundener Client
- **WHEN** der Client `session.list` sendet
- **THEN** kommt die Antwort erst nach dem Abgleich und enthält die abgeglichenen Zustände

#### Scenario: Neustart mit derselben Datenbank

- **GIVEN** ein Core, der eine Session angelegt hat und ohne Stop beendet wurde
- **WHEN** ein neuer Core mit demselben Datenverzeichnis startet
- **THEN** liefert `session.list` die Session mit derselben ID im abgeglichenen Zustand

### Requirement: Gescheiterter Start nach dem Belegen der Pipe

Scheitert das Öffnen der Datenbank oder der Abgleich, SHALL der Core wartende Anfragen mit `internal` beantworten, die Pipe schließen und sich mit Exit-Code 1 und einer Meldung auf stderr beenden.

#### Scenario: Datenbank lässt sich nicht öffnen

- **GIVEN** ein Datenverzeichnis, in dem die Datenbank nicht geöffnet werden kann
- **WHEN** der Core startet
- **THEN** endet der Start mit `start_failed` und Exit-Code 1, stderr nennt den Grund und die Pipe ist frei

### Requirement: Status des Core

`core.status` SHALL die Backends nennen, die beim Abgleich nicht erreichbar waren (`backendUnavailable`, leer, wenn alle erreichbar waren). Der Core MUST jedes nicht erreichbare Backend außerdem beim Start auf stderr melden.

#### Scenario: WSL beim Start nicht erreichbar

- **GIVEN** eine gespeicherte WSL-Session in `Running` und ein WSL-Backend, das nicht verfügbar ist
- **WHEN** der Core startet und ein Client `core.status` sendet
- **THEN** enthält `backendUnavailable` den Wert `wsl`, stderr meldet `backend_unavailable` und die Session ist `Interrupted`

### Requirement: Abbau des Core

Bei `core.shutdown`, SIGINT und SIGTERM SHALL der Core die Pipe schließen, alle PTYs lösen, ohne Zustände zu ändern, die Keepalives des WSL-Backends beenden und die Datenbank schließen. Ein Signal während des Abgleichs MUST diesen abbrechen und ebenso abbauen. Ohne `stopSessions` MUST jede tmux-Session weiterlaufen; mit `stopSessions` werden die Sessions vorher beendet, auch solche, die gerade wieder angebunden werden.

#### Scenario: Beenden ohne Stop

- **GIVEN** ein Core mit einer laufenden WSL-Session
- **WHEN** er ohne Stop beendet wird
- **THEN** existiert die tmux-Session weiter, kein Keepalive-Prozess des Core läuft mehr und die Datenbank ist geschlossen

#### Scenario: Signal während des Abgleichs

- **GIVEN** ein Core, dessen Abgleich noch auf das Backend wartet
- **WHEN** SIGTERM eintrifft
- **THEN** endet der Core mit Exit-Code 0, die Pipe ist frei, die Datenbank ist geschlossen und der gespeicherte Zustand der Session ist unverändert

#### Scenario: Shutdown während des Wiederanbindens

- **GIVEN** eine Session, deren Client verloren ging und die gerade wieder angebunden wird
- **WHEN** ein Client `core.shutdown { stopSessions: true }` sendet
- **THEN** antwortet der Core ohne Fehler und die Session ist `Exited`

## MODIFIED Requirements

### Requirement: Einzelinstanz

Der Core SHALL die Pipe exklusiv belegen (Pfad konfigurierbar). Ist sie belegt, SHALL der Start mit dem Fehlercode `already_running` scheitern, bevor die Datenbank geöffnet wird; der Einstiegsprozess SHALL sich mit Exit-Code 10 und einer Meldung auf stderr beenden. Der laufende Core MUST davon unberührt bleiben.

#### Scenario: Zweite Instanz

- **GIVEN** ein laufender Core auf einer Pipe
- **WHEN** ein zweiter Core dieselbe Pipe belegen will
- **THEN** scheitert er mit `already_running`, Exit-Code 10 und einer stderr-Meldung, und der erste Core antwortet weiter

#### Scenario: Zweite Instanz öffnet keine Datenbank

- **GIVEN** ein laufender Core auf einer Pipe
- **WHEN** ein zweiter Core mit einem noch nicht vorhandenen Datenverzeichnis dieselbe Pipe belegen will
- **THEN** scheitert er mit `already_running` und das Datenverzeichnis bleibt unangelegt
