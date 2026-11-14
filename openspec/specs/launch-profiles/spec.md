# launch-profiles Specification

## Purpose
Legt fest, wie der Core Startprofile verwaltet: die Methoden `profile.*`, die Bindung an Workspace und Projekt, das Anlegen einer Session aus einem Profil mit Überschreiben und Standardverzeichnis, `profile.changed` und die Persistenz in `launch_profiles`. Befehle sind Argument-Arrays, nie Shell-Strings (Konzept Kap. 9).

## Requirements

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

### Requirement: Grenzen der Profile

Der Core SHALL höchstens 64 Profile zulassen (sonst `invalid_state`) und das zusammengeführte Profil mit `validateLaunchProfile` prüfen, bevor es gespeichert wird (sonst `bad_request`).

#### Scenario: Zu viele Profile

- **GIVEN** ein Core mit 64 Profilen
- **WHEN** ein Client `profile.create` aufruft
- **THEN** antwortet der Core mit `invalid_state` und speichert nichts

#### Scenario: Zu großes Profil

- **GIVEN** ein Core ohne Profile
- **WHEN** ein Client ein Profil anlegt, dessen `launch.env` es über 8 KiB bringt
- **THEN** antwortet der Core mit `bad_request` und speichert nichts

### Requirement: Bindung an Workspace und Projekt

Der Core SHALL beim Anlegen und Ändern eines Profils prüfen, dass `workspaceId` und `projectId` bestehen (sonst `not_found`) und dass das Projekt zum Workspace gehört (sonst `bad_request`). Fehlt `workspaceId` bei gesetztem `projectId`, MUST der Core den Workspace des Projekts eintragen, auch bei `profile.update` mit neuem `projectId`; `workspaceId: null` bei bleibendem Projekt MUST `bad_request` ergeben. Eine abgelehnte Anfrage MUST nichts speichern.

#### Scenario: Projekt eines anderen Workspace

- **GIVEN** ein Projekt `p1` im Workspace `w1` und ein Workspace `w2`
- **WHEN** ein Client ein Profil mit `workspaceId: "w2"` und `projectId: "p1"` anlegt
- **THEN** antwortet der Core mit `bad_request`, und `profile.list` bleibt leer

#### Scenario: Workspace aus dem Projekt

- **GIVEN** ein Projekt `p1` im Workspace `w1`
- **WHEN** ein Client ein Profil nur mit `projectId: "p1"` anlegt
- **THEN** trägt das gespeicherte Profil `workspaceId: "w1"`

#### Scenario: Projekt wechseln

- **GIVEN** ein Profil mit Projekt `p1` im Workspace `w1` und ein Projekt `p2` im Workspace `w2`
- **WHEN** ein Client `profile.update { profileId, projectId: "p2" }` ohne `workspaceId` aufruft
- **THEN** trägt das Profil danach `workspaceId: "w2"` und `projectId: "p2"`; mit `workspaceId: "w1"` in der Anfrage antwortet der Core mit `bad_request`

#### Scenario: Unbekannte IDs

- **GIVEN** ein Core ohne Workspace `nope`
- **WHEN** ein Client ein Profil mit `workspaceId: "nope"` oder mit einem unbekannten `projectId` anlegt
- **THEN** antwortet der Core mit `not_found`

### Requirement: Session aus einem Profil anlegen

Der Core SHALL bei `session.create` mit `profileId` ohne `launch` den `LaunchSpec` des Profils übernehmen; ein ausdrückliches `launch` MUST den Spec als Ganzes ersetzen. `loggingEnabled` der Anfrage MUST vor dem des Profils gelten. Die Session MUST die `profileId` tragen und, wenn die Anfrage keine `workspaceId` nennt, die `workspaceId` des Profils. Ein unbekanntes Profil MUST `not_found` ergeben und keine Session anlegen. Der Befehl bleibt ein Argument-Array.

#### Scenario: Workspace des Profils

- **GIVEN** ein Profil im Workspace `w1` und ein Workspace `w2`
- **WHEN** ein Client `session.create { name, profileId }` aufruft, danach mit `workspaceId: "w2"`, und nach dem Löschen von `w1` erneut ohne
- **THEN** liegt die erste Session in `w1`, die zweite in `w2` und die dritte in keinem Workspace

#### Scenario: Anlegen aus Profil

- **GIVEN** ein Profil mit `command: ["claude", "--resume"]`, `cwd: "/home/dev/claude"` und `loggingEnabled: false`
- **WHEN** ein Client `session.create { name, profileId }` ohne `launch` aufruft
- **THEN** hat die Session diesen `launch`, `loggingEnabled: false` und die `profileId`; mit `loggingEnabled: true` in der Anfrage ist es `true`

#### Scenario: Überschreiben

- **GIVEN** ein Profil mit `command` und `cwd`
- **WHEN** ein Client `session.create { name, profileId, launch: { backend: "wsl", cwd: "/tmp" } }` aufruft
- **THEN** hat die Session genau diesen `launch` ohne `command` des Profils und die `profileId`

#### Scenario: Unbekanntes Profil

- **GIVEN** ein Core ohne Profil `nope`
- **WHEN** ein Client `session.create` mit `profileId: "nope"` aufruft, mit oder ohne `launch`
- **THEN** antwortet der Core mit `not_found`, und `session.list` ist leer

### Requirement: Standardverzeichnis aus dem Profil

Hat ein Profil `launch.cwd` `~` und kein ausdrückliches `launch` in der Anfrage, SHALL der Core `defaultCwd` mit dem Backend des Profils, dem Projekt und dem Workspace des Profils und den Einstellungen anwenden: Projektpfad, `defaultCwd` des Workspace, `defaultCwd` der Einstellungen, sonst `~`. Jedes andere `cwd` MUST unverändert bleiben. Die Einstellungen sind die gespeicherten (Capability `settings`).

#### Scenario: Rangfolge

- **GIVEN** ein Projekt mit Pfad `/home/dev/api` in einem Workspace mit `defaultCwd` `/srv/web` und drei Profile mit `cwd: "~"`: eines mit dem Projekt, eines nur mit dem Workspace, eines ohne Bindung
- **WHEN** je eine Session aus ihnen angelegt wird
- **THEN** starten sie in `/home/dev/api`, `/srv/web` und `~`

#### Scenario: Eigenes Verzeichnis

- **GIVEN** ein Profil mit `cwd: "/home/dev/claude"` und einem Projekt
- **WHEN** eine Session daraus angelegt wird
- **THEN** startet sie in `/home/dev/claude`

#### Scenario: Befehl im Zielverzeichnis

- **GIVEN** ein Profil mit `command: ["bash", "-lc", "pwd; exec bash"]` und einem Projekt mit Pfad `/usr` (WSL-Integrationstest)
- **WHEN** eine Session daraus angelegt wird
- **THEN** zeigt ihr Terminal `/usr`

### Requirement: Profiländerungen melden

Der Core SHALL nach jeder gespeicherten Änderung an Profilen das Event `profile.changed` mit der vollständigen Liste an alle Verbindungen senden, die `session.list` genutzt haben, auch an die anfragende, vor deren Antwort. Nach `workspace.delete` und `project.delete` MUST er es ebenfalls senden, weil Profile ihre Bindung verlieren. Abgelehnte Anfragen MUST kein Event auslösen.

#### Scenario: Zweiter Client sieht die Änderung

- **GIVEN** Client A und B haben `session.list` genutzt, Client C nicht
- **WHEN** A ein Profil anlegt, ändert und löscht
- **THEN** erhalten A und B je ein `profile.changed` je Änderung mit der vollständigen Liste, C erhält keines

#### Scenario: Bindung verloren

- **GIVEN** zwei Profile, je an ein Projekt in einem eigenen Workspace gebunden, Client B hat `session.list` genutzt
- **WHEN** das eine Projekt und danach der andere Workspace gelöscht werden
- **THEN** erhält B nach jedem Löschen ein `profile.changed`: erst ohne das Projekt (Workspace bleibt), dann ohne Workspace und Projekt; die Profile bestehen weiter

### Requirement: Keine Geheimnisse in Profilen

Der Core SHALL beim Anlegen und Ändern eines Profils jeden Schlüssel von `launch.env` mit `bad_request` ablehnen, dessen Name auf `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY`, `APIKEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `CREDENTIAL` oder `CREDENTIALS` endet (Groß- und Kleinschreibung egal, Unterstrich in `API_KEY` und Co. optional). Die Meldung MUST den Schlüssel nennen, nie den Wert. Zugangsdaten kommen aus bestehenden CLI-Logins oder geschützten Umgebungsvariablen.

#### Scenario: Geheimnis in der Umgebung

- **GIVEN** ein Core ohne Profile
- **WHEN** ein Client ein Profil mit `launch.env { GITHUB_TOKEN: "abc" }` anlegt, oder ein bestehendes Profil mit `launch.env { NPM_TOKEN: "abc" }` ändert
- **THEN** antwortet der Core mit `bad_request`, die Meldung nennt den Schlüssel und nicht `abc`, und nichts wird gespeichert; `LANG` oder `TOKENS_PER_MIN` sind erlaubt

### Requirement: Profile bleiben über Neustarts

Der Core SHALL Profile in der Tabelle `launch_profiles` speichern und beim Start über `profile.list` wieder liefern, mit `command` und `env` unverändert. Löschen eines Workspace oder Projekts MUST das Profil bestehen lassen und nur die Bindung entfernen. Eine nicht lesbare oder ungültige Zeile MUST der Core überspringen und melden, ohne dass `profile.*` ausfällt.

#### Scenario: Beschädigte Zeile

- **GIVEN** eine gespeicherte Zeile mit ungültigem JSON in `command` neben einem gültigen Profil
- **WHEN** ein Client `profile.list` aufruft
- **THEN** liefert der Core nur das gültige Profil und meldet die Zeile mit ihrer ID im Log; `profile.delete` der beschädigten ID gelingt

#### Scenario: Neustart

- **GIVEN** ein Profil mit Befehl, an einen Workspace gebunden, und ein zweites an einen gelöschten Workspace
- **WHEN** der Core neu gestartet wird
- **THEN** listet `profile.list` beide Profile, das zweite ohne `workspaceId`

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
