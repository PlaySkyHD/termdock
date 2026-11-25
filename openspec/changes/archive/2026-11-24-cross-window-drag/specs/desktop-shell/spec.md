## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Tabs und Panes zwischen Fenstern ziehen

Ein Tab oder ein Pane (Griff) SHALL sich über den Rand seines Fensters ziehen lassen. Der Main SHALL dem Fenster unter dem Zeiger die Position melden, das dort Tab-Leiste und Zonen wie beim Anordnen hervorhebt. Ablegen dort SHALL das Element nach denselben Regeln einsetzen, außerhalb aller Fenster in einem neuen Fenster an der Mausposition. Ist es der ganze Inhalt seines Fensters, SHALL stattdessen das Fenster an den Punkt wandern. Esc bricht ab.

#### Scenario: Zonen im anderen Fenster

- **GIVEN** Fenster A mit den Tabs `s1` und `s2`, Fenster B zeigt `s3` in einem Pane
- **WHEN** der Benutzer den Tab `s1` aus A über die rechte Kante des Panes von B zieht
- **THEN** zeigt B die fünf Zonen mit hervorgehobener rechter Zone und einen Schatten mit dem Namen von `s1`, und A zeigt `s1` weiter

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

#### Scenario: Anhängen scheitert

- **GIVEN** der Benutzer legt das schreibende Pane von `s1` in B ab
- **WHEN** das Anhängen in B scheitert
- **THEN** entfernt B das eingesetzte Pane, A behält es schreibend, und der Main sendet weder `claimWriter` noch `detach` für `v1`

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
