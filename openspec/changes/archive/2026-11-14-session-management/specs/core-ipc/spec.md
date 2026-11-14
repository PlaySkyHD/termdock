## MODIFIED Requirements

### Requirement: Platzhalter für Methoden der Phase 3

Bis ihre Fachlogik umgesetzt ist, SHALL der Core jede noch nicht umgesetzte Methode der Phase 3 (`profile.*`, `settings.*`, `history.search`) und `session.create` ohne `launch` mit dem Fehler `internal` beantworten, dessen Meldung die Methode und „noch nicht umgesetzt“ nennt. `workspace.*` und `project.*` (Capability `workspaces`) sowie `session.update`, `session.archive` und `session.delete` (#57) sind umgesetzt. Die Verbindung MUST offen bleiben und der Core MUST weiter Anfragen bedienen.

#### Scenario: Stub antwortet mit Fehler

- **GIVEN** ein verbundener Client
- **WHEN** er nacheinander jede noch nicht umgesetzte Methode der Phase 3 mit gültigen Parametern aufruft
- **THEN** antwortet der Core jeweils mit `internal` und „noch nicht umgesetzt“, und danach gelingt `session.list` auf derselben Verbindung

## ADDED Requirements

### Requirement: Sessions über die IPC verwalten

`session.update` SHALL die geänderte Session liefern und vorher `session.updated` senden. `session.archive` SHALL `{}` liefern, `Archived` meldet `session.stateChanged`. `session.delete` SHALL `{}` liefern und `session.removed` senden. Eine unbekannte `workspaceId` MUST `not_found` ergeben, Fehler der Registry ihren Code. Nach Archivieren und Löschen MUST der Core die Views der Session in allen Verbindungen vergessen; Aufrufe mit ihnen MUST `not_found` ergeben.

#### Scenario: Umbenennen und Verschieben über die Pipe

- **GIVEN** zwei Clients, die `session.list` genutzt haben, und einer ohne
- **WHEN** der erste eine Session umbenennt, gruppenlos macht und in `w2` verschiebt
- **THEN** erhält er jeweils die geänderte Session, beide Listen-Clients erhalten drei `session.updated` in dieser Reihenfolge, der dritte keines, und der Prozess läuft weiter

#### Scenario: Verschieben in unbekannten Workspace

- **GIVEN** eine gruppenlose Session und kein Workspace `w-typo`
- **WHEN** ein Client sie mit `workspaceId: "w-typo"` ändern will
- **THEN** antwortet der Core mit `not_found`, die Session bleibt gruppenlos und kein `session.updated` wird gesendet

#### Scenario: Laufende Session archivieren über die Pipe

- **GIVEN** eine laufende Session mit View und Verlaufsverzeichnis
- **WHEN** ein Client sie archiviert
- **THEN** ist der Prozess beendet, der Client erhält `session.stateChanged` mit `Archived`, das Verlaufsverzeichnis besteht und die View ist unbekannt

#### Scenario: Löschen über die Pipe

- **GIVEN** eine `Exited`-Session mit einer View eines anderen Clients und Verlaufsverzeichnis
- **WHEN** ein Listen-Client sie löscht
- **THEN** erhält er `session.removed`, der andere Client einen Schreiberwechsel ohne Schreiber, das Verzeichnis fehlt, `session.list` nennt sie nicht und ihre View ist unbekannt

#### Scenario: Laufende Session löschen über die Pipe

- **GIVEN** eine Session im Zustand `Detached`
- **WHEN** ein Client sie löschen will
- **THEN** antwortet der Core mit `invalid_state` und die Session bleibt mit ihrem Verlauf

#### Scenario: Keine verwaiste tmux-Session

- **GIVEN** eine WSL-Session, die `Interrupted` ist, und eine tmux-Session unter ihrem Namen
- **WHEN** ein Client sie löscht
- **THEN** existiert die tmux-Session nicht mehr und der Verlauf ist entfernt
