## MODIFIED Requirements

### Requirement: Screenshot-Modus gegen isolierten Core

Mit `--screenshot <dir>` SHALL die App einen eigenen Core starten (eigene Pipe, Datenverzeichnis in einem Temp-Verzeichnis, tmux-Socket `termdock-test-<pid>-<nonce>` dieses Laufs), Sessions in den Zuständen `Running`, `Detached`, `Exited` und `Interrupted` mit mehreren Tabs, eine eingeklappte Sidebar, ein leeres Fenster und einen Leser aufnehmen (PNG in `<dir>`), danach Sessions und Core beenden, das Datenverzeichnis entfernen und mit Code 0 enden; bei Fehler mit Code 1.

#### Scenario: Aufnahme

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` PNG-Dateien mit der Sidebar in allen vier Zuständen und mehreren Tabs, mit eingeklappter Sidebar, mit leerem Fenster und geöffnetem Formular und mit einem Leser samt „Schreibrecht übernehmen“, und auf dem Socket des Laufs bleibt keine Session

#### Scenario: Parallele Läufe

- **GIVEN** ein Screenshot-Lauf oder WSL-Integrationstests auf `termdock-test` laufen
- **WHEN** ein zweiter Screenshot-Lauf startet
- **THEN** nutzt er einen eigenen tmux-Socket und ein eigenes Electron-Profil, und keiner der Läufe beendet Sessions des anderen

#### Scenario: Verbindung zum isolierten Core scheitert

- **GIVEN** der Screenshot-Lauf hat seinen Core gestartet
- **WHEN** das Verbinden oder die erste Antwort scheitert
- **THEN** beendet die App diesen Core mit `core.shutdown { stopSessions: true }` oder, wenn er nicht antwortet, über seine Prozess-ID, wartet auf sein Ende, entfernt danach das Datenverzeichnis und endet mit Code 1

#### Scenario: Produktiver Core bleibt unberührt

- **GIVEN** ein produktiver Core und eine App laufen
- **WHEN** die App zusätzlich mit `--screenshot <dir>` gestartet wird
- **THEN** verbindet sie sich nicht mit dem produktiven Core, öffnet kein Fenster im laufenden Main und ändert keine Session auf dem Socket `termdock`
