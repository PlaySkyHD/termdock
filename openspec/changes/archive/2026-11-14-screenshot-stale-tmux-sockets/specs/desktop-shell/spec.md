## ADDED Requirements

### Requirement: Screenshot-Modus räumt verwaiste tmux-Sockets auf

Beim Start eines Screenshot-Laufs SHALL die App die tmux-Server auf Sockets `termdock-test-<pid>-<nonce>` beenden (`tmux -L <socket> kill-server`, über `wsl.exe` als Argument-Array), deren Prozess nicht mehr läuft. Der eigene Socket, Sockets laufender Prozesse, `termdock` und `termdock-test` SHALL unberührt bleiben. Fehler beim Aufräumen SHALL geloggt werden und den Lauf nicht abbrechen.

#### Scenario: Server eines abgebrochenen Laufs

- **GIVEN** ein Lauf ist abgebrochen und sein tmux-Server auf `termdock-test-<pid>-<nonce>` läuft noch
- **WHEN** ein neuer Screenshot-Lauf startet
- **THEN** läuft auf diesem Socket kein tmux-Server mehr

#### Scenario: Fremde Sockets bleiben

- **GIVEN** Sockets `termdock`, `termdock-test` und `termdock-test-<pid>-<nonce>` eines laufenden Prozesses
- **WHEN** ein Screenshot-Lauf aufräumt
- **THEN** ruft er auf keinem davon `kill-server` auf

#### Scenario: Aufräumen scheitert

- **GIVEN** WSL antwortet nicht oder `kill-server` eines Sockets scheitert
- **WHEN** ein Screenshot-Lauf aufräumt
- **THEN** loggt er den Fehler, versucht die übrigen Sockets und führt den Lauf fort
