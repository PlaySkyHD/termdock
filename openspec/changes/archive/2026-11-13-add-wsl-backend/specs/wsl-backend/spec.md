# Spec Delta

## Purpose

Legt fest, wie der Core Terminal-Sessions in WSL über tmux startet, wieder anbindet, prüft, beendet und als Snapshot ausliest, wie der Exit-Code ermittelt wird und wie WSL die Sessions ohne PTY am Leben lässt.

## ADDED Requirements

### Requirement: Start im tmux-Socket des Core

Das WSL-Backend SHALL eine Session `<id>` als tmux-Session `td-<id>` auf dem eigenen tmux-Socket (produktiv `termdock`) in der Distro des `LaunchSpec` (sonst der konfigurierten oder der Standard-Distro von WSL) starten. Das Arbeitsverzeichnis MUST der Linux-Pfad aus `LaunchSpec.cwd` sein (`~` erlaubt). Die Session MUST ohne tmux-Statuszeile laufen, so dass das Programm die volle PTY-Größe sieht.

#### Scenario: Start im erwarteten Verzeichnis

- **GIVEN** ein `LaunchSpec` mit `cwd` `/tmp`
- **WHEN** die Session gestartet wird und in ihr `pwd` läuft
- **THEN** zeigt die Ausgabe `/tmp`

### Requirement: Befehle als Argument-Arrays

Alle Aufrufe von `wsl.exe` und `tmux` SHALL Argument-Arrays sein, ohne Login-Shell. Ohne `command` MUST die Login-Shell der Distro in der Session laufen, mit `command` dieses Programm mit genau diesen Argumenten, ohne dass eine Shell sie interpretiert.

#### Scenario: Argumente bleiben wörtlich

- **GIVEN** ein `command` mit einem Argument, das `$HOME` und `;` enthält
- **WHEN** die Session startet
- **THEN** erhält das Programm das Argument unverändert

#### Scenario: Ungültige Session-ID

- **WHEN** eine Session mit einer ID gestartet werden soll, die andere Zeichen als Buchstaben, Ziffern, `-` und `_` enthält
- **THEN** lehnt das Backend ab, ohne `wsl.exe` aufzurufen

### Requirement: Ein- und Ausgabe, Größe und Terminal-Abfrage beim Start

Die PTY der Session SHALL Eingaben an das Programm weitergeben, seine Ausgabe liefern und Größenänderungen an tmux weitergeben. Solange von außen noch keine DA1-Antwort (`ESC [ ? … c`) geschrieben wurde, MUST die PTY die erste DA1-Abfrage (`ESC [ c`) selbst mit `ESC [ ? 1 ; 2 c` beantworten und aus der Ausgabe entfernen, damit Start und Wiederanbinden nicht bis zu 3 s auf eine View warten. Getippte Eingabe vor der Abfrage MUST die Antwort nicht verhindern.

#### Scenario: Start ohne View

- **WHEN** eine Session ohne angehängte View startet und sofort eine Eingabe erhält
- **THEN** erscheint deren Echo nach weniger als 3 s

#### Scenario: View hat schon geantwortet

- **GIVEN** von außen wurde bereits eine DA1-Antwort geschrieben
- **WHEN** die DA1-Abfrage der ConPTY eintrifft
- **THEN** antwortet die PTY nicht selbst und reicht die Abfrage weiter

#### Scenario: Resize

- **GIVEN** eine laufende Session
- **WHEN** die PTY auf 100×30 geändert wird
- **THEN** meldet `stty size` in der Session `30 100`

### Requirement: Detach, Existenz und Wiederanbinden

`dispose()` der PTY SHALL nur den tmux-Client beenden; die tmux-Session MUST weiterlaufen und dabei kein PTY-Ende melden. `exists` MUST über `has-session` ohne PTY prüfen und `true` nur für eine Session mit lebendem Programm liefern. `attach` MUST eine neue PTY an die bestehende Session hängen. `snapshot` MUST den sichtbaren Bildschirminhalt mit Farben und die Cursorposition (0-basiert) liefern, für eine nicht vorhandene Session keinen Snapshot.

#### Scenario: Detach und Reattach mit Snapshot

- **GIVEN** eine laufende Session, die einen Marker ausgegeben hat
- **WHEN** die PTY mit `dispose()` geschlossen wird
- **THEN** meldet `exists` `true`, `snapshot` enthält den Marker und `attach` liefert eine PTY, die Eingaben annimmt

### Requirement: Beenden

`kill` SHALL die tmux-Session beenden und erst auflösen, wenn `has-session` sie nicht mehr findet; bleibt sie länger als die Frist bestehen, MUST `kill` mit einem Fehler ablehnen. Danach MUST `exists` `false` liefern.

#### Scenario: Kill

- **GIVEN** eine laufende Session
- **WHEN** `kill` aufgelöst hat
- **THEN** liefert `exists` `false`

### Requirement: PTY-Ende und Exit-Code

Endet das Programm in der tmux-Session, SHALL die PTY ihr Ende mit dem Exit-Code des Programms melden (bei Ende durch ein Signal `128 + Signal`) und das Backend die tmux-Session danach entfernen. Endet nur der tmux-Client, während die Session weiterlebt, oder lässt sich der Zustand nicht feststellen, MUST das Ende ohne Exit-Code gemeldet werden und die Session bestehen bleiben.

#### Scenario: Programm endet mit Code

- **GIVEN** eine Session mit `command` `sh -c "exit 7"`
- **WHEN** das Programm endet
- **THEN** meldet die PTY `exitCode` 7 und `exists` liefert `false`

#### Scenario: Client geht verloren

- **GIVEN** eine laufende Session
- **WHEN** der tmux-Client von außen getrennt wird
- **THEN** meldet die PTY ein Ende ohne `exitCode` und `exists` liefert `true`

### Requirement: Keepalive je Distro

Solange das Backend mindestens eine Session einer Distro kennt (gestartet, angehängt oder per `exists` gefunden), SHALL je Distro genau ein Prozess `wsl.exe -d <distro> --exec sleep infinity` ohne PTY laufen. Endet die letzte bekannte Session der Distro (`kill`, Programm-Ende oder `exists` meldet sie als weg), MUST der Prozess beendet werden.

#### Scenario: Session überlebt eine Pause ohne PTY

- **GIVEN** eine Session, deren PTY mit `dispose()` geschlossen wurde
- **WHEN** 25 s lang kein anderer `wsl.exe`-Aufruf läuft
- **THEN** liefert `exists` danach `true`

#### Scenario: Letzte Session endet

- **GIVEN** zwei bekannte Sessions in derselben Distro
- **WHEN** beide beendet werden
- **THEN** läuft der Keepalive nach der ersten weiter und ist nach der zweiten beendet

### Requirement: Keepalive-Neustart und Abbau

Endet ein Keepalive unerwartet, während noch Sessions seiner Distro bekannt sind, SHALL das Backend ihn neu starten. Das Schließen des Backends MUST alle Keepalives beenden, die tmux-Sessions aber bestehen lassen.

#### Scenario: Keepalive stirbt

- **GIVEN** eine bekannte Session und ihr Keepalive
- **WHEN** der Keepalive-Prozess unerwartet endet
- **THEN** startet kurz danach ein neuer

#### Scenario: Backend schließen

- **GIVEN** laufende Keepalives
- **WHEN** das Backend geschlossen wird
- **THEN** sind alle Keepalives beendet und kein neuer startet

### Requirement: Verfügbarkeit und Distro

`available` SHALL `true` liefern, wenn die gewählte Distro erreichbar ist und dort `tmux` startet, sonst `false`, ohne zu werfen. Ohne konfigurierte Distro MUST die Standard-Distro von WSL verwendet werden.

#### Scenario: Distro fehlt

- **GIVEN** eine konfigurierte Distro, die es nicht gibt
- **WHEN** `available` aufgerufen wird
- **THEN** liefert es `false`
