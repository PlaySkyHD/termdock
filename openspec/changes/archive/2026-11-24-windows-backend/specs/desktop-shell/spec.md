## RENAMED Requirements

- FROM: `### Requirement: Neue WSL-Session aus der Sidebar`
- TO: `### Requirement: Neue Session aus der Sidebar`

## MODIFIED Requirements

### Requirement: Neue Session aus der Sidebar

Die Sidebar SHALL eine Aktion „Neue Session“ mit Backend (WSL oder Windows-Shell), bei Windows der Shell (Standard aus den Einstellungen, `pwsh`, `powershell`, `cmd`), Name und Arbeitsverzeichnis (Standard `~`) anbieten. Ein Windows-Verzeichnis MUST `~`, ein Pfad darunter oder ein Laufwerks- oder UNC-Pfad sein, sonst steht ein Fehler im Formular. Nach dem Anlegen SHALL sie die Session als Tab öffnen; scheitert das Anlegen, zeigt sie den Fehler im Formular.

#### Scenario: Anlegen mit Standard

- **WHEN** der Benutzer nur einen Namen eingibt und bestätigt
- **THEN** sendet das Fenster `createSession` mit `launch: { backend: "wsl", cwd: "~" }` und öffnet den Tab

#### Scenario: Windows-Shell anlegen

- **WHEN** der Benutzer Backend Windows-Shell, Shell `cmd`, Name „Windows cmd“ und Verzeichnis `C:\` wählt und bestätigt
- **THEN** sendet das Fenster `launch: { backend: "windows", cwd: "C:\\", shell: "cmd" }`, öffnet den Tab, und das Formular nannte vorher „Läuft nur, solange der TermDock-Core läuft“

#### Scenario: Linux-Pfad für Windows

- **WHEN** der Benutzer Windows-Shell wählt und `/home/dev` als Verzeichnis bestätigt
- **THEN** sendet das Fenster nichts, und das Formular meldet „Für Windows ein Pfad wie C:\dev oder \\server\freigabe“

#### Scenario: Backend wechseln

- **GIVEN** das Formular mit dem Standardnamen „WSL“ und Verzeichnis `/srv/app`
- **WHEN** der Benutzer Windows-Shell wählt
- **THEN** heißt die Session „Windows“, und das Verzeichnis ist `~`; ein selbst getippter Name bleibt

### Requirement: Workspaces und Projekte in der Sidebar verwalten

Die Sidebar SHALL das Anlegen, Umbenennen und Löschen von Workspaces und das Anlegen, Umbenennen und Löschen von Projekten anbieten. Namen, Backend (WSL oder Windows-Shell) und Pfade werden in einem kleinen Dialog erfasst (Esc bricht ab, Enter bestätigt); Löschen verlangt eine Bestätigung, deren Standard „Abbrechen“ ist. Ein Fehler des Core SHALL im Dialog stehen und ihn offen lassen.

#### Scenario: Workspace anlegen und umbenennen

- **WHEN** der Benutzer „Neuer Workspace“ wählt, „Web“ eingibt und bestätigt, danach ihn über das Menü in „Web 2“ umbenennt
- **THEN** zeigt die Sidebar den Workspace unter „Web 2“, und der Core hat `workspace.create` und `workspace.update` erhalten

#### Scenario: Projekt hinzufügen

- **WHEN** der Benutzer im Menü eines Workspace „Projekt hinzufügen“ wählt und Name und Pfad `/srv/api` bestätigt
- **THEN** erscheint das Projekt unter dem Workspace mit Backend WSL

#### Scenario: Windows-Projekt hinzufügen

- **WHEN** der Benutzer im Dialog Backend Windows-Shell wählt, „web“ und `C:\` bestätigt
- **THEN** nannte der Dialog „Läuft nur, solange der TermDock-Core läuft“, der Core erhielt `project.create` mit `backend: "windows"`, und das Projekt trägt in der Sidebar das Badge „Win“

#### Scenario: Workspace löschen

- **GIVEN** ein Workspace mit einer laufenden Session
- **WHEN** der Benutzer „Löschen“ wählt und bestätigt
- **THEN** ist der Workspace weg und die Session steht laufend unter „Ohne Gruppe“; bei „Abbrechen“ oder Esc bleibt alles unverändert

#### Scenario: Fehler des Core

- **GIVEN** der Core lehnt `workspace.create` ab
- **WHEN** der Benutzer bestätigt
- **THEN** zeigt der Dialog die Meldung und bleibt offen

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
- **THEN** hat die auslösende oder verschobene Zeile den Fokus, und wo es sie nicht mehr gibt, der Knopf „Neue Session“ der Sidebar, nie `<body>`

#### Scenario: Menü schließen

- **WHEN** der Benutzer bei offenem Menü Esc drückt
- **THEN** schließt es ohne Aufruf, und der Eintrag hat wieder den Fokus

#### Scenario: Menü eines Projekts

- **GIVEN** ein Projekt „api“ hat den Fokus
- **WHEN** der Benutzer die Menütaste drückt
- **THEN** zeigt das Menü „Neue Session hier“, „Umbenennen …“ und „Löschen …“ in dieser Reihenfolge, und der Fokus steht auf „Neue Session hier“

### Requirement: Fokus nach dem Archivieren

Nach erfolgreichem Archivieren (Menü, Tastatur, Ziehen aufs Archiv) SHALL die archivierte Zeile im Archiv den Tastaturfokus haben, nicht der Knopf „Neue Session“. Ist das Archiv zugeklappt, SHALL es dafür aufklappen. Abbrechen und Esc im Bestätigungsdialog geben den Fokus an die auslösende Zeile zurück; bei einem Fehler des Core bleibt der Dialog offen.

#### Scenario: Archivieren per Tastatur

- **GIVEN** eine laufende Session hat in der Sidebar den Fokus, und das Archiv ist zugeklappt
- **WHEN** der Benutzer über das Menü „Archivieren“ wählt und den Dialog bestätigt
- **THEN** klappt das Archiv auf, und die archivierte Zeile darin hat den Fokus

#### Scenario: Archivieren abbrechen

- **GIVEN** der Bestätigungsdialog zum Archivieren ist offen
- **WHEN** der Benutzer Esc drückt
- **THEN** bleibt die Session unverändert, das Archiv zu, und die auslösende Zeile hat den Fokus

### Requirement: Screenshot-Modus wählt Szenengruppen

Mit `--scenes <gruppe,…>` SHALL der Screenshot-Modus nur die genannten Szenengruppen aufnehmen (`scenario`, `sidebar`, `tabs`, `snap`, `restore`, `quit`, `search`, `settings`, `cwd`, `windows`, `crash`, `restart`), fest geordnet, jede mit eigenem Aufbau; ohne Option alle. Ein unbekannter Name oder eine leere Liste beendet die App vor dem Core-Start mit Code 1. Eine gescheiterte Gruppe SHALL genau einmal wiederholt werden (Log `retry <gruppe>: <fehler>`); scheitert sie erneut, Code 1.

#### Scenario: Eine Gruppe allein

- **WHEN** die App mit `--screenshot <dir> --scenes search` startet
- **THEN** enthält `<dir>` nur die Bilder der Suche, und der Lauf endet mit Code 0

#### Scenario: Unbekannter Name

- **WHEN** die App mit `--screenshot <dir> --scenes search,nope` startet
- **THEN** startet kein Core, die Meldung nennt `nope` und die gültigen Gruppen, und die App endet mit Code 1

#### Scenario: Eine Gruppe scheitert einmal

- **GIVEN** die Gruppe `tabs` scheitert im ersten Versuch und gelingt im zweiten
- **WHEN** der Lauf sie wiederholt
- **THEN** steht `retry tabs: <fehler>` im Log, die folgenden Gruppen laufen, die Zusammenfassung nennt die Wiederholung, und der Lauf endet mit Code 0

#### Scenario: Die Wiederholung scheitert

- **GIVEN** die Gruppe `tabs` scheitert auch im zweiten Versuch
- **WHEN** der Lauf endet
- **THEN** endet er mit Code 1 und wiederholt `tabs` kein drittes Mal

## ADDED Requirements

### Requirement: Persistenzgrenze der Windows-Shells sichtbar

Eine Windows-Session und ein Windows-Projekt SHALL in der Sidebar das Badge „Win“ tragen, im Tooltip „Läuft nur, solange der TermDock-Core läuft“. Ist eine Windows-Session aktiv, SHALL die Statusleiste diesen Satz neben dem Backend zeigen. Eine `Interrupted`-Windows-Session MUST sagen, dass die Shell mit dem Core beendet wurde. Der Profil-Editor nennt die Grenze bei der Shell. Die Texte stehen in reinen Funktionen.

#### Scenario: Sidebar und Statusleiste

- **GIVEN** eine laufende Windows-Session mit `cmd` und eine WSL-Session
- **WHEN** die Windows-Session aktiv ist
- **THEN** trägt nur sie das Badge, und die Statusleiste zeigt „Windows · cmd“ und „Läuft nur, solange der TermDock-Core läuft“

#### Scenario: Nach dem Ende des Core

- **GIVEN** ein Tab mit einer Windows-Session
- **WHEN** der Core endet und neu startet
- **THEN** zeigt der Tab „Unterbrochen“ mit dem Satz, dass die Windows-Shell mit dem Core beendet wurde, und „Neu starten“ startet eine neue Shell nach der Trennzeile

#### Scenario: Fehlendes Verzeichnis

- **GIVEN** eine Windows-Session mit der Warnung `cwd_missing` für `D:\gone`
- **WHEN** ihr Pane angezeigt wird
- **THEN** lautet der Hinweis „Verzeichnis D:\gone fehlt – die Session läuft im Benutzerordner.“

### Requirement: Rohpuffer als Snapshot im Pane

Ist der Snapshot der Rohpuffer des Core (Windows-Session), SHALL die View ihn unverändert schreiben, auch Zeilenumbrüche am Ende; nur einen tmux-Snapshot kürzt sie um leere Zeilen am Ende.

#### Scenario: Neustart einer Windows-Shell

- **GIVEN** ein Snapshot, der aus der Trennzeile mit Zeilenumbruch besteht, und die erste Ausgabe der neuen Shell, die danach live kommt
- **WHEN** eine View an die Windows-Session anhängt
- **THEN** steht die Ausgabe der Shell in der Zeile unter der Trennzeile, nicht dahinter

### Requirement: Schließen-Dialog nennt Windows-Shells

Sind unter den laufenden Sessions Windows-Shells, SHALL der Main ihre Zahl mit der Frage senden (`windowsSessions`), und der Dialog MUST zusätzlich sagen, dass sie nur laufen, solange der TermDock-Core läuft, und ein Neustart von Windows oder des Core sie beendet. Ohne Windows-Shell bleiben Frage und Dialog wie bisher.

#### Scenario: Eine Windows-Shell läuft

- **GIVEN** eine laufende Windows-Session und eine WSL-Session
- **WHEN** der Benutzer die App beendet
- **THEN** nennt der Dialog 2 laufende Sessions und „Die Windows-Shell läuft nur, solange der TermDock-Core läuft; ein Neustart von Windows oder des Core beendet sie.“

#### Scenario: Wiederholte Frage

- **WHEN** der Main die Frage erneut sendet, bis das Fenster sie bestätigt
- **THEN** trägt jede Wiederholung dasselbe `windowsSessions`

### Requirement: Screenshot-Szenen der Windows-Shells

Die Gruppe `windows` SHALL mit Sichtbarkeitsselektor aufnehmen: `34-windows-new-session.png` (Formular mit Shell), `35-windows-session.png` (Badge, Statusleiste), `36-windows-project-dialog.png` (Hinweis im Projektdialog), `37-windows-quit-dialog.png` (Satz im Schließen-Dialog), `38-windows-interrupted.png` (nach Ende des Core) und `39-windows-restarted.png` (neue Shell).

#### Scenario: Gruppe windows

- **WHEN** der Screenshot-Modus mit `--scenes windows` läuft
- **THEN** entstehen die sechs Bilder, die WSL-Session daneben trägt kein Badge und lebt nach dem Neustart des Core weiter, und der Lauf endet mit Code 0
