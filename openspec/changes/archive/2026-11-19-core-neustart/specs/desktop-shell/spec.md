## ADDED Requirements

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
- **THEN** leert der Main den Zähler und startet neu wie nach einem Absturz

#### Scenario: Beenden

- **GIVEN** der Nutzer beendet die App, mit oder ohne „Sessions beenden“
- **WHEN** die Verbindung zum Core dabei endet
- **THEN** startet der Main keinen Core

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

#### Scenario: Eingabe während des Neustarts

- **GIVEN** der Core startet neu
- **WHEN** der Nutzer im Pane tippt
- **THEN** sendet die View nichts, und die Eingabe wird nicht nachgereicht

#### Scenario: Views des alten Core

- **GIVEN** ein Fenster hatte Views beim alten Core
- **WHEN** die Verbindung endet
- **THEN** vergisst der Main diese Views, und ihr späteres `detach` geht nicht an den neuen Core

### Requirement: Screenshot-Szenen des Core-Neustarts

Die Screenshot-Gruppe `restart` SHALL den isolierten Core per Prozess-ID beenden, den Neustart anhalten, „Core startet neu …“ im Pane als `90-core-restarting.png` und nach dem Neustart „Core neu gestartet“ als `91-core-restarted.png` aufnehmen, beide mit Sichtbarkeitsselektor, und prüfen, dass die alte Ausgabe im Pane steht und das Pane schreibt.

#### Scenario: Neustart im Bild

- **WHEN** der Screenshot-Modus mit `--scenes restart` läuft
- **THEN** entstehen beide Bilder, die Marke vor dem Absturz steht im Terminal, eine Eingabe danach erscheint, und der Lauf endet mit Code 0

## MODIFIED Requirements

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

### Requirement: Screenshot-Modus wählt Szenengruppen

Mit `--scenes <gruppe,…>` SHALL der Screenshot-Modus nur die genannten Szenengruppen aufnehmen (`scenario`, `sidebar`, `tabs`, `snap`, `restore`, `quit`, `search`, `settings`, `cwd`, `restart`), in fester Reihenfolge; ohne die Option laufen alle. Jede Gruppe SHALL ihren Aufbau selbst mitbringen. Ein unbekannter Name oder eine leere Liste SHALL die App vor dem Start des Cores mit Code 1 beenden und die gültigen Namen nennen.

#### Scenario: Eine Gruppe allein

- **WHEN** die App mit `--screenshot <dir> --scenes search` startet
- **THEN** enthält `<dir>` nur die Bilder der Suche, und der Lauf endet mit Code 0

#### Scenario: Unbekannter Name

- **WHEN** die App mit `--screenshot <dir> --scenes search,nope` startet
- **THEN** startet kein Core, die Meldung nennt `nope` und die gültigen Gruppen, und die App endet mit Code 1
