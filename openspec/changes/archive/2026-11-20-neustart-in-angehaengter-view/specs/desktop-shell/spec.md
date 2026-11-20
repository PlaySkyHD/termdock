## ADDED Requirements

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
