## MODIFIED Requirements

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

### Requirement: Abbruch des Ziehens

Esc, ein Loslassen außerhalb gültiger Ziele und ein Verlust des Zeigers (`pointercancel`, `blur`) SHALL das Ziehen einer Session, eines Tabs oder eines Panes beenden, ohne einen Aufruf an den Core und ohne Änderung am Layout. Nach jedem Ziehen SHALL der folgende Klick unterdrückt sein, damit keine Session öffnet und kein Tab wechselt. Die Logik SHALL ohne DOM testbar sein; ein `DragProvider` je Fenster trägt Sidebar, Tab-Leiste und Panes.

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

## ADDED Requirements

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

Jede Anordnung SHALL ohne Maus gehen: Das Menü eines Tabs (Rechtsklick, Menütaste, Umschalt+F10) verschiebt ihn nach links oder rechts und fügt einen anderen Tab in eine Zone des aktiven Panes ein; der Griff eines Panes öffnet ein Menü zum Herauslösen und Verschieben in eine Richtung; das Menü einer Session öffnet sie in einer Zone des aktiven Panes. `Ctrl+Shift+PageUp`/`PageDown` verschieben den aktiven Tab. Gesperrte Züge sind abgeblendet. Danach hat das aktive Terminal den Fokus.

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
