## ADDED Requirements

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

#### Scenario: Ungültiger Aufruf

- **WHEN** ein Renderer `restartSession` ohne oder mit leerer ID sendet
- **THEN** antwortet der Main mit `bad_request` und sendet nichts an den Core

### Requirement: Screenshot-Szenen für den Neustart einer Session

Die Gruppe `restore` SHALL die unterbrochene Session über den Knopf im Platzhalter neu starten und `19a-session-restarted.png` mit dem angehängten Terminal als Sichtbarkeitsselektor aufnehmen, dann prüfen, dass `history.search` die Trennzeile findet. Danach SHALL sie die beendete Session über das Kontextmenü neu starten und `19b-sidebar-restart-menu.png` mit dem Eintrag als Sichtbarkeitsselektor aufnehmen.

#### Scenario: Neustart im Bild

- **WHEN** der Screenshot-Modus mit `--scenes restore` läuft
- **THEN** enthält `<dir>` `19a-session-restarted.png` und `19b-sidebar-restart-menu.png`, und der Lauf endet mit Code 1, wenn die Session nicht lebt, kein Pane angehängt ist oder die Trennzeile im Verlauf fehlt
