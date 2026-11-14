## MODIFIED Requirements

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

### Requirement: Schreibrecht übernehmen

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
- **THEN** zeigt die View „Verbindung zum Core getrennt“ und sendet ab dann weder Eingabe noch Größe noch Schreibrecht, auch nach späteren Events

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
