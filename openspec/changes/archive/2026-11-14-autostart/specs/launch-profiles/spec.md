## MODIFIED Requirements

### Requirement: Profile verwalten

Der Core SHALL `profile.list` (alle Profile in Anlegereihenfolge), `profile.create`, `profile.update` und `profile.delete` beantworten. Er MUST die ID vergeben und `autostart` mit `false`, `loggingEnabled` mit `true` vorbelegen. Eine unbekannte `profileId` MUST `not_found` ergeben. Bei `profile.update` MUST `null` für `workspaceId` oder `projectId` die Bindung entfernen. Ändern von `autostart` startet nichts; es wirkt beim nächsten Core-Start.

#### Scenario: Anlegen, ändern, auflisten, löschen

- **GIVEN** ein Core ohne Profile
- **WHEN** ein Client `profile.create { name: "Claude", launch: { backend: "wsl", cwd: "/home/dev", command: ["claude"] } }`, dann `profile.update { profileId, autostart: true }` und `profile.list` aufruft
- **THEN** liefert die Liste genau ein Profil mit dieser ID, dem Befehl als Array, `autostart: true` und `loggingEnabled: true`, `session.list` bleibt leer; nach `profile.delete` ist die Liste leer

#### Scenario: Unbekanntes Profil

- **GIVEN** ein Core ohne Profil `x`
- **WHEN** ein Client `profile.update { profileId: "x", name: "a" }` oder `profile.delete { profileId: "x" }` aufruft
- **THEN** antwortet der Core mit `not_found` und sendet kein `profile.changed`

## ADDED Requirements

### Requirement: Autostart beim Core-Start

Nach dem Reconcile SHALL der Core einmal je Core-Start für jedes Profil mit `autostart: true` ohne Session in `Starting`, `Running` oder `Detached` (Bindung über `profileId`) eine Session anlegen, wie `session.create { name, profileId }` mit dem Namen des Profils. Sessions in `Exited`, `Interrupted` oder `Archived` MUST unverändert bleiben. Nur der Core löst den Autostart aus, kein Client. Die neue Session MUST wie jede neue Session mit `session.created` gemeldet werden.

#### Scenario: Nur markierte Profile

- **GIVEN** zwei Profile mit `autostart: true` und eines ohne
- **WHEN** der Core startet
- **THEN** gibt es genau zwei Sessions, je eine mit der `profileId`, dem Namen, dem Workspace, dem Verlauf-Schalter und dem `LaunchSpec` eines Autostart-Profils, und `session.created` wurde für jede einmal gemeldet

#### Scenario: Neustart mit laufenden Sessions

- **GIVEN** ein Core, der zwei Autostart-Sessions gestartet hat, deren WSL-Sessions weiterlaufen
- **WHEN** der Core ohne Stop beendet und neu gestartet wird
- **THEN** sind beide Sessions `Detached` und es gibt keine weitere Session

#### Scenario: Zwei Clients

- **GIVEN** ein Autostart-Profil und zwei Clients, die sich während des Core-Starts verbinden und `session.list` senden
- **WHEN** beide Antworten eintreffen
- **THEN** nennen beide dieselbe eine Session des Profils, und es wurde genau ein Start an das Backend gegeben

#### Scenario: Unterbrochene Session

- **GIVEN** ein Autostart-Profil, dessen einzige Session `Interrupted` ist
- **WHEN** der Core startet
- **THEN** gibt es eine neue Session des Profils und die alte ist weiter `Interrupted`

#### Scenario: Standardverzeichnis

- **GIVEN** ein Autostart-Profil mit `cwd: "~"`, gebunden an ein Projekt mit Pfad `/home/dev/api`
- **WHEN** der Core startet
- **THEN** startet die Session in `/home/dev/api`

### Requirement: Autostart bei nicht erreichbarem Backend

Fehlt das Backend eines Autostart-Profils oder ist es nicht erreichbar, SHALL der Core für dieses Profil keine Session anlegen und das Backend einmal je Core-Start auf stderr (`backend_unavailable`) und in `core.status` melden. Scheitert ein Start, MUST die Session `Interrupted` werden und der Fehler einmal gemeldet werden. Der Core MUST den Autostart in keinem der Fälle wiederholen.

#### Scenario: WSL nicht erreichbar

- **GIVEN** zwei Autostart-Profile für WSL und ein WSL-Backend, das nicht erreichbar ist
- **WHEN** der Core startet
- **THEN** gibt es keine Session, das Backend wurde einmal auf Erreichbarkeit geprüft, stderr meldet `backend_unavailable` einmal und `core.status` nennt `wsl`

#### Scenario: Start scheitert

- **GIVEN** ein Autostart-Profil und ein Backend, dessen Start fehlschlägt
- **WHEN** der Core startet
- **THEN** ist die Session des Profils `Interrupted`, der Fehler steht einmal auf stderr und das Backend hat genau einen Start erhalten
