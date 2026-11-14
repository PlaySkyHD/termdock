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

### Requirement: Views gehören ihrem Fenster

Eine View SHALL dem Fenster gehören, das sie angehängt hat. Eingabe, Größe, Schreibrecht und Lösen SHALL der Main nur für Views des aufrufenden Fensters weitergeben. Schließt ein Fenster, lädt sein Renderer neu oder stürzt er ab, SHALL der Main dessen Views beim Core lösen.

#### Scenario: Renderer lädt neu

- **GIVEN** Fenster A hat die schreibende View `v1`
- **WHEN** der Renderer von A neu lädt oder abstürzt
- **THEN** sendet der Main `session.detach` für `v1`, und die neue Seite in A hängt sich mit einer neuen View an

#### Scenario: Fremde View

- **GIVEN** Fenster A hat die View `v1`
- **WHEN** Fenster B Eingabe für `v1` sendet
- **THEN** antwortet der Main mit `not_found` und sendet nichts an den Core

#### Scenario: Fenster schließt

- **GIVEN** Fenster A hat die View `v1`
- **WHEN** Fenster A geschlossen wird
- **THEN** sendet der Main `session.detach` für `v1`, und die Session läuft weiter

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

Nur die schreibende View SHALL Eingaben und ihre eigene Größe an den Core senden; sie passt das Terminal an ihre Fläche an. Eine lesende View SHALL alle Eingaben und automatischen Antworten des Terminals (etwa DA1, Cursorposition) verwerfen und das Terminal in der Größe des Schreibers darstellen, beschnitten, wenn ihre Fläche kleiner ist.

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

### Requirement: Schreibrecht übernehmen

Eine lesende View SHALL ihre Rolle anzeigen und eine Schaltfläche „Schreibrecht übernehmen“ anbieten. Ein Klick SHALL `session.claimWriter` senden; nach `view.writerChanged` SHALL jede View ihre Rolle aus dem gemeldeten Schreiber ableiten.

#### Scenario: Leser übernimmt

- **GIVEN** A schreibt und B liest dieselbe Session
- **WHEN** der Benutzer in B auf „Schreibrecht übernehmen“ klickt
- **THEN** schreibt B, passt die Größe an ihre Fläche an und sendet sie, und A wird Leser und verwirft ab dann Eingaben

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
- **THEN** zeigt die View „Verbindung zum Core getrennt“ und sendet ab dann weder Eingabe noch Größe noch Schreibrecht, auch nach späteren Events

### Requirement: Screenshot-Modus gegen isolierten Core

Mit `--screenshot <dir>` SHALL die App einen eigenen Core starten (eigene Pipe, Datenverzeichnis in einem Temp-Verzeichnis, tmux-Socket `termdock-test-<pid>-<nonce>` dieses Laufs), Sessions in den Zuständen `Running`, `Detached`, `Exited` und `Interrupted` mit mehreren Tabs, eine eingeklappte Sidebar, ein leeres Fenster und einen Leser aufnehmen (PNG in `<dir>`), danach Sessions und Core beenden, das Datenverzeichnis entfernen und mit Code 0 enden; bei Fehler mit Code 1.

#### Scenario: Aufnahme

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` PNG-Dateien mit der Sidebar in allen vier Zuständen und mehreren Tabs, mit eingeklappter Sidebar, mit leerem Fenster und geöffnetem Formular und mit einem Leser samt „Schreibrecht übernehmen“, und auf dem Socket des Laufs bleibt keine Session

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

Ein Klick auf eine Session SHALL einen Tab öffnen oder den Tab fokussieren, der sie schon in einem Pane zeigt, mit diesem Pane als aktivem; Strg+Klick SHALL immer einen neuen Tab mit eigener View öffnen. Jedes Pane SHALL höchstens einmal angehängt sein und angehängt bleiben, solange es offen ist; Wechseln SHALL nichts am Core ändern. Schließen eines Tabs SHALL die Views aller seiner Panes mit `session.detach` lösen, die Session läuft weiter, und der Nachbar wird aktiv.

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

Der Zustand eines Fensters (Sessions, Tabs, aktiver Tab, Pane-Baum und aktives Pane je Tab, Sidebar) SHALL in einem Store ohne React und Electron liegen, dessen Fensteranteil die Form `LayoutWindow` mit `LayoutTab` hat; `root` eines Tabs ist ein `PaneNode` mit 1 bis 4 Panes. Er SHALL höchstens 64 Tabs je Fenster zulassen.

#### Scenario: Tab im Layout-Format

- **WHEN** der Store einen Tab für `s1` anlegt
- **THEN** hat der Tab eine `id`, ein `root` vom Typ `pane` mit `sessionId` `s1` und `activePaneId` auf dieses Pane

#### Scenario: Tab-Limit

- **GIVEN** das Fenster hat 64 Tabs
- **WHEN** eine weitere Session geöffnet wird
- **THEN** entsteht kein Tab, und die Statusleiste nennt das Limit

### Requirement: Split-Panes je Tab

Ein Pane SHALL sich rechts oder unten teilen lassen. Das neue Pane SHALL dieselbe Session als weitere View zeigen (das geteilte bleibt aktiv) oder, bei Umschalt+Klick in der Sidebar, die angeklickte Session (das neue wird aktiv). Ein Tab SHALL höchstens 4 Panes haben; bei 4 Panes ist Teilen gesperrt. Schließen eines Panes SHALL seine View mit `session.detach` lösen und das Pane aus dem Baum entfernen; Splits mit einem Kind entfallen, gleichgerichtete verschmelzen, das letzte schließt den Tab.

#### Scenario: Pane teilen

- **GIVEN** ein Tab zeigt `s1` in einem Pane, das schreibt
- **WHEN** der Benutzer „Rechts teilen“ wählt
- **THEN** hat der Tab einen Split `row` mit zwei Panes zu je 50 %, das neue Pane hängt sich als weitere View an `s1` an und liest, und das geteilte Pane bleibt aktiv und behält den Tastaturfokus

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
- **THEN** sind die Schaltflächen gesperrt, und der Baum bleibt unverändert

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

Je Tab SHALL genau ein Pane aktiv und sichtbar markiert sein; es hat den Tastaturfokus, und die Statusleiste zeigt seine View. Ein Drücken in ein Pane SHALL es aktiv machen. Ein Klick ohne Ziehen und ohne Textauswahl SHALL, wenn seine View liest, `session.claimWriter` senden; Markieren von Text SHALL das Schreibrecht nicht übernehmen.

#### Scenario: Text im Leser markieren

- **GIVEN** A schreibt `s1`, B liest `s1`
- **WHEN** der Benutzer in B Text mit der Maus markiert oder doppelt klickt
- **THEN** wird B aktiv, sendet aber kein `session.claimWriter`, und die Größe der Session bleibt

#### Scenario: Klick in lesendes Pane

- **GIVEN** zwei Panes zeigen `s1`, A schreibt, B liest
- **WHEN** der Benutzer in B klickt
- **THEN** ist B aktiv und markiert, sendet `session.claimWriter`, schreibt nach `view.writerChanged` und passt die Größe an; A wird Leser

#### Scenario: Klick in schreibendes Pane

- **GIVEN** A schreibt und ist nicht aktiv
- **WHEN** der Benutzer in A klickt
- **THEN** wird A aktiv, und das Fenster sendet kein `session.claimWriter`

### Requirement: Lesende View in Schreibergröße

Eine lesende View SHALL das Terminal in der Größe des Schreibers darstellen, ohne zu skalieren. Ist ihre Fläche kleiner, wird es beschnitten; die Fläche außerhalb des Terminals ist abgedunkelt, und ein Hinweis nennt „Größe des Schreibers: C×R“. Eine schreibende View zeigt weder Abdunklung noch Hinweis.

#### Scenario: Leser in kleinerem Pane

- **GIVEN** A schreibt `s1` mit 132×40, B liest `s1` in einem kleineren Pane
- **WHEN** B gezeichnet wird
- **THEN** zeigt B die linke obere Ecke des Terminals in 132×40 ohne Skalierung und den Hinweis „Größe des Schreibers: 132×40“

#### Scenario: Leser in größerem Pane

- **GIVEN** B liest in einem Pane, das größer ist als der Schreiber
- **WHEN** B gezeichnet wird
- **THEN** ist die Fläche rechts und unter dem Terminal abgedunkelt

### Requirement: Screenshot-Szenen für Split-Panes

Der Screenshot-Modus SHALL zusätzlich Tabs mit 2, 3 und 4 Panes aufnehmen, `stty size` in einem Pane vor und nach dem Ziehen eines Trenners, dieselbe Session in zwei Panes, davon eines lesend und beschnitten mit Hinweis, und `vim` in einem Pane vor und nach der Größenänderung. Wartet eine Szene vergeblich, SHALL der Lauf mit Code 1 enden.

#### Scenario: Aufnahme der Splits

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` zusätzlich PNG-Dateien mit 2, 3 und 4 Panes, mit `stty size` vor und nach dem Ziehen, mit einem beschnittenen Leser samt Hinweis und mit `vim` vor und nach der Größenänderung

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
