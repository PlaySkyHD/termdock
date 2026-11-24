## ADDED Requirements

### Requirement: Grund eines gescheiterten Starts

Scheitert ein Start mit einem `CoreError` des Backends, SHALL die Registry dessen Text an „Session <id> could not be started“ anhängen (`backend_unavailable`). Andere Fehler MUST sie nur als `cause` behalten, weil sie Befehlszeilen enthalten können.

#### Scenario: Text des Backends

- **GIVEN** ein Backend, dessen Start mit `CoreError("backend_unavailable", "PowerShell 7 (pwsh.exe) is not installed …")` scheitert
- **WHEN** ein Client die Session anlegt
- **THEN** enthält die Fehlermeldung den Text des Backends, und die Session ist `Interrupted`

### Requirement: Windows-Sessions über das Ende des Core

Windows-Shells SHALL mit dem Core enden, auch bei `core.shutdown { stopSessions: false }`, SIGINT und SIGTERM; ihr gespeicherter Zustand bleibt stehen. Der nächste Core MUST sie `Interrupted` setzen. `session.restart` und der Autostart MUST danach eine neue Shell mit Trennzeile starten; der Verlauf läuft weiter.

#### Scenario: Neustart des Core

- **GIVEN** eine Windows-Session mit `cmd.exe`, angehängter View und Ausgabe `kept-65`
- **WHEN** ein Client `core.shutdown { stopSessions: false }` sendet, ein neuer Core auf denselben Daten startet und `session.restart` folgt
- **THEN** läuft die erste Shell nach dem Ende nicht mehr, der neue Core meldet `Running → Interrupted`, nach dem Neustart läuft eine zweite Shell, und der Verlauf enthält `kept-65` vor der Trennzeile

#### Scenario: Autostart

- **GIVEN** ein Autostart-Profil mit `{ backend: "windows", shell: "cmd", cwd: "~" }`
- **WHEN** ein Core startet
- **THEN** legt der Autostart genau eine Session an, und sie ist `Detached` mit laufender Shell

#### Scenario: Neustart nach dem Ende

- **GIVEN** eine Windows-Session, deren Shell mit `exit 3` endete
- **WHEN** ein Client `session.restart` sendet
- **THEN** beginnt die Ausgabe mit der Trennzeile `--- Neu gestartet <ISO-Zeit> ---`, und genau eine neue Shell läuft

#### Scenario: Archivieren und Löschen

- **GIVEN** zwei laufende Windows-Sessions
- **WHEN** ein Client die erste archiviert und löscht, die zweite beendet und löscht
- **THEN** läuft keine der beiden Shells mehr, und die Registry ist leer
