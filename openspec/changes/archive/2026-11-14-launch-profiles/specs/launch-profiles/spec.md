# launch-profiles Specification

## Purpose
Legt fest, wie der Core Startprofile verwaltet: die Methoden `profile.*`, die Bindung an Workspace und Projekt, das Anlegen einer Session aus einem Profil mit Überschreiben und Standardverzeichnis, `profile.changed` und die Persistenz in `launch_profiles`. Befehle sind Argument-Arrays, nie Shell-Strings (Konzept Kap. 9).

## ADDED Requirements

### Requirement: Profile verwalten

Der Core SHALL `profile.list` (alle Profile in Anlegereihenfolge), `profile.create`, `profile.update` und `profile.delete` beantworten. Er MUST die ID vergeben und `autostart` mit `false`, `loggingEnabled` mit `true` vorbelegen. Eine unbekannte `profileId` MUST `not_found` ergeben. Bei `profile.update` MUST `null` für `workspaceId` oder `projectId` die Bindung entfernen. `autostart` wird nur gespeichert.

#### Scenario: Anlegen, ändern, auflisten, löschen

- **GIVEN** ein Core ohne Profile
- **WHEN** ein Client `profile.create { name: "Claude", launch: { backend: "wsl", cwd: "/home/dev", command: ["claude"] } }`, dann `profile.update { profileId, autostart: true }` und `profile.list` aufruft
- **THEN** liefert die Liste genau ein Profil mit dieser ID, dem Befehl als Array, `autostart: true` und `loggingEnabled: true`; nach `profile.delete` ist sie leer

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

Der Core SHALL beim Anlegen und Ändern eines Profils prüfen, dass `workspaceId` und `projectId` bestehen (sonst `not_found`) und dass das Projekt zum Workspace gehört (sonst `bad_request`). Fehlt `workspaceId` bei gesetztem `projectId`, MUST der Core den Workspace des Projekts eintragen; `workspaceId: null` bei bleibendem Projekt MUST `bad_request` ergeben. Eine abgelehnte Anfrage MUST nichts speichern.

#### Scenario: Projekt eines anderen Workspace

- **GIVEN** ein Projekt `p1` im Workspace `w1` und ein Workspace `w2`
- **WHEN** ein Client ein Profil mit `workspaceId: "w2"` und `projectId: "p1"` anlegt
- **THEN** antwortet der Core mit `bad_request`, und `profile.list` bleibt leer

#### Scenario: Workspace aus dem Projekt

- **GIVEN** ein Projekt `p1` im Workspace `w1`
- **WHEN** ein Client ein Profil nur mit `projectId: "p1"` anlegt
- **THEN** trägt das gespeicherte Profil `workspaceId: "w1"`

#### Scenario: Unbekannte IDs

- **GIVEN** ein Core ohne Workspace `nope`
- **WHEN** ein Client ein Profil mit `workspaceId: "nope"` oder mit einem unbekannten `projectId` anlegt
- **THEN** antwortet der Core mit `not_found`

### Requirement: Session aus einem Profil anlegen

Der Core SHALL bei `session.create` mit `profileId` ohne `launch` den `LaunchSpec` des Profils übernehmen; ein ausdrückliches `launch` MUST den Spec als Ganzes ersetzen. `loggingEnabled` der Anfrage MUST vor dem des Profils gelten. Die Session MUST die `profileId` tragen. Ein unbekanntes Profil MUST `not_found` ergeben und keine Session anlegen. Der Befehl bleibt ein Argument-Array; `env` enthält keine Geheimnisse, Zugangsdaten kommen aus bestehenden CLI-Logins.

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

Hat ein Profil `launch.cwd` `~` und kein ausdrückliches `launch` in der Anfrage, SHALL der Core `defaultCwd` mit dem Backend des Profils, dem Projekt und dem Workspace des Profils und den Einstellungen anwenden: Projektpfad, `defaultCwd` des Workspace, `defaultCwd` der Einstellungen, sonst `~`. Jedes andere `cwd` MUST unverändert bleiben. Bis zur Verdrahtung des Settings-Repositories (#60) gelten die Standard-Einstellungen.

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

### Requirement: Profile bleiben über Neustarts

Der Core SHALL Profile in der Tabelle `launch_profiles` speichern und beim Start über `profile.list` wieder liefern, mit `command` und `env` unverändert. Löschen eines Workspace oder Projekts MUST das Profil bestehen lassen und nur die Bindung entfernen.

#### Scenario: Neustart

- **GIVEN** ein Profil mit Befehl, an einen Workspace gebunden, und ein zweites an einen gelöschten Workspace
- **WHEN** der Core neu gestartet wird
- **THEN** listet `profile.list` beide Profile, das zweite ohne `workspaceId`
