## Purpose

Legt fest, wie der Core Workspaces und ihre Projektordner verwaltet: die Methoden `workspace.*` und `project.*`, Pfadprüfung je Backend, `workspace.changed`, das Löschen eines Workspace mit laufenden Sessions, das Standardverzeichnis neuer Sessions und die Persistenz in den Tabellen `workspaces` und `projects` (Konzept Kap. 2, 3, 5).

## ADDED Requirements

### Requirement: Workspaces verwalten

Der Core SHALL `workspace.list` (alle Workspaces mit Projekten, Anlegereihenfolge), `workspace.create`, `workspace.update` und `workspace.delete` beantworten. Er MUST die ID vergeben und höchstens 64 Workspaces zulassen (sonst `invalid_state`). Eine unbekannte `workspaceId` MUST `not_found` ergeben. `null` für `defaultCwd` MUST den Wert entfernen. Das zusammengeführte Objekt MUST mit `validateWorkspace` geprüft sein, bevor es gespeichert wird (sonst `bad_request`).

#### Scenario: Anlegen, umbenennen, auflisten

- **GIVEN** ein Core ohne Workspaces
- **WHEN** ein Client `workspace.create { name: "Web" }` und danach `workspace.update { workspaceId, name: "Web 2", defaultCwd: "/srv" }` aufruft
- **THEN** liefert `workspace.list` genau einen Workspace mit dieser ID, dem Namen „Web 2“, `defaultCwd` `/srv` und ohne Projekte

#### Scenario: Unbekannter Workspace

- **GIVEN** ein Core ohne Workspace `x`
- **WHEN** ein Client `workspace.update { workspaceId: "x", name: "a" }` oder `workspace.delete { workspaceId: "x" }` aufruft
- **THEN** antwortet der Core mit `not_found` und sendet kein `workspace.changed`

#### Scenario: Grenze der Workspaces

- **GIVEN** ein Core mit 64 Workspaces
- **WHEN** ein Client `workspace.create` aufruft
- **THEN** antwortet der Core mit `invalid_state` und speichert nichts

### Requirement: Projekte verwalten

Der Core SHALL `project.create`, `project.update` und `project.delete` auf den Projekten eines Workspace beantworten. Er MUST die Projekt-ID vergeben, höchstens 16 Projekte je Workspace zulassen (sonst `invalid_state`) und eine unbekannte `workspaceId` oder `projectId` mit `not_found` ablehnen. Bei `project.update` MUST `distro: null` die Distribution entfernen. Der zusammengeführte Workspace MUST mit `validateWorkspace` geprüft sein, bevor er gespeichert wird (sonst `bad_request`).

#### Scenario: Projekt hinzufügen und ändern

- **GIVEN** ein Workspace ohne Projekte
- **WHEN** ein Client `project.create { workspaceId, name: "api", path: "/home/dev/api", backend: "wsl" }` und danach `project.update { projectId, name: "api2" }` aufruft
- **THEN** liefert `workspace.list` den Workspace mit einem Projekt `api2` mit unverändertem Pfad und Backend

#### Scenario: Projekt löschen

- **GIVEN** ein Workspace mit zwei Projekten
- **WHEN** ein Client `project.delete { projectId }` für eines aufruft
- **THEN** enthält der Workspace nur noch das andere Projekt

#### Scenario: Grenze der Projekte

- **GIVEN** ein Workspace mit 16 Projekten
- **WHEN** ein Client `project.create` für ihn aufruft
- **THEN** antwortet der Core mit `invalid_state`

#### Scenario: Backend wechseln ohne Distribution zu entfernen

- **GIVEN** ein Projekt mit Backend `wsl` und `distro: "Ubuntu"`
- **WHEN** ein Client `project.update { projectId, backend: "windows" }` ohne `distro: null` aufruft
- **THEN** antwortet der Core mit `bad_request` und das Projekt bleibt unverändert

### Requirement: Projektpfade je Backend

Der Core SHALL den Pfad eines Projekts beim Anlegen und Ändern nur syntaktisch prüfen, ohne Dateisystemzugriff: ein absoluter Linux-Pfad (beginnt mit `/`) für `wsl`, ein Windows-Pfad (Laufwerk `C:\` oder `C:/`, oder UNC `\\server\share`) für `windows`. Bei `project.update` MUST der Core das zusammengeführte Projekt prüfen, auch wenn nur das Backend wechselt. Ein Verstoß MUST `bad_request` ergeben.

#### Scenario: Windows-Pfad bei Backend wsl

- **GIVEN** ein Workspace
- **WHEN** ein Client `project.create` mit Backend `wsl` und Pfad `C:\dev\api` aufruft
- **THEN** antwortet der Core mit `bad_request`, und `workspace.list` zeigt kein neues Projekt

#### Scenario: Backend-Wechsel mit altem Pfad

- **GIVEN** ein Projekt mit Backend `wsl` und Pfad `/home/dev/api`
- **WHEN** ein Client `project.update { projectId, backend: "windows", distro: null }` aufruft
- **THEN** antwortet der Core mit `bad_request`; mit zusätzlich `path: "D:\\dev\\api"` ist die Änderung gültig

### Requirement: Änderungen melden

Der Core SHALL nach jeder gespeicherten Änderung an Workspaces oder Projekten das Event `workspace.changed` mit der vollständigen Liste an alle Verbindungen senden, die `session.list` genutzt haben, auch an die anfragende, vor deren Antwort. Abgelehnte Anfragen MUST kein Event auslösen.

#### Scenario: Zweiter Client sieht die Änderung

- **GIVEN** Client A und Client B sind verbunden und haben `session.list` genutzt, Client C nicht
- **WHEN** A einen Workspace anlegt und ein Projekt hinzufügt
- **THEN** erhalten A und B je ein `workspace.changed` je Änderung mit der vollständigen Liste, C erhält keines

### Requirement: Workspace löschen lässt Sessions laufen

Beim Löschen eines Workspace SHALL der Core seine Projekte löschen und `workspaceId` jeder seiner Sessions im Speicher und in der Datenbank entfernen; die Prozesse MUST weiterlaufen und ihren Zustand behalten. Er MUST je betroffener Session `session.updated` ohne `workspaceId` senden und danach `workspace.changed`. Profile mit Bindung an den Workspace oder eines seiner Projekte MUST bestehen bleiben, ohne diese Bindung.

#### Scenario: Workspace mit laufender Session löschen

- **GIVEN** ein Workspace mit einer laufenden Session, ein zweiter Client hat `session.list` genutzt
- **WHEN** der erste Client den Workspace löscht
- **THEN** erhält der zweite Client `session.updated` mit der Session ohne `workspaceId` im Zustand `Running`, danach `workspace.changed` ohne den Workspace; `session.list` zeigt die Session gruppenlos

#### Scenario: Gruppenlos nach Neustart

- **GIVEN** ein gelöschter Workspace mit einer Session
- **WHEN** der Core neu gestartet wird
- **THEN** ist die Session weiterhin gruppenlos gespeichert

#### Scenario: Sessions anderer Workspaces bleiben

- **GIVEN** zwei Workspaces mit je einer Session
- **WHEN** einer gelöscht wird
- **THEN** behält die Session des anderen ihre `workspaceId` und erhält kein `session.updated`

### Requirement: Standardverzeichnis für neue Sessions

Der Core SHALL eine reine Funktion `defaultCwd` bereitstellen, die für eine Session ohne `cwd` das erste gesetzte aus Projektpfad, `defaultCwd` des Workspace und `defaultCwd` der Einstellungen liefert, sonst `~`. Die Einstellungen MUST als Parameter übergeben werden; die Funktion MUST weder das Dateisystem noch ein Repository lesen.

#### Scenario: Rangfolge

- **GIVEN** ein Projekt mit Pfad `/p`, ein Workspace mit `defaultCwd` `/w` und Einstellungen mit `defaultCwd` `/s`
- **WHEN** `defaultCwd` mit allen dreien, danach ohne Projekt, ohne Workspace-Wert und ohne Einstellung aufgerufen wird
- **THEN** liefert sie nacheinander `/p`, `/w`, `/s` und `~`

### Requirement: Persistenz der Workspaces

Der Core SHALL Workspaces und Projekte in den Tabellen `workspaces` und `projects` speichern (ADR 0004) und nach einem Neustart unverändert in Anlegereihenfolge liefern. Ein nicht gesetztes `defaultCwd` oder `distro` MUST nicht gesetzt bleiben.

#### Scenario: Neustart

- **GIVEN** ein Workspace mit `defaultCwd` und zwei Projekten, eines mit `distro`, das andere mit Backend `windows`
- **WHEN** die Datenbank geschlossen und neu geöffnet wird
- **THEN** liefert `workspace.list` denselben Workspace mit denselben Projekten in derselben Reihenfolge, das Windows-Projekt ohne `distro`
