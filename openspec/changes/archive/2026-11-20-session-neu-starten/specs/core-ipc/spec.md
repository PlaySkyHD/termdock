## ADDED Requirements

### Requirement: Session über die IPC neu starten

`session.restart` SHALL eine Session in `Exited` oder `Interrupted` über die Registry unter derselben ID mit ihrem gespeicherten `LaunchSpec`, Namen und Workspace neu starten und `{ session }` liefern; die Zustände meldet `session.stateChanged`. Eine unbekannte ID MUST `not_found` ergeben, jeder andere Zustand oder ein laufender Lifecycle-Aufruf `invalid_state`. Zwei parallele Anfragen MUST genau einen Start auslösen.

#### Scenario: Unterbrochene Session neu starten

- **GIVEN** ein Listen-Client und eine `Interrupted`-Session in Workspace `w1`
- **WHEN** er `session.restart` sendet
- **THEN** erhält er die Session mit derselben ID, demselben `LaunchSpec` und Workspace, `session.stateChanged` mit `Starting` und danach `Detached`, und das Backend hat einen neuen Start erhalten

#### Scenario: Laufende Session

- **GIVEN** eine Session im Zustand `Running` oder `Detached`
- **WHEN** ein Client `session.restart` sendet
- **THEN** antwortet der Core mit `invalid_state`, und das Backend erhält keinen Start

#### Scenario: Unbekannte Session

- **WHEN** ein Client `session.restart` mit einer unbekannten ID sendet
- **THEN** antwortet der Core mit `not_found`

#### Scenario: Zwei Anfragen gleichzeitig

- **GIVEN** eine `Exited`-Session
- **WHEN** zwei Clients `session.restart` senden, ohne auf die Antwort zu warten
- **THEN** erhält genau einer die Session, der andere `invalid_state`, und das Backend hat genau einen neuen Start erhalten

#### Scenario: tmux-Session lebt noch

- **GIVEN** eine WSL-Session, die `Interrupted` ist, und eine tmux-Session unter ihrem Namen
- **WHEN** ein Client `session.restart` sendet
- **THEN** bindet der Core sich an diese tmux-Session an, und es gibt danach genau eine tmux-Session unter dem Namen
