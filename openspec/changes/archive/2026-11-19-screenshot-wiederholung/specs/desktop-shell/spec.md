## MODIFIED Requirements

### Requirement: Screenshot-Modus wählt Szenengruppen

Mit `--scenes <gruppe,…>` SHALL der Screenshot-Modus nur die genannten Szenengruppen (`scenario`, `sidebar`, `tabs`, `snap`, `restore`, `quit`, `search`, `settings`, `cwd`) aufnehmen; ohne Option laufen alle. Ein unbekannter Name oder eine leere Liste beendet die App vor dem Core-Start mit Code 1. Eine gescheiterte Gruppe SHALL der Lauf nach dem Zurücksetzen genau einmal wiederholen (Log `retry <gruppe>: <fehler>`, Zusammenfassung am Ende); scheitert auch das, endet er mit Code 1.

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
