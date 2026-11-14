## MODIFIED Requirements

### Requirement: Reconcile beim Core-Start

Beim Start SHALL der Core alle gespeicherten Sessions laden und jede in `Starting`, `Running` oder `Detached` abgleichen. WSL: existiert die Backend-Session, MUST der Core sich wieder anbinden und sie `Detached` setzen, sonst oder bei gescheitertem Anbinden `Interrupted`. Windows-Sessions MUST ohne Backend-Aufruf `Interrupted` werden. Neue Zustände MUST gespeichert werden. Erst danach MUST der Autostart laufen (Capability `launch-profiles`) und die abgeglichenen Zustände sehen.

#### Scenario: Lebende WSL-Session

- **GIVEN** eine gespeicherte WSL-Session in `Running`, deren tmux-Session noch existiert
- **WHEN** der Core startet
- **THEN** hat sich der Core über das Backend wieder angebunden, ohne einen neuen Prozess zu starten, und die Session ist `Detached`

#### Scenario: Fehlende WSL-Session

- **GIVEN** eine gespeicherte WSL-Session in `Detached`, deren tmux-Session nicht mehr existiert
- **WHEN** der Core startet
- **THEN** ist die Session `Interrupted`

#### Scenario: Windows-Session

- **GIVEN** eine gespeicherte Windows-Session in `Running`
- **WHEN** der Core startet
- **THEN** ist die Session `Interrupted`

#### Scenario: Neustart des Core mit derselben Datenbank

- **GIVEN** ein Core mit Datenbankdatei, der eine WSL-Session mit lebender tmux-Session, eine WSL-Session, deren tmux-Session endet, eine Windows-Session und eine beendete Session angelegt hat
- **WHEN** der Core verworfen und ein neuer Core auf derselben Datei gestartet wird
- **THEN** ist die erste Session `Detached` und angebunden, die zweite und dritte `Interrupted`, die vierte `Exited`, und alle behalten ID, Name und `LaunchSpec`

#### Scenario: Autostart nach dem Reconcile

- **GIVEN** eine gespeicherte WSL-Session eines Autostart-Profils in `Running`, deren tmux-Session noch existiert, und eine eines zweiten Autostart-Profils, deren tmux-Session fehlt
- **WHEN** der Core startet
- **THEN** ist die erste `Detached` und ihr Profil bekommt keine neue Session; die zweite ist `Interrupted` und ihr Profil bekommt genau eine neue
