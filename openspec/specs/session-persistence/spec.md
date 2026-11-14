# session-persistence Specification

## Purpose
Legt fest, wie der Core die Metadaten von Sessions in SQLite ablegt und migriert, jede Änderung durchschreibt und die gespeicherten Sessions beim Core-Start mit den Backends abgleicht, so dass verlorene Prozesse als `Interrupted` erscheinen.

## Requirements

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

### Requirement: Session-Metadaten speichern

Der Core SHALL zu jeder Session ID, Name, Zustand, `LaunchSpec` (Backend, Distro, Shell, Arbeitsverzeichnis, Kommando, Umgebung), Workspace, Profil, Terminalgröße, letzten Exit-Code, Verlauf-Schalter sowie Anlage- und Änderungszeit speichern. Gelesene Sessions MUST den gespeicherten Werten gleichen; nicht gesetzte optionale Felder MUST nicht gesetzt bleiben. Views und Schreiber MUST NOT gespeichert werden.

#### Scenario: Roundtrip

- **GIVEN** eine Session mit allen optionalen Feldern und eine ohne optionale Felder
- **WHEN** beide gespeichert und wieder gelesen werden
- **THEN** gleichen sie den gespeicherten Sessions

#### Scenario: Überschreiben

- **GIVEN** eine gespeicherte Session
- **WHEN** sie mit geändertem Zustand erneut gespeichert wird
- **THEN** gibt es sie genau einmal mit dem neuen Zustand

### Requirement: Durchschreiben aus der Registry

Ist ein Repository angebunden, SHALL der Core jede Änderung einer Session sofort speichern: Anlegen, jeden Zustandswechsel, Exit-Code, Terminalgröße, Name, Workspace, Verlauf-Schalter und Änderungszeit. Ein Zustandswechsel MUST gespeichert sein, bevor er gemeldet wird. Das Löschen einer Session MUST ihre Zeile entfernen; ein neuer Core MUST sie nicht mehr laden. Ohne Repository MUST sich der Core unverändert verhalten.

#### Scenario: Zustandswechsel wird gespeichert

- **GIVEN** eine Registry mit Repository
- **WHEN** eine Session angelegt wird und ihr Prozess danach mit Exit-Code 3 endet
- **THEN** enthält das Repository die Session im Zustand `Exited` mit letztem Exit-Code 3

#### Scenario: Gespeichert vor der Meldung

- **GIVEN** eine Registry mit Repository und ein Listener für Zustandswechsel
- **WHEN** die Session ihren Zustand ändert
- **THEN** liest der Listener den neuen Zustand bereits aus dem Repository

#### Scenario: Größe wird gespeichert

- **GIVEN** eine laufende Session mit Schreiber
- **WHEN** der Schreiber die Größe 120×40 setzt
- **THEN** enthält das Repository die Größe 120×40

#### Scenario: Umbenennen und Verschieben werden gespeichert

- **GIVEN** eine Registry mit Repository und eine Session im Workspace `w1`
- **WHEN** sie umbenannt und gruppenlos gemacht wird
- **THEN** enthält das Repository den neuen Namen, keinen Workspace und die neue Änderungszeit

#### Scenario: Gelöschte Session wird nicht mehr geladen

- **GIVEN** ein Core mit Datenbankdatei und zwei Sessions, von denen eine gelöscht wurde
- **WHEN** ein neuer Core auf derselben Datei startet
- **THEN** listet er nur die andere Session

### Requirement: Fehler beim Speichern

Scheitert das Speichern einer Änderung einer bestehenden Session, SHALL der Core die Änderung trotzdem im Speicher übernehmen und melden und den Fehler an den Fehler-Handler der Registry geben (Standard: Konsole). Scheitert schon das Speichern einer neuen Session, MUST das Anlegen mit `internal` fehlschlagen, ohne die Session zu registrieren oder zu starten.

#### Scenario: Zustandswechsel kann nicht gespeichert werden

- **GIVEN** eine laufende Session und ein Repository, dessen Speichern fehlschlägt
- **WHEN** die PTY mit Exit-Code 3 endet
- **THEN** ist die Session `Exited` mit Exit-Code 3, der Zustandswechsel wird gemeldet, der Fehler geht an den Fehler-Handler und das PTY-Ende wirft keinen Fehler

#### Scenario: Neue Session kann nicht gespeichert werden

- **GIVEN** ein Repository, dessen Speichern fehlschlägt
- **WHEN** eine Session angelegt wird
- **THEN** schlägt der Aufruf mit `internal` fehl, die Registry enthält keine Session und das Backend hat keinen Start erhalten

### Requirement: Reconcile beim Core-Start

Beim Start SHALL der Core alle gespeicherten Sessions laden und jede in `Starting`, `Running` oder `Detached` abgleichen. WSL: existiert die Backend-Session, MUST der Core sich wieder anbinden und sie `Detached` setzen, sonst oder bei gescheitertem Anbinden `Interrupted`. Windows-Sessions MUST ohne Backend-Aufruf `Interrupted` werden. Neue Zustände MUST gespeichert werden.

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

### Requirement: Reconcile bei nicht erreichbarem Backend

Ist das Backend einer abzugleichenden Session nicht verfügbar, fehlt es oder scheitert die Existenzprüfung, SHALL der Core die Session `Interrupted` setzen und im Ergebnis des Starts `backend_unavailable` für dieses Backend melden. Die übrigen Sessions MUST trotzdem abgeglichen werden.

#### Scenario: WSL nicht erreichbar

- **GIVEN** gespeicherte WSL-Sessions in `Running` und ein WSL-Backend, das nicht verfügbar ist oder dessen Existenzprüfung fehlschlägt
- **WHEN** der Core startet
- **THEN** sind die Sessions `Interrupted` und das Ergebnis meldet `backend_unavailable` für WSL

### Requirement: Beendete Sessions beim Reconcile

Sessions in `Exited`, `Interrupted` oder `Archived` SHALL der Core beim Start unverändert übernehmen, ohne ihr Backend zu fragen.

#### Scenario: Beendete Sessions bleiben

- **GIVEN** gespeicherte Sessions in `Exited` (Exit-Code 0), `Interrupted` und `Archived`
- **WHEN** der Core startet
- **THEN** haben sie unverändert ihren gespeicherten Zustand und Exit-Code, und das Backend wurde für sie nicht gefragt

### Requirement: Ablauf des Reconcile

Das Ergebnis des Reconcile SHALL für jede abgeglichene Session den Zustand am Ende des Reconcile nennen. Endet eine wieder angebundene PTY, während das Reconcile noch läuft, MUST das wie jedes PTY-Ende behandelt werden. Während des Reconcile MUST Anlegen und Neustart mit `invalid_state` abgelehnt werden. Scheitert das Laden der gespeicherten Sessions, MUST das Reconcile wiederholbar bleiben.

#### Scenario: PTY endet während des Reconcile

- **GIVEN** eine wieder angebundene WSL-Session, deren PTY mit Exit-Code 0 endet, während weitere Sessions noch abgeglichen werden
- **WHEN** das Reconcile endet
- **THEN** meldet das Ergebnis für sie `Exited` und sie ist mit diesem Zustand gespeichert

#### Scenario: Anlegen während des Reconcile

- **GIVEN** ein laufendes Reconcile
- **WHEN** eine Session angelegt oder eine gespeicherte Session neu gestartet werden soll
- **THEN** schlägt der Aufruf mit `invalid_state` fehl

#### Scenario: Laden scheitert

- **GIVEN** ein Repository, dessen Lesen einmal fehlschlägt
- **WHEN** das Reconcile fehlschlägt und erneut aufgerufen wird
- **THEN** lädt der zweite Aufruf die gespeicherten Sessions

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

### Requirement: Verlauf beim Löschen entfernen

Beim Löschen einer Session SHALL der Core das Verzeichnis `history/<sessionId>/` im Datenverzeichnis rekursiv entfernen, bevor er ihre Zeile entfernt; ein fehlendes Verzeichnis MUST kein Fehler sein. Der Pfad MUST nur aus einer Session-ID aus Buchstaben, Ziffern, `-` und `_` entstehen und unter `history/` liegen, sonst MUST nichts entfernt werden. Archivieren MUST den Verlauf nicht entfernen.

#### Scenario: Verlauf wird entfernt

- **GIVEN** zwei Sessions mit Verlaufsverzeichnis, von denen eine `Exited` ist
- **WHEN** die beendete Session gelöscht wird
- **THEN** fehlt ihr Verzeichnis unter `history/`, das der anderen besteht weiter

#### Scenario: Kein Verlauf vorhanden

- **GIVEN** eine Session ohne Verlaufsverzeichnis
- **WHEN** ihr Verlauf zweimal entfernt wird
- **THEN** gelingen beide Aufrufe

#### Scenario: Ungültige Session-ID

- **GIVEN** eine Session-ID `..` oder mit Pfadtrenner
- **WHEN** ihr Verlauf entfernt werden soll
- **THEN** schlägt der Aufruf fehl und keine Datei im Datenverzeichnis ist entfernt

#### Scenario: Verlauf kann nicht entfernt werden

- **GIVEN** eine `Exited`-Session, deren Verlauf sich nicht entfernen lässt
- **WHEN** sie gelöscht wird
- **THEN** schlägt der Aufruf mit `internal` fehl und die Session ist weiter gespeichert
