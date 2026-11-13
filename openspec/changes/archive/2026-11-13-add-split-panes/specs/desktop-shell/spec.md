# Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: UI-Zustand als reiner Store

Der Zustand eines Fensters (Sessions, Tabs, aktiver Tab, Pane-Baum und aktives Pane je Tab, Sidebar) SHALL in einem Store ohne React und Electron liegen, dessen Fensteranteil die Form `LayoutWindow` mit `LayoutTab` hat; `root` eines Tabs ist ein `PaneNode` mit 1 bis 4 Panes. Er SHALL höchstens 64 Tabs je Fenster zulassen.

#### Scenario: Tab im Layout-Format

- **WHEN** der Store einen Tab für `s1` anlegt
- **THEN** hat der Tab eine `id`, ein `root` vom Typ `pane` mit `sessionId` `s1` und `activePaneId` auf dieses Pane

#### Scenario: Tab-Limit

- **GIVEN** das Fenster hat 64 Tabs
- **WHEN** eine weitere Session geöffnet wird
- **THEN** entsteht kein Tab, und die Statusleiste nennt das Limit

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
