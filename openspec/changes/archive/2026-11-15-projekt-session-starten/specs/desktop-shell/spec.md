## MODIFIED Requirements

### Requirement: Kontextmenü als Tastatur-Alternative

Rechtsklick, Menütaste und Umschalt+F10 auf einer Session, einem Workspace oder einem Projekt SHALL ein Menü (`role="menu"`) mit denselben Aktionen wie Maus und Drag&Drop öffnen: Sessions Öffnen, Umbenennen, Verschieben, Archivieren, Löschen; Workspaces Umbenennen, Projekt hinzufügen, Löschen; Projekte Neue Session hier, Umbenennen, Löschen. Pfeiltasten wechseln den Eintrag, Enter wählt, Esc schließt mit Fokus zurück. Löschen einer Session geht nur in `Exited`, `Interrupted`, `Archived`.

#### Scenario: Verschieben per Tastatur

- **GIVEN** eine Session unter „Ohne Gruppe“ hat den Fokus
- **WHEN** der Benutzer die Menütaste, Pfeil abwärts bis „Verschieben nach Web“ und Enter drückt
- **THEN** sendet der Main `session.update` mit der `workspaceId` von „Web“

#### Scenario: Löschen einer laufenden Session

- **GIVEN** eine `Running`-Session
- **WHEN** der Benutzer ihr Menü öffnet
- **THEN** ist „Löschen“ abgeblendet und nicht wählbar

#### Scenario: Startende Session

- **GIVEN** eine Session im Zustand `Starting`
- **WHEN** der Benutzer ihr Menü öffnet oder sie auf das Archiv zieht
- **THEN** ist „Archivieren“ abgeblendet beziehungsweise das Archiv kein gültiges Ziel, weil der Core es mit `invalid_state` ablehnt

#### Scenario: Fokus nach der Aktion

- **WHEN** eine Menüaktion oder ein Dialog der Sidebar endet (Verschieben, Umbenennen, Abbrechen, Bestätigen)
- **THEN** hat die auslösende oder verschobene Zeile den Fokus, und wo es sie nicht mehr gibt, der Knopf „Neue WSL-Session“ der Sidebar, nie `<body>`

#### Scenario: Menü schließen

- **WHEN** der Benutzer bei offenem Menü Esc drückt
- **THEN** schließt es ohne Aufruf, und der Eintrag hat wieder den Fokus

#### Scenario: Menü eines Projekts

- **GIVEN** ein Projekt „api“ hat den Fokus
- **WHEN** der Benutzer die Menütaste drückt
- **THEN** zeigt das Menü „Neue Session hier“, „Umbenennen …“ und „Löschen …“ in dieser Reihenfolge, und der Fokus steht auf „Neue Session hier“

## ADDED Requirements

### Requirement: Session im Projekt starten

Klick und Enter auf eine Projektzeile der Sidebar sowie der Menüeintrag „Neue Session hier“ SHALL eine neue Session im Projekt starten: `session.create` mit Namen und Workspace des Projekts und `launch` aus Backend, Distro (falls gesetzt) und Pfad als `cwd`, ohne Shell, Befehl und Umgebung. Sie öffnet sich wie jede neue Session (Strg+Klick neuer Tab, Umschalt+Klick Split). Lehnt der Core ab, zeigt die Statusleiste den Grund. Ein zweiter Start während des ersten SHALL abgewiesen werden.

#### Scenario: Klick startet im Projektpfad

- **GIVEN** ein Projekt „api“ mit Pfad `/srv/api` im Workspace „Web“
- **WHEN** der Benutzer die Zeile „api“ anklickt
- **THEN** sendet der Main `session.create` mit Name „api“, der `workspaceId` von „Web“ und `launch.cwd` `/srv/api`, und die neue Session ist in einem Tab geöffnet

#### Scenario: Strg+Klick und Umschalt+Klick

- **GIVEN** ein Tab mit der Session `s1` ist aktiv
- **WHEN** der Benutzer ein Projekt mit Strg+Klick anklickt, danach ein Projekt mit Umschalt+Klick
- **THEN** liegt die erste neue Session in einem neuen Tab, und die zweite in einem Split neben dem aktiven Pane

#### Scenario: Core lehnt ab

- **GIVEN** ein Projekt, dessen Start der Core mit einem Fehler ablehnt
- **WHEN** der Benutzer es anklickt
- **THEN** steht der Grund des Core in der Statusleiste, es entsteht weder Tab noch Session, und die Projektzeile hat den Fokus

#### Scenario: Doppelklick

- **GIVEN** der Start einer Session für ein Projekt ist unterwegs
- **WHEN** der Benutzer erneut klickt
- **THEN** sendet das Fenster kein zweites `session.create`, und die Statusleiste meldet, dass die Session noch gestartet wird

### Requirement: Screenshot-Szene für Projekt-Sessions

Der Screenshot-Modus SHALL das Menü eines Projekts mit „Neue Session hier“ und die gestartete Session im Projektpfad aufnehmen und prüfen, dass der Core die Session mit `cwd` des Projekts, dem Namen und dem Workspace des Projekts kennt und das Terminal das Verzeichnis zeigt. Tritt eine erwartete Änderung nicht ein, SHALL der Lauf mit Code 1 enden.

#### Scenario: Aufnahme

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` zusätzlich PNG-Dateien des Projektmenüs und der Session im Projektpfad
