# desktop-shell Specification

## Purpose
Die Desktop-App ist ein Client des Core: Ein Electron-Main verbindet sich mit dem Core oder startet ihn, vermittelt zwischen Renderer und Pipe und zeigt Sessions in Terminal-Views, in denen genau eine View schreibt.

## Requirements

### Requirement: Ein Main-Prozess für alle Fenster

Die Desktop-App SHALL je Windows-Benutzer genau einen Electron-Main-Prozess haben, dem alle Fenster gehören. Ein weiterer Start der App SHALL sich beenden und im laufenden Main ein neues Fenster öffnen.

#### Scenario: Zweiter Start öffnet ein Fenster im laufenden Main

- **GIVEN** die App läuft mit einem Fenster
- **WHEN** der Benutzer die App erneut startet
- **THEN** beendet sich der neue Prozess, und der laufende Main öffnet ein zweites Fenster mit derselben Core-Verbindung

### Requirement: Verbinden vor Starten des Core

Der Main SHALL beim Start zuerst die Pipe des Core verbinden. Nur wenn die Pipe nicht existiert, SHALL er den Core als losgelösten Kindprozess starten (Electron als Node, eigene Prozessgruppe) und erneut verbinden, mit wachsenden Wartezeiten und höchstens 5 s Gesamtzeit ab dem Start des Core.

#### Scenario: Core läuft schon

- **GIVEN** ein Core belegt die Pipe
- **WHEN** die App startet
- **THEN** verbindet sie sich und startet keinen weiteren Core

#### Scenario: Core läuft nicht

- **GIVEN** kein Core belegt die Pipe
- **WHEN** die App startet
- **THEN** startet sie genau einen Core als losgelösten Prozess und verbindet sich, sobald er die Pipe belegt hat

#### Scenario: Core wird nicht erreichbar

- **GIVEN** der gestartete Core belegt die Pipe auch nach 5 s nicht
- **WHEN** die Wiederholungen ausgeschöpft sind
- **THEN** meldet die App den Fehler mit dem letzten Verbindungsfehler und versucht keinen weiteren Start

#### Scenario: Anderer Verbindungsfehler

- **GIVEN** ein Core belegt die Pipe, spricht aber eine andere Hauptversion des Protokolls oder verweigert den Zugriff
- **WHEN** die App startet
- **THEN** meldet sie diesen Fehler und startet keinen Core

#### Scenario: UI schließen, Sessions behalten

- **GIVEN** die App hat den Core gestartet
- **WHEN** der Benutzer alle Fenster schließt
- **THEN** endet der Main, der Core und seine Sessions laufen weiter

### Requirement: Warten auf den Abgleich beim Start

Nach `hello` SHALL der Main mit einer ersten Anfrage auf das Ende des Abgleichs im Core warten und ihr einen großzügigen Timeout (60 s) geben. `session.create` und `session.attach` SHALL er ebenfalls 60 s geben, weil sie auf WSL warten können; alle übrigen Anfragen SHALL er mit dem normalen Timeout (10 s) begrenzen.

#### Scenario: Kalter WSL-Start

- **GIVEN** WSL läuft noch nicht, und das Anlegen der Session dauert 30 s
- **WHEN** die View eine Session anlegt
- **THEN** wartet der Main auf die Antwort, und es entsteht genau eine Session

#### Scenario: Langer Abgleich

- **GIVEN** der Core braucht 20 s für den Abgleich nach seinem Start
- **WHEN** die App sich verbindet
- **THEN** wartet sie, ohne mit `timeout` abzubrechen, und zeigt danach die Session

#### Scenario: Späte Anfrage hängt

- **GIVEN** die Verbindung ist bereit
- **WHEN** der Core eine spätere Anfrage nicht innerhalb von 10 s beantwortet
- **THEN** scheitert sie mit dem Code `timeout`

### Requirement: Schmale Brücke zwischen Renderer und Main

Der Renderer SHALL keinen Zugriff auf die Pipe, auf Node oder auf Electron-Module haben (`contextIsolation`, `sandbox`, kein `nodeIntegration`, CSP ohne Inline-Skripte). Der Main SHALL vom Renderer nur eine feste Liste von Aufrufen annehmen (Core-Status, Sessions verwalten, Views mit Eingabe, Größe und Schreibrecht, Workspaces und Projekte, Layout, Schließen-Dialog, Einstellungen, Startprofile, WSL-Distributionen), ihre Argumente prüfen und Fehler mit stabilem Code zurückgeben.

#### Scenario: Unbekannter Aufruf

- **WHEN** ein Renderer einen Aufruf außerhalb der Liste sendet, etwa `core.shutdown`
- **THEN** antwortet der Main mit `bad_request` und sendet nichts an den Core

#### Scenario: Fehler des Core

- **WHEN** der Core einen Aufruf mit einem Fehlercode ablehnt, etwa `not_found`
- **THEN** erhält der Renderer denselben Code und die Meldung

#### Scenario: Core-Status

- **WHEN** der Renderer `coreStatus` aufruft
- **THEN** sendet der Main `core.status` und gibt `backendUnavailable` zurück

#### Scenario: Ungültiges Layout gemeldet

- **WHEN** ein Renderer mit `reportLayout` einen Teil meldet, der die Prüfung des Layouts verletzt (etwa fünf Panes in einem Tab, eine doppelte ID oder ein unbekannter Schlüssel)
- **THEN** antwortet der Main mit `bad_request`, und das gespeicherte Layout bleibt unverändert

#### Scenario: Ungültige Antwort auf den Schließen-Dialog

- **WHEN** ein Renderer `answerQuit` mit einer unbekannten Wahl, ohne boolesches `remember` oder mit einer ID sendet, die nicht gefragt wurde
- **THEN** antwortet der Main mit `bad_request` bzw. `not_found`, und das Beenden ändert sich nicht

#### Scenario: Ungültiger Aufruf der Verwaltung

- **WHEN** ein Renderer `updateSession` ohne `name` und `workspaceId`, `createWorkspace` ohne Namen, `createProject` mit unbekanntem Backend oder `deleteSession` ohne ID sendet
- **THEN** antwortet der Main mit `bad_request` und sendet nichts an den Core

#### Scenario: Verwaltung geht an den Core

- **WHEN** ein Renderer `updateSession { sessionId: "s1", workspaceId: null }` und `archiveSession { sessionId: "s1" }` aufruft
- **THEN** sendet der Main `session.update` mit `workspaceId: null` und `session.archive` und gibt die geänderte Session beziehungsweise `null` zurück

#### Scenario: Ungültiger Aufruf für Einstellungen und Profile

- **WHEN** ein Renderer `updateSettings` ohne Änderung oder mit einem unbekannten Schlüssel, `createProfile` ohne Namen oder ohne `launch`, `updateProfile` ohne Änderung oder `deleteProfile` ohne ID sendet
- **THEN** antwortet der Main mit `bad_request` und sendet nichts an den Core

#### Scenario: Einstellungen und Profile gehen an den Core

- **WHEN** ein Renderer `updateSettings { settings: { defaultDistro: null } }`, `updateProfile { profileId: "p1", change: { autostart: true } }` und `listDistros` aufruft
- **THEN** sendet der Main `settings.set`, `profile.update { profileId: "p1", autostart: true }` und `wsl.distros` und gibt die Einstellungen, das Profil und die Liste zurück

### Requirement: Views gehören ihrem Fenster

Eine View SHALL dem Fenster gehören, das sie angehängt hat. Eingabe, Größe, Schreibrecht und Lösen SHALL der Main nur für Views des aufrufenden Fensters weitergeben. Schließt ein Fenster, lädt sein Renderer neu oder stürzt er ab, SHALL der Main dessen Views beim Core lösen; hielt eine davon das Schreibrecht, MUST es danach frei sein, so dass ein anderes Fenster es übernehmen kann.

#### Scenario: Renderer lädt neu

- **GIVEN** Fenster A hat die schreibende View `v1`
- **WHEN** der Renderer von A neu lädt oder abstürzt
- **THEN** sendet der Main `session.detach` für `v1`, und die neue Seite in A hängt sich mit einer neuen View an

#### Scenario: Renderer stürzt ab, anderes Fenster schreibt

- **GIVEN** Fenster A hat die schreibende View `v1` einer Session, Fenster B eine lesende View derselben Session
- **WHEN** der Renderer von A abstürzt (`forcefullyCrashRenderer()`) und B danach „Eingabe übernehmen“ wählt
- **THEN** hat A beim Main keine View mehr, `session.list` nennt keinen Schreiber, Eingabe für `v1` wird abgelehnt, B schreibt, und nach dem Neuladen hängt sich A mit einer neuen View als Leser an

#### Scenario: Fremde View

- **GIVEN** Fenster A hat die View `v1`
- **WHEN** Fenster B Eingabe für `v1` sendet
- **THEN** antwortet der Main mit `not_found` und sendet nichts an den Core

#### Scenario: Fenster schließt

- **GIVEN** Fenster A hat die View `v1`
- **WHEN** Fenster A geschlossen wird
- **THEN** sendet der Main `session.detach` für `v1`, und die Session läuft weiter

### Requirement: Events nur an beteiligte Fenster

Der Main SHALL Ausgabe, Größenänderung und Schreiberwechsel einer Session nur an Fenster senden, die eine View dieser Session haben oder gerade eine anhängen, je Fenster einmal. Zustandswechsel von Sessions SHALL er an alle Fenster senden, ebenso neue Sessions: Er leitet das Core-Event `session.created` als Brücken-Event `sessionCreated` an alle Fenster weiter und meldet nach `session.create` selbst nichts.

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
- **WHEN** der Core `session.created` meldet, gleich von welchem Client die Session stammt
- **THEN** erhalten beide Fenster das Event `sessionCreated` mit der Session

#### Scenario: Eigener Aufruf

- **GIVEN** Fenster A und B sind offen
- **WHEN** A `createSession` erfolgreich aufruft
- **THEN** sendet der Main aus diesem Aufruf selbst kein `sessionCreated`; die Fenster erfahren es nur aus dem Core-Event

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

### Requirement: Snapshot vor Live-Ausgabe

Nach `session.attach` SHALL die View das Terminal auf die gemeldete Sitzungsgröße bringen, zuerst den Snapshot aus der Antwort darstellen und danach die Live-Ausgabe in Eingangsreihenfolge, auch wenn Ausgabe vor der Antwort eintrifft. Leerzeilen am Ende des Snapshots SHALL sie weglassen, damit der Cursor hinter dem zuletzt geschriebenen Text steht. Ausgabe, deren Sequenznummer nicht über der Marke der Attach-Antwort liegt, SHALL sie verwerfen.

#### Scenario: Ausgabe schon im Snapshot

- **GIVEN** die Attach-Antwort meldet die Marke 5
- **WHEN** Ausgabe mit den Nummern 4, 5 und 6 eintrifft, vor oder nach der Antwort
- **THEN** stellt die View nur die Ausgabe mit Nummer 6 nach dem Snapshot dar

#### Scenario: Snapshot einer Shell

- **GIVEN** die Session ist 117×35 groß und zeigt oben einen Prompt, darunter leere Zeilen
- **WHEN** eine neue View sich anhängt
- **THEN** zeigt sie den Prompt oben in einem Terminal von 117×35, und der Cursor steht hinter dem Prompt

#### Scenario: Ausgabe vor der Antwort

- **GIVEN** die View hat `session.attach` gesendet
- **WHEN** Ausgabe eintrifft, bevor die Antwort mit dem Snapshot da ist
- **THEN** stellt die View zuerst den Snapshot und danach diese Ausgabe dar

### Requirement: Schreiber bestimmt Eingabe und Größe

Nur die schreibende View SHALL Eingaben und ihre eigene Größe an den Core senden; sie passt das Terminal in normaler Schriftgröße an ihre Fläche an. Eine lesende View SHALL alle Eingaben und automatischen Antworten des Terminals (etwa DA1, Cursorposition) verwerfen, nie `session.resize` senden und das Terminal im Raster des Schreibers darstellen (Zoom siehe „Lesende View in Schreibergröße“).

#### Scenario: Schreiber tippt

- **GIVEN** die View schreibt
- **WHEN** der Benutzer `ls --color` und Enter tippt
- **THEN** sendet die View die Bytes mit `session.input`, und die Ausgabe erscheint in allen Views der Session

#### Scenario: Leser beantwortet keine Abfrage

- **GIVEN** die View liest
- **WHEN** das Programm eine Terminal-Abfrage ausgibt und xterm.js eine Antwort erzeugt
- **THEN** sendet die View nichts an den Core

#### Scenario: Schreiber ändert die Größe

- **GIVEN** zwei Views zeigen dieselbe Session, A schreibt
- **WHEN** das Fenster von A kleiner wird
- **THEN** sendet A `session.resize` mit der neuen Größe, und B stellt nach `session.resized` das Terminal in dieser Größe dar

#### Scenario: Leser ändert seine Fläche

- **GIVEN** A schreibt, B liest dieselbe Session
- **WHEN** die Fläche von B durch einen Trenner kleiner wird
- **THEN** sendet B kein `session.resize`, und die Größe der Session bleibt

### Requirement: Eingabe übernehmen

Eine lesende View SHALL ihre Rolle anzeigen und eine Schaltfläche „Eingabe übernehmen“ im Pane anbieten, die Statusleiste ebenso für das aktive Pane. Ein Klick darauf SHALL `session.claimWriter` senden; nach `view.writerChanged` SHALL jede View ihre Rolle aus dem gemeldeten Schreiber ableiten.

#### Scenario: Leser übernimmt

- **GIVEN** A schreibt und B liest dieselbe Session
- **WHEN** der Benutzer in B auf „Eingabe übernehmen“ klickt
- **THEN** schreibt B in normaler Schriftgröße, passt die Größe an ihre Fläche an und sendet sie, und A wird Leser und verwirft ab dann Eingaben

#### Scenario: Schreiber löst sich

- **GIVEN** A schreibt und B liest
- **WHEN** A geschlossen wird
- **THEN** meldet der Core keinen Schreiber, B bleibt Leser und bietet die Übernahme an

#### Scenario: Übernahme abgelehnt

- **WHEN** der Main oder der Core `session.claimWriter` ablehnt
- **THEN** bleibt die View Leser und zeigt die Fehlermeldung in der Statusleiste

#### Scenario: Core-Verbindung endet

- **GIVEN** die View schreibt
- **WHEN** die Verbindung zum Core endet
- **THEN** zeigt die View „Core startet neu …“ oder, ohne Neustart, „Verbindung zum Core getrennt“ und sendet ab dann weder Eingabe noch Größe noch Schreibrecht, auch nach späteren Events; erst nach `coreRestarted` ersetzt eine neu angehängte View sie

### Requirement: Screenshot-Modus gegen isolierten Core

Mit `--screenshot <dir>` SHALL die App einen eigenen Core starten (eigene Pipe, Datenverzeichnis in einem Temp-Verzeichnis, tmux-Socket `termdock-test-<pid>-<nonce>` dieses Laufs), Sessions in den Zuständen `Running`, `Detached`, `Exited` und `Interrupted` mit mehreren Tabs, eine eingeklappte Sidebar, ein leeres Fenster und einen Leser aufnehmen (PNG in `<dir>`), danach Sessions und Core beenden, das Datenverzeichnis entfernen und mit Code 0 enden; bei Fehler mit Code 1.

#### Scenario: Aufnahme

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` PNG-Dateien mit der Sidebar in allen vier Zuständen und mehreren Tabs, mit eingeklappter Sidebar, mit leerem Fenster und geöffnetem Formular und mit einem Leser samt „Eingabe übernehmen“, und auf dem Socket des Laufs bleibt keine Session

#### Scenario: Parallele Läufe

- **GIVEN** ein Screenshot-Lauf oder WSL-Integrationstests auf `termdock-test` laufen
- **WHEN** ein zweiter Screenshot-Lauf startet
- **THEN** nutzt er einen eigenen tmux-Socket und ein eigenes Electron-Profil, und keiner der Läufe beendet Sessions des anderen

#### Scenario: Verbindung zum isolierten Core scheitert

- **GIVEN** der Screenshot-Lauf hat seinen Core gestartet
- **WHEN** das Verbinden oder die erste Antwort scheitert
- **THEN** beendet die App diesen Core mit `core.shutdown { stopSessions: true }` oder, wenn er nicht antwortet, über seine Prozess-ID, wartet auf sein Ende, entfernt danach das Datenverzeichnis und endet mit Code 1

#### Scenario: Produktiver Core bleibt unberührt

- **GIVEN** ein produktiver Core und eine App laufen
- **WHEN** die App zusätzlich mit `--screenshot <dir>` gestartet wird
- **THEN** verbindet sie sich nicht mit dem produktiven Core, öffnet kein Fenster im laufenden Main und ändert keine Session auf dem Socket `termdock`

### Requirement: Sidebar mit Sessions nach Workspace

Die Sidebar SHALL Workspaces mit Namen, Projekten und Sessions in der Reihenfolge des Core zeigen, darunter „Ohne Gruppe“ und ein Archiv. Archivierte Sessions stehen nur im Archiv, Sessions mit unbekanntem Workspace unter „Ohne Gruppe“. Jede Session SHALL ein Zustandssymbol tragen und sich über `session.stateChanged`, `sessionCreated`, `sessionUpdated`, `sessionRemoved` und `workspaceChanged` aktualisieren. Die Sidebar SHALL sich ein- und ausblenden lassen.

#### Scenario: Sessions ohne Workspace

- **GIVEN** der Core kennt zwei Sessions ohne `workspaceId`
- **WHEN** ein Fenster startet
- **THEN** zeigt die Sidebar beide im Bereich „Ohne Gruppe“

#### Scenario: Gruppe je Workspace

- **GIVEN** zwei Workspaces „Web“ und „Daten“, eine Session in „Web“ und ein Projekt in „Daten“
- **WHEN** die Sidebar sie anzeigt
- **THEN** stehen beide unter ihrem Namen in der Reihenfolge des Core, „Web“ mit der Session, „Daten“ mit dem Projekt, und „Ohne Gruppe“ zuletzt

#### Scenario: Zustandswechsel

- **GIVEN** die Sidebar zeigt `s1` als `Running`
- **WHEN** der Main `session.stateChanged` mit `Exited` meldet
- **THEN** zeigt die Sidebar `s1` als `Exited`

#### Scenario: Neue Session in anderem Fenster

- **GIVEN** zwei Fenster zeigen die Sidebar
- **WHEN** Fenster A eine Session anlegt
- **THEN** erscheint sie auch in der Sidebar von Fenster B

#### Scenario: Änderung eines anderen Clients

- **GIVEN** zwei Fenster zeigen die Sidebar, `s1` steht unter „Ohne Gruppe“
- **WHEN** ein anderer Core-Client `s1` in den Workspace „Web“ verschiebt und danach einen Workspace anlegt
- **THEN** steht `s1` in beiden Fenstern unter „Web“ und der neue Workspace erscheint in beiden

#### Scenario: Update ändert den Zustand nicht

- **GIVEN** die Sidebar zeigt `s1` als `Exited`
- **WHEN** ein `sessionUpdated` mit einem älteren Zustand `Running` und neuem Namen eintrifft
- **THEN** zeigt sie `s1` mit dem neuen Namen weiter als `Exited`

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

Ein Klick auf eine Session SHALL einen Tab öffnen oder den Tab fokussieren, der sie schon in einem Pane zeigt, mit diesem Pane als aktivem; Strg+Klick SHALL immer einen neuen Tab mit eigener View öffnen. Jedes Pane SHALL höchstens einmal angehängt sein und angehängt bleiben, solange es offen ist, auch in einem anderen Tab; Wechseln SHALL nichts am Core ändern. Schließen eines Tabs SHALL die Views aller seiner Panes mit `session.detach` lösen, die Session läuft weiter, und der Nachbar wird aktiv.

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

#### Scenario: Pane wandert in einen anderen Tab

- **GIVEN** ein Tab mit zwei Panes, das linke zeigt `s1` und schreibt
- **WHEN** der Benutzer das linke Pane in einen eigenen Tab verschiebt
- **THEN** sendet das Fenster weder `session.detach` noch `session.attach` für diese View, und sie schreibt im neuen Tab weiter

### Requirement: Neues Fenster mit eigenen Tabs

Der Main SHALL über das Menü „Neues Fenster“ ein Fenster öffnen, das eigene Tabs hat. Ein Fenster ohne Tabs SHALL die Sidebar und einen Leerzustand zeigen.

#### Scenario: Neues Fenster aus dem Menü

- **GIVEN** Fenster A zeigt zwei Tabs
- **WHEN** der Benutzer „Neues Fenster“ wählt
- **THEN** öffnet sich Fenster B ohne Tabs mit Sidebar und Leerzustand, und die Tabs von A bleiben unverändert

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

Der Zustand eines Fensters (Sessions, Tabs, aktiver Tab, Pane-Baum und aktives Pane je Tab, Sidebar) SHALL in einem Store ohne React und Electron liegen, dessen Fensteranteil die Form `LayoutWindow` mit `LayoutTab` hat; `root` eines Tabs ist ein `PaneNode` mit 1 bis 4 Panes. Er SHALL höchstens 64 Tabs je Fenster zulassen.

#### Scenario: Tab im Layout-Format

- **WHEN** der Store einen Tab für `s1` anlegt
- **THEN** hat der Tab eine `id`, ein `root` vom Typ `pane` mit `sessionId` `s1` und `activePaneId` auf dieses Pane

#### Scenario: Tab-Limit

- **GIVEN** das Fenster hat 64 Tabs
- **WHEN** eine weitere Session geöffnet wird
- **THEN** entsteht kein Tab, und die Statusleiste nennt das Limit

### Requirement: Split-Panes je Tab

Teilen (Kürzel, Knöpfe) SHALL per `session.create` eine neue Session mit Backend, Distribution, Shell, `cwd` und Workspace der Session des aktiven Panes starten und im neuen, aktiven Pane rechts oder unten zeigen. Umschalt+Klick in der Sidebar SHALL die angeklickte Session zeigen; ist sie die des geteilten Panes, liest die neue View, und das geteilte bleibt aktiv. Ein Tab SHALL höchstens 4 Panes haben. Schließen löst die View; Splits mit einem Kind entfallen, gleichgerichtete verschmelzen.

#### Scenario: Pane teilen

- **GIVEN** ein Tab zeigt `s1` (WSL, `cwd` `/srv`) in einem Pane, das schreibt
- **WHEN** der Benutzer „Rechts teilen“ oder `Ctrl+Shift+D` wählt
- **THEN** legt das Fenster eine neue Session mit Backend `wsl` und `cwd` `/srv` an, der Tab hat einen Split `row` mit zwei Panes zu je 50 %, das neue zeigt die neue Session, ist aktiv und schreibt

#### Scenario: Dieselbe Session per Umschalt+Klick

- **GIVEN** ein Tab zeigt `s1` in einem Pane, das schreibt
- **WHEN** der Benutzer `s1` in der Sidebar mit Umschalt+Klick wählt
- **THEN** zeigt das neue Pane `s1` als lesende View, und das geteilte Pane bleibt aktiv und behält den Tastaturfokus

#### Scenario: Teilen mit anderer Session

- **GIVEN** ein Tab zeigt `s1` in einem Pane
- **WHEN** der Benutzer `s2` in der Sidebar mit Umschalt+Klick wählt
- **THEN** zeigt das neue Pane rechts daneben `s2` und ist aktiv

#### Scenario: Gleichgerichtete Splits verschmelzen

- **GIVEN** ein Split `row` mit A und einem Split `column` aus B und einem Split `row` aus C und D
- **WHEN** der Benutzer B schließt
- **THEN** ist `root` ein Split `row` mit A, C und D, und die Anteile ergeben weiter 1

#### Scenario: Teilen in gleicher Richtung

- **GIVEN** ein Tab hat einen Split `row` mit zwei Panes
- **WHEN** der Benutzer das rechte Pane rechts teilt
- **THEN** hat der Split drei Kinder, und das geteilte Pane gibt die Hälfte seines Anteils an das neue ab

#### Scenario: Fünftes Pane gesperrt

- **GIVEN** ein Tab hat 4 Panes
- **WHEN** der Benutzer teilen will
- **THEN** sind die Schaltflächen gesperrt, es wird keine Session angelegt, und der Baum bleibt unverändert

#### Scenario: Pane schließen

- **GIVEN** ein Split `row` mit den Panes A und B
- **WHEN** der Benutzer B schließt
- **THEN** löst das Fenster die View von B, `root` des Tabs ist das Pane A, und A ist aktiv

#### Scenario: Layout-Prüfung

- **WHEN** ein Tab durch Teilen, Schließen und Ziehen verändert wurde
- **THEN** besteht das Fenster die Layout-Prüfung des Core (`validateLayoutDocument`)

### Requirement: Trenner und gebündelte Größe

Zwischen den Kindern eines Splits SHALL ein Trenner liegen, der sich mit der Maus ziehen lässt; kein Pane wird kleiner als ein Mindestanteil. Ändert sich die Fläche einer View durch Trenner, Fenster oder Sidebar, SHALL nur die schreibende View ihr Terminal anpassen und `session.resize` senden, gebündelt nach einer kurzen Verzögerung und nur bei geänderter Größe. Ein verstecktes Pane SHALL keine abweichende Größe senden.

#### Scenario: Trenner ziehen

- **GIVEN** zwei Panes nebeneinander, das linke schreibt
- **WHEN** der Benutzer den Trenner nach rechts zieht
- **THEN** wird das linke Pane breiter, und `stty size` in seiner Session meldet die neue Spaltenzahl

#### Scenario: Kein Sturm von Resize-Anfragen

- **GIVEN** eine schreibende View
- **WHEN** sich ihre Fläche innerhalb der Verzögerung mehrmals ändert
- **THEN** sendet sie höchstens ein `session.resize` mit der letzten Größe

#### Scenario: Mindestgröße

- **WHEN** der Benutzer einen Trenner bis an den Rand zieht
- **THEN** behält das kleinere Pane den Mindestanteil, und die Anteile ergeben weiter 1

#### Scenario: Versteckter Tab

- **GIVEN** ein Tab mit Panes ist versteckt
- **WHEN** der Benutzer einen anderen Tab ansieht
- **THEN** sendet keine View des versteckten Tabs `session.resize`

### Requirement: Aktives Pane und Schreibrecht per Klick

Je Tab SHALL genau ein Pane aktiv und sichtbar markiert sein; es hat den Tastaturfokus, und die Statusleiste zeigt seine View. Ein Drücken in ein Pane SHALL es aktiv machen und sonst nichts ändern. Nur ein Doppelklick in ein lesendes Pane SHALL `session.claimWriter` senden; ein einfacher Klick und Markieren von Text SHALL weder Schreiber noch Größe der Session ändern.

#### Scenario: Klick in lesendes Pane

- **GIVEN** zwei Panes zeigen `s1`, A schreibt, B liest
- **WHEN** der Benutzer einmal in B klickt
- **THEN** ist B aktiv und markiert, sendet kein `session.claimWriter`, A schreibt weiter, und die Größe der Session bleibt

#### Scenario: Text im Leser markieren

- **GIVEN** A schreibt `s1`, B liest `s1`
- **WHEN** der Benutzer in B Text mit der Maus markiert
- **THEN** wird B aktiv, sendet aber kein `session.claimWriter`, und die Größe der Session bleibt

#### Scenario: Doppelklick in lesendes Pane

- **GIVEN** zwei Panes zeigen `s1`, A schreibt, B liest
- **WHEN** der Benutzer in B doppelt klickt
- **THEN** sendet B `session.claimWriter`, schreibt nach `view.writerChanged` und passt die Größe an; A wird Leser

#### Scenario: Klick in schreibendes Pane

- **GIVEN** A schreibt und ist nicht aktiv
- **WHEN** der Benutzer in A klickt oder doppelt klickt
- **THEN** wird A aktiv, und das Fenster sendet kein `session.claimWriter`

### Requirement: Lesende View in Schreibergröße

Eine lesende View SHALL das Raster des Schreibers zeigen und ihre Schrift in ganzen Pixeln nur so weit verkleinern, dass es in ihre Fläche passt, nie über die normale Größe. Unter der Mindestschrift SHALL sie diese nutzen und abschneiden. Die Fläche außerhalb ist abgedunkelt, ein Hinweis nennt „Größe des Schreibers: C×R“. Wird sie Schreiber, gilt die normale Schrift. Eine schreibende View zeigt weder Abdunklung noch Hinweis.

#### Scenario: Leser in kleinerem Pane

- **GIVEN** A schreibt `s1` mit 132×40, B liest `s1` in einem Pane mit 70 % der Fläche von A
- **WHEN** B gezeichnet wird
- **THEN** zeigt B das ganze Raster 132×40 in kleinerer Schrift und den Hinweis „Größe des Schreibers: 132×40“

#### Scenario: Leser unter der Mindestschrift

- **GIVEN** B liest in einem Pane, in das das Raster erst unter der Mindestschrift passen würde
- **WHEN** B gezeichnet wird
- **THEN** zeigt B die linke obere Ecke in der Mindestschrift, der Rest ist abgeschnitten

#### Scenario: Leser in größerem Pane

- **GIVEN** B liest in einem Pane, das größer ist als der Schreiber
- **WHEN** B gezeichnet wird
- **THEN** bleibt die Schrift normal, und die Fläche rechts und unter dem Terminal ist abgedunkelt

### Requirement: Screenshot-Szenen für Split-Panes

Der Screenshot-Modus SHALL zusätzlich aufnehmen: Tabs mit 2, 3 und 4 Panes, zwei Sessions nach Teilen per Knopf, `stty size` vor und nach dem Ziehen eines Trenners, dieselbe Session per Umschalt+Klick mit gezoomtem und beschnittenem Leser, den Leser vor und nach „Eingabe übernehmen“ (ein einfacher Klick ändert nichts, geprüft) und `vim` vor und nach der Größenänderung. Wartet eine Szene vergeblich, SHALL der Lauf mit Code 1 enden.

#### Scenario: Aufnahme der Splits

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` zusätzlich PNG-Dateien mit 2, 3 und 4 Panes, mit zwei Sessions nach dem Teilen, mit `stty size` vor und nach dem Ziehen, mit einem gezoomten und einem beschnittenen Leser, mit dem Leser vor und nach der Übernahme und mit `vim` vor und nach der Größenänderung

### Requirement: Sequenznummer und Marke vom Core

Der Main SHALL jeder Ausgabe an die Fenster die Nummer `seq` des Core mitgeben und als Marke der Attach-Antwort `outputSeq` des Core verwenden. Fehlen die Felder (Core mit Protokoll 1.0), SHALL er die Ausgabe je Session selbst ab 1 zählen und als Marke die zuletzt gezählte Nummer nehmen.

#### Scenario: Zurückgehaltene Ausgabe in einem späteren Lesevorgang

- **GIVEN** Fenster A hat eine View von `s1` und hängt eine zweite an; der Core antwortet mit `outputSeq: 5`
- **WHEN** Ausgabe von `s1` mit `seq` 5 erst nach der Antwort beim Main eintrifft, danach Ausgabe mit `seq` 6
- **THEN** meldet der Main die Marke 5, und die neue View stellt nur die Ausgabe 6 dar

#### Scenario: Core ohne Nummern

- **GIVEN** ein Core, der weder `seq` noch `outputSeq` sendet
- **WHEN** zwei Ausgaben von `s1` eintreffen und danach eine View angehängt wird
- **THEN** tragen die Ausgaben die Nummern 1 und 2, und die Marke ist 2

### Requirement: Layout gebündelt speichern

Der Main SHALL das Layout aller Fenster zu einem `LayoutDocument` bündeln (Tabs, aktiver Tab und Sidebar je Fenster vom Renderer, Position, Größe und Maximierung aus dem `BrowserWindow`) und mit `layout.save` speichern: nach Änderungen mit kurzer Verzögerung, mehrere Änderungen in einem Aufruf, und beim Beenden sofort. Die letzten Fenster bleiben beim Beenden im Layout; ein vom Benutzer geschlossenes weiteres Fenster wird entfernt.

#### Scenario: Mehrere Änderungen

- **WHEN** innerhalb der Verzögerung drei Änderungen eintreffen
- **THEN** sendet der Main ein `layout.save` mit dem Stand nach der dritten

#### Scenario: Beenden

- **GIVEN** zwei Fenster sind offen
- **WHEN** der Benutzer die App beendet
- **THEN** ist das Layout mit beiden Fenstern gespeichert, bevor die Verbindung zum Core endet; das gilt auch für „Beenden“ im Menü (`app.quit()` ohne `window-all-closed`) und für das Ende der Windows-Sitzung

#### Scenario: Beenden mit „Beenden“ im Menü

- **GIVEN** zwei Fenster sind offen und die letzte Änderung ist noch nicht gespeichert
- **WHEN** der Benutzer „Beenden“ wählt
- **THEN** hält der Main das Beenden einmal an, speichert das Layout mit beiden Fenstern, schließt die Verbindung und beendet die App dann

#### Scenario: Revisionskonflikt

- **GIVEN** ein anderer Client hat das Layout gespeichert, `layout.save` mit der bekannten Revision antwortet `invalid_state`
- **WHEN** der Main speichert
- **THEN** lädt er mit `layout.get` die aktuelle Revision und speichert seinen Stand erneut, sodass der letzte Stand gilt

### Requirement: Layout beim Start wiederherstellen

Beim Start SHALL der Main `layout.get` aufrufen und für jedes gespeicherte Fenster ein Fenster mit Tabs, Splits, aktiven Panes und Sidebar öffnen; jedes Pane hängt sich neu an. Position und Größe SHALL gegen `screen.getAllDisplays()` geprüft werden: liegt das Fenster nicht mehr ausreichend auf einem Bildschirm, wird es auf dem primären Bildschirm zentriert und auf dessen Arbeitsfläche begrenzt. Ohne gespeichertes Layout öffnet ein Fenster im Startzustand ohne Tabs.

#### Scenario: Zwei Fenster

- **GIVEN** ein gespeichertes Layout mit zwei Fenstern mit mehreren Tabs und einem Split
- **WHEN** die App startet
- **THEN** öffnen sich zwei Fenster mit denselben Tabs, Panes, Anteilen, aktiven Tabs und aktiven Panes, und jedes Pane einer lebenden Session hängt sich an

#### Scenario: Bildschirm fehlt

- **GIVEN** ein Fenster wurde auf einem Bildschirm gespeichert, der nicht mehr vorhanden ist
- **WHEN** die App startet
- **THEN** liegt das Fenster vollständig im sichtbaren Bereich des primären Bildschirms

#### Scenario: Kein Layout

- **GIVEN** `layout.get` liefert kein Layout
- **WHEN** die App startet
- **THEN** öffnet ein Fenster mit Sidebar und Leerzustand

#### Scenario: layout.get scheitert

- **GIVEN** `layout.get` scheitert beim Start auch nach Wiederholungen, und im Core ist ein Layout gespeichert
- **WHEN** der Benutzer in dem leeren Fenster arbeitet
- **THEN** überschreibt der Main das gespeicherte Layout nicht; er speichert erst, wenn `layout.get` antwortet und kein Layout liefert

#### Scenario: Neuladen der Seite

- **GIVEN** ein Fenster mit Tabs, dessen Seite neu lädt
- **WHEN** der Renderer startet
- **THEN** erhält er mit `windowLayout` dieselben Tabs und meldet nichts, bevor er sie übernommen hat

### Requirement: Platzhalter für nicht lebende Sessions

Ein Pane, dessen Session `Exited`, `Interrupted`, `Starting` oder `Archived` ist oder im Core fehlt, SHALL sich nicht anhängen, sondern Zustand, letzten Exit-Code und die Aktion „Pane schließen“ zeigen und nie als `Running` erscheinen. Eine Session gilt erst nach der ersten Session-Liste als fehlend.

#### Scenario: Interrupted nach Neustart

- **GIVEN** ein gespeichertes Pane zeigt eine Session, die der Core als `Interrupted` meldet
- **WHEN** das Layout wiederhergestellt wird
- **THEN** zeigt das Pane „Unterbrochen“ mit Zustand und der Aktion „Pane schließen“, und es gibt kein `session.attach` dafür

#### Scenario: Pane schließen

- **WHEN** der Benutzer im Platzhalter „Pane schließen“ wählt
- **THEN** entfernt der Store das Pane (bei der letzten schließt er den Tab), und das neue Layout wird gespeichert

#### Scenario: Fehlende Session

- **GIVEN** das Layout nennt eine Session, die der Core nicht kennt
- **WHEN** die Session-Liste geladen ist
- **THEN** zeigt das Pane den Platzhalter „Session nicht gefunden“, davor „Sessions werden geladen“

#### Scenario: Session-Liste scheitert

- **GIVEN** die erste Session-Liste scheitert
- **WHEN** auch die Wiederholungen scheitern
- **THEN** gilt die Liste als geladen (leer), und Panes zeigen den Platzhalter mit „Pane schließen“ statt „Sessions werden geladen“

### Requirement: Screenshot-Szenen für die Wiederherstellung

Der Screenshot-Modus SHALL zusätzlich ein Layout mit 2 Fenstern, mehreren Tabs und Splits vor dem Neustart der Oberfläche und den wiederhergestellten Zustand danach aufnehmen und beide Zustände (Tabs, Panes, Anteile, aktive Tabs, Position und Größe) vergleichen, dazu den Platzhalter einer vorher mit `tmux kill-session` beendeten Session. Weicht der Zustand ab, SHALL der Lauf mit Code 1 enden.

#### Scenario: Aufnahme der Wiederherstellung

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` zusätzlich PNG-Dateien beider Fenster vor und nach dem Neustart und einen Platzhalter einer `Interrupted`-Session

### Requirement: Zentrale Keymap

Das Fenster SHALL alle Tastenkürzel aus einer Tabelle Befehl → Kürzel beziehen. Standard: `Ctrl+Shift+T` neue Session, `Ctrl+Shift+W` Tab schließen, `Ctrl+Tab`, `Ctrl+Shift+Tab` und `Ctrl+1…9` für Tabs, `Ctrl+Shift+D` und `Ctrl+Shift+E` teilen, `Alt+Pfeiltasten` Pane-Fokus, `Ctrl+Shift+B` Sidebar, `Ctrl+Shift+N` neues Fenster, `Ctrl+Shift+C` und `Ctrl+Shift+V` Zwischenablage, `Ctrl+Shift+H` Übersicht. Kein Standardkürzel SHALL `Ctrl+<Buchstabe>` ohne Shift sein.

#### Scenario: Taste zu Befehl

- **GIVEN** die Standardbelegung
- **WHEN** `Ctrl+Shift+D` gedrückt wird
- **THEN** ist der Befehl „rechts teilen“

#### Scenario: Nicht gebundene Taste

- **GIVEN** die Standardbelegung
- **WHEN** `Ctrl+C`, `Ctrl+B`, ein Buchstabe oder `Alt+1` gedrückt wird
- **THEN** gehört die Taste keinem Befehl

### Requirement: Kürzel vor xterm.js

Eine gebundene Taste SHALL im Terminal als Befehl laufen (`attachCustomKeyEventHandler`), einmal je Tastendruck, und weder von xterm.js noch von der Shell verarbeitet werden. Hat der Befehl nichts zu tun (`Alt+Links` in einem Pane), SHALL die Taste unverändert an xterm.js gehen, ebenso jede andere. Buchstaben SHALL nach dem Zeichen der Belegung gelten, nicht nach der physischen Taste. Ein Fenster-Listener SHALL außerhalb des Terminals dasselbe tun. „Neues Fenster“ SHALL dem Menü bleiben.

#### Scenario: Taste ohne Wirkung

- **GIVEN** ein Tab mit einem Pane
- **WHEN** der Benutzer `Alt+Links` oder `Ctrl+Tab` drückt
- **THEN** erhält xterm.js die Taste unverändert

#### Scenario: Andere Tastaturbelegung

- **GIVEN** eine AZERTY-Belegung
- **WHEN** der Benutzer die Taste mit dem Zeichen W und `Ctrl+Shift` drückt
- **THEN** schließt sich der Tab

#### Scenario: Übersicht offen

- **GIVEN** die Übersicht der Kürzel ist offen
- **WHEN** der Benutzer `Alt+Rechts`, `Ctrl+2` oder `Ctrl+Shift+W` drückt
- **THEN** ändert sich darunter nichts, und xterm.js erhält die Taste nicht; `Ctrl+Shift+H` und Escape schließen die Übersicht, und das Terminal hat wieder den Fokus

#### Scenario: Tab per Kürzel

- **GIVEN** drei Tabs, der letzte ist aktiv
- **WHEN** der Benutzer `Ctrl+Tab` drückt
- **THEN** ist der erste Tab aktiv, und die Shell erhält keine Eingabe

#### Scenario: Interrupt bleibt bei der Shell

- **GIVEN** ein Befehl läuft im aktiven Pane
- **WHEN** der Benutzer `Ctrl+C` drückt
- **THEN** erhält die Shell ihn unverändert, und kein Befehl der App läuft

#### Scenario: Pane-Fokus

- **GIVEN** zwei Panes nebeneinander, das linke ist aktiv
- **WHEN** der Benutzer `Alt+Rechts` drückt
- **THEN** ist das rechte Pane aktiv und hat den Tastaturfokus; am Rand ändert sich nichts

### Requirement: Zwischenablage nur in der schreibenden View

`Ctrl+Shift+C` SHALL die Auswahl des aktiven Terminals unverändert kopieren. `Ctrl+Shift+V` und Rechtsklick SHALL die Zwischenablage über `Terminal.paste` einfügen (Zeilenumbruch wird CR, Bracketed Paste, wenn die Anwendung es anfordert). Eine lesende View SHALL weder einfügen noch die Zwischenablage lesen; die Statusleiste SHALL den Grund nennen. Fordert ein Programm Mausberichte an, SHALL der Rechtsklick an das Programm gehen.

#### Scenario: Mehrzeilig einfügen

- **GIVEN** die Shell fordert Bracketed Paste an und das Pane schreibt
- **WHEN** der Benutzer zwei Zeilen mit Umlauten einfügt
- **THEN** sendet das Fenster `ESC[200~` Text mit CR `ESC[201~` als `session.input`, und die Shell führt keine Zeile aus

#### Scenario: Einfügen im Leser

- **GIVEN** das aktive Pane liest
- **WHEN** der Benutzer `Ctrl+Shift+V` drückt
- **THEN** sendet das Fenster keine Eingabe, liest die Zwischenablage nicht, und die Statusleiste nennt „Einfügen nur im schreibenden Pane“

#### Scenario: Kopieren

- **GIVEN** Text im Terminal ist markiert
- **WHEN** der Benutzer `Ctrl+Shift+C` drückt
- **THEN** enthält die Zwischenablage genau diesen Text

### Requirement: Übersicht der Kürzel

Das Fenster SHALL die Kürzel aus der Keymap in einem Dialog anzeigen, geöffnet über eine Schaltfläche der Tab-Leiste oder `Ctrl+Shift+H`; Escape und die Schaltfläche SHALL ihn schließen, danach hat das aktive Terminal den Fokus.

#### Scenario: Übersicht öffnen und schließen

- **GIVEN** ein Fenster mit einem Terminal
- **WHEN** der Benutzer `Ctrl+Shift+H` und danach Escape drückt
- **THEN** erscheint der Dialog mit allen Kürzeln und verschwindet wieder; Escape erreicht die Shell nicht

### Requirement: Screenshot-Szenen für Tastenkürzel

Der Screenshot-Modus SHALL zusätzlich mit echten Tastenereignissen prüfen und aufnehmen: `Ctrl+C` erreicht die Shell, die Übersicht, mehrzeiliges Einfügen mit Umlauten ohne Ausführen, Kopieren, Teilen per Kürzel, Fokuswechsel, Einfügen im Leser (abgelehnt), ausgeblendete Sidebar und Schließen des Tabs. Wartet eine Szene vergeblich, SHALL der Lauf mit Code 1 enden.

#### Scenario: Aufnahme der Kürzel

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` zusätzlich PNG-Dateien der Übersicht, des eingefügten Texts, des abgelehnten Einfügens und des per Kürzel geteilten Fensters ohne Sidebar

### Requirement: Screenshot-Modus räumt verwaiste tmux-Sockets auf

Beim Start eines Screenshot-Laufs SHALL die App die tmux-Server auf Sockets `termdock-test-<pid>-<nonce>` beenden (`tmux -L <socket> kill-server`, über `wsl.exe` als Argument-Array), deren Prozess nicht mehr läuft. Der eigene Socket, Sockets laufender Prozesse, `termdock` und `termdock-test` SHALL unberührt bleiben. Fehler beim Aufräumen SHALL geloggt werden und den Lauf nicht abbrechen.

#### Scenario: Server eines abgebrochenen Laufs

- **GIVEN** ein Lauf ist abgebrochen und sein tmux-Server auf `termdock-test-<pid>-<nonce>` läuft noch
- **WHEN** ein neuer Screenshot-Lauf startet
- **THEN** läuft auf diesem Socket kein tmux-Server mehr

#### Scenario: Fremde Sockets bleiben

- **GIVEN** Sockets `termdock`, `termdock-test` und `termdock-test-<pid>-<nonce>` eines laufenden Prozesses
- **WHEN** ein Screenshot-Lauf aufräumt
- **THEN** ruft er auf keinem davon `kill-server` auf

#### Scenario: Aufräumen scheitert

- **GIVEN** WSL antwortet nicht oder `kill-server` eines Sockets scheitert
- **WHEN** ein Screenshot-Lauf aufräumt
- **THEN** loggt er den Fehler, versucht die übrigen Sockets und führt den Lauf fort

### Requirement: Neue Sessions in der Sidebar

Der Renderer SHALL eine Session aus dem Event `sessionCreated` in die Sidebar übernehmen und dabei idempotent sein: Dieselbe Session SHALL höchstens einmal erscheinen, wenn Event, Antwort auf `createSession` und `session.list` sie alle melden, und ein bekannter Zustand SHALL nicht auf einen älteren zurückfallen.

#### Scenario: Session eines anderen Clients

- **GIVEN** ein offenes Fenster mit geladener Liste
- **WHEN** ein anderer Core-Client eine Session anlegt
- **THEN** erscheint sie ohne Neuladen in der Sidebar

#### Scenario: Mehrfach gemeldet

- **GIVEN** ein Fenster, dessen erste Liste noch aussteht
- **WHEN** das Event zweimal eintrifft, die Liste die Session enthält und die Antwort von `createSession` ebenfalls
- **THEN** zeigt die Sidebar die Session einmal, im neuesten bekannten Zustand

### Requirement: Schließen-Dialog bei laufenden Sessions

Beim Beenden durch den Benutzer (Menü, Strg+Q, Schließen des letzten Fensters) SHALL der Main die Sessions mit `session.list` zählen und nur fragen, wenn mindestens eine `Running` oder `Detached` ist und `confirmQuitWhileRunning` gilt. Der Dialog SHALL im fokussierten Fenster erscheinen: „Oberfläche schließen, Sessions behalten“, „Sessions beenden“, „Abbrechen“ und „Nicht mehr fragen“. „Sessions beenden“ SHALL nach dem Speichern des Layouts `core.shutdown { stopSessions: true }` senden.

#### Scenario: Keine laufende Session

- **GIVEN** alle Sessions sind `Exited` oder `Interrupted`, oder es gibt keine
- **WHEN** der Benutzer die App beendet
- **THEN** erscheint kein Dialog, und die App beendet sich wie bisher

#### Scenario: Dialog bei laufenden Sessions

- **GIVEN** eine Session ist `Running` oder `Detached`, und die Nachfrage ist an
- **WHEN** der Benutzer die App beendet
- **THEN** bleibt die App offen und zeigt den Dialog mit der Zahl der laufenden Sessions; der Fokus liegt auf „Oberfläche schließen, Sessions behalten“

#### Scenario: Abbrechen

- **GIVEN** der Dialog ist offen und „Nicht mehr fragen“ ist gesetzt
- **WHEN** der Benutzer „Abbrechen“ wählt oder Escape drückt
- **THEN** bleiben Fenster, Sessions und Layout unverändert, und es wird nichts gespeichert

#### Scenario: Sessions behalten

- **GIVEN** der Dialog ist offen
- **WHEN** der Benutzer „Oberfläche schließen, Sessions behalten“ wählt
- **THEN** speichert der Main das Layout mit allen Fenstern, schließt die Verbindung und beendet die App; Core und Sessions laufen weiter

#### Scenario: Sessions beenden

- **GIVEN** der Dialog ist offen
- **WHEN** der Benutzer „Sessions beenden“ wählt
- **THEN** speichert der Main zuerst das Layout und sendet dann `core.shutdown { stopSessions: true }`, bevor die App endet

#### Scenario: Fenster der Frage verschwindet

- **GIVEN** der Dialog ist offen
- **WHEN** das Fenster neu geladen wird oder abstürzt
- **THEN** gilt die Frage als abgebrochen, und die App läuft weiter

#### Scenario: Fenster zeigt den Dialog nicht

- **GIVEN** der Main hat die Frage gesendet, aber der Renderer hat noch nicht zugehört oder hängt
- **WHEN** das Fenster den Dialog nicht binnen 5 s mit `quitShown` bestätigt (der Main sendet die Frage bis dahin alle 500 ms erneut und nach dem Laden der Seite)
- **THEN** gilt die Frage als abgebrochen: die App bleibt offen, nichts wird beendet, und das nächste Beenden fragt neu; nach der Bestätigung gibt es kein Zeitlimit

#### Scenario: Fokus bleibt im Dialog

- **GIVEN** der Dialog ist offen
- **WHEN** der Benutzer Tab oder Umschalt+Tab drückt oder der Fokus anderswohin springt
- **THEN** wandert der Fokus nur zwischen den Elementen des Dialogs bzw. kehrt dorthin zurück, und keine Taste erreicht das Terminal dahinter

### Requirement: Gespeicherte Wahl beim Beenden

Mit „Nicht mehr fragen“ SHALL der Main `confirmQuitWhileRunning: false` und die Wahl als `quitAction` per `settings.set` speichern, bevor er beendet; „Abbrechen“ speichert nie. Ist die Nachfrage aus, SHALL er die gespeicherte Aktion ohne Dialog anwenden (fehlend: Sessions behalten). Das Ende der Windows-Sitzung (`session-end`) SHALL nie fragen und die Sessions behalten. Antwortet der Core nicht, SHALL die App wie bisher beenden und die Sessions behalten.

#### Scenario: Nicht mehr fragen

- **GIVEN** der Dialog ist offen
- **WHEN** der Benutzer „Nicht mehr fragen“ setzt und „Sessions beenden“ wählt
- **THEN** sind `confirmQuitWhileRunning: false` und `quitAction: "stopSessions"` gespeichert, und das nächste Beenden mit laufenden Sessions beendet sie ohne Dialog

#### Scenario: Windows-Abmeldung

- **GIVEN** Sessions laufen, und die Nachfrage ist an oder die gespeicherte Aktion beendet Sessions
- **WHEN** Windows meldet `session-end`
- **THEN** erscheint kein Dialog, das Layout wird gespeichert, und die Sessions bleiben erhalten

#### Scenario: Core antwortet nicht

- **GIVEN** `session.list` scheitert beim Beenden
- **WHEN** der Benutzer die App beendet
- **THEN** beendet sich die App ohne Dialog und behält die Sessions

### Requirement: Screenshot-Szene des Schließen-Dialogs

Der Screenshot-Modus SHALL den Schließen-Dialog bei laufenden Sessions ohne und mit gesetztem „Nicht mehr fragen“ aufnehmen und über den echten Weg (Klick im Renderer, `answerQuit`, `settings.set` im isolierten Core) prüfen, dass „Abbrechen“ nichts speichert und eine gespeicherte Wahl nicht mehr fragt. Die Szene SHALL die Einstellungen danach zurücksetzen und die App nicht beenden.

#### Scenario: Szene des Dialogs

- **GIVEN** der Screenshot-Lauf hat Sessions in `Running` und `Detached`
- **WHEN** die Szene den Dialog öffnet, das Kästchen setzt, „Abbrechen“ und dann „Sessions beenden“ mit Kästchen wählt
- **THEN** liegen zwei PNG (`24-…`, `25-…`) im Ausgabeverzeichnis, die Entscheidungen stimmen, und der nächste Aufruf fragt nicht mehr

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

### Requirement: Sessions per Drag&Drop ordnen

Der Benutzer SHALL eine nicht archivierte Session in der Sidebar auf einen Workspace, auf „Ohne Gruppe“ oder auf das Archiv ziehen können (`session.update` mit `workspaceId` beziehungsweise `null`, `session.archive`). Während des Ziehens SHALL jedes gültige Ziel hervorgehoben sein, das Ziel unter dem Zeiger zusätzlich. Eine archivierte Session ist nicht ziehbar; das Ziehen auf das Archiv verlangt die Bestätigung des Archivierens.

#### Scenario: Auf einen Workspace ziehen

- **GIVEN** eine Session unter „Ohne Gruppe“ und ein Workspace „Web“
- **WHEN** der Benutzer sie mit der Maus auf „Web“ zieht und dort loslässt
- **THEN** sendet der Main `session.update` mit der `workspaceId` von „Web“, der Prozess bleibt unberührt, und die Session steht unter „Web“

#### Scenario: Hervorhebung beim Ziehen

- **GIVEN** eine Session in „Web“ und ein zweiter Workspace
- **WHEN** der Benutzer sie zieht und über den zweiten Workspace fährt
- **THEN** sind der zweite Workspace, „Ohne Gruppe“ und das Archiv als gültige Ziele hervorgehoben, der zweite zusätzlich als aktuelles Ziel, und „Web“ ist nicht hervorgehoben

#### Scenario: Klick statt Ziehen

- **WHEN** der Benutzer die Maus um weniger als 5 Pixel bewegt und loslässt
- **THEN** öffnet der Klick die Session, und es beginnt kein Ziehen

#### Scenario: Auf das Archiv ziehen

- **GIVEN** eine laufende Session
- **WHEN** der Benutzer sie auf das Archiv zieht
- **THEN** fragt ein Dialog nach der Bestätigung; erst „Archivieren“ sendet `session.archive`, bei Abbruch bleibt die Session unverändert

### Requirement: Abbruch des Ziehens

Esc, ein Loslassen außerhalb gültiger Ziele und ein Verlust des Zeigers (`pointercancel`, `blur`) SHALL das Ziehen einer Session, eines Tabs oder eines Panes beenden, ohne Aufruf an den Core, ohne Änderung am Layout und mit geschlossener Muster-Leiste. Nach jedem Ziehen SHALL der folgende Klick unterdrückt sein, damit keine Session öffnet und kein Tab wechselt. Die Logik SHALL ohne DOM testbar sein; ein `DragProvider` je Fenster trägt Sidebar, Tab-Leiste, Panes und Muster-Leiste.

#### Scenario: Esc bricht ab

- **GIVEN** eine Session wird gezogen
- **WHEN** der Benutzer Esc drückt und danach loslässt
- **THEN** verschwindet die Hervorhebung, es ergeht kein Aufruf an den Core, und die Session öffnet sich nicht

#### Scenario: Loslassen im Leeren

- **GIVEN** eine Session wird gezogen
- **WHEN** der Benutzer außerhalb jedes Ziels oder auf dem eigenen Workspace loslässt
- **THEN** ergeht kein Aufruf an den Core

#### Scenario: Esc beim Ziehen eines Tabs

- **GIVEN** ein Tab wird über einem Pane eines anderen Tabs gezogen, die Zonen sind sichtbar
- **WHEN** der Benutzer Esc drückt und danach loslässt
- **THEN** verschwinden Zonen und Hervorhebung, Tabs und Panes bleiben unverändert, und der aktive Tab wechselt nicht

#### Scenario: Esc in der Muster-Leiste

- **GIVEN** ein Tab wird über einem Feld der offenen Muster-Leiste gezogen
- **WHEN** der Benutzer Esc drückt und danach loslässt
- **THEN** schließt die Leiste, Tabs und Panes bleiben unverändert

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

### Requirement: Archiv-Bereich mit Löschen

Die Sidebar SHALL das Archiv eingeklappt zeigen, mit der Zahl archivierter Sessions. Aufgeklappt zeigt es jede archivierte Session mit der Aktion „Löschen“; sie verlangt eine Bestätigung, die den Verlust des Verlaufs nennt, und sendet danach `session.delete`. Archivieren verlangt ebenfalls eine Bestätigung, die das Beenden des Prozesses nennt.

#### Scenario: Archiv aufklappen

- **GIVEN** zwei archivierte Sessions
- **WHEN** der Benutzer das Archiv aufklappt
- **THEN** stehen beide mit „Löschen“ darunter, und eingeklappt zeigt die Zeile „2“

#### Scenario: Archivierte Session löschen

- **WHEN** der Benutzer bei einer archivierten Session „Löschen“ und im Dialog „Löschen“ wählt
- **THEN** sendet der Main `session.delete`, und die Session verschwindet aus dem Archiv

#### Scenario: Löschen abgelehnt

- **GIVEN** der Core lehnt `session.delete` mit `invalid_state` ab
- **WHEN** der Benutzer bestätigt
- **THEN** bleibt die Session im Archiv, und der Bestätigungsdialog zeigt die Meldung des Core und bleibt offen

### Requirement: Gelöschte Session im offenen Tab

Meldet der Main `sessionRemoved`, SHALL der Renderer die Session aus dem Store entfernen; ein Pane mit ihr zeigt danach den Platzhalter „Session nicht gefunden“ mit „Pane schließen“, und der Main vergisst ihre Sequenznummer. Das Event gilt für alle Fenster, auch bei einem Löschen durch einen anderen Client.

#### Scenario: Löschen durch anderen Client

- **GIVEN** Fenster A zeigt in einem Tab eine archivierte Session
- **WHEN** ein anderer Client sie löscht
- **THEN** zeigt der Tab in A den Platzhalter „Session nicht gefunden“, und die Sidebar listet sie nicht mehr

#### Scenario: Späte Antwort nach dem Löschen

- **GIVEN** `updateSession` für `s1` ist unterwegs und `sessionRemoved` für `s1` trifft vorher ein
- **WHEN** die Antwort eintrifft
- **THEN** erscheint `s1` nicht wieder; nur Events fügen unbekannte Sessions hinzu

### Requirement: Screenshot-Szenen der Sidebar

Der Screenshot-Modus SHALL die Sidebar mit zwei Workspaces (mit Projekt) und gruppenlosen Sessions, das aufgeklappte Archiv, ein Ziehen mit echten Mausereignissen (`webContents.sendInputEvent`) mit Hervorhebung der Ziele und nach dem Loslassen die verschobene Session, das Kontextmenü, die Bestätigung des Löschens und den Platzhalter einer gelöschten Session aufnehmen. Tritt eine erwartete Änderung nicht ein, SHALL der Lauf mit Code 1 enden.

#### Scenario: Aufnahme

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` zusätzlich PNG-Dateien der Sidebar mit Workspaces, des Archivs, der Hervorhebung beim Ziehen, des Kontextmenüs und der Lösch-Bestätigung, und die gezogene Session steht danach im Ziel-Workspace

### Requirement: Suchdialog für den Verlauf

Die Oberfläche SHALL mit `Ctrl+Shift+F` (Befehl `searchHistory`) und einer Schaltfläche der Tab-Leiste einen modalen Suchdialog öffnen und schließen. Er SHALL 250 ms nach der letzten Eingabe, mit Enter sofort, über die Brücke den Verlauf aller Sessions suchen und nur die Antwort der neuesten Suche zeigen. Treffer SHALL nach Session gruppiert mit Zeit und Zeilenausschnitt als Text erscheinen, nie interpretiert. Solange er offen ist, MUST nur sein Befehl wirken; Escape schließt ihn.

#### Scenario: Suchen

- **GIVEN** zwei Sessions mit gespeichertem „deploy“ in der Ausgabe
- **WHEN** der Benutzer `Ctrl+Shift+F` drückt und „deploy“ eingibt
- **THEN** zeigt der Dialog Treffer in zwei Gruppen mit den Namen der Sessions und hervorgehobenem Treffer

#### Scenario: Treffer öffnen

- **GIVEN** der Dialog zeigt Treffer einer Session
- **WHEN** der Benutzer einen Treffer anklickt
- **THEN** schließt der Dialog und der Tab der Session ist aktiv (neu geöffnet oder fokussiert; eine nicht lebende Session als Platzhalter)

#### Scenario: Späte Antwort

- **GIVEN** eine Suche nach „a“ ist unterwegs
- **WHEN** der Benutzer „ab“ sucht und die Antwort auf „a“ erst danach eintrifft
- **THEN** zeigt der Dialog das Ergebnis für „ab“

#### Scenario: Fehler und keine Treffer

- **GIVEN** der Dialog ist offen
- **WHEN** die Suche scheitert oder nichts findet
- **THEN** nennt er den Fehler bzw. „Keine Treffer“, und Eingabe bleibt möglich

#### Scenario: Modal

- **GIVEN** der Dialog ist offen
- **WHEN** der Benutzer `Ctrl+Shift+T`, `Ctrl+Shift+H` oder `Ctrl+Shift+V` drückt
- **THEN** wirkt keiner dieser Befehle, und die Taste erreicht das Terminal nicht

### Requirement: Screenshot-Szene der Verlaufssuche

Der Screenshot-Modus SHALL den Suchdialog leer und mit Treffern aus zwei Sessions aufnehmen, über den echten Weg (Kürzel, Eingabe, Brücke, Core-Suche) prüfen, dass beide Sessions in den Gruppen stehen, und einen Klick auf einen Treffer aufnehmen. Danach SHALL sie mit echten Tastenereignissen per Pfeil einen Treffer der zweiten Gruppe wählen, den Dialog aufnehmen, mit Enter die Session öffnen und aufnehmen; weicht eine Prüfung ab, endet der Lauf mit Exit-Code 1.

#### Scenario: Szene der Suche

- **GIVEN** zwei Sessions, die „deploy“ ausgegeben haben
- **WHEN** die Szene `Ctrl+Shift+F` drückt, „deploy“ eingibt und einen Treffer anklickt
- **THEN** liegen drei PNG (`26-…` bis `28-…`) im Ausgabeverzeichnis und der Tab der gewählten Session ist aktiv

#### Scenario: Szene der Tastaturwahl

- **GIVEN** der Dialog zeigt Treffer in zwei Gruppen
- **WHEN** die Szene Pfeil runter bis zum ersten Treffer der zweiten Gruppe und dann Enter drückt
- **THEN** liegen zwei weitere PNG (`29-…`, `30-…`) vor, und der Tab der zweiten Gruppe ist aktiv

### Requirement: Tabs und Panes per Drag&Drop anordnen

Der Benutzer SHALL Tabs in der Tab-Leiste umsortieren und einen Tab, ein Pane (über seinen Griff) oder eine Session der Sidebar auf eine von fünf Zonen eines Panes ziehen können: links, rechts, oben, unten teilen, die Mitte ersetzt dessen View. Ein Pane auf der Tab-Leiste SHALL ein eigener Tab werden; ein leerer Tab schließt. Zonen über 4 Panes SHALL gesperrt sein. Gezogen werden Views, nie Sessions: Eine verschobene View behält Rolle und Eingabe-Lock. Das Ergebnis steht im gemeldeten Layout.

#### Scenario: Tab umsortieren

- **GIVEN** die Tabs A, B und C, A ist aktiv
- **WHEN** der Benutzer A mit der Maus auf die rechte Hälfte von B zieht und loslässt
- **THEN** ist die Reihenfolge B, A, C, A ist aktiv, und das gemeldete Layout hat diese Reihenfolge

#### Scenario: Zonen beim Überfahren

- **GIVEN** Tab B mit einem Pane ist aktiv, Tab A hat ein Pane
- **WHEN** der Benutzer A über die rechte Kante des Panes von B zieht
- **THEN** zeigt das Pane fünf Zonen, die rechte ist hervorgehoben, und eine Vorschau deckt seine rechte Hälfte

#### Scenario: Tab in einen Split ziehen

- **GIVEN** Tab A zeigt `s1`, Tab B zeigt `s2` und ist aktiv
- **WHEN** der Benutzer A auf die untere Zone des Panes von B fallen lässt
- **THEN** hat B einen Split `column` mit `s2` oben und `s1` unten zu je 50 %, das Pane von `s1` ist aktiv, A ist geschlossen, und keine View wurde gelöst oder neu angehängt

#### Scenario: Mitte ersetzt die View

- **GIVEN** Tab B mit zwei Panes `s2` und `s3`, Tab A zeigt `s1`
- **WHEN** der Benutzer A auf die Mitte des Panes von `s3` fallen lässt
- **THEN** zeigt dieses Pane die View von `s1`, die View von `s3` wird gelöst, und `s3` läuft weiter

#### Scenario: Grenze von 4 Panes

- **GIVEN** Tab B hat 4 Panes, Tab A ein Pane
- **WHEN** der Benutzer A über die Kante eines Panes von B zieht
- **THEN** sind die Kanten gesperrt, nur die Mitte ist wählbar, und ein Loslassen ersetzt die View

#### Scenario: Pane herausziehen

- **GIVEN** Tab A mit zwei Panes, Tab B
- **WHEN** der Benutzer ein Pane von A am Griff auf die Tab-Leiste hinter B zieht
- **THEN** steht es als eigener, aktiver Tab hinter B, A hat ein Pane; zieht er auch das letzte Pane von A heraus, schließt A

#### Scenario: Session aus der Sidebar auf ein Pane

- **GIVEN** ein Tab zeigt `s1` in einem Pane, das schreibt
- **WHEN** der Benutzer `s2` aus der Sidebar auf die linke Zone zieht
- **THEN** zeigt ein neues, aktives Pane links `s2` als View nach den bestehenden Regeln, und `s1` schreibt weiter

#### Scenario: Leser bleibt Leser

- **GIVEN** zwei Panes zeigen `s1`, das rechte liest
- **WHEN** der Benutzer das lesende Pane auf die obere Zone des schreibenden zieht
- **THEN** liest es weiter, das andere schreibt weiter, und keine View wurde gelöst oder neu angehängt

### Requirement: Anordnen per Tastatur und Kontextmenü

Jede Anordnung SHALL ohne Maus gehen: Das Menü eines Tabs (Rechtsklick, Menütaste, Umschalt+F10) verschiebt ihn nach links oder rechts und fügt einen anderen Tab in eine Zone des aktiven Panes ein; der Griff eines Panes öffnet ein Menü zum Herauslösen und Tauschen mit dem Nachbarn; das Menü einer Session öffnet sie in einer Zone des aktiven Panes. `Ctrl+Shift+PageUp`/`PageDown` verschieben den aktiven Tab. Gesperrte Züge sind abgeblendet. Danach hat das aktive Terminal den Fokus.

#### Scenario: Tab per Tastatur verschieben

- **GIVEN** die Tabs A und B, A ist aktiv
- **WHEN** der Benutzer `Ctrl+Shift+PageDown` drückt
- **THEN** ist die Reihenfolge B, A, und A bleibt aktiv mit dem Fokus im Terminal

#### Scenario: Pane per Menü herauslösen

- **GIVEN** ein Tab mit zwei Panes
- **WHEN** der Benutzer den Griff eines Panes fokussiert, Enter drückt und „In eigenen Tab verschieben“ wählt
- **THEN** steht das Pane als eigener, aktiver Tab am Ende, und sein Terminal hat den Fokus

#### Scenario: Gesperrter Eintrag

- **GIVEN** der aktive Tab hat 4 Panes
- **WHEN** der Benutzer das Menü eines anderen Tabs öffnet
- **THEN** sind die Kanten-Einträge abgeblendet, „Mitte“ ist wählbar

### Requirement: Screenshot-Szenen für das Anordnen

Der Screenshot-Modus SHALL mit echten Mausereignissen (`webContents.sendInputEvent`) die Zonen-Überlagerung, das Ergebnis nach dem Ablegen, umsortierte Tabs und ein herausgezogenes Pane aufnehmen und prüfen, dass die verschobenen Views ohne neues Anhängen ihre Rolle behalten. Tritt eine erwartete Änderung nicht ein, SHALL der Lauf mit Code 1 enden.

#### Scenario: Aufnahme

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` PNG-Dateien der Zonen über einem Pane, des Splits nach dem Ablegen, der umsortierten Tabs und des herausgezogenen Panes, und die Views der verschobenen Panes sind dieselben wie vorher

### Requirement: Treffer der Suche per Tastatur wählen

Im Suchdialog SHALL Pfeil runter und hoch den nächsten und vorigen Treffer über alle Gruppen wählen und an den Enden stehen bleiben; Pos1 und Ende wählen den ersten und letzten, sobald einer gewählt ist. Der gewählte Treffer MUST hervorgehoben sein. Enter SHALL ihn wie ein Klick öffnen; ohne Auswahl oder nach geändertem Suchtext startet Enter die Suche. Neue Ergebnisse setzen die Auswahl zurück. Der Fokus SHALL im Suchfeld bleiben (`combobox`, `listbox`, `aria-activedescendant`).

#### Scenario: Mit Pfeiltasten wählen

- **GIVEN** der Dialog zeigt Treffer in zwei Gruppen, nichts ist gewählt
- **WHEN** der Benutzer so oft Pfeil runter drückt, bis der erste Treffer der zweiten Gruppe erreicht ist
- **THEN** ist genau dieser Treffer hervorgehoben (`aria-selected`), das Suchfeld verweist mit `aria-activedescendant` auf ihn und hat weiter den Fokus

#### Scenario: Enter öffnet

- **GIVEN** ein Treffer der Session „Deploy“ ist gewählt
- **WHEN** der Benutzer Enter drückt
- **THEN** schließt der Dialog und der Tab von „Deploy“ ist aktiv

#### Scenario: Enter ohne Auswahl oder nach neuem Text

- **GIVEN** der Dialog zeigt Treffer ohne Auswahl, oder der Suchtext wurde seit dem Ergebnis geändert
- **WHEN** der Benutzer Enter drückt
- **THEN** startet die Suche sofort, und kein Treffer des alten Ergebnisses wird geöffnet

#### Scenario: Enden und Neustart

- **GIVEN** der letzte Treffer ist gewählt
- **WHEN** der Benutzer Pfeil runter drückt
- **THEN** bleibt der letzte Treffer gewählt; nach einem neuen Ergebnis ist nichts gewählt

#### Scenario: Pos1 und Ende bewegen den Cursor ohne Auswahl

- **GIVEN** der Dialog zeigt Treffer, nichts ist gewählt
- **WHEN** der Benutzer Pos1 drückt
- **THEN** bewegt sich der Textcursor im Suchfeld, und die Auswahl bleibt leer

### Requirement: Session im Projekt starten

Klick und Enter auf eine Projektzeile der Sidebar sowie der Menüeintrag „Neue Session hier“ SHALL eine neue Session im Projekt starten: `session.create` mit Workspace des Projekts, seinem Namen (bei Namensgleichheit „api 2“ …) und `launch` aus Backend, Distro (falls da), Pfad als `cwd`, ohne Shell, Befehl, Umgebung. Sie öffnet sich wie jede neue Session (Strg+Klick Tab, Umschalt+Klick Split; Tab voll: abgewiesen). Fehler und ein gleichzeitiger zweiter Start melden sich in der Statusleiste.

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

#### Scenario: Weiterer Klick

- **GIVEN** eine Session „api“ aus einem früheren Klick auf das Projekt „api“
- **WHEN** der Benutzer das Projekt erneut anklickt
- **THEN** sendet der Main `session.create` mit Name „api 2“

#### Scenario: Split bei vollem Tab

- **GIVEN** der aktive Tab hat 4 Panes
- **WHEN** der Benutzer ein Projekt mit Umschalt+Klick anklickt
- **THEN** sendet das Fenster kein `session.create`, und die Statusleiste meldet „Höchstens 4 Panes je Tab“

#### Scenario: Doppelklick

- **GIVEN** der Start einer Session für ein Projekt ist unterwegs
- **WHEN** der Benutzer erneut klickt
- **THEN** sendet das Fenster kein zweites `session.create`, und die Statusleiste meldet, dass die Session noch gestartet wird

### Requirement: Screenshot-Szene für Projekt-Sessions

Der Screenshot-Modus SHALL das Menü eines Projekts mit „Neue Session hier“ und die gestartete Session im Projektpfad aufnehmen und prüfen, dass der Core die Session mit `cwd` des Projekts, dem Namen und dem Workspace des Projekts kennt und das Terminal das Verzeichnis zeigt. Tritt eine erwartete Änderung nicht ein, SHALL der Lauf mit Code 1 enden.

#### Scenario: Aufnahme

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` zusätzlich PNG-Dateien des Projektmenüs und der Session im Projektpfad

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

### Requirement: Änderungen an Einstellungen und Profilen an alle Fenster

Der Main SHALL `settings.changed` als `settingsChanged` und `profile.changed` als `profilesChanged` an alle Fenster weitergeben, auch für Änderungen anderer Clients. Ein offener Einstellungsdialog SHALL die neuen Werte übernehmen; ein Formular, das der Benutzer gerade bearbeitet, MUST seine Eingaben behalten.

#### Scenario: Zweites Fenster sieht die Änderung

- **GIVEN** zwei Fenster, im zweiten ist der Abschnitt Startprofile offen
- **WHEN** das erste Fenster ein Profil anlegt
- **THEN** zeigt die Liste des zweiten Fensters das neue Profil, ohne neu zu öffnen

### Requirement: Einstellungsdialog öffnen

Das Fenster SHALL den Einstellungsdialog mit `Ctrl+,` (Befehl der Keymap) und über „Datei → Einstellungen …“ öffnen; das Menü zeigt das Kürzel, ohne es selbst zu belegen, und öffnet den Dialog im fokussierten Fenster. Der Dialog SHALL modal sein wie die übrigen: Fokusfalle (auch über Auswahllisten und Textfelder), Escape schließt, danach hat das aktive Terminal den Fokus. Ein Fehler des Core SHALL im Dialog stehen und ihn offen lassen.

#### Scenario: Öffnen per Kürzel

- **GIVEN** ein Fenster mit einem Terminal im Fokus
- **WHEN** der Benutzer `Ctrl+,` und danach Escape drückt
- **THEN** erscheint der Dialog mit dem Abschnitt Allgemein und verschwindet wieder; keine der Tasten erreicht die Shell

#### Scenario: Öffnen über das Menü

- **WHEN** der Benutzer „Datei → Einstellungen …“ wählt
- **THEN** öffnet das fokussierte Fenster den Dialog

#### Scenario: Fehler des Core bleibt im Dialog

- **GIVEN** der Core lehnt das Speichern ab, etwa weil ein Profil einen Schlüssel `API_TOKEN` in der Umgebung hat
- **WHEN** der Benutzer speichert
- **THEN** zeigt der Dialog die Meldung des Core im sichtbaren Bereich (der Abschnitt rollt so weit wie nötig), bleibt offen und behält die Eingaben

### Requirement: Abschnitt Allgemein

Der Abschnitt Allgemein SHALL die Distribution (Auswahl aus `listDistros` plus „WSL-Standard“, ohne Liste ein freies Feld mit dem Grund), die Standardshell (pwsh, powershell, cmd oder keine), das Standardverzeichnis, den Schalter „Beim Schließen fragen“ (`confirmQuitWhileRunning`) und den Schalter „Nach Updates suchen“ (`checkForUpdates`, fehlend heißt an) zeigen. Speichern SHALL nur geänderte Schlüssel mit `updateSettings` senden; ein geleertes Feld MUST den Schlüssel entfernen (`null`).

#### Scenario: Nachfrage wieder einschalten

- **GIVEN** gespeichert ist `confirmQuitWhileRunning: false` mit `quitAction: "keepSessions"`
- **WHEN** der Benutzer „Beim Schließen fragen“ einschaltet und speichert
- **THEN** sendet das Fenster `settings.set { settings: { confirmQuitWhileRunning: true } }`, und das nächste Beenden mit laufenden Sessions fragt wieder

#### Scenario: Update-Suche ausschalten

- **GIVEN** `checkForUpdates` ist nicht gespeichert
- **WHEN** der Benutzer „Nach Updates suchen“ ausschaltet und speichert
- **THEN** sendet das Fenster `settings.set { settings: { checkForUpdates: false } }`; schaltet er es wieder ein, sendet es `checkForUpdates: true`

#### Scenario: Distribution aus der Liste

- **GIVEN** `listDistros` liefert `Ubuntu` (Standard) und `Debian`
- **WHEN** der Benutzer `Debian` wählt und speichert
- **THEN** ist `defaultDistro` `Debian`; wählt er danach „WSL-Standard“, sendet das Fenster `defaultDistro: null`

#### Scenario: WSL nicht verfügbar

- **GIVEN** `listDistros` liefert eine leere Liste mit Grund
- **WHEN** der Abschnitt öffnet
- **THEN** zeigt er den Grund und ein Textfeld für die Distribution

### Requirement: Abschnitt Verlauf

Der Abschnitt Verlauf SHALL das Limit je Session in MiB (64 KiB bis 1 GiB, also 0,0625 bis 1024) und den Schalter „Verlauf für neue Sessions“ (`historyEnabledByDefault`) zeigen und darauf hinweisen, dass der Verlauf unverschlüsselt auf der Platte liegt und mit der Session gelöscht wird. Ein Limit außerhalb der Grenzen oder keine Zahl MUST eine Meldung am Feld ergeben und nichts senden.

#### Scenario: Limit ändern

- **GIVEN** das Limit ist 10 MiB
- **WHEN** der Benutzer `20` einträgt und speichert
- **THEN** sendet das Fenster `historyLimitBytes: 20971520`

#### Scenario: Ungültiges Limit

- **WHEN** der Benutzer `0`, `2048` oder `zehn` einträgt
- **THEN** zeigt das Feld eine Meldung, und das Fenster sendet nichts

### Requirement: Abschnitt Kürzel

Der Abschnitt Kürzel SHALL die Übersicht der Keymap (dieselben Zeilen wie der Dialog „Tastenkürzel“) nur lesend zeigen.

#### Scenario: Übersicht im Dialog

- **WHEN** der Benutzer den Abschnitt Kürzel wählt
- **THEN** zeigt er jede Zeile der Übersicht mit Befehl und Kürzel, darunter `Ctrl+,` für die Einstellungen, und kein Eingabefeld

### Requirement: Startprofile im Dialog verwalten

Der Abschnitt Startprofile SHALL alle Profile mit Name, Backend und Befehl auflisten und Anlegen, Bearbeiten und Löschen (mit Rückfrage in der Zeile) anbieten. Der Editor SHALL Name, Backend, Distribution oder Shell, Verzeichnis, Befehl (ein Argument je Zeile), Umgebung (`NAME=Wert` je Zeile), Autostart und Verlauf zeigen und darauf hinweisen, dass Zugangsdaten nicht in die Umgebung gehören. Bearbeiten MUST Workspace und Projekt des Profils unverändert lassen.

#### Scenario: Profil anlegen

- **GIVEN** der Editor mit Name `Claude`, Backend WSL, Verzeichnis `/srv/app`, Befehl `claude` und `--continue` in zwei Zeilen, Autostart an
- **WHEN** der Benutzer speichert
- **THEN** sendet das Fenster `profile.create` mit `launch.command` `["claude", "--continue"]` und `autostart: true`, und die Liste zeigt das Profil

#### Scenario: Unveränderte Felder bleiben beim Bearbeiten

- **GIVEN** ein Profil mit Verzeichnis `~/work`, einem leeren Argument oder einem Argument mit Zeilenumbruch
- **WHEN** der Benutzer nur Autostart umschaltet und speichert
- **THEN** sendet das Fenster nur `autostart`; Verzeichnis, Befehl und Umgebung bleiben wie gespeichert

#### Scenario: Profil löschen

- **GIVEN** ein Profil in der Liste
- **WHEN** der Benutzer „Löschen“ und danach die Rückfrage bestätigt
- **THEN** sendet das Fenster `profile.delete`, und das Profil verschwindet aus der Liste; „Abbrechen“ sendet nichts

### Requirement: Eingaben im offenen Einstellungsdialog

Ein Abschnittswechsel SHALL die ungespeicherten Eingaben jedes Abschnitts (auch eines offenen Profil-Editors) behalten, bis der Dialog schließt; es gibt keine Rückfrage. Escape im offenen Profil-Editor SHALL zuerst zur Profilliste zurückkehren, erst ein weiteres Escape schließt den Dialog. Kommen neue Einstellungen (`settingsChanged`), SHALL jedes Feld, das der Benutzer nicht geändert hat, den neuen Wert zeigen; geänderte Felder bleiben, und Speichern vergleicht mit den neuen Werten.

#### Scenario: Abschnitt wechseln

- **GIVEN** im Abschnitt Verlauf steht ein ungespeichertes Limit `20`
- **WHEN** der Benutzer zu Kürzel und zurück zu Verlauf wechselt
- **THEN** steht dort weiter `20`

#### Scenario: Escape im Editor

- **GIVEN** der Profil-Editor ist offen
- **WHEN** der Benutzer Escape drückt
- **THEN** zeigt der Dialog wieder die Profilliste; ein zweites Escape schließt ihn

#### Scenario: Fremde Änderung bei offenem Abschnitt

- **GIVEN** Allgemein ist offen mit `Ubuntu`, und ein anderer Client setzt `defaultDistro: "Debian"`
- **WHEN** der Benutzer danach wieder `Ubuntu` wählt und speichert
- **THEN** zeigt das Feld vorher `Debian`, und das Fenster sendet `defaultDistro: "Ubuntu"`

### Requirement: Formularprüfung der Startprofile

Das Fenster SHALL das Profil vor dem Senden prüfen: Der Name MUST nach Trimmen 1 bis 128 Zeichen haben; das Verzeichnis MUST leer oder `~` (Standardverzeichnis), für WSL sonst ein absoluter Linux-Pfad und für Windows ein Laufwerks- oder UNC-Pfad sein; der Befehl MUST ein Array sein (leer heißt Login-Shell), Zeilen werden nie an Leerzeichen geteilt; Umgebungsnamen MUST `[A-Za-z_][A-Za-z0-9_]*` sein und dürfen sich nicht wiederholen. Ein Fehler steht am Feld, und nichts wird gesendet.

#### Scenario: Erstes fehlerhaftes Feld

- **GIVEN** im Editor sind Verzeichnis und Umgebung ungültig, und der Editor ist nach unten gerollt
- **WHEN** der Benutzer speichert
- **THEN** hat das Feld Verzeichnis den Fokus und steht mit seiner Meldung im sichtbaren Bereich

#### Scenario: Leerer Name

- **WHEN** der Benutzer ein Profil mit dem Namen `   ` speichert
- **THEN** meldet das Feld Name einen Fehler, und das Fenster sendet nichts

#### Scenario: Ungültiger Pfad

- **WHEN** der Benutzer für WSL `srv/app` oder `C:\dev` als Verzeichnis einträgt
- **THEN** meldet das Feld Verzeichnis einen Fehler; für Windows ist `C:\dev` gültig und `/srv` nicht

#### Scenario: Befehl mit Leerzeichen

- **WHEN** der Benutzer `git log --oneline` in eine Zeile schreibt
- **THEN** ist der Befehl `["git log --oneline"]`, ein einziges Argument, nie eine Shell-Zeile

### Requirement: Screenshot-Szenen der Einstellungen

Der Screenshot-Modus SHALL den Dialog per `Ctrl+,` öffnen und die Abschnitte Allgemein, Verlauf, Kürzel, Startprofile mit Liste und Editor sowie eine Fehleranzeige des Core (Profil mit `API_TOKEN` in der Umgebung) aufnehmen. Er SHALL prüfen, dass ein gespeichertes Profil und eine geänderte Einstellung im Core ankommen; weicht etwas ab oder wartet eine Szene vergeblich, MUST der Lauf mit Code 1 enden.

#### Scenario: Aufnahme der Einstellungen

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` je ein PNG der vier Abschnitte, des Profil-Editors, der Profilliste und der Fehleranzeige

### Requirement: Muster-Leiste beim Ziehen

Ruht ein gezogener Tab oder ein Pane kurz am oberen Rand des Tab-Bereichs (innerhalb der Breite der Leiste), SHALL oben eine einzeilige Leiste mit den Mustern „2 nebeneinander“, „2 übereinander“, „1 + 2“, „2 + 1“ und „2 × 2“ erscheinen. Sichtbar MUST nur ein Muster mit Platz für alle Views sein, die es ordnet (höchstens 4 Panes). Jedes Feld SHALL Namen und Statuspunkt der View zeigen, die dort landen würde; das Feld des gezogenen Elements ist markiert, freie Felder heißen „leer“.

#### Scenario: Leiste mit beschrifteten Feldern

- **GIVEN** Tab B mit `s2` ist aktiv, Tab A zeigt `s1`
- **WHEN** der Benutzer A an den oberen Rand des Tab-Bereichs und über das große Feld von „1 + 2“ zieht
- **THEN** zeigt die Leiste alle fünf Muster; in „1 + 2“ steht `s1` markiert links, `s2` rechts oben, rechts unten „leer“

#### Scenario: Muster ohne Platz sind ausgeblendet

- **GIVEN** der aktive Tab hat 2 Panes, ein anderer Tab 1 Pane
- **WHEN** der Benutzer den anderen Tab an den oberen Rand zieht
- **THEN** fehlen „2 nebeneinander“ und „2 übereinander“, die Muster mit 3 und 4 Feldern sind sichtbar

#### Scenario: Leiste nur am oberen Rand

- **GIVEN** ein Tab wird gezogen
- **WHEN** der Zeiger über der Tab-Leiste oder in der Mitte eines Panes steht, den oberen Rand nur auf dem Weg zur oberen Zone eines Panes überquert oder sich im Rand weiter bewegt
- **THEN** bleibt die Leiste geschlossen, die Zonen der Panes gelten wie bisher

#### Scenario: Offene Leiste nur über sich selbst

- **GIVEN** die Leiste ist offen
- **WHEN** der Zeiger unter ihre Unterkante oder mehr als 16 Pixel neben sie geht
- **THEN** schließt sie, und die Zonen der Panes darunter gelten sofort wieder

### Requirement: Ablegen auf ein Muster

Ein Ablegen auf ein Feld SHALL den aktiven Tab nach dem Muster ordnen: die gezogene View ins Feld, die übrigen in Baumreihenfolge in die anderen Felder, gleiche Anteile. Ein anderer gezogener Tab SHALL im aktiven Tab aufgehen. Leere Felder werden nicht angelegt. Jedes Pane MUST seine View behalten (Rolle, Eingabe-Lock, kein `session.detach`/`session.attach`). Die gezogene View wird aktiv; das Ergebnis steht im gemeldeten Layout.

#### Scenario: Tab auf ein Feld

- **GIVEN** Tab B mit `s2` ist aktiv, Tab A zeigt `s1`, beide schreiben
- **WHEN** der Benutzer A auf das zweite Feld von „2 nebeneinander“ fallen lässt
- **THEN** zeigt B links `s2` und rechts `s1` zu je 50 %, A ist geschlossen, beide schreiben weiter, und keine View wurde neu angehängt

#### Scenario: Leeres Feld entfällt

- **GIVEN** der aktive Tab hat 3 Panes
- **WHEN** der Benutzer ein Pane auf das erste Feld von „2 × 2“ legt
- **THEN** stehen oben zwei Panes nebeneinander, unten eines über die ganze Breite, und es gibt kein viertes Pane

#### Scenario: Grenze von 4 Panes

- **GIVEN** der aktive Tab hat 3 Panes, ein anderer Tab 2
- **WHEN** der Benutzer den anderen Tab an den oberen Rand zieht
- **THEN** öffnet keine Muster-Leiste, und das Layout bleibt unverändert

#### Scenario: Wiederherstellen

- **GIVEN** ein Tab wurde nach „2 + 1“ geordnet
- **WHEN** die App neu startet
- **THEN** steht der Tab mit denselben Panes und Anteilen wieder da

### Requirement: Muster per Kontextmenü

Die Menüs eines Tabs und des Griffs eines Panes SHALL jedes Muster als Eintrag anbieten: „Anordnen: <Muster>“ für den aktiven Tab und ein Pane, „Mit dem aktiven Tab anordnen: <Muster>“ für einen anderen Tab; das Element kommt ins erste Feld. Gesperrte Einträge SHALL abgeblendet sein und den Grund nennen. Danach hat das aktive Terminal den Fokus.

#### Scenario: Muster per Tastatur

- **GIVEN** der aktive Tab hat 3 Panes
- **WHEN** der Benutzer den Griff eines Panes fokussiert, Enter drückt und mit den Pfeiltasten „Anordnen: 2 × 2“ wählt
- **THEN** steht das Pane oben links, die beiden anderen folgen, und sein Terminal hat den Fokus

#### Scenario: Zu wenige Felder

- **GIVEN** der aktive Tab hat 2 Panes
- **WHEN** der Benutzer das Menü eines anderen Tabs mit einem Pane öffnet
- **THEN** sind die Einträge für „2 nebeneinander“ und „2 übereinander“ abgeblendet mit „Zu wenige Felder für alle Panes“

### Requirement: Screenshot-Szenen für Layout-Vorschläge

Der Screenshot-Modus SHALL mit echten Mausereignissen (`webContents.sendInputEvent`) die Muster-Leiste mit beschrifteten Feldern, den Abbruch mit Esc, das Ergebnis nach dem Ablegen und den Weg über Tastatur und Kontextmenü aufnehmen und prüfen, dass alle Views ohne neues Anhängen ihre Rolle behalten. Tritt eine erwartete Änderung nicht ein, SHALL der Lauf mit Code 1 enden.

#### Scenario: Aufnahme

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` PNG-Dateien der Leiste, des Ergebnisses nach dem Ablegen und nach der Wahl im Menü, und die Views sind dieselben wie vorher

### Requirement: Screenshot-Modus wählt Szenengruppen

Mit `--scenes <gruppe,…>` SHALL der Screenshot-Modus nur die genannten Szenengruppen aufnehmen (`scenario`, `sidebar`, `tabs`, `snap`, `restore`, `quit`, `search`, `settings`, `cwd`, `windows`, `drag`, `crash`, `restart`), fest geordnet, jede mit eigenem Aufbau; ohne Option alle. Ein unbekannter Name oder eine leere Liste beendet die App vor dem Core-Start mit Code 1. Eine gescheiterte Gruppe SHALL genau einmal wiederholt werden (Log `retry <gruppe>: <fehler>`); scheitert sie erneut, Code 1.

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

### Requirement: Hinweis bei fehlendem Arbeitsverzeichnis

Hat eine laufende Session die Warnung `cwd_missing`, SHALL ihr Pane unten einen einzeiligen Hinweis zeigen: „Verzeichnis <path> fehlt in <distro> – die Session läuft im Wurzelverzeichnis /.“ (langer Pfad gekürzt, voller Text als `aria-label`). Er MUST keine Eingabe blockieren (Maus geht außer am Schließknopf zum Terminal) und sich mit „Hinweis schließen“ schließen lassen; geschlossen bleibt er bis zum nächsten Start. Unbekannte Codes zeigt das Pane nicht.

#### Scenario: Hinweis im Pane

- **GIVEN** eine Session `API` mit `cwd` `/srv/api`, das in `Ubuntu` fehlt
- **WHEN** ihr Pane angezeigt wird
- **THEN** steht unten in einer Zeile „Verzeichnis /srv/api fehlt in Ubuntu – die Session läuft im Wurzelverzeichnis /.“, `pwd` im Terminal zeigt `/`, Zeile 0 des Terminals ist frei, und ein Klick auf den Text des Hinweises trifft das Terminal

#### Scenario: Schließen

- **GIVEN** der Hinweis ist sichtbar
- **WHEN** der Nutzer „Hinweis schließen“ wählt
- **THEN** verschwindet er, das Terminal nimmt weiter Eingaben an, und Wechsel zwischen `Running` und `Detached` desselben Laufs bringen ihn nicht zurück

#### Scenario: Neuer Start

- **GIVEN** ein geschlossener Hinweis
- **WHEN** die Session wieder `Starting` wird
- **THEN** zeigt das Pane die Warnungen des neuen Laufs wieder

#### Scenario: Ohne Warnung

- **GIVEN** eine Session in `/tmp`, eine beendete Session oder eine Warnung mit unbekanntem Code
- **WHEN** ihr Pane angezeigt wird
- **THEN** zeigt es keinen Hinweis

#### Scenario: Warnungen über die Brücke

- **GIVEN** ein `session.stateChanged` mit `warnings`, auch eines, das vor der ersten Liste ankommt
- **WHEN** der Main es weiterreicht und das Fenster es anwendet
- **THEN** hat die Session im Store diese Warnungen; ein Wechsel ohne `warnings` entfernt sie

#### Scenario: Screenshot-Szene

- **WHEN** der Screenshot-Modus läuft
- **THEN** entstehen `70-cwd-missing-warning.png` (Hinweis, `cwd=/` im Terminal) und `71-cwd-warning-dismissed.png` (geschlossen, weitere Eingabe), und eine Session in `/tmp` zeigt keinen Hinweis; mit `--scenes cwd` läuft die Szene allein

### Requirement: Screenshot-Szenen prüfen die Sichtbarkeit ihres Kernelements

Eine Szene des Screenshot-Modus mit Fehlermeldung, Menü oder Dialog SHALL vor der Aufnahme prüfen, dass das Kernelement existiert und vollständig innerhalb aller abschneidenden Vorfahren (`overflow` nicht `visible`, ohne Rahmen und Scrollbar) und des Fensters liegt; ein Element mit `position: fixed` liegt nur im Fenster. Sonst SHALL der Lauf mit Code 1 enden und Szenenname und Selektor nennen.

#### Scenario: Element abgeschnitten

- **GIVEN** die Meldung einer Szene liegt unterhalb des sichtbaren Bereichs ihres scrollbaren Panels
- **WHEN** die Szene aufnimmt
- **THEN** endet der Lauf mit Code 1, und die Meldung nennt Szene und Selektor

#### Scenario: Element vollständig sichtbar

- **GIVEN** das Menü einer Szene liegt ganz im Fenster
- **WHEN** die Szene aufnimmt
- **THEN** wird das PNG geschrieben

### Requirement: Core nach Absturz neu starten

Endet die Verbindung zum Core, während die App läuft und nicht beendet wird, SHALL der Main den Core wie beim Start verbinden oder starten (`connectOrStartCore`, gleiche Wartezeiten). Er SHALL höchstens 3 Neustarts in 2 Minuten versuchen, auch gescheiterte zählen; danach bleibt er getrennt, bis der Nutzer „Core neu starten“ wählt, was den Zähler leert. Beim Beenden der App SHALL er nicht neu starten.

#### Scenario: Core stirbt

- **GIVEN** die App ist mit dem Core verbunden
- **WHEN** der Core-Prozess endet
- **THEN** startet der Main genau einen neuen Core, verbindet sich und meldet allen Fenstern `coreRestarted`

#### Scenario: Ein anderer Core läuft schon

- **GIVEN** nach dem Ende der Verbindung belegt schon ein anderer Core die Pipe
- **WHEN** der Main neu verbindet
- **THEN** verbindet er sich nur und startet keinen Core

#### Scenario: Grenze erreicht

- **GIVEN** der Main hat in den letzten 2 Minuten 3 Neustarts versucht
- **WHEN** die Verbindung erneut endet
- **THEN** startet er nicht neu, alle Fenster erhalten `coreClosed { restarting: false }` und zeigen „Verbindung zum Core getrennt“ mit „Core neu starten“

#### Scenario: Knopf nach der Grenze

- **GIVEN** der Main ist nach der Grenze getrennt
- **WHEN** ein Fenster `restartCore` aufruft
- **THEN** leert der Main den Zähler, alle Fenster erhalten `coreClosed { restarting: true }` und zeigen „Core startet neu …“, und er startet neu wie nach einem Absturz

#### Scenario: Beenden

- **GIVEN** der Nutzer beendet die App, mit oder ohne „Sessions beenden“
- **WHEN** die Verbindung zum Core dabei endet
- **THEN** startet der Main keinen Core

#### Scenario: Beenden während des Neustarts

- **GIVEN** ein Neustart verbindet sich gerade
- **WHEN** der Nutzer die App mit „Sessions beenden“ beendet und der neue Core danach antwortet
- **THEN** sendet der Main ihm `core.shutdown { stopSessions: true }` und schließt die Verbindung; ohne „Sessions beenden“ schließt er sie nur, und der Core läuft weiter

#### Scenario: Fenster lädt während der Trennung

- **GIVEN** der Core startet neu oder der Main hat aufgegeben
- **WHEN** ein Fenster neu lädt oder ein neues Fenster öffnet
- **THEN** fragt es beim Start `coreConnection` und zeigt die Trennung mit dem aktuellen `restarting`, sofern noch kein neueres Event kam

### Requirement: Views nach dem Neustart neu anhängen

Während des Neustarts SHALL jedes Pane „Core startet neu …“ zeigen und nichts an den Core senden; Eingaben gehen verloren. Nach `coreRestarted` SHALL jedes Fenster Sessions, Workspaces und Core-Status neu holen und jedes Pane seine View neu anhängen; das aktive Pane des Fensters mit dem Fokus übernimmt das Schreibrecht. Danach SHALL kurz „Core neu gestartet“ erscheinen und sich selbst schließen.

#### Scenario: Wiederanbinden

- **GIVEN** zwei Panes zeigen die WSL-Session `s1`, das linke ist aktiv, das Fenster hat den Fokus
- **WHEN** der Core neu startet und `s1` beim Abgleich `Detached` bleibt
- **THEN** hängen beide Panes neu an, zeigen die alte Ausgabe aus dem Snapshot, und genau das linke schreibt

#### Scenario: Session ging verloren

- **GIVEN** ein Pane zeigt eine Session, die der Abgleich `Interrupted` markiert
- **WHEN** das Fenster nach `coreRestarted` neu lädt
- **THEN** zeigt das Pane den Platzhalter mit `Interrupted` statt eines Terminals

#### Scenario: Core endet während des Neuladens

- **GIVEN** ein Fenster hat `coreRestarted` erhalten und wartet auf die Sessionliste des neuen Core
- **WHEN** die Verbindung vor der Antwort wieder endet (`coreClosed`, oder die Liste scheitert mit `closed`) oder ein weiteres `coreRestarted` folgt
- **THEN** übernimmt das Fenster diese Liste nicht und hängt keine Views neu an: Es zeigt weiter die getrennte Verbindung mit „Core neu starten“, oder nur das letzte Neuladen übernimmt seine Liste samt der bis dahin gehaltenen Events

#### Scenario: Eingabe während des Neustarts

- **GIVEN** der Core startet neu
- **WHEN** der Nutzer im Pane tippt
- **THEN** sendet die View nichts, und die Eingabe wird nicht nachgereicht

#### Scenario: Views des alten Core

- **GIVEN** ein Fenster hatte Views beim alten Core
- **WHEN** die Verbindung endet
- **THEN** vergisst der Main diese Views, und ihr späteres `detach` geht nicht an den neuen Core

#### Scenario: Pane nach dem Neustart

- **GIVEN** der Core ist neu gestartet, ein anderes Fenster schreibt in `s1`
- **WHEN** der Nutzer im Fenster mit dem Fokus `s1` in einem neuen Pane öffnet und es aktiv macht
- **THEN** hängt das neue Pane als Leser an; nur die Panes, die der Neustart neu anhängt, übernehmen das Schreibrecht

### Requirement: Screenshot-Szenen des Core-Neustarts

Die Screenshot-Gruppe `restart` SHALL den isolierten Core per Prozess-ID beenden, den Neustart anhalten, „Core startet neu …“ im Pane als `90-core-restarting.png` und nach dem Neustart „Core neu gestartet“ als `91-core-restarted.png` aufnehmen, beide mit Sichtbarkeitsselektor, und prüfen, dass die alte Ausgabe im Pane steht und das Pane schreibt.

#### Scenario: Neustart im Bild

- **WHEN** der Screenshot-Modus mit `--scenes restart` läuft
- **THEN** entstehen beide Bilder, die Marke vor dem Absturz steht im Terminal, eine Eingabe danach erscheint, und der Lauf endet mit Code 0

### Requirement: Screenshot-Fenster auf einem Nebenmonitor

Im Screenshot-Modus SHALL ein Fenster ohne gespeicherte Position 40 px innerhalb des Arbeitsbereichs des ersten Monitors öffnen, der nicht der Hauptmonitor ist; ohne Nebenmonitor auf dem Hauptmonitor. `TERMDOCK_SCREENSHOT_DISPLAY` SHALL das überschreiben: `primary` oder die 1-basierte Nummer eines Monitors; eine Nummer ohne Monitor gilt wie keine Angabe. Der normale Start MUST unverändert bleiben.

#### Scenario: Drei Monitore

- **GIVEN** `screen.getAllDisplays()` liefert Nebenmonitor A, Nebenmonitor B und den Hauptmonitor in dieser Reihenfolge
- **WHEN** ein Screenshot-Lauf ohne `TERMDOCK_SCREENSHOT_DISPLAY` ein Fenster öffnet
- **THEN** liegt es 40 px innerhalb des Arbeitsbereichs von Nebenmonitor A

#### Scenario: Hauptmonitor gewählt

- **WHEN** ein Screenshot-Lauf mit `TERMDOCK_SCREENSHOT_DISPLAY=primary` ein Fenster öffnet
- **THEN** liegt es 40 px innerhalb des Arbeitsbereichs des Hauptmonitors

### Requirement: Screenshot-Läufe laufen rechnerweit nacheinander

Vor dem Start seines Cores SHALL ein Screenshot-Lauf `termdock-screenshot.lock` im Temp-Verzeichnis exklusiv mit seiner PID anlegen. Ist sie belegt, SHALL er warten, `waiting for screenshot run <pid>` loggen und nach 15 min ohne Core mit Code 1 enden. Frei SHALL eine Sperre sein, deren Prozess beendet ist, deren Inhalt unlesbar und älter als 5 s ist oder die älter als 12 min ist. Er SHALL nur die eigene Sperre entfernen; das Warten zählt nicht ins Laufzeitlimit.

#### Scenario: Zweiter Lauf wartet

- **GIVEN** ein Screenshot-Lauf mit PID 100 hält die Sperre
- **WHEN** ein zweiter Screenshot-Lauf startet
- **THEN** loggt er `waiting for screenshot run 100`, startet keinen Core, solange die Sperre gehalten wird, und beginnt seine Szenen erst, wenn der erste Lauf die Sperre entfernt hat

#### Scenario: Verwaiste Sperre

- **GIVEN** die Sperrdatei enthält die PID eines beendeten Prozesses
- **WHEN** ein Screenshot-Lauf startet
- **THEN** ersetzt er die Sperre durch seine eigene und läuft ohne zu warten

#### Scenario: Unlesbare Sperre

- **GIVEN** die Sperrdatei enthält keine PID (ihr Lauf starb zwischen Anlegen und Schreiben)
- **WHEN** ein Screenshot-Lauf startet
- **THEN** wartet er, solange die Datei höchstens 5 s alt ist, und ersetzt sie danach durch seine eigene

#### Scenario: Sperre älter als 12 min

- **GIVEN** die Sperrdatei ist älter als 12 min und ihre PID gehört einem lebenden Prozess (wiederverwendete PID)
- **WHEN** ein Screenshot-Lauf startet
- **THEN** ersetzt er die Sperre durch seine eigene und läuft ohne zu warten

#### Scenario: Zeitlimit des Wartens

- **GIVEN** ein wartender Lauf und andere Läufe, die die Sperre nacheinander halten, sodass ihn 15 min lang keine freie Sperre erreicht
- **WHEN** der wartende Lauf sein Zeitlimit erreicht
- **THEN** endet er mit Code 1, ohne einen Core gestartet zu haben, und lässt die fremde Sperre liegen

#### Scenario: Vorübergehender Dateifehler

- **GIVEN** das Anlegen, Lesen oder Entfernen der Sperrdatei scheitert mit `EPERM`, `EACCES` oder `EBUSY` (Löschen ausstehend, Virenscanner)
- **WHEN** ein Screenshot-Lauf die Sperre nehmen will
- **THEN** gilt die Sperre in dieser Runde als belegt, er versucht es weiter bis zum Zeitlimit von 15 min, und andere Dateifehler beenden ihn mit Code 1

#### Scenario: Freigabe am Ende

- **GIVEN** ein Screenshot-Lauf hält die Sperre
- **WHEN** er endet, mit Code 0 oder 1, auch weil das Verbinden mit seinem Core scheitert
- **THEN** entfernt er die Sperrdatei, aber nur, wenn sie noch seine PID enthält

### Requirement: Escape-Sequenzen nur im Terminal-Emulator

Der Main-Prozess SHALL Terminal-Ausgabe unverändert als `output`-Event an die Fenster der Session geben und MUST auf keine Sequenz reagieren. Die App MUST keinen eigenen OSC-Handler außer dem für OSC 9 (Verzeichnis der Windows-Shell), kein Clipboard-Addon (OSC 52 ist nicht umgesetzt), keinen Link-Öffner, kein `openExternal` und keinen Fenstertitel aus der Ausgabe haben. Ein OSC-8-Link aus xterm.js MUST kein Fenster öffnen und nicht navigieren (`setWindowOpenHandler`, `will-navigate` verweigern).

#### Scenario: Sequenzen durch die Brücke

- **GIVEN** ein Fenster mit einer View einer Session
- **WHEN** die Session OSC 52, einen OSC-8-Link und Titel-Sequenzen ausgibt
- **THEN** erhält das Fenster genau diese Bytes in `output`-Events und kein anderes Event, die PTY keine Eingabe, und kein Log enthält ihren Inhalt

#### Scenario: Kein Weg aus der Ausgabe

- **GIVEN** die Quellen von Main, Preload, Shared und Renderer
- **WHEN** sie geprüft werden
- **THEN** enthalten sie kein `registerOscHandler` für eine andere Nummer als 9, kein Clipboard- oder Web-Links-Addon, keinen `linkHandler`, kein `onTitleChange`, kein `openExternal` und keinen Import von `clipboard` aus Electron, und `main.ts` verweigert neue Fenster und Navigation

### Requirement: Screenshot-Szenen für einen Renderer-Absturz

Die Screenshot-Gruppe `crash` SHALL zwei Fenster mit derselben Session öffnen, den Renderer des schreibenden Fensters mit `forcefullyCrashRenderer()` beenden und `31-crash-input-free.png` (Leser mit „Eingabe übernehmen“), `32-crash-other-window-writes.png` (das andere Fenster schreibt) und `33-crash-reloaded-reader.png` (das neu geladene Fenster liest) aufnehmen, jede mit Sichtbarkeitsselektor. Sie läuft vor `restart`, weil diese Gruppe den Core beendet.

#### Scenario: Absturz und Neuladen

- **WHEN** der Screenshot-Modus mit `--scenes crash` läuft
- **THEN** liegen die drei PNG vor, der Main hielt nach dem Absturz keine View des Fensters, der Core nannte keinen Schreiber, das zweite Fenster schrieb sichtbar, das neu geladene Fenster hängte sich als Leser an, und der Lauf endet mit Code 0

### Requirement: Session aus der App neu starten

Der Platzhalter eines Panes SHALL bei `Interrupted` und `Exited` den Knopf „Neu starten“ zeigen, das Kontextmenü einer Session in der Sidebar den Eintrag „Neu starten“; in anderen Zuständen fehlen beide. Beide SHALL über den Bridge-Aufruf `restartSession` `session.restart` senden. Danach SHALL sich das Pane anhängen, sobald die Session lebt; eine Ablehnung zeigt der Platzhalter beziehungsweise die Statusleiste.

#### Scenario: Knopf im Platzhalter

- **GIVEN** ein Pane zeigt den Platzhalter einer `Interrupted`-Session
- **WHEN** der Benutzer „Neu starten“ wählt
- **THEN** sendet der Main `session.restart` mit ihrer ID, und sobald sie `Detached` ist, hängt das Pane eine View an und zeigt das Terminal

#### Scenario: Knopf nur für beendete Sessions

- **GIVEN** Platzhalter für Sessions in `Starting`, `Archived` und für eine fehlende Session
- **WHEN** sie angezeigt werden
- **THEN** hat keiner den Knopf „Neu starten“, die Platzhalter für `Exited` und `Interrupted` haben ihn

#### Scenario: Eintrag im Kontextmenü

- **GIVEN** Sessions in `Exited`, `Interrupted`, `Running`, `Detached`, `Starting` und `Archived`
- **WHEN** der Benutzer ihr Menü öffnet
- **THEN** steht „Neu starten“ nur bei `Exited` und `Interrupted`, und die Wahl sendet `restartSession`

#### Scenario: Ablehnung

- **GIVEN** der Core lehnt den Neustart mit `backend_unavailable` ab
- **WHEN** der Benutzer im Platzhalter „Neu starten“ gewählt hat
- **THEN** zeigt der Platzhalter die Meldung, und der Knopf ist wieder wählbar

#### Scenario: Ablehnung im Menü

- **GIVEN** der Core lehnt den Neustart mit `backend_unavailable` ab
- **WHEN** der Benutzer im Kontextmenü der Sidebar „Neu starten“ gewählt hat
- **THEN** zeigt die Statusleiste die Meldung des Core

#### Scenario: Kalte Distro

- **GIVEN** WSL startet die Distro nach einem Windows-Neustart erst
- **WHEN** der Main `session.restart` sendet
- **THEN** wartet er so lange wie bei `session.create` statt nach 10 s mit `timeout` abzubrechen

#### Scenario: Ungültiger Aufruf

- **WHEN** ein Renderer `restartSession` ohne oder mit leerer ID sendet
- **THEN** antwortet der Main mit `bad_request` und sendet nichts an den Core

### Requirement: Screenshot-Szenen für den Neustart einer Session

Die Gruppe `restore` SHALL die unterbrochene Session über den Knopf im Platzhalter neu starten und `19a-session-restarted.png` mit dem angehängten Terminal als Sichtbarkeitsselektor aufnehmen, dann prüfen, dass `history.search` die Trennzeile findet. Danach SHALL sie die beendete Session über das Kontextmenü neu starten und `19b-sidebar-restart-menu.png` mit dem Eintrag als Sichtbarkeitsselektor aufnehmen.

#### Scenario: Neustart im Bild

- **WHEN** der Screenshot-Modus mit `--scenes restore` läuft
- **THEN** enthält `<dir>` `19a-session-restarted.png` und `19b-sidebar-restart-menu.png`, und der Lauf endet mit Code 1, wenn die Session nicht lebt, kein Pane angehängt ist oder die Trennzeile im Verlauf fehlt

### Requirement: Neustart in einer angehängten View

Eine angehängte View einer Session in `Exited` oder `Interrupted` SHALL oben im Pane eine Leiste mit Zustand und Grund zeigen, in anderen Zuständen nicht. Nur die schreibende View SHALL darin den Knopf „Neu starten“ haben, der `restartSession` sendet; eine lesende View zeigt nur einen Hinweis und sendet weder Eingabe noch Resize. Nach dem Neustart SHALL die Leiste verschwinden und dieselbe View den neuen Lauf zeigen.

#### Scenario: Knopf in der schreibenden View

- **GIVEN** ein Pane hat die schreibende View einer Session, deren Prozess endet
- **WHEN** die Session `Exited` wird und der Benutzer in der Leiste „Neu starten“ wählt
- **THEN** sendet der Main `session.restart` mit ihrer ID, die Leiste verschwindet, sobald die Session lebt, und dieselbe View zeigt die Trennzeile und die Ausgabe des neuen Laufs

#### Scenario: Leiste nur für beendete Sessions

- **GIVEN** angehängte Views von Sessions in `Running`, `Detached`, `Starting`, `Archived`, `Exited` und `Interrupted`
- **WHEN** sie angezeigt werden
- **THEN** zeigen nur die Views zu `Exited` und `Interrupted` die Leiste

#### Scenario: Lesende View

- **GIVEN** eine Session in `Interrupted` mit einer schreibenden und einer lesenden View
- **WHEN** beide angezeigt werden
- **THEN** hat nur die schreibende den Knopf, die lesende zeigt den Hinweis ohne Knopf und sendet weder Eingabe noch Resize

### Requirement: Ablehnung des Neustarts in der View

Lehnt der Core den Neustart aus der Leiste ab, SHALL die Leiste die Meldung zeigen und der Knopf danach wieder wählbar sein; solange der Aufruf läuft, ist er gesperrt. Die Meldung SHALL verschwinden, sobald die Session wieder lebt (`Running`, `Detached`) oder archiviert ist, und bei einem neuen Klick; über `Starting`, `Exited` und `Interrupted` bleibt sie.

#### Scenario: backend_unavailable

- **GIVEN** der Core lehnt den Neustart mit `backend_unavailable` ab
- **WHEN** der Benutzer in der Leiste „Neu starten“ gewählt hat und die Session `Interrupted` bleibt
- **THEN** zeigt die Leiste die Meldung, und der Knopf ist wieder wählbar

#### Scenario: Meldung nach erneutem Leben

- **GIVEN** die Leiste zeigt eine Ablehnung
- **WHEN** die Session über das Sidebar-Menü neu startet und `Running` wird, später erneut endet
- **THEN** zeigt die Leiste keine alte Meldung

### Requirement: Screenshot-Szenen für den Neustart in der View

Die Gruppe `restore` SHALL die angehängte Session beenden, `19c-restart-bar-in-view.png` mit dem Knopf der Leiste als Sichtbarkeitsselektor aufnehmen, den Knopf wählen und `19d-restarted-in-view.png` mit dem Terminal als Sichtbarkeitsselektor aufnehmen. Der Lauf SHALL scheitern, wenn die Session nicht lebt, die Leiste bleibt oder das Pane eine andere View bekommen hat.

#### Scenario: Neustart in der View im Bild

- **WHEN** der Screenshot-Modus mit `--scenes restore` läuft
- **THEN** enthält `<dir>` `19c-restart-bar-in-view.png` und `19d-restarted-in-view.png`, und der Lauf endet mit Code 1, wenn die Session nach dem Klick nicht lebt, die Leiste sichtbar bleibt oder die View des Panes gewechselt hat

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

### Requirement: Tabs und Panes zwischen Fenstern ziehen

Ein Tab oder Pane (Griff) SHALL sich über den Fensterrand ziehen lassen. Der Main SHALL dem Fenster unter dem Zeiger die Position melden; es hebt Tab-Leiste und Kanten der Panes hervor. Ablegen dort SHALL das Element nach den Regeln des Anordnens einsetzen, außer: Mitte eines Panes, Layout-Muster und Tausch nehmen keinen Drop an. Außerhalb aller Fenster öffnet ein neues an der Mausposition; ist das Element der ganze Fensterinhalt, wandert das Fenster. Esc bricht ab.

#### Scenario: Zonen im anderen Fenster

- **GIVEN** Fenster A mit den Tabs `s1` und `s2`, Fenster B zeigt `s3` in einem Pane
- **WHEN** der Benutzer den Tab `s1` aus A über die rechte Kante des Panes von B zieht
- **THEN** zeigt B die Zonen des Panes mit hervorgehobener rechter Zone und gesperrter Mitte und einen Schatten mit dem Namen von `s1`, und A zeigt `s1` weiter

#### Scenario: Ablegen im anderen Fenster

- **GIVEN** wie oben
- **WHEN** der Benutzer dort loslässt
- **THEN** hat B einen Split `row` mit `s3` links und `s1` rechts, das Pane von `s1` ist aktiv, A hat nur noch den Tab `s2`, und das gemeldete Layout nennt `s1` nur in B

#### Scenario: Ablegen außerhalb aller Fenster

- **GIVEN** Fenster A mit den Tabs `s1` und `s2`
- **WHEN** der Benutzer den Tab `s1` neben alle Fenster zieht und loslässt
- **THEN** öffnet ein neues Fenster an der Mausposition mit `s1` als einzigem, aktivem Tab, und A hat nur noch `s2`

#### Scenario: Ganzes Fenster

- **GIVEN** Fenster A mit einem einzigen Tab
- **WHEN** der Benutzer ihn neben alle Fenster zieht und loslässt
- **THEN** wandert A an die Mausposition, kein Fenster öffnet, und keine View wird gelöst oder angehängt

#### Scenario: Ungültiges Ziel

- **GIVEN** Fenster B hat 64 Tabs
- **WHEN** der Benutzer einen Tab aus A auf die Tab-Leiste von B fallen lässt
- **THEN** ändert sich weder A noch B

#### Scenario: Mitte gesperrt

- **GIVEN** Fenster B zeigt `s3` in einem Pane
- **WHEN** der Benutzer einen Tab aus A über die Mitte dieses Panes zieht und loslässt
- **THEN** ist die Mitte nicht hervorgehoben, B behält `s3` mit seiner View, und A behält den Tab

#### Scenario: Abbruch mit Esc

- **GIVEN** der Benutzer zieht einen Tab aus A über ein Pane von B
- **WHEN** er Esc drückt
- **THEN** verschwinden die Zonen in B, ein Loslassen danach ändert nichts, und A behält den Tab

### Requirement: Übergabe der View zwischen Fenstern

Beim Ziehen zwischen Fenstern SHALL die View das Fenster wechseln und ihre Rolle behalten: Das Ziel hängt eine neue View an, der Main überträgt einem Schreiber das Recht mit `session.claimWriter`, erst dann löst die Quelle die alte View. Je View SHALL der Core genau ein Anhängen und ein Lösen sehen, nie zwei Schreiber und keinen Moment ohne Schreiber, wenn einer da war. Scheitert ein Schritt, SHALL die Quelle alles behalten. Der letzte Tab schließt die Quelle ohne Dialog.

#### Scenario: Schreiber bleibt Schreiber

- **GIVEN** in Fenster A schreibt die View `v1` von `s1`
- **WHEN** der Benutzer ihr Pane in Fenster B ablegt
- **THEN** sieht der Core `session.attach` aus B (neue View `v2`, liest), `session.claimWriter(v2)` und `session.detach(v1)` in dieser Reihenfolge, B schreibt und bestimmt die Größe, und `view.writerChanged` nennt nie keinen Schreiber

#### Scenario: Leser bleibt Leser

- **GIVEN** `s1` schreibt in Fenster C, in A zeigt ein lesendes Pane `s1`
- **WHEN** der Benutzer das lesende Pane nach B zieht
- **THEN** liest es in B, C schreibt weiter, und der Main sendet kein `session.claimWriter`

#### Scenario: Letzter Tab

- **GIVEN** Fenster A hat einen Tab, Fenster B ist offen
- **WHEN** der Benutzer den Tab in B ablegt
- **THEN** schließt A ohne Schließen-Dialog, keine Session endet, und A verlässt das gespeicherte Layout

#### Scenario: Neuer Tab während der Übergabe

- **GIVEN** der Benutzer hat den einzigen Tab von A in B abgelegt, B hängt noch an
- **WHEN** A in dieser Zeit einen weiteren Tab bekommt
- **THEN** bleibt A mit diesem Tab offen und gibt nur den verschobenen ab

#### Scenario: Anhängen scheitert

- **GIVEN** der Benutzer legt das schreibende Pane von `s1` in B ab
- **WHEN** das Anhängen in B scheitert
- **THEN** entfernt B das eingesetzte Pane, A behält es schreibend, und der Main sendet weder `claimWriter` noch `detach` für `v1`

#### Scenario: Beendete Session

- **GIVEN** in A zeigt ein Tab die Session `s1` im Zustand `Exited` (die View zeigt die letzte Ausgabe)
- **WHEN** der Benutzer den Tab neben alle Fenster zieht
- **THEN** zeigt das neue Fenster den Platzhalter von `s1`, der Main sendet kein `session.claimWriter`, und A gibt den Tab ab

#### Scenario: Session startet gerade

- **GIVEN** in A schreibt die View `v1` von `s1`, `s1` ist nach „Neu starten“ im Zustand `Starting`
- **WHEN** der Benutzer den Tab in B ablegt
- **THEN** wartet B, bis seine View angehängt ist, bevor es antwortet; meldet es trotzdem einen Platzhalter, prüft der Main den Zustand beim Core, bricht ab, und `v1` bleibt Schreiber

#### Scenario: Core-Neustart während der Übergabe

- **GIVEN** eine Übergabe an B läuft
- **WHEN** die Verbindung zum Core endet
- **THEN** bricht der Main die Übergabe ab, B entfernt die eingesetzten Panes, und A behält das Element; eine spätere Antwort von B ändert nichts

#### Scenario: Zeitlimit

- **GIVEN** eine Übergabe an B läuft
- **WHEN** B 75 s lang nichts meldet oder schließt
- **THEN** bricht der Main ab, B entfernt die eingesetzten Panes, und A behält das Element mit Rolle

#### Scenario: Neustart

- **GIVEN** der Benutzer hat einen Tab von A nach B gezogen
- **WHEN** die App beendet und neu gestartet wird
- **THEN** steht der Tab in B und nicht in A

### Requirement: Screenshot-Szenen für das Ziehen zwischen Fenstern

Der Screenshot-Modus SHALL in der Gruppe `drag` mit zwei Fenstern und echten Mausereignissen die Zonen im Zielfenster, das Ergebnis nach dem Ablegen, ein neues Fenster nach dem Ablegen außerhalb und das Layout nach einem Neustart der Oberfläche aufnehmen. Er SHALL prüfen, dass der Schreiber Schreiber bleibt und das Quellfenster seine View gelöst hat. Tritt das nicht ein, SHALL der Lauf mit Code 1 enden.

#### Scenario: Aufnahme

- **WHEN** die App mit `--screenshot <dir> --scenes drag` startet
- **THEN** enthält `<dir>` PNG-Dateien der Zonen im Zielfenster, des Ziels nach dem Ablegen, des neuen Fensters und des wiederhergestellten Layouts, und der Main hat für jede verschobene View genau eine alte View gelöst

### Requirement: Aktuelles Verzeichnis einer Windows-Session aus OSC 9;9

Der Terminal-Controller einer Windows-Session SHALL über den OSC-Parser von xterm.js (`registerOscHandler(9, …)`) das Verzeichnis lesen, das der Prompt-Hook der Windows-Shell sendet (`9;"<pfad>"` oder `9;<pfad>`), und es als `currentCwd()` anbieten. `onCwd(listener)` MUST bei jeder Änderung melden und eine Funktion zum Abmelden liefern; ein werfender Listener stört die anderen nicht. Ein anderer OSC 9 MUST der Handler mit `false` weitergeben. Der Snapshot läuft durch denselben Parser.

#### Scenario: Pfad aus der Ausgabe

- **GIVEN** eine angehängte View einer Windows-Session und ein Listener über `onCwd`
- **WHEN** die Ausgabe `ESC ] 9 ; 9 ; "C:\Windows" ESC \` zweimal und danach `ESC ] 9 ; 9 ; "D:\work dir" ESC \` bringt
- **THEN** meldet der Listener `C:\Windows` einmal und `D:\work dir` einmal, und `currentCwd()` ist `D:\work dir`

#### Scenario: Pfad aus dem Snapshot

- **GIVEN** ein Snapshot mit zwei Meldungen, zuletzt `\\server\share\dir`
- **WHEN** die View anhängt
- **THEN** ist `currentCwd()` `\\server\share\dir`

#### Scenario: Snapshot ohne Meldung (bekannte Grenze)

- **GIVEN** eine Windows-Session, deren letzte Meldung nicht mehr im Rohpuffer von 256 KiB liegt
- **WHEN** eine View anhängt
- **THEN** ist `currentCwd()` `undefined`, bis der nächste Prompt den Pfad meldet

#### Scenario: Keine Windows-Session

- **GIVEN** eine WSL-Session, deren Programm `ESC ] 9 ; 9 ; "C:\Windows" ESC \` ausgibt
- **WHEN** die Ausgabe in der View eintrifft
- **THEN** ist kein OSC-9-Handler installiert, xterm.js verarbeitet die Sequenz wie sonst, und `currentCwd()` bleibt `undefined`

#### Scenario: Werfender Listener

- **GIVEN** ein Listener, der wirft, und ein zweiter
- **WHEN** ein neuer Pfad gemeldet wird
- **THEN** erhält der zweite Listener den Pfad, und die Ausgabe wird weiter verarbeitet

#### Scenario: Benachrichtigung bleibt

- **GIVEN** eine angehängte View
- **WHEN** die Ausgabe `ESC ] 9 ; Build finished ESC \` enthält
- **THEN** gibt der Handler `false` zurück, und `currentCwd()` ändert sich nicht

#### Scenario: Abbau

- **GIVEN** ein abgemeldeter Listener und ein Controller, der danach `dispose` ruft
- **WHEN** weitere Meldungen eintreffen
- **THEN** wird kein Listener mehr gerufen, und der OSC-Handler ist beim Terminal entfernt

### Requirement: Prüfung des gemeldeten Verzeichnisses

Die reine Funktion `parseCwdOsc` SHALL einen gemeldeten Pfad nur annehmen, wenn er absolut ist (`X:\`, `X:/` oder UNC), höchstens 512 Zeichen hat und kein Steuerzeichen (C0, DEL, C1) enthält. Sonst MUST die Meldung verworfen werden und der letzte gute Pfad bleiben, ohne dass ein Listener gerufen wird. Terminal-Ausgabe ist Daten: Der Pfad wird nie ausgeführt.

#### Scenario: Ungültiger Pfad

- **GIVEN** ein gemeldeter Pfad `C:\good`
- **WHEN** danach Meldungen mit einem Steuerzeichen im Pfad, mit `relative\dir` und mit 600 Zeichen eintreffen
- **THEN** bleibt `currentCwd()` `C:\good`, und kein Listener wird gerufen
