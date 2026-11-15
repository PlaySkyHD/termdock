## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Muster-Leiste beim Ziehen

Zieht der Benutzer einen Tab oder ein Pane an den oberen Rand des Tab-Bereichs, SHALL oben eine Leiste mit den Mustern „2 nebeneinander“, „2 übereinander“, „1 + 2“, „2 + 1“ und „2 × 2“ erscheinen. Sichtbar MUST nur ein Muster mit Platz für alle Views sein, die es ordnet (höchstens 4 Panes). Jedes Feld SHALL Namen und Statuspunkt der View zeigen, die dort landen würde; das Feld des gezogenen Elements ist markiert, freie Felder heißen „leer“.

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
- **WHEN** der Zeiger über der Tab-Leiste oder in der Mitte eines Panes steht
- **THEN** bleibt die Leiste geschlossen, die Zonen der Panes gelten wie bisher

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
