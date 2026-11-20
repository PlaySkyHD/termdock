## MODIFIED Requirements

### Requirement: Reconcile beim Core-Start

Beim Start SHALL der Core alle gespeicherten Sessions laden und jede in `Starting`, `Running` oder `Detached` abgleichen. WSL: existiert die Backend-Session, MUST er sich wieder anbinden und sie `Detached` setzen, sonst oder bei gescheitertem Anbinden `Interrupted`. Die Existenz MUST er je Backend gebündelt erfragen (`listLive`), ohne Antwort per `exists`. Windows-Sessions MUST ohne Backend-Aufruf `Interrupted` werden. Neue Zustände MUST gespeichert werden. Erst danach MUST der Autostart laufen.

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
- **THEN** ist die erste `Detached` und ihr Profil bekommt keine neue Session; die zweite wird nach dem Reconcile `Interrupted`, danach unter ihrer ID neu gestartet, und es gibt keine weitere Session

#### Scenario: Gebündelte Prüfung

- **GIVEN** gespeicherte WSL-Sessions in `Running`, `Detached` und `Starting`, von denen zwei leben, sowie beendete Sessions, und ein Backend mit `listLive`
- **WHEN** der Core startet
- **THEN** fragt er `listLive` genau einmal mit den drei abzugleichenden Sessions, ruft `exists` nicht auf, die zwei lebenden sind `Detached` und angebunden, die dritte ist `Interrupted`

#### Scenario: Rückfall auf die Einzelprüfung

- **GIVEN** gespeicherte WSL-Sessions in `Running` und ein Backend, dessen `listLive` `undefined` liefert oder fehlschlägt
- **WHEN** der Core startet
- **THEN** prüft er jede Session mit `exists`, gleicht sie danach ab und meldet `backend_unavailable` nur, wenn eine Einzelprüfung fehlschlägt

#### Scenario: Kein Bündel für nicht erreichbare Backends

- **GIVEN** eine gespeicherte WSL-Session in `Running` mit nicht verfügbarem WSL-Backend und eine Windows-Session in `Running`
- **WHEN** der Core startet
- **THEN** fragt er kein `listLive`, beide Sessions sind `Interrupted` und das Ergebnis meldet `backend_unavailable` für WSL

#### Scenario: Core endet während der gebündelten Prüfung

- **GIVEN** ein laufendes `listLive` beim Start
- **WHEN** der Core verworfen wird, bevor es antwortet
- **THEN** bindet er keine Session an und speichert keinen neuen Zustand
