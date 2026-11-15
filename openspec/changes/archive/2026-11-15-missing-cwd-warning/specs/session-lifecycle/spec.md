## ADDED Requirements

### Requirement: Warnungen des laufenden Laufs

Die Registry SHALL die Warnungen, die ein Start des Backends meldet, beim Binden der PTY in `SessionInfo.warnings` übernehmen (höchstens 8), für `session.create`, Neustart und Autostart gleich. Sie MUST sie nur in `Running` und `Detached` führen und bei jedem anderen Zustand entfernen. Ein Wiederanbinden an eine lebende Backend-Session hat keine Warnungen. Das Repository MUST Warnungen nicht speichern.

#### Scenario: Start mit fehlendem Verzeichnis

- **GIVEN** ein Backend, dessen Start `cwd_missing` für `/srv/api` meldet
- **WHEN** `create` die Session startet
- **THEN** ist sie `Detached`, Antwort, Liste und beide Zustandswechsel (`Running`, `Detached`) tragen die Warnung

#### Scenario: Ende des Laufs

- **GIVEN** eine Session mit Warnung, deren Views kommen und gehen
- **WHEN** ihr Prozess endet
- **THEN** bleibt die Warnung bis dahin, und die Session ist danach `Exited` ohne Warnung

#### Scenario: Neustart prüft neu

- **GIVEN** eine beendete Session mit Warnung, deren Verzeichnis inzwischen existiert
- **WHEN** sie neu gestartet wird
- **THEN** hat sie keine Warnung; tritt der Neustart einer noch lebenden Backend-Session bei, ebenfalls nicht

#### Scenario: Nicht gespeichert

- **GIVEN** eine Session mit Warnung
- **WHEN** das Repository sie speichert
- **THEN** enthält der gespeicherte Eintrag keine Warnung
