## ADDED Requirements

### Requirement: Sidebar mit Sessions nach Workspace

Die Sidebar SHALL alle Sessions außer `Archived` gruppiert nach `workspaceId` anzeigen (Überschrift ist die ID) und immer einen Bereich „Ohne Gruppe“ für Sessions ohne Workspace. Jede Session SHALL ein Zustandssymbol tragen und sich über `session.stateChanged` und das Event für neue Sessions aktualisieren. Die Sidebar SHALL sich ein- und ausblenden lassen.

#### Scenario: Sessions ohne Workspace

- **GIVEN** der Core kennt zwei Sessions ohne `workspaceId`
- **WHEN** ein Fenster startet
- **THEN** zeigt die Sidebar beide im Bereich „Ohne Gruppe“

#### Scenario: Gruppe je Workspace

- **GIVEN** eine Session hat `workspaceId` `w1`, eine andere keine
- **WHEN** die Sidebar sie anzeigt
- **THEN** steht die erste unter einer Überschrift `w1`, die zweite unter „Ohne Gruppe“

#### Scenario: Zustandswechsel

- **GIVEN** die Sidebar zeigt `s1` als `Running`
- **WHEN** der Main `session.stateChanged` mit `Exited` meldet
- **THEN** zeigt die Sidebar `s1` als `Exited`

#### Scenario: Neue Session in anderem Fenster

- **GIVEN** zwei Fenster zeigen die Sidebar
- **WHEN** Fenster A eine Session anlegt
- **THEN** erscheint sie auch in der Sidebar von Fenster B

### Requirement: Beendete Sessions nie als laufend

Die Oberfläche SHALL `Exited` und `Interrupted` in Sidebar, Tab und Statusleiste mit eigenem Symbol und Text darstellen und nie als laufend; als laufend gilt nur `Running`. Ein Tab einer Session, die nicht `Running` oder `Detached` ist, SHALL sich nicht anhängen, sondern Zustand und Exit-Code zeigen.

#### Scenario: Unterbrochene Session

- **GIVEN** eine Session ist `Interrupted`
- **WHEN** der Benutzer sie in der Sidebar anklickt
- **THEN** öffnet sich ein Tab ohne `session.attach`, der „Unterbrochen“ zeigt

#### Scenario: Session endet im offenen Tab

- **GIVEN** ein Tab ist an `s1` angehängt
- **WHEN** `s1` `Exited` wird
- **THEN** bleibt die letzte Ausgabe sichtbar, und die Statusleiste zeigt `Exited`

### Requirement: Tabs öffnen, wechseln, schließen

Ein Klick auf eine Session SHALL einen Tab öffnen oder den Tab fokussieren, der sie schon zeigt; Strg+Klick SHALL immer einen neuen Tab mit eigener View öffnen. Jeder Tab SHALL höchstens einmal angehängt sein und angehängt bleiben, solange er offen ist; Wechseln SHALL nichts am Core ändern. Schließen SHALL die View mit `session.detach` lösen, die Session läuft weiter, und der Nachbar wird aktiv.

#### Scenario: Zweiter Klick fokussiert

- **GIVEN** ein Tab zeigt `s1`, ein anderer ist aktiv
- **WHEN** der Benutzer `s1` in der Sidebar anklickt
- **THEN** wird der vorhandene Tab aktiv, und es entsteht keine zweite View

#### Scenario: Tabwechsel

- **GIVEN** zwei Tabs sind offen
- **WHEN** der Benutzer den Tab wechselt
- **THEN** sendet das Fenster weder `session.detach` noch `session.attach`, und die Ausgabe des versteckten Tabs läuft weiter

#### Scenario: Tab schließen

- **GIVEN** ein Tab zeigt `s1`, die Session läuft
- **WHEN** der Benutzer den Tab schließt
- **THEN** sendet der Main `session.detach` für seine View, `s1` bleibt am Leben und wird `Detached`, wenn keine andere View sie zeigt

### Requirement: Neues Fenster mit eigenen Tabs

Der Main SHALL über das Menü „Neues Fenster“ ein Fenster öffnen, das eigene Tabs hat. Ein Fenster ohne Tabs SHALL die Sidebar und einen Leerzustand zeigen.

#### Scenario: Neues Fenster aus dem Menü

- **GIVEN** Fenster A zeigt zwei Tabs
- **WHEN** der Benutzer „Neues Fenster“ wählt
- **THEN** öffnet sich Fenster B ohne Tabs mit Sidebar und Leerzustand, und die Tabs von A bleiben unverändert

### Requirement: Neue WSL-Session aus der Sidebar

Die Sidebar SHALL eine Aktion „Neue WSL-Session“ mit Name und Arbeitsverzeichnis (Standard `~`) anbieten. Nach dem Anlegen SHALL sie die Session als Tab öffnen; scheitert das Anlegen, SHALL sie den Fehler im Formular zeigen.

#### Scenario: Anlegen mit Standard

- **WHEN** der Benutzer nur einen Namen eingibt und bestätigt
- **THEN** sendet das Fenster `createSession` mit `launch: { backend: "wsl", cwd: "~" }` und öffnet den Tab

### Requirement: Statusleiste mit Backend, Session und Hinweisen

Die Statusleiste SHALL Backend und Distro, Name und Zustand der aktiven Session, Rolle und Größe ihrer View und, wenn `core.status` Backends in `backendUnavailable` meldet, einen Hinweis darauf zeigen. Ohne aktiven Tab zeigt sie nur die Hinweise.

#### Scenario: WSL nicht erreichbar

- **GIVEN** `core.status` meldet `backendUnavailable: ["wsl"]`
- **WHEN** ein Fenster startet
- **THEN** zeigt die Statusleiste „WSL nicht erreichbar“

#### Scenario: Aktive Session

- **GIVEN** der aktive Tab zeigt eine `Detached`-Session der Distro `Ubuntu`
- **WHEN** die Statusleiste gezeichnet wird
- **THEN** nennt sie WSL, `Ubuntu`, den Namen der Session und `Detached`

### Requirement: UI-Zustand als reiner Store

Der Zustand eines Fensters (Sessions, Tabs, aktiver Tab, Sidebar) SHALL in einem Store ohne React und Electron liegen, dessen Fensteranteil die Form `LayoutWindow` mit `LayoutTab` hat, jeder Tab mit genau einem Pane. Er SHALL höchstens 64 Tabs je Fenster zulassen.

#### Scenario: Tab im Layout-Format

- **WHEN** der Store einen Tab für `s1` anlegt
- **THEN** hat der Tab eine `id`, ein `root` vom Typ `pane` mit `sessionId` `s1` und `activePaneId` auf dieses Pane

#### Scenario: Tab-Limit

- **GIVEN** das Fenster hat 64 Tabs
- **WHEN** eine weitere Session geöffnet wird
- **THEN** entsteht kein Tab, und die Statusleiste nennt das Limit

## MODIFIED Requirements

### Requirement: Schmale Brücke zwischen Renderer und Main

Der Renderer SHALL keinen Zugriff auf die Pipe, auf Node oder auf Electron-Module haben (`contextIsolation`, `sandbox`, kein `nodeIntegration`, CSP ohne Inline-Skripte). Der Main SHALL vom Renderer nur eine feste Liste von Aufrufen annehmen (Core-Status, Sessions auflisten, anlegen, anhängen, lösen, Eingabe, Größe, Schreibrecht), ihre Argumente prüfen und Fehler mit stabilem Code zurückgeben.

#### Scenario: Unbekannter Aufruf

- **WHEN** ein Renderer einen Aufruf außerhalb der Liste sendet, etwa `core.shutdown`
- **THEN** antwortet der Main mit `bad_request` und sendet nichts an den Core

#### Scenario: Fehler des Core

- **WHEN** der Core einen Aufruf mit einem Fehlercode ablehnt, etwa `not_found`
- **THEN** erhält der Renderer denselben Code und die Meldung

#### Scenario: Core-Status

- **WHEN** der Renderer `coreStatus` aufruft
- **THEN** sendet der Main `core.status` und gibt `backendUnavailable` zurück

### Requirement: Events nur an beteiligte Fenster

Der Main SHALL Ausgabe, Größenänderung und Schreiberwechsel einer Session nur an Fenster senden, die eine View dieser Session haben oder gerade eine anhängen, je Fenster einmal. Zustandswechsel von Sessions und neu angelegte Sessions SHALL er an alle Fenster senden.

#### Scenario: Ausgabe einer Session

- **GIVEN** Fenster A zeigt Session `s1`, Fenster B zeigt Session `s2`
- **WHEN** der Core Ausgabe von `s1` meldet
- **THEN** erhält nur Fenster A die Bytes

#### Scenario: Ausgabe während des Anhängens

- **GIVEN** Fenster A hängt gerade eine View an `s1` an
- **WHEN** der Core direkt nach der Antwort Ausgabe von `s1` meldet
- **THEN** erhält Fenster A die Bytes mit ihrer Sequenznummer, und die View stellt sie nur dar, wenn der Snapshot sie nicht schon enthält

#### Scenario: Neue Session

- **GIVEN** Fenster A und B sind offen
- **WHEN** A `createSession` erfolgreich aufruft
- **THEN** erhalten beide Fenster das Event `sessionCreated` mit der Session

### Requirement: Session beim Start der View

Beim Start SHALL ein Fenster die Sessions auflisten und den Core-Status abfragen und ohne Tab die Sidebar mit einem Leerzustand zeigen. Es SHALL von sich aus weder eine Session anlegen noch sich an eine anhängen.

#### Scenario: Keine Session

- **GIVEN** der Core kennt keine Session
- **WHEN** ein Fenster startet
- **THEN** zeigt es die leere Sidebar und den Leerzustand, und der Main sendet weder `session.create` noch `session.attach`

#### Scenario: Lebende Session vorhanden

- **GIVEN** der Core kennt eine `Exited`- und eine `Detached`-Session
- **WHEN** ein Fenster startet
- **THEN** listet die Sidebar beide, und es ist kein Tab offen

### Requirement: Screenshot-Modus gegen isolierten Core

Mit `--screenshot <dir>` SHALL die App einen eigenen Core starten (eigene Pipe, Datenverzeichnis in einem Temp-Verzeichnis, tmux-Socket `termdock-test`), Sessions in den Zuständen `Running`, `Detached`, `Exited` und `Interrupted` mit mehreren Tabs, eine eingeklappte Sidebar, ein leeres Fenster und einen Leser aufnehmen (`capturePage()`, PNG in `<dir>`), danach alle Sessions und den Core beenden, das Datenverzeichnis entfernen und mit Code 0 enden; bei Fehler mit Code 1.

#### Scenario: Aufnahme

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` PNG-Dateien mit der Sidebar in allen vier Zuständen und mehreren Tabs, mit eingeklappter Sidebar, mit leerem Fenster und geöffnetem Formular und mit einem Leser samt „Schreibrecht übernehmen“, und auf dem Socket `termdock-test` bleibt keine Session dieses Laufs

#### Scenario: Verbindung zum isolierten Core scheitert

- **GIVEN** der Screenshot-Lauf hat seinen Core gestartet
- **WHEN** das Verbinden oder die erste Antwort scheitert
- **THEN** beendet die App diesen Core mit `core.shutdown { stopSessions: true }` oder, wenn er nicht antwortet, über seine Prozess-ID, wartet auf sein Ende, entfernt danach das Datenverzeichnis und endet mit Code 1

#### Scenario: Produktiver Core bleibt unberührt

- **GIVEN** ein produktiver Core und eine App laufen
- **WHEN** die App zusätzlich mit `--screenshot <dir>` gestartet wird
- **THEN** verbindet sie sich nicht mit dem produktiven Core, öffnet kein Fenster im laufenden Main und ändert keine Session auf dem Socket `termdock`
