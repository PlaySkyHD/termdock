## MODIFIED Requirements

### Requirement: Abbau des Core

Bei `core.shutdown`, SIGINT und SIGTERM SHALL der Core die Pipe schließen, alle PTYs lösen, ohne Zustände zu ändern, und die Datenbank schließen; die Keepalives des WSL-Backends MUST weiterlaufen (der nächste Core übernimmt sie). Ein Signal während des Abgleichs MUST diesen abbrechen und ebenso abbauen. Ohne `stopSessions` MUST jede tmux-Session weiterlaufen; mit `stopSessions` werden die Sessions vorher beendet, auch solche, die gerade wieder angebunden werden.

#### Scenario: Beenden ohne Stop

- **GIVEN** ein Core mit einer laufenden WSL-Session
- **WHEN** er ohne Stop beendet wird
- **THEN** existiert die tmux-Session weiter, ihr Keepalive läuft weiter und die Datenbank ist geschlossen

#### Scenario: Beenden mit Stop

- **GIVEN** ein Core mit einer laufenden WSL-Session
- **WHEN** ein Client `core.shutdown { stopSessions: true }` sendet
- **THEN** ist die tmux-Session beendet und für ihren Socket läuft kein Keepalive mehr

#### Scenario: Signal während des Abgleichs

- **GIVEN** ein Core, dessen Abgleich noch auf das Backend wartet
- **WHEN** SIGTERM eintrifft
- **THEN** endet der Core mit Exit-Code 0, die Pipe ist frei, die Datenbank ist geschlossen und der gespeicherte Zustand der Session ist unverändert

#### Scenario: Shutdown während des Wiederanbindens

- **GIVEN** eine Session, deren Client verloren ging und die gerade wieder angebunden wird
- **WHEN** ein Client `core.shutdown { stopSessions: true }` sendet
- **THEN** antwortet der Core ohne Fehler und die Session ist `Exited`
