## MODIFIED Requirements

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

### Requirement: Screenshot-Modus wählt Szenengruppen

Mit `--scenes <gruppe,…>` SHALL der Screenshot-Modus nur die genannten Szenengruppen aufnehmen (`scenario`, `sidebar`, `tabs`, `snap`, `restore`, `quit`, `search`, `settings`, `cwd`, `crash`, `restart`) in fester Reihenfolge, jede mit eigenem Aufbau; ohne Option laufen alle. Ein unbekannter Name oder eine leere Liste beendet die App vor dem Core-Start mit Code 1. Eine gescheiterte Gruppe SHALL genau einmal wiederholt werden (Log `retry <gruppe>: <fehler>`); scheitert sie erneut, Code 1.

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

### Requirement: Screenshot-Szenen für einen Renderer-Absturz

Die Screenshot-Gruppe `crash` SHALL zwei Fenster mit derselben Session öffnen, den Renderer des schreibenden Fensters mit `forcefullyCrashRenderer()` beenden und `31-crash-input-free.png` (Leser mit „Eingabe übernehmen“), `32-crash-other-window-writes.png` (das andere Fenster schreibt) und `33-crash-reloaded-reader.png` (das neu geladene Fenster liest) aufnehmen, jede mit Sichtbarkeitsselektor. Sie läuft vor `restart`, weil diese Gruppe den Core beendet.

#### Scenario: Absturz und Neuladen

- **WHEN** der Screenshot-Modus mit `--scenes crash` läuft
- **THEN** liegen die drei PNG vor, der Main hielt nach dem Absturz keine View des Fensters, der Core nannte keinen Schreiber, das zweite Fenster schrieb sichtbar, das neu geladene Fenster hängte sich als Leser an, und der Lauf endet mit Code 0
