## MODIFIED Requirements

### Requirement: Ablage und Schema

Der Core SHALL die Metadaten in der SQLite-Datei `termdock.db` im Datenverzeichnis ablegen. Das Datenverzeichnis MUST `TERMDOCK_DATA_DIR` sein, wenn die Variable gesetzt ist, sonst `%APPDATA%\TermDock`. Die Datenbank MUST im WAL-Modus laufen. Das Schema MUST über nummerierte Migrationen aufgebaut werden, deren höchste angewendete Nummer in der Tabelle `schema_version` steht. Jede Migration MUST genau einmal und vollständig oder gar nicht angewendet werden.

#### Scenario: Migration auf leerer Datenbank

- **GIVEN** ein leeres Datenverzeichnis
- **WHEN** der Core die Datenbank öffnet
- **THEN** existiert `termdock.db` mit den Tabellen `sessions`, `workspaces`, `projects`, `layouts`, `launch_profiles` und `settings`, `schema_version` nennt die höchste Migration und die Datenbank läuft im WAL-Modus

#### Scenario: Erneutes Öffnen

- **GIVEN** eine Datenbank, auf die alle Migrationen schon angewendet sind und die Sessions enthält
- **WHEN** der Core sie erneut öffnet
- **THEN** wird keine Migration erneut angewendet und die Sessions sind unverändert

#### Scenario: Gleichzeitiges Migrieren

- **GIVEN** zwei Verbindungen auf dieselbe leere Datei, von denen die zweite migriert, nachdem die erste die Schema-Version gelesen hat
- **WHEN** die erste Verbindung migriert
- **THEN** überspringt sie die schon angewendeten Migrationen ohne Fehler und `schema_version` enthält jede Migration genau einmal

#### Scenario: Datenverzeichnis aus der Umgebung

- **GIVEN** `TERMDOCK_DATA_DIR` zeigt auf ein Verzeichnis
- **WHEN** das Datenverzeichnis bestimmt wird
- **THEN** ist es dieses Verzeichnis, sonst `TermDock` unter `%APPDATA%`

## ADDED Requirements

### Requirement: Schema der Phase 3

Migration 3 SHALL die Tabellen `launch_profiles` (ID, Name, Workspace, Projekt, `LaunchSpec` in Spalten, Autostart, Verlauf-Schalter, Zeiten) und `settings` (Schlüssel, JSON-Wert), die Spalten `projects.backend` (Standard `wsl`), `projects.distro` und `workspaces.default_cwd` sowie den Index `sessions_profile` anlegen. Bestandsdaten MUST erhalten bleiben. Löschen eines Workspace oder Projekts MUST die Bindung eines Profils entfernen, nicht das Profil.

#### Scenario: Migration 2 → 3

- **GIVEN** eine Datenbank mit Schema-Version 2, einem Workspace mit Projekt, einer Session und einem gespeicherten Layout
- **WHEN** der Core sie öffnet
- **THEN** ist die Schema-Version 3, Session und Layout sind unverändert, das Projekt hat Backend `wsl` ohne `distro` und der Workspace kein `default_cwd`

#### Scenario: Profil verliert die Bindung

- **GIVEN** ein Profil, das an einen Workspace und eines seiner Projekte gebunden ist
- **WHEN** der Workspace gelöscht wird
- **THEN** besteht das Profil weiter, ohne Workspace und ohne Projekt

#### Scenario: Profil verliert nur das Projekt

- **GIVEN** ein Profil, das an einen Workspace und eines seiner Projekte gebunden ist
- **WHEN** nur das Projekt gelöscht wird
- **THEN** besteht das Profil weiter, ohne Projekt und weiter mit dem Workspace

### Requirement: Bindungen an Workspaces

`sessions.workspace_id` hat keinen Fremdschlüssel. Beim Löschen eines Workspace MUST der Core `workspace_id` jeder seiner Sessions auf NULL setzen und je Session `session.updated` senden; die Prozesse laufen weiter (umgesetzt mit #56). Hat ein Profil ein Projekt, MUST sein Workspace der Workspace dieses Projekts sein; der Core MUST das beim Anlegen und Ändern prüfen (umgesetzt mit #58).

#### Scenario: Workspace mit Sessions löschen

- **GIVEN** ein Workspace mit einer laufenden Session
- **WHEN** der Workspace gelöscht wird
- **THEN** ist die Session gruppenlos gespeichert, läuft weiter, und Listen-Clients erhalten `session.updated` ohne `workspaceId`

#### Scenario: Projekt eines anderen Workspace im Profil

- **GIVEN** ein Projekt `p1` im Workspace `w1`
- **WHEN** ein Profil mit `workspaceId: "w2"` und `projectId: "p1"` angelegt wird
- **THEN** lehnt der Core es mit `bad_request` ab und speichert nichts
