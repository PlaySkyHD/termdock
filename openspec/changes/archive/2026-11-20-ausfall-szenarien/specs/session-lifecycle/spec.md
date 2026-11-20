## MODIFIED Requirements

### Requirement: Ende der PTY

Endet die PTY einer laufenden Session mit Exit-Code, SHALL die Session `Exited` werden und den Exit-Code speichern. Endet sie ohne Exit-Code und existiert die Backend-Session nicht mehr oder scheitert das Wiederanbinden, MUST die Session `Interrupted` werden. Angehängte Views bleiben angehängt und behalten das Schreibrecht; Eingabe an eine solche Session MUST mit `invalid_state` abgelehnt werden, und ein `restart` MUST sie neu starten.

#### Scenario: Prozess endet selbst

- **GIVEN** eine laufende Session
- **WHEN** die PTY mit Exit-Code 0 endet
- **THEN** ist die Session `Exited` mit letztem Exit-Code 0

#### Scenario: Unerwartetes PTY-Ende

- **GIVEN** eine Session im Zustand `Running` oder `Detached`, deren Backend-Session nicht mehr existiert
- **WHEN** die PTY ohne Exit-Code endet
- **THEN** ist die Session `Interrupted`

#### Scenario: tmux-Server stirbt

- **GIVEN** zwei laufende WSL-Sessions mit angehängten Views eines Clients
- **WHEN** der tmux-Server ihres Sockets beendet wird (`kill-server`)
- **THEN** erhält der Client für beide `session.stateChanged` mit `Interrupted`, `session.list` nennt beide `Interrupted` und `session.input` der View antwortet mit `invalid_state`

#### Scenario: Neustart nach dem Tod des Servers

- **GIVEN** eine Session, die durch das Ende des tmux-Servers `Interrupted` wurde, mit einer schreibenden View
- **WHEN** `restart` aufgerufen wird
- **THEN** ist die Session `Running`, die View ist weiter Schreiber, und ihre Eingabe erscheint in der Ausgabe
